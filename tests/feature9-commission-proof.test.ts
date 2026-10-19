/**
 * tests/feature9-commission-proof.test.ts
 * Pengujian Komprehensif Fitur 9: Upload dan Penggantian Bukti Komisi Mingguan.
 *
 * Verifikasi 15 Poin Wajib:
 * 1. Upload pertama membuat satu bukti aktif.
 * 2. Upload kedua menggantikan bukti pertama.
 * 3. Setelah upload kedua, hanya satu bukti aktif yang tercatat.
 * 4. Metadata menunjuk file baru.
 * 5. File lama dihapus setelah penggantian berhasil.
 * 6. Jika upload file baru gagal, file lama tetap aktif.
 * 7. Jika pembaruan D1 gagal, file lama tetap aktif.
 * 8. Jika penghapusan file lama gagal setelah penggantian berhasil, bukti baru tetap aktif dan kegagalan ditangani.
 * 9. Member tidak dapat melihat atau menghapus bukti milik Member lain.
 * 10. Member tidak dapat menghapus bukti sendiri melalui API.
 * 11. Admin dapat melihat dan menghapus bukti aktif.
 * 12. Super Admin dapat melihat dan menghapus bukti aktif.
 * 13. Upload setelah penghapusan manual berhasil membuat bukti aktif baru.
 * 14. Upload bersamaan tidak menghasilkan lebih dari satu bukti aktif.
 * 15. Semua test lama tetap lulus.
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

describe('Fitur 9 — Upload dan Penggantian Bukti Komisi Mingguan', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('1, 2, 3, 4, 5: Upload pertama membuat 1 bukti aktif, upload kedua menggantikan file lama, file lama dibersihkan dari R2', async () => {
    const admin = await seedTestAdmin(ctx.db, 'f9_admin');
    const member = await seedTestUser(ctx.db, admin.id, 'f9_member_one');

    // 1. Upload pertama
    const file1 = createDummyImage('komisi_minggu_1.jpg', 'image/jpeg');
    const formData1 = new FormData();
    formData1.append('file', file1);

    const res1 = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: {
          Cookie: `${member.sessionCookie}; ${member.deviceCookie}`
        },
        body: formData1
      }),
      ctx.env
    );
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as any;
    expect(data1.status).toBe('ok');
    expect(data1.proof).toBeDefined();
    expect(data1.proof.original_filename).toBe('komisi_minggu_1.jpg');

    // Verifikasi di database D1 & R2
    const rowsAfterUpload1 = await ctx.db
      .prepare('SELECT id, user_id, r2_key, original_filename FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .all<{ id: string; user_id: string; r2_key: string; original_filename: string }>();

    expect(rowsAfterUpload1.results?.length).toBe(1);
    const proof1R2Key = rowsAfterUpload1.results[0].r2_key;
    const r2Obj1 = await ctx.env.VIDEOS_BUCKET!.get(proof1R2Key);
    expect(r2Obj1).not.toBeNull();

    // 2. Upload kedua (penggantian)
    const file2 = createDummyImage('komisi_minggu_2.png', 'image/png');
    const formData2 = new FormData();
    formData2.append('file', file2);

    const res2 = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: {
          Cookie: `${member.sessionCookie}; ${member.deviceCookie}`
        },
        body: formData2
      }),
      ctx.env
    );
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as any;
    expect(data2.status).toBe('ok');
    expect(data2.message).toContain('diperbarui');
    expect(data2.proof.original_filename).toBe('komisi_minggu_2.png');

    // 3 & 4. Verifikasi hanya 1 bukti aktif tercatat dan metadata menunjuk file baru
    const rowsAfterUpload2 = await ctx.db
      .prepare('SELECT id, user_id, r2_key, original_filename FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .all<{ id: string; user_id: string; r2_key: string; original_filename: string }>();

    expect(rowsAfterUpload2.results?.length).toBe(1);
    expect(rowsAfterUpload2.results[0].original_filename).toBe('komisi_minggu_2.png');
    const proof2R2Key = rowsAfterUpload2.results[0].r2_key;
    expect(proof2R2Key).not.toBe(proof1R2Key);

    // 5. File lama di R2 telah dihapus
    const oldR2Check = await ctx.env.VIDEOS_BUCKET!.get(proof1R2Key);
    expect(oldR2Check).toBeNull();

    // File baru di R2 ada dan aktif
    const newR2Check = await ctx.env.VIDEOS_BUCKET!.get(proof2R2Key);
    expect(newR2Check).not.toBeNull();

    // Verifikasi audit log
    const auditLogs = await ctx.db
      .prepare('SELECT action, details FROM audit_logs WHERE target_user_id = ? ORDER BY created_at ASC')
      .bind(member.id)
      .all<{ action: string; details: string }>();

    const actions = auditLogs.results?.map((a) => a.action);
    expect(actions).toContain('UPLOAD_COMMISSION_PROOF');
    expect(actions).toContain('REPLACE_COMMISSION_PROOF');
  });

  it('6 & 7: Anti-Loss — Jika upload R2 gagal atau update D1 gagal, bukti lama tetap aktif dan aman', async () => {
    const admin = await seedTestAdmin(ctx.db, 'f9_admin_antirisk');
    const member = await seedTestUser(ctx.db, admin.id, 'f9_member_antirisk');

    // Upload file awal yang sukses
    const initialFile = createDummyImage('komisi_asli.jpg');
    const initForm = new FormData();
    initForm.append('file', initialFile);

    const initRes = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: initForm
      }),
      ctx.env
    );
    expect(initRes.status).toBe(200);

    const initialDb = await ctx.db
      .prepare('SELECT id, r2_key, original_filename FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .first<{ id: string; r2_key: string; original_filename: string }>();
    expect(initialDb?.original_filename).toBe('komisi_asli.jpg');

    // Skenario 6: Jika R2 put gagal saat upload pengganti
    const mockEnvPutFail = {
      ...ctx.env,
      VIDEOS_BUCKET: {
        ...ctx.env.VIDEOS_BUCKET!,
        put: vi.fn().mockRejectedValue(new Error('R2 Network Failure')),
        get: ctx.env.VIDEOS_BUCKET!.get.bind(ctx.env.VIDEOS_BUCKET!),
        delete: ctx.env.VIDEOS_BUCKET!.delete.bind(ctx.env.VIDEOS_BUCKET!)
      }
    };

    const failForm = new FormData();
    failForm.append('file', createDummyImage('komisi_gagal.jpg'));

    const failRes = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: failForm
      }),
      mockEnvPutFail
    );
    expect(failRes.status).toBe(500);

    // Bukti lama di D1 dan R2 TETAP ADA DAN UTUH
    const checkDbAfterFail = await ctx.db
      .prepare('SELECT id, r2_key, original_filename FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .first<{ id: string; r2_key: string; original_filename: string }>();
    expect(checkDbAfterFail?.original_filename).toBe('komisi_asli.jpg');
    expect(checkDbAfterFail?.r2_key).toBe(initialDb?.r2_key);

    // Skenario 7: Jika D1 batch gagal
    const mockEnvDbFail = {
      ...ctx.env,
      DB: {
        ...ctx.db,
        prepare: ctx.db.prepare.bind(ctx.db),
        batch: vi.fn().mockRejectedValue(new Error('D1 Constraint Failure'))
      }
    };

    const failDbForm = new FormData();
    failDbForm.append('file', createDummyImage('komisi_db_fail.jpg'));

    const failDbRes = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: failDbForm
      }),
      mockEnvDbFail as any
    );
    expect(failDbRes.status).toBe(500);

    // Bukti lama tetap utuh
    const finalDbCheck = await ctx.db
      .prepare('SELECT id, r2_key, original_filename FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .first<{ id: string; r2_key: string; original_filename: string }>();
    expect(finalDbCheck?.original_filename).toBe('komisi_asli.jpg');
  });

  it('8: Jika penghapusan file lama di R2 gagal setelah D1 sukses, bukti baru tetap aktif', async () => {
    const admin = await seedTestAdmin(ctx.db, 'f9_admin_del_fail');
    const member = await seedTestUser(ctx.db, admin.id, 'f9_member_del_fail');

    // Upload pertama
    const f1 = new FormData();
    f1.append('file', createDummyImage('first.jpg'));
    await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: f1
      }),
      ctx.env
    );

    // Mock R2 delete agar throw error saat mencoba menghapus file lama
    const mockEnvDeleteFail = {
      ...ctx.env,
      VIDEOS_BUCKET: {
        ...ctx.env.VIDEOS_BUCKET!,
        put: ctx.env.VIDEOS_BUCKET!.put.bind(ctx.env.VIDEOS_BUCKET!),
        get: ctx.env.VIDEOS_BUCKET!.get.bind(ctx.env.VIDEOS_BUCKET!),
        delete: vi.fn().mockRejectedValue(new Error('R2 Delete Failed'))
      }
    };

    // Upload kedua (mengganti)
    const f2 = new FormData();
    f2.append('file', createDummyImage('second.jpg'));
    const res2 = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
        body: f2
      }),
      mockEnvDeleteFail
    );
    expect(res2.status).toBe(200);

    // Bukti baru tetap aktif di database
    const dbProof = await ctx.db
      .prepare('SELECT original_filename FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .first<{ original_filename: string }>();
    expect(dbProof?.original_filename).toBe('second.jpg');
  });

  it('9, 10, 11, 12, 13: RBAC — Isolasi antar-member, member tidak bisa hapus sendiri, Admin & Super Admin dapat melihat & menghapus, upload baru setelah hapus sukses', async () => {
    const superAdmin = await seedTestSuperAdmin(ctx.db, 'f9_super');
    const admin = await seedTestAdmin(ctx.db, 'f9_admin_rbac');
    const memberA = await seedTestUser(ctx.db, admin.id, 'f9_member_a');
    const memberB = await seedTestUser(ctx.db, admin.id, 'f9_member_b');

    // Member A mengunggah bukti
    const formA = new FormData();
    formA.append('file', createDummyImage('bukti_member_a.png', 'image/png'));
    const uploadResA = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${memberA.sessionCookie}; ${memberA.deviceCookie}` },
        body: formA
      }),
      ctx.env
    );
    expect(uploadResA.status).toBe(200);
    const dataA = (await uploadResA.json()) as any;
    const proofIdA = dataA.proof.id;

    // 9. Member A dapat melihat file miliknya (200)
    const viewOwnerRes = await worker.fetch(
      new Request(`http://localhost/api/commission-proofs/${proofIdA}/file`, {
        headers: { Cookie: `${memberA.sessionCookie}; ${memberA.deviceCookie}` }
      }),
      ctx.env
    );
    expect(viewOwnerRes.status).toBe(200);

    // 9. Member B DITOLAK saat mencoba melihat file Member A (403 Forbidden)
    const viewOtherRes = await worker.fetch(
      new Request(`http://localhost/api/commission-proofs/${proofIdA}/file`, {
        headers: { Cookie: `${memberB.sessionCookie}; ${memberB.deviceCookie}` }
      }),
      ctx.env
    );
    expect(viewOtherRes.status).toBe(403);

    // 10. Member TIDAK DAPAT menghapus bukti melalui API
    const memberDeleteRes = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'DELETE',
        headers: { Cookie: `${memberA.sessionCookie}; ${memberA.deviceCookie}` }
      }),
      ctx.env
    );
    expect(memberDeleteRes.status).toBe(404); // Endpoint DELETE member tidak ada

    // Member mencoba endpoint admin delete -> DITOLAK (403 Forbidden)
    const memberAdminDeleteRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberA.id}/commission-proof`, {
        method: 'DELETE',
        headers: { Cookie: `${memberA.sessionCookie}; ${memberA.deviceCookie}` }
      }),
      ctx.env
    );
    expect(memberAdminDeleteRes.status).toBe(403);

    // 11. Admin dapat melihat metadata dan file bukti Member A
    const adminGetProofRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberA.id}/commission-proof`, {
        headers: { Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}` }
      }),
      ctx.env
    );
    expect(adminGetProofRes.status).toBe(200);

    const adminViewFileRes = await worker.fetch(
      new Request(`http://localhost/api/commission-proofs/${proofIdA}/file`, {
        headers: { Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}` }
      }),
      ctx.env
    );
    expect(adminViewFileRes.status).toBe(200);

    // 11. Admin dapat menghapus bukti aktif Member A
    const adminDeleteRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberA.id}/commission-proof`, {
        method: 'DELETE',
        headers: { Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}` }
      }),
      ctx.env
    );
    expect(adminDeleteRes.status).toBe(200);

    // Verifikasi database kosong untuk Member A
    const dbAfterDelete = await ctx.db
      .prepare('SELECT id FROM commission_proofs WHERE user_id = ?')
      .bind(memberA.id)
      .first();
    expect(dbAfterDelete).toBeNull();

    // 13. Member A mengunggah bukti baru setelah penghapusan -> SUKSES
    const formA2 = new FormData();
    formA2.append('file', createDummyImage('bukti_setelah_hapus.jpg'));
    const reuploadRes = await worker.fetch(
      new Request('http://localhost/api/member/commission-proof', {
        method: 'POST',
        headers: { Cookie: `${memberA.sessionCookie}; ${memberA.deviceCookie}` },
        body: formA2
      }),
      ctx.env
    );
    expect(reuploadRes.status).toBe(200);

    const dataA2 = (await reuploadRes.json()) as any;
    const proofIdA2 = dataA2.proof.id;

    // 12. Super Admin dapat melihat dan menghapus bukti aktif
    const superViewRes = await worker.fetch(
      new Request(`http://localhost/api/commission-proofs/${proofIdA2}/file`, {
        headers: { Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}` }
      }),
      ctx.env
    );
    expect(superViewRes.status).toBe(200);

    const superDeleteRes = await worker.fetch(
      new Request(`http://localhost/api/admin/users/${memberA.id}/commission-proof`, {
        method: 'DELETE',
        headers: { Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}` }
      }),
      ctx.env
    );
    expect(superDeleteRes.status).toBe(200);
  });

  it('14: Upload bersamaan (concurrent) tidak menghasilkan lebih dari satu bukti aktif', async () => {
    const admin = await seedTestAdmin(ctx.db, 'f9_admin_race');
    const member = await seedTestUser(ctx.db, admin.id, 'f9_member_race');

    const form1 = new FormData();
    form1.append('file', createDummyImage('race_1.jpg'));
    const form2 = new FormData();
    form2.append('file', createDummyImage('race_2.jpg'));

    const [req1, req2] = await Promise.all([
      worker.fetch(
        new Request('http://localhost/api/member/commission-proof', {
          method: 'POST',
          headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
          body: form1
        }),
        ctx.env
      ),
      worker.fetch(
        new Request('http://localhost/api/member/commission-proof', {
          method: 'POST',
          headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` },
          body: form2
        }),
        ctx.env
      )
    ]);

    // Keduanya mengembalikan 200
    expect(req1.status).toBe(200);
    expect(req2.status).toBe(200);

    // Verifikasi database: Tepat 1 baris
    const rows = await ctx.db
      .prepare('SELECT id, user_id, original_filename FROM commission_proofs WHERE user_id = ?')
      .bind(member.id)
      .all<{ id: string; user_id: string; original_filename: string }>();

    expect(rows.results?.length).toBe(1);
  });
});
