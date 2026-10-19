/**
 * tests/feature9-cleanup-on-delete.test.ts
 * Pengujian Regresi: Pembersihan Objek Bukti Komisi di Cloudflare R2 Saat Akun Dihapus.
 *
 * Verifikasi 10 Poin Wajib:
 * 1. Member memiliki bukti komisi di D1 dan objeknya ada di R2.
 * 2. Admin menghapus Member melalui handleDeleteMember.
 * 3. Akun dan metadata bukti komisi terhapus sesuai perilaku yang diharapkan.
 * 4. Objek bukti komisi Member tersebut ikut dihapus dari R2.
 * 5. Video katalog dan objek lain yang tidak terkait tetap ada.
 * 6. Penghapusan akun melalui handleDeleteAccount, jika berlaku untuk Member, juga membersihkan objek bukti komisi.
 * 7. Jika Member tidak memiliki bukti komisi, penghapusan akun tetap berhasil tanpa error yang tidak semestinya.
 * 8. Jika penghapusan D1 gagal, objek bukti komisi lama tidak dihapus terlebih dahulu.
 * 9. Jika penghapusan objek R2 gagal setelah penghapusan D1 berhasil, kegagalan ditangani dan dilaporkan dengan benar.
 * 10. Penghapusan akun tidak menghasilkan akses baru atau membuka kembali bukti komisi yang sudah tidak memiliki metadata aktif.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../worker/index';
import {
  createIsolatedTestDb,
  seedTestSuperAdmin,
  seedTestAdmin,
  seedTestUser,
  TestContext
} from './setup-test-db';

function createDummyImage(name: string, type: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg'): File {
  let bytes: Uint8Array;
  if (type === 'image/jpeg') {
    bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 10, 20, 30, 40]);
  } else if (type === 'image/png') {
    bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 10, 20, 30, 40]);
  } else {
    bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 10, 20, 30, 40]);
  }
  return new File([bytes], name, { type });
}

describe('Pembersihan Objek Bukti Komisi di R2 Saat Akun Dihapus', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('1, 2, 3, 4, 5, 10: handleDeleteMember membersihkan bukti komisi dari D1 & R2 tanpa menghapus video katalog atau objek lain', async () => {
    const admin = await seedTestAdmin(ctx.db, 'del_admin_1');
    const member = await seedTestUser(ctx.db, admin.id, 'del_member_1');

    // Simpan objek video katalog terpisah di R2 dan D1 untuk memastikan tidak terhapus
    const catalogVideoKey = 'videos/unrelated-catalog-video-123.mp4';
    await ctx.env.VIDEOS_BUCKET!.put(catalogVideoKey, new Uint8Array([1, 2, 3, 4, 5]), {
      httpMetadata: { contentType: 'video/mp4' }
    });

    // 1. Member mengunggah bukti komisi ke D1 & R2
    const form = new FormData();
    form.append('file', createDummyImage('komisi_member1.jpg'));
    const uploadRes = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: form
      }),
      ctx.env
    );
    expect(uploadRes.status).toBe(200);
    const uploadData = (await uploadRes.json()) as any;
    const proofId = uploadData.proof.id;

    // Verifikasi bukti ada di D1 dan R2
    const proofInDb = await ctx.db
      .prepare('SELECT id, r2_key FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .first<{ id: string; r2_key: string }>();
    expect(proofInDb).not.toBeNull();
    const proofR2Key = proofInDb!.r2_key;

    const r2BeforeDelete = await ctx.env.VIDEOS_BUCKET!.get(proofR2Key);
    expect(r2BeforeDelete).not.toBeNull();

    // 2. Admin menghapus Member melalui handleDeleteMember
    const deleteRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${member.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ confirm_username: member.username })
      }),
      ctx.env
    );
    expect(deleteRes.status).toBe(200);

    // 3. Akun dan metadata bukti komisi terhapus di D1
    const userInDb = await ctx.db
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(member.id)
      .first();
    expect(userInDb).toBeNull();

    const proofAfterDelete = await ctx.db
      .prepare('SELECT id FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .first();
    expect(proofAfterDelete).toBeNull();

    // 4. Objek bukti komisi ikut terhapus dari R2
    const r2AfterDelete = await ctx.env.VIDEOS_BUCKET!.get(proofR2Key);
    expect(r2AfterDelete).toBeNull();

    // 5. Video katalog dan objek R2 lain tetap utuh
    const catalogVideoCheck = await ctx.env.VIDEOS_BUCKET!.get(catalogVideoKey);
    expect(catalogVideoCheck).not.toBeNull();

    // 10. Akses ke bukti komisi yang sudah dihapus mengembalikan 404 / ditolak
    const viewFileRes = await worker.fetch(
      new Request(`http://localhost/api/commission-proofs/${proofId}/file`, {
        headers: { Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}` }
      }),
      ctx.env
    );
    expect(viewFileRes.status).toBe(404);
  });

  it('6: handleDeleteAccount oleh Super Admin membersihkan bukti komisi milik Member dari D1 & R2', async () => {
    const superAdmin = await seedTestSuperAdmin(ctx.db, 'del_super_6');
    const admin = await seedTestAdmin(ctx.db, 'del_admin_6');
    const member = await seedTestUser(ctx.db, admin.id, 'del_member_6');

    // Member upload bukti komisi
    const form = new FormData();
    form.append('file', createDummyImage('komisi_member6.png', 'image/png'));
    const uploadRes = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: form
      }),
      ctx.env
    );
    expect(uploadRes.status).toBe(200);

    const proofInDb = await ctx.db
      .prepare('SELECT id, r2_key FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .first<{ id: string; r2_key: string }>();
    expect(proofInDb).not.toBeNull();
    const proofR2Key = proofInDb!.r2_key;

    // Super Admin menghapus akun Member via /api/super-admin/users/:id
    const deleteRes = await worker.fetch(
      new Request(`http://localhost/api/super-admin/users/${member.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ confirm_username: member.username })
      }),
      ctx.env
    );
    expect(deleteRes.status).toBe(200);

    // Verifikasi D1 dan R2 bersih
    const userInDb = await ctx.db.prepare('SELECT id FROM users WHERE id = ?').bind(member.id).first();
    expect(userInDb).toBeNull();

    const proofInDbAfter = await ctx.db.prepare('SELECT id FROM commission_proofs WHERE user_id = ?').bind(member.id).first();
    expect(proofInDbAfter).toBeNull();

    const r2After = await ctx.env.VIDEOS_BUCKET!.get(proofR2Key);
    expect(r2After).toBeNull();
  });

  it('7: Penghapusan akun Member atau Admin tanpa bukti komisi tetap sukses', async () => {
    const superAdmin = await seedTestSuperAdmin(ctx.db, 'del_super_7');
    const admin = await seedTestAdmin(ctx.db, 'del_admin_7');
    const memberNoProof = await seedTestUser(ctx.db, admin.id, 'del_member_no_proof');

    // Admin menghapus Member yang tidak punya bukti komisi
    const delMemberRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberNoProof.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ confirm_username: memberNoProof.username })
      }),
      ctx.env
    );
    expect(delMemberRes.status).toBe(200);

    // Super Admin menghapus akun Admin yang juga tidak punya bukti komisi
    const delAdminRes = await worker.fetch(
      new Request(`http://localhost/api/super-admin/users/${admin.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ confirm_username: admin.username })
      }),
      ctx.env
    );
    expect(delAdminRes.status).toBe(200);
  });

  it('8: Jika penghapusan D1 gagal, objek bukti komisi di R2 TIDAK dihapus terlebih dahulu', async () => {
    const admin = await seedTestAdmin(ctx.db, 'del_admin_8');
    const member = await seedTestUser(ctx.db, admin.id, 'del_member_8');

    // Upload bukti komisi
    const form = new FormData();
    form.append('file', createDummyImage('komisi_member8.jpg'));
    await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: form
      }),
      ctx.env
    );

    const proofInDb = await ctx.db
      .prepare('SELECT r2_key FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .first<{ r2_key: string }>();
    const proofR2Key = proofInDb!.r2_key;

    // Spy pada R2 delete untuk memastikan tidak dipanggil jika D1 batch gagal
    const deleteSpy = vi.fn();
    const mockEnvDbFail = {
      ...ctx.env,
      DB: {
        ...ctx.db,
        prepare: ctx.db.prepare.bind(ctx.db),
        batch: vi.fn().mockRejectedValue(new Error('Database Constraint Error on Delete'))
      },
      VIDEOS_BUCKET: {
        ...ctx.env.VIDEOS_BUCKET!,
        put: ctx.env.VIDEOS_BUCKET!.put.bind(ctx.env.VIDEOS_BUCKET!),
        get: ctx.env.VIDEOS_BUCKET!.get.bind(ctx.env.VIDEOS_BUCKET!),
        delete: deleteSpy
      }
    };

    const failDeleteRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${member.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ confirm_username: member.username })
      }),
      mockEnvDbFail as any
    );
    expect(failDeleteRes.status).toBe(500);

    // R2 delete TIDAK PERNAH dipanggil karena D1 gagal terlebih dahulu
    expect(deleteSpy).not.toHaveBeenCalled();

    // Berkas fisik di R2 tetap ada dan aman
    const r2Check = await ctx.env.VIDEOS_BUCKET!.get(proofR2Key);
    expect(r2Check).not.toBeNull();
  });

  it('9: Jika penghapusan R2 gagal setelah D1 berhasil, penghapusan akun tetap sukses dan kegagalan R2 ditangani', async () => {
    const admin = await seedTestAdmin(ctx.db, 'del_admin_9');
    const member = await seedTestUser(ctx.db, admin.id, 'del_member_9');

    // Upload bukti komisi
    const form = new FormData();
    form.append('file', createDummyImage('komisi_member9.webp', 'image/webp'));
    await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: form
      }),
      ctx.env
    );

    // Mock R2 delete agar throw error saat mencoba menghapus objek bukti komisi
    const mockEnvR2DeleteFail = {
      ...ctx.env,
      VIDEOS_BUCKET: {
        ...ctx.env.VIDEOS_BUCKET!,
        put: ctx.env.VIDEOS_BUCKET!.put.bind(ctx.env.VIDEOS_BUCKET!),
        get: ctx.env.VIDEOS_BUCKET!.get.bind(ctx.env.VIDEOS_BUCKET!),
        delete: vi.fn().mockRejectedValue(new Error('Simulated R2 Network Failure'))
      }
    };

    // Spy on console.error to verify the failure is logged
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const deleteRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${member.id}`, {
        method: 'DELETE',
        headers: {
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ confirm_username: member.username })
      }),
      mockEnvR2DeleteFail
    );

    // Handler mengembalikan 200 karena transaksi D1 sudah berhasil menghapus akun
    expect(deleteRes.status).toBe(200);

    // Console.error mencatat kegagalan R2
    expect(consoleErrorSpy).toHaveBeenCalled();
    const logCall = consoleErrorSpy.mock.calls.find((call) =>
      call[0]?.includes('[DELETE_MEMBER]')
    );
    expect(logCall).toBeDefined();

    consoleErrorSpy.mockRestore();

    // Verifikasi D1 akun member benar-benar telah terhapus
    const userInDb = await ctx.db.prepare('SELECT id FROM users WHERE id = ?').bind(member.id).first();
    expect(userInDb).toBeNull();
  });
});
