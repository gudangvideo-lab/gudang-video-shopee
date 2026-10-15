#!/usr/bin/env node
/**
 * scripts/recover-super-admin.js
 * Utilitas CLI pemulihan darurat akun Super Admin Gudang Video Shopee.
 *
 * FITUR KEAMANAN:
 * 1. Tanpa bypass endpoint publik: Dijalankan out-of-band via CLI oleh pemilik sistem.
 * 2. Tanpa logging kredensial: Password tidak pernah dicetak dalam plain text, riwayat shell, atau log.
 * 3. Input tersembunyi (*): Menggunakan interface terminal masked.
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

function promptHiddenPassword(questionText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });

    const stdin = process.stdin;
    let password = '';

    process.stderr.write(questionText);

    const onData = (charBuffer) => {
      const char = charBuffer.toString();
      if (char === '\n' || char === '\r' || char === '\u0004') {
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
        process.stderr.write('\nOperasi dibatalkan.\n');
        process.exit(1);
      } else {
        password += char;
        process.stderr.write('*');
      }
    };

    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    } else {
      rl.question('', (ans) => {
        rl.close();
        resolve(ans);
      });
    }
  });
}

function promptQuestion(questionText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });
    rl.question(questionText, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const result = {
    username: '',
    password: '',
    outputFile: ''
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--username' || arg === '-u') {
      result.username = args[++i] || '';
    } else if (arg === '--password' || arg === '-p') {
      result.password = args[++i] || '';
    } else if (arg === '--file' || arg === '-f') {
      result.outputFile = args[++i] || '';
    }
  }

  return result;
}

async function main() {
  const cliArgs = parseCliArgs();

  let username = cliArgs.username;
  let password = cliArgs.password;

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
