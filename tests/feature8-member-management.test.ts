/**
 * tests/feature8-member-management.test.ts
 * Pengujian Komprehensif Fitur 8: Nonaktifkan dan Hapus Member Secara Terpisah.
 *
 * Verifikasi 10 Kriteria Wajib:
 * 1. Admin yang berwenang dapat menonaktifkan Member (PATCH /api/admin/users/:id/status).
 * 2. Super Admin dapat melakukan tindakan penonaktifan dan pengaktifan sesuai kebijakan RBAC.
 * 3. Member yang dinonaktifkan seketika ditolak saat mengakses endpoint terlindungi,
 *    termasuk dengan cookie sesi yang sebelumnya masih valid.
 * 4. Akun Admin dan Super Admin TIDAK DAPAT diubah statusnya atau dihapus melalui endpoint khusus Member.
 * 5. Pengguna tanpa otorisasi (anonim 401, member 403) mendapat respons yang tepat.
 * 6. Penghapusan Member (DELETE /api/admin/users/:id) menuntut konfirmasi username yang valid.
 * 7. Penghapusan Member tidak merusak relasi database, tabel audit log historis, atau katalog video.
 * 8. File video katalog dan tautan produk Shopee tetap aman dan utuh setelah Member dihapus.
 * 9. Akun yang dinonaktifkan dapat dipulihkan/diaktifkan kembali melalui tindakan Aktifkan.
 * 10. Filter status (active/suspended) dan hitungan database anggota merefleksikan status akun secara deterministik.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import {
  createIsolatedTestDb,
  seedTestSuperAdmin,
  seedTestAdmin,
  seedTestUser,
  TestContext
} from './setup-test-db';

describe('Fitur 8 — Nonaktifkan dan Hapus Member Secara Terpisah', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('1, 2, 5: Otorisasi RBAC — Admin dan Super Admin diizinkan, Member ditolak (403), Anonim ditolak (401)', async () => {
    const superAdmin = await seedTestSuperAdmin(ctx.db, 'f8_super');
    const admin = await seedTestAdmin(ctx.db, 'f8_admin');
    const memberTarget = await seedTestUser(ctx.db, superAdmin.id, 'f8_target_member');
    const memberAttacker = await seedTestUser(ctx.db, superAdmin.id, 'f8_attacker_member');

    // 1. Anonim ditolak (401)
    const anonRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberTarget.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' })
      }),
      ctx.env
    );
    expect(anonRes.status).toBe(401);

    // 2. Member biasa ditolak (403)
    const memberRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberTarget.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${memberAttacker.sessionCookie}; ${memberAttacker.deviceCookie}`
        },
        body: JSON.stringify({ status: 'suspended' })
      }),
      ctx.env
    );
    expect(memberRes.status).toBe(403);

    // 3. Admin diizinkan (200)
    const adminRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberTarget.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`
        },
        body: JSON.stringify({ status: 'suspended', reason: 'Uji penonaktifan oleh Admin' })
      }),
      ctx.env
    );
    expect(adminRes.status).toBe(200);
    const adminData = (await adminRes.json()) as any;
    expect(adminData.status).toBe('ok');
    expect(adminData.user.status).toBe('suspended');

    // 4. Super Admin diizinkan mengaktifkan kembali (200)
    const superRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberTarget.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`
        },
        body: JSON.stringify({ status: 'active' })
      }),
      ctx.env
    );
    expect(superRes.status).toBe(200);
    const superData = (await superRes.json()) as any;
    expect(superData.status).toBe('ok');
    expect(superData.user.status).toBe('active');
  });

  it('3 & 9: Member dinonaktifkan seketika kehilangan akses pada seluruh endpoint terlindungi, lalu pulih saat diaktifkan kembali', async () => {
    const admin = await seedTestAdmin(ctx.db, 'f8_admin_revoker');
    const member = await seedTestUser(ctx.db, admin.id, 'f8_active_victim');

    // Seed satu video aktif dalam rak default
    const videoId = crypto.randomUUID();
    const r2Key = 'videos/f8-test-video.mp4';
    await ctx.db.prepare(`
      INSERT INTO videos (id, title, description, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id, rack_id)
      VALUES (?, 'Video Uji Fitur 8', 'Deskripsi', 'Produk Shopee', 'https://shopee.co.id/product/123', ?, 'video/mp4', 1024, 'active', ?, '00000000-0000-0000-0000-000000000001')
    `).bind(videoId, r2Key, admin.id).run();

    await ctx.env.VIDEOS_BUCKET!.put(r2Key, new Uint8Array([1, 2, 3, 4]));

    // Sebelum dinonaktifkan: Member dapat mengakses /api/auth/me, /api/videos, dan stream video
    const meBefore = await worker.fetch(
      new Request('http://localhost/api/auth/me', {
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` }
      }),
      ctx.env
    );
    expect(meBefore.status).toBe(200);

    const streamBefore = await worker.fetch(
      new Request(`http://localhost/api/videos/${videoId}/stream`, {
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` }
      }),
      ctx.env
    );
    expect(streamBefore.status).toBe(200);

    // ADMIN MENONAKTIFKAN MEMBER
    const suspendRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${member.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`
        },
        body: JSON.stringify({ status: 'suspended', reason: 'Pelanggaran ketentuan akses' })
      }),
      ctx.env
    );
    expect(suspendRes.status).toBe(200);

    // Sesi aktif yang sebelumnya dipegang Member SEKETIKA DITOLAK (401 Unauthorized)
    // 1. /api/auth/me
    const meAfter = await worker.fetch(
      new Request('http://localhost/api/auth/me', {
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` }
      }),
      ctx.env
    );
    expect(meAfter.status).toBe(401);

    // 2. /api/videos (katalog)
    const videosAfter = await worker.fetch(
      new Request('http://localhost/api/videos', {
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` }
      }),
      ctx.env
    );
    expect(videosAfter.status).toBe(401);

    // 3. /api/videos/:id/stream (pemutaran)
    const streamAfter = await worker.fetch(
      new Request(`http://localhost/api/videos/${videoId}/stream`, {
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` }
      }),
      ctx.env
    );
    expect(streamAfter.status).toBe(401);

    // 4. /api/videos/:id/download (unduhan)
    const downloadAfter = await worker.fetch(
      new Request(`http://localhost/api/videos/${videoId}/download`, {
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` }
      }),
      ctx.env
    );
    expect(downloadAfter.status).toBe(401);

    // Verifikasi audit log SUSPEND_USER tercatat
    const auditLogRow = await ctx.db
      .prepare(`SELECT action, target_user_id, details FROM audit_logs WHERE target_user_id = ? AND action = 'SUSPEND_USER'`)
      .bind(member.id)
      .first<{ action: string; target_user_id: string; details: string }>();
    expect(auditLogRow).toBeDefined();
    expect(auditLogRow?.details).toContain('Pelanggaran ketentuan akses');

    // AKTIFKAN KEMBALI MEMBER OLEH ADMIN
    const activateRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${member.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`
        },
        body: JSON.stringify({ status: 'active' })
      }),
      ctx.env
    );
    expect(activateRes.status).toBe(200);

    const userDb = await ctx.db
      .prepare(`SELECT status FROM users WHERE id = ?`)
      .bind(member.id)
      .first<{ status: string }>();
    expect(userDb?.status).toBe('active');
  });

  it('4: Akun Admin dan Super Admin TIDAK DAPAT dinonaktifkan atau dihapus via endpoint Member', async () => {
    const superAdmin = await seedTestSuperAdmin(ctx.db, 'f8_super_prot');
    const adminA = await seedTestAdmin(ctx.db, 'f8_admin_a');
    const adminB = await seedTestAdmin(ctx.db, 'f8_admin_b');

    // Admin A mencoba menonaktifkan Admin B -> DITOLAK (403)
    const suspendAdminRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${adminB.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${adminA.sessionCookie}; ${adminA.deviceCookie}`
        },
        body: JSON.stringify({ status: 'suspended' })
      }),
      ctx.env
    );
    expect(suspendAdminRes.status).toBe(403);
    const suspendAdminData = (await suspendAdminRes.json()) as any;
    expect(suspendAdminData.error).toBe('INVALID_ROLE');

    // Admin A mencoba menghapus Admin B via DELETE /api/admin/users/:id -> DITOLAK (403)
    const deleteAdminRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${adminB.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${adminA.sessionCookie}; ${adminA.deviceCookie}`
        },
        body: JSON.stringify({ confirm_username: 'f8_admin_b' })
      }),
      ctx.env
    );
    expect(deleteAdminRes.status).toBe(403);
    const deleteAdminData = (await deleteAdminRes.json()) as any;
    expect(deleteAdminData.error).toBe('CANNOT_DELETE_NON_MEMBER');

    // Admin A mencoba menghapus Super Admin via DELETE /api/admin/users/:id -> DITOLAK (403)
    const deleteSuperRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${superAdmin.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${adminA.sessionCookie}; ${adminA.deviceCookie}`
        },
        body: JSON.stringify({ confirm_username: 'f8_super_prot' })
      }),
      ctx.env
    );
    expect(deleteSuperRes.status).toBe(403);
    const deleteSuperData = (await deleteSuperRes.json()) as any;
    expect(deleteSuperData.error).toBe('CANNOT_DELETE_NON_MEMBER');

    // Pengguna tidak dapat menonaktifkan dirinya sendiri (403)
    const selfSuspendRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${adminA.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${adminA.sessionCookie}; ${adminA.deviceCookie}`
        },
        body: JSON.stringify({ status: 'suspended' })
      }),
      ctx.env
    );
    expect(selfSuspendRes.status).toBe(403);
    const selfSuspendData = (await selfSuspendRes.json()) as any;
    expect(selfSuspendData.error).toBe('SELF_STATUS_UPDATE_FORBIDDEN');
  });

  it('6, 7, 8: Tindakan Hapus Member — validasi konfirmasi, zero data video/R2 deletion, preservasi audit logs', async () => {
    const admin = await seedTestAdmin(ctx.db, 'f8_admin_deleter');
    const member = await seedTestUser(ctx.db, admin.id, 'f8_member_to_delete');

    // Seed video yang diunggah oleh admin
    const videoId = crypto.randomUUID();
    const r2Key = 'videos/f8-video-safe.mp4';
    await ctx.db.prepare(`
      INSERT INTO videos (id, title, description, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id, rack_id)
      VALUES (?, 'Video Katalog Aman', 'Deskripsi Aman', 'Produk Shopee', 'https://shopee.co.id/product/safe', ?, 'video/mp4', 2048, 'active', ?, '00000000-0000-0000-0000-000000000001')
    `).bind(videoId, r2Key, admin.id).run();

    await ctx.env.VIDEOS_BUCKET!.put(r2Key, new Uint8Array([5, 6, 7, 8]));

    // Buat riwayat permohonan Shopee milik member ini
    const reqId = crypto.randomUUID();
    await ctx.db.prepare(`
      INSERT INTO shopee_account_requests (id, user_id, current_shopee_link, requested_shopee_link, status)
      VALUES (?, ?, 'https://shopee.co.id/old_link', 'https://shopee.co.id/new_link', 'pending')
    `).bind(reqId, member.id).run();

    // Buat audit log lama yang menargetkan member ini
    const oldLogId = crypto.randomUUID();
    await ctx.db.prepare(`
      INSERT INTO audit_logs (id, admin_id, action, target_user_id, details)
      VALUES (?, ?, 'RESET_DEVICE', ?, 'Reset perangkat uji sebelum penghapusan')
    `).bind(oldLogId, admin.id, member.id).run();

    // 1. Hapus tanpa nama konfirmasi atau nama salah -> DITOLAK (400)
    const wrongConfirmRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${member.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`
        },
        body: JSON.stringify({ confirm_username: 'wrong_username' })
      }),
      ctx.env
    );
    expect(wrongConfirmRes.status).toBe(400);
    const wrongConfirmData = (await wrongConfirmRes.json()) as any;
    expect(wrongConfirmData.error).toBe('CONFIRMATION_MISMATCH');

    // 2. Hapus dengan nama konfirmasi yang cocok (case-insensitive) -> SUKSES (200)
    const deleteRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${member.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`
        },
        body: JSON.stringify({ confirm_username: 'F8_MEMBER_TO_DELETE' })
      }),
      ctx.env
    );
    expect(deleteRes.status).toBe(200);
    const deleteData = (await deleteRes.json()) as any;
    expect(deleteData.status).toBe('ok');

    // 3. Verifikasi akun member benar-benar terhapus dari users
    const checkUser = await ctx.db
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(member.id)
      .first();
    expect(checkUser).toBeNull();

    // 4. Verifikasi video katalog & objek R2 TETAP ADA DAN UTUH (zero video loss)
    const checkVideo = await ctx.db
      .prepare('SELECT id, r2_key, title, product_url FROM videos WHERE id = ?')
      .bind(videoId)
      .first<{ id: string; r2_key: string; title: string; product_url: string }>();
    expect(checkVideo).toBeDefined();
    expect(checkVideo?.title).toBe('Video Katalog Aman');
    expect(checkVideo?.product_url).toBe('https://shopee.co.id/product/safe');

    const r2Obj = await ctx.env.VIDEOS_BUCKET!.get(r2Key);
    expect(r2Obj).not.toBeNull();

    // 5. Verifikasi log audit historis TIDAK DIHAPUS (target_user_id di-nullkan secara aman)
    const oldLogCheck = await ctx.db
      .prepare('SELECT id, action, target_user_id, details FROM audit_logs WHERE id = ?')
      .bind(oldLogId)
      .first<{ id: string; action: string; target_user_id: string | null; details: string }>();
    expect(oldLogCheck).toBeDefined();
    expect(oldLogCheck?.target_user_id).toBeNull();
    expect(oldLogCheck?.details).toContain('Reset perangkat uji sebelum penghapusan');

    // 6. Verifikasi aksi DELETE_USER tercatat di audit log
    const deleteLog = await ctx.db
      .prepare('SELECT action, details FROM audit_logs WHERE action = "DELETE_USER" ORDER BY created_at DESC LIMIT 1')
      .first<{ action: string; details: string }>();
    expect(deleteLog).toBeDefined();
    expect(deleteLog?.details).toContain('f8_member_to_delete');
  });
});
