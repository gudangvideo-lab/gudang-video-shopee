/**
 * worker/session.ts
 * Manajemen sesi, validasi kedaluwarsa, idle timeout 7 hari, dan middleware otorisasi.
 */

import { parseCookies, SESSION_COOKIE_NAME } from './cookies';
import { sha256 } from './crypto';

export type UserRole = 'super_admin' | 'admin' | 'member';

export interface SessionUser {
  id: string;
  username: string;
  role: UserRole;
  status: 'active' | 'suspended';
  shopee_link?: string | null;
}

export interface SessionDevice {
  id: string;
  name: string;
  boundAt: string;
  lastSeenAt: string;
}

export interface AuthenticatedContext {
  user: SessionUser;
  device: SessionDevice;
  sessionId: string;
}

/**
 * Mengonversi string datetime SQLite (format UTC 'YYYY-MM-DD HH:MM:SS') menjadi epoch timestamp (ms).
 * Menghindari interpretasi timezone lokal di runtime JavaScript.
 */
export function parseSqliteDate(dateStr: string): number {
  if (!dateStr) return 0;
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + (dateStr.endsWith('Z') ? '' : 'Z');
  return new Date(iso).getTime();
}

const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari

/**
 * Memvalidasi sesi aktif dari cookie __Host-gvs_session.
 */
export async function validateSession(request: Request, db: D1Database): Promise<AuthenticatedContext | null> {
  const cookies = parseCookies(request);
  const rawSessionToken = cookies[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
    return null;
  }

  const sessionTokenHash = await sha256(rawSessionToken);

  interface DbSessionRow {
    session_id: string;
    user_id: string;
    device_id: string;
    expires_at: string;
    last_active_at: string;
    revoked_at: string | null;
    username: string;
    role: UserRole;
    user_status: 'active' | 'suspended';
    shopee_link: string | null;
    device_name: string;
    device_is_active: number;
    bound_at: string;
    last_seen_at: string;
  }

  const row = await db
    .prepare(
      `SELECT
        s.id AS session_id,
        s.user_id,
        s.device_id,
        s.expires_at,
        s.last_active_at,
        s.revoked_at,
        u.username,
        u.role,
        u.status AS user_status,
        u.shopee_link,
        d.device_name,
        d.is_active AS device_is_active,
        d.bound_at,
        d.last_seen_at
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      JOIN user_devices d ON s.device_id = d.id
      WHERE s.session_token_hash = ?`
    )
    .bind(sessionTokenHash)
    .first<DbSessionRow>();

  if (!row) {
    return null;
  }

  // 1. Sesi telah dicabut (revoked)
  if (row.revoked_at !== null) {
    return null;
  }

  // 2. Akun pengguna tidak aktif (misal suspended)
  if (row.user_status !== 'active') {
    return null;
  }

  // 3. Ikatan perangkat tidak aktif (misal telah direset)
  if (row.device_is_active !== 1) {
    return null;
  }

  // 4. Batas kedaluwarsa absolut (30 hari)
  const now = Date.now();
  const expiresAtMs = parseSqliteDate(row.expires_at);
  if (now > expiresAtMs) {
    return null;
  }

  // 5. Idle timeout (7 hari tidak aktif)
  const lastActiveMs = parseSqliteDate(row.last_active_at);
  if (now - lastActiveMs > IDLE_TIMEOUT_MS) {
    return null;
  }

  // Perbarui last_active_at pada sesi dan last_seen_at pada perangkat secara asinkron (sliding window)
  try {
    await db.batch([
      db.prepare(`UPDATE user_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.session_id),
      db.prepare(`UPDATE user_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.device_id)
    ]);
  } catch {
    // Abaikan kegagalan update telemetri non-kritis
  }

  return {
    user: {
      id: row.user_id,
      username: row.username,
      role: row.role,
      status: row.user_status,
      shopee_link: row.shopee_link || null
    },
    device: {
      id: row.device_id,
      name: row.device_name,
      boundAt: row.bound_at,
      lastSeenAt: row.last_seen_at
    },
    sessionId: row.session_id
  };
}
