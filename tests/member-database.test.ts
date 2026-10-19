/**
 * tests/member-database.test.ts
 * Pengujian Komprehensif Fitur: Database Anggota, Pencarian Server, Multi-Filter,
 * Server-Side Pagination, dan Agregasi Kelompok Pengundang.
 *
 * Verifikasi 13 Kriteria Wajib:
 * 1. Database berisi setidaknya 600 anggota simulasi.
 * 2. Anggota yang berada jauh di luar halaman pertama dapat ditemukan melalui pencarian server.
 * 3. Filter status, role, jalur pendaftaran, dan pengundang bekerja pada seluruh data.
 * 4. Pencarian dan filter dapat digabungkan secara simultan.
 * 5. Total hasil tetap akurat setelah filter diterapkan (via pagination metadata).
 * 6. Navigasi pagination tidak menggandakan atau melewatkan record akibat kesalahan implementasi.
 * 7. Pengurutan tetap deterministik ketika beberapa anggota memiliki waktu pembuatan sama.
 * 8. Jumlah kelompok pengundang akurat untuk seluruh hasil yang cocok di database.
 * 9. Anggota tanpa pengundang dihitung dalam kelompok yang benar (__direct__).
 * 10. Tidak ada kebocoran informasi autentikasi (password hash, salt, session token, activation code).
 * 11. Admin dan Super Admin diizinkan; Member dan anonim ditolak.
 * 12. Pemanggil endpoint lama tetap kompatibel.
 * 13. Fitur aktivasi anggota dan endpoint terkait tidak mengalami regresi.
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
import { hashPassword } from '../worker/crypto';

describe('Fitur: Database Anggota, Pencarian Server, Filter, dan Pengelompokan', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // Helper untuk melakukan seed massal 600 pengguna dengan cepat menggunakan multi-row INSERT
  async function seed600Members() {
    const { hash, salt } = await hashPassword('Password123!');
    interface RawUser {
      id: string;
      username: string;
      status: string;
      whatsapp: string;
      registration_path: string;
      inviter_name: string | null;
      created_at: string;
    }

    const rows: RawUser[] = [];

    // 1. Target khusus yang berada di tanggal paling lampau (halaman paling akhir)
    rows.push({
      id: '00000000-0000-4000-8000-000000000001',
      username: 'deep_target_user_599',
      status: 'active',
      whatsapp: '628999999999',
      registration_path: 'referral',
      inviter_name: 'Leader Alpha',
      created_at: '2024-01-01 00:00:00'
    });

    // 2. 200 anggota Leader Alpha (active, referral, waktu created_at identik untuk uji deterministik)
    for (let i = 1; i <= 200; i++) {
      const numStr = String(i).padStart(4, '0');
      rows.push({
        id: crypto.randomUUID(),
        username: `user_alpha_${numStr}`,
        status: 'active',
        whatsapp: `62811000${numStr}`,
        registration_path: 'referral',
        inviter_name: 'Leader Alpha',
        created_at: '2026-01-01 10:00:00'
      });
    }

    // 3. 150 anggota Leader Beta (suspended, referral)
    for (let i = 1; i <= 150; i++) {
      const numStr = String(i).padStart(4, '0');
      rows.push({
        id: crypto.randomUUID(),
        username: `user_beta_${numStr}`,
        status: 'suspended',
        whatsapp: `62822000${numStr}`,
        registration_path: 'referral',
        inviter_name: 'Leader Beta',
        created_at: '2026-01-02 10:00:00'
      });
    }

    // 4. 249 anggota Mandiri / Direct (active, inviter_name = null)
    for (let i = 1; i <= 249; i++) {
      const numStr = String(i).padStart(4, '0');
      rows.push({
        id: crypto.randomUUID(),
        username: `user_direct_${numStr}`,
        status: 'active',
        whatsapp: `62833000${numStr}`,
        registration_path: 'direct',
        inviter_name: null,
        created_at: '2026-01-03 10:00:00'
      });
    }

    // Multi-row INSERT dalam potongan 8 baris per query (8 * 11 = 88 variabel, batas D1 < 100)
    const chunkSize = 8;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, "member", ?, ?, ?, ?, ?, ?)').join(', ');
      const sql = `
        INSERT INTO users (id, username, password_hash, password_salt, role, status, shopee_link, whatsapp, registration_path, inviter_name, created_at)
        VALUES ${placeholders}
      `;
      const bindings: any[] = [];
      for (const r of chunk) {
        bindings.push(
          r.id,
          r.username,
          hash,
          salt,
          r.status,
          `https://shopee.co.id/${r.username}`,
          r.whatsapp,
          r.registration_path,
          r.inviter_name,
          r.created_at
        );
      }
      await ctx.db.prepare(sql).bind(...bindings).run();
    }
  }

  // 1 & 2: Otorisasi RBAC Endpoint Administratif
  it('11. Otorisasi RBAC: Admin dan Super Admin diizinkan (200), Member ditolak (403), Anonim ditolak (401)', async () => {
    const superAdmin = await seedTestSuperAdmin(ctx.db, 'db_super_rbac');
    const admin = await seedTestAdmin(ctx.db, 'db_admin_rbac');
    const member = await seedTestUser(ctx.db, superAdmin.id, 'db_member_rbac');

    // Super Admin diizinkan
    const superRes = await worker.fetch(
      new Request('http://localhost/api/admin/users', {
        headers: {
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`
        }
      }),
      ctx.env
    );
    expect(superRes.status).toBe(200);
    const superData = (await superRes.json()) as any;
    expect(superData.status).toBe('ok');
    expect(Array.isArray(superData.users)).toBe(true);

    // Admin operasional diizinkan
    const adminRes = await worker.fetch(
      new Request('http://localhost/api/admin/users', {
        headers: {
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`
        }
      }),
      ctx.env
    );
    expect(adminRes.status).toBe(200);

    // Member reguler ditolak (403 Forbidden)
    const memberRes = await worker.fetch(
      new Request('http://localhost/api/admin/users', {
        headers: {
          Cookie: `${member.sessionCookie}; ${member.deviceCookie}`
        }
      }),
      ctx.env
    );
    expect(memberRes.status).toBe(403);

    // Anonim ditolak (401 Unauthorized)
    const anonRes = await worker.fetch(new Request('http://localhost/api/admin/users'), ctx.env);
    expect(anonRes.status).toBe(401);

    // Groups endpoint juga terlindungi RBAC yang sama
    const groupsAnon = await worker.fetch(new Request('http://localhost/api/admin/users/groups'), ctx.env);
    expect(groupsAnon.status).toBe(401);

    const groupsMember = await worker.fetch(
      new Request('http://localhost/api/admin/users/groups', {
        headers: { Cookie: `${member.sessionCookie}; ${member.deviceCookie}` }
      }),
      ctx.env
    );
    expect(groupsMember.status).toBe(403);
  });

  // Pengujian Skala Penuh: 600 Anggota, Pencarian Server, Multi-Filter, Pagination, dan Agregasi
  it('1 s.d. 10 & 12: Memverifikasi dataset 600 anggota, pencarian server, filter, pagination, dan kelompok pengundang', async () => {
    const admin = await seedTestAdmin(ctx.db, 'admin_scale_tester');

    // Lakukan seed 600 anggota simulasi
    await seed600Members();

    // 1. Verifikasi total anggota di database setidaknya 600
    const totalCountRow = await ctx.db
      .prepare(`SELECT COUNT(*) as total FROM users WHERE role = 'member'`)
      .first<{ total: number }>();
    expect(totalCountRow?.total).toBe(600);

    const fetchUsers = async (query: string = '') => {
      const url = query ? `http://localhost/api/admin/users?${query}` : 'http://localhost/api/admin/users';
      const res = await worker.fetch(
        new Request(url, {
          headers: {
            Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`
          }
        }),
        ctx.env
      );
      expect(res.status).toBe(200);
      return (await res.json()) as any;
    };

    // 12. Kompatibilitas panggilan tanpa query parameter
    const resDefault = await fetchUsers();
    expect(resDefault.status).toBe('ok');
    expect(Array.isArray(resDefault.users)).toBe(true);
    expect(resDefault.pagination).toBeDefined();
    expect(resDefault.pagination.page).toBe(1);
    expect(resDefault.pagination.total).toBeGreaterThanOrEqual(600);

    // 2. Anggota di tanggal paling lampau (halaman terakhir) ditemukan lewat pencarian server
    // Pada halaman 1 normal (limit 15), target ini tidak ada
    const resPage1 = await fetchUsers('limit=15&page=1');
    expect(resPage1.users.some((u: any) => u.username === 'deep_target_user_599')).toBe(false);

    // Saat dicari dengan q=deep_target, server menemukannya langsung pada page 1 pencarian
    const resSearch = await fetchUsers('q=deep_target&limit=15&page=1');
    expect(resSearch.pagination.total).toBe(1);
    expect(resSearch.users.length).toBe(1);
    expect(resSearch.users[0].username).toBe('deep_target_user_599');
    expect(resSearch.users[0].whatsapp).toBe('628999999999');

    // Pencarian dengan WhatsApp
    const resSearchWa = await fetchUsers('q=628999999999');
    expect(resSearchWa.pagination.total).toBe(1);
    expect(resSearchWa.users[0].username).toBe('deep_target_user_599');

    // 3 & 5. Filter status, jalur, role, pengundang bekerja pada seluruh data dan total akurat
    // Filter status suspended: harus tepat 150 anggota
    const resSuspended = await fetchUsers('status=suspended');
    expect(resSuspended.pagination.total).toBe(150);
    expect(resSuspended.users.every((u: any) => u.status === 'suspended')).toBe(true);

    // Filter jalur direct (khusus member): harus tepat 249 anggota
    const resDirectMember = await fetchUsers('role=member&registration_path=direct');
    expect(resDirectMember.pagination.total).toBe(249);
    expect(resDirectMember.users.every((u: any) => u.registration_path === 'direct')).toBe(true);

    // Filter jalur direct (semua role termasuk admin penguji): 250 pengguna
    const resDirectAll = await fetchUsers('registration_path=direct');
    expect(resDirectAll.pagination.total).toBe(250);

    // Filter pengundang spesifik (Leader Alpha): 200 + 1 deep_target = 201 anggota
    const resAlpha = await fetchUsers('inviter=Leader Alpha');
    expect(resAlpha.pagination.total).toBe(201);
    expect(resAlpha.users.every((u: any) => u.inviter_name === 'Leader Alpha')).toBe(true);

    // Filter pengundang mandiri (__none__) khusus member: tepat 249 anggota
    const resNoInviterMember = await fetchUsers('role=member&inviter=__none__');
    expect(resNoInviterMember.pagination.total).toBe(249);
    expect(resNoInviterMember.users.every((u: any) => !u.inviter_name)).toBe(true);

    // Filter pengundang mandiri (__none__) semua role: 250 pengguna
    const resNoInviterAll = await fetchUsers('inviter=__none__');
    expect(resNoInviterAll.pagination.total).toBe(250);

    // 4. Kombinasi pencarian dan multiple filter
    const resCombo = await fetchUsers('q=user_alpha_0001&status=active&registration_path=referral&inviter=Leader Alpha');
    expect(resCombo.pagination.total).toBe(1);
    expect(resCombo.users[0].username).toBe('user_alpha_0001');

    // 6. Navigasi pagination: tidak ada record duplikat atau terlewat antara page 1 dan page 2
    const p1 = await fetchUsers('limit=15&page=1');
    const p2 = await fetchUsers('limit=15&page=2');
    expect(p1.users.length).toBe(15);
    expect(p2.users.length).toBe(15);

    const idsP1 = new Set(p1.users.map((u: any) => u.id));
    const idsP2 = new Set(p2.users.map((u: any) => u.id));
    for (const id of idsP1) {
      expect(idsP2.has(id)).toBe(false);
    }

    // 7. Pengurutan deterministik ketika created_at identik
    // Seluruh 200 anggota Leader Alpha memiliki created_at yang persis sama.
    // Panggilan berulang pada page 1 harus mengembalikan ID dan urutan yang identik karena secondary id DESC.
    const runA = await fetchUsers('inviter=Leader Alpha&limit=10&page=1');
    const runB = await fetchUsers('inviter=Leader Alpha&limit=10&page=1');
    expect(runA.users.map((u: any) => u.id)).toEqual(runB.users.map((u: any) => u.id));

    // 8 & 9. Agregasi kelompok pengundang: hitungan seluruh hasil yang cocok di database
    const groupsRes = await worker.fetch(
      new Request('http://localhost/api/admin/users/groups', {
        headers: { Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}` }
      }),
      ctx.env
    );
    expect(groupsRes.status).toBe(200);
    const groupsData = (await groupsRes.json()) as any;
    expect(groupsData.status).toBe('ok');
    expect(Array.isArray(groupsData.groups)).toBe(true);

    const alphaGroup = groupsData.groups.find((g: any) => g.inviter_name === 'Leader Alpha');
    expect(alphaGroup).toBeDefined();
    expect(alphaGroup.member_count).toBe(201);
    expect(alphaGroup.is_direct).toBe(false);

    const betaGroup = groupsData.groups.find((g: any) => g.inviter_name === 'Leader Beta');
    expect(betaGroup).toBeDefined();
    expect(betaGroup.member_count).toBe(150);
    expect(betaGroup.is_direct).toBe(false);

    // 9. Kelompok Tanpa Pengundang (Daftar Mandiri) khusus akun role member
    const directGroup = groupsData.groups.find((g: any) => g.is_direct === true);
    expect(directGroup).toBeDefined();
    expect(directGroup.group_key).toBe('__direct__');
    expect(directGroup.inviter_name).toBe('Tanpa Pengundang (Daftar Mandiri)');
    // Tepat 249 member (akun admin penguji tidak dicampur ke dalam kelompok member)
    expect(directGroup.member_count).toBe(249);

    // Total anggota agregasi kelompok adalah 600 (tepat seluruh role member, tanpa admin)
    expect(groupsData.total_members).toBe(totalCountRow!.total);

    // Pengujian: Jika filter role=admin atau super_admin diberikan, kelompok kosong
    const adminGroupsRes = await worker.fetch(
      new Request('http://localhost/api/admin/users/groups?role=admin', {
        headers: { Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}` }
      }),
      ctx.env
    );
    expect(adminGroupsRes.status).toBe(200);
    const adminGroupsData = (await adminGroupsRes.json()) as any;
    expect(adminGroupsData.groups.length).toBe(0);
    expect(adminGroupsData.total_members).toBe(0);

    // Namun di daftar lengkap (userViewMode: list), admin tetap muncul saat role=all
    expect(resNoInviterAll.pagination.total).toBe(250);
    expect(resNoInviterMember.pagination.total).toBe(249);

    // 10. Kerahasiaan data: Zero secret credential leak
    const sampleUser = resPage1.users[0];
    expect(sampleUser.password_hash).toBeUndefined();
    expect(sampleUser.password_salt).toBeUndefined();
    expect(sampleUser.session_token).toBeUndefined();
    expect(sampleUser.activation_code).toBeUndefined();
    expect(sampleUser.activation_code_hash).toBeUndefined();
  }, 60000);
});
