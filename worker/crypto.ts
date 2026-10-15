/**
 * worker/crypto.ts
 * Modul kriptografi untuk Gudang Video Shopee Affiliate.
 * Menggunakan Web Cryptography API (crypto.subtle) dan CSPRNG native.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const CURRENT_PBKDF2_ITERATIONS = 10000;
export const CURRENT_HASH_VERSION = 1;
const DUMMY_SALT = '0123456789abcdef0123456789abcdef';

/**
 * Menghitung hash SHA-256 dan mengembalikan representasi string hex 64 karakter.
 */
export async function sha256(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mengonversi string hex ke Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Mengonversi Uint8Array ke string hex.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Format string penyimpanan hash password berversi:
 * $pbkdf2-sha512$v=1$i=10000$<rawHashHex>
 */
export function formatPasswordHash(rawHashHex: string, iterations = CURRENT_PBKDF2_ITERATIONS): string {
  return `$pbkdf2-sha512$v=${CURRENT_HASH_VERSION}$i=${iterations}$${rawHashHex}`;
}

export const MIN_PBKDF2_ITERATIONS = 1000;
export const MAX_PBKDF2_ITERATIONS = 50000;

/**
 * Mengurai format hash tersimpan untuk mendapatkan parameter iterasi dan raw hash.
 * Memvalidasi batas iterasi dan format hex untuk mencegah serangan CPU exhaustion / malformed hash.
 * Mendukung format versi baru ($pbkdf2-sha512$v=1$i=...$<128-hex>) dan fallback raw hex legacy (128-hex).
 */
export function parsePasswordHash(storedHash: string): { iterations: number; rawHash: string } {
  if (typeof storedHash !== 'string' || !storedHash.trim()) {
    throw new Error('INVALID_HASH: Format hash tidak boleh kosong');
  }

  const trimmed = storedHash.trim();
  const versionedMatch = trimmed.match(/^\$pbkdf2-sha512\$v=1\$i=(\d+)\$([0-9a-fA-F]{128})$/);
  if (versionedMatch) {
    const iterations = parseInt(versionedMatch[1], 10);
    if (!Number.isSafeInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
      throw new Error(`INVALID_ITERATIONS: Iterasi harus berada dalam rentang ${MIN_PBKDF2_ITERATIONS} hingga ${MAX_PBKDF2_ITERATIONS}`);
    }
    return {
      iterations,
      rawHash: versionedMatch[2].toLowerCase()
    };
  }

  // Fallback untuk backward compatibility dengan plain hex format (wajib tepat 128 karakter hex untuk SHA-512)
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return {
      iterations: CURRENT_PBKDF2_ITERATIONS,
      rawHash: trimmed.toLowerCase()
    };
  }

  throw new Error('INVALID_HASH_FORMAT: Format hash tidak valid atau korup');
}

/**
 * Pembandingan waktu konstan independen (constant-time equality).
 * Membandingkan byte per byte tanpa early-exit untuk memitigasi serangan timing.
 *
 * Catatan teknis: Runtime JavaScript (V8 JIT) tidak dapat menjamin hardware-level
 * constant-time secara mutlak karena optimasi compiler mikroarsitektur CPU,
 * namun perulangan XOR byte-by-byte ini mengeliminasi early termination loop
 * dan selalu memproses panjang maksimal tanpa membocorkan indeks perbedaan.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const lenA = a.byteLength;
  const lenB = b.byteLength;
  let diff = lenA ^ lenB;
  const maxLen = Math.max(lenA, lenB);

  for (let i = 0; i < maxLen; i++) {
    const byteA = i < lenA ? a[i] : 0;
    const byteB = i < lenB ? b[i] : 0;
    diff |= byteA ^ byteB;
  }

  return diff === 0;
}

/**
 * Melakukan hashing password dengan algoritma PBKDF2-HMAC-SHA512.
 * Menggunakan 10.000 iterasi dan salt unik 16-byte (128-bit) CSPRNG.
 * Menyimpan metadata parameter dan versi hash untuk mendukung migrasi password di masa depan.
 */
export async function hashPassword(
  password: string,
  iterations = CURRENT_PBKDF2_ITERATIONS
): Promise<{ hash: string; salt: string }> {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const saltHex = bytesToHex(saltBytes);

  const rawHashHex = await computePbkdf2(password, saltBytes, iterations);
  const formattedHash = formatPasswordHash(rawHashHex, iterations);
  return { hash: formattedHash, salt: saltHex };
}

/**
 * Menurunkan kunci PBKDF2-HMAC-SHA512.
 */
async function computePbkdf2(password: string, saltBytes: Uint8Array, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-512'
    },
    passwordKey,
    512 // 64 bytes
  );

  return bytesToHex(new Uint8Array(derivedBits));
}

/**
 * Memverifikasi kecocokan password dengan hash dan salt tersimpan.
 * Mengekstrak parameter iterasi dari metadata hash tersimpan.
 */
export async function verifyPassword(password: string, storedHash: string, storedSalt: string): Promise<boolean> {
  try {
    const { iterations, rawHash } = parsePasswordHash(storedHash);
    const saltBytes = hexToBytes(storedSalt);
    if (saltBytes.byteLength !== 16) {
      return false;
    }
    const computedHashHex = await computePbkdf2(password, saltBytes, iterations);

    const computedBytes = hexToBytes(computedHashHex);
    const storedBytes = hexToBytes(rawHash);

    return timingSafeEqual(computedBytes, storedBytes);
  } catch {
    return false;
  }
}

/**
 * Eksekusi kalkulasi hashing tiruan (dummy hashing) untuk mencegah serangan user enumeration timing.
 */
export async function dummyPasswordHash(password: string): Promise<void> {
  try {
    const saltBytes = hexToBytes(DUMMY_SALT);
    await computePbkdf2(password, saltBytes, CURRENT_PBKDF2_ITERATIONS);
  } catch {
    // Ignore error
  }
}

/**
 * Membangkitkan token acak berentropi tinggi (default 32 bytes = 256 bits).
 */
export function generateRandomToken(bytesCount = 32): string {
  const bytes = new Uint8Array(bytesCount);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Menghasilkan 26 karakter Base32 seragam dari CSPRNG.
 * Karena 256 % 32 = 0, operasi byte & 0x1F menghasilkan distribusi acak 100% seragam tanpa bias.
 */
function generateBase32Chars(length: number): string {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  let result = '';
  for (let i = 0; i < length; i++) {
    const index = randomBytes[i] & 0x1f; // 0..31
    result += BASE32_ALPHABET[index];
  }
  return result;
}

/**
 * Membangkitkan Kode Aktivasi berformat: awalan GVS + 26 karakter Base32 seragam (130-bit entropy).
 * Contoh: GVS-ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z
 */
export function generateActivationCode(): string {
  const chars = generateBase32Chars(26);
  // Format menjadi GVS-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX agar mudah dibaca manusia
  return `GVS-${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}-${chars.slice(15, 20)}-${chars.slice(20)}`;
}

/**
 * Membangkitkan Kode Reset Perangkat berformat: awalan RST + 26 karakter Base32 seragam (130-bit entropy).
 * Contoh: RST-ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z
 */
export function generateResetCode(): string {
  const chars = generateBase32Chars(26);
  return `RST-${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}-${chars.slice(15, 20)}-${chars.slice(20)}`;
}

/**
 * Menormalkan kode (menghapus spasi dan tanda hubung, mengubah ke huruf kapital).
 */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
