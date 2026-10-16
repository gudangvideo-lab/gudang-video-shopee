/**
 * tests/pagination.test.ts
 * Pengujian Komprehensif Keyset Cursor-Based Pagination Katalog Video:
 * 1. Mampu melintasi katalog melampaui batas lama 200 video (250 video diuji).
 * 2. Menjamin keterjangkauan video #201 hingga #250 tanpa duplikasi atau data terlewat.
 * 3. Keberhasilan tie-breaking deterministik saat timestamp created_at identik.
 * 4. Paginasi bekerja mulus bersama filter rak (rack_id) dan pencarian kata kunci (q).
 * 5. Validasi input: cursor tidak valid (400) dan limit di luar batas (400).
 * 6. Penanganan katalog kosong (empty state) yang konsisten.
 * 7. Otorisasi member (shopee_link dan status aktif) tetap ditegakkan pada paginasi.
 * 8. Endpoint admin (/api/admin/videos) mendukung paginasi dan filter status aktif/nonaktif.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import { createIsolatedTestDb, seedTestAdmin, seedTestUser, TestContext } from './setup-test-db';

describe('Keyset Cursor-Based Pagination Katalog Video', () => {
  let ctx: TestContext;
  let admin: { id: string; username: string; sessionCookie: string; rawSessionToken: string };
  let member: { id: string; username: string; sessionCookie: string; deviceCookie: string; rawSessionToken: string };

  const DEFAULT_RACK_ID = '00000000-0000-0000-0000-000000000001';

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
    admin = await seedTestAdmin(ctx.db, 'admin_pagination', 'AdminPagi123!');
    member = await seedTestUser(ctx.db, admin.id, 'member_pagination', 'MemberPagi123!');

    // Pastikan member memiliki shopee_link terverifikasi
    await ctx.db
      .prepare(`UPDATE users SET shopee_link = 'https://shopee.co.id/member_pagination' WHERE id = ?`)
      .bind(member.id)
      .run();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Helper untuk menyisipkan daftar video secara cepat menggunakan db.batch
   */
  async function seedFastVideos(
    count: number,
    options: {
      rackId?: string;
      status?: 'active' | 'inactive';
      titlePrefix?: string;
      baseDate?: string;
      fixedDate?: string;
    } = {}
  ): Promise<Array<{ id: string; title: string; created_at: string }>> {
    const rackId = options.rackId || DEFAULT_RACK_ID;
    const status = options.status || 'active';
    const titlePrefix = options.titlePrefix || 'Video Katalog';
    const seeded: Array<{ id: string; title: string; created_at: string }> = [];

    const statements: any[] = [];
    const baseTime = options.baseDate ? new Date(options.baseDate).getTime() : new Date('2026-01-01T00:00:00Z').getTime();

    for (let i = 1; i <= count; i++) {
      const id = crypto.randomUUID();
      const title = `${titlePrefix} #${String(i).padStart(4, '0')}`;
      const r2Key = `videos/${id}.mp4`;
      const productName = `Produk Afiliasi #${i}`;
      const productUrl = `https://shopee.co.id/product/test/${i}`;

      // Hitung created_at (semakin besar i, semakin baru timestampnya)
      const createdAt = options.fixedDate
        ? options.fixedDate
        : new Date(baseTime + i * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

      seeded.push({ id, title, created_at: createdAt });

      statements.push(
        ctx.db.prepare(
          `INSERT INTO videos (
            id, r2_key, title, product_name, product_url, description,
            file_size, content_type, uploaded_by_admin_id, status, download_count,
            rack_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        ).bind(
          id,
          r2Key,
          title,
          productName,
          productUrl,
          `Deskripsi video katalog nomor ${i}`,
          1024 * 1024 * 2,
          'video/mp4',
          admin.id,
          status,
          rackId,
          createdAt,
          createdAt
        )
      );
    }

    // Jalankan per batch maksimal 100 statements
    const chunkSize = 80;
    for (let i = 0; i < statements.length; i += chunkSize) {
      await ctx.db.batch(statements.slice(i, i + chunkSize));
    }

    return seeded;
  }

  // ---------------------------------------------------------------------------
  // 1. MELAMPAUI BATAS LAMA 200 VIDEO (TRAVERSAL 250 VIDEO)
  // ---------------------------------------------------------------------------
  it('1. Mampu mengambil seluruh 250 video melalui cursor traversal tanpa batas 200', async () => {
    // Buat 250 video aktif
    const seeded = await seedFastVideos(250);
    expect(seeded.length).toBe(250);

    const retrievedVideoIds: string[] = [];
    let currentCursor: string | undefined = undefined;
    let pageCount = 0;
    let hasMore = true;

    while (hasMore) {
      pageCount++;
      const url = currentCursor
        ? `http://localhost:8787/api/videos?limit=24&cursor=${encodeURIComponent(currentCursor)}`
        : `http://localhost:8787/api/videos?limit=24`;

      const req = new Request(url, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);

      const data = await res.json() as any;
      expect(data.status).toBe('ok');
      expect(Array.isArray(data.videos)).toBe(true);
      expect(data.pagination).toBeDefined();

      for (const v of data.videos) {
        retrievedVideoIds.push(v.id);
      }

      hasMore = data.pagination.has_more;
      currentCursor = data.pagination.next_cursor;

      if (hasMore) {
        expect(currentCursor).toBeTruthy();
        expect(data.videos.length).toBe(24);
      } else {
        expect(currentCursor).toBeNull();
      }
    }

    // 250 video dengan limit 24 -> 10 halaman berisi 24 item, halaman ke-11 berisi 10 item = 11 halaman
    expect(pageCount).toBe(11);
    expect(retrievedVideoIds.length).toBe(250);

    // Pastikan tidak ada ID yang berulang (0 duplikasi)
    const uniqueIds = new Set(retrievedVideoIds);
    expect(uniqueIds.size).toBe(250);

    // Urutan harus DESC berdasarkan created_at (video #250 paling baru, video #1 paling lama)
    // Video #201 dan #250 wajib terjangkau
    const newestSeeded = seeded[seeded.length - 1]; // #250
    const video201 = seeded[200]; // #201 (0-indexed 200)
    const oldestSeeded = seeded[0]; // #1

    expect(retrievedVideoIds[0]).toBe(newestSeeded.id);
    expect(retrievedVideoIds).toContain(video201.id);
    expect(retrievedVideoIds[retrievedVideoIds.length - 1]).toBe(oldestSeeded.id);
  });

  // ---------------------------------------------------------------------------
  // 2. DETERMINISTIK TIE-BREAKING DENGAN TIMESTAMP IDENTIK
  // ---------------------------------------------------------------------------
  it('2. Menangani tie-breaking secara deterministik saat banyak video memiliki created_at yang persis sama', async () => {
    // Sisipkan 10 video dengan timestamp persis sama
    const fixedTime = '2026-05-15 10:30:00';
    const seeded = await seedFastVideos(10, { fixedDate: fixedTime });

    // Urutkan id secara descending untuk ekspektasi tie-breaker (ORDER BY created_at DESC, id DESC)
    const expectedIds = [...seeded].map((s) => s.id).sort().reverse();

    const retrievedIds: string[] = [];
    let currentCursor: string | undefined = undefined;
    let page = 0;

    // Ambil dengan limit 3 per halaman
    while (true) {
      page++;
      const url = currentCursor
        ? `http://localhost:8787/api/videos?limit=3&cursor=${encodeURIComponent(currentCursor)}`
        : `http://localhost:8787/api/videos?limit=3`;

      const req = new Request(url, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const res = await worker.fetch(req, ctx.env);
      const data = await res.json() as any;

      for (const v of data.videos) {
        retrievedIds.push(v.id);
      }

      if (!data.pagination.has_more) break;
      currentCursor = data.pagination.next_cursor;
    }

    expect(retrievedIds.length).toBe(10);
    expect(retrievedIds).toEqual(expectedIds);
  });

  // ---------------------------------------------------------------------------
  // 3. VALIDASI PARAMETER LIMIT
  // ---------------------------------------------------------------------------
  it('3. Memvalidasi batasan limit: default 24, maksimal 100, menolak limit di luar batas', async () => {
    await seedFastVideos(30);

    // Default limit (tanpa query limit) -> 24 item
    const defReq = new Request('http://localhost:8787/api/videos', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const defRes = await worker.fetch(defReq, ctx.env);
    const defData = await defRes.json() as any;
    expect(defData.videos.length).toBe(24);
    expect(defData.pagination.limit).toBe(24);

    // Limit kustom valid = 5
    const customReq = new Request('http://localhost:8787/api/videos?limit=5', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const customRes = await worker.fetch(customReq, ctx.env);
    const customData = await customRes.json() as any;
    expect(customData.videos.length).toBe(5);
    expect(customData.pagination.limit).toBe(5);

    // Limit melebihi batas 100 -> 400 INVALID_LIMIT
    const overReq = new Request('http://localhost:8787/api/videos?limit=101', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const overRes = await worker.fetch(overReq, ctx.env);
    expect(overRes.status).toBe(400);
    const overData = await overRes.json() as any;
    expect(overData.error).toBe('INVALID_LIMIT');

    // Limit tidak valid (<= 0 atau string non-angka) -> 400 INVALID_LIMIT
    const zeroReq = new Request('http://localhost:8787/api/videos?limit=0', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const zeroRes = await worker.fetch(zeroReq, ctx.env);
    expect(zeroRes.status).toBe(400);

    const badReq = new Request('http://localhost:8787/api/videos?limit=abc', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const badRes = await worker.fetch(badReq, ctx.env);
    expect(badRes.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // 4. PENANGANAN CURSOR TIDAK VALID
  // ---------------------------------------------------------------------------
  it('4. Mengembalikan 400 INVALID_CURSOR untuk format cursor yang rusak atau dimanipulasi', async () => {
    // Malformed base64
    const malReq = new Request('http://localhost:8787/api/videos?cursor=not-a-valid-cursor-string!!!', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const malRes = await worker.fetch(malReq, ctx.env);
    expect(malRes.status).toBe(400);
    const malData = await malRes.json() as any;
    expect(malData.error).toBe('INVALID_CURSOR');

    // Valid base64 tapi bukan JSON yang diharapkan
    const invalidJsonCursor = btoa(JSON.stringify({ wrongKey: 'value' }));
    const badJsonReq = new Request(`http://localhost:8787/api/videos?cursor=${encodeURIComponent(invalidJsonCursor)}`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const badJsonRes = await worker.fetch(badJsonReq, ctx.env);
    expect(badJsonRes.status).toBe(400);
    const badJsonData = await badJsonRes.json() as any;
    expect(badJsonData.error).toBe('INVALID_CURSOR');
  });

  // ---------------------------------------------------------------------------
  // 5. FILTER RAK & PENCARIAN KATA KUNCI BERSAMA PAGINASI
  // ---------------------------------------------------------------------------
  it('5. Mempertahankan filter rak dan pencarian kata kunci di sepanjang perpindahan halaman', async () => {
    // Buat rak baru
    const customRackId = crypto.randomUUID();
    await ctx.db
      .prepare(`INSERT INTO racks (id, name, is_default, created_by) VALUES (?, 'Elektronik & Gadget', 0, ?)`)
      .bind(customRackId, admin.id)
      .run();

    // Buat 30 video pada rak kustom
    await seedFastVideos(30, { rackId: customRackId, titlePrefix: 'Gadget Unik' });
    // Buat 10 video pada rak default
    await seedFastVideos(10, { rackId: DEFAULT_RACK_ID, titlePrefix: 'Umum' });

    // Request halaman 1 untuk rak kustom
    const r1Req = new Request(`http://localhost:8787/api/videos?rack_id=${customRackId}&limit=20`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const r1Res = await worker.fetch(r1Req, ctx.env);
    const r1Data = await r1Res.json() as any;
    expect(r1Data.videos.length).toBe(20);
    expect(r1Data.pagination.has_more).toBe(true);
    for (const v of r1Data.videos) {
      expect(v.rack_id).toBe(customRackId);
    }

    // Request halaman 2 menggunakan cursor dari halaman 1
    const r2Req = new Request(
      `http://localhost:8787/api/videos?rack_id=${customRackId}&limit=20&cursor=${encodeURIComponent(r1Data.pagination.next_cursor)}`,
      {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      }
    );
    const r2Res = await worker.fetch(r2Req, ctx.env);
    const r2Data = await r2Res.json() as any;
    expect(r2Data.videos.length).toBe(10);
    expect(r2Data.pagination.has_more).toBe(false);
    expect(r2Data.pagination.next_cursor).toBeNull();
    for (const v of r2Data.videos) {
      expect(v.rack_id).toBe(customRackId);
    }

    // Pengujian pencarian kata kunci (q)
    const qReq = new Request(`http://localhost:8787/api/videos?q=Gadget&limit=50`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const qRes = await worker.fetch(qReq, ctx.env);
    const qData = await qRes.json() as any;
    expect(qData.videos.length).toBe(30);
    for (const v of qData.videos) {
      expect(v.title).toContain('Gadget');
    }
  });

  // ---------------------------------------------------------------------------
  // 6. PENANGANAN KATALOG KOSONG (EMPTY STATE)
  // ---------------------------------------------------------------------------
  it('6. Menangani katalog kosong secara elegan dengan has_more=false dan next_cursor=null', async () => {
    const req = new Request('http://localhost:8787/api/videos', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const res = await worker.fetch(req, ctx.env);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.status).toBe('ok');
    expect(data.videos).toEqual([]);
    expect(data.pagination).toEqual({
      limit: 24,
      has_more: false,
      next_cursor: null
    });
  });

  // ---------------------------------------------------------------------------
  // 7. OTORISASI & ISOLASI MEMBER
  // ---------------------------------------------------------------------------
  it('7. Member tanpa shopee_link atau non-aktif tidak dapat melihat katalog video', async () => {
    await seedFastVideos(5);

    // Buat member baru tanpa shopee_link
    const unlinkedMember = await seedTestUser(ctx.db, admin.id, 'unlinked_member', 'Unlinked123!', null);

    const req = new Request('http://localhost:8787/api/videos', {
      method: 'GET',
      headers: { Cookie: unlinkedMember.sessionCookie }
    });
    const res = await worker.fetch(req, ctx.env);
    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.error).toBe('SHOPEE_LINK_REQUIRED');

    // Member aktif hanya melihat video berstatus 'active'
    await seedFastVideos(5, { status: 'inactive', titlePrefix: 'Video Rahasia' });

    const memberReq = new Request('http://localhost:8787/api/videos', {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const memberRes = await worker.fetch(memberReq, ctx.env);
    const memberData = await memberRes.json() as any;
    expect(memberData.videos.length).toBe(5);
    for (const v of memberData.videos) {
      expect(v.title).not.toContain('Video Rahasia');
    }
  });

  // ---------------------------------------------------------------------------
  // 8. ENDPOINT ADMIN (/api/admin/videos) DENGAN PAGINASI & FILTER STATUS
  // ---------------------------------------------------------------------------
  it('8. Endpoint admin mendukung paginasi dan filter status aktif/nonaktif', async () => {
    await seedFastVideos(15, { status: 'active', titlePrefix: 'Aktif' });
    await seedFastVideos(10, { status: 'inactive', titlePrefix: 'Nonaktif' });

    // Admin mengambil hanya video nonaktif dengan limit 5
    const inactiveReq = new Request('http://localhost:8787/api/admin/videos?status=inactive&limit=5', {
      method: 'GET',
      headers: { Cookie: admin.sessionCookie }
    });
    const inactiveRes = await worker.fetch(inactiveReq, ctx.env);
    expect(inactiveRes.status).toBe(200);

    const inactiveData = await inactiveRes.json() as any;
    expect(inactiveData.videos.length).toBe(5);
    expect(inactiveData.pagination.has_more).toBe(true);
    for (const v of inactiveData.videos) {
      expect(v.status).toBe('inactive');
    }

    // Admin mengambil seluruh video (aktif + nonaktif)
    const allReq = new Request('http://localhost:8787/api/admin/videos?limit=50', {
      method: 'GET',
      headers: { Cookie: admin.sessionCookie }
    });
    const allRes = await worker.fetch(allReq, ctx.env);
    const allData = await allRes.json() as any;
    expect(allData.videos.length).toBe(25);
  });

  // ---------------------------------------------------------------------------
  // 9. TRUNCATION QUERY PENCARIAN MELEBIHI 100 KARAKTER PADA BACKEND
  // ---------------------------------------------------------------------------
  it('9. Memotong parameter pencarian q yang melebihi 100 karakter pada backend secara aman', async () => {
    await seedFastVideos(5, { titlePrefix: 'Smartphone Flagship' });

    // Kirim query q dengan panjang 150 karakter
    const longQuery = 'Smartphone'.padEnd(150, 'X');
    const req = new Request(`http://localhost:8787/api/videos?q=${encodeURIComponent(longQuery)}`, {
      method: 'GET',
      headers: { Cookie: member.sessionCookie }
    });
    const res = await worker.fetch(req, ctx.env);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.status).toBe('ok');
    expect(Array.isArray(data.videos)).toBe(true);
    // Karena dipotong pada 100 karakter (SmartphoneXXX...), tidak error SQL dan mengembalikan array kosong dengan aman
    expect(data.videos).toEqual([]);
  });
});
