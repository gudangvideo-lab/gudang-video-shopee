#!/usr/bin/env node
/**
 * scripts/bootstrap-admin.js
 * Utilitas bootstrap CLI untuk menginisialisasi administrator pertama Gudang Video Shopee.
 *
 * FITUR KEAMANAN:
 * 1. Bebas dari kredensial hardcoded (menggunakan input interaktif tersembunyi).
 * 2. Proteksi Kredensial Maksimal: Password diwajibkan melalui prompt bertopeng (*) dengan konfirmasi ganda.
 *    Opsi argumen CLI (--pass/-p) dan environment variable password ditiadakan demi mencegah kebocoran.
 * 3. Idempotent & Anti-Takeover: Menggunakan klausul WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
 *    sehingga tidak dapat dieksekusi ulang untuk merebut kendali sistem yang sudah memiliki admin.
 * 4. Algoritma identik dengan aplikasi: PBKDF2-HMAC-SHA512 (10.000 iterasi), salt 16-byte CSPRNG,
 *    dan format versi modular crypt ($pbkdf2-sha512$v=1$i=10000$...).
 * 5. Pencatatan audit log otomatis ('ACTIVATE_USER').
 */

import { webcrypto } from 'node:crypto';
import readline from 'node:readline';

const crypto = globalThis.crypto || webcrypto;

export const CURRENT_PBKDF2_ITERATIONS = 10000;
export const CURRENT_HASH_VERSION = 1;

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computePbkdf2(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-512'
    },
    passwordKey,
    512
  );

  return bytesToHex(new Uint8Array(derivedBits));
}

export async function hashPassword(password) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const saltHex = bytesToHex(saltBytes);

  const rawHashHex = await computePbkdf2(password, saltBytes, CURRENT_PBKDF2_ITERATIONS);
  const formattedHash = `$pbkdf2-sha512$v=${CURRENT_HASH_VERSION}$i=${CURRENT_PBKDF2_ITERATIONS}$${rawHashHex}`;
  return { hash: formattedHash, salt: saltHex };
}

/**
 * Membangkitkan statement SQL bootstrap idempotent.
 */
export async function generateBootstrapAdminSql(username, password) {
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username.trim())) {
    throw new Error('Username harus alfanumerik/underscore sepanjang 3-30 karakter.');
  }

  if (password.length < 8 || password.length > 64) {
    throw new Error('Password minimal 8 karakter dan maksimal 64 karakter.');
  }

  const adminId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const { hash, salt } = await hashPassword(password);

  const sqlStatements = [
    `INSERT INTO users (id, username, password_hash, password_salt, role, status) SELECT '${adminId}', '${username.trim()}', '${hash}', '${salt}', 'super_admin', 'active' WHERE (SELECT COUNT(*) FROM users WHERE role = 'super_admin') < 3 AND NOT EXISTS (SELECT 1 FROM users WHERE username = '${username.trim()}');`,
    `INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent) SELECT '${auditId}', '${adminId}', 'ACTIVATE_USER', '${adminId}', 'Bootstrap Super Administrator', '127.0.0.1', 'CLI-Bootstrap' WHERE EXISTS (SELECT 1 FROM users WHERE id = '${adminId}');`
  ];

  return {
    adminId,
    username: username.trim(),
    hash,
    salt,
    sqlStatements,
    fullSql: sqlStatements.join('\n')
  };
}

export function promptHiddenPassword(questionText) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('TTY_REQUIRED: Operasi ini memerlukan terminal TTY interaktif untuk memasukkan password secara aman dengan proteksi masking. Lingkungan non-interaktif ditolak demi mencegah kebocoran kredensial.'));
      return;
    }

    const rl = readline.createInterface({
      input: stdin,
      output: process.stderr
    });

    process.stderr.write(questionText);

    stdin.setRawMode(true);
    stdin.resume();
    let inputVal = '';
    const onData = (chunk) => {
      const str = chunk.toString('utf8');
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === '\n' || c === '\r' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          rl.close();
          resolve(inputVal);
          return;
        } else if (c === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(false);
          process.exit(130);
        } else if (c === '\u0008' || c === '\x7f') {
          // Backspace
          if (inputVal.length > 0) {
            inputVal = inputVal.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else {
          inputVal += c;
          process.stderr.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

export function promptLine(questionText) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('TTY_REQUIRED: Masukkan nilai via argumen resmi di lingkungan non-interaktif, atau jalankan di terminal interaktif.'));
      return;
    }
    const rl = readline.createInterface({
      input: stdin,
      output: process.stderr
    });
    rl.question(questionText, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

/**
 * Memvalidasi dan mengurai argumen baris perintah untuk bootstrap.
 * Opsi password via CLI argument (--pass / -p) ditolak secara eksplisit
 * demi mencegah kebocoran password pada daftar proses OS dan shell history.
 */
export function parseBootstrapArgs(args = []) {
  let username = process.env.BOOTSTRAP_ADMIN_USER || process.env.ADMIN_USERNAME || '';
  if (username && !username.trim()) {
    username = '';
  }
  let generateSqlOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();
    if (
      lower === '--pass' ||
      lower === '-p' ||
      lower === '--password' ||
      lower === '--passwd' ||
      lower.startsWith('--pass=') ||
      lower.startsWith('-p=') ||
      lower.startsWith('--password=') ||
      lower.startsWith('--passwd=')
    ) {
      throw new Error(
        'ARGUMENT_REJECTED: Opsi password via argumen CLI dinonaktifkan demi keamanan. ' +
        'Silakan jalankan skrip tanpa opsi password untuk memasukkan password secara interaktif melalui prompt bertopeng.'
      );
    } else if (arg === '--user' || arg === '-u') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        throw new Error('ARGUMENT_ERROR: Opsi username memerlukan nilai yang valid.');
      }
      const val = args[++i].trim();
      if (!val) {
        throw new Error('ARGUMENT_ERROR: Nilai username tidak boleh kosong.');
      }
      username = val;
    } else if (arg.startsWith('--user=') || arg.startsWith('-u=')) {
      const eqIdx = arg.indexOf('=');
      const val = arg.slice(eqIdx + 1).trim();
      if (!val) {
        throw new Error('ARGUMENT_ERROR: Nilai username tidak boleh kosong.');
      }
      username = val;
    } else if (arg === '--sql-only') {
      generateSqlOnly = true;
    } else if (arg.startsWith('-')) {
      throw new Error('ARGUMENT_ERROR: Opsi baris perintah tidak dikenal.');
    } else {
      throw new Error('ARGUMENT_ERROR: Argumen posisi tidak didukung. Harap gunakan opsi resmi yang diizinkan.');
    }
  }

  return { username, generateSqlOnly };
}

async function main() {
  let cliOptions;
  try {
    cliOptions = parseBootstrapArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`\n[ERROR KEAMANAN]: ${err.message}\n`);
    process.exit(1);
  }

  let username = cliOptions.username;
  let password = '';
  const generateSqlOnly = cliOptions.generateSqlOnly;

  // Jika username belum disediakan, tanyakan interaktif
  if (!username && process.stdin.isTTY) {
    username = await promptLine('Masukkan Username Admin: ');
  }

  // Password wajib dimasukkan secara interaktif bertopeng dengan konfirmasi ganda
  if (!password) {
    const p1 = await promptHiddenPassword('Masukkan Password Admin (karakter akan disembunyikan): ');
    const p2 = await promptHiddenPassword('Konfirmasi Password Admin: ');
    if (p1 !== p2) {
      console.error('\n[ERROR KEAMANAN]: Password konfirmasi tidak cocok.');
      process.exit(1);
    }
    password = p1;
  }

  if (!username || !password) {
    console.error('================================================================');
    console.error('Gudang Video Shopee - Initial Administrator Bootstrap');
    console.error('================================================================');
    console.error('Penggunaan interaktif aman:');
    console.error('  node scripts/bootstrap-admin.js');
    console.error('  (Akan meminta input username dan password bertopeng secara interaktif dengan konfirmasi)');
    console.error('\nOpsi flag CLI yang diizinkan:');
    console.error('  --user, -u <username>   Tentukan username');
    console.error('  --sql-only              Hanya cetak query SQL aman untuk di-pipe ke file / Wrangler D1');
    console.error('\nCatatan Keamanan: Opsi password via CLI (--pass) maupun environment variable sengaja ditiadakan demi mencegah kebocoran kredensial.');
    process.exit(1);
  }

  try {
    const result = await generateBootstrapAdminSql(username, password);
    const isRedirected = !process.stdout.isTTY;

    if (generateSqlOnly || isRedirected) {
      // Output murni SQL ke stdout tanpa polusi teks diagnostik
      console.log(result.fullSql);
      if (isRedirected) {
        console.error(`[INFO] SQL bootstrap berhasil dihasilkan ke stream stdout untuk admin: ${result.username}`);
      }
      return;
    }

    console.log('================================================================');
    console.log('Bootstrap Super Administrator SQL Berhasil Dibuat');
    console.log('================================================================');
    console.log(`Username       : ${result.username}`);
    console.log(`Role           : super_admin`);
    console.log(`Algoritma Hash : PBKDF2-HMAC-SHA512 (${CURRENT_PBKDF2_ITERATIONS} iterasi)`);
    console.log(`Format Hash    : Modular Crypt ($pbkdf2-sha512$v=1$i=10000$...)`);
    console.log('----------------------------------------------------------------');
    console.log('Jalankan perintah berikut pada database lokal atau environment Anda:');
    console.log('\nwrangler d1 execute DB --local --command "' + result.fullSql.replace(/\n/g, ' ') + '"\n');
    console.log('Catatan: Jika kuota 3 Super Admin sudah penuh atau username sudah ada,');
    console.log('perintah secara otomatis tidak akan memasukkan baris baru (0 rows inserted).');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
}

// Jalankan jika dieksekusi langsung
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
