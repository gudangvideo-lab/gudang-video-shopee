/**
 * worker/auth.ts
 * Handler untuk endpoint autentikasi pengguna:
 * - POST /api/auth/activate
 * - POST /api/auth/login
 * - POST /api/auth/reset-device
 * - POST /api/auth/logout
 * - GET  /api/auth/me
 */

import {
  hashPassword,
  verifyPassword,
  dummyPasswordHash,
  sha256,
  generateRandomToken,
  normalizeCode
} from './crypto';
import {
  createDeviceCookie,
  createSessionCookie,
  clearSessionCookie,
  parseCookies,
  DEVICE_COOKIE_NAME,
  SESSION_COOKIE_NAME
} from './cookies';
import {
  verifyCsrf,
  isValidUsername,
  isValidPassword,
  parseJsonBody,
  jsonResponse,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginRateLimit,
  isValidShopeeUrl,
  normalizeShopeeUrl
} from './security';
import { validateSession, parseSqliteDate, UserRole } from './session';

/**
 * Endpoint: POST /api/auth/activate
 */
export async function handleActivate(request: Request, db: D1Database): Promise<Response> {
  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid atau melebihi batas ukuran.' }, 400);
  }

  const { activation_code, username, password, shopee_link, device_name } = body;

  if (typeof activation_code !== 'string' || !activation_code.trim()) {
    return jsonResponse({ error: 'MISSING_CODE', message: 'Kode aktivasi wajib diisi.' }, 400);
  }

  if (typeof shopee_link !== 'string' || !shopee_link.trim()) {
    return jsonResponse({ error: 'MISSING_SHOPEE_LINK', message: 'Tautan akun/profil Shopee Affiliate wajib diisi.' }, 400);
  }

  if (!isValidShopeeUrl(shopee_link)) {
    return jsonResponse({
      error: 'INVALID_SHOPEE_LINK',
      message: 'Tautan Shopee tidak valid. Harap gunakan tautan resmi Shopee (contoh: https://shopee.co.id/... atau https://shope.ee/...).'
    }, 400);
  }

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

  const cleanShopeeLink = normalizeShopeeUrl(shopee_link);
  const cleanCode = normalizeCode(activation_code);
  const codeHash = await sha256(cleanCode);

  interface CodeRow {
    id: string;
    status: string;
    used_count: number;
    expires_at: string;
  }

  const codeRow = await db
    .prepare(`SELECT id, status, used_count, expires_at FROM activation_codes WHERE code_hash = ?`)
    .bind(codeHash)
    .first<CodeRow>();

  if (!codeRow) {
    return jsonResponse({
      error: 'INVALID_ACTIVATION_CODE',
      message: 'Kode aktivasi tidak valid, telah digunakan, atau kedaluwarsa.'
    }, 400);
  }

  if (codeRow.status !== 'active' || codeRow.used_count !== 0 || parseSqliteDate(codeRow.expires_at) <= Date.now()) {
    return jsonResponse({
      error: 'INVALID_ACTIVATION_CODE',
      message: 'Kode aktivasi tidak valid, telah digunakan, atau kedaluwarsa.'
    }, 400);
  }

  // Siapkan data entitas baru
  const userId = crypto.randomUUID();
  const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);
  const deviceId = crypto.randomUUID();
  const rawDeviceToken = generateRandomToken(32);
  const deviceTokenHash = await sha256(rawDeviceToken);
  const sessionId = crypto.randomUUID();
  const rawSessionToken = generateRandomToken(32);
  const sessionTokenHash = await sha256(rawSessionToken);
  const auditId = crypto.randomUUID();

  const cleanDeviceName =
    typeof device_name === 'string' && device_name.trim()
      ? device_name.trim().slice(0, 100)
      : 'Browser';
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    // Eksekusi atomik batch SQLite:
    // Stmt 1: INSERT INTO users memicu trg_enforce_valid_activation_code (memvalidasi kode aktif & unused)
    // Stmt 2: UPDATE activation_codes memicu trg_prevent_activation_code_reuse
    // Stmt 3: INSERT INTO user_devices (terikat aktif 1)
    // Stmt 4: INSERT INTO user_sessions (maksimal 30 hari)
    // Stmt 5: INSERT INTO audit_logs (mencatat aktivasi member beserta tautan Shopee)
    const batchResults = await db.batch([
      db.prepare(`
        INSERT INTO users (id, username, password_hash, password_salt, role, status, activation_code_id, shopee_link)
        VALUES (?, ?, ?, ?, 'member', 'active', ?, ?)
      `).bind(userId, username.trim(), passwordHash, passwordSalt, codeRow.id, cleanShopeeLink),

      db.prepare(`
        UPDATE activation_codes
        SET status = 'used',
            used_count = 1,
            used_by_user_id = ?,
            used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(userId, codeRow.id),

      db.prepare(`
        INSERT INTO user_devices (id, user_id, device_token_hash, device_name, ip_address, user_agent, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).bind(deviceId, userId, deviceTokenHash, cleanDeviceName, ipAddress, userAgent),

      db.prepare(`
        INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+30 days'))
      `).bind(sessionId, userId, deviceId, sessionTokenHash, ipAddress, userAgent),

      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'ACTIVATE_USER', ?, ?, ?, ?)
      `).bind(auditId, userId, userId, `Aktivasi akun member dengan tautan Shopee: ${cleanShopeeLink}`, ipAddress, userAgent)
    ]);

    if (!batchResults[1].meta.changes || batchResults[1].meta.changes < 1) {
      throw new Error('ACTIVATION_CODE_UPDATE_FAILED');
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('users.username') || errorMsg.includes('uq_users_username')) {
      return jsonResponse({
        error: 'USERNAME_TAKEN',
        message: 'Nama pengguna tersebut sudah terdaftar. Silakan pilih nama pengguna lain.'
      }, 400);
    }

    return jsonResponse({
      error: 'ACTIVATION_FAILED',
      message: 'Aktivasi gagal. Kode aktivasi tidak valid, telah digunakan, atau kedaluwarsa.'
    }, 400);
  }

  // Berikan 2 cookie: cookie perangkat permanen dan cookie sesi 30 hari
  const response = jsonResponse({
    status: 'ok',
    message: 'Akun dan perangkat berhasil diaktifkan.',
    user: {
      username: username.trim(),
      role: 'member',
      shopee_link: cleanShopeeLink
    }
  }, 200);

  response.headers.append('Set-Cookie', createDeviceCookie(rawDeviceToken));
  response.headers.append('Set-Cookie', createSessionCookie(rawSessionToken));
  return response;
}

/**
 * Endpoint: POST /api/auth/login
 */
export async function handleLogin(request: Request, db: D1Database): Promise<Response> {
  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid atau melebihi batas ukuran.' }, 400);
  }

  const { username, password } = body;

  if (typeof username !== 'string' || typeof password !== 'string') {
    return jsonResponse({
      error: 'INVALID_CREDENTIALS',
      message: 'Nama pengguna atau kata sandi tidak valid.'
    }, 401);
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const rateLimitKey = `${clientIp}:${username.trim().toLowerCase()}`;

  const rateLimitStatus = checkLoginRateLimit(rateLimitKey);
  if (!rateLimitStatus.allowed) {
    return jsonResponse(
      {
        error: 'TOO_MANY_ATTEMPTS',
        message: 'Terlalu banyak percobaan login yang gagal. Silakan tunggu beberapa saat.'
      },
      429,
      { 'Retry-After': String(rateLimitStatus.retryAfterSeconds || 60) }
    );
  }

  interface UserRow {
    id: string;
    username: string;
    password_hash: string;
    password_salt: string;
    role: UserRole;
    status: 'active' | 'suspended';
  }

  const user = await db
    .prepare(`SELECT id, username, password_hash, password_salt, role, status FROM users WHERE username = ?`)
    .bind(username.trim())
    .first<UserRow>();

  if (!user) {
    // Eksekusi kalkulasi hashing tiruan agar timing response identik (anti user enumeration)
    await dummyPasswordHash(password);
    recordFailedLogin(rateLimitKey);
    return jsonResponse({
      error: 'INVALID_CREDENTIALS',
      message: 'Nama pengguna atau kata sandi tidak valid.'
    }, 401);
  }

  const isPasswordValid = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!isPasswordValid) {
    recordFailedLogin(rateLimitKey);
    return jsonResponse({
      error: 'INVALID_CREDENTIALS',
      message: 'Nama pengguna atau kata sandi tidak valid.'
    }, 401);
  }

  if (user.status === 'suspended') {
    return jsonResponse({
      error: 'ACCOUNT_SUSPENDED',
      message: 'Akun Anda telah dinonaktifkan oleh administrator.'
    }, 403);
  }

  // Verifikasi cookie perangkat jika tersedia
  const cookies = parseCookies(request);
  const deviceToken = cookies[DEVICE_COOKIE_NAME];

  let matchedDeviceId: string | null = null;

  if (deviceToken) {
    const deviceTokenHash = await sha256(deviceToken);

    interface DeviceRow {
      id: string;
    }

    const device = await db
      .prepare(`SELECT id FROM user_devices WHERE user_id = ? AND device_token_hash = ? AND is_active = 1`)
      .bind(user.id, deviceTokenHash)
      .first<DeviceRow>();

    if (device) {
      matchedDeviceId = device.id;
    }
  }

  // Skenario 1: Perangkat terdaftar dan valid (Alur login reguler)
  if (matchedDeviceId) {
    const sessionId = crypto.randomUUID();
    const rawSessionToken = generateRandomToken(32);
    const sessionTokenHash = await sha256(rawSessionToken);
    const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
    const userAgent = request.headers.get('User-Agent') || 'Unknown';

    await db
      .prepare(
        `INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, ip_address, user_agent, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+30 days'))`
      )
      .bind(sessionId, user.id, matchedDeviceId, sessionTokenHash, ipAddress, userAgent)
      .run();

    resetLoginRateLimit(rateLimitKey);

    const response = jsonResponse({
      status: 'ok',
      message: 'Login berhasil.',
      user: {
        username: user.username,
        role: user.role
      }
    }, 200);

    response.headers.append('Set-Cookie', createSessionCookie(rawSessionToken));
    return response;
  }

  // Skenario 2: Perangkat tidak cocok / belum ada cookie perangkat
  // Skenario 2A: Super Admin - Diizinkan multi-perangkat simultan (HP, laptop, komputer)
  if (user.role === 'super_admin') {
    const newDeviceId = crypto.randomUUID();
    const rawDeviceToken = generateRandomToken(32);
    const deviceTokenHash = await sha256(rawDeviceToken);
    const cleanDeviceName =
      typeof body.device_name === 'string' && body.device_name.trim()
        ? body.device_name.trim().slice(0, 100)
        : 'Browser Super Administrator';

    const newSessionId = crypto.randomUUID();
    const rawSessionToken = generateRandomToken(32);
    const sessionTokenHash = await sha256(rawSessionToken);
    const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
    const userAgent = request.headers.get('User-Agent') || 'Unknown';
    const auditId = crypto.randomUUID();

    await db.batch([
      db.prepare(`
        INSERT INTO user_devices (id, user_id, device_token_hash, device_name, ip_address, user_agent, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).bind(newDeviceId, user.id, deviceTokenHash, cleanDeviceName, ipAddress, userAgent),

      db.prepare(`
        INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+30 days'))
      `).bind(newSessionId, user.id, newDeviceId, sessionTokenHash, ipAddress, userAgent),

      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'ACTIVATE_USER', ?, 'Pendaftaran perangkat Super Administrator', ?, ?)
      `).bind(auditId, user.id, user.id, ipAddress, userAgent)
    ]);

    resetLoginRateLimit(rateLimitKey);

    const response = jsonResponse({
      status: 'ok',
      message: 'Login berhasil.',
      user: {
        username: user.username,
        role: user.role
      }
    }, 200);

    response.headers.append('Set-Cookie', createDeviceCookie(rawDeviceToken));
    response.headers.append('Set-Cookie', createSessionCookie(rawSessionToken));
    return response;
  }

  // Skenario 2B: Admin atau Member tanpa perangkat awal - Akun yang BELUM PERNAH memiliki perangkat diizinkan mendaftarkan browser pertama
  if (user.role === 'admin' || user.role === 'member') {
    interface DeviceStats {
      total_count: number;
    }

    const deviceStats = await db
      .prepare(`SELECT COUNT(*) AS total_count FROM user_devices WHERE user_id = ?`)
      .bind(user.id)
      .first<DeviceStats>();

    // Jika akun sudah memiliki riwayat perangkat (aktif maupun nonaktif), tolak pendaftaran otomatis
    if (!deviceStats || deviceStats.total_count === 0) {
      const newDeviceId = crypto.randomUUID();
      const rawDeviceToken = generateRandomToken(32);
      const deviceTokenHash = await sha256(rawDeviceToken);
      const cleanDeviceName =
        typeof body.device_name === 'string' && body.device_name.trim()
          ? body.device_name.trim().slice(0, 100)
          : (user.role === 'admin' ? 'Browser Administrator' : 'Browser Member');

      const newSessionId = crypto.randomUUID();
      const rawSessionToken = generateRandomToken(32);
      const sessionTokenHash = await sha256(rawSessionToken);
      const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
      const userAgent = request.headers.get('User-Agent') || 'Unknown';
      const auditId = crypto.randomUUID();

      try {
        const batchResults = await db.batch([
          db.prepare(`
            INSERT INTO user_devices (id, user_id, device_token_hash, device_name, ip_address, user_agent, is_active)
            SELECT ?, ?, ?, ?, ?, ?, 1
            WHERE NOT EXISTS (SELECT 1 FROM user_devices WHERE user_id = ?)
          `).bind(newDeviceId, user.id, deviceTokenHash, cleanDeviceName, ipAddress, userAgent, user.id),

          db.prepare(`
            INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, ip_address, user_agent, expires_at)
            SELECT ?, ?, ?, ?, ?, ?, datetime('now', '+30 days')
            WHERE EXISTS (SELECT 1 FROM user_devices WHERE id = ?)
          `).bind(newSessionId, user.id, newDeviceId, sessionTokenHash, ipAddress, userAgent, newDeviceId),

          db.prepare(`
            INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
            SELECT ?, ?, 'ACTIVATE_USER', ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM user_devices WHERE id = ?)
          `).bind(auditId, user.id, user.id, user.role === 'admin' ? 'Pendaftaran perangkat pertama administrator' : 'Pendaftaran perangkat pertama member', ipAddress, userAgent, newDeviceId)
        ]);

        const deviceInserted = batchResults[0]?.meta?.changes && batchResults[0].meta.changes > 0;
        if (deviceInserted) {
          resetLoginRateLimit(rateLimitKey);

          const response = jsonResponse({
            status: 'ok',
            message: 'Login berhasil.',
            user: {
              username: user.username,
              role: user.role
            }
          }, 200);

          response.headers.append('Set-Cookie', createDeviceCookie(rawDeviceToken));
          response.headers.append('Set-Cookie', createSessionCookie(rawSessionToken));
          return response;
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (!errorMsg.includes('uq_user_devices') && !errorMsg.includes('UNIQUE constraint failed') && !errorMsg.includes('SINGLE_DEVICE_ENFORCEMENT_VIOLATION')) {
          throw err;
        }
      }
    }
  }

  return jsonResponse({
    error: 'DEVICE_NOT_AUTHORIZED',
    message: 'Perangkat tidak terdaftar. Akun ini terikat pada perangkat lain.'
  }, 403);
}

/**
 * Endpoint: POST /api/auth/reset-device
 */
export async function handleResetDevice(request: Request, db: D1Database): Promise<Response> {
  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid atau melebihi batas ukuran.' }, 400);
  }

  const { username, password, reset_code, device_name } = body;

  if (typeof username !== 'string' || typeof password !== 'string' || typeof reset_code !== 'string') {
    return jsonResponse({
      error: 'MISSING_FIELDS',
      message: 'Nama pengguna, kata sandi, dan kode reset wajib diisi.'
    }, 400);
  }

  interface UserRow {
    id: string;
    password_hash: string;
    password_salt: string;
    status: string;
  }

  const user = await db
    .prepare(`SELECT id, password_hash, password_salt, status FROM users WHERE username = ?`)
    .bind(username.trim())
    .first<UserRow>();

  if (!user) {
    await dummyPasswordHash(password);
    return jsonResponse({
      error: 'INVALID_CREDENTIALS',
      message: 'Nama pengguna atau kata sandi tidak valid.'
    }, 401);
  }

  const isPasswordValid = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!isPasswordValid) {
    return jsonResponse({
      error: 'INVALID_CREDENTIALS',
      message: 'Nama pengguna atau kata sandi tidak valid.'
    }, 401);
  }

  if (user.status !== 'active') {
    return jsonResponse({
      error: 'ACCOUNT_SUSPENDED',
      message: 'Akun Anda tidak aktif atau dibekukan.'
    }, 403);
  }

  const cleanResetCode = normalizeCode(reset_code);
  const resetCodeHash = await sha256(cleanResetCode);

  interface ResetCodeRow {
    id: string;
    created_by: string;
    status: string;
    used_count: number;
    expires_at: string;
  }

  const resetRow = await db
    .prepare(
      `SELECT id, created_by, status, used_count, expires_at
       FROM device_reset_codes
       WHERE user_id = ? AND code_hash = ?`
    )
    .bind(user.id, resetCodeHash)
    .first<ResetCodeRow>();

  if (!resetRow) {
    return jsonResponse({
      error: 'INVALID_RESET_CODE',
      message: 'Kode reset tidak valid, telah digunakan, atau kedaluwarsa.'
    }, 400);
  }

  if (resetRow.status !== 'active' || resetRow.used_count !== 0 || parseSqliteDate(resetRow.expires_at) <= Date.now()) {
    return jsonResponse({
      error: 'INVALID_RESET_CODE',
      message: 'Kode reset tidak valid, telah digunakan, atau kedaluwarsa.'
    }, 400);
  }

  // Buat data perangkat baru dan sesi baru
  const newDeviceId = crypto.randomUUID();
  const rawDeviceToken = generateRandomToken(32);
  const deviceTokenHash = await sha256(rawDeviceToken);
  const newSessionId = crypto.randomUUID();
  const rawSessionToken = generateRandomToken(32);
  const sessionTokenHash = await sha256(rawSessionToken);

  const cleanDeviceName =
    typeof device_name === 'string' && device_name.trim()
      ? device_name.trim().slice(0, 100)
      : 'Browser Baru';
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';
  const auditId = crypto.randomUUID();

  try {
    const batchResults = await db.batch([
      // 1. Klaim kode reset (memicu trg_prevent_reset_code_reuse)
      db.prepare(`
        UPDATE device_reset_codes
        SET status = 'used',
            used_count = 1,
            used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(resetRow.id),

      // 2. Nonaktifkan seluruh perangkat lama
      db.prepare(`UPDATE user_devices SET is_active = 0 WHERE user_id = ?`).bind(user.id),

      // 3. Cabut seluruh sesi lama
      db.prepare(`UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL`).bind(user.id),

      // 4. Daftarkan perangkat baru aktif (1)
      db.prepare(`
        INSERT INTO user_devices (id, user_id, device_token_hash, device_name, ip_address, user_agent, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).bind(newDeviceId, user.id, deviceTokenHash, cleanDeviceName, ipAddress, userAgent),

      // 5. Daftarkan sesi baru (30 hari)
      db.prepare(`
        INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+30 days'))
      `).bind(newSessionId, user.id, newDeviceId, sessionTokenHash, ipAddress, userAgent),

      // 6. Catat audit log reset perangkat
      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'RESET_DEVICE', ?, 'Reset perangkat diklaim oleh pengguna', ?, ?)
      `).bind(auditId, resetRow.created_by, user.id, ipAddress, userAgent)
    ]);

    if (!batchResults[0].meta.changes || batchResults[0].meta.changes < 1) {
      throw new Error('RESET_CODE_UPDATE_FAILED');
    }
  } catch {
    return jsonResponse({
      error: 'RESET_FAILED',
      message: 'Gagal mereset perangkat. Silakan coba kembali atau hubungi admin.'
    }, 400);
  }

  const response = jsonResponse({
    status: 'ok',
    message: 'Perangkat berhasil direset dan browser baru telah terikat.'
  }, 200);

  response.headers.append('Set-Cookie', createDeviceCookie(rawDeviceToken));
  response.headers.append('Set-Cookie', createSessionCookie(rawSessionToken));
  return response;
}

/**
 * Endpoint: POST /api/auth/logout
 */
export async function handleLogout(request: Request, db: D1Database): Promise<Response> {
  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const cookies = parseCookies(request);
  const sessionToken = cookies[SESSION_COOKIE_NAME];

  if (sessionToken) {
    const sessionTokenHash = await sha256(sessionToken);
    try {
      await db
        .prepare(`UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_token_hash = ? AND revoked_at IS NULL`)
        .bind(sessionTokenHash)
        .run();
    } catch {
      // Abaikan error DB saat logout
    }
  }

  const response = jsonResponse({ status: 'ok', message: 'Logout berhasil.' }, 200);
  // Hapus cookie sesi dari browser, pertahankan cookie perangkat
  response.headers.append('Set-Cookie', clearSessionCookie());
  return response;
}

/**
 * Endpoint: GET /api/auth/me
 */
export async function handleMe(request: Request, db: D1Database): Promise<Response> {
  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({
      error: 'UNAUTHORIZED',
      message: 'Sesi tidak valid atau telah kedaluwarsa.'
    }, 401);
  }

  return jsonResponse({
    status: 'ok',
    user: {
      id: ctx.user.id,
      username: ctx.user.username,
      role: ctx.user.role,
      status: ctx.user.status,
      shopee_link: ctx.user.shopee_link || null
    },
    device: {
      id: ctx.device.id,
      name: ctx.device.name,
      boundAt: ctx.device.boundAt,
      lastSeenAt: ctx.device.lastSeenAt
    }
  }, 200);
}
