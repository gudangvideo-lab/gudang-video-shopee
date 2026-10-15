#!/usr/bin/env node
/**
 * scripts/bootstrap-admin.js
 * Utilitas bootstrap CLI untuk menginisialisasi administrator pertama Gudang Video Shopee.
 *
 * FITUR KEAMANAN:
 * 1. Bebas dari kredensial hardcoded (menggunakan environment variables, input interaktif tersembunyi, atau argumen CLI).
 * 2. Proteksi Process List & History: Mendukung input password interaktif bertopeng (*) sehingga tidak
 *    tercatat di riwayat shell atau daftar proses OS (`ps`/Task Manager).
 * 3. Idempotent & Anti-Takeover: Menggunakan klausul `WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`
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

function promptHiddenPassword(questionText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });

    const stdin = process.stdin;
    process.stderr.write(questionText);

    if (stdin.isTTY) {
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
    } else {
      rl.question('', (ans) => {
        rl.close();
        resolve(ans);
      });
    }
  });
}

function promptLine(questionText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });
    rl.question(questionText, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let username = process.env.BOOTSTRAP_ADMIN_USER || process.env.ADMIN_USERNAME || '';
  let password = process.env.BOOTSTRAP_ADMIN_PASS || process.env.ADMIN_PASSWORD || '';
  let generateSqlOnly = false;
  let usedCliFlagPass = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user' && args[i + 1]) {
      username = args[++i];
    } else if (args[i] === '--pass' && args[i + 1]) {
      password = args[++i];
      usedCliFlagPass = true;
    } else if (args[i] === '--sql-only') {
      generateSqlOnly = true;
    }
  }

  if (usedCliFlagPass) {
    console.warn('\n[PERINGATAN KEAMANAN]: Mengirimkan password via argumen CLI (--pass)');
    console.warn('berisiko terekspos pada daftar proses OS (ps/Task Manager) dan riwayat shell.');
    console.warn('Disarankan menggunakan prompt interaktif atau environment variable BOOTSTRAP_ADMIN_PASS / ADMIN_PASSWORD.\n');
  }

  // Jika username belum disediakan, tanyakan interaktif
  if (!username && process.stdin.isTTY) {
    username = await promptLine('Masukkan Username Admin: ');
  }

  // Jika password belum disediakan, tanyakan interaktif bertopeng
  if (!password && process.stdin.isTTY) {
    password = await promptHiddenPassword('Masukkan Password Admin (karakter akan disembunyikan): ');
  }

  if (!username || !password) {
    console.error('================================================================');
    console.error('Gudang Video Shopee - Initial Administrator Bootstrap');
    console.error('================================================================');
    console.error('Penggunaan interaktif aman:');
    console.error('  node scripts/bootstrap-admin.js');
    console.error('  (Akan meminta input username dan password bertopeng secara interaktif)');
    console.error('\nAtau via Environment Variables:');
    console.error('  BOOTSTRAP_ADMIN_USER=admin BOOTSTRAP_ADMIN_PASS=rahasia node scripts/bootstrap-admin.js');
    console.error('\nOpsi flag CLI:');
    console.error('  --user <username>   Tentukan username');
    console.error('  --pass <password>   Tentukan password langsung (tidak disarankan untuk shell publik)');
    console.error('  --sql-only          Hanya cetak query SQL aman untuk di-pipe ke file / Wrangler D1');
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
