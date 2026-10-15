/**
 * tests/e2e.test.ts
 * ============================================================================
 * Pengujian Integrasi End-to-End (E2E) Siklus Hidup Lengkap:
 * Gudang Video Shopee Affiliate
 *
 * Menguji seluruh 12 alur kerja nyata:
 * 1. Admin menerbitkan kode aktivasi sekali pakai.
 * 2. Pengguna baru mengaktifkan akun dan mengikat Perangkat A.
 * 3. Pencegahan replay attack pada kode aktivasi yang sudah digunakan.
 * 4. Pengguna berhasil login dari Perangkat A yang terikat.
 * 5. Percobaan login dari Perangkat B ditolak (Single-Device Enforcement).
 * 6. Admin menerbitkan kode reset perangkat.
 * 7. Perangkat B mengklaim kode reset, mengikat perangkat baru, dan membatalkan Perangkat A.
 * 8. Admin mengunggah video ke Cloudflare R2 privat.
 * 9. Pengguna terautentikasi melihat katalog dan mengunduh video.
 * 10. Admin menonaktifkan video, verifikasi akses pengguna ditutup (404).
 * 11. Pengguna reguler ditolak dari seluruh endpoint admin (RBAC 403 FORBIDDEN).
 * 12. Admin menghapus video (konsistensi R2 + D1) dan pengguna logout (sesi dicabut).
 * ============================================================================
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import { createIsolatedTestDb, seedTestSuperAdmin, TestContext } from './setup-test-db';
import { DEVICE_COOKIE_NAME, SESSION_COOKIE_NAME } from '../worker/cookies';

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

describe('End-to-End (E2E) Lifecycle Testing - Gudang Video Shopee Affiliate', () => {
  let ctx: TestContext;
  let adminSessionCookie: string;
  const BASE_URL = 'http://localhost:8787';
  const ORIGIN = 'http://localhost:8787';

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
    const admin = await seedTestSuperAdmin(ctx.db, 'super_admin', 'AdminPassword123!');
    adminSessionCookie = admin.sessionCookie;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('menjalankan 12 siklus hidup lengkap akun, perangkat, keamanan, dan media R2', async () => {
    // --------------------------------------------------------------------------
    // ALUR 1: Admin membuat kode aktivasi sekali pakai
    // --------------------------------------------------------------------------
    const createCodeRes = await worker.fetch(
      new Request(`${BASE_URL}/api/admin/activation-codes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: adminSessionCookie
        },
        body: JSON.stringify({
          note: 'Undangan Member Affiliate E2E',
          expires_in_days: 7
        })
      }),
      ctx.env
    );

    expect(createCodeRes.status).toBe(201);
    const codeJson = (await createCodeRes.json()) as any;
    expect(codeJson.status).toBe('ok');
    expect(codeJson.data.code).toMatch(/^GVS(-[2-7A-Z]{5}){4}-[2-7A-Z]{6}$/);
    const activationCode = codeJson.data.code;

    // --------------------------------------------------------------------------
    // ALUR 2: Pengguna baru mengaktifkan akun di Perangkat A
    // --------------------------------------------------------------------------
    const activateRes = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'User-Agent': 'DeviceA-Browser/1.0'
        },
        body: JSON.stringify({
          activation_code: activationCode,
          username: 'affiliate_top_creator',
          password: 'CreatorPassword123!',
          shopee_link: 'https://shope.ee/top_creator',
          device_name: 'Chrome Windows Workstation'
        })
      }),
      ctx.env
    );

    expect(activateRes.status).toBe(200);
    const activateCookies = extractResponseCookies(activateRes);
    expect(activateCookies[DEVICE_COOKIE_NAME]).toBeDefined();
    expect(activateCookies[SESSION_COOKIE_NAME]).toBeDefined();

    const deviceAToken = activateCookies[DEVICE_COOKIE_NAME];
    let sessionAToken = activateCookies[SESSION_COOKIE_NAME];

    const activateJson = (await activateRes.json()) as any;
    expect(activateJson.user.username).toBe('affiliate_top_creator');
    expect(activateJson.user.role).toBe('member');

    // Verifikasi sesi aktif Perangkat A dan ambil User ID
    const meRes = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/me`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionAToken}`
        }
      }),
      ctx.env
    );
    expect(meRes.status).toBe(200);
    const meJson = (await meRes.json()) as any;
    const memberUserId = meJson.user.id;
    expect(memberUserId).toBeDefined();

    // --------------------------------------------------------------------------
    // ALUR 3: Replay attack ditolak saat mencoba aktivasi ulang dengan kode yang sama
    // --------------------------------------------------------------------------
    const replayRes = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN
        },
        body: JSON.stringify({
          activation_code: activationCode,
          username: 'impostor_creator',
          password: 'HackerPassword123!',
          shopee_link: 'https://shope.ee/impostor'
        })
      }),
      ctx.env
    );

    expect(replayRes.status).toBe(400);
    const replayJson = (await replayRes.json()) as any;
    expect(replayJson.error).toBe('INVALID_ACTIVATION_CODE');

    // --------------------------------------------------------------------------
    // ALUR 4: Pengguna berhasil login dari Perangkat A yang terikat
    // --------------------------------------------------------------------------
    const loginDeviceARes = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: `${DEVICE_COOKIE_NAME}=${deviceAToken}`
        },
        body: JSON.stringify({
          username: 'affiliate_top_creator',
          password: 'CreatorPassword123!'
        })
      }),
      ctx.env
    );

    expect(loginDeviceARes.status).toBe(200);
    const loginCookies = extractResponseCookies(loginDeviceARes);
    expect(loginCookies[SESSION_COOKIE_NAME]).toBeDefined();
    sessionAToken = loginCookies[SESSION_COOKIE_NAME]; // Sesi baru

    // --------------------------------------------------------------------------
    // ALUR 5: Percobaan login dari Perangkat B ditolak (Single-Device Enforcement)
    // --------------------------------------------------------------------------
    // 5a. Perangkat B tanpa cookie perangkat
    const loginNoDeviceRes = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN
        },
        body: JSON.stringify({
          username: 'affiliate_top_creator',
          password: 'CreatorPassword123!'
        })
      }),
      ctx.env
    );
    expect(loginNoDeviceRes.status).toBe(403);
    const noDeviceJson = (await loginNoDeviceRes.json()) as any;
    expect(noDeviceJson.error).toBe('DEVICE_NOT_AUTHORIZED');

    // 5b. Perangkat B dengan token cookie palsu
    const loginFakeDeviceRes = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: `${DEVICE_COOKIE_NAME}=unauthorized_device_token_xyz`
        },
        body: JSON.stringify({
          username: 'affiliate_top_creator',
          password: 'CreatorPassword123!'
        })
      }),
      ctx.env
    );
    expect(loginFakeDeviceRes.status).toBe(403);

    // --------------------------------------------------------------------------
    // ALUR 6: Admin menerbitkan kode reset perangkat untuk member
    // --------------------------------------------------------------------------
    const createResetRes = await worker.fetch(
      new Request(`${BASE_URL}/api/admin/users/${memberUserId}/reset-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: adminSessionCookie
        },
        body: JSON.stringify({
          reason: 'Pemulihan perangkat member ganti ponsel'
        })
      }),
      ctx.env
    );

    expect(createResetRes.status).toBe(201);
    const resetJson = (await createResetRes.json()) as any;
    expect(resetJson.status).toBe('ok');
    expect(resetJson.data.reset_code).toMatch(/^RST(-[2-7A-Z]{5}){4}-[2-7A-Z]{6}$/);
    const resetCode = resetJson.data.reset_code;

    // --------------------------------------------------------------------------
    // ALUR 7: Perangkat B mengklaim reset-code & Perangkat A dinonaktifkan
    // --------------------------------------------------------------------------
    const claimResetRes = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/reset-device`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'User-Agent': 'DeviceB-Mobile/2.0'
        },
        body: JSON.stringify({
          reset_code: resetCode,
          username: 'affiliate_top_creator',
          password: 'CreatorPassword123!',
          device_name: 'iPhone 15 Pro Mobile'
        })
      }),
      ctx.env
    );

    expect(claimResetRes.status).toBe(200);
    const deviceBCookies = extractResponseCookies(claimResetRes);
    expect(deviceBCookies[DEVICE_COOKIE_NAME]).toBeDefined();
    expect(deviceBCookies[SESSION_COOKIE_NAME]).toBeDefined();

    const deviceBToken = deviceBCookies[DEVICE_COOKIE_NAME];
    const sessionBToken = deviceBCookies[SESSION_COOKIE_NAME];
    expect(deviceBToken).toBeTruthy();

    // Verifikasi sesi lama Perangkat A langsung dibatalkan (401)
    const oldSessionCheck = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/me`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionAToken}`
        }
      }),
      ctx.env
    );
    expect(oldSessionCheck.status).toBe(401);

    // Verifikasi Perangkat A tidak bisa login lagi karena device token lama telah digantikan
    const oldDeviceLoginCheck = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: `${DEVICE_COOKIE_NAME}=${deviceAToken}`
        },
        body: JSON.stringify({
          username: 'affiliate_top_creator',
          password: 'CreatorPassword123!'
        })
      }),
      ctx.env
    );
    expect(oldDeviceLoginCheck.status).toBe(403);

    // --------------------------------------------------------------------------
    // ALUR 8: Admin mengunggah video ke Cloudflare R2 privat
    // --------------------------------------------------------------------------
    // Header container MP4 ISO BMFF: 4 bytes length + 'ftyp'
    const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    const videoFile = new File([mp4Bytes], 'tripod_shopee.mp4', { type: 'video/mp4' });

    const formData = new FormData();
    formData.append('file', videoFile);
    formData.append('title', 'Tripod Multifungsi Bluetooth Remote');
    formData.append('product_name', 'Tripod Tongsis Bluetooth 3-in-1');
    formData.append('product_url', 'https://shopee.co.id/product/998877/112233');
    formData.append('description', 'Video showcase unboxing dan setup tripod.');
    formData.append('status', 'active');

    const uploadRes = await worker.fetch(
      new Request(`${BASE_URL}/api/admin/videos`, {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          Cookie: adminSessionCookie
        },
        body: formData
      }),
      ctx.env
    );

    expect(uploadRes.status).toBe(201);
    const uploadJson = (await uploadRes.json()) as any;
    expect(uploadJson.status).toBe('ok');
    expect(uploadJson.video.id).toBeDefined();
    const videoId = uploadJson.video.id;

    // Periksa bahwa database mencatat r2_key acak yang aman
    const dbVideo = await ctx.db
      .prepare('SELECT r2_key, download_count FROM videos WHERE id = ?')
      .bind(videoId)
      .first<{ r2_key: string; download_count: number }>();
    expect(dbVideo).toBeDefined();
    expect(dbVideo!.r2_key).toMatch(/^videos\/[0-9a-f-]{36}\.mp4$/);
    expect(dbVideo!.download_count).toBe(0);

    // --------------------------------------------------------------------------
    // ALUR 9: Pengguna terautentikasi (Perangkat B) membaca katalog dan mengunduh video
    // --------------------------------------------------------------------------
    // 9a. List katalog video
    const listVideosRes = await worker.fetch(
      new Request(`${BASE_URL}/api/videos`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        }
      }),
      ctx.env
    );
    expect(listVideosRes.status).toBe(200);
    const catalogJson = (await listVideosRes.json()) as any;
    expect(catalogJson.status).toBe('ok');
    expect(Array.isArray(catalogJson.videos)).toBe(true);
    expect(catalogJson.videos.length).toBeGreaterThanOrEqual(1);
    const foundVideo = catalogJson.videos.find((v: any) => v.id === videoId);
    expect(foundVideo).toBeDefined();
    // Object key R2 mutlak tidak boleh bocor ke respons katalog klien!
    expect(foundVideo.r2_key).toBeUndefined();

    // 9b. Download & stream video
    const downloadRes = await worker.fetch(
      new Request(`${BASE_URL}/api/videos/${videoId}/download`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        }
      }),
      ctx.env
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('Content-Type')).toBe('video/mp4');
    expect(downloadRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(downloadRes.headers.get('Cache-Control')).toContain('private');
    expect(downloadRes.headers.get('Content-Disposition')).toContain('attachment');
    const downloadedBuffer = await downloadRes.arrayBuffer();
    expect(new Uint8Array(downloadedBuffer)).toEqual(mp4Bytes);

    // Verifikasi penambahan download_count di database
    const updatedDbVideo = await ctx.db
      .prepare('SELECT download_count FROM videos WHERE id = ?')
      .bind(videoId)
      .first<{ download_count: number }>();
    expect(updatedDbVideo!.download_count).toBe(1);

    // --------------------------------------------------------------------------
    // ALUR 10: Admin menonaktifkan video -> Member ditolak (404 VIDEO_NOT_FOUND)
    // --------------------------------------------------------------------------
    const deactivateRes = await worker.fetch(
      new Request(`${BASE_URL}/api/admin/videos/${videoId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: adminSessionCookie
        },
        body: JSON.stringify({
          status: 'inactive'
        })
      }),
      ctx.env
    );
    expect(deactivateRes.status).toBe(200);

    // Pengguna membaca katalog: video nonaktif tidak muncul
    const listAfterDeactivateRes = await worker.fetch(
      new Request(`${BASE_URL}/api/videos`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        }
      }),
      ctx.env
    );
    const catalogAfterJson = (await listAfterDeactivateRes.json()) as any;
    const inactiveFound = catalogAfterJson.videos.find((v: any) => v.id === videoId);
    expect(inactiveFound).toBeUndefined();

    // Pengguna mencoba unduh langsung via ID: ditolak 404
    const downloadInactiveRes = await worker.fetch(
      new Request(`${BASE_URL}/api/videos/${videoId}/download`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        }
      }),
      ctx.env
    );
    expect(downloadInactiveRes.status).toBe(404);

    // --------------------------------------------------------------------------
    // ALUR 11: Pengguna biasa diblokir dari seluruh endpoint admin (RBAC)
    // --------------------------------------------------------------------------
    const memberAccessAdminRes1 = await worker.fetch(
      new Request(`${BASE_URL}/api/admin/users`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        }
      }),
      ctx.env
    );
    expect(memberAccessAdminRes1.status).toBe(403);

    const memberAccessAdminRes2 = await worker.fetch(
      new Request(`${BASE_URL}/api/admin/activation-codes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        },
        body: JSON.stringify({ note: 'Unauthorized' })
      }),
      ctx.env
    );
    expect(memberAccessAdminRes2.status).toBe(403);

    const memberAccessAdminRes3 = await worker.fetch(
      new Request(`${BASE_URL}/api/admin/videos/${videoId}`, {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        }
      }),
      ctx.env
    );
    expect(memberAccessAdminRes3.status).toBe(403);

    // --------------------------------------------------------------------------
    // ALUR 12: Admin menghapus video (konsistensi R2 + D1) dan Pengguna Logout
    // --------------------------------------------------------------------------
    // 12a. Admin menghapus video
    const deleteRes = await worker.fetch(
      new Request(`${BASE_URL}/api/admin/videos/${videoId}`, {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          Cookie: adminSessionCookie
        }
      }),
      ctx.env
    );
    expect(deleteRes.status).toBe(200);

    // Verifikasi metadata terhapus dari D1
    const checkDbDeleted = await ctx.db
      .prepare('SELECT id FROM videos WHERE id = ?')
      .bind(videoId)
      .first();
    expect(checkDbDeleted).toBeNull();

    // Verifikasi berkas biner terhapus dari R2
    const checkR2Deleted = await ctx.env.VIDEOS_BUCKET!.get(dbVideo!.r2_key);
    expect(checkR2Deleted).toBeNull();

    // 12b. Pengguna logout
    const logoutRes = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        }
      }),
      ctx.env
    );
    expect(logoutRes.status).toBe(200);

    // Verifikasi sesi Perangkat B sudah dibatalkan dan tidak bisa lagi mengakses endpoint
    const afterLogoutCheck = await worker.fetch(
      new Request(`${BASE_URL}/api/auth/me`, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${sessionBToken}`
        }
      }),
      ctx.env
    );
    expect(afterLogoutCheck.status).toBe(401);
  });
});
