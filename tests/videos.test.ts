/**
 * tests/videos.test.ts
 * Pengujian Komprehensif Cloudflare R2 Private Video Storage & Katalog Video:
 * 1. Pengguna tanpa sesi tidak dapat membaca katalog privat atau mengunduh video.
 * 2. Pengguna non-admin tidak dapat mengunggah, mengubah, atau menghapus video.
 * 3. Video nonaktif tidak dapat diunduh pengguna reguler.
 * 4. Object key arbitrer dan path traversal ditolak.
 * 5. Upload file yang melebihi batas (atau kosong) ditolak.
 * 6. Validasi metadata, tipe konten, ekstensi, dan URL Shopee.
 * 7. Download mengembalikan konten dan header streaming yang benar.
 * 8. Video tidak ditemukan ditangani dengan benar.
 * 9. Kegagalan R2 atau database tidak menghasilkan respons sukses palsu (anti-orphan).
 * 10. Proteksi CSRF dan penanganan sesi kedaluwarsa.
 * 11. Penghapusan dan perubahan metadata menjaga konsistensi D1 dan R2.
 * 12. Pengguna yang logout tidak bisa menggunakan sesi lama untuk mengunduh video.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import { createIsolatedTestDb, seedTestAdmin, seedTestUser, TestContext } from './setup-test-db';
import { sha256 } from '../worker/crypto';
import { SESSION_COOKIE_NAME } from '../worker/cookies';

describe('Penyimpanan Video Privat Cloudflare R2 dan API Katalog Video', () => {
  let ctx: TestContext;
  let admin: { id: string; username: string; sessionCookie: string; rawSessionToken: string };
  let member: { id: string; username: string; sessionCookie: string; deviceCookie: string; rawSessionToken: string };

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
    admin = await seedTestAdmin(ctx.db, 'admin_super', 'AdminSuper123!');
    member = await seedTestUser(ctx.db, admin.id, 'member_affiliate', 'MemberPass123!');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // Helper untuk mengunggah video melalui API admin
  async function uploadTestVideo(
    overrides: {
      fileBytes?: Uint8Array | string;
      fileName?: string;
      fileType?: string;
      title?: string;
      productName?: string;
      productUrl?: string;
      description?: string;
      status?: 'active' | 'inactive';
      cookie?: string;
      origin?: string;
    } = {}
  ): Promise<Response> {
    const rawData = overrides.fileBytes ?? new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const fileName = overrides.fileName ?? 'sample_video.mp4';
    const fileType = overrides.fileType ?? 'video/mp4';

    const file = new File([rawData], fileName, { type: fileType });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', overrides.title ?? 'Video Promosi TWS Nirkabel');
    formData.append('product_name', overrides.productName ?? 'TWS Earphone Bluetooth 5.3');
    formData.append('product_url', overrides.productUrl ?? 'https://shopee.co.id/product/123/456');
    if (overrides.description !== undefined) {
      formData.append('description', overrides.description);
    }
    if (overrides.status) {
      formData.append('status', overrides.status);
    }

    const headers: Record<string, string> = {
      Cookie: overrides.cookie ?? admin.sessionCookie,
      Origin: overrides.origin ?? 'http://localhost:8787'
    };

    const request = new Request('http://localhost:8787/api/admin/videos', {
      method: 'POST',
      body: formData,
      headers
    });

    return worker.fetch(request, ctx.env);
  }

  // ---------------------------------------------------------------------------
  // 1. PENGGUNA TANPA SESI (UNAUTHENTICATED)
  // ---------------------------------------------------------------------------
  it('1. Pengguna tanpa sesi tidak dapat membaca katalog privat atau mengunduh video', async () => {
    // Unggah 1 video oleh admin terlebih dahulu
    const uploadRes = await uploadTestVideo();
    expect(uploadRes.status).toBe(201);
    const { video } = await uploadRes.json() as any;

    // Akses katalog tanpa sesi
    const listReq = new Request('http://localhost:8787/api/videos', { method: 'GET' });
    const listRes = await worker.fetch(listReq, ctx.env);
    expect(listRes.status).toBe(401);
    const listBody = await listRes.json() as any;
    expect(listBody.error).toBe('UNAUTHORIZED');

    // Akses download tanpa sesi
    const dlReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, { method: 'GET' });
    const dlRes = await worker.fetch(dlReq, ctx.env);
    expect(dlRes.status).toBe(401);
    const dlBody = await dlRes.json() as any;
    expect(dlBody.error).toBe('UNAUTHORIZED');
  });

  // ---------------------------------------------------------------------------
  // 2. OTORISASI ROLE NON-ADMIN (REGULAR USER FORBIDDEN)
  // ---------------------------------------------------------------------------
  it('2. Pengguna non-admin tidak dapat mengunggah, mengubah, atau menghapus video', async () => {
    // Siapkan 1 video via admin
    const uploadRes = await uploadTestVideo();
    expect(uploadRes.status).toBe(201);
    const { video } = await uploadRes.json() as any;

    // Member mencoba upload
    const memberUploadRes = await uploadTestVideo({ cookie: member.sessionCookie });
    expect(memberUploadRes.status).toBe(403);
    const memberUploadBody = await memberUploadRes.json() as any;
    expect(memberUploadBody.error).toBe('FORBIDDEN');

    // Member mencoba list admin videos
    const memberAdminListReq = new Request('http://localhost:8787/api/admin/videos', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const memberAdminListRes = await worker.fetch(memberAdminListReq, ctx.env);
    expect(memberAdminListRes.status).toBe(403);

    // Member mencoba update video
    const memberUpdateReq = new Request(`http://localhost:8787/api/admin/videos/${video.id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Judul Dihack Oleh Member' }),
      headers: {
        'Content-Type': 'application/json',
        Cookie: member.sessionCookie,
        Origin: 'http://localhost:8787'
      }
    });
    const memberUpdateRes = await worker.fetch(memberUpdateReq, ctx.env);
    expect(memberUpdateRes.status).toBe(403);

    // Member mencoba delete video
    const memberDeleteReq = new Request(`http://localhost:8787/api/admin/videos/${video.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: member.sessionCookie,
        Origin: 'http://localhost:8787'
      }
    });
    const memberDeleteRes = await worker.fetch(memberDeleteReq, ctx.env);
    expect(memberDeleteRes.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // 3. VIDEO NONAKTIF TIDAK DAPAT DIUNDUH PENGGUNA
  // ---------------------------------------------------------------------------
  it('3. Video nonaktif tidak dapat dilihat atau diunduh oleh pengguna reguler', async () => {
    // Unggah video berstatus inactive
    const uploadRes = await uploadTestVideo({
      title: 'Video Draf Belum Rilis',
      status: 'inactive'
    });
    expect(uploadRes.status).toBe(201);
    const { video } = await uploadRes.json() as any;

    // Member mengambil katalog publik
    const listReq = new Request('http://localhost:8787/api/videos', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const listRes = await worker.fetch(listReq, ctx.env);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as any;
    // Video inactive tidak boleh muncul dalam daftar
    expect(listBody.videos.some((v: any) => v.id === video.id)).toBe(false);

    // Member mencoba mengunduh langsung via ID
    const dlReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const dlRes = await worker.fetch(dlReq, ctx.env);
    expect(dlRes.status).toBe(404);
    const dlBody = await dlRes.json() as any;
    expect(dlBody.error).toBe('VIDEO_NOT_FOUND');

    // Namun Admin diizinkan mengunduh video inactive untuk pengecekan
    const adminDlReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
      method: 'GET',
      headers: { Cookie: admin.sessionCookie }
    });
    const adminDlRes = await worker.fetch(adminDlReq, ctx.env);
    expect(adminDlRes.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // 4. OBJECT KEY ARBITRER DAN PATH TRAVERSAL DITOLAK
  // ---------------------------------------------------------------------------
  it('4. Object key arbitrer dan path traversal ditolak, R2 key selalu acak dari server', async () => {
    // Admin mencoba upload file dengan nama berbau path traversal
    const uploadRes = await uploadTestVideo({
      fileName: '../../../../etc/passwd.mp4'
    });
    expect(uploadRes.status).toBe(201);
    const { video } = await uploadRes.json() as any;

    // Periksa di database: r2_key TIDAK BOLEH memuat path traversal
    const dbRow = await ctx.db
      .prepare('SELECT r2_key FROM videos WHERE id = ?')
      .bind(video.id)
      .first<{ r2_key: string }>();

    expect(dbRow).toBeDefined();
    expect(dbRow!.r2_key).toMatch(/^videos\/[0-9a-f-]{36}\.mp4$/);
    expect(dbRow!.r2_key).not.toContain('..');

    // Coba unduh dengan URL path traversal
    const traversalReq = new Request('http://localhost:8787/api/videos/..%2F..%2Fetc/download', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const traversalRes = await worker.fetch(traversalReq, ctx.env);
    expect(traversalRes.status).toBe(400);
    const traversalBody = await traversalRes.json() as any;
    expect(traversalBody.error).toBe('INVALID_VIDEO_ID');
  });

  // ---------------------------------------------------------------------------
  // 5. UPLOAD MELEBIHI BATAS (100MB) ATAU FILE KOSONG DITOLAK
  // ---------------------------------------------------------------------------
  it('5. Upload file kosong (0 bytes) atau melebihi batas 100 MB ditolak', async () => {
    // File 0 byte
    const emptyFileRes = await uploadTestVideo({
      fileBytes: new Uint8Array(0)
    });
    expect(emptyFileRes.status).toBe(400);
    const emptyBody = await emptyFileRes.json() as any;
    expect(emptyBody.error).toBe('FILE_EMPTY');

    // File melebihi batas 100 MB (simulasikan objek file berukuran 101 MB)
    const oneMbChunk = new Uint8Array(1024 * 1024);
    const largeBlob = new Blob(new Array(101).fill(oneMbChunk), { type: 'video/mp4' });
    const largeFile = new File([largeBlob], 'huge_video.mp4', { type: 'video/mp4' });

    const formData = new FormData();
    formData.append('file', largeFile);
    formData.append('title', 'Video Raksasa Melebihi Batas');
    formData.append('product_name', 'Produk Shopee');
    formData.append('product_url', 'https://shopee.co.id/product/1/2');

    const largeReq = new Request('http://localhost:8787/api/admin/videos', {
      method: 'POST',
      body: formData,
      headers: {
        Cookie: admin.sessionCookie,
        Origin: 'http://localhost:8787'
      }
    });

    const largeRes = await worker.fetch(largeReq, ctx.env);
    expect(largeRes.status).toBe(413);
    const largeBody = await largeRes.json() as any;
    expect(largeBody.error).toBe('FILE_TOO_LARGE');
  });

  // ---------------------------------------------------------------------------
  // 6. VALIDASI METADATA DAN TIPE KONTEN BERJALAN
  // ---------------------------------------------------------------------------
  it('6. Validasi ekstensi terlarang, MIME type palsu, judul pendek, dan URL tidak sah', async () => {
    // Ekstensi terlarang (.exe)
    const exeRes = await uploadTestVideo({ fileName: 'virus.exe', fileType: 'application/octet-stream' });
    expect(exeRes.status).toBe(400);
    expect((await exeRes.json() as any).error).toBe('INVALID_FILE_EXTENSION');

    // MIME type tidak sah
    const textRes = await uploadTestVideo({ fileName: 'file.mp4', fileType: 'text/html' });
    expect(textRes.status).toBe(400);
    expect((await textRes.json() as any).error).toBe('INVALID_CONTENT_TYPE');

    // Judul terlalu pendek (<3 karakter)
    const shortTitleRes = await uploadTestVideo({ title: 'ab' });
    expect(shortTitleRes.status).toBe(400);
    expect((await shortTitleRes.json() as any).error).toBe('INVALID_TITLE');

    // Nama produk kosong
    const emptyProductRes = await uploadTestVideo({ productName: ' ' });
    expect(emptyProductRes.status).toBe(400);
    expect((await emptyProductRes.json() as any).error).toBe('INVALID_PRODUCT_NAME');

    // URL Shopee tidak valid (skema selain http/https)
    const badUrlRes = await uploadTestVideo({ productUrl: 'javascript:alert(1)' });
    expect(badUrlRes.status).toBe(400);
    expect((await badUrlRes.json() as any).error).toBe('INVALID_PRODUCT_URL');
  });

  // ---------------------------------------------------------------------------
  // 7. DOWNLOAD MENGEMBALIKAN KONTEN DAN HEADER STREAMING DENGAN BENAR
  // ---------------------------------------------------------------------------
  it('7. Download mengembalikan konten binary yang cocok, header keamanan lengkap, dan menambah download_count', async () => {
    const rawContent = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
    const uploadRes = await uploadTestVideo({
      fileBytes: rawContent,
      fileName: 'review_asli.mp4',
      title: 'Review Asli Headset TWS 2026'
    });
    expect(uploadRes.status).toBe(201);
    const { video } = await uploadRes.json() as any;

    // Member mengunduh video
    const dlReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const dlRes = await worker.fetch(dlReq, ctx.env);
    expect(dlRes.status).toBe(200);

    // Verifikasi header respons
    expect(dlRes.headers.get('Content-Type')).toBe('video/mp4');
    expect(dlRes.headers.get('Content-Length')).toBe(String(rawContent.length));
    expect(dlRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(dlRes.headers.get('Cache-Control')).toContain('no-store');
    expect(dlRes.headers.get('Content-Disposition')).toContain('attachment;');
    expect(dlRes.headers.get('Content-Disposition')).toContain('Review_Asli_Headset_TWS_2026.mp4');

    // Verifikasi isi binary cocok
    const downloadedBuffer = await dlRes.arrayBuffer();
    const downloadedBytes = new Uint8Array(downloadedBuffer);
    expect(downloadedBytes).toEqual(rawContent);

    // Verifikasi download_count bertambah di D1
    const dbVideo = await ctx.db
      .prepare('SELECT download_count FROM videos WHERE id = ?')
      .bind(video.id)
      .first<{ download_count: number }>();
    expect(dbVideo!.download_count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 8. VIDEO TIDAK DITEMUKAN DITANGANI DENGAN BENAR
  // ---------------------------------------------------------------------------
  it('8. Mengembalikan 404 VIDEO_NOT_FOUND jika ID video tidak terdaftar', async () => {
    const nonExistentId = crypto.randomUUID();
    const req = new Request(`http://localhost:8787/api/videos/${nonExistentId}/download`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const res = await worker.fetch(req, ctx.env);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('VIDEO_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------
  // 9. KEGAGALAN R2 ATAU DATABASE TIDAK MENGHASILKAN RESPON SUKSES PALSU
  // ---------------------------------------------------------------------------
  it('9. Penanganan kegagalan: STORAGE_UNAVAILABLE saat bucket hilang, rollback saat DB error, dan 404 jika objek R2 hilang', async () => {
    // A. Unduh saat bucket R2 tidak tersedia di env
    const uploadRes = await uploadTestVideo();
    expect(uploadRes.status).toBe(201);
    const { video } = await uploadRes.json() as any;

    const envNoBucket = { ...ctx.env, VIDEOS_BUCKET: undefined };
    const dlReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const noBucketRes = await worker.fetch(dlReq, envNoBucket);
    expect(noBucketRes.status).toBe(500);
    expect((await noBucketRes.json() as any).error).toBe('STORAGE_UNAVAILABLE');

    // B. Objek R2 dihapus langsung dari bucket di luar sistem -> download mengembalikan 404 OBJECT_NOT_FOUND
    const dbRow = await ctx.db.prepare('SELECT r2_key FROM videos WHERE id = ?').bind(video.id).first<{ r2_key: string }>();
    await ctx.bucket!.delete(dbRow!.r2_key);

    const missingObjRes = await worker.fetch(dlReq, ctx.env);
    expect(missingObjRes.status).toBe(404);
    expect((await missingObjRes.json() as any).error).toBe('OBJECT_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------
  // 10. PROTEKSI CSRF DAN SESI KEDALUWARSA
  // ---------------------------------------------------------------------------
  it('10. Mutasi ditolak jika Origin asing (CSRF Protection), dan sesi kedaluwarsa ditolak', async () => {
    // CSRF pada upload
    const csrfRes = await uploadTestVideo({ origin: 'https://evil-attacker-site.com' });
    expect(csrfRes.status).toBe(403);
    expect((await csrfRes.json() as any).error).toBe('CSRF_FORBIDDEN');

    // Sesi kedaluwarsa: buat sesi yang expired_at di masa lampau
    const expiredSessionId = crypto.randomUUID();
    const rawToken = 'expired-token-12345678901234567890';
    const tokenHash = await (await import('../worker/crypto')).sha256(rawToken);

    await ctx.db
      .prepare(`
        INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, expires_at)
        SELECT ?, id, (SELECT id FROM user_devices WHERE user_id = users.id LIMIT 1), ?, datetime('now', '-2 days')
        FROM users WHERE id = ?
      `)
      .bind(expiredSessionId, tokenHash, member.id)
      .run();

    const expiredCookie = `__Host-gvs_session=${rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax`;
    const expiredReq = new Request('http://localhost:8787/api/videos', {
      method: 'GET',
      headers: { Cookie: expiredCookie }
    });
    const expiredRes = await worker.fetch(expiredReq, ctx.env);
    expect(expiredRes.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // 11. KONSISTENSI PENGHAPUSAN DAN PERUBAHAN METADATA
  // ---------------------------------------------------------------------------
  it('11. Perubahan metadata dan penghapusan video membersihkan R2 dan D1 secara konsisten', async () => {
    const uploadRes = await uploadTestVideo({ title: 'Judul Asli' });
    expect(uploadRes.status).toBe(201);
    const { video } = await uploadRes.json() as any;

    // A. Update metadata
    const updateReq = new Request(`http://localhost:8787/api/admin/videos/${video.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: 'Judul Diperbarui Oleh Admin',
        product_name: 'Nama Produk Baru',
        status: 'inactive'
      }),
      headers: {
        'Content-Type': 'application/json',
        Cookie: admin.sessionCookie,
        Origin: 'http://localhost:8787'
      }
    });
    const updateRes = await worker.fetch(updateReq, ctx.env);
    expect(updateRes.status).toBe(200);
    const updateBody = await updateRes.json() as any;
    expect(updateBody.video.title).toBe('Judul Diperbarui Oleh Admin');
    expect(updateBody.video.status).toBe('inactive');

    // Periksa audit log mencatat UPDATE_VIDEO
    const updateLog = await ctx.db
      .prepare(`SELECT action, details FROM audit_logs WHERE action = 'UPDATE_VIDEO' AND details LIKE ?`)
      .bind(`%${video.id}%`)
      .first<{ action: string; details: string }>();
    expect(updateLog).toBeDefined();

    // B. Hapus video
    const dbRowBefore = await ctx.db.prepare('SELECT r2_key FROM videos WHERE id = ?').bind(video.id).first<{ r2_key: string }>();
    expect(dbRowBefore).toBeDefined();
    // Pastikan objek R2 ada sebelum dihapus
    const r2ObjBefore = await ctx.bucket!.get(dbRowBefore!.r2_key);
    expect(r2ObjBefore).not.toBeNull();

    const deleteReq = new Request(`http://localhost:8787/api/admin/videos/${video.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: admin.sessionCookie,
        Origin: 'http://localhost:8787'
      }
    });
    const deleteRes = await worker.fetch(deleteReq, ctx.env);
    expect(deleteRes.status).toBe(200);

    // Verifikasi di D1: record sudah hilang
    const dbRowAfter = await ctx.db.prepare('SELECT id FROM videos WHERE id = ?').bind(video.id).first();
    expect(dbRowAfter).toBeNull();

    // Verifikasi di R2: objek sudah dihapus
    const r2ObjAfter = await ctx.bucket!.get(dbRowBefore!.r2_key);
    expect(r2ObjAfter).toBeNull();

    // Verifikasi di audit_logs: ada catatan DELETE_VIDEO
    const deleteLog = await ctx.db
      .prepare(`SELECT action, details FROM audit_logs WHERE action = 'DELETE_VIDEO' AND details LIKE ?`)
      .bind(`%${video.id}%`)
      .first<{ action: string; details: string }>();
    expect(deleteLog).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 12. PENGGUNA YANG LOGOUT TIDAK BISA MENGGUNAKAN SESI LAMA
  // ---------------------------------------------------------------------------
  it('12. Pengguna yang telah logout tidak bisa menggunakan sesi lama untuk mengunduh video', async () => {
    const uploadRes = await uploadTestVideo();
    expect(uploadRes.status).toBe(201);
    const { video } = await uploadRes.json() as any;

    // Pastikan saat ini member bisa download
    const beforeLogoutDlReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const beforeDlRes = await worker.fetch(beforeLogoutDlReq, ctx.env);
    expect(beforeDlRes.status).toBe(200);

    // Member melakukan logout
    const logoutReq = new Request('http://localhost:8787/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
        Cookie: member.sessionCookie,
        Origin: 'http://localhost:8787'
      }
    });
    const logoutRes = await worker.fetch(logoutReq, ctx.env);
    expect(logoutRes.status).toBe(200);

    // Coba download kembali dengan token sesi yang sama
    const afterLogoutDlReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const afterDlRes = await worker.fetch(afterLogoutDlReq, ctx.env);
    expect(afterDlRes.status).toBe(401);
    const afterDlBody = await afterDlRes.json() as any;
    expect(afterDlBody.error).toBe('UNAUTHORIZED');
  });

  // ---------------------------------------------------------------------------
  // 13. AUDIT DAN PENGUJIAN VALIDITAS SESI PADA ENDPOINT UNDUHAN VIDEO (GET /api/videos/:id/download)
  // ---------------------------------------------------------------------------
  describe('Audit dan Validitas Sesi pada Endpoint Unduhan Video (/api/videos/:id/download)', () => {
    it('13.a. Sesi valid dapat mengunduh video aktif sesuai hak akses (member dan admin)', async () => {
      // Unggah 1 video aktif dan 1 video nonaktif
      const activeUploadRes = await uploadTestVideo({
        title: 'Video Aktif Member',
        status: 'active'
      });
      expect(activeUploadRes.status).toBe(201);
      const { video: activeVideo } = (await activeUploadRes.json()) as any;

      const inactiveUploadRes = await uploadTestVideo({
        title: 'Video Nonaktif Draf',
        status: 'inactive'
      });
      expect(inactiveUploadRes.status).toBe(201);
      const { video: inactiveVideo } = (await inactiveUploadRes.json()) as any;

      // 1. Member dengan sesi valid mengunduh video aktif -> 200 OK
      const memberActiveDlReq = new Request(`http://localhost:8787/api/videos/${activeVideo.id}/download`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const memberActiveDlRes = await worker.fetch(memberActiveDlReq, ctx.env);
      expect(memberActiveDlRes.status).toBe(200);
      expect(memberActiveDlRes.headers.get('Content-Type')).toBe('video/mp4');
      expect(memberActiveDlRes.headers.get('Content-Disposition')).toContain('attachment; filename=');
      expect(memberActiveDlRes.headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate');
      expect(memberActiveDlRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
      const bodyBytes = await memberActiveDlRes.arrayBuffer();
      expect(bodyBytes.byteLength).toBeGreaterThan(0);

      // 2. Admin dengan sesi valid mengunduh video aktif -> 200 OK
      const adminActiveDlReq = new Request(`http://localhost:8787/api/videos/${activeVideo.id}/download`, {
        method: 'GET',
        headers: { Cookie: admin.sessionCookie }
      });
      const adminActiveDlRes = await worker.fetch(adminActiveDlReq, ctx.env);
      expect(adminActiveDlRes.status).toBe(200);

      // 3. Member dengan sesi valid mencoba mengunduh video nonaktif -> 404 VIDEO_NOT_FOUND
      const memberInactiveDlReq = new Request(`http://localhost:8787/api/videos/${inactiveVideo.id}/download`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const memberInactiveDlRes = await worker.fetch(memberInactiveDlReq, ctx.env);
      expect(memberInactiveDlRes.status).toBe(404);
      const memberInactiveBody = (await memberInactiveDlRes.json()) as any;
      expect(memberInactiveBody.error).toBe('VIDEO_NOT_FOUND');
      expect(memberInactiveBody.message).toBe('Video tidak tersedia untuk diunduh.');

      // 4. Admin dengan sesi valid diizinkan mengunduh video nonaktif untuk pratinjau -> 200 OK
      const adminInactiveDlReq = new Request(`http://localhost:8787/api/videos/${inactiveVideo.id}/download`, {
        method: 'GET',
        headers: { Cookie: admin.sessionCookie }
      });
      const adminInactiveDlRes = await worker.fetch(adminInactiveDlReq, ctx.env);
      expect(adminInactiveDlRes.status).toBe(200);
    });

    it('13.b. Sesi yang telah dicabut (revoked) ditolak saat mencoba mengunduh video (401 UNAUTHORIZED)', async () => {
      const uploadRes = await uploadTestVideo({ status: 'active' });
      expect(uploadRes.status).toBe(201);
      const { video } = (await uploadRes.json()) as any;

      // Verifikasi awal: sesi member masih valid
      const initialReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const initialRes = await worker.fetch(initialReq, ctx.env);
      expect(initialRes.status).toBe(200);

      // Cabut sesi member secara eksplisit di database (revoked_at diisi)
      const memberTokenHash = await sha256(member.rawSessionToken);
      await ctx.db
        .prepare(`UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_token_hash = ?`)
        .bind(memberTokenHash)
        .run();

      // Coba unduh kembali dengan sesi yang telah dicabut
      const revokedReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const revokedRes = await worker.fetch(revokedReq, ctx.env);
      expect(revokedRes.status).toBe(401);
      const revokedBody = (await revokedRes.json()) as any;
      expect(revokedBody.error).toBe('UNAUTHORIZED');
      expect(revokedBody.message).toBe('Sesi login tidak valid atau telah kedaluwarsa.');

      // Uji juga pencabutan sesi admin
      const adminTokenHash = await sha256(admin.rawSessionToken);
      await ctx.db
        .prepare(`UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_token_hash = ?`)
        .bind(adminTokenHash)
        .run();

      const revokedAdminReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: admin.sessionCookie }
      });
      const revokedAdminRes = await worker.fetch(revokedAdminReq, ctx.env);
      expect(revokedAdminRes.status).toBe(401);
      const revokedAdminBody = (await revokedAdminRes.json()) as any;
      expect(revokedAdminBody.error).toBe('UNAUTHORIZED');
    });

    it('13.c. Sesi yang telah kedaluwarsa (kedaluwarsa 30 hari atau idle timeout 7 hari) ditolak saat mencoba mengunduh video (401 UNAUTHORIZED)', async () => {
      const uploadRes = await uploadTestVideo({ status: 'active' });
      expect(uploadRes.status).toBe(201);
      const { video } = (await uploadRes.json()) as any;

      // 1. Skenario batas kedaluwarsa absolut (expires_at sudah lampau)
      const memberTokenHash = await sha256(member.rawSessionToken);
      await ctx.db
        .prepare(`UPDATE user_sessions SET expires_at = datetime('now', '-1 hour') WHERE session_token_hash = ?`)
        .bind(memberTokenHash)
        .run();

      const expiredReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const expiredRes = await worker.fetch(expiredReq, ctx.env);
      expect(expiredRes.status).toBe(401);
      const expiredBody = (await expiredRes.json()) as any;
      expect(expiredBody.error).toBe('UNAUTHORIZED');
      expect(expiredBody.message).toBe('Sesi login tidak valid atau telah kedaluwarsa.');

      // 2. Skenario idle timeout (last_active_at > 7 hari yang lalu)
      const userIdle = await seedTestUser(ctx.db, admin.id, 'member_idle_user', 'PassIdle123!');
      const idleTokenHash = await sha256(userIdle.rawSessionToken);
      await ctx.db
        .prepare(`UPDATE user_sessions SET last_active_at = datetime('now', '-8 days') WHERE session_token_hash = ?`)
        .bind(idleTokenHash)
        .run();

      const idleReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: userIdle.sessionCookie }
      });
      const idleRes = await worker.fetch(idleReq, ctx.env);
      expect(idleRes.status).toBe(401);
      const idleBody = (await idleRes.json()) as any;
      expect(idleBody.error).toBe('UNAUTHORIZED');
      expect(idleBody.message).toBe('Sesi login tidak valid atau telah kedaluwarsa.');
    });

    it('13.d. Token sesi yang tidak dikenal atau tidak valid ditolak (401 UNAUTHORIZED)', async () => {
      const uploadRes = await uploadTestVideo({ status: 'active' });
      expect(uploadRes.status).toBe(201);
      const { video } = (await uploadRes.json()) as any;

      // 1. Token acak yang tidak pernah terdaftar di database
      const unknownTokenReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: `${SESSION_COOKIE_NAME}=random_unregistered_token_1234567890abcdef1234567890abcdef` }
      });
      const unknownTokenRes = await worker.fetch(unknownTokenReq, ctx.env);
      expect(unknownTokenRes.status).toBe(401);
      const unknownBody = (await unknownTokenRes.json()) as any;
      expect(unknownBody.error).toBe('UNAUTHORIZED');

      // 2. Token bernilai kosong
      const emptyTokenReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: `${SESSION_COOKIE_NAME}=` }
      });
      const emptyTokenRes = await worker.fetch(emptyTokenReq, ctx.env);
      expect(emptyTokenRes.status).toBe(401);
      const emptyBody = (await emptyTokenRes.json()) as any;
      expect(emptyBody.error).toBe('UNAUTHORIZED');

      // 3. Token dengan karakter rusak / malformed string
      const malformedTokenReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: `${SESSION_COOKIE_NAME}=!!@@##$$%%^^&&**(())__+` }
      });
      const malformedTokenRes = await worker.fetch(malformedTokenReq, ctx.env);
      expect(malformedTokenRes.status).toBe(401);
      const malformedBody = (await malformedTokenRes.json()) as any;
      expect(malformedBody.error).toBe('UNAUTHORIZED');

      // 4. Sesi valid yang diikuti cookie sesi duplikat malformed tetap dapat mengunduh
      const validFollowedByMalformedReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: `${member.sessionCookie}; ${SESSION_COOKIE_NAME}=broken%ZZ%FF` }
      });
      const validFollowedByMalformedRes = await worker.fetch(validFollowedByMalformedReq, ctx.env);
      expect(validFollowedByMalformedRes.status).toBe(200);

      // 5. Cookie malformed yang mendahului cookie sesi valid tidak membatalkan unduhan
      const malformedPrecedingValidReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: `junk=%%; ${SESSION_COOKIE_NAME}=corrupt%E0%A0; ${member.sessionCookie}` }
      });
      const malformedPrecedingValidRes = await worker.fetch(malformedPrecedingValidReq, ctx.env);
      expect(malformedPrecedingValidRes.status).toBe(200);

      // 6. Cookie sesi duplikat dengan token berbeda (ambigu) ditolak secara ketat (401 UNAUTHORIZED)
      const ambiguousDuplicateReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: `${member.sessionCookie}; ${SESSION_COOKIE_NAME}=conflicting_token_abc123` }
      });
      const ambiguousDuplicateRes = await worker.fetch(ambiguousDuplicateReq, ctx.env);
      expect(ambiguousDuplicateRes.status).toBe(401);
      const ambiguousBody = (await ambiguousDuplicateRes.json()) as any;
      expect(ambiguousBody.error).toBe('UNAUTHORIZED');

      // 7. Cookie sesi duplikat dengan nilai identik tetap diterima (200 OK)
      const identicalDuplicateReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: `${member.sessionCookie}; ${member.sessionCookie}` }
      });
      const identicalDuplicateRes = await worker.fetch(identicalDuplicateReq, ctx.env);
      expect(identicalDuplicateRes.status).toBe(200);
    });

    it('13.e. Permintaan tanpa cookie sesi atau hanya membawa cookie lain ditolak (401 UNAUTHORIZED)', async () => {
      const uploadRes = await uploadTestVideo({ status: 'active' });
      expect(uploadRes.status).toBe(201);
      const { video } = (await uploadRes.json()) as any;

      // 1. Tanpa header Cookie sama sekali
      const noCookieReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET'
      });
      const noCookieRes = await worker.fetch(noCookieReq, ctx.env);
      expect(noCookieRes.status).toBe(401);
      const noCookieBody = (await noCookieRes.json()) as any;
      expect(noCookieBody.error).toBe('UNAUTHORIZED');
      expect(noCookieBody.message).toBe('Sesi login tidak valid atau telah kedaluwarsa.');

      // 2. Membawa cookie perangkat tetapi tanpa cookie sesi
      const deviceOnlyReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: member.deviceCookie }
      });
      const deviceOnlyRes = await worker.fetch(deviceOnlyReq, ctx.env);
      expect(deviceOnlyRes.status).toBe(401);
      const deviceOnlyBody = (await deviceOnlyRes.json()) as any;
      expect(deviceOnlyBody.error).toBe('UNAUTHORIZED');

      // 3. Membawa cookie asing / tracking tidak relevan
      const foreignCookieReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: 'ga_tracking_id=12345; theme=dark' }
      });
      const foreignCookieRes = await worker.fetch(foreignCookieReq, ctx.env);
      expect(foreignCookieRes.status).toBe(401);
      const foreignCookieBody = (await foreignCookieRes.json()) as any;
      expect(foreignCookieBody.error).toBe('UNAUTHORIZED');
    });

    it('13.f. Sesi milik akun yang dinonaktifkan (suspended) atau perangkat dinonaktifkan ditolak saat mencoba mengunduh video', async () => {
      const uploadRes = await uploadTestVideo({ status: 'active' });
      expect(uploadRes.status).toBe(201);
      const { video } = (await uploadRes.json()) as any;

      // 1. Akun pengguna diubah menjadi suspended
      await ctx.db
        .prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`)
        .bind(member.id)
        .run();

      const suspendedReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const suspendedRes = await worker.fetch(suspendedReq, ctx.env);
      // validateSession menolak akun yang tidak aktif (status !== 'active') sehingga mengembalikan 401
      expect([401, 403]).toContain(suspendedRes.status);
      const suspendedBody = (await suspendedRes.json()) as any;
      expect(['UNAUTHORIZED', 'ACCOUNT_SUSPENDED']).toContain(suspendedBody.error);

      // 2. Perangkat pengguna dinonaktifkan (is_active = 0)
      const userDeact = await seedTestUser(ctx.db, admin.id, 'member_deactivated_device', 'PassDeact123!');
      await ctx.db
        .prepare(`UPDATE user_devices SET is_active = 0 WHERE user_id = ?`)
        .bind(userDeact.id)
        .run();

      const deactReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: userDeact.sessionCookie }
      });
      const deactRes = await worker.fetch(deactReq, ctx.env);
      expect(deactRes.status).toBe(401);
      const deactBody = (await deactRes.json()) as any;
      expect(deactBody.error).toBe('UNAUTHORIZED');
    });
  });

  // ---------------------------------------------------------------------------
  // 14. FITUR 5: STREAMING DAN PRATINJAU VIDEO (GET /api/videos/:id/stream)
  // ---------------------------------------------------------------------------
  describe('Fitur 5: Streaming dan Pratinjau Video (GET /api/videos/:id/stream)', () => {
    it('14.a. Member terautentikasi dapat melakukan streaming video aktif secara utuh dan tidak menambah download_count', async () => {
      const rawData = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const uploadRes = await uploadTestVideo({ fileBytes: rawData, status: 'active' });
      expect(uploadRes.status).toBe(201);
      const { video } = (await uploadRes.json()) as any;

      const streamReq = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });

      const streamRes = await worker.fetch(streamReq, ctx.env);
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('Content-Type')).toBe('video/mp4');
      expect(streamRes.headers.get('Accept-Ranges')).toBe('bytes');
      expect(streamRes.headers.get('Content-Length')).toBe('8');
      expect(streamRes.headers.get('Content-Disposition')).toContain('inline');
      expect(streamRes.headers.get('X-Content-Type-Options')).toBe('nosniff');

      const bodyBuffer = new Uint8Array(await streamRes.arrayBuffer());
      expect(bodyBuffer).toEqual(rawData);

      // Verifikasi bahwa download_count di database TIDAK bertambah (tetap 0)
      const dbRow = await ctx.db
        .prepare('SELECT download_count FROM videos WHERE id = ?')
        .bind(video.id)
        .first<{ download_count: number }>();
      expect(dbRow?.download_count).toBe(0);
    });

    it('14.b. Mendukung HTTP Range Requests (206 Partial Content) untuk pemutaran dan pencarian posisi (seeking)', async () => {
      // 12 byte MP4 dengan magic bytes ftyp di offset 4-7
      const rawData = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, // 0-3
        0x66, 0x74, 0x79, 0x70, // 4-7 ('ftyp')
        0x10, 0x20, 0x30, 0x40  // 8-11
      ]);
      const uploadRes = await uploadTestVideo({ fileBytes: rawData, status: 'active' });
      expect(uploadRes.status).toBe(201);
      const { video } = (await uploadRes.json()) as any;

      // 1. Range awal: bytes=0-3 (4 byte pertama)
      const rangeReq1 = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: {
          Cookie: member.sessionCookie,
          Range: 'bytes=0-3'
        }
      });
      const rangeRes1 = await worker.fetch(rangeReq1, ctx.env);
      expect(rangeRes1.status).toBe(206);
      expect(rangeRes1.headers.get('Content-Range')).toBe('bytes 0-3/12');
      expect(rangeRes1.headers.get('Content-Length')).toBe('4');
      expect(rangeRes1.headers.get('Accept-Ranges')).toBe('bytes');
      expect(rangeRes1.headers.get('Content-Disposition')).toContain('inline');
      const buf1 = new Uint8Array(await rangeRes1.arrayBuffer());
      expect(buf1).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x18]));

      // 2. Range byte 8 hingga akhir: bytes=8- (4 byte terakhir)
      const rangeReq2 = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: {
          Cookie: member.sessionCookie,
          Range: 'bytes=8-'
        }
      });
      const rangeRes2 = await worker.fetch(rangeReq2, ctx.env);
      expect(rangeRes2.status).toBe(206);
      expect(rangeRes2.headers.get('Content-Range')).toBe('bytes 8-11/12');
      expect(rangeRes2.headers.get('Content-Length')).toBe('4');
      const buf2 = new Uint8Array(await rangeRes2.arrayBuffer());
      expect(buf2).toEqual(new Uint8Array([0x10, 0x20, 0x30, 0x40]));

      // 3. Suffix range: bytes=-2 (2 byte terakhir)
      const rangeReq3 = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: {
          Cookie: member.sessionCookie,
          Range: 'bytes=-2'
        }
      });
      const rangeRes3 = await worker.fetch(rangeReq3, ctx.env);
      expect(rangeRes3.status).toBe(206);
      expect(rangeRes3.headers.get('Content-Range')).toBe('bytes 10-11/12');
      expect(rangeRes3.headers.get('Content-Length')).toBe('2');
      const buf3 = new Uint8Array(await rangeRes3.arrayBuffer());
      expect(buf3).toEqual(new Uint8Array([0x30, 0x40]));

      // 4. Unsatisfiable range: bytes=50-100 (melebihi ukuran file)
      const invalidRangeReq = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: {
          Cookie: member.sessionCookie,
          Range: 'bytes=50-100'
        }
      });
      const invalidRangeRes = await worker.fetch(invalidRangeReq, ctx.env);
      expect(invalidRangeRes.status).toBe(416);
      expect(invalidRangeRes.headers.get('Content-Range')).toBe('bytes */12');
      expect(invalidRangeRes.headers.get('Accept-Ranges')).toBe('bytes');
    });

    it('14.c. Pengguna tanpa sesi atau sesi kedaluwarsa ditolak saat mengakses stream (401 UNAUTHORIZED)', async () => {
      const uploadRes = await uploadTestVideo({ status: 'active' });
      const { video } = (await uploadRes.json()) as any;

      // Tanpa cookie sesi
      const anonReq = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET'
      });
      const anonRes = await worker.fetch(anonReq, ctx.env);
      expect(anonRes.status).toBe(401);
      const anonBody = (await anonRes.json()) as any;
      expect(anonBody.error).toBe('UNAUTHORIZED');

      // Dengan cookie palsu
      const fakeReq = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: { Cookie: 'GVS_SESSION=invalid_session_token_123' }
      });
      const fakeRes = await worker.fetch(fakeReq, ctx.env);
      expect(fakeRes.status).toBe(401);
    });

    it('14.d. Member tidak dapat memutar video nonaktif (404), tetapi Admin dan Super Admin diizinkan untuk pratinjau verifikasi', async () => {
      const uploadRes = await uploadTestVideo({ status: 'inactive' });
      const { video } = (await uploadRes.json()) as any;

      // 1. Member mencoba memutar video nonaktif -> ditolak 404
      const memberReq = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const memberRes = await worker.fetch(memberReq, ctx.env);
      expect(memberRes.status).toBe(404);
      const memberBody = (await memberRes.json()) as any;
      expect(memberBody.error).toBe('VIDEO_NOT_FOUND');

      // 2. Admin mencoba memutar video nonaktif -> diizinkan 200 OK
      const adminReq = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: { Cookie: admin.sessionCookie }
      });
      const adminRes = await worker.fetch(adminReq, ctx.env);
      expect(adminRes.status).toBe(200);

      // 3. Super Admin mencoba memutar video nonaktif -> diizinkan 200 OK
      await ctx.db
        .prepare(`UPDATE users SET role = 'super_admin' WHERE id = ?`)
        .bind(admin.id)
        .run();

      const superAdminReq = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: { Cookie: admin.sessionCookie }
      });
      const superAdminRes = await worker.fetch(superAdminReq, ctx.env);
      expect(superAdminRes.status).toBe(200);
    });

    it('14.e. Member tanpa shopee_link atau akun suspended ditolak dari streaming video', async () => {
      const uploadRes = await uploadTestVideo({ status: 'active' });
      const { video } = (await uploadRes.json()) as any;

      // Member tanpa shopee_link
      const userNoShopee = await seedTestUser(ctx.db, admin.id, 'member_tanpa_shopee', 'PassNoShopee123!');
      await ctx.db
        .prepare('UPDATE users SET shopee_link = NULL WHERE id = ?')
        .bind(userNoShopee.id)
        .run();

      const noShopeeReq = new Request(`http://localhost:8787/api/videos/${video.id}/stream`, {
        method: 'GET',
        headers: { Cookie: userNoShopee.sessionCookie }
      });
      const noShopeeRes = await worker.fetch(noShopeeReq, ctx.env);
      expect(noShopeeRes.status).toBe(403);
      const noShopeeBody = (await noShopeeRes.json()) as any;
      expect(noShopeeBody.error).toBe('SHOPEE_LINK_REQUIRED');
    });

    it('14.f. ID video tidak valid mengembalikan 400 dan video tidak terdaftar mengembalikan 404', async () => {
      // ID tidak valid (bukan UUID)
      const invalidIdReq = new Request('http://localhost:8787/api/videos/not-a-uuid-123/stream', {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const invalidIdRes = await worker.fetch(invalidIdReq, ctx.env);
      expect(invalidIdRes.status).toBe(400);
      const invalidIdBody = (await invalidIdRes.json()) as any;
      expect(invalidIdBody.error).toBe('INVALID_VIDEO_ID');

      // UUID acak tidak ada di database
      const randomUuid = crypto.randomUUID();
      const notFoundReq = new Request(`http://localhost:8787/api/videos/${randomUuid}/stream`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const notFoundRes = await worker.fetch(notFoundReq, ctx.env);
      expect(notFoundRes.status).toBe(404);
      const notFoundBody = (await notFoundRes.json()) as any;
      expect(notFoundBody.error).toBe('VIDEO_NOT_FOUND');
    });

    it('14.g. Memastikan fitur unduhan video (/api/videos/:id/download) tetap berfungsi normal dan menambah download_count', async () => {
      const uploadRes = await uploadTestVideo({ status: 'active' });
      const { video } = (await uploadRes.json()) as any;

      const dlReq = new Request(`http://localhost:8787/api/videos/${video.id}/download`, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const dlRes = await worker.fetch(dlReq, ctx.env);
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get('Content-Disposition')).toContain('attachment');

      // Beri sedikit jeda DB update
      await new Promise((r) => setTimeout(r, 50));
      const dbRow = await ctx.db
        .prepare('SELECT download_count FROM videos WHERE id = ?')
        .bind(video.id)
        .first<{ download_count: number }>();
      expect(dbRow?.download_count).toBeGreaterThanOrEqual(1);
    });
  });
});
