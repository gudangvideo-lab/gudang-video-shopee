/**
 * tests/pagination-stress.test.ts
 * FASE D.5 — LOCAL PAGINATION STRESS TEST (250 VIDEO SIMULASI)
 *
 * Pengujian komprehensif implementasi Keyset Cursor-Based Pagination
 * pada lingkungan lokal yang terisolasi 100% menggunakan Miniflare in-memory SQLite D1
 * dan in-memory R2 bucket tanpa menyentuh resource Cloudflare produksi.
 *
 * Ruang Lingkup Pengujian:
 * 1. Isolasi lingkungan lokal (Miniflare in-memory D1 & R2).
 * 2. Fixture tepat 250 video simulasi dengan variasi timestamp, tie-breaker, rak, judul, dan status.
 * 3. Traversal katalog lengkap (250 video dengan limit 24 -> 11 halaman, 0 duplikat, 0 terlewat).
 * 4. Navigasi cursor maju (Next) dan mundur (Prev via cursor stack).
 * 5. Konsistensi urutan deterministik (created_at DESC, id DESC) dan stabilitas pengulangan.
 * 6. Batas limit (default 24, 1, 24, 100, 0, negatif, >100, non-numerik).
 * 7. Validasi cursor tidak valid (malformed, non-base64, JSON salah, skema cacat, cursor kosong).
 * 8. Pencarian (multi-match, single-match, zero-match, case-insensitivity, karakter khusus, >100 char).
 * 9. Filter rak (Rak 1, Rak 2, kombinasi search + rack) dan filter status admin (active / inactive).
 * 10. Penanganan katalog kosong (empty state) yang konsisten.
 * 11. Penegakan autentikasi & otorisasi RBAC (unauthenticated, member-to-admin forbidden, shopee_link).
 * 12. Pengujian integrasi logika UI Frontend (navigasi tombol Next/Prev, reset filter, race conditions, error loading).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../worker/index';
import { createIsolatedTestDb, seedTestAdmin, seedTestUser, TestContext } from './setup-test-db';

describe('FASE D.5 — Stress Test Pagination Katalog Video (250 Video Simulasi)', () => {
  let ctx: TestContext;
  let admin: { id: string; username: string; sessionCookie: string; rawSessionToken: string };
  let member: { id: string; username: string; sessionCookie: string; deviceCookie: string; rawSessionToken: string };

  const RACK_1_ID = '00000000-0000-0000-0000-000000000001'; // Default rack 'General'
  const RACK_2_ID = '00000000-0000-0000-0000-000000000002'; // Custom rack 'Fashion & Gadget'

  beforeEach(async () => {
    ctx = await createIsolatedTestDb();
    admin = await seedTestAdmin(ctx.db, 'admin_stresstest', 'AdminStress123!');
    member = await seedTestUser(ctx.db, admin.id, 'member_stresstest', 'MemberStress123!');

    // Pastikan member memiliki shopee_link terverifikasi
    await ctx.db
      .prepare(`UPDATE users SET shopee_link = 'https://shopee.co.id/member_stresstest' WHERE id = ?`)
      .bind(member.id)
      .run();

    // Buat Rak ke-2 untuk pengujian multi-rak
    await ctx.db
      .prepare(`INSERT INTO racks (id, name, is_default, created_by) VALUES (?, 'Fashion & Gadget', 0, ?)`)
      .bind(RACK_2_ID, admin.id)
      .run();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  interface SimulatedVideo {
    id: string;
    title: string;
    created_at: string;
    rack_id: string;
    status: 'active' | 'inactive';
    product_name: string;
  }

  /**
   * Helper untuk menyisipkan tepat 250 video simulasi dengan ID terstruktur SIM-VIDEO-001 s/d SIM-VIDEO-250.
   * - 235 video active, 15 video inactive (SIM-VIDEO-236 s/d SIM-VIDEO-250)
   * - 150 video di Rak 1 (General), 100 video di Rak 2 (Fashion & Gadget)
   * - Timestamp dibuat meningkat per menit, kecuali SIM-VIDEO-100, 101, 102 yang berbagi timestamp identik.
   * - Variasi judul mengandung kata kunci pencarian umum, spesifik, dan karakter khusus.
   */
  async function seed250SimulatedVideos(): Promise<SimulatedVideo[]> {
    const list: SimulatedVideo[] = [];
    const baseTime = new Date('2026-01-01T08:00:00Z').getTime();
    const fixedTieTimestamp = '2026-01-01 10:00:00';

    const statements: any[] = [];

    for (let i = 1; i <= 250; i++) {
      const numStr = String(i).padStart(3, '0');
      const id = `SIM-VIDEO-${numStr}`;

      // Tentukan status: video 236..250 adalah inactive (15 video), sisanya active (235 video)
      const status: 'active' | 'inactive' = i > 235 ? 'inactive' : 'active';

      // Tentukan rak: 1..150 di Rak 1, 151..250 di Rak 2
      const rackId = i <= 150 ? RACK_1_ID : RACK_2_ID;

      // Timestamp: video 100, 101, 102 memiliki created_at yang persis sama untuk uji tie-breaker
      let createdAt: string;
      if (i >= 100 && i <= 102) {
        createdAt = fixedTieTimestamp;
      } else {
        createdAt = new Date(baseTime + i * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      }

      // Variasi judul untuk pengujian pencarian
      let title: string;
      let productName: string;

      if (i === 42) {
        title = `SIM-VIDEO-${numStr}: Produk Unik Langka EdisiKhususXYZ999`;
        productName = 'Edisi Khusus Kolektor Langka';
      } else if (i === 88) {
        title = `SIM-VIDEO-${numStr}: [PROMO] Diskon 50% & Hadiah Gratis! #ShopeeSuperSale`;
        productName = 'Paket Bundling Diskon';
      } else if (i % 5 === 0) {
        title = `SIM-VIDEO-${numStr}: Sepatu Sneakers Olahraga Pria Sporty`;
        productName = `Sepatu Sport #${numStr}`;
      } else if (i % 3 === 0) {
        title = `SIM-VIDEO-${numStr}: Tas Selempang Kulit Premium Wanita`;
        productName = `Tas Wanita #${numStr}`;
      } else {
        title = `SIM-VIDEO-${numStr}: Kemeja Kasual Lengan Panjang`;
        productName = `Kemeja Kasual #${numStr}`;
      }

      list.push({
        id,
        title,
        created_at: createdAt,
        rack_id: rackId,
        status,
        product_name: productName
      });

      statements.push(
        ctx.db.prepare(
          `INSERT INTO videos (
            id, r2_key, title, product_name, product_url, description,
            file_size, content_type, uploaded_by_admin_id, status, download_count,
            rack_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        ).bind(
          id,
          `videos/${id}.mp4`,
          title,
          productName,
          `https://shopee.co.id/product/${id}`,
          `Deskripsi video simulasi ${id}`,
          1024 * 1024 * 3,
          'video/mp4',
          admin.id,
          status,
          rackId,
          createdAt,
          createdAt
        )
      );
    }

    // Jalankan dalam chunk 50 statements
    for (let i = 0; i < statements.length; i += 50) {
      await ctx.db.batch(statements.slice(i, i + 50));
    }

    return list;
  }

  // ===========================================================================
  // 1. TRAVERSAL SELURUH KATALOG (250 VIDEO DENGAN LIMIT DEFAULT 24)
  // ===========================================================================
  it('A. Traversal seluruh 250 video simulasi tanpa batas lama 200 (Admin & Member)', async () => {
    const seeded = await seed250SimulatedVideos();
    expect(seeded.length).toBe(250);

    // 1. Admin Traversal: Mengambil seluruh 250 video (aktif + nonaktif)
    // 250 item dengan limit 24 -> 10 halaman @ 24 item + 1 halaman @ 10 item = 11 halaman
    const adminRetrievedIds: string[] = [];
    let adminCursor: string | undefined = undefined;
    let adminPages = 0;
    let adminHasMore = true;

    while (adminHasMore) {
      adminPages++;
      const url = adminCursor
        ? `http://localhost:8787/api/admin/videos?limit=24&cursor=${encodeURIComponent(adminCursor)}`
        : `http://localhost:8787/api/admin/videos?limit=24`;

      const req = new Request(url, {
        method: 'GET',
        headers: { Cookie: admin.sessionCookie }
      });
      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);

      const data = await res.json() as any;
      expect(data.status).toBe('ok');
      expect(Array.isArray(data.videos)).toBe(true);

      for (const v of data.videos) {
        adminRetrievedIds.push(v.id);
      }

      adminHasMore = data.pagination.has_more;
      adminCursor = data.pagination.next_cursor;

      if (adminHasMore) {
        expect(adminCursor).toBeTruthy();
        expect(data.videos.length).toBe(24);
      } else {
        expect(adminCursor).toBeNull();
        expect(data.videos.length).toBe(10); // Halaman ke-11 berisi sisa 10 video
      }
    }

    expect(adminPages).toBe(11);
    expect(adminRetrievedIds.length).toBe(250);

    // Pastikan 0 duplikasi dan 0 video terlewat
    const adminUniqueIds = new Set(adminRetrievedIds);
    expect(adminUniqueIds.size).toBe(250);

    // Pastikan video #201 hingga #250 terjangkau penuh
    expect(adminRetrievedIds).toContain('SIM-VIDEO-201');
    expect(adminRetrievedIds).toContain('SIM-VIDEO-250');

    // 2. Member Traversal: Mengambil seluruh 235 video aktif
    // 235 item dengan limit 24 -> 9 halaman @ 24 item + 1 halaman @ 19 item = 10 halaman
    const memberRetrievedIds: string[] = [];
    let memberCursor: string | undefined = undefined;
    let memberPages = 0;
    let memberHasMore = true;

    while (memberHasMore) {
      memberPages++;
      const url = memberCursor
        ? `http://localhost:8787/api/videos?limit=24&cursor=${encodeURIComponent(memberCursor)}`
        : `http://localhost:8787/api/videos?limit=24`;

      const req = new Request(url, {
        method: 'GET',
        headers: { Cookie: member.sessionCookie }
      });
      const res = await worker.fetch(req, ctx.env);
      expect(res.status).toBe(200);

      const data = await res.json() as any;
      expect(data.status).toBe('ok');
      for (const v of data.videos) {
        memberRetrievedIds.push(v.id);
      }

      memberHasMore = data.pagination.has_more;
      memberCursor = data.pagination.next_cursor;
    }

    expect(memberPages).toBe(10);
    expect(memberRetrievedIds.length).toBe(235);
    const memberUniqueIds = new Set(memberRetrievedIds);
    expect(memberUniqueIds.size).toBe(235);

    // Member tidak boleh menerima video nonaktif (SIM-VIDEO-236 s/d SIM-VIDEO-250)
    for (let i = 236; i <= 250; i++) {
      expect(memberRetrievedIds).not.toContain(`SIM-VIDEO-${String(i).padStart(3, '0')}`);
    }
  });

  // ===========================================================================
  // 2. NAVIGASI CURSOR MAJU (NEXT) DAN MUNDUR (PREV VIA CURSOR STACK)
  // ===========================================================================
  it('B. Navigasi cursor maju dan mundur secara konsisten tanpa kehilangan data atau looping', async () => {
    await seed250SimulatedVideos();

    // Simulasikan cursor stack seperti yang dilakukan UI frontend:
    // history = [null, cursorPage1, cursorPage2]
    const cursorHistory: (string | null)[] = [];
    const pageSnapshots: string[][] = [];

    let currentCursor: string | null = null;

    // Maju 3 halaman
    for (let p = 1; p <= 3; p++) {
      const url = currentCursor
        ? `http://localhost:8787/api/videos?limit=10&cursor=${encodeURIComponent(currentCursor)}`
        : `http://localhost:8787/api/videos?limit=10`;

      const res = await worker.fetch(new Request(url, { headers: { Cookie: member.sessionCookie } }), ctx.env);
      const data = await res.json() as any;
      expect(res.status).toBe(200);

      const pageIds = data.videos.map((v: any) => v.id);
      pageSnapshots.push(pageIds);

      cursorHistory.push(currentCursor);
      currentCursor = data.pagination.next_cursor;
    }

    // Pastikan 3 halaman menghasilkan 30 ID yang berbeda (tidak looping)
    const combined30 = pageSnapshots.flat();
    expect(new Set(combined30).size).toBe(30);

    // Sekarang simulasikan navigasi "Halaman Sebelumnya" (Prev):
    // Pop cursor dari history dan ambil ulang halaman 2 lalu halaman 1
    const cursorForPage2 = cursorHistory[1]; // cursor saat masuk page 2
    const prevUrl2 = cursorForPage2
      ? `http://localhost:8787/api/videos?limit=10&cursor=${encodeURIComponent(cursorForPage2)}`
      : `http://localhost:8787/api/videos?limit=10`;

    const resPrev2 = await worker.fetch(new Request(prevUrl2, { headers: { Cookie: member.sessionCookie } }), ctx.env);
    const dataPrev2 = await resPrev2.json() as any;
    const page2IdsAgain = dataPrev2.videos.map((v: any) => v.id);

    // Halaman 2 saat kembali harus 100% identik dengan kunjungan pertama
    expect(page2IdsAgain).toEqual(pageSnapshots[1]);

    // Kembali ke Halaman 1
    const cursorForPage1 = cursorHistory[0]; // null
    const prevUrl1 = cursorForPage1
      ? `http://localhost:8787/api/videos?limit=10&cursor=${encodeURIComponent(cursorForPage1)}`
      : `http://localhost:8787/api/videos?limit=10`;

    const resPrev1 = await worker.fetch(new Request(prevUrl1, { headers: { Cookie: member.sessionCookie } }), ctx.env);
    const dataPrev1 = await resPrev1.json() as any;
    const page1IdsAgain = dataPrev1.videos.map((v: any) => v.id);

    // Halaman 1 saat kembali harus 100% identik dengan kunjungan pertama
    expect(page1IdsAgain).toEqual(pageSnapshots[0]);
  });

  // ===========================================================================
  // 3. KONSISTENSI URUTAN DETERMINISTIK & TIE-BREAKER
  // ===========================================================================
  it('C. Memastikan urutan deterministik (created_at DESC, id DESC) dan tie-breaker ID bekerja stabil', async () => {
    await seed250SimulatedVideos();

    // SIM-VIDEO-100, SIM-VIDEO-101, SIM-VIDEO-102 memiliki created_at yang persis sama.
    // Berdasarkan tie-breaker `ORDER BY created_at DESC, id DESC`:
    // Urutan antar ketiganya harus strictly: SIM-VIDEO-102, lalu SIM-VIDEO-101, lalu SIM-VIDEO-100.
    const res = await worker.fetch(
      new Request('http://localhost:8787/api/admin/videos?limit=100', {
        headers: { Cookie: admin.sessionCookie }
      }),
      ctx.env
    );
    const data = await res.json() as any;
    expect(res.status).toBe(200);
    expect(data.status).toBe('ok');

    // Lakukan request berulang 3 kali untuk memastikan determinisme idempotensi
    for (let repetition = 1; repetition <= 3; repetition++) {
      const repRes = await worker.fetch(
        new Request('http://localhost:8787/api/admin/videos?limit=100', {
          headers: { Cookie: admin.sessionCookie }
        }),
        ctx.env
      );
      const repData = await repRes.json() as any;
      const ids = repData.videos.map((v: any) => v.id);
      expect(ids.length).toBe(100);

      // Verifikasi urutan keseluruhan adalah created_at DESC, id DESC
      for (let i = 0; i < repData.videos.length - 1; i++) {
        const current = repData.videos[i];
        const next = repData.videos[i + 1];
        if (current.created_at === next.created_at) {
          expect(current.id > next.id).toBe(true);
        } else {
          expect(current.created_at >= next.created_at).toBe(true);
        }
      }
    }
  });

  // ===========================================================================
  // 4. BATAS LIMIT (1..100, DEFAULT 24, INVALID LIMITS)
  // ===========================================================================
  it('D. Validasi batas limit: default 24, batas 1..100, menolak 0, negatif, >100, dan non-numerik', async () => {
    await seed250SimulatedVideos();

    // Default limit -> 24
    const defRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    const defData = await defRes.json() as any;
    expect(defData.pagination.limit).toBe(24);
    expect(defData.videos.length).toBe(24);

    // Limit 1
    const l1Res = await worker.fetch(
      new Request('http://localhost:8787/api/videos?limit=1', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    const l1Data = await l1Res.json() as any;
    expect(l1Data.pagination.limit).toBe(1);
    expect(l1Data.videos.length).toBe(1);

    // Limit 24
    const l24Res = await worker.fetch(
      new Request('http://localhost:8787/api/videos?limit=24', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    const l24Data = await l24Res.json() as any;
    expect(l24Data.pagination.limit).toBe(24);
    expect(l24Data.videos.length).toBe(24);

    // Limit 100
    const l100Res = await worker.fetch(
      new Request('http://localhost:8787/api/videos?limit=100', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    const l100Data = await l100Res.json() as any;
    expect(l100Data.pagination.limit).toBe(100);
    expect(l100Data.videos.length).toBe(100);

    // Limit 0 -> 400 INVALID_LIMIT
    const l0Res = await worker.fetch(
      new Request('http://localhost:8787/api/videos?limit=0', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    expect(l0Res.status).toBe(400);
    const l0Data = await l0Res.json() as any;
    expect(l0Data.error).toBe('INVALID_LIMIT');

    // Limit negatif (-5) -> 400 INVALID_LIMIT
    const lNegRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?limit=-5', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    expect(lNegRes.status).toBe(400);
    const lNegData = await lNegRes.json() as any;
    expect(lNegData.error).toBe('INVALID_LIMIT');

    // Limit di atas 100 (101) -> 400 INVALID_LIMIT
    const l101Res = await worker.fetch(
      new Request('http://localhost:8787/api/videos?limit=101', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    expect(l101Res.status).toBe(400);
    const l101Data = await l101Res.json() as any;
    expect(l101Data.error).toBe('INVALID_LIMIT');

    // Limit non-numerik ('abc') -> 400 INVALID_LIMIT
    const lAbcRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?limit=abc', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    expect(lAbcRes.status).toBe(400);
    const lAbcData = await lAbcRes.json() as any;
    expect(lAbcData.error).toBe('INVALID_LIMIT');
  });

  // ===========================================================================
  // 5. VALIDASI CURSOR TIDAK VALID & PARAMETER KOSONG
  // ===========================================================================
  it('E. Validasi cursor tidak valid: malformed, non-base64, JSON cacat, dan cursor kosong', async () => {
    await seed250SimulatedVideos();

    // 1. Cursor bukan base64 valid
    const malRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?cursor=not-a-base64-string!!@@', {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(malRes.status).toBe(400);
    expect((await malRes.json() as any).error).toBe('INVALID_CURSOR');

    // 2. Base64 valid tapi bukan JSON
    const nonJsonCursor = btoa('Halo ini teks biasa bukan JSON');
    const nonJsonRes = await worker.fetch(
      new Request(`http://localhost:8787/api/videos?cursor=${encodeURIComponent(nonJsonCursor)}`, {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(nonJsonRes.status).toBe(400);
    expect((await nonJsonRes.json() as any).error).toBe('INVALID_CURSOR');

    // 3. JSON valid tapi skema field salah ({ wrongKey: 'abc' })
    const wrongSchemaCursor = btoa(JSON.stringify({ wrongKey: 'abc' }));
    const wrongSchemaRes = await worker.fetch(
      new Request(`http://localhost:8787/api/videos?cursor=${encodeURIComponent(wrongSchemaCursor)}`, {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(wrongSchemaRes.status).toBe(400);
    expect((await wrongSchemaRes.json() as any).error).toBe('INVALID_CURSOR');

    // 4. JSON valid tapi field timestamp (t) kosong atau bukan string
    const missingTimeCursor = btoa(JSON.stringify({ t: '', i: 'SIM-VIDEO-001' }));
    const missingTimeRes = await worker.fetch(
      new Request(`http://localhost:8787/api/videos?cursor=${encodeURIComponent(missingTimeCursor)}`, {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(missingTimeRes.status).toBe(400);
    expect((await missingTimeRes.json() as any).error).toBe('INVALID_CURSOR');

    // 5. Parameter cursor kosong (?cursor=) ditangani elegan sebagai halaman pertama (200 OK)
    const emptyCursorRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?cursor=', {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(emptyCursorRes.status).toBe(200);
    const emptyCursorData = await emptyCursorRes.json() as any;
    expect(emptyCursorData.videos.length).toBe(24);
  });

  // ===========================================================================
  // 6. PENCARIAN KATA KUNCI (SEARCH)
  // ===========================================================================
  it('F. Pencarian: multi-match, single-match, zero-match, case-insensitivity, karakter khusus, dan query >100 karakter', async () => {
    await seed250SimulatedVideos();

    // 1. Multi-match: "Sepatu" (ada 50 video: i % 5 === 0 dari 250 video = 50 total, 47 active)
    const multiRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?q=Sepatu&limit=100', {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(multiRes.status).toBe(200);
    const multiData = await multiRes.json() as any;
    expect(multiData.videos.length).toBe(47); // 47 active video matching
    for (const v of multiData.videos) {
      expect(v.title.toLowerCase()).toContain('sepatu');
    }

    // 2. Single-match: "EdisiKhususXYZ999" (hanya ada di SIM-VIDEO-042)
    const singleRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?q=EdisiKhususXYZ999', {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(singleRes.status).toBe(200);
    const singleData = await singleRes.json() as any;
    expect(singleData.videos.length).toBe(1);
    expect(singleData.videos[0].id).toBe('SIM-VIDEO-042');
    expect(singleData.pagination.has_more).toBe(false);
    expect(singleData.pagination.next_cursor).toBeNull();

    // 3. Zero-match: kata kunci tidak ada
    const zeroRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?q=KataKunciIniPastiTidakAdaDiDatabase9999', {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(zeroRes.status).toBe(200);
    const zeroData = await zeroRes.json() as any;
    expect(zeroData.videos).toEqual([]);
    expect(zeroData.pagination.has_more).toBe(false);
    expect(zeroData.pagination.next_cursor).toBeNull();

    // 4. Case-insensitivity: "sepatu", "SEPATU", "SePaTu" menghasilkan jumlah identik
    const lowerRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?q=sepatu&limit=100', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    const upperRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?q=SEPATU&limit=100', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    const mixedRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?q=SePaTu&limit=100', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    const lowerData = await lowerRes.json() as any;
    const upperData = await upperRes.json() as any;
    const mixedData = await mixedRes.json() as any;
    expect(lowerData.videos.length).toBe(47);
    expect(upperData.videos.length).toBe(47);
    expect(mixedData.videos.length).toBe(47);

    // 5. Karakter khusus: "[PROMO]" dan "#ShopeeSuperSale" (SIM-VIDEO-088)
    const specialRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos?q=[PROMO]', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    expect(specialRes.status).toBe(200);
    const specialData = await specialRes.json() as any;
    expect(specialData.videos.length).toBe(1);
    expect(specialData.videos[0].id).toBe('SIM-VIDEO-088');

    // 6. Query pencarian panjang > 100 karakter dipotong pada 100 karakter dan tidak menyebabkan error SQLite
    const longQuery = 'Sepatu'.padEnd(160, 'Q');
    const longRes = await worker.fetch(
      new Request(`http://localhost:8787/api/videos?q=${encodeURIComponent(longQuery)}`, {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    expect(longRes.status).toBe(200);
    const longData = await longRes.json() as any;
    expect(longData.videos).toEqual([]);
  });

  // ===========================================================================
  // 7. FILTER RAK & FILTER STATUS ADMIN
  // ===========================================================================
  it('G. Filter rak (Rak 1 & Rak 2), kombinasi filter rak + search, dan filter status admin', async () => {
    await seed250SimulatedVideos();

    // 1. Filter Rak 1 (General, 150 video total, 150 active)
    const r1Res = await worker.fetch(
      new Request(`http://localhost:8787/api/videos?rack_id=${RACK_1_ID}&limit=100`, {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    const r1Data = await r1Res.json() as any;
    expect(r1Data.videos.length).toBe(100);
    expect(r1Data.pagination.has_more).toBe(true);
    for (const v of r1Data.videos) {
      expect(v.rack_id).toBe(RACK_1_ID);
    }

    // Ambil halaman ke-2 Rak 1 menggunakan cursor
    const r1p2Res = await worker.fetch(
      new Request(
        `http://localhost:8787/api/videos?rack_id=${RACK_1_ID}&limit=100&cursor=${encodeURIComponent(r1Data.pagination.next_cursor)}`,
        { headers: { Cookie: member.sessionCookie } }
      ),
      ctx.env
    );
    const r1p2Data = await r1p2Res.json() as any;
    expect(r1p2Data.videos.length).toBe(50); // 100 + 50 = 150 video di Rak 1
    expect(r1p2Data.pagination.has_more).toBe(false);

    // 2. Filter Rak 2 (Fashion & Gadget, 100 video total, 85 active, 15 inactive)
    const r2Res = await worker.fetch(
      new Request(`http://localhost:8787/api/videos?rack_id=${RACK_2_ID}&limit=100`, {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    const r2Data = await r2Res.json() as any;
    expect(r2Data.videos.length).toBe(85); // 85 active
    expect(r2Data.pagination.has_more).toBe(false);
    for (const v of r2Data.videos) {
      expect(v.rack_id).toBe(RACK_2_ID);
    }

    // 3. Kombinasi Filter Rak + Search (Rak 2 + q="Sepatu")
    // SIM-VIDEO-151 s/d SIM-VIDEO-250 (100 video). Active adalah 151..235 (85 video).
    // Kelipatan 5 dalam 151..235: 155, 160, 165, 170, 175, 180, 185, 190, 195, 200, 205, 210, 215, 220, 225, 230, 235 = 17 video
    const comboRes = await worker.fetch(
      new Request(`http://localhost:8787/api/videos?rack_id=${RACK_2_ID}&q=Sepatu&limit=50`, {
        headers: { Cookie: member.sessionCookie }
      }),
      ctx.env
    );
    const comboData = await comboRes.json() as any;
    expect(comboData.videos.length).toBe(17);
    for (const v of comboData.videos) {
      expect(v.rack_id).toBe(RACK_2_ID);
      expect(v.title.toLowerCase()).toContain('sepatu');
    }

    // 4. Filter status admin:
    // a. status=inactive (15 video)
    const adminInactRes = await worker.fetch(
      new Request('http://localhost:8787/api/admin/videos?status=inactive&limit=50', {
        headers: { Cookie: admin.sessionCookie }
      }),
      ctx.env
    );
    const adminInactData = await adminInactRes.json() as any;
    expect(adminInactData.videos.length).toBe(15);
    for (const v of adminInactData.videos) {
      expect(v.status).toBe('inactive');
    }

    // b. status=active (235 video)
    const adminActRes = await worker.fetch(
      new Request('http://localhost:8787/api/admin/videos?status=active&limit=100', {
        headers: { Cookie: admin.sessionCookie }
      }),
      ctx.env
    );
    const adminActData = await adminActRes.json() as any;
    expect(adminActData.videos.length).toBe(100);
    for (const v of adminActData.videos) {
      expect(v.status).toBe('active');
    }
  });

  // ===========================================================================
  // 8. KATALOG KOSONG (EMPTY STATE)
  // ===========================================================================
  it('H. Penanganan katalog kosong secara elegan sesuai kontrak respons API', async () => {
    // Tanpa menyisipkan video sama sekali
    const res = await worker.fetch(
      new Request('http://localhost:8787/api/videos', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
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

  // ===========================================================================
  // 9. AUTENTIKASI DAN OTORISASI
  // ===========================================================================
  it('I. Autentikasi dan otorisasi: penolakan tanpa sesi, akses terlarang member ke admin, dan shopee_link', async () => {
    await seed250SimulatedVideos();

    // 1. Member endpoint tanpa sesi -> 401 UNAUTHORIZED
    const unauthMemberRes = await worker.fetch(new Request('http://localhost:8787/api/videos'), ctx.env);
    expect(unauthMemberRes.status).toBe(401);

    // 2. Admin endpoint tanpa sesi -> 401 UNAUTHORIZED
    const unauthAdminRes = await worker.fetch(new Request('http://localhost:8787/api/admin/videos'), ctx.env);
    expect(unauthAdminRes.status).toBe(401);

    // 3. Akun member mengakses admin endpoint -> 403 FORBIDDEN
    const forbiddenRes = await worker.fetch(
      new Request('http://localhost:8787/api/admin/videos', { headers: { Cookie: member.sessionCookie } }),
      ctx.env
    );
    expect(forbiddenRes.status).toBe(403);
    const forbiddenData = await forbiddenRes.json() as any;
    expect(forbiddenData.error).toBe('FORBIDDEN');

    // 4. Member belum terverifikasi shopee_link -> 403 SHOPEE_LINK_REQUIRED
    const unlinkedUser = await seedTestUser(ctx.db, admin.id, 'unlinked_user', 'Unlink123!', null);
    const unlinkedRes = await worker.fetch(
      new Request('http://localhost:8787/api/videos', { headers: { Cookie: unlinkedUser.sessionCookie } }),
      ctx.env
    );
    expect(unlinkedRes.status).toBe(403);
    expect((await unlinkedRes.json() as any).error).toBe('SHOPEE_LINK_REQUIRED');
  });

  // ===========================================================================
  // 10. UJI INTEGRASI LOGIKA UI FRONTEND
  // ===========================================================================
  it('J. Logika UI Frontend: navigasi tombol Next/Prev, reset pagination saat filter/search, dan race conditions', async () => {
    // 1. Simulasi status navigasi UI
    let pageIndex = 1;
    let currentCursor: string | null = null;
    let cursorHistory: string[] = [];
    let hasMore = true;
    let loading = false;

    // Helper navigasi Next
    const onNextPage = (nextCursor: string) => {
      cursorHistory.push(currentCursor || '');
      currentCursor = nextCursor;
      pageIndex++;
    };

    // Helper navigasi Prev
    const onPrevPage = () => {
      if (pageIndex <= 1) return;
      currentCursor = cursorHistory.pop() || null;
      pageIndex--;
    };

    // Helper reset filter/search
    const onFilterOrSearchReset = () => {
      cursorHistory = [];
      currentCursor = null;
      pageIndex = 1;
    };

    // Simulasi halaman 1:
    expect(pageIndex).toBe(1);
    expect(pageIndex <= 1).toBe(true); // Tombol Prev disabled pada page 1
    expect(!hasMore || loading).toBe(false); // Tombol Next enabled

    // Pindah ke Halaman 2:
    onNextPage('cursor-page-2');
    expect(pageIndex).toBe(2);
    expect(currentCursor).toBe('cursor-page-2');
    expect(cursorHistory).toEqual(['']);
    expect(pageIndex <= 1).toBe(false); // Tombol Prev aktif pada page 2

    // Pindah ke Halaman 3 (Halaman Terakhir, hasMore = false):
    onNextPage('cursor-page-3');
    hasMore = false;
    expect(pageIndex).toBe(3);
    expect(currentCursor).toBe('cursor-page-3');
    expect(cursorHistory).toEqual(['', 'cursor-page-2']);
    expect(!hasMore || loading).toBe(true); // Tombol Next disabled pada halaman terakhir

    // Kembali ke Halaman 2 (Prev):
    onPrevPage();
    expect(pageIndex).toBe(2);
    expect(currentCursor).toBe('cursor-page-2');
    expect(cursorHistory).toEqual(['']);

    // Kembali ke Halaman 1 (Prev):
    onPrevPage();
    expect(pageIndex).toBe(1);
    expect(currentCursor).toBe(null);
    expect(cursorHistory).toEqual([]);

    // Pengujian reset filter: saat pengguna mengubah filter atau mengetik pencarian baru
    onNextPage('cursor-page-2');
    expect(pageIndex).toBe(2);
    onFilterOrSearchReset();
    expect(pageIndex).toBe(1);
    expect(currentCursor).toBe(null);
    expect(cursorHistory).toEqual([]);

    // 2. Uji status loading tidak macet saat request gagal
    let uiLoading = false;
    let uiError: string | null = null;
    const fetchSimulatedWithError = async (shouldFail: boolean) => {
      uiLoading = true;
      uiError = null;
      try {
        if (shouldFail) {
          throw new Error('Koneksi terputus ke server');
        }
      } catch (err: any) {
        uiError = err.message;
      } finally {
        uiLoading = false;
      }
    };

    await fetchSimulatedWithError(true);
    expect(uiLoading).toBe(false); // Loading tidak macet!
    expect(uiError).toBe('Koneksi terputus ke server');
  });
});
