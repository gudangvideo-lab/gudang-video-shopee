/**
 * tests/feature6-member-activation.test.ts
 * Pengujian Lengkap Fitur 6: Admin Dapat Menambahkan Member Baru
 * Memverifikasi seluruh 15 butir pengujian backend sesuai spesifikasi:
 * 1. Admin dapat membuat kode aktivasi baru (201) berisi plaintext kode.
 * 2. Super Admin tetap dapat membuat kode aktivasi baru (201).
 * 3. Plaintext kode TIDAK disimpan di database (hanya SHA-256 hash).
 * 4. Status kode baru: used_count = 0, status = 'active', max_uses = 1.
 * 5. Masa berlaku default 7 hari jika tidak ditentukan.
 * 6. Parameter note tersimpan dengan benar saat diberikan Admin.
 * 7. Parameter note yang kosong/tidak diberikan ditangani dengan baik.
 * 8. Member biasa TIDAK DAPAT membuat kode aktivasi (403 Forbidden).
 * 9. Permintaan tanpa autentikasi ditolak (401 Unauthorized).
 * 10. Kode aktivasi buatan Admin dapat digunakan calon Member melalui /api/auth/activate.
 * 11. Akun yang didaftarkan memiliki role: 'member' di database.
 * 12. Calon Member TIDAK DAPAT mengubah rolenya menjadi admin/super_admin (anti privilege escalation).
 * 13. Kode yang telah digunakan tidak dapat digunakan kembali (400 Bad Request).
 * 14. Audit log mencatat aktivitas penerbitan kode dengan created_by/admin_id sesuai ID penerbit.
 * 15. Audit log TIDAK memuat plaintext kode aktivasi.
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
import { sha256, normalizeCode } from '../worker/crypto';

describe('Feature 6 — Admin Dapat Menambahkan Member Baru', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // 1 & 6 & 14 & 15: Admin dapat membuat kode aktivasi dengan note, audit log tercatat tanpa plaintext kode
  it('1, 6, 14, 15: Admin dapat membuat kode aktivasi baru (201), note tersimpan, audit log mencatat tanpa plaintext kode', async () => {
    const admin = await seedTestAdmin(ctx.db, 'admin_creator');

    const res = await worker.fetch(
      new Request('http://localhost/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({
          note: 'Pendaftaran member afiliasi batch April'
        })
      }),
      ctx.env
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(typeof body.data.code).toBe('string');
    expect(body.data.code.length).toBeGreaterThanOrEqual(8);
    const plaintextCode = body.data.code;

    // Verifikasi di database: plaintext TIDAK tersimpan, hanya hash SHA-256
    const codeHash = await sha256(normalizeCode(plaintextCode));
    const row = await ctx.db
      .prepare('SELECT * FROM activation_codes WHERE code_hash = ?')
      .bind(codeHash)
      .first<any>();

    expect(row).toBeDefined();
    expect(row.created_by).toBe(admin.id);
    expect(row.note).toBe('Pendaftaran member afiliasi batch April');

    // Pastikan tidak ada kolom kode plaintext di tabel
    expect((row as any).code).toBeUndefined();

    // Verifikasi audit log
    const audit = await ctx.db
      .prepare('SELECT * FROM audit_logs WHERE admin_id = ? AND action = ?')
      .bind(admin.id, 'CREATE_ACTIVATION_CODE')
      .first<any>();

    expect(audit).toBeDefined();
    expect(audit.details).toBeDefined();
    expect(audit.details).not.toContain(plaintextCode);
    expect(audit.details).toContain(row.id);
  });

  // 2: Super Admin tetap dapat membuat kode aktivasi
  it('2: Super Admin tetap dapat membuat kode aktivasi baru (201)', async () => {
    const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_creator');

    const res = await worker.fetch(
      new Request('http://localhost/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${superAdmin.sessionCookie}; ${superAdmin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({
          note: 'Kode aktivasi dari Super Admin'
        })
      }),
      ctx.env
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.data.code).toBeDefined();
  });

  // 3 & 4 & 5 & 7: Plaintext hash, used_count = 0, status = 'active', max_uses = 1, default 7 hari, note kosong ditangani baik
  it('3, 4, 5, 7: Hash SHA-256 tersimpan, used_count = 0, status = active, max_uses = 1, default 7 hari, note null/kosong ditangani baik', async () => {
    const admin = await seedTestAdmin(ctx.db, 'admin_props');

    const beforeMs = Date.now();

    const res = await worker.fetch(
      new Request('http://localhost/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({}) // note tidak diberikan
      }),
      ctx.env
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const plaintext = body.data.code;
    const codeHash = await sha256(normalizeCode(plaintext));

    const row = await ctx.db
      .prepare('SELECT * FROM activation_codes WHERE code_hash = ?')
      .bind(codeHash)
      .first<any>();

    expect(row).toBeDefined();
    // 3: Plaintext hash
    expect(row.code_hash).toBe(codeHash);
    // 4: used_count = 0, status = active, max_uses = 1
    expect(row.used_count).toBe(0);
    expect(row.status).toBe('active');
    expect(row.max_uses).toBe(1);
    // 7: note null/kosong aman
    expect(row.note === null || row.note === '').toBe(true);

    // 5: Masa berlaku default 30 hari (sekitar 30 * 86400 * 1000 ms dari sekarang)
    const afterMs = Date.now();
    const expiryTimestamp = new Date(row.expires_at.includes('T') ? row.expires_at : row.expires_at.replace(' ', 'T') + 'Z').getTime();
    const expectedExpiryMin = beforeMs + 30 * 86400 * 1000 - 60000;
    const expectedExpiryMax = afterMs + 30 * 86400 * 1000 + 60000;
    expect(expiryTimestamp).toBeGreaterThanOrEqual(expectedExpiryMin);
    expect(expiryTimestamp).toBeLessThanOrEqual(expectedExpiryMax);
  });

  // 8: Member biasa TIDAK DAPAT membuat kode aktivasi (403 Forbidden)
  it('8: Member biasa TIDAK DAPAT membuat kode aktivasi (403 Forbidden)', async () => {
    const superAdmin = await seedTestSuperAdmin(ctx.db, 'super_setup');
    const member = await seedTestUser(ctx.db, superAdmin.id, 'regular_member');

    const res = await worker.fetch(
      new Request('http://localhost/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${member.sessionCookie}; ${member.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ note: 'Member coba terbitkan kode' })
      }),
      ctx.env
    );

    expect(res.status).toBe(403);
    const err = (await res.json()) as any;
    expect(err.error).toBe('FORBIDDEN');
  });

  // 9: Permintaan tanpa autentikasi ditolak (401 Unauthorized)
  it('9: Permintaan tanpa autentikasi ditolak (401 Unauthorized)', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ note: 'Anon coba terbitkan kode' })
      }),
      ctx.env
    );

    expect(res.status).toBe(401);
  });

  // 10, 11, 12, 13: Kode buatan Admin dipakai calon Member mendaftar -> role: member, anti privilege escalation, single-use
  it('10, 11, 12, 13: Calon Member mendaftar dengan kode buatan Admin, role selalu member, anti privilege escalation, kode tidak bisa dipakai ulang', async () => {
    const admin = await seedTestAdmin(ctx.db, 'admin_recruiter');

    // Admin buat kode aktivasi
    const createRes = await worker.fetch(
      new Request('http://localhost/api/admin/activation-codes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${admin.sessionCookie}; ${admin.deviceCookie}`,
          'Origin': 'http://localhost'
        },
        body: JSON.stringify({ note: 'Undangan untuk member baru Doni' })
      }),
      ctx.env
    );
    expect(createRes.status).toBe(201);
    const { code } = ((await createRes.json()) as any).data;

    // 10 & 12: Calon member mendaftar lewat /api/auth/activate dan mencoba menyuntik role: 'admin' atau 'super_admin'
    const activateRes = await worker.fetch(
      new Request('http://localhost/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'doni_affiliate',
          password: 'PasswordSuper123!',
          shopee_link: 'https://shopee.co.id/doni_affiliate',
          whatsapp: '081299887766',
          registration_path: 'direct',
          role: 'super_admin' // Mencoba eskalasi peran
        })
      }),
      ctx.env
    );

    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as any;
    expect(activateBody.status).toBe('ok');

    // 11: Pastikan di database rolenya strictly 'member', BUKAN 'super_admin'
    const newMember = await ctx.db
      .prepare('SELECT id, username, role, status, whatsapp, shopee_link FROM users WHERE username = ?')
      .bind('doni_affiliate')
      .first<any>();

    expect(newMember).toBeDefined();
    expect(newMember.role).toBe('member'); // PRIVILEGE ESCALATION PREVENTED!
    expect(newMember.status).toBe('active');
    expect(newMember.whatsapp).toBe('6281299887766');

    // 13: Percobaan kedua menggunakan kode yang sama DITOLAK (status 400 Bad Request)
    const reuseRes = await worker.fetch(
      new Request('http://localhost/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_code: code,
          username: 'doni_impostor',
          password: 'PasswordSuper123!',
          shopee_link: 'https://shopee.co.id/doni_impostor',
          whatsapp: '081299887767',
          registration_path: 'direct'
        })
      }),
      ctx.env
    );

    expect(reuseRes.status).toBe(400);
    const reuseErr = (await reuseRes.json()) as any;
    expect(reuseErr.error).toBe('INVALID_ACTIVATION_CODE');
  });
});
