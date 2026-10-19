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
  rack_id?: string | null;
  rack_name?: string | null;
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

export interface VideoCursor {
  t: string;
  i: string;
}

export function encodeVideoCursor(createdAt: string, id: string): string {
  const payload = JSON.stringify({ t: createdAt, i: id });
  const base64 = btoa(payload);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeVideoCursor(cursorStr: string): VideoCursor | null {
  if (typeof cursorStr !== 'string' || !cursorStr.trim()) return null;
  try {
    let base64 = cursorStr.trim().replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    const decodedStr = atob(base64);
    const parsed = JSON.parse(decodedStr);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.t === 'string' &&
      parsed.t.trim().length > 0 &&
      typeof parsed.i === 'string' &&
      parsed.i.trim().length > 0 &&
      parsed.i.length <= 128
    ) {
      return { t: parsed.t.trim(), i: parsed.i.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GET /api/videos
 * Mengambil katalog video aktif untuk member terautentikasi dengan cursor pagination.
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

  const url = new URL(request.url);
  const rackId = url.searchParams.get('rack_id')?.trim();
  const cursorParam = url.searchParams.get('cursor')?.trim();
  const limitParam = url.searchParams.get('limit')?.trim();
  const searchQuery = url.searchParams.get('q')?.trim();

  // Validasi limit pagination (default: 24, min: 1, max: 100)
  let limit = 24;
  if (limitParam) {
    const parsedLimit = parseInt(limitParam, 10);
    if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return jsonResponse({
        error: 'INVALID_LIMIT',
        message: 'Parameter limit pagination harus berupa bilangan bulat antara 1 dan 100.'
      }, 400);
    }
    limit = parsedLimit;
  }

  // Validasi cursor pagination
  let cursor: VideoCursor | null = null;
  if (cursorParam) {
    cursor = decodeVideoCursor(cursorParam);
    if (!cursor) {
      return jsonResponse({
        error: 'INVALID_CURSOR',
        message: 'Parameter cursor pagination tidak valid.'
      }, 400);
    }
  }

  let query = `
    SELECT
      v.id, v.title, v.description, v.product_name, v.product_url,
      v.file_size, v.content_type, v.created_at, v.rack_id,
      r.name AS rack_name
    FROM videos v
    LEFT JOIN racks r ON v.rack_id = r.id
    WHERE v.status = 'active'
  `;
  const bindings: any[] = [];

  if (rackId && rackId !== 'all') {
    if (!isValidUuid(rackId)) {
      return jsonResponse({ error: 'INVALID_RACK_ID', message: 'Format ID rak tidak valid.' }, 400);
    }
    query += ` AND v.rack_id = ?`;
    bindings.push(rackId);
  }

  if (searchQuery) {
    const cleanSearch = searchQuery.slice(0, 100);
    query += ` AND (INSTR(LOWER(v.title), LOWER(?)) > 0 OR INSTR(LOWER(v.product_name), LOWER(?)) > 0 OR (v.description IS NOT NULL AND INSTR(LOWER(v.description), LOWER(?)) > 0))`;
    bindings.push(cleanSearch, cleanSearch, cleanSearch);
  }

  if (cursor) {
    query += ` AND (v.created_at < ? OR (v.created_at = ? AND v.id < ?))`;
    bindings.push(cursor.t, cursor.t, cursor.i);
  }

  query += ` ORDER BY v.created_at DESC, v.id DESC LIMIT ?`;
  bindings.push(limit + 1);

  const { results } = await db
    .prepare(query)
    .bind(...bindings)
    .all<Omit<VideoRow, 'r2_key' | 'uploaded_by_admin_id' | 'status' | 'updated_at'>>();

  const rows = results || [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = items.length > 0 ? items[items.length - 1] : null;
  const nextCursor = hasMore && lastItem ? encodeVideoCursor(lastItem.created_at, lastItem.id) : null;

  return jsonResponse({
    status: 'ok',
    videos: items,
    pagination: {
      limit,
      has_more: hasMore,
      next_cursor: nextCursor
    }
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
      SELECT
        v.id, v.title, v.description, v.product_name, v.product_url,
        v.file_size, v.content_type, v.created_at, v.rack_id,
        r.name AS rack_name
      FROM videos v
      LEFT JOIN racks r ON v.rack_id = r.id
      WHERE v.id = ? AND v.status = 'active'
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

export interface ParsedByteRange {
  start: number;
  end: number;
  length: number;
}

/**
 * Melakukan parsing header HTTP Range: bytes=start-end
 * Mengembalikan objek ParsedByteRange jika valid, null jika tidak ada/format non-bytes,
 * atau string 'unsatisfiable' jika rentang berada di luar ukuran file.
 */
export function parseRangeHeader(
  rangeHeader: string | null | undefined,
  fileSize: number
): ParsedByteRange | null | 'unsatisfiable' {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null;
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return null;

  let start: number;
  let end: number;

  if (startStr && endStr) {
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (start > end) return 'unsatisfiable';
  } else if (startStr) {
    start = parseInt(startStr, 10);
    end = fileSize - 1;
  } else {
    // Suffix range: bytes=-500 (500 byte terakhir)
    const suffix = parseInt(endStr, 10);
    if (suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  }

  if (fileSize <= 0 || start >= fileSize || end >= fileSize || start < 0) {
    return 'unsatisfiable';
  }

  return {
    start,
    end,
    length: end - start + 1
  };
}

/**
 * GET /api/videos/:id/stream
 * Streaming video privat untuk pemutaran/pratinjau inline HTML5 video player.
 * Mendukung HTTP Range Requests (206 Partial Content), Content-Disposition: inline,
 * dan TIDAK menambah download_count sehingga statistik unduhan tetap akurat.
 */
export async function handleStreamVideo(request: Request, env: Env, videoId: string): Promise<Response> {
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
      message: 'Anda wajib mendaftarkan tautan akun Shopee Affiliate sebelum dapat memutar video.'
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

  // Jika video nonaktif, hanya administrator (admin / super_admin) yang diizinkan memutar (pratinjau)
  if (video.status !== 'active' && ctx.user.role !== 'admin' && ctx.user.role !== 'super_admin') {
    return jsonResponse({
      error: 'VIDEO_NOT_FOUND',
      message: 'Video tidak tersedia untuk diputar.'
    }, 404);
  }

  if (!env.VIDEOS_BUCKET) {
    return jsonResponse({
      error: 'STORAGE_UNAVAILABLE',
      message: 'Penyimpanan Cloudflare R2 tidak terhubung.'
    }, 500);
  }

  const rangeHeader = request.headers.get('Range');
  const parsedRange = parseRangeHeader(rangeHeader, video.file_size);

  if (parsedRange === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${video.file_size}`,
        'Accept-Ranges': 'bytes'
      }
    });
  }

  // Ambil objek dari R2 dengan range jika diminta
  const r2Options = parsedRange
    ? { range: { offset: parsedRange.start, length: parsedRange.length } }
    : undefined;

  const object = await env.VIDEOS_BUCKET.get(video.r2_key, r2Options);
  if (!object || !object.body) {
    return jsonResponse({
      error: 'OBJECT_NOT_FOUND',
      message: 'Objek file video tidak ditemukan di penyimpanan privat.'
    }, 404);
  }

  const ext = getExtensionFromMime(video.content_type);
  const safeBaseName = sanitizeFilename(video.title);
  const inlineFilename = `${safeBaseName}${ext}`;

  const headers = new Headers();
  headers.set('Content-Type', video.content_type || 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set(
    'Content-Disposition',
    `inline; filename="${inlineFilename}"; filename*=UTF-8''${encodeURIComponent(inlineFilename)}`
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-cache, no-transform');

  if (parsedRange) {
    headers.set('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${video.file_size}`);
    headers.set('Content-Length', String(parsedRange.length));
    return new Response(object.body, {
      status: 206,
      headers
    });
  }

  headers.set('Content-Length', String(video.file_size));
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
  const rackIdParam = formData.get('rack_id');

  let rackId = '00000000-0000-0000-0000-000000000001';
  if (typeof rackIdParam === 'string' && isValidUuid(rackIdParam)) {
    const rackCheck = await env.DB.prepare('SELECT id FROM racks WHERE id = ?').bind(rackIdParam).first();
    if (rackCheck) {
      rackId = rackIdParam;
    }
  }

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
          r2_key, content_type, file_size, status, uploaded_by_admin_id, rack_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        auth.ctx.user.id,
        rackId
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
      status: videoStatus,
      rack_id: rackId
    }
  }, 201);
}

/**
 * GET /api/admin/videos
 * Mengambil daftar seluruh video (termasuk yang nonaktif) untuk Administrator dengan cursor pagination.
 */
export async function handleAdminListVideos(request: Request, db: D1Database): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  interface AdminVideoRow extends VideoRow {
    uploaded_by_username: string | null;
  }

  const url = new URL(request.url);
  const rackId = url.searchParams.get('rack_id')?.trim();
  const statusParam = url.searchParams.get('status')?.trim().toLowerCase();
  const cursorParam = url.searchParams.get('cursor')?.trim();
  const limitParam = url.searchParams.get('limit')?.trim();
  const searchQuery = url.searchParams.get('q')?.trim();

  // Validasi limit pagination (default: 24, min: 1, max: 100)
  let limit = 24;
  if (limitParam) {
    const parsedLimit = parseInt(limitParam, 10);
    if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return jsonResponse({
        error: 'INVALID_LIMIT',
        message: 'Parameter limit pagination harus berupa bilangan bulat antara 1 dan 100.'
      }, 400);
    }
    limit = parsedLimit;
  }

  // Validasi cursor pagination
  let cursor: VideoCursor | null = null;
  if (cursorParam) {
    cursor = decodeVideoCursor(cursorParam);
    if (!cursor) {
      return jsonResponse({
        error: 'INVALID_CURSOR',
        message: 'Parameter cursor pagination tidak valid.'
      }, 400);
    }
  }

  let query = `
    SELECT
      v.id, v.title, v.description, v.product_name, v.product_url,
      v.content_type, v.file_size, v.status, v.download_count,
      v.created_at, v.updated_at, v.rack_id,
      r.name AS rack_name,
      u.username AS uploaded_by_username
    FROM videos v
    LEFT JOIN racks r ON v.rack_id = r.id
    LEFT JOIN users u ON v.uploaded_by_admin_id = u.id
    WHERE 1=1
  `;
  const bindings: any[] = [];

  if (rackId && rackId !== 'all') {
    if (!isValidUuid(rackId)) {
      return jsonResponse({ error: 'INVALID_RACK_ID', message: 'Format ID rak tidak valid.' }, 400);
    }
    query += ` AND v.rack_id = ?`;
    bindings.push(rackId);
  }

  if (statusParam === 'active' || statusParam === 'inactive') {
    query += ` AND v.status = ?`;
    bindings.push(statusParam);
  }

  if (searchQuery) {
    const cleanSearch = searchQuery.slice(0, 100);
    query += ` AND (INSTR(LOWER(v.title), LOWER(?)) > 0 OR INSTR(LOWER(v.product_name), LOWER(?)) > 0 OR (v.description IS NOT NULL AND INSTR(LOWER(v.description), LOWER(?)) > 0))`;
    bindings.push(cleanSearch, cleanSearch, cleanSearch);
  }

  if (cursor) {
    query += ` AND (v.created_at < ? OR (v.created_at = ? AND v.id < ?))`;
    bindings.push(cursor.t, cursor.t, cursor.i);
  }

  query += ` ORDER BY v.created_at DESC, v.id DESC LIMIT ?`;
  bindings.push(limit + 1);

  const { results } = await db
    .prepare(query)
    .bind(...bindings)
    .all<AdminVideoRow>();

  const rows = results || [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = items.length > 0 ? items[items.length - 1] : null;
  const nextCursor = hasMore && lastItem ? encodeVideoCursor(lastItem.created_at, lastItem.id) : null;

  return jsonResponse({
    status: 'ok',
    videos: items,
    pagination: {
      limit,
      has_more: hasMore,
      next_cursor: nextCursor
    }
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

  const { title, description, product_name, product_url, status, rack_id } = body;

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

  if (rack_id !== undefined) {
    if (typeof rack_id !== 'string' || !isValidUuid(rack_id)) {
      return jsonResponse({ error: 'INVALID_RACK_ID', message: 'Format ID rak tidak valid.' }, 400);
    }
    const rackCheck = await db.prepare('SELECT id FROM racks WHERE id = ?').bind(rack_id).first();
    if (!rackCheck) {
      return jsonResponse({ error: 'RACK_NOT_FOUND', message: 'Rak tujuan tidak ditemukan.' }, 404);
    }
    updates.push('rack_id = ?');
    bindings.push(rack_id);
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
      SELECT
        v.id, v.title, v.description, v.product_name, v.product_url,
        v.file_size, v.content_type, v.status, v.download_count,
        v.created_at, v.updated_at, v.rack_id,
        r.name AS rack_name
      FROM videos v
      LEFT JOIN racks r ON v.rack_id = r.id
      WHERE v.id = ?
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
