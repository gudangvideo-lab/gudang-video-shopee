/**
 * worker/admin.ts
 * Handler untuk endpoint operasional administratif dan Super Administrator:
 *
 * Otorisasi:
 * - requireAdmin: Diizinkan untuk 'admin' dan 'super_admin'
 * - requireSuperAdmin: Eksklusif untuk 'super_admin'
 *
 * Endpoint Super Admin:
 * - GET   /api/super-admin/admins
 * - POST  /api/super-admin/admins
 * - PATCH /api/super-admin/admins/:id/status
 * - POST  /api/super-admin/members
 * - POST  /api/admin/activation-codes (khusus Super Admin)
 *
 * Endpoint Admin & Super Admin:
 * - GET   /api/admin/activation-codes
 * - POST  /api/admin/users/:id/reset-code
 * - GET   /api/admin/users
 * - GET   /api/admin/audit-logs
 */

import { generateActivationCode, generateResetCode, normalizeCode, sha256, hashPassword } from './crypto';
import { jsonResponse, verifyCsrf, parseJsonBody, isValidUuid, isValidUsername, isValidPassword, isValidRackName } from './security';
import { validateSession, AuthenticatedContext, UserRole } from './session';

/**
 * Middleware untuk memverifikasi hak akses administrator (admin atau super_admin).
 */
export async function requireAdmin(
  request: Request,
  db: D1Database
): Promise<{ ctx: AuthenticatedContext } | { response: Response }> {
  const ctx = await validateSession(request, db);

  if (!ctx) {
    return {
      response: jsonResponse({
        error: 'UNAUTHORIZED',
        message: 'Diperlukan sesi login aktif.'
      }, 401)
    };
  }

  if (ctx.user.role !== 'admin' && ctx.user.role !== 'super_admin') {
    return {
      response: jsonResponse({
        error: 'FORBIDDEN',
        message: 'Akses ditolak. Fitur ini hanya untuk administrator.'
      }, 403)
    };
  }

  return { ctx };
}

/**
 * Middleware untuk memverifikasi hak akses Super Administrator (super_admin saja).
 */
export async function requireSuperAdmin(
  request: Request,
  db: D1Database
): Promise<{ ctx: AuthenticatedContext } | { response: Response }> {
  const ctx = await validateSession(request, db);

  if (!ctx) {
    return {
      response: jsonResponse({
        error: 'UNAUTHORIZED',
        message: 'Diperlukan sesi login aktif.'
      }, 401)
    };
  }

  if (ctx.user.role !== 'super_admin') {
    return {
      response: jsonResponse({
        error: 'FORBIDDEN',
        message: 'Akses ditolak. Fitur ini hanya untuk Super Administrator.'
      }, 403)
    };
  }

  return { ctx };
}

/**
 * Endpoint: POST /api/admin/activation-codes
 * Dibatasi eksklusif untuk Super Administrator sesuai rancangan hak akses.
 */
export async function handleCreateActivationCode(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireSuperAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const body = (await parseJsonBody(request)) || {};
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
  const days =
    typeof body.expires_in_days === 'number' && Number.isFinite(body.expires_in_days)
      ? Math.min(365, Math.max(1, Math.floor(body.expires_in_days)))
      : 30;

  const rawCode = generateActivationCode();
  const cleanCode = normalizeCode(rawCode);
  const codeHash = await sha256(cleanCode);
  const codeId = crypto.randomUUID();
  const auditId = crypto.randomUUID();

  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  await db.batch([
    db.prepare(`
      INSERT INTO activation_codes (id, code_hash, created_by, status, max_uses, used_count, note, expires_at)
      VALUES (?, ?, ?, 'active', 1, 0, ?, datetime('now', '+' || ? || ' days'))
    `).bind(codeId, codeHash, auth.ctx.user.id, note, days),

    db.prepare(`
      INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
      VALUES (?, ?, 'CREATE_ACTIVATION_CODE', NULL, ?, ?, ?)
    `).bind(auditId, auth.ctx.user.id, `Membuat kode aktivasi baru: ${codeId}`, ipAddress, userAgent)
  ]);

  return jsonResponse({
    status: 'ok',
    message: 'Kode aktivasi berhasil dibuat.',
    data: {
      id: codeId,
      code: rawCode,
      note,
      expires_in_days: days
    }
  }, 201);
}

/**
 * Endpoint: GET /api/admin/activation-codes
 */
export async function handleListActivationCodes(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  interface CodeRow {
    id: string;
    status: string;
    used_count: number;
    used_by_user_id: string | null;
    note: string | null;
    expires_at: string;
    used_at: string | null;
    created_at: string;
    used_by_username: string | null;
  }

  const { results } = await db
    .prepare(`
      SELECT
        a.id, a.status, a.used_count, a.used_by_user_id, a.note,
        a.expires_at, a.used_at, a.created_at,
        u.username AS used_by_username
      FROM activation_codes a
      LEFT JOIN users u ON a.used_by_user_id = u.id
      ORDER BY a.created_at DESC
      LIMIT 100
    `)
    .all<CodeRow>();

  return jsonResponse({ status: 'ok', codes: results || [] }, 200);
}

/**
 * Endpoint: POST /api/admin/users/:id/reset-code
 * Menerbitkan kode reset perangkat berumur pendek (30 menit) sekali pakai.
 * Aturan:
 * - Akun Super Admin tidak menggunakan kode reset (multi-device).
 * - Admin hanya dapat menerbitkan kode reset untuk akun Member.
 * - Super Admin dapat menerbitkan kode reset untuk Admin dan Member.
 */
export async function handleIssueResetCode(request: Request, db: D1Database, targetUserId: string): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(targetUserId)) {
    return jsonResponse({ error: 'INVALID_USER_ID', message: 'Format ID pengguna tidak valid.' }, 400);
  }

  const body = (await parseJsonBody(request)) || {};
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 200)
    : 'Reset perangkat disetujui admin';

  interface TargetUserRow {
    id: string;
    username: string;
    role: UserRole;
    status: string;
  }

  const targetUser = await db
    .prepare(`SELECT id, username, role, status FROM users WHERE id = ?`)
    .bind(targetUserId)
    .first<TargetUserRow>();

  if (!targetUser) {
    return jsonResponse({ error: 'USER_NOT_FOUND', message: 'Pengguna tidak ditemukan.' }, 404);
  }

  // Super Admin kebal dari reset code karena memiliki akses multi-perangkat bawaan
  if (targetUser.role === 'super_admin') {
    return jsonResponse({
      error: 'SUPER_ADMIN_RESET_NOT_ALLOWED',
      message: 'Akun Super Administrator memiliki akses multi-perangkat dan tidak memerlukan kode reset.'
    }, 403);
  }

  // Admin biasa tidak diizinkan mereset perangkat akun sesama Admin atau Super Admin
  if (targetUser.role === 'admin' && auth.ctx.user.role !== 'super_admin') {
    return jsonResponse({
      error: 'FORBIDDEN',
      message: 'Hanya Super Administrator yang berwenang menerbitkan kode reset perangkat untuk akun Administrator.'
    }, 403);
  }

  const rawResetCode = generateResetCode();
  const cleanCode = normalizeCode(rawResetCode);
  const codeHash = await sha256(cleanCode);
  const resetCodeId = crypto.randomUUID();
  const auditId = crypto.randomUUID();

  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  await db.batch([
    db.prepare(`
      INSERT INTO device_reset_codes (id, user_id, code_hash, created_by, status, max_uses, used_count, expires_at)
      VALUES (?, ?, ?, ?, 'active', 1, 0, datetime('now', '+30 minutes'))
    `).bind(resetCodeId, targetUser.id, codeHash, auth.ctx.user.id),

    db.prepare(`
      INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
      VALUES (?, ?, 'ISSUE_RESET_CODE', ?, ?, ?, ?)
    `).bind(auditId, auth.ctx.user.id, targetUser.id, reason, ipAddress, userAgent)
  ]);

  return jsonResponse({
    status: 'ok',
    message: 'Kode reset perangkat berhasil diterbitkan.',
    data: {
      id: resetCodeId,
      user_id: targetUser.id,
      username: targetUser.username,
      reset_code: rawResetCode,
      expires_in_minutes: 30
    }
  }, 201);
}

/**
 * Endpoint: GET /api/admin/users
 */
export async function handleListUsers(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  interface UserListRow {
    id: string;
    username: string;
    role: string;
    status: string;
    created_at: string;
    shopee_link: string | null;
    whatsapp: string | null;
    registration_path: string | null;
    inviter_name: string | null;
    device_name: string | null;
    device_bound_at: string | null;
    device_last_seen_at: string | null;
  }

  const { results } = await db
    .prepare(`
      SELECT
        u.id, u.username, u.role, u.status, u.created_at, u.shopee_link,
        u.whatsapp, u.registration_path, u.inviter_name,
        d.device_name, d.bound_at AS device_bound_at, d.last_seen_at AS device_last_seen_at
      FROM users u
      LEFT JOIN user_devices d ON u.id = d.user_id AND d.is_active = 1
      ORDER BY u.created_at DESC
      LIMIT 100
    `)
    .all<UserListRow>();

  return jsonResponse({ status: 'ok', users: results || [] }, 200);
}

/**
 * Endpoint: GET /api/admin/audit-logs
 */
export async function handleListAuditLogs(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  interface AuditRow {
    id: string;
    admin_id: string;
    action: string;
    target_user_id: string | null;
    details: string;
    ip_address: string | null;
    created_at: string;
    admin_username: string | null;
    target_username: string | null;
  }

  const { results } = await db
    .prepare(`
      SELECT
        a.id, a.admin_id, a.action, a.target_user_id, a.details, a.ip_address, a.created_at,
        u_admin.username AS admin_username,
        u_target.username AS target_username
      FROM audit_logs a
      LEFT JOIN users u_admin ON a.admin_id = u_admin.id
      LEFT JOIN users u_target ON a.target_user_id = u_target.id
      ORDER BY a.created_at DESC
      LIMIT 100
    `)
    .all<AuditRow>();

  return jsonResponse({ status: 'ok', logs: results || [] }, 200);
}

// =============================================================================
// ENDPOINT KHUSUS SUPER ADMINISTRATOR (requireSuperAdmin)
// =============================================================================

/**
 * Endpoint: GET /api/super-admin/admins
 * Mengambil daftar seluruh akun Administrator yang dikelola oleh Super Admin.
 */
export async function handleListAdmins(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireSuperAdmin(request, db);
  if ('response' in auth) return auth.response;

  interface AdminRow {
    id: string;
    username: string;
    role: string;
    status: string;
    created_at: string;
    device_name: string | null;
    device_bound_at: string | null;
    device_last_seen_at: string | null;
  }

  const { results } = await db
    .prepare(`
      SELECT
        u.id, u.username, u.role, u.status, u.created_at,
        d.device_name, d.bound_at AS device_bound_at, d.last_seen_at AS device_last_seen_at
      FROM users u
      LEFT JOIN user_devices d ON u.id = d.user_id AND d.is_active = 1
      WHERE u.role IN ('super_admin', 'admin')
      ORDER BY CASE WHEN u.role = 'super_admin' THEN 0 ELSE 1 END, u.created_at DESC
    `)
    .all<AdminRow>();

  return jsonResponse({ status: 'ok', admins: results || [] }, 200);
}

/**
 * Endpoint: POST /api/super-admin/admins
 * Membuat akun Administrator baru. Dilakukan eksklusif oleh Super Administrator.
 */
export async function handleCreateAdmin(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireSuperAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' }, 400);
  }

  const { username, password } = body;

  if (!isValidUsername(username)) {
    return jsonResponse({
      error: 'INVALID_USERNAME',
      message: 'Nama pengguna harus berupa alfanumerik atau underscore sepanjang 3-30 karakter.'
    }, 400);
  }

  if (!isValidPassword(password)) {
    return jsonResponse({
      error: 'INVALID_PASSWORD',
      message: 'Kata sandi minimal 8 karakter dan maksimal 64 karakter.'
    }, 400);
  }

  const adminId = crypto.randomUUID();
  const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);
  const auditId = crypto.randomUUID();

  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO users (id, username, password_hash, password_salt, role, status)
        VALUES (?, ?, ?, ?, 'admin', 'active')
      `).bind(adminId, username.trim(), passwordHash, passwordSalt),

      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'CREATE_ADMIN', ?, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        adminId,
        `Super Admin membuat akun Admin baru: ${username.trim()}`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('users.username') || errorMsg.includes('uq_users_username')) {
      return jsonResponse({
        error: 'USERNAME_TAKEN',
        message: 'Nama pengguna tersebut sudah terdaftar. Silakan pilih nama pengguna lain.'
      }, 400);
    }
    return jsonResponse({
      error: 'CREATE_ADMIN_FAILED',
      message: 'Gagal membuat akun administrator.'
    }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: 'Akun Administrator berhasil dibuat.',
    admin: {
      id: adminId,
      username: username.trim(),
      role: 'admin',
      status: 'active'
    }
  }, 201);
}

/**
 * Endpoint: PATCH /api/super-admin/admins/:id/status
 * Mengaktifkan atau menonaktifkan akun Administrator.
 * Jika dinonaktifkan: seluruh sesi aktif langsung dicabut dan perangkat lama dinonaktifkan.
 */
export async function handleUpdateAdminStatus(
  request: Request,
  db: D1Database,
  targetAdminId: string
): Promise<Response> {
  const auth = await requireSuperAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(targetAdminId)) {
    return jsonResponse({ error: 'INVALID_ADMIN_ID', message: 'Format ID administrator tidak valid.' }, 400);
  }

  // Larang Super Admin mengubah status akun miliknya sendiri
  if (targetAdminId === auth.ctx.user.id) {
    return jsonResponse({
      error: 'SELF_STATUS_UPDATE_FORBIDDEN',
      message: 'Anda tidak dapat mengubah status akun Anda sendiri.'
    }, 403);
  }

  interface TargetAdminRow {
    id: string;
    username: string;
    role: UserRole;
    status: string;
  }

  const targetAdmin = await db
    .prepare(`SELECT id, username, role, status FROM users WHERE id = ?`)
    .bind(targetAdminId)
    .first<TargetAdminRow>();

  if (!targetAdmin) {
    return jsonResponse({ error: 'ADMIN_NOT_FOUND', message: 'Akun administrator tidak ditemukan.' }, 404);
  }

  if (targetAdmin.role === 'super_admin') {
    return jsonResponse({
      error: 'SUPER_ADMIN_PROTECTED',
      message: 'Akun Super Administrator dilindungi dan statusnya tidak dapat diubah melalui API.'
    }, 403);
  }

  if (targetAdmin.role !== 'admin') {
    return jsonResponse({
      error: 'INVALID_ROLE',
      message: 'Operasi ini hanya berlaku untuk akun dengan peran Administrator.'
    }, 400);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' }, 400);
  }

  const { status, reason } = body;
  if (status !== 'active' && status !== 'suspended') {
    return jsonResponse({
      error: 'INVALID_STATUS',
      message: 'Status harus bernilai "active" atau "suspended".'
    }, 400);
  }

  const auditAction = status === 'suspended' ? 'SUSPEND_ADMIN' : 'ACTIVATE_ADMIN';
  const auditDetails =
    typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, 200)
      : `Super Admin mengubah status Admin ${targetAdmin.username} menjadi ${status}`;

  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  if (status === 'suspended') {
    // Nonaktifkan admin, cabut seluruh sesi seketika, dan nonaktifkan perangkat
    await db.batch([
      db.prepare(`UPDATE users SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND role = 'admin'`).bind(targetAdminId),
      db.prepare(`UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL`).bind(targetAdminId),
      db.prepare(`UPDATE user_devices SET is_active = 0 WHERE user_id = ?`).bind(targetAdminId),
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(auditId, auth.ctx.user.id, auditAction, targetAdminId, auditDetails, ipAddress, userAgent)
    ]);
  } else {
    // Aktifkan kembali admin
    await db.batch([
      db.prepare(`UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND role = 'admin'`).bind(targetAdminId),
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(auditId, auth.ctx.user.id, auditAction, targetAdminId, auditDetails, ipAddress, userAgent)
    ]);
  }

  return jsonResponse({
    status: 'ok',
    message: `Status Administrator berhasil diubah menjadi ${status}.`,
    admin: {
      id: targetAdmin.id,
      username: targetAdmin.username,
      role: 'admin',
      status
    }
  }, 200);
}

/**
 * Endpoint: POST /api/super-admin/members
 * Membuat akun Member secara langsung oleh Super Administrator.
 */
export async function handleCreateMember(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireSuperAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' }, 400);
  }

  const { username, password } = body;

  if (!isValidUsername(username)) {
    return jsonResponse({
      error: 'INVALID_USERNAME',
      message: 'Nama pengguna harus berupa alfanumerik atau underscore sepanjang 3-30 karakter.'
    }, 400);
  }

  if (!isValidPassword(password)) {
    return jsonResponse({
      error: 'INVALID_PASSWORD',
      message: 'Kata sandi minimal 8 karakter dan maksimal 64 karakter.'
    }, 400);
  }

  const memberId = crypto.randomUUID();
  const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);
  const auditId = crypto.randomUUID();

  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO users (id, username, password_hash, password_salt, role, status, activation_code_id)
        VALUES (?, ?, ?, ?, 'member', 'active', NULL)
      `).bind(memberId, username.trim(), passwordHash, passwordSalt),

      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'CREATE_MEMBER', ?, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        memberId,
        `Super Admin membuat akun Member langsung: ${username.trim()}`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('users.username') || errorMsg.includes('uq_users_username')) {
      return jsonResponse({
        error: 'USERNAME_TAKEN',
        message: 'Nama pengguna tersebut sudah terdaftar. Silakan pilih nama pengguna lain.'
      }, 400);
    }
    return jsonResponse({
      error: 'CREATE_MEMBER_FAILED',
      message: 'Gagal membuat akun member.'
    }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: 'Akun Member berhasil dibuat.',
    member: {
      id: memberId,
      username: username.trim(),
      role: 'member',
      status: 'active'
    }
  }, 201);
}


/**
 * Endpoint: DELETE /api/super-admin/users/:id
 * Menghapus akun Admin atau Member secara aman tanpa merusak integritas video, R2, atau audit logs.
 */
export async function handleDeleteAccount(
  request: Request,
  db: D1Database,
  targetUserId: string
): Promise<Response> {
  const auth = await requireSuperAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(targetUserId)) {
    return jsonResponse({ error: 'INVALID_USER_ID', message: 'Format ID pengguna tidak valid.' }, 400);
  }

  if (targetUserId === auth.ctx.user.id) {
    return jsonResponse({
      error: 'CANNOT_DELETE_SELF',
      message: 'Anda tidak dapat menghapus akun Anda sendiri.'
    }, 400);
  }

  const targetUser = await db
    .prepare('SELECT id, username, role, status FROM users WHERE id = ?')
    .bind(targetUserId)
    .first<{ id: string; username: string; role: string; status: string }>();

  if (!targetUser) {
    return jsonResponse({ error: 'USER_NOT_FOUND', message: 'Pengguna tidak ditemukan.' }, 404);
  }

  if (targetUser.role === 'super_admin') {
    return jsonResponse({
      error: 'SUPER_ADMIN_PROTECTED',
      message: 'Akun Super Administrator dilindungi dan tidak dapat dihapus.'
    }, 403);
  }

  const body = await parseJsonBody<{ confirm_username?: string }>(request);
  if (!body || typeof body.confirm_username !== 'string') {
    return jsonResponse({
      error: 'MISSING_CONFIRMATION',
      message: 'Wajib menyertakan nama pengguna konfirmasi untuk menghapus akun.'
    }, 400);
  }

  if (body.confirm_username.trim().toLowerCase() !== targetUser.username.toLowerCase()) {
    return jsonResponse({
      error: 'CONFIRMATION_MISMATCH',
      message: 'Nama pengguna konfirmasi tidak cocok.'
    }, 400);
  }

  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await db.batch([
      // 1. Reassign video ke super admin actor agar R2 & data video tidak hilang
      db.prepare('UPDATE videos SET uploaded_by_admin_id = ? WHERE uploaded_by_admin_id = ?')
        .bind(auth.ctx.user.id, targetUserId),
      // 2. Reassign kode aktivasi yang dibuat admin ini ke super admin
      db.prepare('UPDATE activation_codes SET created_by = ? WHERE created_by = ?')
        .bind(auth.ctx.user.id, targetUserId),
      // 3. Reassign kode reset perangkat yang dibuat admin ini ke super admin
      db.prepare('UPDATE device_reset_codes SET created_by = ? WHERE created_by = ?')
        .bind(auth.ctx.user.id, targetUserId),
      // 4. Hapus riwayat sesi, perangkat, dan reset code milik target user
      db.prepare('DELETE FROM device_reset_codes WHERE user_id = ?')
        .bind(targetUserId),
      db.prepare('DELETE FROM user_sessions WHERE user_id = ?')
        .bind(targetUserId),
      db.prepare('DELETE FROM user_devices WHERE user_id = ?')
        .bind(targetUserId),
      // 5. Reassign audit logs yang dicatat target admin ke super admin
      db.prepare('UPDATE audit_logs SET admin_id = ? WHERE admin_id = ?')
        .bind(auth.ctx.user.id, targetUserId),
      // 6. Hapus target user dari tabel users
      db.prepare('DELETE FROM users WHERE id = ?')
        .bind(targetUserId),
      // 7. Catat aksi DELETE_USER ke audit logs
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'DELETE_USER', NULL, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        `Super Admin menghapus akun ${targetUser.role} "${targetUser.username}" (ID: ${targetUserId})`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse({
      error: 'DELETE_USER_FAILED',
      message: `Gagal menghapus akun: ${errorMsg}`
    }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: `Akun ${targetUser.role === 'admin' ? 'Administrator' : 'Member'} "${targetUser.username}" berhasil dihapus.`
  }, 200);
}

/**
 * Endpoint: POST /api/super-admin/users/:id/reset-password
 * Super Administrator mereset password akun Admin atau Member,
 * dan seketika mencabut seluruh sesi aktif milik akun tersebut.
 */
export async function handleResetUserPassword(
  request: Request,
  db: D1Database,
  targetUserId: string
): Promise<Response> {
  const auth = await requireSuperAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(targetUserId)) {
    return jsonResponse({ error: 'INVALID_USER_ID', message: 'Format ID pengguna tidak valid.' }, 400);
  }

  const targetUser = await db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .bind(targetUserId)
    .first<{ id: string; username: string; role: string }>();

  if (!targetUser) {
    return jsonResponse({ error: 'USER_NOT_FOUND', message: 'Pengguna tidak ditemukan.' }, 404);
  }

  if (targetUser.role === 'super_admin' && targetUserId !== auth.ctx.user.id) {
    return jsonResponse({
      error: 'SUPER_ADMIN_PROTECTED',
      message: 'Tidak dapat mereset kata sandi Super Administrator lain secara paksa.'
    }, 403);
  }

  const body = await parseJsonBody<{ new_password?: string }>(request);
  if (!body || !isValidPassword(body.new_password)) {
    return jsonResponse({
      error: 'INVALID_PASSWORD',
      message: 'Kata sandi baru minimal 8 karakter dan maksimal 64 karakter.'
    }, 400);
  }

  const { hash: newHash, salt: newSalt } = await hashPassword(body.new_password);
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(newHash, newSalt, targetUserId),
    // Cabut seluruh sesi aktif milik target user
    db.prepare('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL')
      .bind(targetUserId),
    db.prepare(`
      INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
      VALUES (?, ?, 'RESET_PASSWORD', ?, ?, ?, ?)
    `).bind(
      auditId,
      auth.ctx.user.id,
      targetUserId,
      `Super Admin mereset kata sandi untuk akun ${targetUser.role} "${targetUser.username}" dan mencabut seluruh sesinya`,
      ipAddress,
      userAgent
    )
  ]);

  return jsonResponse({
    status: 'ok',
    message: `Kata sandi untuk pengguna "${targetUser.username}" berhasil direset.`
  }, 200);
}

/**
 * Endpoint: PATCH /api/super-admin/users/:id/username
 * Super Administrator mengubah nama pengguna akun Admin atau Member.
 */
export async function handleSuperAdminUpdateUsername(
  request: Request,
  db: D1Database,
  targetUserId: string
): Promise<Response> {
  const auth = await requireSuperAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(targetUserId)) {
    return jsonResponse({ error: 'INVALID_USER_ID', message: 'Format ID pengguna tidak valid.' }, 400);
  }

  const targetUser = await db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .bind(targetUserId)
    .first<{ id: string; username: string; role: string }>();

  if (!targetUser) {
    return jsonResponse({ error: 'USER_NOT_FOUND', message: 'Pengguna tidak ditemukan.' }, 404);
  }

  const body = await parseJsonBody<{ new_username?: string }>(request);
  if (!body || !isValidUsername(body.new_username)) {
    return jsonResponse({
      error: 'INVALID_USERNAME',
      message: 'Nama pengguna harus berupa alfanumerik atau underscore sepanjang 3-30 karakter.'
    }, 400);
  }

  const cleanUsername = body.new_username.trim();
  if (cleanUsername.toLowerCase() === targetUser.username.toLowerCase()) {
    return jsonResponse({
      error: 'USERNAME_UNCHANGED',
      message: 'Nama pengguna baru tidak boleh sama dengan nama pengguna saat ini.'
    }, 400);
  }

  const existing = await db
    .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?')
    .bind(cleanUsername, targetUserId)
    .first();

  if (existing) {
    return jsonResponse({
      error: 'USERNAME_TAKEN',
      message: 'Nama pengguna tersebut sudah terdaftar. Silakan pilih nama pengguna lain.'
    }, 400);
  }

  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await db.batch([
      db.prepare('UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(cleanUsername, targetUserId),
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'CHANGE_USERNAME', ?, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        targetUserId,
        `Super Admin mengubah username akun "${targetUser.username}" menjadi "${cleanUsername}"`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('users.username') || errorMsg.includes('uq_users_username')) {
      return jsonResponse({
        error: 'USERNAME_TAKEN',
        message: 'Nama pengguna tersebut sudah terdaftar. Silakan pilih nama pengguna lain.'
      }, 400);
    }
    return jsonResponse({ error: 'UPDATE_FAILED', message: 'Gagal memperbarui nama pengguna.' }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: 'Nama pengguna berhasil diperbarui.',
    user: {
      id: targetUserId,
      username: cleanUsername,
      role: targetUser.role
    }
  }, 200);
}

// =============================================================================
// SISTEM MANAJEMEN RAK (KATEGORI) VIDEO
// =============================================================================

/**
 * GET /api/racks
 * Mengambil daftar rak (kategori) video untuk pengguna terautentikasi (Member & Admin).
 */
export async function handleListRacks(request: Request, db: D1Database): Promise<Response> {
  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Diperlukan sesi login aktif.' }, 401);
  }

  interface RackRow {
    id: string;
    name: string;
    is_default: number;
    created_at: string;
    updated_at: string;
    video_count: number;
  }

  const { results } = await db
    .prepare(`
      SELECT
        r.id, r.name, r.is_default, r.created_at, r.updated_at,
        COUNT(v.id) AS video_count
      FROM racks r
      LEFT JOIN videos v ON v.rack_id = r.id AND v.status = 'active'
      GROUP BY r.id, r.name, r.is_default, r.created_at, r.updated_at
      ORDER BY r.is_default DESC, r.name ASC
    `)
    .all<RackRow>();

  return jsonResponse({
    status: 'ok',
    racks: results || []
  }, 200);
}

/**
 * GET /api/admin/racks
 * Mengambil daftar rak video untuk Admin, menghitung seluruh video (aktif + nonaktif).
 */
export async function handleAdminListRacks(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  interface RackRow {
    id: string;
    name: string;
    is_default: number;
    created_at: string;
    updated_at: string;
    video_count: number;
  }

  const { results } = await db
    .prepare(`
      SELECT
        r.id, r.name, r.is_default, r.created_at, r.updated_at,
        COUNT(v.id) AS video_count
      FROM racks r
      LEFT JOIN videos v ON v.rack_id = r.id
      GROUP BY r.id, r.name, r.is_default, r.created_at, r.updated_at
      ORDER BY r.is_default DESC, r.name ASC
    `)
    .all<RackRow>();

  return jsonResponse({
    status: 'ok',
    racks: results || []
  }, 200);
}

/**
 * POST /api/admin/racks
 * Membuat rak (kategori) video baru.
 */
export async function handleCreateRack(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const body = await parseJsonBody<{ name?: string }>(request);
  if (!body || !isValidRackName(body.name)) {
    return jsonResponse({
      error: 'INVALID_RACK_NAME',
      message: 'Nama rak harus berupa teks antara 2 hingga 50 karakter.'
    }, 400);
  }

  const cleanName = body.name.trim();

  // Cek duplikasi nama secara case-insensitive
  const existing = await db
    .prepare('SELECT id FROM racks WHERE name = ? COLLATE NOCASE')
    .bind(cleanName)
    .first();

  if (existing) {
    return jsonResponse({
      error: 'RACK_NAME_EXISTS',
      message: 'Rak dengan nama tersebut sudah ada. Silakan gunakan nama lain.'
    }, 400);
  }

  const rackId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO racks (id, name, is_default, created_by)
        VALUES (?, ?, 0, ?)
      `).bind(rackId, cleanName, auth.ctx.user.id),
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'CREATE_RACK', NULL, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        `Admin ${auth.ctx.user.username} membuat rak baru: "${cleanName}" (ID: ${rackId})`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('racks.name') || errorMsg.includes('uq_racks_name')) {
      return jsonResponse({
        error: 'RACK_NAME_EXISTS',
        message: 'Rak dengan nama tersebut sudah ada.'
      }, 400);
    }
    return jsonResponse({ error: 'CREATE_RACK_FAILED', message: 'Gagal membuat rak baru.' }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: 'Rak video berhasil dibuat.',
    rack: {
      id: rackId,
      name: cleanName,
      is_default: 0,
      video_count: 0
    }
  }, 201);
}

/**
 * PUT/PATCH /api/admin/racks/:id
 * Mengubah nama rak (kategori) video. Rak General bawaan dilindungi dari pengubahan nama.
 */
export async function handleUpdateRack(
  request: Request,
  db: D1Database,
  rackId: string
): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(rackId)) {
    return jsonResponse({ error: 'INVALID_RACK_ID', message: 'Format ID rak tidak valid.' }, 400);
  }

  const existingRack = await db
    .prepare('SELECT id, name, is_default FROM racks WHERE id = ?')
    .bind(rackId)
    .first<{ id: string; name: string; is_default: number }>();

  if (!existingRack) {
    return jsonResponse({ error: 'RACK_NOT_FOUND', message: 'Rak tidak ditemukan.' }, 404);
  }

  if (existingRack.is_default === 1 || existingRack.id === '00000000-0000-0000-0000-000000000001') {
    return jsonResponse({
      error: 'DEFAULT_RACK_PROTECTED',
      message: 'Rak default General dilindungi dan namanya tidak dapat diubah.'
    }, 400);
  }

  const body = await parseJsonBody<{ name?: string }>(request);
  if (!body || !isValidRackName(body.name)) {
    return jsonResponse({
      error: 'INVALID_RACK_NAME',
      message: 'Nama rak harus berupa teks antara 2 hingga 50 karakter.'
    }, 400);
  }

  const cleanName = body.name.trim();

  // Cek duplikasi
  const duplicate = await db
    .prepare('SELECT id FROM racks WHERE name = ? COLLATE NOCASE AND id != ?')
    .bind(cleanName, rackId)
    .first();

  if (duplicate) {
    return jsonResponse({
      error: 'RACK_NAME_EXISTS',
      message: 'Rak dengan nama tersebut sudah ada.'
    }, 400);
  }

  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await db.batch([
      db.prepare('UPDATE racks SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(cleanName, rackId),
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'UPDATE_RACK', NULL, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        `Admin ${auth.ctx.user.username} mengubah nama rak "${existingRack.name}" menjadi "${cleanName}"`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('racks.name') || errorMsg.includes('uq_racks_name')) {
      return jsonResponse({
        error: 'RACK_NAME_EXISTS',
        message: 'Rak dengan nama tersebut sudah ada.'
      }, 400);
    }
    return jsonResponse({ error: 'UPDATE_RACK_FAILED', message: 'Gagal memperbarui nama rak.' }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: 'Nama rak berhasil diperbarui.',
    rack: {
      id: rackId,
      name: cleanName,
      is_default: 0
    }
  }, 200);
}

/**
 * DELETE /api/admin/racks/:id
 * Menghapus rak secara aman. Seluruh video dalam rak yang dihapus secara otomatis
 * dipindahkan ke rak default 'General'. Rak default 'General' dilindungi dari penghapusan.
 */
export async function handleDeleteRack(
  request: Request,
  db: D1Database,
  rackId: string
): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(rackId)) {
    return jsonResponse({ error: 'INVALID_RACK_ID', message: 'Format ID rak tidak valid.' }, 400);
  }

  if (rackId === '00000000-0000-0000-0000-000000000001') {
    return jsonResponse({
      error: 'CANNOT_DELETE_DEFAULT_RACK',
      message: 'Rak default General dilindungi sistem dan tidak dapat dihapus.'
    }, 400);
  }

  const existingRack = await db
    .prepare('SELECT id, name, is_default FROM racks WHERE id = ?')
    .bind(rackId)
    .first<{ id: string; name: string; is_default: number }>();

  if (!existingRack) {
    return jsonResponse({ error: 'RACK_NOT_FOUND', message: 'Rak tidak ditemukan.' }, 404);
  }

  if (existingRack.is_default === 1) {
    return jsonResponse({
      error: 'CANNOT_DELETE_DEFAULT_RACK',
      message: 'Rak default tidak dapat dihapus.'
    }, 400);
  }

  const videoCountRow = await db
    .prepare('SELECT COUNT(*) as cnt FROM videos WHERE rack_id = ?')
    .bind(rackId)
    .first<{ cnt: number }>();

  const movedVideoCount = videoCountRow?.cnt ?? 0;
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await db.batch([
      // Pindahkan seluruh video ke rak default 'General'
      db.prepare(`
        UPDATE videos
        SET rack_id = '00000000-0000-0000-0000-000000000001', updated_at = CURRENT_TIMESTAMP
        WHERE rack_id = ?
      `).bind(rackId),
      // Hapus rak dari tabel racks
      db.prepare('DELETE FROM racks WHERE id = ?').bind(rackId),
      // Catat ke audit logs
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'DELETE_RACK', NULL, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        `Admin ${auth.ctx.user.username} menghapus rak "${existingRack.name}" (ID: ${rackId}), ${movedVideoCount} video dipindahkan ke rak General`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse({
      error: 'DELETE_RACK_FAILED',
      message: `Gagal menghapus rak: ${errorMsg}`
    }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: `Rak "${existingRack.name}" berhasil dihapus. Sebanyak ${movedVideoCount} video telah dipindahkan ke rak General.`,
    moved_video_count: movedVideoCount
  }, 200);
}

/**
 * PATCH /api/admin/videos/:id/rack
 * Memindahkan video ke rak tertentu.
 */
export async function handleMoveVideoRack(
  request: Request,
  db: D1Database,
  videoId: string
): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(videoId)) {
    return jsonResponse({ error: 'INVALID_VIDEO_ID', message: 'Format ID video tidak valid.' }, 400);
  }

  const existingVideo = await db
    .prepare('SELECT id, title, rack_id FROM videos WHERE id = ?')
    .bind(videoId)
    .first<{ id: string; title: string; rack_id: string }>();

  if (!existingVideo) {
    return jsonResponse({ error: 'VIDEO_NOT_FOUND', message: 'Video tidak ditemukan.' }, 404);
  }

  const body = await parseJsonBody<{ target_rack_id?: string; rack_id?: string }>(request);
  const targetRackId = (body?.target_rack_id || body?.rack_id || '').trim();
  if (!isValidUuid(targetRackId)) {
    return jsonResponse({ error: 'INVALID_RACK_ID', message: 'ID rak tujuan tidak valid.' }, 400);
  }

  // Pastikan rak tujuan ada
  const targetRack = await db
    .prepare('SELECT id, name FROM racks WHERE id = ?')
    .bind(targetRackId)
    .first<{ id: string; name: string }>();

  if (!targetRack) {
    return jsonResponse({ error: 'RACK_NOT_FOUND', message: 'Rak tujuan tidak ditemukan.' }, 404);
  }

  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  await db.batch([
    db.prepare('UPDATE videos SET rack_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(targetRackId, videoId),
    db.prepare(`
      INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
      VALUES (?, ?, 'MOVE_VIDEO_RACK', NULL, ?, ?, ?)
    `).bind(
      auditId,
      auth.ctx.user.id,
      `Admin ${auth.ctx.user.username} memindahkan video "${existingVideo.title}" ke rak "${targetRack.name}"`,
      ipAddress,
      userAgent
    )
  ]);

  return jsonResponse({
    status: 'ok',
    message: `Video berhasil dipindahkan ke rak "${targetRack.name}".`,
    video_id: videoId,
    rack_id: targetRackId,
    rack_name: targetRack.name
  }, 200);
}
