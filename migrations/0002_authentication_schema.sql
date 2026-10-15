-- =============================================================================
-- Migration: 0002_authentication_schema.sql
-- Deskripsi: Skema lengkap autentikasi satu perangkat, kode aktivasi, kode reset,
--            sesi aman, dan audit log untuk Gudang Video Shopee Affiliate.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABEL: activation_codes
-- Menyimpan kode aktivasi berformat GVS + 26 karakter Base32 (130-bit entropy).
-- Hanya hash SHA-256 yang disimpan di database.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activation_codes (
    id TEXT PRIMARY KEY,                              -- UUID v4
    code_hash TEXT NOT NULL,                          -- SHA-256 dari kode aktivasi rahasia
    created_by TEXT NOT NULL,                         -- FK ke users.id (admin pembuat)
    used_by_user_id TEXT,                             -- FK ke users.id (pengguna pengklaim)
    status TEXT NOT NULL DEFAULT 'active',            -- 'active' | 'used' | 'revoked' | 'expired'
    max_uses INTEGER NOT NULL DEFAULT 1,              -- Wajib bernilai 1 (sekali pakai)
    used_count INTEGER NOT NULL DEFAULT 0,            -- Nilai pemakaian (0 atau 1)
    note TEXT,                                        -- Catatan lisensi / pembeli Shopee
    expires_at DATETIME NOT NULL,                     -- Batas waktu kedaluwarsa kode
    used_at DATETIME,                                 -- Waktu klaim kode
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_activation_codes_status CHECK (status IN ('active', 'used', 'revoked', 'expired')),
    CONSTRAINT chk_activation_codes_usage CHECK (used_count >= 0 AND used_count <= max_uses AND max_uses = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_codes_hash ON activation_codes(code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_codes_user ON activation_codes(used_by_user_id) WHERE used_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activation_codes_status ON activation_codes(status);
CREATE INDEX IF NOT EXISTS idx_activation_codes_created_by ON activation_codes(created_by);

-- -----------------------------------------------------------------------------
-- 2. TABEL: users
-- Menyimpan identitas akun pengguna dan administrator.
-- Setiap user reguler wajib terhubung ke satu activation_codes.id yang unik.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                              -- UUID v4
    username TEXT NOT NULL COLLATE NOCASE,            -- Username unik case-insensitive
    password_hash TEXT NOT NULL,                      -- Hash PBKDF2-HMAC-SHA512
    password_salt TEXT NOT NULL,                      -- Salt acak 16-byte
    role TEXT NOT NULL DEFAULT 'user',                -- 'admin' | 'user'
    status TEXT NOT NULL DEFAULT 'active',            -- 'active' | 'suspended'
    activation_code_id TEXT,                          -- FK ke activation_codes.id
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id) ON DELETE RESTRICT,
    CONSTRAINT chk_users_role CHECK (role IN ('admin', 'user')),
    CONSTRAINT chk_users_status CHECK (status IN ('active', 'suspended'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_activation_code ON users(activation_code_id) WHERE activation_code_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- -----------------------------------------------------------------------------
-- 3. TABEL: device_reset_codes
-- Menyimpan kode reset perangkat khusus, berumur pendek (15-30 menit), sekali pakai.
-- Diterbitkan admin setelah verifikasi kepemilikan akun.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_reset_codes (
    id TEXT PRIMARY KEY,                              -- UUID v4
    user_id TEXT NOT NULL,                            -- FK ke users.id (target akun)
    code_hash TEXT NOT NULL,                          -- SHA-256 dari kode reset
    created_by TEXT NOT NULL,                         -- FK ke users.id (admin penerbit)
    status TEXT NOT NULL DEFAULT 'active',            -- 'active' | 'used' | 'revoked' | 'expired'
    max_uses INTEGER NOT NULL DEFAULT 1,              -- Wajib bernilai 1 (sekali pakai)
    used_count INTEGER NOT NULL DEFAULT 0,            -- Nilai pemakaian (0 atau 1)
    expires_at DATETIME NOT NULL,                     -- Batas waktu berumur pendek
    used_at DATETIME,                                 -- Waktu klaim reset
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_reset_codes_status CHECK (status IN ('active', 'used', 'revoked', 'expired')),
    CONSTRAINT chk_reset_codes_usage CHECK (used_count >= 0 AND used_count <= max_uses AND max_uses = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reset_codes_hash ON device_reset_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_reset_codes_user ON device_reset_codes(user_id, status);
CREATE INDEX IF NOT EXISTS idx_reset_codes_created_by ON device_reset_codes(created_by);

-- -----------------------------------------------------------------------------
-- 4. TABEL: user_devices
-- Menyimpan ikatan perangkat klien.
-- Constraint uq_user_devices_user memastikan MAKSIMAL 1 PERANGKAT AKTIF per akun.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_devices (
    id TEXT PRIMARY KEY,                              -- UUID v4
    user_id TEXT NOT NULL,                            -- FK ke users.id
    device_token_hash TEXT NOT NULL,                  -- SHA-256 dari token rahasia cookie browser
    device_name TEXT NOT NULL,                        -- Label perangkat klien
    ip_address TEXT,                                  -- Telemetri IP pengikatan
    user_agent TEXT,                                  -- Telemetri User-Agent browser
    is_active INTEGER NOT NULL DEFAULT 1,             -- 1 = Terikat aktif, 0 = Nonaktif/Direset
    bound_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_user_devices_active CHECK (is_active IN (0, 1))
);

-- Penegakan fisik 1 akun = maksimal 1 perangkat aktif
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_devices_user ON user_devices(user_id) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_user_devices_lookup ON user_devices(user_id, device_token_hash);

-- -----------------------------------------------------------------------------
-- 5. TABEL: user_sessions
-- Menyimpan sesi login aktif (maksimal 30 hari absolut, idle timeout 7 hari).
-- Token sesi disimpan dalam bentuk hash SHA-256.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,                              -- UUID v4
    user_id TEXT NOT NULL,                            -- FK ke users.id
    device_id TEXT NOT NULL,                          -- FK ke user_devices.id
    session_token_hash TEXT NOT NULL,                 -- SHA-256 dari token sesi
    ip_address TEXT,                                  -- IP saat sesi dibuat
    user_agent TEXT,                                  -- User-Agent sesi
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at DATETIME NOT NULL,                     -- Batas waktu kedaluwarsa absolut (+30 hari)
    revoked_at DATETIME,                              -- Waktu pencabutan (NULL jika aktif)
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_token ON user_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_validation ON user_sessions(session_token_hash, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_device ON user_sessions(device_id);

-- -----------------------------------------------------------------------------
-- 6. TABEL: audit_logs
-- Mencatat seluruh tindakan administratif untuk akuntabilitas & investigasi.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,                              -- UUID v4
    admin_id TEXT NOT NULL,                           -- FK ke users.id (admin pelaku)
    action TEXT NOT NULL,                             -- Aksi administratif yang dilakukan
    target_user_id TEXT,                              -- FK ke users.id (akun target)
    details TEXT NOT NULL,                            -- Catatan / rincian tindakan
    ip_address TEXT,                                  -- IP pelaku
    user_agent TEXT,                                  -- User-Agent pelaku
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

-- -----------------------------------------------------------------------------
-- 7. TRIGGERS PENJAMIN ATOMISITAS & INTEGRITAS DATA
-- -----------------------------------------------------------------------------

-- Trigger 1: Menolak insert user jika kode aktivasi tidak ada, tidak aktif, sudah dipakai, atau kedaluwarsa
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

-- Trigger 2: Mencegah pembaruan status kode aktivasi jika kode sudah pernah dipakai atau tidak aktif
CREATE TRIGGER IF NOT EXISTS trg_prevent_activation_code_reuse
BEFORE UPDATE OF status, used_count ON activation_codes
FOR EACH ROW
WHEN OLD.used_count >= 1 OR OLD.status != 'active' OR OLD.expires_at <= CURRENT_TIMESTAMP
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_USE_ALREADY_USED_OR_EXPIRED_CODE');
END;

-- Trigger 3: Mencegah pembaruan status kode reset perangkat jika kode sudah pernah dipakai atau tidak aktif
CREATE TRIGGER IF NOT EXISTS trg_prevent_reset_code_reuse
BEFORE UPDATE OF status, used_count ON device_reset_codes
FOR EACH ROW
WHEN OLD.used_count >= 1 OR OLD.status != 'active' OR OLD.expires_at <= CURRENT_TIMESTAMP
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_USE_ALREADY_USED_OR_EXPIRED_RESET_CODE');
END;

-- -----------------------------------------------------------------------------
-- 8. PEMBARUAN METADATA SKEMA
-- -----------------------------------------------------------------------------
UPDATE system_metadata
SET value = '1.1.0', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
