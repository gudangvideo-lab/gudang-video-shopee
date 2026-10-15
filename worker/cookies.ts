/**
 * worker/cookies.ts
 * Parser dan pembuat cookie aman untuk Cloudflare Workers.
 * Menggunakan prefix __Host-, HttpOnly, Secure, dan SameSite=Lax.
 */

export const DEVICE_COOKIE_NAME = '__Host-gvs_device';
export const SESSION_COOKIE_NAME = '__Host-gvs_session';

const DEVICE_COOKIE_MAX_AGE = 31536000; // 1 tahun (365 hari)
const SESSION_COOKIE_MAX_AGE = 2592000;  // 30 hari

/**
 * Membaca seluruh cookie dari header Cookie request.
 */
export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) {
    return {};
  }

  const cookies: Record<string, string> = {};
  const conflictedKeys = new Set<string>();
  const pairs = cookieHeader.split(';');

  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();

      if (conflictedKeys.has(key)) {
        continue;
      }

      let decodedVal: string;
      try {
        decodedVal = decodeURIComponent(val);
      } catch {
        // Cookie dengan percent-encoding malformed diabaikan
        continue;
      }

      if (key in cookies) {
        if (cookies[key] !== decodedVal) {
          // Nilai duplikat berbeda bersifat ambigu: hapus dan jangan terima sesi ambigu
          delete cookies[key];
          conflictedKeys.add(key);
        }
      } else {
        cookies[key] = decodedVal;
      }
    }
  }

  return cookies;
}

/**
 * Membangkitkan nilai header Set-Cookie untuk pengenal perangkat klien.
 */
export function createDeviceCookie(token: string): string {
  return `${DEVICE_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE}`;
}

/**
 * Membangkitkan nilai header Set-Cookie untuk sesi login aktif (maksimal 30 hari).
 */
export function createSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`;
}

/**
 * Membangkitkan nilai header Set-Cookie untuk mencabut/menghapus cookie sesi dari peramban.
 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
