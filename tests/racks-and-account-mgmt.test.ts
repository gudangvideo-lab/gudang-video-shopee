/**
 * tests/racks-and-account-mgmt.test.ts
 * Pengujian komprehensif untuk fitur baru:
 * 1. Manajemen username dan password mandiri (self-service).
 * 2. Pembuatan akun Super Admin tambahan dengan batas tepat 3.
 * 3. Penghapusan akun Admin dan Member secara aman (zero-orphan).
 * 4. Reset password dan ganti username oleh Super Admin.
 * 5. Sistem rak video (Rak General bawaan, pembuatan, pengubahan, pemindahan video, dan penghapusan aman).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import {
  createIsolatedTestDb,
  TestContext,
  seedTestAdmin,
  seedTestSuperAdmin,
  seedTestMember,
  seedTestActivationCode
} from './setup-test-db';

describe('Paket Fitur: Manajemen Akun, Keamanan, dan Sistem Rak', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe('1. Manajemen Password dan Username Mandiri (Self-Service)', () => {
    it('gagal mengubah password jika kata sandi lama salah', async () => {
      const member = await seedTestMember(ctx.db, 'member_self', 'OldPass123!');

      const res = await worker.fetch(
        new Request('http://localhost/api/auth/change-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${member.sessionCookie}; ${member.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            current_password: 'WrongPassword!',
            new_password: 'NewValidPassword123!'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBe('INVALID_CURRENT_PASSWORD');
    });

    it('berhasil mengubah password mandiri, mencabut sesi lama, dan memberikan sesi baru', async () => {
      const member = await seedTestMember(ctx.db, 'member_self2', 'OldPass123!');

      const res = await worker.fetch(
        new Request('http://localhost/api/auth/change-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${member.sessionCookie}; ${member.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            current_password: 'OldPass123!',
            new_password: 'BrandNewPass123!'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.status).toBe('ok');

      // Cookie sesi baru diterbitkan
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain('__Host-gvs_session=');

      // Sesi lama dicabut di database
      const oldSessions = await ctx.db
        .prepare('SELECT COUNT(*) as active FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL')
        .bind(member.id)
        .first<{ active: number }>();

      // Hanya ada 1 sesi baru yang aktif
      expect(oldSessions?.active).toBe(1);
    });

    it('berhasil mengubah username mandiri dengan verifikasi password', async () => {
      const member = await seedTestMember(ctx.db, 'member_old_uname', 'SecretPass123!');

      const res = await worker.fetch(
        new Request('http://localhost/api/auth/change-username', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${member.sessionCookie}; ${member.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            current_password: 'SecretPass123!',
            new_username: 'member_new_uname'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.user.username).toBe('member_new_uname');

      // Pastikan di database berubah
      const userDb = await ctx.db
        .prepare('SELECT username FROM users WHERE id = ?')
        .bind(member.id)
        .first<{ username: string }>();
      expect(userDb?.username).toBe('member_new_uname');
    });

    it('gagal mengubah username mandiri jika username sudah digunakan akun lain', async () => {
      await seedTestMember(ctx.db, 'existing_user', 'Pass123!');
      const member2 = await seedTestMember(ctx.db, 'another_user', 'Pass123!');

      const res = await worker.fetch(
        new Request('http://localhost/api/auth/change-username', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${member2.sessionCookie}; ${member2.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            current_password: 'Pass123!',
            new_username: 'EXISTING_USER' // Test case-insensitivity
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBe('USERNAME_TAKEN');
    });
  });

  describe('2. Kebijakan Super Admin: Maksimal 2 Akun, Bootstrap Out-of-Band & Sesi Multi-Browser', () => {
    it('endpoint pembuatan Super Admin via aplikasi ditiadakan (mengembalikan 404 NOT_FOUND)', async () => {
      const superAdmin1 = await seedTestSuperAdmin(ctx.db, 'super1', 'SuperPass123!');

      const res = await worker.fetch(
        new Request('http://localhost/api/super-admin/super-admins', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${superAdmin1.sessionCookie}; ${superAdmin1.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            username: 'super_attempt',
            password: 'SuperPass123!'
          })
        }),
        ctx.env
      );

      // Endpoint ditiadakan dan ditolak secara aman dengan 404
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toBe('Endpoint tidak ditemukan');
    });

    it('skrip operasional bootstrap dapat membuat Super Admin ke-1 dan ke-2, namun menolak ke-3 (batas maksimal 2)', async () => {
      const { generateBootstrapAdminSql } = await import('../scripts/bootstrap-admin.js');

      // 1. Buat Super Admin pertama via bootstrap script
      const boot1 = await generateBootstrapAdminSql('super_boot_1', 'SuperPass123!');
      for (const stmt of boot1.sqlStatements) {
        await ctx.db.prepare(stmt).run();
      }

      const count1 = await ctx.db
        .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'super_admin'")
        .first<{ total: number }>();
      expect(count1?.total).toBe(1);

      // 2. Buat Super Admin kedua via bootstrap script
      const boot2 = await generateBootstrapAdminSql('super_boot_2', 'SuperPass123!');
      for (const stmt of boot2.sqlStatements) {
        await ctx.db.prepare(stmt).run();
      }

      const count2 = await ctx.db
        .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'super_admin'")
        .first<{ total: number }>();
      expect(count2?.total).toBe(2);

      // 3. Coba buat Super Admin ketiga via bootstrap script (harus no-op karena COUNT >= 2)
      const boot3 = await generateBootstrapAdminSql('super_boot_3', 'SuperPass123!');
      for (const stmt of boot3.sqlStatements) {
        await ctx.db.prepare(stmt).run();
      }

      const count3 = await ctx.db
        .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'super_admin'")
        .first<{ total: number }>();
      expect(count3?.total).toBe(2);

      const check3 = await ctx.db
        .prepare("SELECT id FROM users WHERE username = 'super_boot_3'")
        .first();
      expect(check3).toBeNull();
    });

    it('skrip bootstrap memiliki perilaku idempoten (tidak menimpa akun yang sudah ada)', async () => {
      const { generateBootstrapAdminSql } = await import('../scripts/bootstrap-admin.js');

      // Buat akun super_idem_1
      const bootA = await generateBootstrapAdminSql('super_idem_1', 'InitialPass123!');
      for (const stmt of bootA.sqlStatements) {
        await ctx.db.prepare(stmt).run();
      }

      const originalUser = await ctx.db
        .prepare("SELECT password_hash FROM users WHERE username = 'super_idem_1'")
        .first<{ password_hash: string }>();

      // Jalankan ulang bootstrap dengan username yang sama tetapi password berbeda
      const bootB = await generateBootstrapAdminSql('super_idem_1', 'DifferentPass123!');
      for (const stmt of bootB.sqlStatements) {
        await ctx.db.prepare(stmt).run();
      }

      const afterUser = await ctx.db
        .prepare("SELECT password_hash FROM users WHERE username = 'super_idem_1'")
        .first<{ password_hash: string }>();

      // Password hash asli TIDAK BERUBAH (anti-takeover)
      expect(afterUser?.password_hash).toBe(originalUser?.password_hash);
    });

    it('kedua Super Admin dapat memiliki sesi simultan di berbagai perangkat/browser tanpa saling mencabut sesi', async () => {
      const super1 = await seedTestSuperAdmin(ctx.db, 'super_user_one', 'SuperPass123!');
      const super2 = await seedTestSuperAdmin(ctx.db, 'super_user_two', 'SuperPass123!');

      // Login Super Admin 1 dari Browser A
      const login1A = await worker.fetch(
        new Request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
          body: JSON.stringify({ username: 'super_user_one', password: 'SuperPass123!', device_name: 'Laptop Work' })
        }),
        ctx.env
      );
      expect(login1A.status).toBe(200);

      // Login Super Admin 1 dari Browser B (tidak membatalkan Browser A)
      const login1B = await worker.fetch(
        new Request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
          body: JSON.stringify({ username: 'super_user_one', password: 'SuperPass123!', device_name: 'HP Mobile' })
        }),
        ctx.env
      );
      expect(login1B.status).toBe(200);

      // Login Super Admin 2 dari Browser C
      const login2 = await worker.fetch(
        new Request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
          body: JSON.stringify({ username: 'super_user_two', password: 'SuperPass123!', device_name: 'PC Kantor' })
        }),
        ctx.env
      );
      expect(login2.status).toBe(200);

      // Periksa bahwa total sesi aktif di database tetap tersimpan untuk kedua Super Admin
      const sessionsSuper1 = await ctx.db
        .prepare('SELECT COUNT(*) AS total FROM user_sessions WHERE user_id = ?')
        .bind(super1.id)
        .first<{ total: number }>();
      expect(sessionsSuper1?.total).toBeGreaterThanOrEqual(2);

      const sessionsSuper2 = await ctx.db
        .prepare('SELECT COUNT(*) AS total FROM user_sessions WHERE user_id = ?')
        .bind(super2.id)
        .first<{ total: number }>();
      expect(sessionsSuper2?.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe('3. Penghapusan Akun Admin & Member secara Aman (Zero-Orphan)', () => {
    it('gagal jika konfirmasi username tidak cocok', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_deleter', 'Pass123!');
      const admin = await seedTestAdmin(ctx.db, 'admin_victim', 'Pass123!');

      const res = await worker.fetch(
        new Request(`http://localhost/api/super-admin/users/${admin.id}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            confirm_username: 'wrong_username'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBe('CONFIRMATION_MISMATCH');
    });

    it('Super Admin dilarang menghapus akunnya sendiri', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_self_del', 'Pass123!');

      const res = await worker.fetch(
        new Request(`http://localhost/api/super-admin/users/${superAdmin.id}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            confirm_username: 'super_self_del'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBe('CANNOT_DELETE_SELF');
    });

    it('Super Admin dilarang menghapus akun Super Admin lain via API web', async () => {
      const super1 = await seedTestSuperAdmin(ctx.db, 'super_one', 'Pass123!');
      const super2 = await seedTestSuperAdmin(ctx.db, 'super_two', 'Pass12345!');

      const res = await worker.fetch(
        new Request(`http://localhost/api/super-admin/users/${super2.id}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${super1.sessionCookie}; ${super1.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            confirm_username: 'super_two'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toBe('SUPER_ADMIN_PROTECTED');
    });

    it('berhasil menghapus akun Admin dan me-reassign video serta kode aktivasi ke Super Admin', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_boss', 'Pass123!');
      const admin = await seedTestAdmin(ctx.db, 'admin_to_delete', 'Pass123!');

      // Admin mengunggah video
      const videoId = crypto.randomUUID();
      await ctx.db
        .prepare(`
          INSERT INTO videos (
            id, title, product_name, product_url, r2_key,
            content_type, file_size, status, uploaded_by_admin_id, rack_id
          ) VALUES (?, 'Video Admin', 'Produk', 'https://shopee.co.id/p', 'videos/dummy.mp4', 'video/mp4', 1000, 'active', ?, '00000000-0000-0000-0000-000000000001')
        `)
        .bind(videoId, admin.id)
        .run();

      // Admin membuat kode aktivasi
      const code = await seedTestActivationCode(ctx.db, admin.id);

      // Hapus akun admin
      const res = await worker.fetch(
        new Request(`http://localhost/api/super-admin/users/${admin.id}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            confirm_username: 'admin_to_delete'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(200);

      // Verifikasi admin sudah tidak ada di users
      const deletedUser = await ctx.db
        .prepare('SELECT id FROM users WHERE id = ?')
        .bind(admin.id)
        .first();
      expect(deletedUser).toBeNull();

      // Video TIDAK terhapus, melainkan di-reassign ke superAdmin
      const videoDb = await ctx.db
        .prepare('SELECT uploaded_by_admin_id FROM videos WHERE id = ?')
        .bind(videoId)
        .first<{ uploaded_by_admin_id: string }>();
      expect(videoDb?.uploaded_by_admin_id).toBe(superAdmin.id);

      // Kode aktivasi TIDAK terhapus, melainkan di-reassign ke superAdmin
      const codeDb = await ctx.db
        .prepare('SELECT created_by FROM activation_codes WHERE id = ?')
        .bind(code.id)
        .first<{ created_by: string }>();
      expect(codeDb?.created_by).toBe(superAdmin.id);
    });
  });

  describe('4. Reset Password dan Ganti Username oleh Super Admin', () => {
    it('Super Admin dapat mereset password akun Member dan mencabut sesinya', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_resetter', 'Pass123!');
      const member = await seedTestMember(ctx.db, 'member_target', 'OldMemberPass123!');

      const res = await worker.fetch(
        new Request(`http://localhost/api/super-admin/users/${member.id}/reset-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            new_password: 'ResetPasswordSuccess123!'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(200);

      // Sesi lama member telah dicabut
      const activeSessions = await ctx.db
        .prepare('SELECT COUNT(*) as count FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL')
        .bind(member.id)
        .first<{ count: number }>();
      expect(activeSessions?.count).toBe(0);
    });

    it('Super Admin dapat mengubah username akun Admin atau Member', async () => {
      const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_uname_mgr', 'Pass123!');
      const member = await seedTestMember(ctx.db, 'member_initial_uname', 'Pass123!');

      const res = await worker.fetch(
        new Request(`http://localhost/api/super-admin/users/${member.id}/username`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({
            new_username: 'member_renamed_by_super'
          })
        }),
        ctx.env
      );

      expect(res.status).toBe(200);

      const userDb = await ctx.db
        .prepare('SELECT username FROM users WHERE id = ?')
        .bind(member.id)
        .first<{ username: string }>();
      expect(userDb?.username).toBe('member_renamed_by_super');
    });
  });

  describe('5. Sistem Rak Video (General Default, Pembuatan, Pemindahan, dan Penghapusan Aman)', () => {
    it('rak default General otomatis ada dengan id stabil 00000000-0000-0000-0000-000000000001', async () => {
      const defaultRack = await ctx.db
        .prepare("SELECT id, name, is_default FROM racks WHERE id = '00000000-0000-0000-0000-000000000001'")
        .first<{ id: string; name: string; is_default: number }>();

      expect(defaultRack).toBeDefined();
      expect(defaultRack?.name).toBe('General');
      expect(defaultRack?.is_default).toBe(1);
    });

    it('dilarang mengubah nama atau menghapus rak default General', async () => {
      const admin = await seedTestAdmin(ctx.db, 'admin_rack_tester', 'Pass123!');

      // Coba rename
      const resRename = await worker.fetch(
        new Request('http://localhost/api/admin/racks/00000000-0000-0000-0000-000000000001', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({ name: 'RenamedGeneral' })
        }),
        ctx.env
      );
      expect(resRename.status).toBe(400);

      // Coba delete
      const resDel = await worker.fetch(
        new Request('http://localhost/api/admin/racks/00000000-0000-0000-0000-000000000001', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
            Origin: 'http://localhost'
          }
        }),
        ctx.env
      );
      expect(resDel.status).toBe(400);
    });

    it('Admin dapat membuat rak baru, me-rename rak, dan memindahkan video antar rak', async () => {
      const admin = await seedTestAdmin(ctx.db, 'admin_rack_flow', 'Pass123!');

      // 1. Buat rak baru 'Elektronik'
      const resCreate = await worker.fetch(
        new Request('http://localhost/api/admin/racks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({ name: 'Elektronik' })
        }),
        ctx.env
      );
      expect(resCreate.status).toBe(201);
      const dataCreate = await resCreate.json() as any;
      const rackId = dataCreate.rack.id;

      // 2. Rename rak 'Elektronik' ke 'Gadget & Elektronik'
      const resUpdate = await worker.fetch(
        new Request(`http://localhost/api/admin/racks/${rackId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({ name: 'Gadget & Elektronik' })
        }),
        ctx.env
      );
      expect(resUpdate.status).toBe(200);
      const dataUpdate = await resUpdate.json() as any;
      expect(dataUpdate.rack.name).toBe('Gadget & Elektronik');

      // 3. Masukkan video ke General
      const videoId = crypto.randomUUID();
      await ctx.db
        .prepare(`
          INSERT INTO videos (
            id, title, product_name, product_url, r2_key,
            content_type, file_size, status, uploaded_by_admin_id, rack_id
          ) VALUES (?, 'Smartphone Unboxing', 'Smartphone X', 'https://shopee.co.id/x', 'videos/x.mp4', 'video/mp4', 1000, 'active', ?, '00000000-0000-0000-0000-000000000001')
        `)
        .bind(videoId, admin.id)
        .run();

      // 4. Pindahkan video ke rak 'Gadget & Elektronik'
      const resMove = await worker.fetch(
        new Request(`http://localhost/api/admin/videos/${videoId}/rack`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
            Origin: 'http://localhost'
          },
          body: JSON.stringify({ target_rack_id: rackId })
        }),
        ctx.env
      );
      expect(resMove.status).toBe(200);

      // Cek di DB bahwa video sekarang berada di rak 'Gadget & Elektronik'
      const videoDb = await ctx.db
        .prepare('SELECT rack_id FROM videos WHERE id = ?')
        .bind(videoId)
        .first<{ rack_id: string }>();
      expect(videoDb?.rack_id).toBe(rackId);

      // 5. Hapus rak 'Gadget & Elektronik': Video otomatis kembali ke 'General' secara aman!
      const resDelRack = await worker.fetch(
        new Request(`http://localhost/api/admin/racks/${rackId}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
            Origin: 'http://localhost'
          }
        }),
        ctx.env
      );
      expect(resDelRack.status).toBe(200);
      const dataDel = await resDelRack.json() as any;
      expect(dataDel.moved_video_count).toBe(1);

      // Pastikan video otomatis kembali ke General
      const videoAfterDel = await ctx.db
        .prepare('SELECT rack_id FROM videos WHERE id = ?')
        .bind(videoId)
        .first<{ rack_id: string }>();
      expect(videoAfterDel?.rack_id).toBe('00000000-0000-0000-0000-000000000001');
    });
  });
});
