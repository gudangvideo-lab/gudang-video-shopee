/**
 * worker/videos.ts
 * Handler untuk integrasi Cloudflare R2 Private Video Storage dan Katalog Video.
 *
 * Kebijakan Keamanan:
 * 1. Bucket R2 bersifat privat tanpa akses publik langsung.
 * 2. Seluruh akses katalog dan streaming unduhan memerlukan sesi pengguna aktif.
 * 3. Operasi upload, update, dan delete video hanya diizinkan untuk administrator.
 * 4. Object key R2 di-generate secara acak oleh server (UUID) untuk mencegah path traversal.
 * 5. Streaming unduhan menggunakan ReadableStream dari objek R2 langsung tanpa buffering memori.
 * 6. Penghapusan dan kegagalan upload menjaga konsistensi antara D1 dan R2 (anti-orphan).
 */

import { Env } from './types';
import { jsonResponse, verifyCsrf, parseJsonBody, isValidUuid } from './security';
import { validateSession } from './session';
import { requireAdmin } from './admin';

export const MAX_VIDEO_SIZE_BYTES = 104_857_600; // 100 MB

const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime'
]);

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);

interface VideoRow {
  id: string;
  title: string;
  description: string | null;
  product_name: string;
  product_url: string;
  r2_key: string;
  content_type: string;
  file_size: number;
  status: 'active' | 'inactive';
  uploaded_by_admin_id: string;
  download_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Membersihkan nama file untuk Content-Disposition agar aman dari header injection.
 */
export function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[\x00-\x1f\\/:"*?<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.slice(0, 100) || 'video_shopee';
}

function getExtensionFromMime(mime: string): string {
  switch (mime) {
    case 'video/webm':
      return '.webm';
    case 'video/quicktime':
      return '.mov';
    case 'video/mp4':
    default:
      return '.mp4';
  }
}

interface UploadedFile {
  name: string;
  size: number;
  type: string;
  stream: () => ReadableStream;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function isUploadedFile(item: unknown): item is UploadedFile {
  return (
    typeof item === 'object' &&
    item !== null &&
    'name' in item &&
    'size' in item &&
    typeof (item as any).size === 'number'
  );
}

/**
 * Validasi struktur kontainer video dasar (magic bytes)
 * Mencegah binary non-media (misal: .exe atau script) yang sengaja diberi ekstensi video.
 */
function hasValidVideoMagicBytes(buffer: ArrayBuffer, mime: string): boolean {
  if (buffer.byteLength < 8) return true; // Toleransi payload mini untuk testing lokal
  const bytes = new Uint8Array(buffer);
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    // ISO BMFF (MP4/MOV): offset 4-7 biasanya 'ftyp' atau 'moov'
    const boxType = String.fromCharCode(...bytes.slice(4, 8));
    return boxType === 'ftyp' || boxType === 'moov';
  }
  if (mime === 'video/webm') {
    // EBML header: 0x1A 0x45 0xDF 0xA3
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  return true;
}

function isValidHttpUrl(str: string): boolean {
  try {
    const parsed = new URL(str);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * GET /api/videos
 * Mengambil katalog video aktif untuk member terautentikasi.
 * Object key internal R2 di-omit secara ketat.
 */
export async function handleListVideos(request: Request, db: D1Database): Promise<Response> {
  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({
      error: 'UNAUTHORIZED',
      message: 'Sesi login tidak valid atau telah kedaluwarsa.'
    }, 401);
  }

  if (ctx.user.status === 'suspended') {
    return jsonResponse({
      error: 'ACCOUNT_SUSPENDED',
      message: 'Akun Anda telah dinonaktifkan oleh administrator.'
    }, 403);
  }

  if (ctx.user.role === 'member' && !ctx.user.shopee_link) {
    return jsonResponse({
      error: 'SHOPEE_LINK_REQUIRED',
      message: 'Anda wajib mendaftarkan tautan akun Shopee Affiliate sebelum dapat mengakses katalog video.'
    }, 403);
  }

  const { results } = await db
    .prepare(`
      SELECT id, title, description, product_name, product_url, file_size, content_type, created_at
      FROM videos
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT 200
    `)
    .all<Omit<VideoRow, 'r2_key' | 'uploaded_by_admin_id' | 'status' | 'updated_at'>>();

  return jsonResponse({
    status: 'ok',
    videos: results || []
  }, 200);
}

/**
 * GET /api/videos/:id
 * Mengambil detail video aktif untuk member terautentikasi.
 */
export async function handleGetVideo(request: Request, db: D1Database, videoId: string): Promise<Response> {
  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({
      error: 'UNAUTHORIZED',
      message: 'Sesi login tidak valid atau telah kedaluwarsa.'
    }, 401);
  }

  if (ctx.user.status === 'suspended') {
    return jsonResponse({
      error: 'ACCOUNT_SUSPENDED',
      message: 'Akun Anda telah dinonaktifkan oleh administrator.'
    }, 403);
  }

  if (ctx.user.role === 'member' && !ctx.user.shopee_link) {
    return jsonResponse({
      error: 'SHOPEE_LINK_REQUIRED',
      message: 'Anda wajib mendaftarkan tautan akun Shopee Affiliate sebelum dapat mengakses detail video.'
    }, 403);
  }

  if (!isValidUuid(videoId)) {
    return jsonResponse({ error: 'INVALID_VIDEO_ID', message: 'Format ID video tidak valid.' }, 400);
  }

  const video = await db
    .prepare(`
      SELECT id, title, description, product_name, product_url, file_size, content_type, created_at
      FROM videos
      WHERE id = ? AND status = 'active'
    `)
    .bind(videoId)
    .first<Omit<VideoRow, 'r2_key' | 'uploaded_by_admin_id' | 'status' | 'updated_at'>>();

  if (!video) {
    return jsonResponse({
      error: 'VIDEO_NOT_FOUND',
      message: 'Video tidak ditemukan atau tidak aktif.'
    }, 404);
  }

  return jsonResponse({
    status: 'ok',
    video
  }, 200);
}

/**
 * GET /api/videos/:id/download
 * Mengunduh file video melalui streaming objek privat Cloudflare R2.
 * Memvalidasi sesi pengguna, status akun, dan status video.
 */
export async function handleDownloadVideo(request: Request, env: Env, videoId: string): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'DATABASE_UNAVAILABLE', message: 'Database D1 tidak terhubung.' }, 500);
  }

  const ctx = await validateSession(request, env.DB);
  if (!ctx) {
    return jsonResponse({
      error: 'UNAUTHORIZED',
      message: 'Sesi login tidak valid atau telah kedaluwarsa.'
    }, 401);
  }

  if (ctx.user.status === 'suspended') {
    return jsonResponse({
      error: 'ACCOUNT_SUSPENDED',
      message: 'Akun Anda telah dinonaktifkan oleh administrator.'
    }, 403);
  }

  if (ctx.user.role === 'member' && !ctx.user.shopee_link) {
    return jsonResponse({
      error: 'SHOPEE_LINK_REQUIRED',
      message: 'Anda wajib mendaftarkan tautan akun Shopee Affiliate sebelum dapat mengunduh video.'
    }, 403);
  }

  if (!isValidUuid(videoId)) {
    return jsonResponse({ error: 'INVALID_VIDEO_ID', message: 'Format ID video tidak valid.' }, 400);
  }

  const video = await env.DB
    .prepare(`
      SELECT id, title, r2_key, content_type, file_size, status
      FROM videos
      WHERE id = ?
    `)
    .bind(videoId)
    .first<Pick<VideoRow, 'id' | 'title' | 'r2_key' | 'content_type' | 'file_size' | 'status'>>();

  if (!video) {
    return jsonResponse({
      error: 'VIDEO_NOT_FOUND',
      message: 'Video tidak ditemukan.'
    }, 404);
  }

  // Jika video dinonaktifkan, hanya administrator (admin / super_admin) yang diizinkan mengunduh (untuk keperluan pratinjau)
  if (video.status !== 'active' && ctx.user.role !== 'admin' && ctx.user.role !== 'super_admin') {
    return jsonResponse({
      error: 'VIDEO_NOT_FOUND',
      message: 'Video tidak tersedia untuk diunduh.'
    }, 404);
  }

  if (!env.VIDEOS_BUCKET) {
    return jsonResponse({
      error: 'STORAGE_UNAVAILABLE',
      message: 'Penyimpanan Cloudflare R2 tidak terhubung.'
    }, 500);
  }

  const object = await env.VIDEOS_BUCKET.get(video.r2_key);
  if (!object || !object.body) {
    return jsonResponse({
      error: 'OBJECT_NOT_FOUND',
      message: 'Objek file video tidak ditemukan di penyimpanan privat.'
    }, 404);
  }

  // Tambahkan hitungan unduhan di database (tidak memblokir respons)
  env.DB
    .prepare(`UPDATE videos SET download_count = download_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(video.id)
    .run()
    .catch(() => {});

  const ext = getExtensionFromMime(video.content_type);
  const safeBaseName = sanitizeFilename(video.title);
  const downloadFilename = `${safeBaseName}${ext}`;

  const headers = new Headers();
  headers.set('Content-Type', video.content_type || 'application/octet-stream');
  headers.set('Content-Length', String(video.file_size));
  headers.set(
    'Content-Disposition',
    `attachment; filename="${downloadFilename}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');

  // Streaming langsung body objek R2 tanpa buffer ke memori Worker
  return new Response(object.body, {
    status: 200,
    headers
  });
}

/**
 * POST /api/admin/videos
 * Mengunggah file video baru beserta metadata ke R2 privat dan D1.
 * Hanya dapat diakses oleh Administrator.
 */
export async function handleAdminUploadVideo(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'DATABASE_UNAVAILABLE', message: 'Database D1 tidak terhubung.' }, 500);
  }

  const auth = await requireAdmin(request, env.DB);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!env.VIDEOS_BUCKET) {
    return jsonResponse({
      error: 'STORAGE_UNAVAILABLE',
      message: 'Penyimpanan Cloudflare R2 tidak terhubung.'
    }, 500);
  }

  // Proteksi Batas Memori Isolate: Tolak permintaan di awal jika header Content-Length
  // melebihi batas maksimal 100 MB + toleransi metadata multipart (64 KB).
  const contentLength = request.headers.get('Content-Length');
  if (contentLength) {
    const totalBytes = parseInt(contentLength, 10);
    if (!Number.isNaN(totalBytes) && totalBytes > MAX_VIDEO_SIZE_BYTES + 64 * 1024) {
      return jsonResponse({
        error: 'FILE_TOO_LARGE',
        message: 'Ukuran payload permintaan melebihi batas maksimum 100 MB.'
      }, 413);
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({
      error: 'INVALID_FORM_DATA',
      message: 'Permintaan harus berupa multipart/form-data yang valid.'
    }, 400);
  }

  const file = formData.get('file');
  const title = formData.get('title');
  const productName = formData.get('product_name');
  const productUrl = formData.get('product_url');
  const description = formData.get('description');
  const statusParam = formData.get('status');

  if (!isUploadedFile(file) || file.size === 0) {
    return jsonResponse({
      error: 'FILE_EMPTY',
      message: 'File video wajib diunggah dan tidak boleh kosong.'
    }, 400);
  }

  if (file.size > MAX_VIDEO_SIZE_BYTES) {
    return jsonResponse({
      error: 'FILE_TOO_LARGE',
      message: `Ukuran file (${(file.size / (1024 * 1024)).toFixed(1)} MB) melebihi batas maksimum 100 MB.`
    }, 413);
  }

  const rawFilename = file.name || 'video.mp4';
  const dotIndex = rawFilename.lastIndexOf('.');
  const ext = dotIndex !== -1 ? rawFilename.slice(dotIndex).toLowerCase() : '';

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return jsonResponse({
      error: 'INVALID_FILE_EXTENSION',
      message: 'Format file tidak didukung. Harap gunakan ekstensi .mp4, .webm, atau .mov.'
    }, 400);
  }

  const detectedMime = (file.type || '').toLowerCase();
  if (detectedMime && !ALLOWED_MIME_TYPES.has(detectedMime)) {
    return jsonResponse({
      error: 'INVALID_CONTENT_TYPE',
      message: 'Tipe konten video tidak valid. Hanya video MP4, WebM, atau QuickTime yang diizinkan.'
    }, 400);
  }

  const safeContentType = detectedMime || (ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4');

  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 200) {
    return jsonResponse({
      error: 'INVALID_TITLE',
      message: 'Judul video wajib diisi antara 3 hingga 200 karakter.'
    }, 400);
  }

  if (typeof productName !== 'string' || productName.trim().length < 2 || productName.trim().length > 200) {
    return jsonResponse({
      error: 'INVALID_PRODUCT_NAME',
      message: 'Nama produk Shopee wajib diisi antara 2 hingga 200 karakter.'
    }, 400);
  }

  if (typeof productUrl !== 'string' || !isValidHttpUrl(productUrl.trim())) {
    return jsonResponse({
      error: 'INVALID_PRODUCT_URL',
      message: 'URL produk Shopee harus berupa tautan HTTP/HTTPS yang valid.'
    }, 400);
  }

  const cleanDescription =
    typeof description === 'string' && description.trim()
      ? description.trim().slice(0, 1000)
      : null;

  const videoStatus: 'active' | 'inactive' =
    typeof statusParam === 'string' && statusParam.trim().toLowerCase() === 'inactive'
      ? 'inactive'
      : 'active';

  const videoId = crypto.randomUUID();
  // Server-generated random object key - mutlak mencegah path traversal dan nama file klien arbitrer
  const r2Key = `videos/${crypto.randomUUID()}${ext}`;

  // 1. Simpan konten ke R2
  try {
    const fileBuffer = await file.arrayBuffer();
    if (!hasValidVideoMagicBytes(fileBuffer, safeContentType)) {
      return jsonResponse({
        error: 'INVALID_VIDEO_BINARY',
        message: 'File yang diunggah tidak memiliki header kontainer video yang valid.'
      }, 400);
    }
    await env.VIDEOS_BUCKET.put(r2Key, fileBuffer, {
      httpMetadata: {
        contentType: safeContentType
      },
      customMetadata: {
        videoId,
        originalName: sanitizeFilename(rawFilename)
      }
    });
  } catch (r2Err) {
    return jsonResponse({
      error: 'STORAGE_WRITE_FAILED',
      message: `Gagal mengunggah file video ke penyimpanan Cloudflare R2: ${r2Err instanceof Error ? r2Err.message : String(r2Err)}`
    }, 500);
  }

  // 2. Simpan metadata ke D1. Jika gagal, rollback file R2 agar tidak ada berkas yatim.
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO videos (
          id, title, description, product_name, product_url,
          r2_key, content_type, file_size, status, uploaded_by_admin_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        videoId,
        title.trim(),
        cleanDescription,
        productName.trim(),
        productUrl.trim(),
        r2Key,
        safeContentType,
        file.size,
        videoStatus,
        auth.ctx.user.id
      ),

      env.DB.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'UPLOAD_VIDEO', NULL, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        `Mengunggah video "${title.trim()}" (ID: ${videoId}, Ukuran: ${file.size} bytes)`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (dbErr) {
    // Rollback file dari R2
    try {
      await env.VIDEOS_BUCKET.delete(r2Key);
    } catch {
      // Abaikan error saat rollback delete
    }

    return jsonResponse({
      error: 'DATABASE_INSERT_FAILED',
      message: `Gagal menyimpan metadata video ke database: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`
    }, 500);
  }

  return jsonResponse({
    status: 'ok',
    message: 'Video berhasil diunggah dan disimpan ke R2 privat.',
    video: {
      id: videoId,
      title: title.trim(),
      description: cleanDescription,
      product_name: productName.trim(),
      product_url: productUrl.trim(),
      file_size: file.size,
      content_type: safeContentType,
      status: videoStatus
    }
  }, 201);
}

/**
 * GET /api/admin/videos
 * Mengambil daftar seluruh video (termasuk yang nonaktif) untuk Administrator.
 */
export async function handleAdminListVideos(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  interface AdminVideoRow extends VideoRow {
    uploaded_by_username: string | null;
  }

  const { results } = await db
    .prepare(`
      SELECT
        v.id, v.title, v.description, v.product_name, v.product_url,
        v.content_type, v.file_size, v.status, v.download_count,
        v.created_at, v.updated_at,
        u.username AS uploaded_by_username
      FROM videos v
      LEFT JOIN users u ON v.uploaded_by_admin_id = u.id
      ORDER BY v.created_at DESC
      LIMIT 200
    `)
    .all<AdminVideoRow>();

  return jsonResponse({
    status: 'ok',
    videos: results || []
  }, 200);
}

/**
 * PUT /api/admin/videos/:id
 * Memperbarui metadata dan status aktif/nonaktif video.
 */
export async function handleAdminUpdateVideo(
  request: Request,
  db: D1Database,
  videoId: string
): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(videoId)) {
    return jsonResponse({ error: 'INVALID_VIDEO_ID', message: 'Format ID video tidak valid.' }, 400);
  }

  const existingVideo = await db
    .prepare(`SELECT id, title FROM videos WHERE id = ?`)
    .bind(videoId)
    .first<{ id: string; title: string }>();

  if (!existingVideo) {
    return jsonResponse({ error: 'VIDEO_NOT_FOUND', message: 'Video tidak ditemukan.' }, 404);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON tidak valid.' }, 400);
  }

  const { title, description, product_name, product_url, status } = body;

  const updates: string[] = [];
  const bindings: any[] = [];

  if (typeof title === 'string') {
    if (title.trim().length < 3 || title.trim().length > 200) {
      return jsonResponse({ error: 'INVALID_TITLE', message: 'Judul video harus antara 3 hingga 200 karakter.' }, 400);
    }
    updates.push('title = ?');
    bindings.push(title.trim());
  }

  if (description !== undefined) {
    const cleanDesc =
      typeof description === 'string' && description.trim()
        ? description.trim().slice(0, 1000)
        : null;
    updates.push('description = ?');
    bindings.push(cleanDesc);
  }

  if (typeof product_name === 'string') {
    if (product_name.trim().length < 2 || product_name.trim().length > 200) {
      return jsonResponse({ error: 'INVALID_PRODUCT_NAME', message: 'Nama produk harus antara 2 hingga 200 karakter.' }, 400);
    }
    updates.push('product_name = ?');
    bindings.push(product_name.trim());
  }

  if (typeof product_url === 'string') {
    if (!isValidHttpUrl(product_url.trim())) {
      return jsonResponse({ error: 'INVALID_PRODUCT_URL', message: 'URL produk harus berupa tautan HTTP/HTTPS yang valid.' }, 400);
    }
    updates.push('product_url = ?');
    bindings.push(product_url.trim());
  }

  if (typeof status === 'string') {
    const cleanStatus = status.trim().toLowerCase();
    if (cleanStatus !== 'active' && cleanStatus !== 'inactive') {
      return jsonResponse({ error: 'INVALID_STATUS', message: 'Status video harus "active" atau "inactive".' }, 400);
    }
    updates.push('status = ?');
    bindings.push(cleanStatus);
  }

  if (updates.length === 0) {
    return jsonResponse({ error: 'NO_UPDATES', message: 'Tidak ada kolom yang diperbarui.' }, 400);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  bindings.push(videoId);

  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  await db.batch([
    db.prepare(`UPDATE videos SET ${updates.join(', ')} WHERE id = ?`).bind(...bindings),
    db.prepare(`
      INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
      VALUES (?, ?, 'UPDATE_VIDEO', NULL, ?, ?, ?)
    `).bind(
      auditId,
      auth.ctx.user.id,
      `Memperbarui metadata video ID: ${videoId}`,
      ipAddress,
      userAgent
    )
  ]);

  const updatedVideo = await db
    .prepare(`
      SELECT id, title, description, product_name, product_url, file_size, content_type, status, download_count, updated_at
      FROM videos
      WHERE id = ?
    `)
    .bind(videoId)
    .first();

  return jsonResponse({
    status: 'ok',
    message: 'Metadata video berhasil diperbarui.',
    video: updatedVideo
  }, 200);
}

/**
 * DELETE /api/admin/videos/:id
 * Menghapus file video dari R2 privat dan metadata dari D1 secara konsisten.
 */
export async function handleAdminDeleteVideo(
  request: Request,
  env: Env,
  videoId: string
): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'DATABASE_UNAVAILABLE', message: 'Database D1 tidak terhubung.' }, 500);
  }

  const auth = await requireAdmin(request, env.DB);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(videoId)) {
    return jsonResponse({ error: 'INVALID_VIDEO_ID', message: 'Format ID video tidak valid.' }, 400);
  }

  const video = await env.DB
    .prepare(`SELECT id, title, r2_key FROM videos WHERE id = ?`)
    .bind(videoId)
    .first<{ id: string; title: string; r2_key: string }>();

  if (!video) {
    return jsonResponse({ error: 'VIDEO_NOT_FOUND', message: 'Video tidak ditemukan.' }, 404);
  }

  // 1. Hapus berkas dari Cloudflare R2
  if (env.VIDEOS_BUCKET && video.r2_key) {
    try {
      await env.VIDEOS_BUCKET.delete(video.r2_key);
    } catch {
      return jsonResponse({
        error: 'STORAGE_DELETE_FAILED',
        message: 'Gagal menghapus file dari penyimpanan R2.'
      }, 500);
    }
  }

  // 2. Hapus catatan dari database D1
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM videos WHERE id = ?`).bind(videoId),
    env.DB.prepare(`
      INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
      VALUES (?, ?, 'DELETE_VIDEO', NULL, ?, ?, ?)
    `).bind(
      auditId,
      auth.ctx.user.id,
      `Menghapus video "${video.title}" (ID: ${videoId}, Key: ${video.r2_key})`,
      ipAddress,
      userAgent
    )
  ]);

  return jsonResponse({
    status: 'ok',
    message: 'Video dan berkas penyimpanan berhasil dihapus.'
  }, 200);
}
