import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import { createIsolatedTestDb, seedTestSuperAdmin, seedTestAdminWithoutDevice, seedTestActivationCode, TestContext } from './setup-test-db';
import { DEVICE_COOKIE_NAME, SESSION_COOKIE_NAME, parseCookies } from '../worker/cookies';
import {
  normalizeCode,
  sha256,
  timingSafeEqual,
  hashPassword,
  verifyPassword,
  generateActivationCode,
  parsePasswordHash,
  MIN_PBKDF2_ITERATIONS,
  MAX_PBKDF2_ITERATIONS
} from '../worker/crypto';
import { generateBootstrapAdminSql, parseBootstrapArgs, promptHiddenPassword } from '../scripts/bootstrap-admin';
import {
  clearAllRateLimits,
  setRateLimitClock,
  getRateLimitNow,
  getRateLimitKeys,
  getClientIp,
  setMaxRateLimitEntries,
  getMaxRateLimitEntries,
  pruneRateLimitRecords,
  checkRateLimit,
  recordRateLimitFailure
} from '../worker/security';

declare const process: any;

// Helper helper untuk parsing JSON ber-type
async function getJson(res: Response): Promise<any> {
  return res.json();
}

function extractResponseCookies(res: Response): Record<string, string> {
  const result: Record<string, string> = {};
  const getSetCookieFn = (res.headers as any).getSetCookie;
  let rawList: string[] = [];
  if (typeof getSetCookieFn === 'function') {
    rawList = getSetCookieFn.call(res.headers);
  } else {
    const raw = res.headers.get('Set-Cookie') || '';
    rawList = raw ? [raw] : [];
  }

  for (const item of rawList) {
    const subItems = item.split(/,(?=\s*__Host-)/g);
    for (const sub of subItems) {
      const firstPart = sub.trim().split(';')[0];
      const eq = firstPart.indexOf('=');
      if (eq > 0) {
        result[firstPart.slice(0, eq).trim()] = decodeURIComponent(firstPart.slice(eq + 1).trim());
      }
    }
  }
  return result;
}

describe('Modul Autentikasi dan Keamanan Cloudflare Worker', () => {
  let ctx: TestContext;
  let adminId: string;
  let adminSessionCookie: string;

  beforeEach(async () => {
    setMaxRateLimitEntries(null);
    clearAllRateLimits();
    setRateLimitClock(null);
    ctx = await createIsolatedTestDb();
    const admin = await seedTestSuperAdmin(ctx.db);
    adminId = admin.id;
    adminSessionCookie = admin.sessionCookie;
  });

  afterEach(async () => {
    setRateLimitClock(null);
    setMaxRateLimitEntries(null);
    clearAllRateLimits();
    await ctx.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 1. PENGUJIAN AKTIVASI AKUN & ATOMISITAS
  // ---------------------------------------------------------------------------
  describe('Aktivasi Akun (POST /api/auth/activate)', () => {
    it('berhasil mengaktifkan akun baru dengan kode aktivasi yang valid', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);

      const request = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'user_berhasil',
          password: 'PasswordValid123!',
          shopee_link: 'https://shope.ee/user_berhasil',
          whatsapp: '081234567890',
          registration_path: 'direct',
          device_name: 'Chrome Windows'
        })
      });

      const response = await worker.fetch(request, ctx.env);
      expect(response.status).toBe(200);

      const data = await getJson(response);
      expect(data).toHaveProperty('status', 'ok');
      expect(data.user).toHaveProperty('username', 'user_berhasil');

      // Pastikan kedua cookie diterbitkan
      const cookieHeader = response.headers.get('Set-Cookie') || '';
      expect(cookieHeader).toContain(DEVICE_COOKIE_NAME);
      expect(cookieHeader).toContain(SESSION_COOKIE_NAME);
      expect(cookieHeader).toContain('HttpOnly');
      expect(cookieHeader).toContain('SameSite=Lax');

      // Verifikasi di database: kode aktivasi berubah status menjadi 'used'
      const codeRow = await ctx.db
        .prepare(`SELECT status, used_count, used_by_user_id FROM activation_codes WHERE code_hash = ?`)
        .bind(await sha256(normalizeCode(code)))
        .first<{ status: string; used_count: number; used_by_user_id: string }>();

      expect(codeRow?.status).toBe('used');
      expect(codeRow?.used_count).toBe(1);
      expect(codeRow?.used_by_user_id).toBeTruthy();

      // Verifikasi shopee_link, whatsapp, dan registration_path tersimpan di database
      const userDb = await ctx.db
        .prepare(`SELECT shopee_link, whatsapp, registration_path, inviter_name FROM users WHERE id = ?`)
        .bind(codeRow?.used_by_user_id)
        .first<{ shopee_link: string; whatsapp: string; registration_path: string; inviter_name: string | null }>();
      expect(userDb?.shopee_link).toBe('https://shope.ee/user_berhasil');
      expect(userDb?.whatsapp).toBe('6281234567890');
      expect(userDb?.registration_path).toBe('direct');
      expect(userDb?.inviter_name).toBeNull();

      // Verifikasi 1 perangkat aktif terdaftar
      const deviceRow = await ctx.db
        .prepare(`SELECT is_active, device_name FROM user_devices WHERE user_id = ?`)
        .bind(codeRow?.used_by_user_id)
        .first<{ is_active: number; device_name: string }>();

      expect(deviceRow?.is_active).toBe(1);
      expect(deviceRow?.device_name).toBe('Chrome Windows');
    });

    it('menolak aktivasi jika tautan akun Shopee Affiliate tidak diisi (400 MISSING_SHOPEE_LINK)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const request = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'user_no_shopee',
          password: 'PasswordValid123!'
        })
      });
      const response = await worker.fetch(request, ctx.env);
      expect(response.status).toBe(400);
      const data = await getJson(response);
      expect(data.error).toBe('MISSING_SHOPEE_LINK');
    });

    it('menolak aktivasi jika tautan akun Shopee bukan berasal dari domain Shopee resmi (400 INVALID_SHOPEE_LINK)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const request = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'user_bad_shopee',
          password: 'PasswordValid123!',
          shopee_link: 'https://shopee.co.id.phishing-attacker.com/steal'
        })
      });
      const response = await worker.fetch(request, ctx.env);
      expect(response.status).toBe(400);
      const data = await getJson(response);
      expect(data.error).toBe('INVALID_SHOPEE_LINK');
    });

    it('menolak aktivasi dengan kode yang tidak dikenal / tidak ada', async () => {
      const request = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: 'GVS-INVALID-CODE-NOT-EXIST-1234',
          username: 'user_gagal',
          password: 'PasswordValid123!',
          shopee_link: 'https://shope.ee/user_gagal',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });

      const response = await worker.fetch(request, ctx.env);
      expect(response.status).toBe(400);

      const data = await getJson(response);
      expect(data.error).toBe('INVALID_ACTIVATION_CODE');

      // Pastikan TIDAK ADA baris user yang terbuat (anti partial entity)
      const userCount = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM users WHERE username = 'user_gagal'`)
        .first<{ count: number }>();
      expect(userCount?.count).toBe(0);
    });

    it('menolak aktivasi dengan kode yang telah kedaluwarsa', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId, { isExpired: true });

      const request = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'user_expired',
          password: 'PasswordValid123!',
          shopee_link: 'https://shope.ee/user_expired',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });

      const response = await worker.fetch(request, ctx.env);
      expect(response.status).toBe(400);
      const data = await getJson(response);
      expect(data.error).toBe('INVALID_ACTIVATION_CODE');

      const userCount = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM users WHERE username = 'user_expired'`)
        .first<{ count: number }>();
      expect(userCount?.count).toBe(0);
    });

    it('menolak klaim ulang kode aktivasi yang sudah pernah digunakan (replay attack)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);

      // Aktivasi pertama
      const req1 = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'user_pertama',
          password: 'PasswordValid123!',
          shopee_link: 'https://shope.ee/user_pertama',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });
      const res1 = await worker.fetch(req1, ctx.env);
      expect(res1.status).toBe(200);

      // Percobaan aktivasi kedua dengan kode yang sama
      const req2 = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'user_kedua',
          password: 'PasswordValid123!',
          shopee_link: 'https://shope.ee/user_kedua',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });
      const res2 = await worker.fetch(req2, ctx.env);
      expect(res2.status).toBe(400);

      // Pastikan user kedua tidak terbuat
      const user2Count = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM users WHERE username = 'user_kedua'`)
        .first<{ count: number }>();
      expect(user2Count?.count).toBe(0);
    });

    it('menangani dua permintaan aktivasi konkuren secara atomik (race condition prevention)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);

      const makeReq = (username: string) =>
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username,
            password: 'PasswordValid123!',
            shopee_link: `https://shope.ee/${username}`,
            whatsapp: '081234567890',
            registration_path: 'direct'
          })
        });

      // Kirim dua permintaan secara simultan via Promise.all
      const [resA, resB] = await Promise.all([
        worker.fetch(makeReq('concurrent_user_a'), ctx.env),
        worker.fetch(makeReq('concurrent_user_b'), ctx.env)
      ]);

      const statuses = [resA.status, resB.status];
      // Tepat satu yang berhasil (200) dan tepat satu yang gagal (400)
      expect(statuses).toContain(200);
      expect(statuses).toContain(400);

      // Verifikasi integritas: tepat 1 user yang terdaftar untuk kode ini
      const usersWithCode = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM users WHERE username IN ('concurrent_user_a', 'concurrent_user_b')`)
        .first<{ count: number }>();
      expect(usersWithCode?.count).toBe(1);
    });

    it('kegagalan karena username duplikat tidak meninggalkan entitas yatim dan kode aktivasi tetap aktif (no orphaned entities)', async () => {
      // 1. Buat user pertama
      const { code: code1 } = await seedTestActivationCode(ctx.db, adminId);
      const req1 = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code1,
          username: 'duplicate_user_test',
          password: 'PasswordValid123!',
          shopee_link: 'https://shope.ee/dup1',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });
      const res1 = await worker.fetch(req1, ctx.env);
      expect(res1.status).toBe(200);

      // 2. Coba aktivasi user kedua dengan kode berbeda tetapi username sama persis
      const { code: code2 } = await seedTestActivationCode(ctx.db, adminId);
      const req2 = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code2,
          username: 'duplicate_user_test', // Duplikat!
          password: 'PasswordOther456!',
          shopee_link: 'https://shope.ee/dup2',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });
      const res2 = await worker.fetch(req2, ctx.env);
      expect(res2.status).toBe(400);
      const errData = await getJson(res2);
      expect(errData.error).toBe('USERNAME_TAKEN');

      // 3. Verifikasi atomisitas: kode2 HARUS tetap berstatus 'active' dan used_count = 0
      const code2Row = await ctx.db
        .prepare(`SELECT status, used_count FROM activation_codes WHERE code_hash = ?`)
        .bind(await sha256(normalizeCode(code2)))
        .first<{ status: string; used_count: number }>();
      expect(code2Row?.status).toBe('active');
      expect(code2Row?.used_count).toBe(0);

      // 4. Pastikan tidak ada perangkat atau sesi tambahan yang terbuat
      const totalDevices = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM user_devices`)
        .first<{ count: number }>();
      // 1 dari admin seed + 1 dari user1 = 2
      expect(totalDevices?.count).toBe(2);
    });

    it('menolak payload aktivasi yang melebihi batas ukuran (payload too large > 64KB)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const hugeData = 'A'.repeat(70 * 1024); // 70 KB
      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'valid_user',
          password: 'PasswordValid123!',
          device_name: hugeData
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(400);
      const data = await getJson(res);
      expect(data.error).toBe('INVALID_JSON');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. PENGUJIAN LOGIN & PENGAWASAN PERANGKAT
  // ---------------------------------------------------------------------------
  describe('Login & Penegakan Satu Perangkat (POST /api/auth/login)', () => {
    let activatedUser: { username: string; password: string; deviceCookie: string };

    beforeEach(async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const password = 'UserPassword123!';
      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'target_login_user',
          password,
          shopee_link: 'https://shope.ee/target_login_user',
          whatsapp: '081234567890',
          registration_path: 'direct',
          device_name: 'Test Device 1'
        })
      });
      const res = await worker.fetch(req, ctx.env);
      const cookies = extractResponseCookies(res);
      activatedUser = {
        username: 'target_login_user',
        password,
        deviceCookie: `${DEVICE_COOKIE_NAME}=${cookies[DEVICE_COOKIE_NAME]}`
      };
    });

    it('berhasil login dari perangkat yang sama dengan password benar', async () => {
      const loginReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: activatedUser.deviceCookie
        },
        body: JSON.stringify({
          username: activatedUser.username,
          password: activatedUser.password
        })
      });

      const res = await worker.fetch(loginReq, ctx.env);
      expect(res.status).toBe(200);

      const data = await getJson(res);
      expect(data.status).toBe('ok');
      expect(res.headers.get('Set-Cookie')).toContain(SESSION_COOKIE_NAME);
    });

    it('menolak login dari browser baru tanpa cookie perangkat (403 DEVICE_NOT_AUTHORIZED)', async () => {
      const loginReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
          // Tidak mengirim cookie perangkat
        },
        body: JSON.stringify({
          username: activatedUser.username,
          password: activatedUser.password
        })
      });

      const res = await worker.fetch(loginReq, ctx.env);
      expect(res.status).toBe(403);

      const data = await getJson(res);
      expect(data.error).toBe('DEVICE_NOT_AUTHORIZED');
    });

    it('menolak login jika password salah dan tidak membocorkan keberadaan username', async () => {
      // 1. Username ada, password salah
      const wrongPwReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: activatedUser.deviceCookie
        },
        body: JSON.stringify({
          username: activatedUser.username,
          password: 'WrongPassword999!'
        })
      });
      const wrongPwRes = await worker.fetch(wrongPwReq, ctx.env);
      expect(wrongPwRes.status).toBe(401);
      const wrongPwData = await getJson(wrongPwRes);
      expect(wrongPwData.error).toBe('INVALID_CREDENTIALS');

      // 2. Username tidak terdaftar
      const unknownUserReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'user_tidak_dikenal_123',
          password: 'AnyPassword123!'
        })
      });
      const unknownUserRes = await worker.fetch(unknownUserReq, ctx.env);
      expect(unknownUserRes.status).toBe(401);
      const unknownUserData = await getJson(unknownUserRes);
      expect(unknownUserData.error).toBe('INVALID_CREDENTIALS');
      // Pesan error identik (anti user enumeration)
      expect(unknownUserData.message).toBe(wrongPwData.message);
    });
  });

  // ---------------------------------------------------------------------------
  // 2.1 PENGUJIAN PENDAFTARAN PERANGKAT PERTAMA ADMINISTRATOR (FIRST-DEVICE ENROLLMENT)
  // ---------------------------------------------------------------------------
  describe('Pendaftaran Perangkat Pertama Administrator (First-Device Enrollment)', () => {
    it('admin baru tanpa riwayat perangkat dapat login pertama kali dan memperoleh cookie perangkat serta sesi', async () => {
      const adminRaw = await seedTestAdminWithoutDevice(ctx.db, 'admin_murni', 'PasswordAdminMurni123!');

      const loginReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Chrome MacOS Admin Workstation'
        },
        body: JSON.stringify({
          username: adminRaw.username,
          password: adminRaw.password
        })
      });

      const res = await worker.fetch(loginReq, ctx.env);
      expect(res.status).toBe(200);

      const data = await getJson(res);
      expect(data.status).toBe('ok');
      expect(data.user.username).toBe(adminRaw.username);
      expect(data.user.role).toBe('admin');

      const cookies = extractResponseCookies(res);
      expect(cookies[DEVICE_COOKIE_NAME]).toBeDefined();
      expect(cookies[SESSION_COOKIE_NAME]).toBeDefined();

      // Verifikasi di database: tepat 1 perangkat aktif terdaftar
      const devices = await ctx.db
        .prepare(`SELECT device_name, is_active FROM user_devices WHERE user_id = ?`)
        .bind(adminRaw.id)
        .all<{ device_name: string; is_active: number }>();

      expect(devices.results.length).toBe(1);
      expect(devices.results[0].is_active).toBe(1);

      // Verifikasi sesi aktif dibuat
      const sessions = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL`)
        .bind(adminRaw.id)
        .first<{ count: number }>();
      expect(sessions?.count).toBe(1);

      // Verifikasi audit log mencatat pendaftaran perangkat pertama
      const audit = await ctx.db
        .prepare(`SELECT action, target_user_id, details FROM audit_logs WHERE admin_id = ? AND action = 'ACTIVATE_USER'`)
        .bind(adminRaw.id)
        .first<{ action: string; target_user_id: string; details: string }>();
      expect(audit).toBeDefined();
      expect(audit?.details).toContain('Pendaftaran perangkat pertama administrator');
    });

    it('login admin berikutnya dari browser yang sama berhasil menggunakan cookie perangkat', async () => {
      const adminRaw = await seedTestAdminWithoutDevice(ctx.db, 'admin_repeat', 'PasswordRepeat123!');

      // Login pertama (first-device enrollment)
      const firstReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminRaw.username, password: adminRaw.password })
      });
      const firstRes = await worker.fetch(firstReq, ctx.env);
      expect(firstRes.status).toBe(200);
      const firstCookies = extractResponseCookies(firstRes);
      const deviceCookie = `${DEVICE_COOKIE_NAME}=${firstCookies[DEVICE_COOKIE_NAME]}`;

      // Login kedua dari browser yang sama
      const secondReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: deviceCookie
        },
        body: JSON.stringify({ username: adminRaw.username, password: adminRaw.password })
      });
      const secondRes = await worker.fetch(secondReq, ctx.env);
      expect(secondRes.status).toBe(200);
      const secondCookies = extractResponseCookies(secondRes);
      expect(secondCookies[SESSION_COOKIE_NAME]).toBeDefined();

      // Verifikasi di database: tetap hanya 1 perangkat
      const devices = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM user_devices WHERE user_id = ?`)
        .bind(adminRaw.id)
        .first<{ count: number }>();
      expect(devices?.count).toBe(1);
    });

    it('admin dengan perangkat terdaftar tidak dapat login dari browser lain tanpa reset perangkat', async () => {
      const adminRaw = await seedTestAdminWithoutDevice(ctx.db, 'admin_bound', 'PasswordBound123!');

      // Login pertama mengikat browser 1
      const enrollReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminRaw.username, password: adminRaw.password })
      });
      const enrollRes = await worker.fetch(enrollReq, ctx.env);
      expect(enrollRes.status).toBe(200);

      // Percobaan login dari browser 2 (tanpa cookie perangkat)
      const otherBrowserReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminRaw.username, password: adminRaw.password })
      });
      const otherBrowserRes = await worker.fetch(otherBrowserReq, ctx.env);
      expect(otherBrowserRes.status).toBe(403);
      const otherData = await getJson(otherBrowserRes);
      expect(otherData.error).toBe('DEVICE_NOT_AUTHORIZED');

      // Percobaan login dari browser 2 dengan token perangkat palsu
      const fakeDevReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${DEVICE_COOKIE_NAME}=token_perangkat_palsu_999`
        },
        body: JSON.stringify({ username: adminRaw.username, password: adminRaw.password })
      });
      const fakeDevRes = await worker.fetch(fakeDevReq, ctx.env);
      expect(fakeDevRes.status).toBe(403);
      const fakeData = await getJson(fakeDevRes);
      expect(fakeData.error).toBe('DEVICE_NOT_AUTHORIZED');

      // Verifikasi di database: tetap tepat 1 perangkat
      const count = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM user_devices WHERE user_id = ?`)
        .bind(adminRaw.id)
        .first<{ count: number }>();
      expect(count?.count).toBe(1);
    });

    it('admin dengan riwayat perangkat nonaktif tidak otomatis memperoleh perangkat baru', async () => {
      const adminRaw = await seedTestAdminWithoutDevice(ctx.db, 'admin_inactive', 'PasswordInactive123!');

      // Sisipkan riwayat perangkat nonaktif (misalnya perangkat sebelumnya telah direset/dinonaktifkan)
      await ctx.db
        .prepare(
          `INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active)
           VALUES (?, ?, 'hash_lama_nonaktif', 'Perangkat Lama', 0)`
        )
        .bind(crypto.randomUUID(), adminRaw.id)
        .run();

      // Coba login dari browser baru tanpa cookie perangkat
      const loginReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminRaw.username, password: adminRaw.password })
      });
      const res = await worker.fetch(loginReq, ctx.env);
      expect(res.status).toBe(403);
      const data = await getJson(res);
      expect(data.error).toBe('DEVICE_NOT_AUTHORIZED');

      // Verifikasi di database: tidak ada perangkat baru yang ditambahkan
      const count = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM user_devices WHERE user_id = ?`)
        .bind(adminRaw.id)
        .first<{ count: number }>();
      expect(count?.count).toBe(1);
    });

    it('dua permintaan pendaftaran pertama bersamaan tidak dapat membuat dua perangkat (concurrency safety)', async () => {
      const adminRaw = await seedTestAdminWithoutDevice(ctx.db, 'admin_race', 'PasswordRace123!');

      const reqA = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminRaw.username, password: adminRaw.password })
      });

      const reqB = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminRaw.username, password: adminRaw.password })
      });

      const [resA, resB] = await Promise.all([
        worker.fetch(reqA, ctx.env),
        worker.fetch(reqB, ctx.env)
      ]);

      const statuses = [resA.status, resB.status];
      // Tepat satu yang berhasil (200), dan yang lainnya ditolak (403)
      expect(statuses).toContain(200);
      expect(statuses).toContain(403);

      // Verifikasi di DB: tepat 1 perangkat terdaftar
      const devCount = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM user_devices WHERE user_id = ?`)
        .bind(adminRaw.id)
        .first<{ count: number }>();
      expect(devCount?.count).toBe(1);
    });

    it('password salah, akun nonaktif, dan rate limit tetap ditangani dengan benar pada admin baru', async () => {
      // 1. Password salah pada admin tanpa perangkat
      const adminRaw = await seedTestAdminWithoutDevice(ctx.db, 'admin_checks', 'CorrectPassword123!');

      const sendWrongLogin = () =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: adminRaw.username, password: 'WrongPassword999!' })
          }),
          ctx.env
        );

      const wrongRes = await sendWrongLogin();
      expect(wrongRes.status).toBe(401);
      const wrongData = await getJson(wrongRes);
      expect(wrongData.error).toBe('INVALID_CREDENTIALS');

      // Pastikan tidak ada perangkat yang terbuat
      const devAfterWrong = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM user_devices WHERE user_id = ?`)
        .bind(adminRaw.id)
        .first<{ count: number }>();
      expect(devAfterWrong?.count).toBe(0);

      // 2. Akun admin suspended
      const adminSusp = await seedTestAdminWithoutDevice(ctx.db, 'admin_suspended', 'PasswordSuspended123!', 'suspended');
      const suspReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminSusp.username, password: adminSusp.password })
      });
      const suspRes = await worker.fetch(suspReq, ctx.env);
      expect(suspRes.status).toBe(403);
      const suspData = await getJson(suspRes);
      expect(suspData.error).toBe('ACCOUNT_SUSPENDED');

      // 3. Rate limiting setelah 5 percobaan salah
      for (let i = 0; i < 4; i++) {
        await sendWrongLogin();
      }
      const limitRes = await sendWrongLogin();
      expect(limitRes.status).toBe(429);
      const limitData = await getJson(limitRes);
      expect(limitData.error).toBe('TOO_MANY_ATTEMPTS');
    });

    it('login akun biasa tidak berubah dan tetap wajib terikat perangkat aktif', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const password = 'UserPassword123!';
      const actReq = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'regular_check_user',
          password,
          shopee_link: 'https://shope.ee/regular_check',
          whatsapp: '081234567890',
          registration_path: 'direct',
          device_name: 'Regular Device'
        })
      });
      const actRes = await worker.fetch(actReq, ctx.env);
      const cookies = extractResponseCookies(actRes);
      const regDeviceCookie = `${DEVICE_COOKIE_NAME}=${cookies[DEVICE_COOKIE_NAME]}`;

      // User biasa tanpa cookie perangkat ditolak
      const regularUserReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'regular_check_user', password })
      });
      const regRes = await worker.fetch(regularUserReq, ctx.env);
      expect(regRes.status).toBe(403);
      const regData = await getJson(regRes);
      expect(regData.error).toBe('DEVICE_NOT_AUTHORIZED');

      // User biasa dengan cookie perangkat sah berhasil
      const validReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: regDeviceCookie
        },
        body: JSON.stringify({ username: 'regular_check_user', password })
      });
      const validRes = await worker.fetch(validReq, ctx.env);
      expect(validRes.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. PENGUJIAN RESET PERANGKAT (POST /api/auth/reset-device)
  // ---------------------------------------------------------------------------
  describe('Reset Perangkat & Klaim Kode Reset', () => {
    let userRow: { id: string; username: string; password: string };

    beforeEach(async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const password = 'PasswordReset123!';
      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'reset_target_user',
          password,
          shopee_link: 'https://shope.ee/reset_target',
          whatsapp: '081234567890',
          registration_path: 'direct',
          device_name: 'Perangkat Lama'
        })
      });
      await worker.fetch(req, ctx.env);
      const u = await ctx.db
        .prepare(`SELECT id, username FROM users WHERE username = 'reset_target_user'`)
        .first<{ id: string; username: string }>();
      userRow = { id: u!.id, username: u!.username, password };
    });

    it('berhasil mereset dan mengikat browser baru menggunakan kode reset admin yang sah', async () => {
      // 1. Admin menerbitkan kode reset
      const issueReq = new Request(`http://localhost:8787/api/admin/users/${userRow.id}/reset-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminSessionCookie
        },
        body: JSON.stringify({ reason: 'Ganti HP ke iPhone baru' })
      });
      const issueRes = await worker.fetch(issueReq, ctx.env);
      expect(issueRes.status).toBe(201);
      const issueData = await getJson(issueRes);
      const resetCode = issueData.data.reset_code;

      // 2. Pengguna mengklaim kode reset di browser baru
      const resetReq = new Request('http://localhost:8787/api/auth/reset-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: userRow.username,
          password: userRow.password,
          reset_code: resetCode,
          device_name: 'iPhone Baru'
        })
      });
      const resetRes = await worker.fetch(resetReq, ctx.env);
      expect(resetRes.status).toBe(200);

      const cookieHeader = resetRes.headers.get('Set-Cookie') || '';
      expect(cookieHeader).toContain(DEVICE_COOKIE_NAME);
      expect(cookieHeader).toContain(SESSION_COOKIE_NAME);

      // Verifikasi di DB: perangkat lama sekarang is_active = 0, perangkat baru is_active = 1
      const devices = await ctx.db
        .prepare(`SELECT device_name, is_active FROM user_devices WHERE user_id = ? ORDER BY bound_at ASC`)
        .bind(userRow.id)
        .all<{ device_name: string; is_active: number }>();

      expect(devices.results.length).toBe(2);
      const oldDev = devices.results.find((d) => d.device_name === 'Perangkat Lama');
      const newDev = devices.results.find((d) => d.device_name === 'iPhone Baru');
      expect(oldDev?.is_active).toBe(0); // Lama dinonaktifkan
      expect(newDev?.is_active).toBe(1); // Baru aktif

      // Verifikasi audit log tercatat
      const auditLog = await ctx.db
        .prepare(`SELECT action, target_user_id FROM audit_logs WHERE action = 'RESET_DEVICE' AND target_user_id = ?`)
        .bind(userRow.id)
        .first<{ action: string; target_user_id: string }>();
      expect(auditLog?.action).toBe('RESET_DEVICE');

      // Percobaan menggunakan kode reset yang sama kedua kalinya ditolak
      const reuseRes = await worker.fetch(resetReq, ctx.env);
      expect(reuseRes.status).toBe(400);
    });

    it('dua permintaan reset konkuren dengan kode yang sama hanya mengizinkan satu berhasil (concurrency safety)', async () => {
      // Terbitkan kode reset
      const issueReq = new Request(`http://localhost:8787/api/admin/users/${userRow.id}/reset-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminSessionCookie },
        body: JSON.stringify({ reason: 'Test konkuren' })
      });
      const issueRes = await worker.fetch(issueReq, ctx.env);
      const issueData = await getJson(issueRes);
      const resetCode = issueData.data.reset_code;

      const makeResetReq = (deviceName: string) =>
        new Request('http://localhost:8787/api/auth/reset-device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: userRow.username,
            password: userRow.password,
            reset_code: resetCode,
            device_name: deviceName
          })
        });

      const [res1, res2] = await Promise.all([
        worker.fetch(makeResetReq('Device Paralel 1'), ctx.env),
        worker.fetch(makeResetReq('Device Paralel 2'), ctx.env)
      ]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(200);
      expect(statuses).toContain(400);

      // Verifikasi: MAKSIMAL 1 perangkat aktif per akun (integritas uq_user_devices_user)
      const activeDevices = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM user_devices WHERE user_id = ? AND is_active = 1`)
        .bind(userRow.id)
        .first<{ count: number }>();
      expect(activeDevices?.count).toBe(1);
    });

    it('sesi lama pengguna langsung dicabut setelah reset perangkat berhasil', async () => {
      // 1. Ambil hash token sesi aktif saat ini dari database
      const oldSession = await ctx.db
        .prepare(`SELECT session_token_hash FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL`)
        .bind(userRow.id)
        .first<{ session_token_hash: string }>();
      expect(oldSession).toBeTruthy();

      // 2. Terbitkan dan klaim reset
      const issueReq = new Request(`http://localhost:8787/api/admin/users/${userRow.id}/reset-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminSessionCookie }
      });
      const issueRes = await worker.fetch(issueReq, ctx.env);
      const resetCode = (await getJson(issueRes)).data.reset_code;

      const resetReq = new Request('http://localhost:8787/api/auth/reset-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: userRow.username,
          password: userRow.password,
          reset_code: resetCode
        })
      });
      const resetRes = await worker.fetch(resetReq, ctx.env);
      expect(resetRes.status).toBe(200);

      // 3. Verifikasi sesi lama telah memiliki revoked_at != NULL
      const oldSessionAfter = await ctx.db
        .prepare(`SELECT revoked_at FROM user_sessions WHERE session_token_hash = ?`)
        .bind(oldSession?.session_token_hash)
        .first<{ revoked_at: string | null }>();
      expect(oldSessionAfter?.revoked_at).not.toBeNull();
    });

    it('menolak reset jika kode reset telah kedaluwarsa', async () => {
      const issueReq = new Request(`http://localhost:8787/api/admin/users/${userRow.id}/reset-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminSessionCookie }
      });
      const issueRes = await worker.fetch(issueReq, ctx.env);
      const resetCode = (await getJson(issueRes)).data.reset_code;

      // Ubah expires_at menjadi 10 menit lalu
      await ctx.db
        .prepare(`UPDATE device_reset_codes SET expires_at = datetime('now', '-10 minutes') WHERE user_id = ?`)
        .bind(userRow.id)
        .run();

      const resetReq = new Request('http://localhost:8787/api/auth/reset-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: userRow.username,
          password: userRow.password,
          reset_code: resetCode
        })
      });
      const res = await worker.fetch(resetReq, ctx.env);
      expect(res.status).toBe(400);
      const data = await getJson(res);
      expect(data.error).toBe('INVALID_RESET_CODE');
    });

    it('menolak reset jika password salah', async () => {
      const issueReq = new Request(`http://localhost:8787/api/admin/users/${userRow.id}/reset-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminSessionCookie }
      });
      const issueRes = await worker.fetch(issueReq, ctx.env);
      const resetCode = (await getJson(issueRes)).data.reset_code;

      const resetReq = new Request('http://localhost:8787/api/auth/reset-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: userRow.username,
          password: 'WrongPassword123!',
          reset_code: resetCode
        })
      });
      const res = await worker.fetch(resetReq, ctx.env);
      expect(res.status).toBe(401);
      const data = await getJson(res);
      expect(data.error).toBe('INVALID_CREDENTIALS');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. PENGUJIAN SESI, LOGOUT, DAN IDLE TIMEOUT
  // ---------------------------------------------------------------------------
  describe('Manajemen Sesi & Logout (POST /api/auth/logout & GET /api/auth/me)', () => {
    let sessionUser: { username: string; sessionCookie: string; deviceCookie: string };

    beforeEach(async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'session_test_user',
          password: 'PasswordSession123!',
          shopee_link: 'https://shope.ee/session_user',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });
      const res = await worker.fetch(req, ctx.env);
      const cookies = extractResponseCookies(res);
      sessionUser = {
        username: 'session_test_user',
        sessionCookie: `${SESSION_COOKIE_NAME}=${cookies[SESSION_COOKIE_NAME]}`,
        deviceCookie: `${DEVICE_COOKIE_NAME}=${cookies[DEVICE_COOKIE_NAME]}`
      };
    });

    it('GET /api/auth/me mengembalikan profil pengguna yang sah', async () => {
      const meReq = new Request('http://localhost:8787/api/auth/me', {
        method: 'GET',
        headers: { Cookie: sessionUser.sessionCookie }
      });
      const meRes = await worker.fetch(meReq, ctx.env);
      expect(meRes.status).toBe(200);

      const data = await getJson(meRes);
      expect(data.user.username).toBe('session_test_user');
      expect(data.user.role).toBe('member');
      expect(data.device).toHaveProperty('name');
      expect(data.user).not.toHaveProperty('password_hash');
    });

    it('POST /api/auth/logout mencabut sesi dan menghapus cookie sesi', async () => {
      const logoutReq = new Request('http://localhost:8787/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: sessionUser.sessionCookie }
      });
      const logoutRes = await worker.fetch(logoutReq, ctx.env);
      expect(logoutRes.status).toBe(200);

      // Pastikan cookie sesi dikosongkan (Max-Age=0)
      const setCookie = logoutRes.headers.get('Set-Cookie') || '';
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
      expect(setCookie).toContain('Max-Age=0');

      // Request berikutnya ke /api/auth/me ditolak
      const meReq = new Request('http://localhost:8787/api/auth/me', {
        method: 'GET',
        headers: { Cookie: sessionUser.sessionCookie }
      });
      const meRes = await worker.fetch(meReq, ctx.env);
      expect(meRes.status).toBe(401);
    });

    it('menolak sesi yang telah melewati idle timeout 7 hari', async () => {
      // Ubah last_active_at menjadi 8 hari yang lalu
      await ctx.db
        .prepare(`UPDATE user_sessions SET last_active_at = datetime('now', '-8 days')`)
        .run();

      const meReq = new Request('http://localhost:8787/api/auth/me', {
        method: 'GET',
        headers: { Cookie: sessionUser.sessionCookie }
      });
      const meRes = await worker.fetch(meReq, ctx.env);
      expect(meRes.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. PENGUJIAN OTORISASI ADMIN & CSRF
  // ---------------------------------------------------------------------------
  describe('Otorisasi Role Admin & Perlindungan CSRF', () => {
    it('menolak pengguna biasa yang mencoba mengakses endpoint admin (403 FORBIDDEN)', async () => {
      // Buat user biasa
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'regular_user',
          password: 'PasswordValid123!',
          shopee_link: 'https://shope.ee/regular_user',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });
      const res = await worker.fetch(req, ctx.env);
      const cookies = extractResponseCookies(res);
      const userSessionCookie = `${SESSION_COOKIE_NAME}=${cookies[SESSION_COOKIE_NAME]}`;

      // Coba akses GET /api/admin/users
      const adminReq = new Request('http://localhost:8787/api/admin/users', {
        method: 'GET',
        headers: { Cookie: userSessionCookie }
      });
      const adminRes = await worker.fetch(adminReq, ctx.env);
      expect(adminRes.status).toBe(403);
    });

    it('menolak permintaan mutasi state yang berasal dari Origin asing (CSRF Protection)', async () => {
      const csrfReq = new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://malicious-evil-site.com',
          Host: 'localhost:8787'
        },
        body: JSON.stringify({
          username: 'admin_tester',
          password: 'AdminPassword123!'
        })
      });

      const res = await worker.fetch(csrfReq, ctx.env);
      expect(res.status).toBe(403);
      const data = await getJson(res);
      expect(data.error).toBe('CSRF_FORBIDDEN');
    });

    it('menolak logout jika berasal dari Origin asing (403 CSRF_FORBIDDEN)', async () => {
      const logoutReq = new Request('http://localhost:8787/api/auth/logout', {
        method: 'POST',
        headers: {
          Origin: 'https://attacker-evil-site.com',
          Cookie: `${SESSION_COOKIE_NAME}=any_token`
        }
      });
      const res = await worker.fetch(logoutReq, ctx.env);
      expect(res.status).toBe(403);
      const data = await getJson(res);
      expect(data.error).toBe('CSRF_FORBIDDEN');
    });

    it('menolak penerbitan kode reset jika targetUserId bukan UUID yang valid (400 INVALID_USER_ID)', async () => {
      const issueReq = new Request('http://localhost:8787/api/admin/users/invalid-non-uuid-string/reset-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminSessionCookie
        }
      });
      const res = await worker.fetch(issueReq, ctx.env);
      expect(res.status).toBe(400);
      const data = await getJson(res);
      expect(data.error).toBe('INVALID_USER_ID');
    });

    it('membatasi expires_in_days maksimal 365 hari saat membuat kode aktivasi', async () => {
      const createReq = new Request('http://localhost:8787/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminSessionCookie
        },
        body: JSON.stringify({
          expires_in_days: 9999 // Lebih dari 365
        })
      });
      const res = await worker.fetch(createReq, ctx.env);
      expect(res.status).toBe(201);
      const data = await getJson(res);
      expect(data.data.expires_in_days).toBe(365);
    });

    it('memastikan endpoint health check tetap berjalan normal (200 OK)', async () => {
      const req = new Request('http://localhost:8787/api/health', { method: 'GET' });
      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);
      const data = await getJson(res);
      expect(data.status).toBe('ok');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. PENGUJIAN MODUL KRIPTOGRAFI, TIMING, & VERSI HASH
  // ---------------------------------------------------------------------------
  describe('Audit Kriptografi & Komparasi Waktu Konstan', () => {
    it('timingSafeEqual mengembalikan true untuk byte array identik', () => {
      const buf1 = new Uint8Array([10, 20, 30, 40]);
      const buf2 = new Uint8Array([10, 20, 30, 40]);
      expect(timingSafeEqual(buf1, buf2)).toBe(true);
    });

    it('timingSafeEqual mengembalikan false untuk byte array dengan isi berbeda', () => {
      const buf1 = new Uint8Array([10, 20, 30, 40]);
      const buf2 = new Uint8Array([10, 20, 30, 99]);
      expect(timingSafeEqual(buf1, buf2)).toBe(false);
    });

    it('timingSafeEqual mengembalikan false untuk byte array berbeda panjang tanpa melempar exception', () => {
      const shortBuf = new Uint8Array([10, 20, 30]);
      const longBuf = new Uint8Array([10, 20, 30, 40, 50]);
      expect(timingSafeEqual(shortBuf, longBuf)).toBe(false);
      expect(timingSafeEqual(longBuf, shortBuf)).toBe(false);
      expect(timingSafeEqual(new Uint8Array(0), longBuf)).toBe(false);
    });

    it('hashPassword dan verifyPassword mendukung format berversi ($pbkdf2-sha512$v=1$...)', async () => {
      const password = 'SuperSecretPassword123!';
      const { hash, salt } = await hashPassword(password);
      expect(hash).toContain('$pbkdf2-sha512$v=1$i=10000$');

      const isValid = await verifyPassword(password, hash, salt);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword('WrongPassword123!', hash, salt);
      expect(isInvalid).toBe(false);
    });

    it('verifyPassword mendukung format raw hex legacy (backward compatibility)', async () => {
      const password = 'LegacyPassword123!';
      const { hash: versionedHash, salt } = await hashPassword(password);

      // Ekstrak raw hex dari format versi
      const rawHex = versionedHash.split('$').pop()!;
      expect(rawHex.length).toBe(128); // 64 bytes = 128 hex chars

      // Verifikasi menggunakan format hex murni tanpa prefix versi
      const isValid = await verifyPassword(password, rawHex, salt);
      expect(isValid).toBe(true);
    });

    it('generateActivationCode menghasilkan kode berawalan GVS- dengan 26 karakter Base32', () => {
      const code = generateActivationCode();
      expect(code.startsWith('GVS-')).toBe(true);

      const normalized = normalizeCode(code);
      // GVS + 26 karakter = 29 karakter
      expect(normalized.length).toBe(29);
      expect(normalized.startsWith('GVS')).toBe(true);

      const rawBase32 = normalized.slice(3);
      expect(rawBase32.length).toBe(26);
      expect(/^[A-Z2-7]{26}$/.test(rawBase32)).toBe(true);
    });

    it('parsePasswordHash menolak string kosong atau whitespace', () => {
      expect(() => parsePasswordHash('')).toThrow('INVALID_HASH');
      expect(() => parsePasswordHash('   ')).toThrow('INVALID_HASH');
    });

    it('parsePasswordHash menolak iterasi di bawah batas minimum (<1000)', () => {
      const dummyHex = 'a'.repeat(128);
      expect(() => parsePasswordHash(`$pbkdf2-sha512$v=1$i=${MIN_PBKDF2_ITERATIONS - 1}$${dummyHex}`)).toThrow('INVALID_ITERATIONS');
      expect(() => parsePasswordHash(`$pbkdf2-sha512$v=1$i=0$${dummyHex}`)).toThrow('INVALID_ITERATIONS');
    });

    it('parsePasswordHash menolak iterasi di atas batas maksimum (>50000) untuk mencegah DoS', () => {
      const dummyHex = 'a'.repeat(128);
      expect(() => parsePasswordHash(`$pbkdf2-sha512$v=1$i=${MAX_PBKDF2_ITERATIONS + 1}$${dummyHex}`)).toThrow('INVALID_ITERATIONS');
      expect(() => parsePasswordHash(`$pbkdf2-sha512$v=1$i=10000000$${dummyHex}`)).toThrow('INVALID_ITERATIONS');
    });

    it('parsePasswordHash menolak format hash korup atau karakter non-hex', () => {
      expect(() => parsePasswordHash('$pbkdf2-sha512$v=1$i=10000$not-hex-at-all')).toThrow('INVALID_HASH_FORMAT');
      expect(() => parsePasswordHash('corrupted_plain_string')).toThrow('INVALID_HASH_FORMAT');
    });

    it('verifyPassword menolak jika panjang salt tidak tepat 16-byte (32 karakter hex)', async () => {
      const { hash } = await hashPassword('TestPassword123!');
      const invalidSalt = '0123456789abcdef'; // Hanya 16 karakter (8 byte)
      const result = await verifyPassword('TestPassword123!', hash, invalidSalt);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. PENGUJIAN KEAMANAN BOOTSTRAP ADMINISTRATOR (ANTI-TAKEOVER & IDEMPOTENT)
  // ---------------------------------------------------------------------------
  describe('Verifikasi Keamanan Bootstrap Administrator (scripts/bootstrap-admin.js)', () => {
    it('bootstrap pertama kali pada database bersih berhasil membuat 1 akun admin dan audit log', async () => {
      // Buat instance db baru tanpa seed admin
      const cleanCtx = await createIsolatedTestDb();
      try {
        const { sqlStatements, username } = await generateBootstrapAdminSql('root_superadmin', 'InitialAdminPassword123!');
        for (const stmt of sqlStatements) {
          await cleanCtx.db.prepare(stmt).run();
        }

        const adminUser = await cleanCtx.db
          .prepare(`SELECT username, role, status FROM users WHERE username = ?`)
          .bind(username)
          .first<{ username: string; role: string; status: string }>();

        expect(adminUser?.username).toBe('root_superadmin');
        expect(adminUser?.role).toBe('super_admin');
        expect(adminUser?.status).toBe('active');

        const audit = await cleanCtx.db
          .prepare(`SELECT action, details FROM audit_logs WHERE action = 'ACTIVATE_USER'`)
          .first<{ action: string; details: string }>();
        expect(audit?.action).toBe('ACTIVATE_USER');
        expect(audit?.details).toBe('Bootstrap Super Administrator');
      } finally {
        await cleanCtx.cleanup();
      }
    });

    it('eksekusi bootstrap kedua kali (idempotent anti-takeover) tidak membuat admin baru dan tidak menimpa admin lama', async () => {
      const cleanCtx = await createIsolatedTestDb();
      try {
        // 1. Eksekusi bootstrap pertama
        const first = await generateBootstrapAdminSql('admin_asli', 'OriginalPass123!');
        for (const stmt of first.sqlStatements) {
          await cleanCtx.db.prepare(stmt).run();
        }

        // 2. Percobaan bootstrap kedua dengan username sama (idempotent: tidak boleh menimpa password hash)
        const duplicate = await generateBootstrapAdminSql('admin_asli', 'AttackerPass123!');
        for (const stmt of duplicate.sqlStatements) {
          await cleanCtx.db.prepare(stmt).run();
        }

        const totalAdmins = await cleanCtx.db
          .prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'`)
          .first<{ count: number }>();
        expect(totalAdmins?.count).toBe(1);

        const originalUser = await cleanCtx.db
          .prepare(`SELECT username, password_hash FROM users WHERE username = 'admin_asli'`)
          .first<{ username: string; password_hash: string }>();
        expect(originalUser?.username).toBe('admin_asli');
        expect(originalUser?.password_hash).toBe(first.hash);

        // 3. Masukkan 1 super admin tambahan sehingga kuota tepat 2 terpenuhi
        const b2 = await generateBootstrapAdminSql('admin_super_2', 'SuperPass2222!');
        for (const stmt of b2.sqlStatements) await cleanCtx.db.prepare(stmt).run();

        const countFull = await cleanCtx.db
          .prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'`)
          .first<{ count: number }>();
        expect(countFull?.count).toBe(2);

        // 4. Percobaan bootstrap ke-3 oleh penyerang ditolak karena kuota 2 sudah penuh
        const attacker = await generateBootstrapAdminSql('admin_pembajak', 'AttackerPass123!');
        for (const stmt of attacker.sqlStatements) {
          await cleanCtx.db.prepare(stmt).run();
        }

        const countAfterAttack = await cleanCtx.db
          .prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'`)
          .first<{ count: number }>();
        expect(countAfterAttack?.count).toBe(2);

        const attackerUser = await cleanCtx.db
          .prepare(`SELECT id FROM users WHERE username = 'admin_pembajak'`)
          .first<{ id: string }>();
        expect(attackerUser).toBeNull();
      } finally {
        await cleanCtx.cleanup();
      }
    });

    it('dua proses bootstrap simultan saat sisa kuota 1 hanya menghasilkan tepat 1 akun admin tambahan', async () => {
      const cleanCtx = await createIsolatedTestDb();
      try {
        // Isi hingga tersisa 1 slot (1 super admin terisi dari batas maksimal 2)
        const b1 = await generateBootstrapAdminSql('admin_slot_1', 'SlotPass111!');
        for (const s of b1.sqlStatements) await cleanCtx.db.prepare(s).run();

        const boot1 = await generateBootstrapAdminSql('admin_race_1', 'RacePassword123!');
        const boot2 = await generateBootstrapAdminSql('admin_race_2', 'RacePassword456!');

        // Eksekusi statement SQL secara bersamaan memperebutkan slot terakhir
        const [results1, results2] = await Promise.all([
          (async () => {
            const res = [];
            for (const s of boot1.sqlStatements) res.push(await cleanCtx.db.prepare(s).run());
            return res;
          })(),
          (async () => {
            const res = [];
            for (const s of boot2.sqlStatements) res.push(await cleanCtx.db.prepare(s).run());
            return res;
          })()
        ]);

        // Verifikasi hasil kembalian eksekusi: tepat 1 proses yang berhasil meng-insert baris user baru
        const changes1 = (results1[0] as any)?.meta?.changes ?? 0;
        const changes2 = (results2[0] as any)?.meta?.changes ?? 0;
        expect(changes1 + changes2).toBe(1);

        // Verifikasi record database: tepat 1 akun yang terbentuk antara admin_race_1 atau admin_race_2
        const race1User = await cleanCtx.db
          .prepare(`SELECT id, username FROM users WHERE username = 'admin_race_1'`)
          .first<{ id: string; username: string }>();
        const race2User = await cleanCtx.db
          .prepare(`SELECT id, username FROM users WHERE username = 'admin_race_2'`)
          .first<{ id: string; username: string }>();

        const race1Created = race1User !== null;
        const race2Created = race2User !== null;
        expect(race1Created !== race2Created).toBe(true);

        const adminCount = await cleanCtx.db
          .prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'`)
          .first<{ count: number }>();
        expect(adminCount?.count).toBe(2);
      } finally {
        await cleanCtx.cleanup();
      }
    });

    it('validasi input bootstrap menolak username pendek atau password di bawah 8 karakter', async () => {
      await expect(generateBootstrapAdminSql('ab', 'ValidPass123!')).rejects.toThrow('Username');
      await expect(generateBootstrapAdminSql('valid_user', 'short')).rejects.toThrow('Password');
    });

    it('parseBootstrapArgs menolak opsi --pass, -p, dan seluruh variasinya demi keamanan', () => {
      expect(() => parseBootstrapArgs(['--pass', 'secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['-p', 'secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['--password', 'secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['--passwd', 'secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['--PASS', 'secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['-P', 'secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['--pass=secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['-p=secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['--password=secret123'])).toThrow('ARGUMENT_REJECTED');
      expect(() => parseBootstrapArgs(['--PASS=secret123'])).toThrow('ARGUMENT_REJECTED');
    });

    it('parseBootstrapArgs menolak opsi dengan argumen yang kurang, bernilai kosong, atau opsi tidak dikenal', () => {
      expect(() => parseBootstrapArgs(['--user'])).toThrow('ARGUMENT_ERROR');
      expect(() => parseBootstrapArgs(['-u'])).toThrow('ARGUMENT_ERROR');
      expect(() => parseBootstrapArgs(['--user='])).toThrow('ARGUMENT_ERROR');
      expect(() => parseBootstrapArgs(['-u='])).toThrow('ARGUMENT_ERROR');
      expect(() => parseBootstrapArgs(['--user', '   '])).toThrow('ARGUMENT_ERROR');
      expect(() => parseBootstrapArgs(['-u', '   '])).toThrow('ARGUMENT_ERROR');
    });

    it('parseBootstrapArgs menolak argumen posisi dan opsi asing tanpa membocorkan nilai sensitif', () => {
      // Argumen posisi asing ditolak
      expect(() => parseBootstrapArgs(['unexpected_positional_value'])).toThrow('ARGUMENT_ERROR');
      expect(() => parseBootstrapArgs(['--sql-only', 'extra_arg'])).toThrow('ARGUMENT_ERROR');

      // Pastikan pesan error tidak merefleksikan kembali teks sensitif yang tidak sengaja diketik
      const sensitiveToken = 'superSecretSensitiveText123';
      try {
        parseBootstrapArgs([`--${sensitiveToken}`]);
        expect.unreachable();
      } catch (err: any) {
        expect(err.message).toContain('ARGUMENT_ERROR');
        expect(err.message).not.toContain(sensitiveToken);
      }

      try {
        parseBootstrapArgs([sensitiveToken]);
        expect.unreachable();
      } catch (err: any) {
        expect(err.message).toContain('ARGUMENT_ERROR');
        expect(err.message).not.toContain(sensitiveToken);
      }
    });

    it('promptHiddenPassword menolak eksekusi pada lingkungan stdin non-interaktif (non-TTY)', async () => {
      // Dalam vitest runner lingkungan non-TTY, promptHiddenPassword wajib menolak TTY_REQUIRED
      if (!process.stdin.isTTY) {
        await expect(promptHiddenPassword('Test: ')).rejects.toThrow('TTY_REQUIRED');
      }
    });

    it('parseBootstrapArgs menerima opsi aman --user, -u, dan --sql-only', () => {
      const opts = parseBootstrapArgs(['--user', 'custom_admin', '--sql-only']);
      expect(opts.username).toBe('custom_admin');
      expect(opts.generateSqlOnly).toBe(true);

      const optsShort = parseBootstrapArgs(['-u', 'short_admin']);
      expect(optsShort.username).toBe('short_admin');

      const optsEq = parseBootstrapArgs(['--user=admin_equal']);
      expect(optsEq.username).toBe('admin_equal');
      expect(optsEq.generateSqlOnly).toBe(false);

      const optsEqShort = parseBootstrapArgs(['-u=admin_short_eq']);
      expect(optsEqShort.username).toBe('admin_short_eq');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. PENGUJIAN PERMUTASI LENGKAP PERLINDUNGAN CSRF PADA ENDPOINT MUTASI
  // ---------------------------------------------------------------------------
  describe('Permutasi Perlindungan CSRF & Fallback Referer', () => {
    it('mengizinkan mutasi jika Origin tidak ada tetapi Referer cocok dengan origin target', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'http://localhost:8787/activate' // Same-origin Referer
        },
        body: JSON.stringify({
          activation_code: code,
          username: 'referer_success_user',
          password: 'PasswordValid123!',
          shopee_link: 'https://shope.ee/referer_success',
          whatsapp: '081234567890',
          registration_path: 'direct'
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);
    });

    it('menolak mutasi jika Origin tidak ada dan Referer berasal dari situs asing', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://malicious-external-site.com/fake-page' // Cross-origin Referer
        },
        body: JSON.stringify({
          activation_code: code,
          username: 'referer_fail_user',
          password: 'PasswordValid123!'
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(403);
      const data = await getJson(res);
      expect(data.error).toBe('CSRF_FORBIDDEN');
    });

    it('menolak seluruh endpoint mutasi jika Sec-Fetch-Site bernilai cross-site', async () => {
      const testCases = [
        { path: '/api/auth/activate', body: { activation_code: 'GVS-ANY', username: 'u', password: 'p' } },
        { path: '/api/auth/login', body: { username: 'u', password: 'p' } },
        { path: '/api/auth/reset-device', body: { username: 'u', password: 'p', reset_code: 'r' } },
        { path: '/api/auth/logout', body: {} }
      ];

      for (const tc of testCases) {
        const req = new Request(`http://localhost:8787${tc.path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Sec-Fetch-Site': 'cross-site'
          },
          body: JSON.stringify(tc.body)
        });
        const res = await worker.fetch(req, ctx.env);
        expect(res.status).toBe(403);
        const data = await getJson(res);
        expect(data.error).toBe('CSRF_FORBIDDEN');
      }
    });
  });

  describe('Ketahanan Parsing Cookie & Penanganan Cookie Duplikat / Ambigu (worker/cookies.ts)', () => {
    it('1. Cookie malformed tanpa cookie sesi valid diabaikan dan tidak menyebabkan error 500', async () => {
      // Unit test: nilai malformed tidak disimpan di kamus
      const req = new Request('http://localhost:8787/api/auth/me', {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=malformed%ZZ%FF; bad_ad=%%; another=%E0%A0`
        }
      });
      const parsed = parseCookies(req);
      expect(parsed[SESSION_COOKIE_NAME]).toBeUndefined();
      expect(parsed['bad_ad']).toBeUndefined();
      expect(parsed['another']).toBeUndefined();

      // Endpoint test: memanggil Worker tidak memicu error 500, melainkan ditolak aman 401
      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(401);
      const data = await getJson(res);
      expect(data.error).toBe('UNAUTHORIZED');
    });

    it('2. Cookie sesi valid yang diikuti cookie sesi duplikat malformed tetap mempertahankan sesi valid', async () => {
      // Unit test: cookie malformed kedua diabaikan, sehingga token valid pertama tidak tertimpa
      const rawCookieHeader = `${adminSessionCookie}; ${SESSION_COOKIE_NAME}=corrupted%ZZ%FF`;
      const req = new Request('http://localhost:8787/api/auth/me', {
        headers: { Cookie: rawCookieHeader }
      });
      const parsed = parseCookies(req);
      expect(parsed[SESSION_COOKIE_NAME]).toBeDefined();

      // Endpoint test: Worker berhasil mengautentikasi admin
      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);
      const data = await getJson(res);
      expect(data.status).toBe('ok');
      expect(data.user.id).toBe(adminId);
    });

    it('3. Cookie malformed yang muncul sebelum cookie sesi valid tidak membatalkan pembacaan sesi valid', async () => {
      // Kasus 3a: Cookie asing malformed muncul sebelum sesi valid
      const reqForeign = new Request('http://localhost:8787/api/auth/me', {
        headers: { Cookie: `analytics_corrupt=%%; ${adminSessionCookie}` }
      });
      const parsedForeign = parseCookies(reqForeign);
      expect(parsedForeign[SESSION_COOKIE_NAME]).toBeDefined();

      const resForeign = await worker.fetch(reqForeign, ctx.env);
      expect(resForeign.status).toBe(200);

      // Kasus 3b: Cookie nama sesi yang malformed muncul sebelum cookie sesi yang valid
      const reqSameKey = new Request('http://localhost:8787/api/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=broken%ZZ; ${adminSessionCookie}` }
      });
      const parsedSameKey = parseCookies(reqSameKey);
      expect(parsedSameKey[SESSION_COOKIE_NAME]).toBeDefined();

      const resSameKey = await worker.fetch(reqSameKey, ctx.env);
      expect(resSameKey.status).toBe(200);
      const dataSameKey = await getJson(resSameKey);
      expect(dataSameKey.user.id).toBe(adminId);
    });

    it('4. Cookie sesi kosong dan token tidak valid tetap ditolak (401 UNAUTHORIZED)', async () => {
      // Kasus 4a: Cookie sesi bernilai kosong
      const reqEmpty = new Request('http://localhost:8787/api/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=` }
      });
      const parsedEmpty = parseCookies(reqEmpty);
      expect(parsedEmpty[SESSION_COOKIE_NAME]).toBe('');

      const resEmpty = await worker.fetch(reqEmpty, ctx.env);
      expect(resEmpty.status).toBe(401);
      const dataEmpty = await getJson(resEmpty);
      expect(dataEmpty.error).toBe('UNAUTHORIZED');

      // Kasus 4b: Token acak tidak dikenal di database
      const reqBogus = new Request('http://localhost:8787/api/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=bogus_token_random_1234567890abcdef` }
      });
      const resBogus = await worker.fetch(reqBogus, ctx.env);
      expect(resBogus.status).toBe(401);
      const dataBogus = await getJson(resBogus);
      expect(dataBogus.error).toBe('UNAUTHORIZED');
    });

    it('5. Kebijakan ketat cookie duplikat: nilai berbeda (ambigu) dibatalkan dan ditolak demi keamanan', async () => {
      // Dua token sesi berbeda dikirim bersamaan dalam satu header: ambigu!
      const reqAmbiguous = new Request('http://localhost:8787/api/auth/me', {
        headers: {
          Cookie: `${adminSessionCookie}; ${SESSION_COOKIE_NAME}=another_conflicting_token_xyz`
        }
      });
      const parsed = parseCookies(reqAmbiguous);
      // Nilai ambigu harus dibatalkan (dihapus dari kamus)
      expect(parsed[SESSION_COOKIE_NAME]).toBeUndefined();

      // Endpoint test: permintaan dengan cookie sesi ambigu ditolak secara ketat
      const res = await worker.fetch(reqAmbiguous, ctx.env);
      expect(res.status).toBe(401);
      const data = await getJson(res);
      expect(data.error).toBe('UNAUTHORIZED');
    });

    it('6. Cookie duplikat dengan nilai identik tetap diterima tanpa dianggap ambigu', async () => {
      const reqIdentical = new Request('http://localhost:8787/api/auth/me', {
        headers: {
          Cookie: `${adminSessionCookie}; ${adminSessionCookie}`
        }
      });
      const parsed = parseCookies(reqIdentical);
      expect(parsed[SESSION_COOKIE_NAME]).toBeDefined();

      const res = await worker.fetch(reqIdentical, ctx.env);
      expect(res.status).toBe(200);
      const data = await getJson(res);
      expect(data.user.id).toBe(adminId);
    });
  });

  describe('Hardening Rate Limiting & Regresi Keamanan Autentikasi', () => {
    let testUser: { id: string; username: string; password: string };

    beforeEach(async () => {
      clearAllRateLimits();
      setRateLimitClock(null);
      setMaxRateLimitEntries(null);
      const user = await seedTestAdminWithoutDevice(ctx.db, 'rate_limit_user', 'CorrectPass123!');
      testUser = { id: user.id, username: user.username, password: user.password };
    });

    afterEach(() => {
      clearAllRateLimits();
      setRateLimitClock(null);
      setMaxRateLimitEntries(null);
    });

    it('1. Login gagal mencapai batas (5 kali) menghasilkan HTTP 429 dan respons aman', async () => {
      const sendLogin = (pwd: string) =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '192.0.2.1'
            },
            body: JSON.stringify({ username: testUser.username, password: pwd })
          }),
          ctx.env
        );

      // 5 kali percobaan gagal
      for (let i = 0; i < 5; i++) {
        const res = await sendLogin('WrongPass!');
        expect(res.status).toBe(401);
      }

      // Percobaan ke-6 diblokir dengan 429
      const blockedRes = await sendLogin('WrongPass!');
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers.get('Retry-After')).toBeDefined();

      const data = await getJson(blockedRes);
      expect(data.error).toBe('TOO_MANY_ATTEMPTS');
      expect(data.message).toContain('Terlalu banyak percobaan');
      expect(JSON.stringify(data)).not.toContain(testUser.username);
      expect(JSON.stringify(data)).not.toContain('WrongPass!');
    });

    it('2. Percobaan gagal di bawah ambang batas kedaluwarsa setelah jendela waktu (10 menit)', async () => {
      let simulatedTime = 1700000000000;
      setRateLimitClock(() => simulatedTime);

      const sendLogin = () =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '192.0.2.2'
            },
            body: JSON.stringify({ username: testUser.username, password: 'WrongPassword!' })
          }),
          ctx.env
        );

      // 4 kali salah (di bawah batas 5)
      for (let i = 0; i < 4; i++) {
        const res = await sendLogin();
        expect(res.status).toBe(401);
      }

      // Majukan waktu 11 menit (melewati jendela akumulasi 10 menit)
      simulatedTime += 11 * 60 * 1000;

      // Percobaan berikutnya harus diperlakukan sebagai jendela baru (kembali 401, BUKAN 429)
      const nextRes = await sendLogin();
      expect(nextRes.status).toBe(401);
      const nextData = await getJson(nextRes);
      expect(nextData.error).toBe('INVALID_CREDENTIALS');
    });

    it('3. Login berhasil mereset counter percobaan gagal', async () => {
      const sendLogin = (pwd: string) =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '192.0.2.3'
            },
            body: JSON.stringify({ username: testUser.username, password: pwd })
          }),
          ctx.env
        );

      // 4 kali salah
      for (let i = 0; i < 4; i++) {
        const res = await sendLogin('WrongPass!');
        expect(res.status).toBe(401);
      }

      // Login berhasil pada percobaan berikutnya
      const okRes = await sendLogin(testUser.password);
      expect(okRes.status).toBe(200);

      // Setelah reset, 4 percobaan salah berikutnya tetap diizinkan (tidak langsung 429)
      for (let i = 0; i < 4; i++) {
        const res = await sendLogin('WrongPassAgain!');
        expect(res.status).toBe(401);
      }
    });

    it('4. Masa pemblokiran rate limit berakhir setelah durasi blokir (15 menit) selesai', async () => {
      let simulatedTime = 1700000000000;
      setRateLimitClock(() => simulatedTime);

      const sendLogin = (pwd: string) =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '192.0.2.4'
            },
            body: JSON.stringify({ username: testUser.username, password: pwd })
          }),
          ctx.env
        );

      // Picu 5 kegagalan berturut-turut
      for (let i = 0; i < 5; i++) {
        await sendLogin('WrongPass!');
      }

      // Terblokir
      const blockedRes = await sendLogin('WrongPass!');
      expect(blockedRes.status).toBe(429);

      // Majukan waktu 16 menit (melewati masa blokir 15 menit)
      simulatedTime += 16 * 60 * 1000;

      // Percobaan berikutnya harus diizinkan kembali
      const afterBlockRes = await sendLogin('WrongPass!');
      expect(afterBlockRes.status).toBe(401);
    });

    it('5. Batas IP berlaku pada endpoint aktivasi (POST /api/auth/activate)', async () => {
      const sendActivate = (code: string) =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/activate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '198.51.100.10'
            },
            body: JSON.stringify({
              activation_code: code,
              username: 'new_member_candidate',
              password: 'MemberPass123!',
              shopee_link: 'https://shopee.co.id/member_shop',
              whatsapp: '081234567890',
              registration_path: 'direct'
            })
          }),
          ctx.env
        );

      // 10 kali aktivasi kode salah dari IP yang sama
      for (let i = 0; i < 10; i++) {
        const res = await sendActivate(`WRONG-CODE-${i}`);
        expect(res.status).toBe(400);
      }

      // Percobaan ke-11 dari IP tersebut diblokir oleh IP rate limiter
      const blockedRes = await sendActivate('WRONG-CODE-11');
      expect(blockedRes.status).toBe(429);
      const data = await getJson(blockedRes);
      expect(data.error).toBe('TOO_MANY_ATTEMPTS');
      expect(data.message).toContain('percobaan aktivasi');
    });

    it('6. Batas IP dan akun berlaku pada endpoint reset perangkat (POST /api/auth/reset-device)', async () => {
      const sendReset = (pwd: string, code: string, ip = '198.51.100.20') =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/reset-device', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': ip
            },
            body: JSON.stringify({
              username: testUser.username,
              password: pwd,
              reset_code: code,
              device_name: 'Device Baru'
            })
          }),
          ctx.env
        );

      // 5 kali percobaan salah untuk akun target pada IP ini
      for (let i = 0; i < 5; i++) {
        const res = await sendReset('WrongPassword!', 'INVALID-RESET-CODE');
        expect(res.status).toBe(401);
      }

      // Percobaan ke-6 diblokir dengan 429
      const blockedRes = await sendReset('WrongPassword!', 'INVALID-RESET-CODE');
      expect(blockedRes.status).toBe(429);
      const data = await getJson(blockedRes);
      expect(data.error).toBe('TOO_MANY_ATTEMPTS');
      expect(data.message).toContain('pemulihan perangkat');
    });

    it('7. Permintaan yang diblokir rate limit tidak menjalankan verifikasi database atau crypto yang mahal', async () => {
      // Buat akun terblokir
      for (let i = 0; i < 5; i++) {
        await worker.fetch(
          new Request('http://localhost:8787/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '198.51.100.30'
            },
            body: JSON.stringify({ username: testUser.username, password: 'WrongPassword!' })
          }),
          ctx.env
        );
      }

      const auditBefore = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM audit_logs`)
        .first<{ count: number }>();

      const blockedRes = await worker.fetch(
        new Request('http://localhost:8787/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '198.51.100.30'
          },
          body: JSON.stringify({ username: testUser.username, password: testUser.password })
        }),
        ctx.env
      );

      expect(blockedRes.status).toBe(429);

      const auditAfter = await ctx.db
        .prepare(`SELECT COUNT(*) as count FROM audit_logs`)
        .first<{ count: number }>();
      expect(auditAfter?.count).toBe(auditBefore?.count);
    });

    it('8. IP yang berbeda memiliki penghitung rate limit yang terpisah', async () => {
      const sendLoginFromIp = (ip: string) =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': ip
            },
            body: JSON.stringify({ username: testUser.username, password: 'WrongPassword!' })
          }),
          ctx.env
        );

      // Blokir IP 1
      for (let i = 0; i < 5; i++) {
        await sendLoginFromIp('203.0.113.10');
      }
      const ip1Res = await sendLoginFromIp('203.0.113.10');
      expect(ip1Res.status).toBe(429);

      // IP 2 dari pengguna yang sah tidak terblokir
      const ip2Res = await sendLoginFromIp('203.0.113.20');
      expect(ip2Res.status).toBe(401);
    });

    it('9. Respons HTTP 429 tidak membocorkan data sensitif atau kredensial', async () => {
      for (let i = 0; i < 5; i++) {
        await worker.fetch(
          new Request('http://localhost:8787/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '203.0.113.99'
            },
            body: JSON.stringify({ username: testUser.username, password: 'WrongPassword!' })
          }),
          ctx.env
        );
      }

      const res = await worker.fetch(
        new Request('http://localhost:8787/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.99'
          },
          body: JSON.stringify({ username: testUser.username, password: 'WrongPassword!' })
        }),
        ctx.env
      );

      expect(res.status).toBe(429);
      const text = await res.text();
      expect(text).not.toContain(testUser.username);
      expect(text).not.toContain(testUser.password);
      expect(text).not.toContain('stack');
      expect(text).not.toContain('hash');
      expect(text).not.toContain('salt');
    });

    it('10. Username, kode aktivasi, kode reset, dan password tidak pernah disimpan mentah dalam key Map', async () => {
      clearAllRateLimits();

      const sensitiveUser = 'super_secret_username_99';
      const sensitivePass = 'SuperSecretP@ssword99!';
      const sensitiveActCode = 'SECRET-ACTIVATE-CODE-999';
      const sensitiveResetCode = 'SECRET-RESET-CODE-888';

      // 1. Picu login attempt
      await worker.fetch(
        new Request('http://localhost:8787/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '198.51.100.50'
          },
          body: JSON.stringify({ username: sensitiveUser, password: sensitivePass })
        }),
        ctx.env
      );

      // 2. Picu activate attempt
      await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '198.51.100.50'
          },
          body: JSON.stringify({
            activation_code: sensitiveActCode,
            username: sensitiveUser,
            password: sensitivePass,
            shopee_link: 'https://shopee.co.id/test_shop',
            whatsapp: '081234567890',
            registration_path: 'direct'
          })
        }),
        ctx.env
      );

      // 3. Picu reset-device attempt
      await worker.fetch(
        new Request('http://localhost:8787/api/auth/reset-device', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '198.51.100.50'
          },
          body: JSON.stringify({
            username: sensitiveUser,
            password: sensitivePass,
            reset_code: sensitiveResetCode
          })
        }),
        ctx.env
      );

      const keys = getRateLimitKeys();
      expect(keys.length).toBeGreaterThan(0);

      for (const k of keys) {
        expect(k).not.toContain(sensitiveUser);
        expect(k).not.toContain(sensitivePass);
        expect(k).not.toContain(sensitiveActCode);
        expect(k).not.toContain(sensitiveResetCode);
        expect(k).toMatch(/^(login|activate_ip|reset_ip|reset_acc):[0-9a-f]{64}$/);
      }
    });

    it('11. getClientIp hanya mempercayai CF-Connecting-IP dan menolak pemalsuan X-Forwarded-For', () => {
      // 1. CF-Connecting-IP sah digunakan
      const reqValid = new Request('http://localhost:8787/api/auth/login', {
        headers: { 'CF-Connecting-IP': '203.0.113.15' }
      });
      expect(getClientIp(reqValid)).toBe('203.0.113.15');

      // 2. Pemalsuan X-Forwarded-For tanpa CF-Connecting-IP ditolak dan kembali ke fallback 127.0.0.1
      const reqSpoofed = new Request('http://localhost:8787/api/auth/login', {
        headers: { 'X-Forwarded-For': '198.51.100.99, 10.0.0.1' }
      });
      expect(getClientIp(reqSpoofed)).toBe('127.0.0.1');

      // 3. Gabungan CF-Connecting-IP sah dan X-Forwarded-For palsu tetap memprioritaskan CF-Connecting-IP
      const reqMixed = new Request('http://localhost:8787/api/auth/login', {
        headers: {
          'CF-Connecting-IP': '203.0.113.25',
          'X-Forwarded-For': '198.51.100.99'
        }
      });
      expect(getClientIp(reqMixed)).toBe('203.0.113.25');
    });

    it('12. Eviksi kapasitas Map melindungi catatan blokir aktif dan hanya membuang entri non-blokir', () => {
      setMaxRateLimitEntries(3);
      clearAllRateLimits();

      const now = 1700000000000;
      setRateLimitClock(() => now);

      // 1. Kunci A dibuat terblokir aktif (blockedUntil = now + 15 menit)
      for (let i = 0; i < 5; i++) {
        recordRateLimitFailure('key-blocked-A', { maxAttempts: 5, windowMs: 10 * 60 * 1000, blockDurationMs: 15 * 60 * 1000 });
      }
      expect(checkRateLimit('key-blocked-A').allowed).toBe(false);

      // 2. Kunci B dan C memiliki 1 kegagalan (tidak diblokir)
      recordRateLimitFailure('key-unblocked-B');
      recordRateLimitFailure('key-unblocked-C');

      // 3. Tambahkan Kunci D (unblocked) -> total ukuran menjadi 4, melebihi kapasitas 3
      recordRateLimitFailure('key-unblocked-D');

      // 4. Jalankan pruning
      pruneRateLimitRecords(now);

      const keys = getRateLimitKeys();
      // Buktikan kapasitas dibatasi sesuai batas maksimum
      expect(keys.length).toBeLessThanOrEqual(3);
      // JAMINAN KEAMANAN KRITIS: Kunci A yang sedang diblokir aktif TIDAK BOLEH terhapus!
      expect(keys).toContain('key-blocked-A');
      expect(checkRateLimit('key-blocked-A').allowed).toBe(false);
      // Kunci unblocked tertua (B) yang dievakuasi
      expect(keys).not.toContain('key-unblocked-B');
    });

    it('13. Kondisi saturasi kapasitas penuh blokir aktif menerapkan fail-closed tanpa menghapus blokir lama', () => {
      setMaxRateLimitEntries(2);
      clearAllRateLimits();

      const now = 1700000000000;
      setRateLimitClock(() => now);

      // Penuhi seluruh kapasitas (2 entri) dengan blokir aktif
      for (let i = 0; i < 5; i++) {
        recordRateLimitFailure('active-lock-1', { maxAttempts: 5, windowMs: 10 * 60 * 1000, blockDurationMs: 15 * 60 * 1000 });
        recordRateLimitFailure('active-lock-2', { maxAttempts: 5, windowMs: 10 * 60 * 1000, blockDurationMs: 15 * 60 * 1000 });
      }

      // Kunci ketiga yang baru mencoba masuk saat kapasitas jenuh
      const checkResult = checkRateLimit('incoming-new-key');
      // Perilaku fail-closed aman: ditolak sementara (429) alih-alih meloloskan request
      expect(checkResult.allowed).toBe(false);
      expect(checkResult.retryAfterSeconds).toBeDefined();

      // Pastikan kedua blokir aktif sebelumnya tidak ada yang terhapus
      const keys = getRateLimitKeys();
      expect(keys).toContain('active-lock-1');
      expect(keys).toContain('active-lock-2');
    });

    it('14. Password benar tetapi reset code salah tetap dihitung sebagai kegagalan rate limit', async () => {
      const sendReset = (pwd: string, code: string) =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/reset-device', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '198.51.100.77'
            },
            body: JSON.stringify({
              username: testUser.username,
              password: pwd,
              reset_code: code,
              device_name: 'Device Test'
            })
          }),
          ctx.env
        );

      // 5 kali percobaan dengan password BENAR tetapi reset code SALAH
      for (let i = 0; i < 5; i++) {
        const res = await sendReset(testUser.password, `INVALID-CODE-${i}`);
        expect(res.status).toBe(400);
        const data = await getJson(res);
        expect(data.error).toBe('INVALID_RESET_CODE');
      }

      // Percobaan ke-6 harus diblokir oleh rate limiter (HTTP 429)
      const blockedRes = await sendReset(testUser.password, 'INVALID-CODE-6');
      expect(blockedRes.status).toBe(429);
      const blockedData = await getJson(blockedRes);
      expect(blockedData.error).toBe('TOO_MANY_ATTEMPTS');
    });

    it('15. Reset perangkat yang sukses membersihkan counter dan mengizinkan kuota percobaan berikutnya', async () => {
      // 1. Buat member dengan akun dan perangkat awal
      const { code: actCode } = await seedTestActivationCode(ctx.db, adminId);
      const memberPass = 'ValidMemberPassword123!';
      const actRes = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '198.51.100.88'
          },
          body: JSON.stringify({
            activation_code: actCode,
            username: 'clean_reset_user',
            password: memberPass,
            shopee_link: 'https://shopee.co.id/clean_reset_shop',
            whatsapp: '081234567890',
            registration_path: 'direct'
          })
        }),
        ctx.env
      );
      expect(actRes.status).toBe(200);

      const userInDb = await ctx.db
        .prepare(`SELECT id FROM users WHERE username = 'clean_reset_user'`)
        .first<{ id: string }>();

      // 2. Terbitkan kode reset yang sah dari admin
      const issueRes = await worker.fetch(
        new Request(`http://localhost:8787/api/admin/users/${userInDb!.id}/reset-code`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: adminSessionCookie
          },
          body: JSON.stringify({ reason: 'Ganti HP baru' })
        }),
        ctx.env
      );
      expect(issueRes.status).toBe(201);
      const issueData = await getJson(issueRes);
      const validResetCode = issueData.data.reset_code;

      const sendResetReq = (pwd: string, code: string) =>
        worker.fetch(
          new Request('http://localhost:8787/api/auth/reset-device', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '198.51.100.88'
            },
            body: JSON.stringify({
              username: 'clean_reset_user',
              password: pwd,
              reset_code: code,
              device_name: 'Browser Baru'
            })
          }),
          ctx.env
        );

      // 3. Akumulasikan 4 kegagalan (tepat di bawah batas 5)
      for (let i = 0; i < 4; i++) {
        const failRes = await sendResetReq(memberPass, 'WRONG-RESET-CODE');
        expect(failRes.status).toBe(400);
      }

      // 4. Kirim reset yang sah dengan kode valid
      const successRes = await sendResetReq(memberPass, validResetCode);
      expect(successRes.status).toBe(200);
      const successData = await getJson(successRes);
      expect(successData.status).toBe('ok');

      // 5. Buktikan bahwa counter telah bersih: 4 percobaan gagal berikutnya tidak langsung memicu 429
      for (let i = 0; i < 4; i++) {
        const afterRes = await sendResetReq('WrongPassword!', 'ANY-CODE');
        expect(afterRes.status).toBe(401);
      }
    });

    it('16. Fake clock dapat diset dan dibersihkan kembali ke jam sistem secara benar', () => {
      const fixedTime = 1600000000000;
      setRateLimitClock(() => fixedTime);
      expect(getRateLimitNow()).toBe(fixedTime);

      setRateLimitClock(null);
      const systemNow = getRateLimitNow();
      expect(systemNow).toBeGreaterThan(1700000000000);
      expect(Math.abs(systemNow - Date.now())).toBeLessThan(50);
    });

    it('17. Override kapasitas rate limit dapat diset dan dikembalikan ke nilai default (5000)', () => {
      setMaxRateLimitEntries(10);
      expect(getMaxRateLimitEntries()).toBe(10);

      setMaxRateLimitEntries(null);
      expect(getMaxRateLimitEntries()).toBe(5000);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. FITUR 2: DATA PENDAFTARAN ANGGOTA (WHATSAPP, JALUR, PENGUNDANG)
  // ---------------------------------------------------------------------------
  describe('Fitur 2: Data Pendaftaran Anggota (WhatsApp, Jalur Pendaftaran, Nama Pengundang)', () => {
    it('aktivasi dengan direct menyimpan WhatsApp ternormalisasi dan inviter_name = null', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const res = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'member_direct',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/member_direct',
            whatsapp: '0812-3456-7890',
            registration_path: 'direct'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(200);
      const data = await getJson(res);
      expect(data.status).toBe('ok');
      expect(data.user.whatsapp).toBe('6281234567890');
      expect(data.user.registration_path).toBe('direct');
      expect(data.user.inviter_name).toBeNull();

      const dbUser = await ctx.db
        .prepare(`SELECT whatsapp, registration_path, inviter_name FROM users WHERE username = 'member_direct'`)
        .first<{ whatsapp: string; registration_path: string; inviter_name: string | null }>();
      expect(dbUser?.whatsapp).toBe('6281234567890');
      expect(dbUser?.registration_path).toBe('direct');
      expect(dbUser?.inviter_name).toBeNull();
    });

    it('aktivasi dengan referral menyimpan WhatsApp ternormalisasi dan inviter_name', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const res = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'member_referral',
            password: 'Password123!',
            shopee_link: 'https://shope.ee/member_referral',
            whatsapp: '+62 821 9876 5432',
            registration_path: 'referral',
            inviter_name: 'Budi Santoso'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(200);
      const data = await getJson(res);
      expect(data.status).toBe('ok');
      expect(data.user.whatsapp).toBe('6282198765432');
      expect(data.user.registration_path).toBe('referral');
      expect(data.user.inviter_name).toBe('Budi Santoso');

      const dbUser = await ctx.db
        .prepare(`SELECT whatsapp, registration_path, inviter_name FROM users WHERE username = 'member_referral'`)
        .first<{ whatsapp: string; registration_path: string; inviter_name: string }>();
      expect(dbUser?.whatsapp).toBe('6282198765432');
      expect(dbUser?.registration_path).toBe('referral');
      expect(dbUser?.inviter_name).toBe('Budi Santoso');
    });

    it('normalisasi berbagai variasi format nomor WhatsApp Indonesia (08..., 628..., +628...)', async () => {
      const testCases = [
        { input: '081234567890', expected: '6281234567890' },
        { input: '6281234567891', expected: '6281234567891' },
        { input: '+6281234567892', expected: '6281234567892' },
        { input: '0812-3456-7893', expected: '6281234567893' },
        { input: '+62 812 3456 7894', expected: '6281234567894' }
      ];

      for (let i = 0; i < testCases.length; i++) {
        const { code } = await seedTestActivationCode(ctx.db, adminId);
        const res = await worker.fetch(
          new Request('http://localhost:8787/api/auth/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              activation_code: code,
              username: `norm_user_${i}`,
              password: 'Password123!',
              shopee_link: `https://shopee.co.id/norm_${i}`,
              whatsapp: testCases[i].input,
              registration_path: 'direct'
            })
          }),
          ctx.env
        );
        expect(res.status).toBe(200);
        const data = await getJson(res);
        expect(data.user.whatsapp).toBe(testCases[i].expected);
      }
    });

    it('menolak aktivasi jika WhatsApp tidak diisi (400 MISSING_WHATSAPP)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const res = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'user_no_wa',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/user_no_wa',
            registration_path: 'direct'
          })
        }),
        ctx.env
      );
      expect(res.status).toBe(400);
      const data = await getJson(res);
      expect(data.error).toBe('MISSING_WHATSAPP');
    });

    it('menolak aktivasi jika nomor WhatsApp tidak valid (huruf, terlalu pendek, terlalu panjang, bukan nomor Indonesia)', async () => {
      const invalidNumbers = [
        '08123abc456', // mengandung huruf
        '0812345',     // terlalu pendek (< 11 digit canonical)
        '08123456789012345', // terlalu panjang (> 15 digit)
        '+12025550123', // nomor US
        '0217654321',  // telepon rumah, bukan HP 08...
        '627123456789'  // bukan 628...
      ];

      for (let i = 0; i < invalidNumbers.length; i++) {
        const { code } = await seedTestActivationCode(ctx.db, adminId);
        const res = await worker.fetch(
          new Request('http://localhost:8787/api/auth/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              activation_code: code,
              username: `bad_wa_${i}`,
              password: 'Password123!',
              shopee_link: 'https://shopee.co.id/bad_wa',
              whatsapp: invalidNumbers[i],
              registration_path: 'direct'
            })
          }),
          ctx.env
        );
        expect(res.status).toBe(400);
        const data = await getJson(res);
        expect(data.error).toBe('INVALID_WHATSAPP');
      }
    });

    it('menolak aktivasi jika jalur pendaftaran tidak valid (400 INVALID_REGISTRATION_PATH)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const res = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'bad_path_user',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/bad_path',
            whatsapp: '081234567890',
            registration_path: 'affiliate_partner'
          })
        }),
        ctx.env
      );
      expect(res.status).toBe(400);
      const data = await getJson(res);
      expect(data.error).toBe('INVALID_REGISTRATION_PATH');
    });

    it('menolak aktivasi referral jika inviter_name kosong (400 MISSING_INVITER_NAME)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const res = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'ref_no_inviter',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/ref_no_inviter',
            whatsapp: '081234567890',
            registration_path: 'referral',
            inviter_name: '   '
          })
        }),
        ctx.env
      );
      expect(res.status).toBe(400);
      const data = await getJson(res);
      expect(data.error).toBe('MISSING_INVITER_NAME');
    });

    it('menolak aktivasi referral jika inviter_name kurang dari 2 atau lebih dari 100 karakter (400 INVALID_INVITER_NAME)', async () => {
      // Terlalu pendek (< 2 karakter)
      const { code: code1 } = await seedTestActivationCode(ctx.db, adminId);
      const res1 = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code1,
            username: 'ref_short_inviter',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/ref_short_inviter',
            whatsapp: '081234567890',
            registration_path: 'referral',
            inviter_name: 'A'
          })
        }),
        ctx.env
      );
      expect(res1.status).toBe(400);
      const data1 = await getJson(res1);
      expect(data1.error).toBe('INVALID_INVITER_NAME');

      // Terlalu panjang (> 100 karakter)
      const { code: code2 } = await seedTestActivationCode(ctx.db, adminId);
      const res2 = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code2,
            username: 'ref_long_inviter',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/ref_long_inviter',
            whatsapp: '081234567890',
            registration_path: 'referral',
            inviter_name: 'Z'.repeat(101)
          })
        }),
        ctx.env
      );
      expect(res2.status).toBe(400);
      const data2 = await getJson(res2);
      expect(data2.error).toBe('INVALID_INVITER_NAME');
    });

    it('jalur direct mengosongkan/mengabaikan inviter_name meski klien mengirimkan string nama pengundang', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const res = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'direct_with_inviter',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/direct_with_inviter',
            whatsapp: '081234567890',
            registration_path: 'direct',
            inviter_name: 'Harusnya Diabaikan'
          })
        }),
        ctx.env
      );
      expect(res.status).toBe(200);
      const data = await getJson(res);
      expect(data.user.inviter_name).toBeNull();

      const dbUser = await ctx.db
        .prepare(`SELECT inviter_name FROM users WHERE username = 'direct_with_inviter'`)
        .first<{ inviter_name: string | null }>();
      expect(dbUser?.inviter_name).toBeNull();
    });

    it('kode aktivasi tidak hangus jika validasi data pendaftaran baru gagal (atomisitas)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      const res = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'fail_wa_user',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/fail_wa',
            whatsapp: 'bukan_nomor',
            registration_path: 'direct'
          })
        }),
        ctx.env
      );
      expect(res.status).toBe(400);

      // Pastikan status kode aktivasi masih 'active' dan used_count = 0
      const codeRow = await ctx.db
        .prepare(`SELECT status, used_count FROM activation_codes WHERE code_hash = ?`)
        .bind(await sha256(normalizeCode(code)))
        .first<{ status: string; used_count: number }>();
      expect(codeRow?.status).toBe('active');
      expect(codeRow?.used_count).toBe(0);

      // Kode masih dapat dipakai oleh aktivasi yang valid berikutnya
      const retryRes = await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'success_retry_user',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/success_retry',
            whatsapp: '081234567890',
            registration_path: 'direct'
          })
        }),
        ctx.env
      );
      expect(retryRes.status).toBe(200);
    });

    it('kompatibilitas mundur: akun lama dengan whatsapp = null tetap dapat login dan lolos auth tanpa error', async () => {
      const oldUserId = crypto.randomUUID();
      const oldDeviceId = crypto.randomUUID();
      const oldRawToken = 'old_device_token_raw_32bytes_sample';
      const oldTokenHash = await sha256(oldRawToken);
      const { hash: oldPassHash, salt: oldPassSalt } = await hashPassword('OldUserPassword123!');

      // Sisipkan akun lama tanpa whatsapp (whatsapp = null, registration_path = 'direct', inviter_name = null)
      await ctx.db.prepare(`
        INSERT INTO users (id, username, password_hash, password_salt, role, status, whatsapp, registration_path, inviter_name)
        VALUES (?, 'legacy_user', ?, ?, 'member', 'active', NULL, 'direct', NULL)
      `).bind(oldUserId, oldPassHash, oldPassSalt).run();

      await ctx.db.prepare(`
        INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active)
        VALUES (?, ?, ?, 'Legacy Device', 1)
      `).bind(oldDeviceId, oldUserId, oldTokenHash).run();

      // Login dengan cookie perangkat lama
      const loginRes = await worker.fetch(
        new Request('http://localhost:8787/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${DEVICE_COOKIE_NAME}=${oldRawToken}`
          },
          body: JSON.stringify({
            username: 'legacy_user',
            password: 'OldUserPassword123!'
          })
        }),
        ctx.env
      );
      expect(loginRes.status).toBe(200);
      const loginData = await getJson(loginRes);
      expect(loginData.status).toBe('ok');
      expect(loginData.user.username).toBe('legacy_user');
      expect(loginData.user.role).toBe('member');

      // Verifikasi di DB bahwa whatsapp adalah null
      const legacyDb = await ctx.db
        .prepare(`SELECT whatsapp, registration_path, inviter_name FROM users WHERE id = ?`)
        .bind(oldUserId)
        .first<{ whatsapp: string | null; registration_path: string; inviter_name: string | null }>();
      expect(legacyDb?.whatsapp).toBeNull();
      expect(legacyDb?.registration_path).toBe('direct');
      expect(legacyDb?.inviter_name).toBeNull();

      // Verifikasi sesi melalui /api/auth/me
      const cookies = extractResponseCookies(loginRes);
      const meRes = await worker.fetch(
        new Request('http://localhost:8787/api/auth/me', {
          method: 'GET',
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${cookies[SESSION_COOKIE_NAME]}`
          }
        }),
        ctx.env
      );
      expect(meRes.status).toBe(200);
      const meData = await getJson(meRes);
      expect(meData.user.username).toBe('legacy_user');
    });

    it('endpoint GET /api/admin/users mengembalikan whatsapp, registration_path, dan inviter_name', async () => {
      // Daftarkan member dengan referral
      const { code } = await seedTestActivationCode(ctx.db, adminId);
      await worker.fetch(
        new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'admin_audit_user',
            password: 'Password123!',
            shopee_link: 'https://shopee.co.id/audit_user',
            whatsapp: '081233445566',
            registration_path: 'referral',
            inviter_name: 'Kakak Pembimbing'
          })
        }),
        ctx.env
      );

      // Panggil GET /api/admin/users dengan admin session
      const usersRes = await worker.fetch(
        new Request('http://localhost:8787/api/admin/users', {
          method: 'GET',
          headers: {
            Cookie: adminSessionCookie
          }
        }),
        ctx.env
      );
      expect(usersRes.status).toBe(200);
      const usersData = await getJson(usersRes);
      expect(usersData.status).toBe('ok');
      expect(Array.isArray(usersData.users)).toBe(true);

      const target = usersData.users.find((u: any) => u.username === 'admin_audit_user');
      expect(target).toBeDefined();
      expect(target.whatsapp).toBe('6281233445566');
      expect(target.registration_path).toBe('referral');
      expect(target.inviter_name).toBe('Kakak Pembimbing');
    });
  });
});
