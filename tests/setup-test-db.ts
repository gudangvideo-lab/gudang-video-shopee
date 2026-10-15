/**
 * tests/setup-test-db.ts
 * Helper untuk membangun database D1 terisolasi menggunakan Miniflare in-memory
 * dan menerapkan migrasi 0001 dan 0002 tanpa mengubah data lokal proyek.
 */

import { Miniflare } from 'miniflare';
import { Env } from '../worker/types';
import { hashPassword, sha256, generateActivationCode, normalizeCode, generateRandomToken } from '../worker/crypto';
import { createSessionCookie, createDeviceCookie } from '../worker/cookies';

declare function require(name: string): any;
declare const process: any;

const fs = require('fs');
const path = require('path');

/**
 * Memecah skrip SQL menjadi statement individual, mengabaikan komentar
 * dan memperlakukan blok BEGIN ... END (seperti pada trigger) sebagai satu kesatuan.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let blockDepth = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1] || '';

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      current += char;
      if (char === "'") {
        if (next === "'") {
          current += next;
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (char === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }

    current += char;

    const wordMatch = current.match(/\b(BEGIN|END)\b$/i);
    if (wordMatch) {
      if (wordMatch[1].toUpperCase() === 'BEGIN') {
        blockDepth++;
      } else if (wordMatch[1].toUpperCase() === 'END') {
        blockDepth = Math.max(0, blockDepth - 1);
      }
    }

    if (char === ';' && blockDepth === 0) {
      const stmt = current.trim();
      if (stmt.length > 0 && stmt !== ';') {
        statements.push(stmt);
      }
      current = '';
    }
  }

  if (current.trim().length > 0 && current.trim() !== ';') {
    statements.push(current.trim());
  }
  return statements;
}

export interface TestContext {
  mf: Miniflare;
  db: D1Database;
  bucket?: R2Bucket;
  env: Env;
  cleanup: () => Promise<void>;
}

/**
 * Membuat instance D1 database in-memory dan R2 bucket bersih,
 * serta menerapkan migrasi 0001, 0002, dan 0003.
 */
export async function createIsolatedTestDb(): Promise<TestContext> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null); } }',
    d1Databases: { DB: 'test-isolated-db' },
    r2Buckets: { VIDEOS_BUCKET: 'test-videos-bucket' }
  });

  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const bucket = (await mf.getR2Bucket('VIDEOS_BUCKET')) as unknown as R2Bucket;

  const rootDir = process.cwd();
  const m1Path = path.join(rootDir, 'migrations', '0001_initial_schema.sql');
  const m2Path = path.join(rootDir, 'migrations', '0002_authentication_schema.sql');
  const m3Path = path.join(rootDir, 'migrations', '0003_videos_schema.sql');
  const m4Path = path.join(rootDir, 'migrations', '0004_three_tier_roles.sql');
  const m5Path = path.join(rootDir, 'migrations', '0005_shopee_account_approval.sql');

  const m1Sql = fs.readFileSync(m1Path, 'utf-8');
  const m2Sql = fs.readFileSync(m2Path, 'utf-8');
  const m3Sql = fs.readFileSync(m3Path, 'utf-8');
  const m4Sql = fs.readFileSync(m4Path, 'utf-8');
  const m5Sql = fs.readFileSync(m5Path, 'utf-8');

  const statements = [
    ...splitSqlStatements(m1Sql),
    ...splitSqlStatements(m2Sql),
    ...splitSqlStatements(m3Sql),
    ...splitSqlStatements(m4Sql),
    ...splitSqlStatements(m5Sql)
  ];

  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }

  const env: Env = {
    DB: db,
    VIDEOS_BUCKET: bucket,
    ENVIRONMENT: 'test'
  };

  const cleanup = async () => {
    await mf.dispose();
  };

  return { mf, db, bucket, env, cleanup };
}

/**
 * Membuat admin uji coba secara langsung di database (simulasi inisialisasi aman bootstrap).
 */
export async function seedTestAdmin(db: D1Database, username = 'admin_tester', password = 'AdminPassword123!'): Promise<{
  id: string;
  username: string;
  sessionCookie: string;
  rawSessionToken: string;
  deviceCookie: string;
  rawDeviceToken: string;
}> {
  const adminId = crypto.randomUUID();
  const { hash, salt } = await hashPassword(password);

  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, password_salt, role, status)
       VALUES (?, ?, ?, ?, 'admin', 'active')`
    )
    .bind(adminId, username, hash, salt)
    .run();

  const deviceId = crypto.randomUUID();
  const rawDeviceToken = generateRandomToken(32);
  const deviceTokenHash = await sha256(rawDeviceToken);

  await db
    .prepare(
      `INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active)
       VALUES (?, ?, ?, 'Admin Dev Machine', 1)`
    )
    .bind(deviceId, adminId, deviceTokenHash)
    .run();

  const sessionId = crypto.randomUUID();
  const rawSessionToken = generateRandomToken(32);
  const sessionTokenHash = await sha256(rawSessionToken);

  await db
    .prepare(
      `INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+30 days'))`
    )
    .bind(sessionId, adminId, deviceId, sessionTokenHash)
    .run();

  return {
    id: adminId,
    username,
    sessionCookie: createSessionCookie(rawSessionToken),
    rawSessionToken,
    deviceCookie: createDeviceCookie(rawDeviceToken),
    rawDeviceToken
  };
}

/**
 * Membuat admin uji coba murni tanpa perangkat (mensimulasikan hasil skrip bootstrap-admin.js).
 */
export async function seedTestAdminWithoutDevice(
  db: D1Database,
  username = 'admin_unbound',
  password = 'AdminPassword123!',
  status: 'active' | 'suspended' = 'active'
): Promise<{ id: string; username: string; password: string }> {
  const adminId = crypto.randomUUID();
  const { hash, salt } = await hashPassword(password);

  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, password_salt, role, status)
       VALUES (?, ?, ?, ?, 'admin', ?)`
    )
    .bind(adminId, username, hash, salt, status)
    .run();

  return { id: adminId, username, password };
}

/**
 * Membuat kode aktivasi uji coba yang valid di database.
 */
export async function seedTestActivationCode(
  db: D1Database,
  adminId: string,
  options: { customCode?: string; isExpired?: boolean; isUsed?: boolean } = {}
): Promise<{ id: string; code: string; codeHash: string }> {
  const codeId = crypto.randomUUID();
  const code = options.customCode || generateActivationCode();
  const cleanCode = normalizeCode(code);
  const codeHash = await sha256(cleanCode);

  const expiresModifier = options.isExpired ? "'-1 day'" : "'+30 days'";
  const status = options.isUsed ? 'used' : 'active';
  const usedCount = options.isUsed ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO activation_codes (id, code_hash, created_by, status, max_uses, used_count, expires_at)
       VALUES (?, ?, ?, ?, 1, ?, datetime('now', ${expiresModifier}))`
    )
    .bind(codeId, codeHash, adminId, status, usedCount)
    .run();

  return { id: codeId, code, codeHash };
}

/**
 * Membuat Super Admin uji coba secara langsung di database.
 */
export async function seedTestSuperAdmin(
  db: D1Database,
  username = 'super_admin_tester',
  password = 'SuperPassword123!'
): Promise<{
  id: string;
  username: string;
  sessionCookie: string;
  rawSessionToken: string;
  deviceCookie: string;
  rawDeviceToken: string;
}> {
  const superAdminId = crypto.randomUUID();
  const { hash, salt } = await hashPassword(password);

  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, password_salt, role, status)
       VALUES (?, ?, ?, ?, 'super_admin', 'active')`
    )
    .bind(superAdminId, username, hash, salt)
    .run();

  const deviceId = crypto.randomUUID();
  const rawDeviceToken = generateRandomToken(32);
  const deviceTokenHash = await sha256(rawDeviceToken);

  await db
    .prepare(
      `INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active)
       VALUES (?, ?, ?, 'SuperAdmin Primary Device', 1)`
    )
    .bind(deviceId, superAdminId, deviceTokenHash)
    .run();

  const sessionId = crypto.randomUUID();
  const rawSessionToken = generateRandomToken(32);
  const sessionTokenHash = await sha256(rawSessionToken);

  await db
    .prepare(
      `INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+30 days'))`
    )
    .bind(sessionId, superAdminId, deviceId, sessionTokenHash)
    .run();

  return {
    id: superAdminId,
    username,
    sessionCookie: createSessionCookie(rawSessionToken),
    rawSessionToken,
    deviceCookie: createDeviceCookie(rawDeviceToken),
    rawDeviceToken
  };
}

/**
 * Membuat user affiliate reguler (member) uji coba yang valid dengan perangkat dan sesi aktif.
 */
export async function seedTestUser(
  db: D1Database,
  adminId: string,
  username = 'member_tester',
  password = 'MemberPassword123!',
  shopeeLink: string | null = 'https://shope.ee/member_tester'
): Promise<{
  id: string;
  username: string;
  sessionCookie: string;
  rawSessionToken: string;
  deviceCookie: string;
  rawDeviceToken: string;
}> {
  // Buat kode aktivasi yang valid terlebih dahulu agar memenuhi trigger trg_enforce_valid_activation_code
  const codeId = crypto.randomUUID();
  const rawCode = generateActivationCode();
  const codeHash = await sha256(normalizeCode(rawCode));

  await db
    .prepare(
      `INSERT INTO activation_codes (id, code_hash, created_by, status, max_uses, used_count, expires_at)
       VALUES (?, ?, ?, 'active', 1, 0, datetime('now', '+30 days'))`
    )
    .bind(codeId, codeHash, adminId)
    .run();

  const userId = crypto.randomUUID();
  const { hash, salt } = await hashPassword(password);

  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, password_salt, role, status, activation_code_id, shopee_link)
       VALUES (?, ?, ?, ?, 'member', 'active', ?, ?)`
    )
    .bind(userId, username, hash, salt, codeId, shopeeLink)
    .run();

  await db
    .prepare(
      `UPDATE activation_codes
       SET status = 'used', used_count = 1, used_by_user_id = ?, used_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(userId, codeId)
    .run();

  const deviceId = crypto.randomUUID();
  const rawDeviceToken = generateRandomToken(32);
  const deviceTokenHash = await sha256(rawDeviceToken);

  await db
    .prepare(
      `INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active)
       VALUES (?, ?, ?, 'Member Browser', 1)`
    )
    .bind(deviceId, userId, deviceTokenHash)
    .run();

  const sessionId = crypto.randomUUID();
  const rawSessionToken = generateRandomToken(32);
  const sessionTokenHash = await sha256(rawSessionToken);

  await db
    .prepare(
      `INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+30 days'))`
    )
    .bind(sessionId, userId, deviceId, sessionTokenHash)
    .run();

  return {
    id: userId,
    username,
    sessionCookie: createSessionCookie(rawSessionToken),
    rawSessionToken,
    deviceCookie: createDeviceCookie(rawDeviceToken),
    rawDeviceToken
  };
}
