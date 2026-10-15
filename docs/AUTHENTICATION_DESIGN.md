# Desain Arsitektur Autentikasi Satu Perangkat (Single-Device Authentication)
**Proyek:** Gudang Video Shopee Affiliate
**Dokumen:** `docs/AUTHENTICATION_DESIGN.md`
**Status:** Desain Final Disetujui (Final Architecture Design v3)
**Target Runtime:** Cloudflare Workers, Cloudflare D1 (SQLite), Cloudflare R2

---

## 1. Pendahuluan dan Prinsip Desain

Sistem **Gudang Video Shopee Affiliate** dirancang untuk mendistribusikan aset video kreator afiliasi secara eksklusif kepada pengguna berlisensi. Model bisnis dan keamanan mensyaratkan:

1. **Kode Aktivasi Sekali Pakai (*Single-Use Activation Code*)**:
   - Dibuat secara eksklusif oleh Admin.
   - Digunakan oleh Pengguna untuk mengaktifkan akun baru pada satu browser.
   - **Format Kode & Entropi**: Memiliki awalan `GVS` yang diikuti oleh **26 karakter acak Base32 seragam**, menghasilkan tepat **130 bit entropi** kriptografis ($26 \times 5\text{ bit} = 130\text{ bit}$). Awalan `GVS` tidak dihitung sebagai entropi.
   - Kode hanya disimpan dalam bentuk hash SHA-256 (`code_hash`).
   - Bersifat sekali pakai (*single-use*); sekali berhasil digunakan, kode hangus secara permanen dan tidak dapat didaur ulang.
2. **Pengikatan Satu Perangkat Berbasis Browser (*1-Account 1-Device Binding*)**:
   - Satu akun hanya diizinkan aktif dan login pada satu lingkungan peramban/browser.
   - Upaya login dari perangkat/browser kedua ditolak secara mutlak selama ikatan perangkat lama masih aktif.
3. **Penegasan Batasan Perangkat Fisik (*No Hardware Silver Bullet*)**:
   - Aplikasi web yang berjalan di dalam *sandbox* browser **tidak memiliki akses ke pengenal perangkat keras fisik** (seperti IMEI ponsel, MAC address kartu jaringan, atau nomor seri motherboard).
   - "Identitas perangkat" dalam desain ini diwujudkan sebagai **Kredensial Rahasia Kriptografis Berbasis Browser (*Browser-Bound Cryptographic Secret*)** berentropi tinggi yang disimpan di cookie terisolasi. Desain ini **tidak mengklaim dapat mengidentifikasi perangkat fisik secara mutlak**.
4. **Masa Berlaku Cookie vs. Ikatan Logis**:
   - Nilai cookie perangkat berumur 1 tahun (`Max-Age=31536000`) hanyalah masa kedaluwarsa HTTP klien, **bukan jaminan ikatan permanen**. Browser dapat memangkas atau menghapusnya sewaktu-waktu (kebijakan privasi ITP Apple, pembersihan data pengguna, atau pembersihan cache OS).
   - Status ikatan perangkat sejati dikendalikan oleh catatan logis di basis data Cloudflare D1.
5. **Reset Perangkat Melalui Kode Reset Khusus & Audit Trail**:
   - Pengguna tidak dapat memindahkan akun antarperangkat secara mandiri.
   - Pemindahan ke browser/perangkat baru **memerlukan Kode Reset Perangkat Khusus**, sekali pakai, berumur pendek (15–30 menit), dan hanya diterbitkan oleh Admin setelah verifikasi identitas pembeli.
   - Seluruh penerbitan kode reset dan tindakan reset wajib dicatat ke dalam tabel audit log.
6. **Masa Berlaku Sesi (30 Hari Maksimum & 7 Hari Idle Timeout)**:
   - Sesi autentikasi memiliki masa berlaku absolut maksimal **30 hari** (`expires_at = CURRENT_TIMESTAMP + 30 hari`).
   - Sesi memiliki *idle timeout* **7 hari**; jika pengguna tidak aktif selama 7 hari berturut-turut, sesi dianggap kedaluwarsa.
   - Token sesi tidak pernah disimpan polos dalam database; hanya hash SHA-256 (`session_token_hash`) yang disimpan.
7. **Keamanan Sesi Persisten Tanpa Web Storage**:
   - Sesi autentikasi dikelola menggunakan cookie `HttpOnly`, `Secure`, dan `SameSite=Lax`.
   - **Dilarang keras menyimpan token sesi maupun token perangkat ke `localStorage`, `sessionStorage`, atau `IndexedDB`**.
8. **Otorisasi Backend untuk Semua Operasi Administratif**:
   - Seluruh operasi administratif (`/api/admin/*`) wajib diperiksa otorisasi sesi dan role (`admin`) di level backend Worker.
9. **Perlindungan Konten Video R2**:
   - File video disimpan di Cloudflare R2 privat tanpa akses publik langsung. Pengambilan data video wajib melalui verifikasi Worker terautentikasi.

---

## 2. Skema Basis Data Cloudflare D1

Skema dirancang menggunakan relasi SQLite terindeks, memanfaatkan *Foreign Keys*, *Unique Constraints*, *Check Constraints*, dan *Database Triggers* untuk menjamin integritas data secara mutlak.

```
                      +-------------------+
                      |   admin_users     |
                      |  (users role=admin)
                      +---------+---------+
                                |
             +------------------+------------------+
             | membuat                             | menerbitkan & dicatat
             v                                     v
+--------------------+  1       1  +------------------+  1       N  +---------------------+
|  activation_codes  +<------------+      users       +<------------+ device_reset_codes  |
+--------------------+ (FK unik)   +--------+---------+             +---------------------+
                                            | 1                             |
                                            | memiliki                      | dicatat
                                            v 1 (UNIQUE)                    v
                                   +------------------+             +---------------------+
                                   |   user_devices   |             |     audit_logs      |
                                   +--------+---------+             +---------------------+
                                            | 1
                                            | memiliki
                                            v N
                                   +------------------+
                                   |  user_sessions   |
                                   +------------------+
```

### A. Tabel `activation_codes`
Menyimpan kode aktivasi yang dibuat oleh Admin. Kode asli berformat `GVS` + 26 karakter Base32 acak (130-bit entropy). Hanya hash SHA-256 (`code_hash`) yang disimpan di basis data.

```sql
CREATE TABLE IF NOT EXISTS activation_codes (
    id TEXT PRIMARY KEY,                              -- UUID v4
    code_hash TEXT NOT NULL,                          -- SHA-256 dari kode aktivasi rahasia
    created_by TEXT NOT NULL,                         -- FK ke users.id (admin)
    used_by_user_id TEXT,                             -- FK ke users.id (pengguna aktivator)
    status TEXT NOT NULL DEFAULT 'active',            -- 'active' | 'used' | 'revoked' | 'expired'
    max_uses INTEGER NOT NULL DEFAULT 1,              -- Nilai mutlak: 1 (sekali pakai)
    used_count INTEGER NOT NULL DEFAULT 0,            -- Pencatat pemakaian (maksimal 1)
    note TEXT,                                        -- Catatan lisensi / pembeli
    expires_at DATETIME NOT NULL,                     -- Batas waktu kedaluwarsa kode
    used_at DATETIME,                                 -- Waktu eksekusi pemakaian kode
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_activation_codes_status CHECK (status IN ('active', 'used', 'revoked', 'expired')),
    CONSTRAINT chk_activation_codes_usage CHECK (used_count >= 0 AND used_count <= max_uses AND max_uses = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_codes_hash ON activation_codes(code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_codes_user ON activation_codes(used_by_user_id) WHERE used_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activation_codes_status ON activation_codes(status);
```

### B. Tabel `users`
Menyimpan identitas akun pengguna dan administrator. Kolom `activation_code_id` memastikan setiap akun pengguna biasa terikat secara struktural pada satu kode aktivasi yang sah.

```sql
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                              -- UUID v4
    username TEXT NOT NULL COLLATE NOCASE,            -- Username unik (case-insensitive)
    password_hash TEXT NOT NULL,                      -- Hash password (PBKDF2-HMAC-SHA512)
    password_salt TEXT NOT NULL,                      -- Salt acak kriptografis (16 bytes hex)
    role TEXT NOT NULL DEFAULT 'user',                -- 'admin' | 'user'
    status TEXT NOT NULL DEFAULT 'active',            -- 'active' | 'suspended'
    activation_code_id TEXT,                          -- FK ke activation_codes.id (wajib untuk role='user')
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id) ON DELETE RESTRICT,
    CONSTRAINT chk_users_role CHECK (role IN ('admin', 'user')),
    CONSTRAINT chk_users_status CHECK (status IN ('active', 'suspended'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_activation_code ON users(activation_code_id) WHERE activation_code_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
```

### C. Tabel `device_reset_codes`
Menyimpan kode reset perangkat sekali pakai, berumur pendek (misal 15–30 menit), yang diterbitkan oleh Admin setelah verifikasi identitas pembeli. Nilai kode asli tidak disimpan polos, melainkan berupa hash SHA-256 (`code_hash`).

```sql
CREATE TABLE IF NOT EXISTS device_reset_codes (
    id TEXT PRIMARY KEY,                              -- UUID v4
    user_id TEXT NOT NULL,                            -- FK ke users.id (target akun yang direset)
    code_hash TEXT NOT NULL,                          -- SHA-256 dari kode reset perangkat
    created_by TEXT NOT NULL,                         -- FK ke users.id (admin penerbit)
    status TEXT NOT NULL DEFAULT 'active',            -- 'active' | 'used' | 'revoked' | 'expired'
    max_uses INTEGER NOT NULL DEFAULT 1,              -- Nilai mutlak: 1 (sekali pakai)
    used_count INTEGER NOT NULL DEFAULT 0,            -- Pencatat pemakaian (maksimal 1)
    expires_at DATETIME NOT NULL,                     -- Batas waktu berumur pendek (+15 s/d 30 menit)
    used_at DATETIME,                                 -- Waktu klaim kode reset
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_reset_codes_status CHECK (status IN ('active', 'used', 'revoked', 'expired')),
    CONSTRAINT chk_reset_codes_usage CHECK (used_count >= 0 AND used_count <= max_uses AND max_uses = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reset_codes_hash ON device_reset_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_reset_codes_user ON device_reset_codes(user_id, status);
```

### D. Tabel `user_devices` (Pengikatan Perangkat Klien)
Menyimpan ikatan perangkat per pengguna. Constraint `UNIQUE INDEX ... WHERE is_active = 1` menjamin pada level basis data bahwa **satu akun tidak akan pernah memiliki lebih dari satu ikatan perangkat aktif**.

```sql
CREATE TABLE IF NOT EXISTS user_devices (
    id TEXT PRIMARY KEY,                              -- UUID v4
    user_id TEXT NOT NULL,                            -- FK ke users.id
    device_token_hash TEXT NOT NULL,                  -- SHA-256 dari token rahasia browser klien
    device_name TEXT NOT NULL,                        -- Label perangkat (misal: "Chrome di Windows")
    ip_address TEXT,                                  -- IP saat pengikatan pertama (telemetri)
    user_agent TEXT,                                  -- User-Agent (telemetri)
    is_active INTEGER NOT NULL DEFAULT 1,             -- 1 = Terikat aktif, 0 = Direset/Nonaktif
    bound_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_user_devices_active CHECK (is_active IN (0, 1))
);

-- Jaminan fisik basis data: maksimal 1 perangkat aktif per pengguna
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_devices_user ON user_devices(user_id) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_user_devices_lookup ON user_devices(user_id, device_token_hash);
```

### E. Tabel `user_sessions` (Sesi Login Klien)
Menyimpan sesi login aktif yang sah. Nilai token sesi asli tidak disimpan di basis data, melainkan hanya hash SHA-256 (`session_token_hash`). Sesi dibatasi maksimal 30 hari.

```sql
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,                              -- UUID v4
    user_id TEXT NOT NULL,                            -- FK ke users.id
    device_id TEXT NOT NULL,                          -- FK ke user_devices.id
    session_token_hash TEXT NOT NULL,                 -- SHA-256 dari token sesi acak klien
    ip_address TEXT,                                  -- IP saat sesi dibuat
    user_agent TEXT,                                  -- User agent sesi
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at DATETIME NOT NULL,                     -- Batas waktu kedaluwarsa absolut (maksimal +30 hari)
    revoked_at DATETIME,                              -- Waktu pencabutan (NULL jika aktif)
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_token ON user_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_validation ON user_sessions(session_token_hash, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
```

### F. Tabel `audit_logs` (Pencatatan Audit Tindakan Administratif)
Mencatat seluruh tindakan administratif yang berpengaruh pada akun, lisensi, penerbitan kode reset, dan pemulihan perangkat pengguna.

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,                              -- UUID v4
    admin_id TEXT NOT NULL,                           -- FK ke users.id (admin pelaku)
    action TEXT NOT NULL,                             -- 'CREATE_ACTIVATION_CODE' | 'REVOKE_ACTIVATION_CODE' | 'ISSUE_RESET_CODE' | 'REVOKE_RESET_CODE' | 'RESET_DEVICE' | 'SUSPEND_USER' | 'ACTIVATE_USER'
    target_user_id TEXT,                              -- FK ke users.id (target akun yang diubah)
    details TEXT NOT NULL,                            -- Rincian / alasan tindakan
    ip_address TEXT,                                  -- IP admin saat tindakan
    user_agent TEXT,                                  -- User-Agent admin
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_audit_logs_action CHECK (action IN (
        'CREATE_ACTIVATION_CODE',
        'REVOKE_ACTIVATION_CODE',
        'ISSUE_RESET_CODE',
        'REVOKE_RESET_CODE',
        'RESET_DEVICE',
        'SUSPEND_USER',
        'ACTIVATE_USER'
    ))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(admin_id);
```

---

## 3. Triggers Penjamin Atomisitas dan Keamanan Transaksi

Untuk menjamin bahwa operasi tidak dapat menghasilkan status parsial atau entitas ilegal tanpa kode yang sah, skema database dilengkapi trigger tingkat SQLite:

### A. Trigger Validasi Kode Aktivasi Saat Pendaftaran User
Mencegah pembuatan baris `users` baru jika kode aktivasi tidak valid, telah dipakai, atau kedaluwarsa. Jika kondisi tidak terpenuhi, SQLite langsung mengeksekusi `RAISE(ABORT)` sehingga seluruh transaksi batch `env.DB.batch([...])` dibatalkan seketika (*100% rollback*):

```sql
CREATE TRIGGER IF NOT EXISTS trg_enforce_valid_activation_code
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.role = 'user'
BEGIN
    SELECT RAISE(ABORT, 'ACTIVATION_CODE_INVALID_OR_ALREADY_USED')
    WHERE NOT EXISTS (
        SELECT 1 FROM activation_codes
        WHERE id = NEW.activation_code_id
          AND status = 'active'
          AND used_count = 0
          AND expires_at > CURRENT_TIMESTAMP
    );
END;
```

### B. Trigger Pencegahan Daur Ulang Kode Aktivasi
Mencegah pembaruan status kode aktivasi jika kode tersebut sebelumnya sudah pernah dipakai atau tidak aktif:

```sql
CREATE TRIGGER IF NOT EXISTS trg_prevent_activation_code_reuse
BEFORE UPDATE OF status, used_count ON activation_codes
FOR EACH ROW
WHEN OLD.used_count >= 1 OR OLD.status != 'active' OR OLD.expires_at <= CURRENT_TIMESTAMP
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_USE_ALREADY_USED_OR_EXPIRED_CODE');
END;
```

### C. Trigger Pencegahan Daur Ulang Kode Reset Perangkat
Mencegah klaim ganda atas kode reset perangkat berumur pendek:

```sql
CREATE TRIGGER IF NOT EXISTS trg_prevent_reset_code_reuse
BEFORE UPDATE OF status, used_count ON device_reset_codes
FOR EACH ROW
WHEN OLD.used_count >= 1 OR OLD.status != 'active' OR OLD.expires_at <= CURRENT_TIMESTAMP
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_USE_ALREADY_USED_OR_EXPIRED_RESET_CODE');
END;
```

---

## 4. Alur Kerja Autentikasi dan Pemulihan Perangkat

### Alur 1: Pembuatan Kode Aktivasi oleh Admin
1. Admin terautentikasi mengirim `POST /api/admin/activation-codes` dengan parameter `note` dan `expires_in_days`.
2. Worker membangkitkan string kode: awalan `GVS` + 26 karakter Base32 acak berentropi 130-bit (misal: `GVS-7K9M2-P4R8W-X3Q5Y-N6B1C-D2E4F-G8`).
3. Worker menghitung `code_hash = SHA-256(kode)`.
4. Menyimpan rekaman di `activation_codes` dengan `status = 'active'`, `max_uses = 1`, `used_count = 0`.
5. Mencatat tindakan ke `audit_logs` (`action = 'CREATE_ACTIVATION_CODE'`).
6. Kode *plaintext* dikembalikan satu kali ke Admin untuk diserahkan ke pembeli.

### Alur 2: Aktivasi Pertama dan Pengikatan Perangkat
1. Pengguna membuka halaman aktivasi dan mengisi kode aktivasi, username, dan password.
2. Worker memverifikasi format username, menghitung hash PBKDF2 password, dan menghitung `code_hash = SHA-256(activation_code)`.
3. Worker mengeksekusi `env.DB.batch([...])`:
   - Statement 1: `INSERT INTO users (id, username, password_hash, password_salt, role, status, activation_code_id) VALUES (?, ?, ?, ?, 'user', 'active', ?);` (Memicu Trigger `trg_enforce_valid_activation_code` yang memeriksa kode masih berstatus 'active' dan used_count = 0).
   - Statement 2: `UPDATE activation_codes SET status = 'used', used_count = 1, used_by_user_id = ?, used_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active' AND used_count = 0;` (Memicu Trigger `trg_prevent_activation_code_reuse` yang mengizinkan update karena code masih berstatus 'active').
   - Statement 3: `INSERT INTO user_devices (id, user_id, device_token_hash, device_name, is_active) VALUES (?, ?, ?, ?, 1);`
   - Statement 4: `INSERT INTO user_sessions (id, user_id, device_id, session_token_hash, expires_at) VALUES (?, ?, ?, ?, ?);`
4. Jika kode tidak valid atau terjadi *race condition* (request bersamaan), trigger SQLite langsung mengeksekusi `RAISE(ABORT)`. Seluruh batch dibatalkan secara atomik tanpa baris tersisa.
5. Jika sukses, Worker mengirimkan respons disertai dua cookie:
   - `__Host-gvs_device`: Token perangkat rahasia (Max-Age=1 tahun).
   - `__Host-gvs_session`: Token sesi (Max-Age=30 hari).

### Alur 3: Login Rutin pada Perangkat yang Sama
1. Pengguna memasukkan username dan password di `POST /api/auth/login`.
2. Worker memverifikasi kecocokan username dan hash password PBKDF2.
3. Worker membaca cookie `__Host-gvs_device`:
   - Jika cookie **tidak ada**: Tolak dengan HTTP `403 Forbidden` (`{"error": "DEVICE_NOT_AUTHORIZED", "message": "Perangkat tidak terdaftar. Akun ini terikat pada perangkat lain."}`).
   - Jika cookie **ada**: Hitung `device_token_hash = SHA-256(cookie)`.
4. Worker memeriksa tabel `user_devices`:
   - Jika `user_devices` memiliki baris yang cocok dengan `user_id`, `device_token_hash`, dan `is_active = 1`: **Login Diterima**. Terbitkan token sesi baru di `user_sessions` dan perbarui cookie `__Host-gvs_session`.
   - Jika tidak cocok: Tolak dengan HTTP `403 Forbidden`.

### Alur 4: Percobaan Login dari Perangkat/Browser Lain (Ditolak)
1. Pengguna mencoba login dari browser lain menggunakan username dan password yang benar.
2. Karena browser tersebut tidak memiliki cookie `__Host-gvs_device` yang sah, Worker mendeteksi bahwa akun memiliki perangkat aktif lain.
3. Worker menolak request dengan HTTP `403 Forbidden` (`DEVICE_NOT_AUTHORIZED`).

### Alur 5: Logout
1. Klien memanggil `POST /api/auth/logout`.
2. Worker membaca cookie `__Host-gvs_session` dan mencabutnya di database: `UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_token_hash = ?;`.
3. Worker menghapus cookie sesi (`Max-Age=0`).
4. Cookie perangkat `__Host-gvs_device` **tetap dipertahankan** agar pengguna dapat login kembali di browser tersebut tanpa perlu reset.

### Alur 6: Alur Pemulihan & Reset Perangkat Menggunakan Kode Reset
Jika pengguna berganti HP/browser atau cookie perangkat terhapus:
1. **Verifikasi Identitas**: Pengguna menghubungi Admin melalui saluran resmi (WhatsApp/Telegram) dengan menyertakan bukti kepemilikan.
2. **Penerbitan Kode Reset oleh Admin**:
   - Admin memanggil endpoint backend: `POST /api/admin/users/:id/reset-code` dengan payload `{ "reason": "Pengguna ganti HP ke iPhone 15" }`.
   - Worker membangkitkan kode reset berumur pendek (misal: `RST` + 26 karakter Base32, valid 15–30 menit).
   - Worker mencatat hash kode ke `device_reset_codes` (`status = 'active'`, `expires_at = CURRENT_TIMESTAMP + 30 menit`).
   - Worker mencatat tindakan ke `audit_logs` (`action = 'ISSUE_RESET_CODE'`).
   - Kode *plaintext* diberikan oleh Admin kepada pengguna.
3. **Klaim Kode Reset pada Browser Baru**:
   - Pengguna membuka browser baru dan mengakses form reset perangkat: `POST /api/auth/reset-device` dengan input `username`, `password`, dan `reset_code`.
   - Worker memverifikasi username, password, dan kecocokan hash `reset_code`.
   - Worker mengeksekusi transaksi atomik `env.DB.batch([...])`:
     1. Menandai kode reset sebagai terpakai: `UPDATE device_reset_codes SET status = 'used', used_count = 1, used_at = CURRENT_TIMESTAMP WHERE id = ?;` (Memicu Trigger `trg_prevent_reset_code_reuse`).
     2. Menonaktifkan perangkat lama: `UPDATE user_devices SET is_active = 0 WHERE user_id = ?;`
     3. Mencabut seluruh sesi lama: `UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL;`
     4. Mendaftarkan perangkat baru di `user_devices` (`is_active = 1`).
     5. Menerbitkan sesi baru di `user_sessions`.
     6. Mencatat riwayat pemulihan ke `audit_logs` (`action = 'RESET_DEVICE'`).
4. Browser baru kini resmi terikat dan menerima cookie `__Host-gvs_device` serta `__Host-gvs_session` baru. Browser lama seketika kehilangan akses.

---

## 5. Mode Incognito: Batasan Teknis dan Edukasi Pengguna

### A. Larangan Mengandalkan Deteksi Incognito Programatik
- Deteksi penyamaran otomatis secara programatik (misal via Storage Quota API) **bukan kontrol keamanan yang andal**. Vendor browser secara aktif menambal API mereka agar mode penyamaran tidak dapat dibedakan dari mode reguler guna menjaga privasi pengguna.
- Mengandalkan deteksi otomatis menimbulkan *false-positive* (pengguna normal terblokir) atau *false-negative* (pengguna incognito lolos).

### B. Strategi Edukasi Preventif dan Konfirmasi Pengguna
Pendekatan yang diadopsi adalah **edukasi eksplisit pada antarmuka pengguna (UI)**:

1. **Banner Peringatan Wajib di Halaman Aktivasi & Reset**:
   > **PERHATIAN PENTING SEBELUM AKTIVASI:**
   > Akun Anda akan diikat secara permanen pada browser ini.
   > - **DILARANG MENGGUNAKAN MODE SAMARAN (INCOGNITO / PRIVATE BROWSING).**
   > - Menutup jendela Incognito akan menghapus identitas perangkat Anda secara permanen dan menyebabkan akun Anda terkunci.
   > - Pastikan Anda menggunakan browser utama harian Anda (Chrome, Safari, Edge, dll.).
2. **Checkbox Konfirmasi Persetujuan**:
   Sebelum tombol aktivasi dapat diklik, pengguna wajib mencentang:
   `[x] Saya mengonfirmasi bahwa saya TIDAK menggunakan mode penyamaran (Incognito) dan memahami bahwa akses akun akan terikat pada browser ini.`

---

## 6. Password Hashing, Sesi, dan Keamanan Web

### A. Evaluasi Parameter PBKDF2 pada Cloudflare Workers
- **Rekomendasi Standar**:
  - OWASP merekomendasikan PBKDF2-HMAC-SHA512 dengan minimal 210.000 iterasi untuk backend konvensional dengan CPU server mandiri tak terbatas.
  - NIST SP 800-63B menetapkan batas bawah minimal 10.000 iterasi.
- **Karakteristik & Batasan Runtime Cloudflare Workers**:
  - Workers berjalan di atas arsitektur V8 Isolates dengan batas kuota CPU Time yang ketat: **50 milidetik CPU time per request** pada paket standar/free.
- **Hasil Pengujian Benchmark Empiris Aktual (Node.js/V8 WebCrypto)**:
  - `100.000 iterasi SHA-512`: **~176 ms CPU time** (melebihi batas kuota 50 ms hingga 3,5 kali lipat! Sangat fatal memicu `Error: Worker exceeded CPU limits`).
  - `50.000 iterasi SHA-512`: **~116 ms CPU time** (tetap melebihi batas 50 ms).
  - `25.000 iterasi SHA-512`: **~49 ms CPU time** (berada tepat di ambang kritis batas 50 ms; berisiko gagal saat lonjakan beban).
  - `10.000 iterasi SHA-512`: **~30 - 33 ms CPU time** (stabil dan aman di bawah 50 ms, sekaligus memenuhi standar NIST SP 800-63B).
- **Keputusan Desain**:
  - Mengadopsi **PBKDF2-HMAC-SHA512** dengan **10.000 iterasi**, panjang salt **16 bytes CSPRNG**, dan panjang kunci **64 bytes (512-bit)**. Parameter ini adalah satu-satunya pilihan yang terbukti aman secara kriptografis sekaligus stabil di dalam batas 50 ms CPU Cloudflare Workers.

### B. Verifikasi Password Anti-Timing Attack & Anti-Enumeration
1. **Perbandingan Timing-Safe Portabel**:
   - Fungsi `crypto.subtle.timingSafeEqual` **tidak tersedia** di dalam spesifikasi standar W3C Web Cryptography API (`undefined`).
   - Verifikasi menggunakan algoritma pembandingan waktu konstan berbasis byte independen (`timingSafeEqual(a: Uint8Array, b: Uint8Array)`):
     ```typescript
     export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
       if (a.byteLength !== b.byteLength) return false;
       let c = 0;
       for (let i = 0; i < a.byteLength; i++) {
         c |= a[i] ^ b[i];
       }
       return c === 0;
     }
     ```
2. **Pencegahan User Enumeration (Penebakan Akun)**:
   - Jika `username` tidak ditemukan di basis data: Worker **TIDAK langsung me-return error**! Worker tetap menjalankan kalkulasi PBKDF2 tiruan (*dummy hashing*) 10.000 iterasi menggunakan password yang dimasukkan dan salt tiruan acak.
   - Waktu respons server (*response latency*) untuk "username tidak terdaftar" dan "password salah" adalah **identik (~30 ms)**.
3. **Pesan Error Netral**:
   Respons error login wajib bersifat umum:
   `{"error": "INVALID_CREDENTIALS", "message": "Nama pengguna atau kata sandi tidak valid."}` dengan status HTTP `401 Unauthorized`.

### C. Spesifikasi Cookie Resmi
Menolak atribut `Partitioned` karena aplikasi bersifat *first-party*:
```http
Set-Cookie: __Host-gvs_device=<device_token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000
Set-Cookie: __Host-gvs_session=<session_token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000
```
- `__Host-` Prefix: Menjamin cookie hanya dikirim via HTTPS, terikat pada origin pembuat (tanpa subdomain), dan memiliki `Path=/`.
- `HttpOnly`: Mencegah pembacaan cookie oleh JavaScript (anti-XSS).
- `Secure`: Hanya dikirim melalui koneksi HTTPS terenkripsi.
- `SameSite=Lax`: Mencegah pengiriman otomatis pada request AJAX lintas situs (*anti-CSRF*).

### D. Siklus Hidup Sesi (30 Hari Maksimum & 7 Hari Idle Timeout)
- **Kedaluwarsa Sesi (Absolute & Idle)**:
  - *Absolute Timeout*: Sesi berakhir setelah **30 hari** sejak dibuat (`expires_at = CURRENT_TIMESTAMP + 30 hari`).
  - *Idle Timeout*: Setiap request terotorisasi memperbarui `last_active_at = CURRENT_TIMESTAMP`. Sesi yang tidak memiliki aktivitas selama **7 hari** berturut-turut dianggap kedaluwarsa.
- **Pencabutan Sesi Seketika (*Instant Session Revocation*)**:
  Middleware Worker memverifikasi:
  ```sql
  SELECT s.id, u.role, u.status
  FROM user_sessions s
  JOIN users u ON s.user_id = u.id
  JOIN user_devices d ON s.device_id = d.id
  WHERE s.session_token_hash = ?
    AND s.expires_at > CURRENT_TIMESTAMP
    AND s.last_active_at > datetime('now', '-7 days')
    AND s.revoked_at IS NULL
    AND d.is_active = 1
    AND u.status = 'active';
  ```
  Jika admin melakukan reset perangkat (`d.is_active = 0`) atau membekukan akun (`u.status = 'suspended'`), sesi pengguna seketika itu juga ditolak.

---

## 7. Spesifikasi Endpoint API & Matriks Otorisasi

Seluruh endpoint `/api/admin/*` **wajib melalui middleware otorisasi backend** yang memeriksa:
1. Keberadaan dan keabsahan cookie sesi `__Host-gvs_session`.
2. Sesi belum kedaluwarsa dan belum dicabut (`revoked_at IS NULL`).
3. Akun pengguna memiliki `role === 'admin'`.
4. Akun admin berstatus `status === 'active'`.

| Metode | Path | Otorisasi & Role | Deskripsi & Fungsi |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/activate` | Publik | Validasi kode aktivasi atomik, pembuatan user baru, pengikatan perangkat pertama, penerbitan cookie sesi + perangkat. |
| `POST` | `/api/auth/login` | Publik | Verifikasi username/password dan pencocokan cookie `__Host-gvs_device`. Jika cocok, terbitkan cookie `__Host-gvs_session`. Jika tidak cocok/tidak ada, tolak dengan 403. |
| `POST` | `/api/auth/reset-device` | Publik | Menerima username, password, dan kode reset berumur pendek. Mengikat perangkat baru, mencabut perangkat lama, dan menerbitkan cookie baru. |
| `POST` | `/api/auth/logout` | User / Admin | Mencabut sesi di basis data dan menghapus cookie sesi klien. |
| `GET` | `/api/auth/me` | User / Admin | Mengembalikan profil pengguna (username, role, status perangkat). |
| `POST` | `/api/admin/activation-codes` | **Admin Only** | Membuat kode aktivasi sekali pakai baru (`GVS` + 26 Base32, 130-bit entropy). |
| `GET` | `/api/admin/activation-codes` | **Admin Only** | Menampilkan daftar kode aktivasi, status pemakaian, dan user yang mengklaim. |
| `DELETE` | `/api/admin/activation-codes/:id` | **Admin Only** | Mencabut kode aktivasi yang belum terpakai. Dicatat ke `audit_logs`. |
| `GET` | `/api/admin/users` | **Admin Only** | Menampilkan daftar seluruh pengguna beserta info perangkat terikat (`device_name`, `last_seen_at`). |
| `POST` | `/api/admin/users/:id/reset-code` | **Admin Only** | Menerbitkan kode reset perangkat berumur pendek sekali pakai untuk pengguna tertentu. Dicatat ke `audit_logs`. |
| `POST` | `/api/admin/users/:id/suspend` | **Admin Only** | Membekukan akun pengguna dan mencabut seluruh sesi aktif. Dicatat ke `audit_logs`. |
| `GET` | `/api/admin/audit-logs` | **Admin Only** | Melihat riwayat audit tindakan administratif. |
| `GET` | `/api/videos` | **User Aktif** | Mengambil katalog video. Ditolak jika sesi tidak valid atau perangkat tidak terotorisasi. |
| `GET` | `/api/videos/:id/stream` | **User Aktif** | Mengembalikan stream video dari R2 privat atau presigned URL berdurasi pendek. |

---

## 8. Skenario Pengujian Komprehensif

Pengujian dibangun di atas framework **Vitest** dengan simulasi D1/Miniflare:

1. **Skenario 1: Hashing & Verifikasi PBKDF2**:
   - Memastikan komputasi PBKDF2 100.000 iterasi konsisten dan verifikasi *timing-safe* menolak password yang salah.
   - Memastikan latensi respons untuk user terdaftar vs user tidak terdaftar identik (evaluasi dummy hashing).
2. **Skenario 2: Pemakaian Kode Aktivasi Normal**:
   - Aktivasi dengan kode berformat `GVS` + 26 Base32 valid menghasilkan HTTP 200, status kode berubah menjadi `'used'`, dan user, device, serta session tercipta secara utuh.
3. **Skenario 3: Penolakan Kode yang Digunakan Dua Kali (*Replay Attack*)**:
   - Permintaan aktivasi kedua menggunakan kode yang sama menghasilkan HTTP 400 (`ACTIVATION_CODE_INVALID_OR_ALREADY_USED`).
   - Trigger SQLite menjamin tidak ada user atau sesi kedua yang tercipta.
4. **Skenario 4: Penanganan Permintaan Aktivasi Bersamaan (*Race Condition*)**:
   - Dua request paralel dikirim via `Promise.all([activate(req1), activate(req2)])` dengan kode aktivasi yang sama.
   - Menegaskan tepat 1 request berhasil (200 OK) dan tepat 1 request gagal (400 Bad Request).
   - Memastikan basis data hanya memuat 1 user dan status kode adalah `used_count = 1`.
5. **Skenario 5: Percobaan Login dari Perangkat Baru (*Device Enforcement*)**:
   - User terdaftar di Browser A (memiliki cookie `__Host-gvs_device = tokenA`).
   - Browser B mencoba login dengan username & password yang benar tanpa cookie atau dengan cookie acak.
   - Menegaskan respons server adalah HTTP 403 (`DEVICE_NOT_AUTHORIZED`).
6. **Skenario 6: Login Ulang pada Perangkat yang Sama Setelah Sesi Kedaluwarsa**:
   - Sesi di Browser A kedaluwarsa setelah 30 hari atau tidak aktif selama 7 hari.
   - Browser A melakukan login ulang dengan username & password (cookie `__Host-gvs_device = tokenA` disertakan).
   - Menegaskan login berhasil (HTTP 200) dan sesi baru diterbitkan.
7. **Skenario 7: Penerbitan dan Penggunaan Kode Reset Perangkat**:
   - Admin menerbitkan kode reset untuk pengguna: `POST /api/admin/users/:id/reset-code`.
   - Browser B menggunakan kode reset: `POST /api/auth/reset-device`.
   - Menegaskan Browser B sekarang terikat sebagai perangkat aktif baru, perangkat lama Browser A nonaktif (`is_active = 0`), dan seluruh sesi lama dicabut.
   - Mencoba menggunakan kode reset yang sama kedua kalinya: ditolak oleh Trigger `trg_prevent_reset_code_reuse`.
8. **Skenario 8: Logout Pengguna**:
   - User memanggil `POST /api/auth/logout`.
   - Verifikasi sesi di tabel `user_sessions` memiliki `revoked_at != NULL`. Request berikutnya ditolak dengan HTTP 401.
9. **Skenario 9: Otorisasi Role Admin Backend**:
   - User biasa (role `'user'`) mencoba mengakses endpoint admin (`GET /api/admin/users`).
   - Menegaskan respons adalah HTTP 403 (`FORBIDDEN`).

---

## 9. Mekanisme Aman Bootstrap Admin Pertama

Untuk mencegah kerentanan pengambilalihan hak akses (*privilege escalation*), sistem **TIDAK MEMBUKA** endpoint publik apa pun untuk registrasi admin dan **TIDAK MENANAM KREDENSIAL DEFAULT** (*hardcoded default credentials*) di dalam kode sumber.

### A. Alur Inisialisasi Admin Pertama
1. **Penyisipan Berbasis CLI Terotentikasi**:
   Admin pertama diinisialisasi secara langsung pada basis data D1 menggunakan antarmuka command line lokal/Cloudflare CLI (`wrangler d1 execute`).
2. **Perintah Inisialisasi**:
   Admin menjalankan script satu kali atau perintah SQL yang menghitung hash PBKDF2 (10.000 iterasi) dengan salt acak yang baru:
   ```sql
   INSERT INTO users (id, username, password_hash, password_salt, role, status)
   VALUES (
       'admin-root-001',
       'admin',
       '<PBKDF2_HASH>',
       '<SALT_HEX>',
       'admin',
       'active'
   );
   ```
3. **Pemberitahuan Keamanan**:
   Tabel `users` tidak membatasi akun `role = 'super_admin'` untuk memiliki `activation_code_id`, sehingga akun Super Admin dapat dibuat secara independen tanpa kode aktivasi.
4. **Proteksi Kredensial CLI**:
   Skrip `scripts/bootstrap-admin.js` dan `scripts/recover-super-admin.js` secara ketat menolak pemberian password melalui argumen baris perintah (`--pass`, `--password`, `-p`, baik huruf besar/kecil maupun sintaks `=nilai`) guna mencegah terekspos di tabel proses sistem operasi (`ps aux`, Task Manager) dan riwayat shell (`~/.bash_history`).
   - **Prompt Bertopeng Wajib**: Seluruh input password wajib dimasukkan secara interaktif melalui terminal prompt bertopeng (`*`) dengan konfirmasi ganda (`p1 !== p2`).
   - **Penegakan Interaktivitas TTY**: Script memeriksa ketersediaan terminal interaktif (`process.stdin.isTTY`). Lingkungan non-interaktif (seperti piping, background process, atau redirect stdin tanpa TTY) langsung ditolak dengan kode kesalahan `TTY_REQUIRED` demi mencegah pembocoran password mentah atau fallback tanpa masking.
   - **Penghapusan Environment Variable Password**: Dukungan variabel lingkungan seperti `BOOTSTRAP_ADMIN_PASS` dan `ADMIN_PASSWORD` telah dihapus sepenuhnya dari implementasi untuk mengeliminasi risiko pembocoran kredensial melalui dump memori proses, file `.env`, atau log pipeline.
   - **Penolakan Argumen Posisi & Opsi Kosong**: Parser menolak opsi bernilai kosong (seperti `--user=`, `-u=`, `--username=`, `--file=`) serta menolak argumen posisi asing menggunakan pesan error generik tanpa mencerminkan token input (non-reflection) guna mencegah teks sensitif yang tidak sengaja tertempel tercatat di log terminal.

---

## 10. Checklist & Panduan Mitigasi Login Rate Limiting (Cloudflare WAF / Edge Rules)

### A. Batasan Arsitektur Rate Limiter In-Memory Lokal
Rate limiter yang terpasang di `worker/security.ts` (`checkLoginRateLimit`) beroperasi secara *in-memory* di dalam isolate V8 instance Worker lokal.
- **Bukan Rate Limiter Global:** Karena Cloudflare Workers mendistribusikan request ke ratusan PoP (Points of Presence) dan berbagai isolate secara terdistribusi, beberapa request login yang tiba di isolate atau data center berbeda tidak berbagi memori heap.
- **Peran Aktual:** Proteksi in-memory berfungsi sebagai lapisan pertahanan mendalam (*defense-in-depth*) per isolate lokal untuk menahan loop cepat dari satu koneksi yang sama.

### B. Prasyarat Operasional Sebelum Rilis Publik (Pre-Release Checklist)
Sebelum domain aplikasi dibuka untuk akses publik, administrator sistem disarankan mengonfigurasi aturan Rate Limiting pada Cloudflare WAF melalui Cloudflare Dashboard.

> [!IMPORTANT]
> **Status Verifikasi & Belum Aktif:** Konfigurasi aktual Cloudflare WAF dan efektivitas mitigasi edge belum dan tidak dapat diverifikasi secara lokal karena batasan audit *strict read-only* (tanpa akses remote ke akun Cloudflare). Aturan WAF saat ini **belum aktif** di remote, dan efektivitas mitigasinya tidak boleh diasumsikan sebelum dikonfigurasi dan diuji di lingkungan remote.
> Selain itu, tier paket Cloudflare pada akun proyek belum diverifikasi, sehingga parameter yang dicantumkan di bawah merupakan **rekomendasi awal** yang wajib disesuaikan dengan kapabilitas dashboard dan fitur paket aktual.

### C. Rekomendasi Awal Cloudflare WAF Rate Limiting & Pertimbangan Paket
1. **Karakteristik Penghitungan & Batasan Konsistensi Edge:**
   - Counter Cloudflare WAF Rate Limiting dievaluasi pada data center Cloudflare di edge (PoP). Counter dapat terpisah antar-data center, dan aturan rate limiting tidak menjamin konsistensi jumlah request yang presisi secara matematis di seluruh dunia sebelum mitigasi diterapkan (beberapa request tambahan dapat lewat jika didistribusikan ke PoP berbeda).
2. **Kesesuaian Field Ekspresi Target Rule Menurut Paket:**
   - Rekomendasi kriteria: URI Path `eq "/api/auth/login"` dan HTTP Method `eq "POST"`.
   - **Kompatibilitas Field:** Tidak semua paket Cloudflare mendukung kombinasi field ekspresi yang sama pada Rate Limiting Rules. Pada paket Free, field ekspresi yang didukung terbatas (implementasi standar umumnya berfokus pada path URL, tanpa dukungan filter `http.request.method`). Penyaringan berdasarkan method (`http.request.method`) membutuhkan paket yang menyediakan fitur Advanced Rate Limiting atau Ruleset Engine yang lebih tinggi.
3. **Karakteristik & Ambang Batas Awal Berdasarkan Periode Paket:**
   - Karakteristik Penghitungan: Berdasarkan IP Pengunjung (`ip.src`).
   - Pilihan periode jendela penghitungan (*counting period*) bervariasi menurut paket:
     - **Paket Free:** Jendela periode penghitungan yang tercantum umumnya terbatas pada **10 detik**.
     - **Paket Pro:** Jendela periode penghitungan tersedia hingga **1 menit** (pilihan 10 detik atau 1 menit).
     - **Paket Business:** Jendela periode penghitungan tersedia hingga **10 menit** (pilihan 10 detik, 1 menit, atau 10 menit).
     - **Paket Enterprise:** Menyediakan rentang jendela waktu kustom (detik hingga jam) serta opsi sliding window lanjutan.
   - Ambang batas percobaan (misalnya 5 request) wajib disesuaikan dengan jendela waktu yang aktif pada paket bersangkutan.
4. **Tindakan Mitigasi: Perilaku Throttling & Perbedaan Managed Challenge:**
   - **Pembedaan Managed Challenge vs Turnstile:** `Managed Challenge` adalah tindakan mitigasi layer edge di Cloudflare WAF yang secara adaptif memilih jenis tantangan (seperti tantangan non-interaktif JavaScript atau challenge interaktif) berdasarkan tingkat kecurigaan traffic. Ini berbeda dari *Cloudflare Turnstile*, yang merupakan produk widget CAPTCHA replacement mandiri yang diintegrasikan langsung pada kode antarmuka/frontend web.
   - **Perilaku Throttling Paket Free/Pro/Business vs Enterprise:** Pada paket Free, Pro, dan Business, tindakan challenge menerapkan perilaku *throttling* khusus: request yang melampaui ambang batas akan disajikan challenge untuk memverifikasi pengunjung sah sebelum diizinkan meneruskan request, bukan selalu menerapkan durasi mitigasi statis yang dapat ditentukan bebas oleh pengguna. Paket Enterprise menyediakan opsi durasi mitigasi kustom serta respons khusus lanjutan.
   - **Batasan Efektivitas:** Tindakan `Managed Challenge` **tidak menjamin otomatis memblokir seluruh bot atau brute-force** (bot tingkat lanjut yang menggunakan solver headless atau layanan CAPTCHA solving terdistribusi berpotensi melewati verifikasi), namun secara signifikan menaikkan biaya dan hambatan serangan (*friction*) dibandingkan endpoint tanpa proteksi edge.
   - **Fingerprint JA3/JA4:** Pemanfaatan karakteristik sidik jari TLS (`JA3` / `JA4` seperti `cf.bot_management.ja4`) hanya tersedia pada fitur Cloudflare Bot Management atau paket Enterprise dengan Advanced Rate Limiting, dan tidak tersedia secara umum pada paket Free, Pro, maupun Business standar.

### D. Perbandingan Opsi Arsitektur untuk Rate Limiting Terdistribusi

| Opsi Solusi | Karakteristik Konsistensi State | Dampak Latensi | Ketersediaan & Kompleksitas | Evaluasi & Catatan Operasional |
|---|---|---|---|---|
| **Cloudflare Edge WAF (Rekomendasi Awal)** | Terdistribusi per Edge PoP (tidak sinkron global seketika antar-data center) | Sangat rendah di Edge (request disaring sebelum mencapai Worker ketika aturan cocok dan mitigasi berlaku) | Bergantung paket Cloudflare (kuota rules dan opsi konfigurasi bervariasi; belum diverifikasi pada akun ini) | **Rekomendasi Lapis Pertama**. Efektif menyaring volumetrik brute-force sebelum membebani Worker/D1, dengan memahami keterbatasan konsistensi per-PoP. |
| **Cloudflare Workers KV** | Eventual Consistency (propagasi asinkron antar edge, jeda pembaruan hingga puluhan detik) | Rendah untuk pembacaan edge; penulisan memerlukan waktu propagasi | Tersedia di runtime Workers standar; mengonsumsi kuota operasi tulis | Kurang ideal untuk rate limiting presisi karena delay propagasi memungkinkan lonjakan request lolos secara serentak. |
| **Cloudflare Durable Objects** | Strong Consistency (single-actor koordinator dengan jaminan urutan terpusat) | Menengah (request dirutekan ke lokasi PoP instance Durable Object yang bersangkutan) | Memerlukan Workers Paid dan penulisan arsitektur koordinasi khusus | Memungkinkan koordinasi state yang konsisten pada objek yang sama, dengan akurasi rate limiting bergantung pada desain implementasi, namun menambah kompleksitas kode, latensi rute, dan dependensi biaya. |
| **Cloudflare D1 Database Counter** | Strong Consistency (ACID berbasis transaksi SQLite) | Tinggi (setiap percobaan login memicu transaksi tulis ke basis data) | Memanfaatkan resource D1 yang sudah ada; menguras kuota row write D1 | **Tidak Direkomendasikan**. Menimbulkan risiko bottleneck I/O pada basis data transaksional aplikasi saat diserang brute-force massal. |
