import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import {
  createIsolatedTestDb,
  seedTestSuperAdmin,
  seedTestAdmin,
  seedTestAdminWithoutDevice,
  seedTestUser,
  splitSqlStatements,
  TestContext
} from './setup-test-db';
import { hashPassword, sha256 } from '../worker/crypto';
import { DEVICE_COOKIE_NAME, SESSION_COOKIE_NAME } from '../worker/cookies';
import { generateRecoverySuperAdminSql } from '../scripts/recover-super-admin.js';
import { Miniflare } from 'miniflare';

declare function require(name: string): any;
declare const process: any;

const fs = require('fs');
const path = require('path');

function extractCookies(res: Response): Record<string, string> {
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

describe('Sistem Hak Akses Tiga Level: Super Admin, Admin, dan Member', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // =========================================================================
  // 1. INTEGRITAS SKEMA & TRIGGER DATABASE (D1)
  // =========================================================================
  describe('Integritas Skema dan Trigger Database', () => {
    it('membatasi jumlah Super Admin tepat maksimal 3 akun (trg_limit_super_admin_insert)', async () => {
      // Akun 1: dibuat lewat seed
      await seedTestSuperAdmin(ctx.db, 'super_1', 'SuperPass123!');

      // Akun 2 & 3: masukkan manual
      const { hash: h2, salt: s2 } = await hashPassword('SuperPass123!');
      await ctx.db
        .prepare(`INSERT INTO users (id, username, password_hash, password_salt, role, status) VALUES (?, 'super_2', ?, ?, 'super_admin', 'active')`)
        .bind(crypto.randomUUID(), h2, s2)
        .run();

      const { hash: h3, salt: s3 } = await hashPassword('SuperPass123!');
      await ctx.db
        .prepare(`INSERT INTO users (id, username, password_hash, password_salt, role, status) VALUES (?, 'super_3', ?, ?, 'super_admin', 'active')`)
        .bind(crypto.randomUUID(), h3, s3)
        .run();

      // Akun 4: harus ditolak oleh trigger MAX_SUPER_ADMIN_EXCEEDED
      const { hash: h4, salt: s4 } = await hashPassword('SuperPass123!');
      await expect(
        ctx.db
          .prepare(`INSERT INTO users (id, username, password_hash, password_salt, role, status) VALUES (?, 'super_4', ?, ?, 'super_admin', 'active')`)
          .bind(crypto.randomUUID(), h4, s4)
          .run()
      ).rejects.toThrow(/MAX_SUPER_ADMIN_EXCEEDED/);
    });

    it('mencegah promosi user biasa menjadi Super Admin ke-4 (trg_limit_super_admin_update)', async () => {
      // Buat 3 Super Admin
      for (let i = 1; i <= 3; i++) {
        const { hash, salt } = await hashPassword('SuperPass123!');
        await ctx.db
          .prepare(`INSERT INTO users (id, username, password_hash, password_salt, role, status) VALUES (?, ?, ?, ?, 'super_admin', 'active')`)
          .bind(crypto.randomUUID(), `super_adm_${i}`, hash, salt)
          .run();
      }

      // Buat 1 Admin biasa
      const admin = await seedTestAdmin(ctx.db, 'regular_admin');

      // Coba update role regular_admin menjadi super_admin
      await expect(
        ctx.db
          .prepare(`UPDATE users SET role = 'super_admin' WHERE id = ?`)
          .bind(admin.id)
          .run()
      ).rejects.toThrow(/MAX_SUPER_ADMIN_EXCEEDED/);
    });

    it('melindungi Super Admin dari penghapusan (trg_protect_super_admin_delete)', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_undeletable');
      await expect(
        ctx.db.prepare(`DELETE FROM users WHERE id = ?`).bind(superAdmin.id).run()
      ).rejects.toThrow(/SUPER_ADMIN_CANNOT_BE_DELETED/);
    });

    it('melindungi Super Admin dari penonaktifan atau penurunan role (trg_protect_super_admin_status)', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_protected');

      // Uji penonaktifan (status = 'suspended')
      await expect(
        ctx.db.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).bind(superAdmin.id).run()
      ).rejects.toThrow(/SUPER_ADMIN_CANNOT_BE_SUSPENDED_OR_DEMOTED/);

      // Uji penurunan role (role = 'admin')
      await expect(
        ctx.db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(superAdmin.id).run()
      ).rejects.toThrow(/SUPER_ADMIN_CANNOT_BE_SUSPENDED_OR_DEMOTED/);
    });

    it('penegakan satu perangkat aktif untuk Admin & Member, serta multi-perangkat untuk Super Admin', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_multi');
      const regularAdmin = await seedTestAdmin(ctx.db, 'admin_single');
      const member = await seedTestUser(ctx.db, superAdmin.id, 'member_single');

      // 1. Super Admin bisa punya beberapa perangkat aktif
      const superDev2 = crypto.randomUUID();
      const superDev3 = crypto.randomUUID();
      await expect(
        ctx.db
          .prepare(`INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active) VALUES (?, ?, ?, 'Laptop Super', 1)`)
          .bind(superDev2, superAdmin.id, await sha256('super_token_2'))
          .run()
      ).resolves.toBeDefined();

      await expect(
        ctx.db
          .prepare(`INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active) VALUES (?, ?, ?, 'HP Super', 1)`)
          .bind(superDev3, superAdmin.id, await sha256('super_token_3'))
          .run()
      ).resolves.toBeDefined();

      // 2. Regular Admin TIDAK bisa punya > 1 perangkat aktif
      await expect(
        ctx.db
          .prepare(`INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active) VALUES (?, ?, ?, 'Admin Dev 2', 1)`)
          .bind(crypto.randomUUID(), regularAdmin.id, await sha256('admin_token_2'))
          .run()
      ).rejects.toThrow(/SINGLE_DEVICE_ENFORCEMENT_VIOLATION/);

      // 3. Member TIDAK bisa punya > 1 perangkat aktif
      await expect(
        ctx.db
          .prepare(`INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active) VALUES (?, ?, ?, 'Member Dev 2', 1)`)
          .bind(crypto.randomUUID(), member.id, await sha256('member_token_2'))
          .run()
      ).rejects.toThrow(/SINGLE_DEVICE_ENFORCEMENT_VIOLATION/);
    });
  });

  // =========================================================================
  // 2. KEBIJAKAN SESI & MULTI-PERANGKAT SUPER ADMIN
  // =========================================================================
  describe('Skenario Login dan Sesi Super Admin Multi-Device', () => {
    it('Super Admin dapat login bersamaan di Browser A dan Browser B tanpa saling membatalkan', async () => {
      const superPass = 'SuperSecret123!';
      await seedTestSuperAdmin(ctx.db, 'super_user', superPass);

      // Browser A login
      const resA = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'BrowserA/Chrome' },
        body: JSON.stringify({ username: 'super_user', password: superPass })
      }), ctx.env);
      expect(resA.status).toBe(200);
      const cookiesA = extractCookies(resA);
      const sessionA = cookiesA[SESSION_COOKIE_NAME];
      const deviceA = cookiesA[DEVICE_COOKIE_NAME];
      expect(sessionA).toBeDefined();
      expect(deviceA).toBeDefined();

      // Browser B login
      const resB = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'BrowserB/Firefox' },
        body: JSON.stringify({ username: 'super_user', password: superPass })
      }), ctx.env);
      expect(resB.status).toBe(200);
      const cookiesB = extractCookies(resB);
      const sessionB = cookiesB[SESSION_COOKIE_NAME];
      const deviceB = cookiesB[DEVICE_COOKIE_NAME];
      expect(sessionB).toBeDefined();
      expect(deviceB).toBeDefined();
      expect(sessionA).not.toBe(sessionB);
      expect(deviceA).not.toBe(deviceB);

      // Browser A dan B dapat mengakses /api/auth/me bersamaan
      const meA = await worker.fetch(new Request('http://localhost/api/auth/me', {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionA}; ${DEVICE_COOKIE_NAME}=${deviceA}`,
          'User-Agent': 'BrowserA/Chrome'
        }
      }), ctx.env);
      expect(meA.status).toBe(200);
      const bodyA = await meA.json() as any;
      expect(bodyA.user.role).toBe('super_admin');

      const meB = await worker.fetch(new Request('http://localhost/api/auth/me', {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionB}; ${DEVICE_COOKIE_NAME}=${deviceB}`,
          'User-Agent': 'BrowserB/Firefox'
        }
      }), ctx.env);
      expect(meB.status).toBe(200);
      const bodyB = await meB.json() as any;
      expect(bodyB.user.role).toBe('super_admin');

      // Logout dari Browser A tidak mengeluarkan Browser B
      const logoutA = await worker.fetch(new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionA}; ${DEVICE_COOKIE_NAME}=${deviceA}`,
          'Origin': 'http://localhost'
        }
      }), ctx.env);
      expect(logoutA.status).toBe(200);

      // Browser A sekarang ditolak
      const meAAfter = await worker.fetch(new Request('http://localhost/api/auth/me', {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionA}; ${DEVICE_COOKIE_NAME}=${deviceA}`
        }
      }), ctx.env);
      expect(meAAfter.status).toBe(401);

      // Browser B tetap aktif dan valid
      const meBAfter = await worker.fetch(new Request('http://localhost/api/auth/me', {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionB}; ${DEVICE_COOKIE_NAME}=${deviceB}`
        }
      }), ctx.env);
      expect(meBAfter.status).toBe(200);
    });

    it('Admin dan Member ditolak saat login dari perangkat kedua tanpa reset perangkat', async () => {
      const adminPass = 'AdminSecret123!';
      // Buat admin tanpa perangkat awal
      await seedTestAdminWithoutDevice(ctx.db, 'admin_single_test', adminPass);

      // Browser A login Admin pertama kali -> auto-bind perangkat
      const resA = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin_single_test', password: adminPass })
      }), ctx.env);
      expect(resA.status).toBe(200);

      // Browser B login Admin tanpa cookie perangkat yang terdaftar -> DEVICE_NOT_AUTHORIZED
      const resB = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin_single_test', password: adminPass })
      }), ctx.env);
      expect(resB.status).toBe(403);
      const errB = await resB.json() as any;
      expect(errB.error).toBe('DEVICE_NOT_AUTHORIZED');
    });
  });

  // =========================================================================
  // 3. ENDPOINT KHUSUS SUPER ADMIN & PROTEKSI ROLE
  // =========================================================================
  describe('Endpoint Khusus Super Admin & Pembatasan Otorisasi', () => {
    it('Super Admin dapat membuat Admin baru dan mendaftar admin', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'chief_super');

      // 1. Buat admin baru
      const createRes = await worker.fetch(new Request('http://localhost/api/super-admin/admins', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({
          username: 'brand_new_admin',
          password: 'NewAdminPass123!'
        })
      }), ctx.env);

      expect(createRes.status).toBe(201);
      const createdData = await createRes.json() as any;
      expect(createdData.admin.username).toBe('brand_new_admin');
      expect(createdData.admin.role).toBe('admin');
      expect(createdData.admin.status).toBe('active');

      // 2. Super Admin mendaftar admin
      const listRes = await worker.fetch(new Request('http://localhost/api/super-admin/admins', {
        headers: {
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`
        }
      }), ctx.env);

      expect(listRes.status).toBe(200);
      const listData = await listRes.json() as any;
      expect(listData.admins.some((a: any) => a.username === 'brand_new_admin')).toBe(true);

      // 3. Admin yang baru dibuat dapat login dari perangkat pertama
      const adminLoginRes = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'brand_new_admin', password: 'NewAdminPass123!' })
      }), ctx.env);
      expect(adminLoginRes.status).toBe(200);
    });

    it('Admin dan Member ditolak saat mengakses endpoint Super Admin (403)', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'seed_super');
      const admin = await seedTestAdmin(ctx.db, 'just_admin');
      const member = await seedTestUser(ctx.db, superAdmin.id, 'just_member');

      // Admin mencoba mendaftar admin
      const res1 = await worker.fetch(new Request('http://localhost/api/super-admin/admins', {
        headers: { Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}` }
      }), ctx.env);
      expect(res1.status).toBe(403);
      const err1 = await res1.json() as any;
      expect(err1.error).toBe('FORBIDDEN');

      // Member mencoba membuat admin
      const res2 = await worker.fetch(new Request('http://localhost/api/super-admin/admins', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${member.sessionCookie}; ${member.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ username: 'hacked_admin', password: 'Pass123456!' })
      }), ctx.env);
      expect(res2.status).toBe(403);
      const err2 = await res2.json() as any;
      expect(err2.error).toBe('FORBIDDEN');
    });

    it('Super Admin dapat menonaktifkan Admin dan otomatis mencabut seluruh sesinya', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'boss_super');
      const adminPass = 'ActiveAdminPass1!';
      const targetAdmin = await seedTestAdmin(ctx.db, 'victim_admin', adminPass);

      // Verifikasi targetAdmin sesi saat ini valid
      const meBefore = await worker.fetch(new Request('http://localhost/api/auth/me', {
        headers: { Cookie: `${targetAdmin.sessionCookie}; ${targetAdmin.deviceCookie}` }
      }), ctx.env);
      expect(meBefore.status).toBe(200);

      // Super Admin menonaktifkan targetAdmin
      const suspendRes = await worker.fetch(new Request(`http://localhost/api/super-admin/admins/${targetAdmin.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ status: 'suspended' })
      }), ctx.env);
      expect(suspendRes.status).toBe(200);

      // Sesi targetAdmin langsung tidak valid
      const meAfter = await worker.fetch(new Request('http://localhost/api/auth/me', {
        headers: { Cookie: `${targetAdmin.sessionCookie}; ${targetAdmin.deviceCookie}` }
      }), ctx.env);
      expect(meAfter.status).toBe(401);

      // Percobaan login ulang oleh targetAdmin ditolak karena akun suspended
      const loginAgain = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'victim_admin', password: adminPass })
      }), ctx.env);
      expect(loginAgain.status).toBe(403);
      const loginErr = await loginAgain.json() as any;
      expect(loginErr.error).toBe('ACCOUNT_SUSPENDED');
    });

    it('Penerbitan kode aktivasi dibatasi hanya untuk Super Admin', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'code_super');
      const admin = await seedTestAdmin(ctx.db, 'code_admin');

      // Super Admin berhasil membuat kode aktivasi
      const superRes = await worker.fetch(new Request('http://localhost/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ max_uses: 1, expires_in_days: 7 })
      }), ctx.env);
      expect(superRes.status).toBe(201);
      const codeData = await superRes.json() as any;
      expect(codeData.data.code).toBeDefined();

      // Regular Admin ditolak saat mencoba membuat kode aktivasi
      const adminRes = await worker.fetch(new Request('http://localhost/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ max_uses: 1, expires_in_days: 7 })
      }), ctx.env);
      expect(adminRes.status).toBe(403);
      const err = await adminRes.json() as any;
      expect(err.error).toBe('FORBIDDEN');
    });

    it('Aturan penerbitan kode reset perangkat per role', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'reset_super');
      const admin1 = await seedTestAdmin(ctx.db, 'reset_admin_1');
      const admin2 = await seedTestAdmin(ctx.db, 'reset_admin_2');
      const member = await seedTestUser(ctx.db, superAdmin.id, 'reset_member');

      // 1. Menerbitkan reset code untuk Super Admin ditolak (Super Admin kebal reset perangkat)
      const resSuper = await worker.fetch(new Request(`http://localhost/api/admin/users/${superAdmin.id}/reset-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ reason: 'Pengujian reset super admin' })
      }), ctx.env);
      expect(resSuper.status).toBe(403);
      const superErr = await resSuper.json() as any;
      expect(superErr.error).toBe('SUPER_ADMIN_RESET_NOT_ALLOWED');

      // 2. Regular Admin TIDAK boleh mereset perangkat Admin lain
      const resAdminOnAdmin = await worker.fetch(new Request(`http://localhost/api/admin/users/${admin2.id}/reset-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin1.sessionCookie}; ${admin1.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ reason: 'Admin reset admin lain' })
      }), ctx.env);
      expect(resAdminOnAdmin.status).toBe(403);
      const adminOnAdminErr = await resAdminOnAdmin.json() as any;
      expect(adminOnAdminErr.error).toBe('FORBIDDEN');

      // 3. Super Admin BISA mereset perangkat Admin
      const resSuperOnAdmin = await worker.fetch(new Request(`http://localhost/api/admin/users/${admin2.id}/reset-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ reason: 'Super admin reset device admin' })
      }), ctx.env);
      expect(resSuperOnAdmin.status).toBe(201);
      const superOnAdminData = await resSuperOnAdmin.json() as any;
      expect(superOnAdminData.data.reset_code).toBeDefined();

      // 4. Regular Admin BISA mereset perangkat Member
      const resAdminOnMember = await worker.fetch(new Request(`http://localhost/api/admin/users/${member.id}/reset-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin1.sessionCookie}; ${admin1.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ reason: 'Reset device member ganti HP' })
      }), ctx.env);
      expect(resAdminOnMember.status).toBe(201);
      const adminOnMemberData = await resAdminOnMember.json() as any;
      expect(adminOnMemberData.data.reset_code).toBeDefined();
    });

    it('Super Admin dapat membuat akun Member secara langsung', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'direct_super');

      const createMemberRes = await worker.fetch(new Request('http://localhost/api/super-admin/members', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({
          username: 'direct_member',
          password: 'MemberPass123!'
        })
      }), ctx.env);

      expect(createMemberRes.status).toBe(201);
      const memberData = await createMemberRes.json() as any;
      expect(memberData.member.username).toBe('direct_member');
      expect(memberData.member.role).toBe('member');

      // Member langsung bisa login dari perangkat pertama
      const loginRes = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'direct_member', password: 'MemberPass123!' })
      }), ctx.env);
      expect(loginRes.status).toBe(200);
    });
  });

  // =========================================================================
  // 5. INTEGRITAS MIGRASI 0004 PADA DATABASE BERISI DATA & PEMULIHAN SUPER ADMIN
  // =========================================================================
  describe('Integritas Migrasi 0004 pada Database Berisi Data & Pemulihan Super Admin', () => {
    it('berhasil menjalankan migrasi 0004 pada database berisi data tanpa kehilangan baris atau pelanggaran foreign key', async () => {
      const mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: { DB: 'test-populated-migration' }
      });
      const db = (await mf.getD1Database('DB')) as unknown as D1Database;
      const rootDir = process.cwd();

      // Terapkan migrasi 0001, 0002, 0003
      const m1 = fs.readFileSync(path.join(rootDir, 'migrations', '0001_initial_schema.sql'), 'utf-8');
      const m2 = fs.readFileSync(path.join(rootDir, 'migrations', '0002_authentication_schema.sql'), 'utf-8');
      const m3 = fs.readFileSync(path.join(rootDir, 'migrations', '0003_videos_schema.sql'), 'utf-8');
      const m4 = fs.readFileSync(path.join(rootDir, 'migrations', '0004_three_tier_roles.sql'), 'utf-8');

      for (const s of [...splitSqlStatements(m1), ...splitSqlStatements(m2), ...splitSqlStatements(m3)]) {
        await db.prepare(s).run();
      }

      // Isi data representatif
      await db.prepare(`
        INSERT INTO users (id, username, password_hash, password_salt, role, status, created_at)
        VALUES
          ('admin-old-1', 'admin_pertama', 'h1', 's1', 'admin', 'active', '2026-01-01 10:00:00'),
          ('admin-old-2', 'admin_kedua', 'h2', 's2', 'admin', 'active', '2026-01-02 10:00:00')
      `).run();

      await db.prepare(`
        INSERT INTO activation_codes (id, code_hash, created_by, status, max_uses, used_count, expires_at)
        VALUES
          ('code-1', 'chash1', 'admin-old-1', 'active', 1, 0, datetime('now', '+30 days')),
          ('code-2', 'chash2', 'admin-old-1', 'active', 1, 0, datetime('now', '+30 days'))
      `).run();

      await db.prepare(`
        INSERT INTO users (id, username, password_hash, password_salt, role, status, activation_code_id, created_at)
        VALUES
          ('user-reg-1', 'member_satu', 'mh1', 'ms1', 'user', 'active', 'code-1', '2026-01-03 10:00:00'),
          ('user-reg-2', 'member_dua', 'mh2', 'ms2', 'user', 'suspended', 'code-2', '2026-01-04 10:00:00')
      `).run();

      await db.prepare(`
        UPDATE activation_codes
        SET status = 'used', used_count = 1, used_by_user_id = 'user-reg-1', used_at = CURRENT_TIMESTAMP
        WHERE id = 'code-1'
      `).run();

      await db.prepare(`
        UPDATE activation_codes
        SET status = 'used', used_count = 1, used_by_user_id = 'user-reg-2', used_at = CURRENT_TIMESTAMP
        WHERE id = 'code-2'
      `).run();

      await db.prepare(`
        INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active)
        VALUES
          ('dev-admin-1', 'admin-old-1', 'dh_a1', 'Admin Laptop', 1),
          ('dev-user-1', 'user-reg-1', 'dh_u1', 'Member Phone', 1)
      `).run();

      await db.prepare(`
        INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, expires_at)
        VALUES
          ('sess-admin-1', 'admin-old-1', 'dev-admin-1', 'sh_a1', datetime('now', '+30 days')),
          ('sess-user-1', 'user-reg-1', 'dev-user-1', 'sh_u1', datetime('now', '+30 days'))
      `).run();

      await db.prepare(`
        INSERT INTO videos (id, title, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id)
        VALUES
          ('vid-1', 'Video Review 1', 'Kemeja Shopee', 'https://shope.ee/1', 'vids/1.mp4', 'video/mp4', 1024, 'active', 'admin-old-1')
      `).run();

      await db.prepare(`
        INSERT INTO device_reset_codes (id, user_id, code_hash, created_by, status, max_uses, used_count, expires_at)
        VALUES
          ('reset-1', 'user-reg-1', 'rh1', 'admin-old-1', 'active', 1, 0, datetime('now', '+30 minutes'))
      `).run();

      await db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details)
        VALUES
          ('log-1', 'admin-old-1', 'ACTIVATE_USER', 'user-reg-1', 'Aktivasi user reg 1'),
          ('log-2', 'admin-old-1', 'UPLOAD_VIDEO', NULL, 'Upload vid-1')
      `).run();

      // Jalankan migrasi 0004 sebagai batch atomic (identik dengan cara Wrangler D1 menerapkan file migrasi)
      const m4Statements = splitSqlStatements(m4);
      await db.batch(m4Statements.map((stmt) => db.prepare(stmt)));

      // 1. Verifikasi foreign key check bersih
      const fkCheck = await db.prepare('PRAGMA foreign_key_check').all();
      expect(fkCheck.results.length).toBe(0);

      // 2. Verifikasi jumlah baris setiap tabel utuh (zero data loss)
      const usersCount = await db.prepare('SELECT COUNT(*) as c FROM users').first<any>();
      expect(usersCount.c).toBe(4);

      const codesCount = await db.prepare('SELECT COUNT(*) as c FROM activation_codes').first<any>();
      expect(codesCount.c).toBe(2);

      const devicesCount = await db.prepare('SELECT COUNT(*) as c FROM user_devices').first<any>();
      expect(devicesCount.c).toBe(2);

      const sessionsCount = await db.prepare('SELECT COUNT(*) as c FROM user_sessions').first<any>();
      expect(sessionsCount.c).toBe(2);

      const videosCount = await db.prepare('SELECT COUNT(*) as c FROM videos').first<any>();
      expect(videosCount.c).toBe(1);

      const resetCount = await db.prepare('SELECT COUNT(*) as c FROM device_reset_codes').first<any>();
      expect(resetCount.c).toBe(1);

      const logsCount = await db.prepare('SELECT COUNT(*) as c FROM audit_logs').first<any>();
      expect(logsCount.c).toBe(2);

      // 3. Verifikasi promosi admin & pemetaan role
      const promoted = await db.prepare("SELECT * FROM users WHERE id = 'admin-old-1'").first<any>();
      expect(promoted.role).toBe('super_admin');
      expect(promoted.username).toBe('admin_pertama');

      const admin2 = await db.prepare("SELECT * FROM users WHERE id = 'admin-old-2'").first<any>();
      expect(admin2.role).toBe('admin');

      const member1 = await db.prepare("SELECT * FROM users WHERE id = 'user-reg-1'").first<any>();
      expect(member1.role).toBe('member');

      const member2 = await db.prepare("SELECT * FROM users WHERE id = 'user-reg-2'").first<any>();
      expect(member2.role).toBe('member');

      await mf.dispose();
    });

    it('memulihkan password Super Admin secara aman melalui utilitas CLI tanpa mengubah role atau merusak data', async () => {
      // Buat Super Admin
      const initialPass = 'OldSuperPassword123!';
      const newPass = 'BrandNewSuperPassword456!';
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_recovery_test', initialPass);

      // Pastikan login dengan password lama berhasil
      const loginOldRes = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'super_recovery_test', password: initialPass })
      }), ctx.env);
      expect(loginOldRes.status).toBe(200);

      // Bangkitkan statement pemulihan CLI
      const recoveryData = await generateRecoverySuperAdminSql('super_recovery_test', newPass);
      expect(recoveryData.username).toBe('super_recovery_test');
      expect(recoveryData.sqlStatements.length).toBe(2);

      // Eksekusi SQL pemulihan pada database
      for (const stmt of recoveryData.sqlStatements) {
        await ctx.db.prepare(stmt).run();
      }

      // Verifikasi login dengan password lama sekarang ditolak
      const loginFailRes = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'super_recovery_test', password: initialPass })
      }), ctx.env);
      expect(loginFailRes.status).toBe(401);

      // Verifikasi login dengan password baru berhasil
      const loginNewRes = await worker.fetch(new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'super_recovery_test', password: newPass })
      }), ctx.env);
      expect(loginNewRes.status).toBe(200);

      // Verifikasi audit log pemulihan tercatat
      const auditLog = await ctx.db
        .prepare("SELECT * FROM audit_logs WHERE target_user_id = ? AND details LIKE '%Emergency Super Admin password recovery%'")
        .bind(superAdmin.id)
        .first<any>();
      expect(auditLog).toBeDefined();
      expect(auditLog.details).toContain('Emergency Super Admin password recovery');

      // Verifikasi proteksi: SQL pemulihan tidak memengaruhi akun yang bukan Super Admin
      const regularAdmin = await seedTestAdmin(ctx.db, 'regular_admin_recover');
      expect(regularAdmin.username).toBe('regular_admin_recover');
      const hackAttemptSql = await generateRecoverySuperAdminSql('regular_admin_recover', 'NewPass123!');
      const updateResult = await ctx.db.prepare(hackAttemptSql.sqlStatements[0]).run();
      // UPDATE users WHERE username = 'regular_admin_recover' AND role = 'super_admin' -> meta.changes = 0
      expect(updateResult.meta.changes).toBe(0);
    });
  });
});
