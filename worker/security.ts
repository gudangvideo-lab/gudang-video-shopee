/**
 * worker/security.ts
 * Utilitas validasi keamanan HTTP, perlindungan CSRF, dan pembatasan percobaan login (rate limiting).
 */

import { sha256 } from './crypto';

/**
 * Validasi header Origin / Sec-Fetch-Site untuk mencegah CSRF pada request mutasi state.
 * Memvalidasi origin terhadap URL target Worker yang tepercaya, bukan hanya Host header klien.
 */
export function verifyCsrf(request: Request): boolean {
  // Hanya berlaku untuk metode yang mengubah data
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    return true;
  }

  // 1. Tolak jika browser secara eksplisit menandai request sebagai cross-site
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite === 'cross-site') {
    return false;
  }

  let expectedOrigin = '';
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    return false;
  }

  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.origin !== expectedOrigin) {
        return false;
      }
    } catch {
      return false;
    }
  }

  // Jika Origin tidak disertakan, periksa Referer jika ada
  const referer = request.headers.get('Referer');
  if (!origin && referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.origin !== expectedOrigin) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Validasi format UUID v4.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUuid(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  return UUID_REGEX.test(id.trim());
}

/**
 * Validasi format username (alfanumerik dan underscore, 3-30 karakter).
 */
export function isValidUsername(username: unknown): username is string {
  if (typeof username !== 'string') return false;
  const trimmed = username.trim();
  return /^[a-zA-Z0-9_]{3,30}$/.test(trimmed);
}

/**
 * Validasi panjang password (minimal 8 karakter, maksimal 64 karakter).
 */
export function isValidPassword(password: unknown): password is string {
  if (typeof password !== 'string') return false;
  return password.length >= 8 && password.length <= 64;
}

const MAX_JSON_BODY_BYTES = 64 * 1024; // 64 KB

/**
 * Parser body JSON dengan proteksi batas ukuran payload (maksimal 64KB).
 * Mencegah serangan exhaustion memory pada Worker isolate.
 */
export async function parseJsonBody<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_JSON_BODY_BYTES) {
    return null;
  }

  try {
    const text = await request.text();
    if (text.length > MAX_JSON_BODY_BYTES) {
      return null;
    }
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Pembuat respons JSON standar dengan header keamanan berlapis (defense-in-depth).
 */
export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

/**
 * Ekstraksi alamat IP klien dari header Cloudflare tepercaya.
 * Menggunakan CF-Connecting-IP jika tersedia dan bernilai valid.
 * Tidak mempercayai X-Forwarded-For secara default karena header tersebut
 * dapat dipalsukan oleh klien. Jika CF-Connecting-IP tidak tersedia,
 * mengembalikan fallback tetap '127.0.0.1'.
 */
export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp && cfIp.trim()) {
    return cfIp.trim();
  }
  return '127.0.0.1';
}

/**
 * Menghasilkan kunci rate limit berupa hash SHA-256 untuk memastikan bahwa
 * username, kode aktivasi, kode reset, kata sandi, maupun data sensitif lainnya
 * tidak pernah tersimpan mentah (plaintext) di dalam memori Map maupun log.
 */
export async function hashRateLimitKey(prefix: string, ...parts: string[]): Promise<string> {
  const raw = `${prefix}:${parts.map((p) => p.trim().toLowerCase()).join(':')}`;
  const hash = await sha256(raw);
  return `${prefix}:${hash}`;
}

export interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
  blockDurationMs: number;
}

export interface RateLimitRecord {
  attempts: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  blockedUntil: number;
}

const rateLimitRecords = new Map<string, RateLimitRecord>();
const DEFAULT_MAX_RATE_LIMIT_ENTRIES = 5000;
let maxEntriesOverride: number | null = null;

export function setMaxRateLimitEntries(max: number | null): void {
  maxEntriesOverride = max;
}

export function getMaxRateLimitEntries(): number {
  return maxEntriesOverride !== null ? maxEntriesOverride : DEFAULT_MAX_RATE_LIMIT_ENTRIES;
}

let rateLimitClockOverride: (() => number) | null = null;

export function setRateLimitClock(clock: (() => number) | null): void {
  rateLimitClockOverride = clock;
}

export function getRateLimitNow(): number {
  return rateLimitClockOverride ? rateLimitClockOverride() : Date.now();
}

/**
 * Pembersihan entri rate limit yang sudah kedaluwarsa untuk mencegah pertumbuhan
 * memori tanpa batas pada heap V8 isolate Worker.
 *
 * Aturan Perlindungan Blokir & Eviksi:
 * 1. Entri dengan masa blokir aktif (blockedUntil > now) TIDAK PERNAH dihapus selama eviksi kapasitas.
 * 2. Entri kedaluwarsa (masa blokir telah lewat atau jendela akumulasi telah lewat) dibersihkan terlebih dahulu.
 * 3. Jika kapasitas (getMaxRateLimitEntries()) masih terlampaui, HANYA entri yang tidak sedang diblokir
 *    (blockedUntil <= now) yang boleh dievakuasi, diurutkan dari yang paling lama tidak aktif.
 * 4. Jika seluruh entri di dalam Map sedang dalam masa blokir aktif, tidak ada entri blokir yang dihapus.
 */
export function pruneRateLimitRecords(now = getRateLimitNow()): void {
  const maxEntries = getMaxRateLimitEntries();

  // Langkah 1: Bersihkan entri yang sudah kedaluwarsa secara alami
  for (const [key, record] of rateLimitRecords.entries()) {
    if (record.blockedUntil > 0) {
      if (record.blockedUntil <= now) {
        rateLimitRecords.delete(key);
      }
    } else {
      if (now - record.firstAttemptAt > 15 * 60 * 1000) {
        rateLimitRecords.delete(key);
      }
    }
  }

  // Langkah 2: Jika kapasitas masih melebihi batas aman, eviksi HANYA entri non-blokir tertua
  if (rateLimitRecords.size > maxEntries) {
    const unblockedEntries: Array<[string, RateLimitRecord]> = [];
    for (const entry of rateLimitRecords.entries()) {
      if (entry[1].blockedUntil <= now) {
        unblockedEntries.push(entry);
      }
    }

    unblockedEntries.sort((a, b) => a[1].lastAttemptAt - b[1].lastAttemptAt);

    const needed = rateLimitRecords.size - maxEntries;
    const toRemove = unblockedEntries.slice(0, needed);
    for (const [k] of toRemove) {
      rateLimitRecords.delete(k);
    }
  }
}

export const DEFAULT_LOGIN_LIMIT_OPTIONS: RateLimitOptions = {
  maxAttempts: 5,
  windowMs: 10 * 60 * 1000, // 10 menit
  blockDurationMs: 15 * 60 * 1000 // 15 menit
};

export function checkRateLimit(
  key: string,
  options: RateLimitOptions = DEFAULT_LOGIN_LIMIT_OPTIONS
): { allowed: boolean; retryAfterSeconds?: number } {
  const now = getRateLimitNow();
  const record = rateLimitRecords.get(key);

  if (!record) {
    // Jika entri belum tercatat tetapi kapasitas Map sudah mencapai batas dan
    // SELURUH entri adalah blokir aktif (kondisi saturasi serangan tinggi):
    // Terapkan penolakan sementara fail-closed (60 detik) untuk melindungi Worker dari kehabisan memori.
    const maxEntries = getMaxRateLimitEntries();
    if (rateLimitRecords.size >= maxEntries) {
      pruneRateLimitRecords(now);
      if (rateLimitRecords.size >= maxEntries) {
        let hasUnblocked = false;
        for (const r of rateLimitRecords.values()) {
          if (r.blockedUntil <= now) {
            hasUnblocked = true;
            break;
          }
        }
        if (!hasUnblocked) {
          return { allowed: false, retryAfterSeconds: 60 };
        }
      }
    }
    return { allowed: true };
  }

  // 1. Jika sedang dalam masa blokir aktif
  if (record.blockedUntil > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((record.blockedUntil - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  // 2. Jika masa blokir sudah berakhir, bersihkan
  if (record.blockedUntil !== 0 && record.blockedUntil <= now) {
    rateLimitRecords.delete(key);
    return { allowed: true };
  }

  // 3. Jika jendela waktu telah lewat sejak percobaan pertama tanpa mencapai blokir, reset
  if (now - record.firstAttemptAt > options.windowMs) {
    rateLimitRecords.delete(key);
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordRateLimitFailure(
  key: string,
  options: RateLimitOptions = DEFAULT_LOGIN_LIMIT_OPTIONS
): void {
  const now = getRateLimitNow();
  const maxEntries = getMaxRateLimitEntries();

  if (rateLimitRecords.size >= maxEntries) {
    pruneRateLimitRecords(now);
  }

  let record = rateLimitRecords.get(key);

  if (!record) {
    // Jika kapasitas masih penuh setelah pruning dan seluruh entri sedang diblokir aktif:
    // Blokir langsung entri baru ini (fail-closed) dan jangan menghapus blokir aktif yang sudah ada.
    if (rateLimitRecords.size >= maxEntries) {
      let hasUnblocked = false;
      for (const r of rateLimitRecords.values()) {
        if (r.blockedUntil <= now) {
          hasUnblocked = true;
          break;
        }
      }
      if (!hasUnblocked) {
        record = {
          attempts: options.maxAttempts,
          firstAttemptAt: now,
          lastAttemptAt: now,
          blockedUntil: now + options.blockDurationMs
        };
        rateLimitRecords.set(key, record);
        return;
      }
    }

    record = {
      attempts: 1,
      firstAttemptAt: now,
      lastAttemptAt: now,
      blockedUntil: 0
    };
  } else if (record.blockedUntil === 0 && now - record.firstAttemptAt > options.windowMs) {
    record.attempts = 1;
    record.firstAttemptAt = now;
    record.lastAttemptAt = now;
    record.blockedUntil = 0;
  } else {
    record.attempts += 1;
    record.lastAttemptAt = now;
  }

  if (record.attempts >= options.maxAttempts) {
    record.blockedUntil = now + options.blockDurationMs;
  }

  rateLimitRecords.set(key, record);
}

export function resetRateLimit(key: string): void {
  rateLimitRecords.delete(key);
}

export function clearAllRateLimits(): void {
  rateLimitRecords.clear();
}

/**
 * Helper diagnostik pengujian untuk memastikan tidak ada rahasia mentah pada Map key.
 */
export function getRateLimitKeys(): string[] {
  return Array.from(rateLimitRecords.keys());
}

// Alias kompatibilitas
export const checkLoginRateLimit = checkRateLimit;
export const recordFailedLogin = recordRateLimitFailure;
export const resetLoginRateLimit = resetRateLimit;

const ALLOWED_SHOPEE_DOMAINS = ['shopee.co.id', 'shope.ee', 'shopee.com', 'shopee.id'];

/**
 * Validasi ketat tautan akun / profil Shopee Affiliate.
 * Mencegah phishing, open redirect, malformed URL, dan serangan domain palsu (misal: shopee.co.id.attacker.com).
 */
export function isValidShopeeUrl(urlStr: unknown): urlStr is string {
  if (typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (trimmed.length < 10 || trimmed.length > 500) return false;

  try {
    const parsed = new URL(trimmed);
    // 1. Protokol wajib http atau https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    // 2. Cegah userinfo (misal: https://shopee.co.id@attacker.com)
    if (parsed.username || parsed.password) return false;

    // 3. Hostname harus cocok persis atau merupakan subdomain resmi dengan batasan titik
    const host = parsed.hostname.toLowerCase();
    const isAllowedDomain = ALLOWED_SHOPEE_DOMAINS.some(
      (domain) => host === domain || host.endsWith('.' + domain)
    );
    if (!isAllowedDomain) return false;

    // 4. Pathname harus memiliki konten spesifik (bukan hanya root '/')
    if (!parsed.pathname || parsed.pathname === '/') return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Normalisasi tautan Shopee secara konsisten (menggunakan https dan menghapus trailing slash jika path biasa).
 */
export function normalizeShopeeUrl(urlStr: string): string {
  const trimmed = urlStr.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return trimmed;
  }
}
