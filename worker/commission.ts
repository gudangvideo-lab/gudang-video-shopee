/**
 * worker/commission.ts
 * Handler untuk Fitur 9: Upload dan Penggantian Bukti Komisi Mingguan Member.
 *
 * Kebijakan Keamanan & Bisnis:
 * 1. Setiap Member hanya memiliki SATU bukti komisi aktif pada satu waktu (UNIQUE(user_id)).
 * 2. File bukti komisi disimpan privat di Cloudflare R2 dengan key acak (anti path-traversal).
 * 3. File yang diizinkan hanya gambar (JPEG, PNG, WebP) maksimal 5 MB dengan validasi magic bytes.
 * 4. Penggantian berkas menggunakan pola zero-loss: file baru diunggah & dicatat D1 dulu,
 *    baru file lama dihapus dari R2. Jika D1 gagal, file baru di-rollback.
 * 5. Member hanya dapat melihat file miliknya sendiri. Member TIDAK DAPAT menghapus bukti.
 * 6. Admin dan Super Admin dapat melihat semua bukti dan dapat menghapus bukti aktif member.
 */

import { Env } from './types';
import { jsonResponse, verifyCsrf, isValidUuid } from './security';
import { validateSession } from './session';
import { requireAdmin } from './admin';

export const MAX_COMMISSION_PROOF_SIZE = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface CommissionProofRow {
  id: string;
  user_id: string;
  r2_key: string;
  original_filename: string;
  file_size: number;
  content_type: string;
  uploaded_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Membersihkan nama berkas untuk Content-Disposition agar aman dari header injection.
 */
export function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[\x00-\x1f\\/:"*?<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.slice(0, 100) || 'bukti_komisi';
}

function getExtensionFromMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/jpeg':
    default:
      return '.jpg';
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
 * Memvalidasi magic bytes awal berkas gambar untuk mencegah penyamaran ekstensi (misal: malware berkedok .jpg).
 */
export function hasValidImageMagicBytes(buffer: ArrayBuffer, mime: string): boolean {
  if (buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer);

  if (mime === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === 'image/png') {
    if (buffer.byteLength < 8) return false;
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mime === 'image/webp') {
    if (buffer.byteLength < 12) return false;
    const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    return isRiff && isWebp;
  }
  return false;
}

/**
 * POST /api/member/commission-proof
 * Mengunggah atau mengganti bukti komisi mingguan aktif milik member.
 * Pola: Menggunakan atomic upsert. Jika sudah ada bukti, file baru menggantikan bukti lama
 * dan file lama dihapus dari R2 setelah transaksi D1 sukses.
 */
export async function handleUploadCommissionProof(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'DATABASE_UNAVAILABLE', message: 'Database D1 tidak terhubung.' }, 500);
  }

  const ctx = await validateSession(request, env.DB);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Sesi login tidak valid atau telah kedaluwarsa.' }, 401);
  }

  if (ctx.user.role !== 'member') {
    return jsonResponse({ error: 'FORBIDDEN', message: 'Hanya member yang dapat mengunggah bukti komisi.' }, 403);
  }

  if (ctx.user.status === 'suspended') {
    return jsonResponse({ error: 'ACCOUNT_SUSPENDED', message: 'Akun Anda dinonaktifkan.' }, 403);
  }

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!env.VIDEOS_BUCKET) {
    return jsonResponse({ error: 'STORAGE_UNAVAILABLE', message: 'Penyimpanan Cloudflare R2 tidak terhubung.' }, 500);
  }

  // Pre-check Content-Length untuk mencegah kehabisan memori isolate
  const contentLength = request.headers.get('Content-Length');
  if (contentLength) {
    const totalBytes = parseInt(contentLength, 10);
    if (!Number.isNaN(totalBytes) && totalBytes > MAX_COMMISSION_PROOF_SIZE + 64 * 1024) {
      return jsonResponse({
        error: 'FILE_TOO_LARGE',
        message: 'Ukuran file bukti komisi melebihi batas maksimum 5 MB.'
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
  if (!isUploadedFile(file) || file.size === 0) {
    return jsonResponse({
      error: 'FILE_EMPTY',
      message: 'File bukti komisi wajib diunggah dan tidak boleh kosong.'
    }, 400);
  }

  if (file.size > MAX_COMMISSION_PROOF_SIZE) {
    return jsonResponse({
      error: 'FILE_TOO_LARGE',
      message: `Ukuran file (${(file.size / (1024 * 1024)).toFixed(1)} MB) melebihi batas maksimum 5 MB.`
    }, 413);
  }

  const rawFilename = file.name || 'bukti.jpg';
  const dotIndex = rawFilename.lastIndexOf('.');
  const ext = dotIndex !== -1 ? rawFilename.slice(dotIndex).toLowerCase() : '';

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return jsonResponse({
      error: 'INVALID_FILE_EXTENSION',
      message: 'Format file tidak didukung. Harap gunakan format .jpg, .jpeg, .png, atau .webp.'
    }, 400);
  }

  const detectedMime = (file.type || '').toLowerCase();
  if (detectedMime && !ALLOWED_MIME_TYPES.has(detectedMime)) {
    return jsonResponse({
      error: 'INVALID_CONTENT_TYPE',
      message: 'Tipe konten file tidak valid. Hanya gambar JPEG, PNG, atau WebP yang diizinkan.'
    }, 400);
  }

  const safeContentType = detectedMime || (ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');

  const fileBuffer = await file.arrayBuffer();
  if (!hasValidImageMagicBytes(fileBuffer, safeContentType)) {
    return jsonResponse({
      error: 'INVALID_IMAGE_BINARY',
      message: 'File yang diunggah bukan merupakan file gambar yang valid.'
    }, 400);
  }

  // Periksa apakah member sudah memiliki bukti komisi aktif sebelumnya
  const existingProof = await env.DB
    .prepare('SELECT id, r2_key FROM commission_proofs WHERE user_id = ?')
    .bind(ctx.user.id)
    .first<{ id: string; r2_key: string }>();

  const isReplacement = !!existingProof;
  const newProofId = crypto.randomUUID();
  const fileExt = ext || getExtensionFromMime(safeContentType);
  const newR2Key = `commission-proofs/${ctx.user.id}/${newProofId}${fileExt}`;
  const cleanOriginalName = sanitizeFilename(rawFilename);

  // 1. Simpan file baru ke R2
  try {
    await env.VIDEOS_BUCKET.put(newR2Key, fileBuffer, {
      httpMetadata: {
        contentType: safeContentType
      },
      customMetadata: {
        proofId: newProofId,
        userId: ctx.user.id,
        originalName: cleanOriginalName
      }
    });
  } catch (r2Err) {
    return jsonResponse({
      error: 'STORAGE_WRITE_FAILED',
      message: `Gagal mengunggah file bukti komisi ke penyimpanan R2: ${r2Err instanceof Error ? r2Err.message : String(r2Err)}`
    }, 500);
  }

  // 2. Simpan atau perbarui metadata ke D1 secara atomik
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';
  const auditAction = isReplacement ? 'REPLACE_COMMISSION_PROOF' : 'UPLOAD_COMMISSION_PROOF';
  const auditDetails = isReplacement
    ? `Member "${ctx.user.username}" mengganti bukti komisi aktif dengan berkas baru "${cleanOriginalName}" (${file.size} bytes)`
    : `Member "${ctx.user.username}" mengunggah bukti komisi pertama kali "${cleanOriginalName}" (${file.size} bytes)`;

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO commission_proofs (
          id, user_id, r2_key, original_filename, file_size, content_type,
          uploaded_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          id = excluded.id,
          r2_key = excluded.r2_key,
          original_filename = excluded.original_filename,
          file_size = excluded.file_size,
          content_type = excluded.content_type,
          uploaded_by_user_id = excluded.uploaded_by_user_id,
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        newProofId,
        ctx.user.id,
        newR2Key,
        cleanOriginalName,
        file.size,
        safeContentType,
        ctx.user.id
      ),

      env.DB.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        auditId,
        ctx.user.id,
        auditAction,
        ctx.user.id,
        auditDetails,
        ipAddress,
        userAgent
      )
    ]);
  } catch (dbErr) {
    // Rollback file baru dari R2 jika penyimpanan D1 gagal
    try {
      await env.VIDEOS_BUCKET.delete(newR2Key);
    } catch {
      // Abaikan kegagalan delete rollback non-kritis
    }

    return jsonResponse({
      error: 'DATABASE_INSERT_FAILED',
      message: `Gagal mencatat metadata bukti komisi ke database: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`
    }, 500);
  }

  // 3. Setelah D1 berhasil menunjuk file baru, bersihkan file lama dari R2
  if (isReplacement && existingProof?.r2_key) {
    try {
      await env.VIDEOS_BUCKET.delete(existingProof.r2_key);
    } catch {
      // Kegagalan delete file lama tidak membatalkan bukti baru yang sudah aktif
    }
  }

  // Ambil metadata bukti komisi aktif terbaru
  const activeProof = await env.DB
    .prepare(`
      SELECT id, user_id, original_filename, file_size, content_type, created_at, updated_at
      FROM commission_proofs
      WHERE user_id = ?
    `)
    .bind(ctx.user.id)
    .first<Omit<CommissionProofRow, 'r2_key'>>();

  return jsonResponse({
    status: 'ok',
    message: isReplacement
      ? 'Bukti komisi berhasil diperbarui dengan berkas baru.'
      : 'Bukti komisi berhasil diunggah.',
    proof: activeProof
  }, 200);
}

/**
 * GET /api/member/commission-proof
 * Mengambil metadata bukti komisi aktif milik member yang sedang login.
 */
export async function handleGetMemberCommissionProof(request: Request, db: D1Database): Promise<Response> {
  const ctx = await validateSession(request, db);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Sesi login tidak valid atau telah kedaluwarsa.' }, 401);
  }

  if (ctx.user.role !== 'member') {
    return jsonResponse({ error: 'FORBIDDEN', message: 'Akses khusus member.' }, 403);
  }

  if (ctx.user.status === 'suspended') {
    return jsonResponse({ error: 'ACCOUNT_SUSPENDED', message: 'Akun Anda dinonaktifkan.' }, 403);
  }

  const proof = await db
    .prepare(`
      SELECT id, user_id, original_filename, file_size, content_type, created_at, updated_at
      FROM commission_proofs
      WHERE user_id = ?
    `)
    .bind(ctx.user.id)
    .first<Omit<CommissionProofRow, 'r2_key'>>();

  return jsonResponse({
    status: 'ok',
    proof: proof || null
  }, 200);
}

/**
 * GET /api/admin/users/:id/commission-proof
 * Mengambil metadata bukti komisi aktif milik member tertentu oleh Admin atau Super Admin.
 */
export async function handleGetAdminMemberCommissionProof(
  request: Request,
  db: D1Database,
  targetUserId: string
): Promise<Response> {
  const auth = await requireAdmin(request, db);
  if ('response' in auth) return auth.response;

  if (!isValidUuid(targetUserId)) {
    return jsonResponse({ error: 'INVALID_USER_ID', message: 'Format ID pengguna tidak valid.' }, 400);
  }

  const proof = await db
    .prepare(`
      SELECT id, user_id, original_filename, file_size, content_type, created_at, updated_at
      FROM commission_proofs
      WHERE user_id = ?
    `)
    .bind(targetUserId)
    .first<Omit<CommissionProofRow, 'r2_key'>>();

  return jsonResponse({
    status: 'ok',
    proof: proof || null
  }, 200);
}

/**
 * GET /api/commission-proofs/:id/file
 * Menampilkan atau mengunduh file gambar bukti komisi melalui streaming biner R2 privat.
 * Otorisasi: Member pemilik bukti komisi ATAU Administrator (Admin / Super Admin).
 */
export async function handleViewCommissionProofFile(
  request: Request,
  env: Env,
  proofId: string
): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'DATABASE_UNAVAILABLE', message: 'Database D1 tidak terhubung.' }, 500);
  }

  const ctx = await validateSession(request, env.DB);
  if (!ctx) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Sesi login tidak valid atau telah kedaluwarsa.' }, 401);
  }

  if (ctx.user.status === 'suspended') {
    return jsonResponse({ error: 'ACCOUNT_SUSPENDED', message: 'Akun Anda dinonaktifkan.' }, 403);
  }

  if (!isValidUuid(proofId)) {
    return jsonResponse({ error: 'INVALID_PROOF_ID', message: 'Format ID bukti komisi tidak valid.' }, 400);
  }

  const proof = await env.DB
    .prepare(`
      SELECT id, user_id, r2_key, original_filename, file_size, content_type
      FROM commission_proofs
      WHERE id = ?
    `)
    .bind(proofId)
    .first<Pick<CommissionProofRow, 'id' | 'user_id' | 'r2_key' | 'original_filename' | 'file_size' | 'content_type'>>();

  if (!proof) {
    return jsonResponse({ error: 'PROOF_NOT_FOUND', message: 'Bukti komisi tidak ditemukan.' }, 404);
  }

  // Otorisasi Akses: Member hanya boleh melihat miliknya sendiri, Admin/Super Admin boleh melihat semua
  if (ctx.user.role === 'member' && proof.user_id !== ctx.user.id) {
    return jsonResponse({
      error: 'FORBIDDEN',
      message: 'Anda tidak memiliki hak akses untuk melihat bukti komisi ini.'
    }, 403);
  }

  if (!env.VIDEOS_BUCKET) {
    return jsonResponse({ error: 'STORAGE_UNAVAILABLE', message: 'Penyimpanan Cloudflare R2 tidak terhubung.' }, 500);
  }

  const object = await env.VIDEOS_BUCKET.get(proof.r2_key);
  if (!object || !object.body) {
    return jsonResponse({
      error: 'OBJECT_NOT_FOUND',
      message: 'Objek file bukti komisi tidak ditemukan di penyimpanan R2.'
    }, 404);
  }

  const safeFilename = sanitizeFilename(proof.original_filename);
  const ext = getExtensionFromMime(proof.content_type);
  const inlineFilename = safeFilename.endsWith(ext) ? safeFilename : `${safeFilename}${ext}`;

  const headers = new Headers();
  headers.set('Content-Type', proof.content_type || 'image/jpeg');
  headers.set('Content-Length', String(proof.file_size));
  headers.set(
    'Content-Disposition',
    `inline; filename="${inlineFilename}"; filename*=UTF-8''${encodeURIComponent(inlineFilename)}`
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');

  return new Response(object.body, {
    status: 200,
    headers
  });
}

/**
 * DELETE /api/admin/users/:id/commission-proof
 * Menghapus bukti komisi aktif milik member tertentu oleh Admin atau Super Admin.
 * Member dilarang menghapus bukti secara langsung.
 */
export async function handleAdminDeleteCommissionProof(
  request: Request,
  env: Env,
  targetUserId: string
): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'DATABASE_UNAVAILABLE', message: 'Database D1 tidak terhubung.' }, 500);
  }

  const auth = await requireAdmin(request, env.DB);
  if ('response' in auth) return auth.response;

  if (!verifyCsrf(request)) {
    return jsonResponse({ error: 'CSRF_FORBIDDEN', message: 'Permintaan lintas situs diblokir.' }, 403);
  }

  if (!isValidUuid(targetUserId)) {
    return jsonResponse({ error: 'INVALID_USER_ID', message: 'Format ID pengguna tidak valid.' }, 400);
  }

  const targetUser = await env.DB
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .bind(targetUserId)
    .first<{ id: string; username: string; role: string }>();

  if (!targetUser) {
    return jsonResponse({ error: 'USER_NOT_FOUND', message: 'Pengguna tidak ditemukan.' }, 404);
  }

  const proof = await env.DB
    .prepare('SELECT id, r2_key, original_filename FROM commission_proofs WHERE user_id = ?')
    .bind(targetUserId)
    .first<{ id: string; r2_key: string; original_filename: string }>();

  if (!proof) {
    return jsonResponse({
      error: 'PROOF_NOT_FOUND',
      message: `Member "${targetUser.username}" belum memiliki bukti komisi aktif.`
    }, 404);
  }

  const actorRoleLabel = auth.ctx.user.role === 'super_admin' ? 'Super Admin' : 'Admin';
  const auditId = crypto.randomUUID();
  const ipAddress = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const userAgent = request.headers.get('User-Agent') || 'Unknown';

  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM commission_proofs WHERE user_id = ?').bind(targetUserId),
      env.DB.prepare(`
        INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent)
        VALUES (?, ?, 'DELETE_COMMISSION_PROOF', ?, ?, ?, ?)
      `).bind(
        auditId,
        auth.ctx.user.id,
        targetUserId,
        `${actorRoleLabel} "${auth.ctx.user.username}" menghapus bukti komisi aktif "${proof.original_filename}" milik Member "${targetUser.username}"`,
        ipAddress,
        userAgent
      )
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse({
      error: 'DELETE_PROOF_FAILED',
      message: `Gagal menghapus bukti komisi dari database: ${errorMsg}`
    }, 500);
  }

  // Hapus berkas dari R2
  if (env.VIDEOS_BUCKET && proof.r2_key) {
    try {
      await env.VIDEOS_BUCKET.delete(proof.r2_key);
    } catch {
      // Abaikan kegagalan R2 jika sudah terhapus di D1
    }
  }

  return jsonResponse({
    status: 'ok',
    message: `Bukti komisi aktif milik Member "${targetUser.username}" berhasil dihapus.`
  }, 200);
}
