/**
 * worker/shopee.ts
 * Penanganan pendaftaran akun Shopee awal, permohonan perubahan akun Shopee oleh member,
 * dan peninjauan (persetujuan/penolakan) permohonan oleh administrator.
 */

import { validateSession } from './session';
import {
  jsonResponse,
  verifyCsrf,
  parseJsonBody,
  isValidShopeeUrl,
  normalizeShopeeUrl,
  isValidUuid
} from './security';

interface ShopeeRequestRow {
  id: string;
  user_id: string;
  current_shopee_link: string | null;
  requested_shopee_link: string;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason: string | null;
  reviewed_by_admin_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MemberUserRow {
  id: string;
  username: string;
  status: string;
  shopee_link: string | null;
}

/**
 * POST /api/member/shopee-account/initial
 * Pendaftaran tautan Shopee awal bagi member lama atau member yang dibuat langsung tanpa tautan.
 */
export async function handleInitialShopeeLink(request: Request, db: D1Database): Promise<Response> {
  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Sesi login tidak valid atau telah kedaluwarsa.' }, 401);
  }

  if (ctx.user.role !== 'member') {
    return jsonResponse({ error: 'FORBIDDEN', message: 'Hanya member yang dapat mendaftarkan tautan Shopee.' }, 403);
  }

  if (ctx.user.status === 'suspended') {
    return jsonResponse({ error: 'ACCOUNT_SUSPENDED', message: 'Akun Anda dinonaktifkan.' }, 403);
  }

  // Jika member sudah memiliki tautan aktif, tidak boleh menggunakan endpoint inisialisasi awal
  if (ctx.user.shopee_link) {
    return jsonResponse({
      error: 'SHOPEE_LINK_ALREADY_SET',
      message: 'Akun Anda sudah memiliki tautan Shopee aktif. Silakan gunakan formulir pengajuan perubahan.'
    }, 400);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' }, 400);
  }

  const { shopee_link } = body;
  if (typeof shopee_link !== 'string' || !shopee_link.trim()) {
    return jsonResponse({ error: 'MISSING_SHOPEE_LINK', message: 'Tautan akun Shopee Affiliate wajib diisi.' }, 400);
  }

  if (!isValidShopeeUrl(shopee_link)) {
    return jsonResponse({
      error: 'INVALID_SHOPEE_LINK',
      message: 'Tautan Shopee tidak valid. Harap gunakan tautan resmi Shopee (contoh: https://shopee.co.id/... atau https://shope.ee/...).'
    }, 400);
  }

  const cleanShopeeLink = normalizeShopeeUrl(shopee_link);
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    const batchResults = await db.batch([
      db.prepare(`
        UPDATE users
        SET shopee_link = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND role = 'member' AND shopee_link IS NULL
      `).bind(cleanShopeeLink, ctx.user.id),

      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'SET_INITIAL_SHOPEE_LINK', ?, ?, ?, ?)
      `).bind(
        auditId,
        ctx.user.id,
        ctx.user.id,
        `Pendaftaran tautan Shopee awal oleh member: ${cleanShopeeLink}`,
        ipAddress,
        userAgent
      )
    ]);

    if (!batchResults[0].meta.changes || batchResults[0].meta.changes < 1) {
      return jsonResponse({
        error: 'SHOPEE_LINK_ALREADY_SET',
        message: 'Tautan Shopee sudah didaftarkan sebelumnya.'
      }, 400);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: 'DATABASE_ERROR', message: msg }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: 'Tautan akun Shopee berhasil didaftarkan.',
    shopee_link: cleanShopeeLink
  }, 200);
}

/**
 * POST /api/member/shopee-account/requests
 * Pengajuan perubahan tautan akun Shopee oleh member.
 */
export async function handleSubmitShopeeRequest(request: Request, db: D1Database): Promise<Response> {
  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Sesi login tidak valid atau telah kedaluwarsa.' }, 401);
  }

  if (ctx.user.role !== 'member') {
    return jsonResponse({ error: 'FORBIDDEN', message: 'Hanya member yang dapat mengajukan perubahan tautan Shopee.' }, 403);
  }

  if (ctx.user.status === 'suspended') {
    return jsonResponse({ error: 'ACCOUNT_SUSPENDED', message: 'Akun Anda dinonaktifkan.' }, 403);
  }

  // Member harus memiliki tautan aktif terlebih dahulu sebelum mengajukan perubahan
  if (!ctx.user.shopee_link) {
    return jsonResponse({
      error: 'INITIAL_LINK_REQUIRED',
      message: 'Anda harus menyelesaikan pendaftaran tautan Shopee awal terlebih dahulu.'
    }, 400);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' }, 400);
  }

  const { requested_shopee_link } = body;
  if (typeof requested_shopee_link !== 'string' || !requested_shopee_link.trim()) {
    return jsonResponse({ error: 'MISSING_SHOPEE_LINK', message: 'Tautan Shopee baru wajib diisi.' }, 400);
  }

  if (!isValidShopeeUrl(requested_shopee_link)) {
    return jsonResponse({
      error: 'INVALID_SHOPEE_LINK',
      message: 'Tautan Shopee tidak valid. Harap gunakan tautan resmi Shopee (contoh: https://shopee.co.id/... atau https://shope.ee/...).'
    }, 400);
  }

  const cleanNewLink = normalizeShopeeUrl(requested_shopee_link);
  if (ctx.user.shopee_link === cleanNewLink) {
    return jsonResponse({
      error: 'SAME_SHOPEE_LINK',
      message: 'Tautan Shopee baru tidak boleh sama dengan tautan yang saat ini aktif.'
    }, 400);
  }

  // Periksa apakah masih ada permohonan berstatus pending
  const existingPending = await db
    .prepare(`SELECT id FROM shopee_account_requests WHERE user_id = ? AND status = 'pending'`)
    .bind(ctx.user.id)
    .first<{ id: string }>();

  if (existingPending) {
    return jsonResponse({
      error: 'PENDING_REQUEST_EXISTS',
      message: 'Anda masih memiliki permohonan perubahan akun Shopee yang menunggu persetujuan admin. Harap tunggu keputusan admin.'
    }, 409);
  }

  const requestId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO shopee_account_requests (id, user_id, current_shopee_link, requested_shopee_link, status)
        VALUES (?, ?, ?, ?, 'pending')
      `).bind(requestId, ctx.user.id, ctx.user.shopee_link, cleanNewLink),

      db.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'REQUEST_SHOPEE_LINK_CHANGE', ?, ?, ?, ?)
      `).bind(
        auditId,
        ctx.user.id,
        ctx.user.id,
        `Pengajuan ubah link Shopee ke: ${cleanNewLink}`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('uq_shopee_requests_user_pending') || errorMsg.includes('UNIQUE constraint failed')) {
      return jsonResponse({
        error: 'PENDING_REQUEST_EXISTS',
        message: 'Anda masih memiliki permohonan perubahan akun Shopee yang menunggu persetujuan admin.'
      }, 409);
    }
    return jsonResponse({ error: 'DATABASE_ERROR', message: errorMsg }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: 'Permohonan perubahan akun Shopee berhasil diajukan dan sedang menunggu persetujuan admin.',
    data: {
      id: requestId,
      current_shopee_link: ctx.user.shopee_link,
      requested_shopee_link: cleanNewLink,
      status: 'pending'
    }
  }, 201);
}

/**
 * GET /api/member/shopee-account/requests
 * Riwayat permohonan perubahan akun Shopee milik member yang sedang login.
 */
export async function handleListMemberShopeeRequests(request: Request, db: D1Database): Promise<Response> {
  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Sesi login tidak valid atau telah kedaluwarsa.' }, 401);
  }

  if (ctx.user.role !== 'member') {
    return jsonResponse({ error: 'FORBIDDEN', message: 'Hanya member yang dapat melihat riwayat permohonan ini.' }, 403);
  }

  const { results } = await db
    .prepare(`
      SELECT
        id,
        user_id,
        current_shopee_link,
        requested_shopee_link,
        status,
        rejection_reason,
        reviewed_at,
        created_at,
        updated_at
      FROM shopee_account_requests
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `)
    .bind(ctx.user.id)
    .all<ShopeeRequestRow>();

  return jsonResponse({
    status: 'ok',
    requests: results || []
  }, 200);
}

/**
 * GET /api/admin/shopee-requests
 * Daftar seluruh permohonan perubahan akun Shopee untuk ditinjau oleh Admin & Super Admin.
 */
export async function handleAdminListShopeeRequests(request: Request, db: D1Database): Promise<Response> {
  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Sesi login tidak valid atau telah kedaluwarsa.' }, 401);
  }

  if (ctx.user.role !== 'admin' && ctx.user.role !== 'super_admin') {
    return jsonResponse({ error: 'FORBIDDEN', message: 'Akses khusus administrator.' }, 403);
  }

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status')?.trim().toLowerCase() || 'all';

  let query = `
    SELECT
      r.id,
      r.user_id,
      u.username,
      r.current_shopee_link,
      r.requested_shopee_link,
      r.status,
      r.rejection_reason,
      r.reviewed_by_admin_id,
      a.username AS reviewed_by_username,
      r.reviewed_at,
      r.created_at,
      r.updated_at
    FROM shopee_account_requests r
    JOIN users u ON r.user_id = u.id
    LEFT JOIN users a ON r.reviewed_by_admin_id = a.id
  `;

  const validStatuses = ['pending', 'approved', 'rejected'];
  if (validStatuses.includes(statusFilter)) {
    query += ` WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`;
    const { results } = await db.prepare(query).bind(statusFilter).all();
    return jsonResponse({ status: 'ok', requests: results || [] }, 200);
  }

  query += ` ORDER BY r.created_at DESC LIMIT 200`;
  const { results } = await db.prepare(query).all();
  return jsonResponse({ status: 'ok', requests: results || [] }, 200);
}

/**
 * POST /api/admin/shopee-requests/:id/review
 * Keputusan persetujuan atau penolakan permohonan perubahan akun Shopee.
 */
export async function handleAdminReviewShopeeRequest(
  request: Request,
  db: D1Database,
  requestId: string
): Promise<Response> {
  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Sesi login tidak valid atau telah kedaluwarsa.' }, 401);
  }

  if (ctx.user.role !== 'admin' && ctx.user.role !== 'super_admin') {
    return jsonResponse({ error: 'FORBIDDEN', message: 'Hanya administrator yang berwenang meninjau permohonan.' }, 403);
  }

  if (!isValidUuid(requestId)) {
    return jsonResponse({ error: 'INVALID_REQUEST_ID', message: 'Format ID permohonan tidak valid.' }, 400);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' }, 400);
  }

  const { action, rejection_reason } = body;
  if (action !== 'approve' && action !== 'reject') {
    return jsonResponse({
      error: 'INVALID_ACTION',
      message: "Tindakan harus bernilai 'approve' atau 'reject'."
    }, 400);
  }

  // Ambil permohonan
  const reqRow = await db
    .prepare(`SELECT id, user_id, current_shopee_link, requested_shopee_link, status FROM shopee_account_requests WHERE id = ?`)
    .bind(requestId)
    .first<ShopeeRequestRow>();

  if (!reqRow) {
    return jsonResponse({ error: 'REQUEST_NOT_FOUND', message: 'Permohonan tidak ditemukan.' }, 404);
  }

  if (reqRow.status !== 'pending') {
    return jsonResponse({
      error: 'ALREADY_PROCESSED',
      message: 'Permohonan ini telah diproses sebelumnya.'
    }, 409);
  }

  // Pastikan akun member pemohon masih ada dan statusnya aktif
  const memberUser = await db
    .prepare(`SELECT id, username, status, shopee_link FROM users WHERE id = ?`)
    .bind(reqRow.user_id)
    .first<MemberUserRow>();

  if (!memberUser) {
    return jsonResponse({
      error: 'MEMBER_NOT_FOUND',
      message: 'Akun member pemohon sudah tidak terdaftar di sistem.'
    }, 400);
  }

  if (memberUser.status !== 'active') {
    return jsonResponse({
      error: 'MEMBER_SUSPENDED',
      message: 'Akun member pemohon sedang dinonaktifkan (suspended).'
    }, 400);
  }

  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  if (action === 'approve') {
    try {
      const batchResults = await db.batch([
        // Stmt 1: Update status permohonan ke approved jika status masih pending (idempotent / race safety)
        db.prepare(`
          UPDATE shopee_account_requests
          SET status = 'approved',
              reviewed_by_admin_id = ?,
              reviewed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).bind(ctx.user.id, requestId),

        // Stmt 2: Perbarui link Shopee aktif member di tabel users
        db.prepare(`
          UPDATE users
          SET shopee_link = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(reqRow.requested_shopee_link, reqRow.user_id),

        // Stmt 3: Catat audit log persetujuan
        db.prepare(`
          INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
          VALUES (?, ?, 'APPROVE_SHOPEE_LINK_CHANGE', ?, ?, ?, ?)
        `).bind(
          auditId,
          ctx.user.id,
          reqRow.user_id,
          `Admin (${ctx.user.username}) menyetujui perubahan tautan Shopee untuk member (${memberUser.username}) dari '${reqRow.current_shopee_link || '-'}' ke '${reqRow.requested_shopee_link}' (Permohonan: ${requestId})`,
          ipAddress,
          userAgent
        )
      ]);

      if (!batchResults[0].meta.changes || batchResults[0].meta.changes < 1) {
        return jsonResponse({
          error: 'ALREADY_PROCESSED',
          message: 'Permohonan ini telah diproses oleh admin lain.'
        }, 409);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: 'DATABASE_ERROR', message: msg }, 500);
    }

    return jsonResponse({
      status: 'ok',
      message: 'Permohonan perubahan akun Shopee berhasil disetujui.',
      data: {
        id: requestId,
        status: 'approved',
        active_shopee_link: reqRow.requested_shopee_link
      }
    }, 200);
  } else {
    // action === 'reject'
    if (typeof rejection_reason !== 'string' || !rejection_reason.trim()) {
      return jsonResponse({
        error: 'MISSING_REJECTION_REASON',
        message: 'Alasan penolakan wajib diisi agar member memahami perbaikan yang diperlukan.'
      }, 400);
    }

    const cleanReason = rejection_reason.trim().slice(0, 500);

    try {
      const batchResults = await db.batch([
        // Stmt 1: Update status permohonan ke rejected jika status masih pending
        db.prepare(`
          UPDATE shopee_account_requests
          SET status = 'rejected',
              rejection_reason = ?,
              reviewed_by_admin_id = ?,
              reviewed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).bind(cleanReason, ctx.user.id, requestId),

        // Stmt 2: Catat audit log penolakan (link aktif TIDAK BERUBAH)
        db.prepare(`
          INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
          VALUES (?, ?, 'REJECT_SHOPEE_LINK_CHANGE', ?, ?, ?, ?)
        `).bind(
          auditId,
          ctx.user.id,
          reqRow.user_id,
          `Admin (${ctx.user.username}) menolak perubahan tautan Shopee untuk member (${memberUser.username}). Alasan: ${cleanReason} (Permohonan: ${requestId})`,
          ipAddress,
          userAgent
        )
      ]);

      if (!batchResults[0].meta.changes || batchResults[0].meta.changes < 1) {
        return jsonResponse({
          error: 'ALREADY_PROCESSED',
          message: 'Permohonan ini telah diproses oleh admin lain.'
        }, 409);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: 'DATABASE_ERROR', message: msg }, 500);
    }

    return jsonResponse({
      status: 'ok',
      message: 'Permohonan perubahan akun Shopee berhasil ditolak.',
      data: {
        id: requestId,
        status: 'rejected',
        rejection_reason: cleanReason
      }
    }, 200);
  }
}
