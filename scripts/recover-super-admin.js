#!/usr/bin/env node
/**
 * scripts/recover-super-admin.js
 * Utilitas CLI pemulihan darurat akun Super Admin Gudang Video Shopee.
 *
 * FITUR KEAMANAN:
 * 1. Tanpa bypass endpoint publik: Dijalankan out-of-band via CLI oleh pemilik sistem.
 * 2. Tanpa logging kredensial: Password tidak pernah dicetak dalam plain text, riwayat shell, atau log.
 * 3. Input tersembunyi (*): Menggunakan interface terminal masked. Opsi argumen CLI --password/-p dinonaktifkan.
 * 4. Algoritma identik aplikasi: PBKDF2-HMAC-SHA512 (10.000 iterasi), salt 16-byte CSPRNG.
 * 5. Proteksi role: Klausa SQL membatasi pembaruan HANYA untuk baris dengan role = 'super_admin'.
 * 6. Audit logging otomatis: Mencatat entri pemulihan ke tabel audit_logs.
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
 * Menghasilkan SQL pemulihan password akun Super Admin secara aman.
 */
export async function generateRecoverySuperAdminSql(username, newPassword) {
  if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,30}$/.test(username.trim())) {
    throw new Error('Username harus alfanumerik/underscore sepanjang 3-30 karakter.');
  }

  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 64) {
    throw new Error('Password baru minimal 8 karakter dan maksimal 64 karakter.');
  }

  const cleanUsername = username.trim();
  const auditId = crypto.randomUUID();
  const { hash, salt } = await hashPassword(newPassword);

  const sqlStatements = [
    `UPDATE users SET password_hash = '${hash}', password_salt = '${salt}', updated_at = CURRENT_TIMESTAMP WHERE username = '${cleanUsername}' AND role = 'super_admin';`,
    `INSERT INTO audit_logs (id, admin_id, action, target_user_id, details, ip_address, user_agent) SELECT '${auditId}', id, 'ACTIVATE_USER', id, 'Emergency Super Admin password recovery via CLI', '127.0.0.1', 'CLI-Recovery' FROM users WHERE username = '${cleanUsername}' AND role = 'super_admin';`
  ];

  return {
    username: cleanUsername,
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

    let password = '';
    process.stderr.write(questionText);

    const onData = (charBuffer) => {
      const char = charBuffer.toString();
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        rl.close();
        resolve(password);
      } else if (char === '\u0008' || char === '\x7f') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else if (char === '\u0003') {
        stdin.setRawMode(false);
        process.stderr.write('\nOperasi dibatalkan.\n');
        process.exit(130);
      } else {
        password += char;
        process.stderr.write('*');
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export function promptQuestion(questionText) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('TTY_REQUIRED: Masukkan username via opsi --username di lingkungan non-interaktif, atau jalankan di terminal interaktif.'));
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
 * Mengurai dan memvalidasi argumen CLI pemulihan super admin.
 * Opsi password via CLI argument (--password / --pass / -p) ditolak secara eksplisit
 * demi mencegah kebocoran password pada daftar proses OS dan shell history.
 */
export function parseRecoveryArgs(args = []) {
  let username = '';
  let outputFile = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();
    if (
      lower === '--password' ||
      lower === '--pass' ||
      lower === '--passwd' ||
      lower === '-p' ||
      lower.startsWith('--password=') ||
      lower.startsWith('--pass=') ||
      lower.startsWith('--passwd=') ||
      lower.startsWith('-p=')
    ) {
      throw new Error(
        'ARGUMENT_REJECTED: Opsi password via argumen CLI (--password / -p) dinonaktifkan demi keamanan. Silakan jalankan skrip tanpa argumen password untuk memasukkan password secara interaktif melalui prompt bertopeng.'
      );
    } else if (arg === '--username' || arg === '-u') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        throw new Error('ARGUMENT_ERROR: Opsi username memerlukan nilai yang valid.');
      }
      const val = args[++i].trim();
      if (!val) {
        throw new Error('ARGUMENT_ERROR: Nilai username tidak boleh kosong.');
      }
      username = val;
    } else if (arg.startsWith('--username=') || arg.startsWith('-u=')) {
      const eqIdx = arg.indexOf('=');
      const val = arg.slice(eqIdx + 1).trim();
      if (!val) {
        throw new Error('ARGUMENT_ERROR: Nilai username tidak boleh kosong.');
      }
      username = val;
    } else if (arg === '--file' || arg === '-f') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        throw new Error('ARGUMENT_ERROR: Opsi file memerlukan nilai path yang valid.');
      }
      const val = args[++i].trim();
      if (!val) {
        throw new Error('ARGUMENT_ERROR: Nilai path file tidak boleh kosong.');
      }
      outputFile = val;
    } else if (arg.startsWith('--file=') || arg.startsWith('-f=')) {
      const eqIdx = arg.indexOf('=');
      const val = arg.slice(eqIdx + 1).trim();
      if (!val) {
        throw new Error('ARGUMENT_ERROR: Nilai path file tidak boleh kosong.');
      }
      outputFile = val;
    } else if (arg.startsWith('-')) {
      throw new Error('ARGUMENT_ERROR: Opsi baris perintah tidak dikenal.');
    } else {
      throw new Error('ARGUMENT_ERROR: Argumen posisi tidak didukung. Harap gunakan opsi resmi yang diizinkan.');
    }
  }

  return { username, outputFile };
}

async function main() {
  let cliArgs;
  try {
    cliArgs = parseRecoveryArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`\n[ERROR KEAMANAN]: ${err.message}\n`);
    process.exit(1);
  }

  let username = cliArgs.username;
  let password = '';

  if (!username) {
    username = await promptQuestion('Masukkan username Super Admin yang akan dipulihkan: ');
  }

  if (!password) {
    const p1 = await promptHiddenPassword('Masukkan password baru: ');
    const p2 = await promptHiddenPassword('Konfirmasi password baru: ');
    if (p1 !== p2) {
      console.error('\n[ERROR] Password konfirmasi tidak cocok.');
      process.exit(1);
    }
    password = p1;
  }

  try {
    const { username: validUsername, fullSql } = await generateRecoverySuperAdminSql(username, password);

    console.error('\n=== SUPER ADMIN EMERGENCY RECOVERY SQL GENERATED ===');
    console.error(`Username target : ${validUsername}`);
    console.error(`Status          : Siap dieksekusi pada Cloudflare D1`);
    console.error(`Proteksi        : Hanya memperbarui baris jika role = 'super_admin'`);
    console.error('====================================================\n');

    if (cliArgs.outputFile) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(cliArgs.outputFile, fullSql, 'utf-8');
      console.error(`[INFO] SQL pemulihan berhasil ditulis ke: ${cliArgs.outputFile}`);
    } else {
      // Cetak SQL ke stdout sehingga dapat di-pipe ke wrangler atau file tanpa log password
      console.log(fullSql);
    }
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith('recover-super-admin.js') || process.argv[1].endsWith('recover-super-admin'))) {
  main();
}
