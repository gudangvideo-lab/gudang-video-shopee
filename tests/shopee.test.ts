/**
 * tests/shopee.test.ts
 * Pengujian komprehensif fitur Wajib Registrasi Akun Shopee Affiliate
 * dan Alur Persetujuan Perubahan Akun oleh Administrator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import {
  createIsolatedTestDb,
  seedTestSuperAdmin,
  seedTestAdmin,
  seedTestUser,
  seedTestActivationCode,
  TestContext
} from './setup-test-db';

async function getJson(res: Response): Promise<any> {
  return await res.json();
}

describe('Fitur Wajib Registrasi Akun Shopee Affiliate & Persetujuan Perubahan Admin', () => {
  let ctx: TestContext;
  let superAdminSessionCookie: string;
  let superAdminId: string;
  let adminSessionCookie: string;
  let adminId: string;

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();

    // 1. Seed Super Admin
    const superAdmin = await seedTestSuperAdmin(
      ctx.db,
      'main_superadmin',
      'SuperPassword123!'
    );
    superAdminId = superAdmin.id;
    superAdminSessionCookie = superAdmin.sessionCookie;

    // 2. Seed Admin
    const admin = await seedTestAdmin(
      ctx.db,
      'ops_admin',
      'AdminPassword123!'
    );
    adminId = admin.id;
    adminSessionCookie = admin.sessionCookie;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // =========================================================================
  // 1. REGISTRASI & AKTIVASI DENGAN AKUN SHOPEE AFFILIATE
  // =========================================================================
  describe('Aktivasi Akun dengan Tautan Shopee Affiliate', () => {
    it('berhasil mengaktifkan akun jika kode dan link shopee valid', async () => {
      const { code } = await seedTestActivationCode(ctx.db, superAdminId);

      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'shopee_user_1',
          password: 'PasswordValid123!',
          shopee_link: 'https://shopee.co.id/official_store_id'
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);

      const json = await getJson(res);
      expect(json.status).toBe('ok');

      // Verifikasi di database
      const user = await ctx.db
        .prepare(`SELECT id, username, role, shopee_link FROM users WHERE username = 'shopee_user_1'`)
        .first<{ id: string; username: string; role: string; shopee_link: string }>();

      expect(user).toBeDefined();
      expect(user?.role).toBe('member');
      expect(user?.shopee_link).toBe('https://shopee.co.id/official_store_id');
    });

    it('menolak aktivasi tanpa tautan akun Shopee (400 MISSING_SHOPEE_LINK)', async () => {
      const { code } = await seedTestActivationCode(ctx.db, superAdminId);

      const req = new Request('http://localhost:8787/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'shopee_user_no_link',
          password: 'PasswordValid123!'
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(400);

      const json = await getJson(res);
      expect(json.error).toBe('MISSING_SHOPEE_LINK');
    });

    it('menolak aktivasi dengan tautan domain asing atau phishing (400 INVALID_SHOPEE_LINK)', async () => {
      const { code, id: codeId } = await seedTestActivationCode(ctx.db, superAdminId);

      const invalidUrls = [
        'https://attacker-site.com/shopee',
        'https://shopee.co.id.evil-domain.com/user',
        'http://insecure-shopee.co.id/user',
        'https://shopee.co.id@phishing.com/steal',
        'javascript:alert(1)',
        'bukan-url-sama-sekali'
      ];

      for (const badUrl of invalidUrls) {
        const req = new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: 'bad_shopee_user',
            password: 'PasswordValid123!',
            shopee_link: badUrl
          })
        });

        const res = await worker.fetch(req, ctx.env);
        expect(res.status).toBe(400);
        const json = await getJson(res);
        expect(json.error).toBe('INVALID_SHOPEE_LINK');
      }

      // Pastikan kode aktivasi belum terpakai
      const codeRow = await ctx.db
        .prepare(`SELECT status FROM activation_codes WHERE id = ?`)
        .bind(codeId)
        .first<{ status: string }>();
      expect(codeRow?.status).toBe('active');
    });

    it('menerima berbagai subdomain resmi Shopee (shopee.co.id, shope.ee, shopee.com, shopee.id)', async () => {
      const validUrls = [
        'https://shopee.co.id/my_affiliate_profile',
        'https://shope.ee/abc123XYZ',
        'https://shopee.com/affiliate_user',
        'https://affiliate.shopee.co.id/user/dashboard',
        'https://shopee.id/store'
      ];

      for (let i = 0; i < validUrls.length; i++) {
        const { code } = await seedTestActivationCode(ctx.db, superAdminId);
        const uname = `valid_shopee_${i}`;

        const req = new Request('http://localhost:8787/api/auth/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activation_code: code,
            username: uname,
            password: 'PasswordValid123!',
            shopee_link: validUrls[i]
          })
        });

        const res = await worker.fetch(req, ctx.env);
        expect(res.status).toBe(200);

        const u = await ctx.db
          .prepare(`SELECT shopee_link FROM users WHERE username = ?`)
          .bind(uname)
          .first<{ shopee_link: string }>();
        expect(u?.shopee_link).toBe(validUrls[i]);
      }
    });
  });

  // =========================================================================
  // 2. MEMBER TANPA SHOPEE LINK (LEGACY / DIRECT CREATION)
  // =========================================================================
  describe('Penanganan Member Tanpa Shopee Link (Katalog Terkunci & Initial Setup)', () => {
    let legacyMember: { id: string; username: string; sessionCookie: string };

    beforeEach(async () => {
      // Seed member tanpa shopee_link (shopeeLink = null)
      const user = await seedTestUser(
        ctx.db,
        adminId,
        'legacy_member',
        'PasswordLegacy123!',
        null
      );
      legacyMember = {
        id: user.id,
        username: user.username,
        sessionCookie: user.sessionCookie
      };
    });

    it('GET /api/videos menolak member tanpa shopee_link (403 SHOPEE_LINK_REQUIRED)', async () => {
      const req = new Request('http://localhost:8787/api/videos', {
        method: 'GET',
        headers: { Cookie: legacyMember.sessionCookie }
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(403);

      const json = await getJson(res);
      expect(json.error).toBe('SHOPEE_LINK_REQUIRED');
    });

    it('GET /api/videos/:id/download menolak member tanpa shopee_link (403 SHOPEE_LINK_REQUIRED)', async () => {
      const req = new Request('http://localhost:8787/api/videos/some-video-id/download', {
        method: 'GET',
        headers: { Cookie: legacyMember.sessionCookie }
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(403);

      const json = await getJson(res);
      expect(json.error).toBe('SHOPEE_LINK_REQUIRED');
    });

    it('Super Admin dan Admin tidak terblokir oleh aturan shopee_link pada katalog video', async () => {
      const req = new Request('http://localhost:8787/api/videos', {
        method: 'GET',
        headers: { Cookie: adminSessionCookie }
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);
    });

    it('GET /api/videos/:id menolak member tanpa shopee_link (403 SHOPEE_LINK_REQUIRED)', async () => {
      const videoId = crypto.randomUUID();
      await ctx.db.prepare(`
        INSERT INTO videos (id, title, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id)
        VALUES (?, 'Test Video Detail', 'Produk Detail', 'https://shopee.co.id/test', 'videos/test.mp4', 'video/mp4', 1024, 'active', ?)
      `).bind(videoId, adminId).run();

      const req = new Request(`http://localhost:8787/api/videos/${videoId}`, {
        method: 'GET',
        headers: { Cookie: legacyMember.sessionCookie }
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(403);

      const json = await getJson(res);
      expect(json.error).toBe('SHOPEE_LINK_REQUIRED');
      expect(json.message).toContain('wajib mendaftarkan tautan akun Shopee Affiliate');
    });

    it('guard shopee_link pada GET /api/videos/:id dievaluasi sebelum validasi ID dan query database', async () => {
      const req = new Request('http://localhost:8787/api/videos/invalid-uuid-format', {
        method: 'GET',
        headers: { Cookie: legacyMember.sessionCookie }
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(403);

      const json = await getJson(res);
      expect(json.error).toBe('SHOPEE_LINK_REQUIRED');
    });

    it('member dengan shopee_link terdaftar dapat mengakses detail video (200 OK)', async () => {
      const videoId = crypto.randomUUID();
      await ctx.db.prepare(`
        INSERT INTO videos (id, title, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id)
        VALUES (?, 'Test Video Detail', 'Produk Detail', 'https://shopee.co.id/test', 'videos/test.mp4', 'video/mp4', 1024, 'active', ?)
      `).bind(videoId, adminId).run();

      const activeUser = await seedTestUser(
        ctx.db,
        adminId,
        'member_with_link',
        'ValidPass123!',
        'https://shopee.co.id/my_affiliate_channel'
      );

      const req = new Request(`http://localhost:8787/api/videos/${videoId}`, {
        method: 'GET',
        headers: { Cookie: activeUser.sessionCookie }
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);

      const json = await getJson(res);
      expect(json.status).toBe('ok');
      expect(json.video.id).toBe(videoId);
      expect(json.video.title).toBe('Test Video Detail');
    });

    it('Admin dan Super Admin dapat mengakses detail video tanpa terhambat aturan shopee_link', async () => {
      const videoId = crypto.randomUUID();
      await ctx.db.prepare(`
        INSERT INTO videos (id, title, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id)
        VALUES (?, 'Test Video Detail Admin', 'Produk Admin', 'https://shopee.co.id/test', 'videos/test.mp4', 'video/mp4', 1024, 'active', ?)
      `).bind(videoId, adminId).run();

      // Admin access
      const adminReq = new Request(`http://localhost:8787/api/videos/${videoId}`, {
        method: 'GET',
        headers: { Cookie: adminSessionCookie }
      });
      const adminRes = await worker.fetch(adminReq, ctx.env);
      expect(adminRes.status).toBe(200);
      const adminJson = await getJson(adminRes);
      expect(adminJson.video.id).toBe(videoId);

      // Super Admin access
      const saReq = new Request(`http://localhost:8787/api/videos/${videoId}`, {
        method: 'GET',
        headers: { Cookie: superAdminSessionCookie }
      });
      const saRes = await worker.fetch(saReq, ctx.env);
      expect(saRes.status).toBe(200);
      const saJson = await getJson(saRes);
      expect(saJson.video.id).toBe(videoId);
    });

    it('member yang ditangguhkan tetap mengikuti aturan status akun yang sudah ada sebelum pemeriksaan shopee_link', async () => {
      const videoId = crypto.randomUUID();
      await ctx.db.prepare(`
        INSERT INTO videos (id, title, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id)
        VALUES (?, 'Test Video Detail Suspended', 'Produk', 'https://shopee.co.id/test', 'videos/test.mp4', 'video/mp4', 1024, 'active', ?)
      `).bind(videoId, adminId).run();

      // Nonaktifkan legacyMember
      await ctx.db.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).bind(legacyMember.id).run();

      const req = new Request(`http://localhost:8787/api/videos/${videoId}`, {
        method: 'GET',
        headers: { Cookie: legacyMember.sessionCookie }
      });

      const res = await worker.fetch(req, ctx.env);
      // Sesuai aturan yang ada: status suspended ditolak oleh validasi sesi/akun (401 atau 403) dan TIDAK mengekspos shopee_link atau detail video
      expect([401, 403]).toContain(res.status);

      const json = await getJson(res);
      expect(['UNAUTHORIZED', 'ACCOUNT_SUSPENDED']).toContain(json.error);
      expect(json.error).not.toBe('SHOPEE_LINK_REQUIRED');
    });

    it('berhasil mendaftarkan tautan Shopee awal via POST /api/member/shopee-account/initial', async () => {
      const req = new Request('http://localhost:8787/api/member/shopee-account/initial', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: legacyMember.sessionCookie
        },
        body: JSON.stringify({
          shopee_link: 'https://shopee.co.id/new_legacy_profile'
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);

      const json = await getJson(res);
      expect(json.status).toBe('ok');
      expect(json.shopee_link).toBe('https://shopee.co.id/new_legacy_profile');

      // Verifikasi di database
      const u = await ctx.db
        .prepare(`SELECT shopee_link FROM users WHERE id = ?`)
        .bind(legacyMember.id)
        .first<{ shopee_link: string }>();
      expect(u?.shopee_link).toBe('https://shopee.co.id/new_legacy_profile');

      // Verifikasi katalog video sekarang terbuka
      const catReq = new Request('http://localhost:8787/api/videos', {
        method: 'GET',
        headers: { Cookie: legacyMember.sessionCookie }
      });
      const catRes = await worker.fetch(catReq, ctx.env);
      expect(catRes.status).toBe(200);

      // Verifikasi audit log
      const audit = await ctx.db
        .prepare(`SELECT action, target_user_id FROM audit_logs WHERE action = 'SET_INITIAL_SHOPEE_LINK'`)
        .first<{ action: string; target_user_id: string }>();
      expect(audit).toBeDefined();
      expect(audit?.target_user_id).toBe(legacyMember.id);
    });

    it('menolak initial link jika member SUDAH memiliki shopee_link (400 SHOPEE_LINK_ALREADY_SET)', async () => {
      // 1. Set initial pertama kali
      await ctx.db
        .prepare(`UPDATE users SET shopee_link = 'https://shope.ee/first' WHERE id = ?`)
        .bind(legacyMember.id)
        .run();

      // 2. Coba set lagi
      const req = new Request('http://localhost:8787/api/member/shopee-account/initial', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: legacyMember.sessionCookie
        },
        body: JSON.stringify({
          shopee_link: 'https://shope.ee/second'
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(400);

      const json = await getJson(res);
      expect(json.error).toBe('SHOPEE_LINK_ALREADY_SET');
    });
  });

  // =========================================================================
  // 3. PENGAJUAN PERUBAHAN AKUN SHOPEE OLEH MEMBER
  // =========================================================================
  describe('Pengajuan Perubahan Akun Shopee (POST /api/member/shopee-account/requests)', () => {
    let activeMember: { id: string; username: string; sessionCookie: string };

    beforeEach(async () => {
      const user = await seedTestUser(
        ctx.db,
        adminId,
        'active_member',
        'PasswordActive123!',
        'https://shopee.co.id/active_profile_lama'
      );
      activeMember = {
        id: user.id,
        username: user.username,
        sessionCookie: user.sessionCookie
      };
    });

    it('member berhasil mengajukan permohonan perubahan akun Shopee', async () => {
      const req = new Request('http://localhost:8787/api/member/shopee-account/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: activeMember.sessionCookie
        },
        body: JSON.stringify({
          requested_shopee_link: 'https://shopee.co.id/profile_baru_diajukan'
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(201);

      const json = await getJson(res);
      expect(json.status).toBe('ok');
      expect(json.data.status).toBe('pending');
      expect(json.data.requested_shopee_link).toBe('https://shopee.co.id/profile_baru_diajukan');
      expect(json.data.current_shopee_link).toBe('https://shopee.co.id/active_profile_lama');

      // Tautan aktif member di tabel users HARUS TETAP link lama (belum berubah)
      const u = await ctx.db
        .prepare(`SELECT shopee_link FROM users WHERE id = ?`)
        .bind(activeMember.id)
        .first<{ shopee_link: string }>();
      expect(u?.shopee_link).toBe('https://shopee.co.id/active_profile_lama');

      // Verifikasi audit log
      const audit = await ctx.db
        .prepare(`SELECT action, details FROM audit_logs WHERE action = 'REQUEST_SHOPEE_LINK_CHANGE'`)
        .first<{ action: string; details: string }>();
      expect(audit).toBeDefined();
    });

    it('menolak pengajuan jika tautan yang diminta sama persis dengan tautan aktif (400 SAME_SHOPEE_LINK)', async () => {
      const req = new Request('http://localhost:8787/api/member/shopee-account/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: activeMember.sessionCookie
        },
        body: JSON.stringify({
          requested_shopee_link: 'https://shopee.co.id/active_profile_lama'
        })
      });

      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(400);

      const json = await getJson(res);
      expect(json.error).toBe('SAME_SHOPEE_LINK');
    });

    it('menolak pengajuan jika member sudah memiliki permohonan berstatus pending (409 PENDING_REQUEST_EXISTS)', async () => {
      // 1. Ajukan permohonan pertama
      const req1 = new Request('http://localhost:8787/api/member/shopee-account/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: activeMember.sessionCookie
        },
        body: JSON.stringify({
          requested_shopee_link: 'https://shopee.co.id/profile_baru_1'
        })
      });
      const res1 = await worker.fetch(req1, ctx.env);
      expect(res1.status).toBe(201);

      // 2. Ajukan permohonan kedua saat permohonan pertama masih pending
      const req2 = new Request('http://localhost:8787/api/member/shopee-account/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: activeMember.sessionCookie
        },
        body: JSON.stringify({
          requested_shopee_link: 'https://shopee.co.id/profile_baru_2'
        })
      });
      const res2 = await worker.fetch(req2, ctx.env);
      expect(res2.status).toBe(409);

      const json = await getJson(res2);
      expect(json.error).toBe('PENDING_REQUEST_EXISTS');
    });

    it('member dapat melihat riwayat permohonan miliknya via GET /api/member/shopee-account/requests', async () => {
      // Buat request
      await worker.fetch(
        new Request('http://localhost:8787/api/member/shopee-account/requests', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: activeMember.sessionCookie
          },
          body: JSON.stringify({
            requested_shopee_link: 'https://shope.ee/test_history'
          })
        }),
        ctx.env
      );

      // Ambil daftar
      const res = await worker.fetch(
        new Request('http://localhost:8787/api/member/shopee-account/requests', {
          method: 'GET',
          headers: { Cookie: activeMember.sessionCookie }
        }),
        ctx.env
      );

      expect(res.status).toBe(200);
      const json = await getJson(res);
      expect(json.status).toBe('ok');
      expect(json.requests.length).toBe(1);
      expect(json.requests[0].requested_shopee_link).toBe('https://shope.ee/test_history');
      expect(json.requests[0].status).toBe('pending');
    });
  });

  // =========================================================================
  // 4. REVIEW PERMOHONAN OLEH ADMIN / SUPER ADMIN
  // =========================================================================
  describe('Peninjauan Permohonan oleh Administrator', () => {
    let memberUser: { id: string; username: string; sessionCookie: string };
    let requestId: string;

    beforeEach(async () => {
      const user = await seedTestUser(
        ctx.db,
        adminId,
        'review_target_member',
        'Password123!',
        'https://shopee.co.id/target_lama'
      );
      memberUser = {
        id: user.id,
        username: user.username,
        sessionCookie: user.sessionCookie
      };

      // Buat 1 pending request
      const req = new Request('http://localhost:8787/api/member/shopee-account/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: memberUser.sessionCookie
        },
        body: JSON.stringify({
          requested_shopee_link: 'https://shopee.co.id/target_baru_diajukan'
        })
      });
      const res = await worker.fetch(req, ctx.env);
      const json = await getJson(res);
      requestId = json.data.id;
    });

    it('member biasa tidak boleh mengakses daftar permohonan admin (403 FORBIDDEN)', async () => {
      const req = new Request('http://localhost:8787/api/admin/shopee-requests', {
        method: 'GET',
        headers: { Cookie: memberUser.sessionCookie }
      });
      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(403);
    });

    it('admin dapat melihat daftar permohonan dan memfilter berdasarkan status', async () => {
      const req = new Request('http://localhost:8787/api/admin/shopee-requests?status=pending', {
        method: 'GET',
        headers: { Cookie: adminSessionCookie }
      });
      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);

      const json = await getJson(res);
      expect(json.status).toBe('ok');
      expect(json.requests.length).toBeGreaterThanOrEqual(1);
      const found = json.requests.find((r: any) => r.id === requestId);
      expect(found).toBeDefined();
      expect(found.username).toBe('review_target_member');
      expect(found.current_shopee_link).toBe('https://shopee.co.id/target_lama');
      expect(found.requested_shopee_link).toBe('https://shopee.co.id/target_baru_diajukan');
    });

    it('admin menyetujui permohonan (approve): update status & users.shopee_link secara atomik', async () => {
      const reviewReq = new Request(`http://localhost:8787/api/admin/shopee-requests/${requestId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminSessionCookie
        },
        body: JSON.stringify({
          action: 'approve'
        })
      });

      const res = await worker.fetch(reviewReq, ctx.env);
      expect(res.status).toBe(200);

      const json = await getJson(res);
      expect(json.status).toBe('ok');
      expect(json.data.status).toBe('approved');

      // Verifikasi di database: tabel users.shopee_link HARUS sudah terupdate ke link baru!
      const user = await ctx.db
        .prepare(`SELECT shopee_link FROM users WHERE id = ?`)
        .bind(memberUser.id)
        .first<{ shopee_link: string }>();
      expect(user?.shopee_link).toBe('https://shopee.co.id/target_baru_diajukan');

      // Verifikasi permohonan tercatat reviewer
      const reqDb = await ctx.db
        .prepare(`SELECT status, reviewed_by_admin_id FROM shopee_account_requests WHERE id = ?`)
        .bind(requestId)
        .first<{ status: string; reviewed_by_admin_id: string }>();
      expect(reqDb?.status).toBe('approved');
      expect(reqDb?.reviewed_by_admin_id).toBe(adminId);

      // Verifikasi audit log
      const audit = await ctx.db
        .prepare(`SELECT action, admin_id, target_user_id FROM audit_logs WHERE action = 'APPROVE_SHOPEE_LINK_CHANGE'`)
        .first<{ action: string; admin_id: string; target_user_id: string }>();
      expect(audit).toBeDefined();
      expect(audit?.admin_id).toBe(adminId);
      expect(audit?.target_user_id).toBe(memberUser.id);
    });

    it('admin menolak permohonan (reject): tautan member lama tetap aktif, alasan dicatat', async () => {
      const reviewReq = new Request(`http://localhost:8787/api/admin/shopee-requests/${requestId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminSessionCookie
        },
        body: JSON.stringify({
          action: 'reject',
          rejection_reason: 'Akun Shopee bukan akun affiliate resmi / format profil tidak dapat diverifikasi'
        })
      });

      const res = await worker.fetch(reviewReq, ctx.env);
      expect(res.status).toBe(200);

      const json = await getJson(res);
      expect(json.status).toBe('ok');
      expect(json.data.status).toBe('rejected');

      // Tautan di tabel users TIDAK BOLEH BERUBAH (tetap link lama)
      const user = await ctx.db
        .prepare(`SELECT shopee_link FROM users WHERE id = ?`)
        .bind(memberUser.id)
        .first<{ shopee_link: string }>();
      expect(user?.shopee_link).toBe('https://shopee.co.id/target_lama');

      // Catatan penolakan tersimpan di tabel permohonan
      const reqDb = await ctx.db
        .prepare(`SELECT status, rejection_reason FROM shopee_account_requests WHERE id = ?`)
        .bind(requestId)
        .first<{ status: string; rejection_reason: string }>();
      expect(reqDb?.status).toBe('rejected');
      expect(reqDb?.rejection_reason).toContain('bukan akun affiliate resmi');

      // Verifikasi audit log
      const audit = await ctx.db
        .prepare(`SELECT action FROM audit_logs WHERE action = 'REJECT_SHOPEE_LINK_CHANGE'`)
        .first<{ action: string }>();
      expect(audit).toBeDefined();
    });

    it('menolak penolakan jika admin tidak menyertakan alasan penolakan (400 MISSING_REJECTION_REASON)', async () => {
      const reviewReq = new Request(`http://localhost:8787/api/admin/shopee-requests/${requestId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: adminSessionCookie
        },
        body: JSON.stringify({
          action: 'reject'
          // tanpa rejection_reason
        })
      });

      const res = await worker.fetch(reviewReq, ctx.env);
      expect(res.status).toBe(400);

      const json = await getJson(res);
      expect(json.error).toBe('MISSING_REJECTION_REASON');
    });

    it('dua admin mereview permohonan yang sama secara bersamaan dicegah oleh database lock (race condition prevention)', async () => {
      const makeReviewReq = (adminCookie: string, action: 'approve' | 'reject') =>
        new Request(`http://localhost:8787/api/admin/shopee-requests/${requestId}/review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: adminCookie
          },
          body: JSON.stringify({
            action,
            rejection_reason: action === 'reject' ? 'Alasan konkuren' : undefined
          })
        });

      // Kirim dua review simultan
      const [res1, res2] = await Promise.all([
        worker.fetch(makeReviewReq(adminSessionCookie, 'approve'), ctx.env),
        worker.fetch(makeReviewReq(superAdminSessionCookie, 'reject'), ctx.env)
      ]);

      const statuses = [res1.status, res2.status];
      // Tepat satu yang berhasil (200), satu lagi ditolak karena sudah diproses (409)
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);
    });

    it('menolak review pada permohonan yang sudah selesai diproses (409 ALREADY_PROCESSED)', async () => {
      // 1. Approve permohonan
      await worker.fetch(
        new Request(`http://localhost:8787/api/admin/shopee-requests/${requestId}/review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: adminSessionCookie
          },
          body: JSON.stringify({ action: 'approve' })
        }),
        ctx.env
      );

      // 2. Coba approve/reject ulang
      const res = await worker.fetch(
        new Request(`http://localhost:8787/api/admin/shopee-requests/${requestId}/review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: adminSessionCookie
          },
          body: JSON.stringify({ action: 'reject', rejection_reason: 'Coba tolak yang sudah disetujui' })
        }),
        ctx.env
      );

      expect(res.status).toBe(409);
      const json = await getJson(res);
      expect(json.error).toBe('ALREADY_PROCESSED');
    });
  });
});
