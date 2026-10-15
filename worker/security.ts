/**
 * worker/security.ts
 * Utilitas validasi keamanan HTTP, perlindungan CSRF, dan pembatasan percobaan login (rate limiting).
 */

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
 * Rate Limiter sederhana in-memory untuk memitigasi serangan brute-force login pada instance Worker.
 *
 * PERINGATAN ARSITEKTUR CLOUDFLARE WORKERS:
 * Rate limiter berbasis Map ini hanya tersimpan di heap memori V8 isolate lokal.
 * Karena Cloudflare Workers mendistribusikan request ke berbagai edge PoP dan isolate yang berbeda,
 * rate limiter in-memory ini TIDAK menjamin proteksi global antar-isolate.
 *
 * Rekomendasi produksi skala besar:
 * 1. Cloudflare Native WAF / Zone Rate Limiting Rules (direkomendasikan, zero-latency).
 * 2. Cloudflare KV dengan expiration TTL per IP/Username.
 * 3. Cloudflare Durable Objects sebagai koordinator state terdistribusi yang konsisten.
 */
interface RateLimitRecord {
  attempts: number;
  blockedUntil: number;
}

const loginAttempts = new Map<string, RateLimitRecord>();
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 menit

export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const record = loginAttempts.get(key);

  if (!record) {
    return { allowed: true };
  }

  if (record.blockedUntil > now) {
    const retryAfterSeconds = Math.ceil((record.blockedUntil - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  // Jika masa blokir sudah lewat, reset
  if (record.blockedUntil !== 0 && record.blockedUntil <= now) {
    loginAttempts.delete(key);
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordFailedLogin(key: string): void {
  const now = Date.now();
  const record = loginAttempts.get(key) || { attempts: 0, blockedUntil: 0 };
  record.attempts += 1;

  if (record.attempts >= MAX_ATTEMPTS) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
  }

  loginAttempts.set(key, record);
}

export function resetLoginRateLimit(key: string): void {
  loginAttempts.delete(key);
}

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
