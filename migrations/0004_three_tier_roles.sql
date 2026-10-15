-- =============================================================================
-- Migration: 0004_three_tier_roles.sql
-- Deskripsi: Penerapan sistem tiga level akun (super_admin, admin, member),
--            pemetaan role lama, penegakan batas tepat 3 super_admin,
--            kebijakan multi-perangkat super_admin, dan perluasan audit logs.
--            Kompatibel penuh dengan Cloudflare D1 (foreign_keys permanen aktif).
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 0. HAPUS TRIGGER LAMA SEBELUM RESTRUKTURISASI
-- Menghindari dependensi saat tabel activation_codes di-drop
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_enforce_valid_activation_code;

-- -----------------------------------------------------------------------------
-- 1. RESTRUKTURISASI TABEL ANAK KE NO ACTION (MENCEGAH BLOKIR DROP TABLE USERS)
-- -----------------------------------------------------------------------------

-- A. activation_codes: Ubah ON DELETE RESTRICT ke NO ACTION
CREATE TABLE IF NOT EXISTS activation_codes_new (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    used_by_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_activation_codes_status CHECK (status IN ('active', 'used', 'revoked', 'expired')),
    CONSTRAINT chk_activation_codes_usage CHECK (used_count >= 0 AND used_count <= max_uses AND max_uses = 1)
);
INSERT INTO activation_codes_new (id, code_hash, created_by, used_by_user_id, status, max_uses, used_count, note, expires_at, used_at, created_at)
SELECT id, code_hash, created_by, used_by_user_id, status, max_uses, used_count, note, expires_at, used_at, created_at
FROM activation_codes;
DROP TABLE activation_codes;
ALTER TABLE activation_codes_new RENAME TO activation_codes;

CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_codes_hash ON activation_codes(code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_codes_user ON activation_codes(used_by_user_id) WHERE used_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activation_codes_status ON activation_codes(status);
CREATE INDEX IF NOT EXISTS idx_activation_codes_created_by ON activation_codes(created_by);

CREATE TRIGGER IF NOT EXISTS trg_prevent_activation_code_reuse
BEFORE UPDATE OF status, used_count ON activation_codes
FOR EACH ROW
WHEN OLD.used_count >= 1 OR OLD.status != 'active' OR OLD.expires_at <= CURRENT_TIMESTAMP
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_USE_ALREADY_USED_OR_EXPIRED_CODE');
END;

-- B. user_sessions: Recreate sebelum user_devices untuk mencegah ON DELETE CASCADE menghapus sesi saat user_devices di-drop
CREATE TABLE IF NOT EXISTS user_sessions_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    session_token_hash TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    expires_at DATETIME NOT NULL,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES user_devices(id)
);
INSERT INTO user_sessions_new (id, user_id, device_id, session_token_hash, ip_address, user_agent, expires_at, last_active_at, revoked_at, created_at)
SELECT id, user_id, device_id, session_token_hash, ip_address, user_agent, expires_at, last_active_at, revoked_at, created_at
FROM user_sessions;
DROP TABLE user_sessions;
ALTER TABLE user_sessions_new RENAME TO user_sessions;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_token ON user_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_device ON user_sessions(device_id);

-- C. user_devices: Hapus ON DELETE CASCADE sementara agar tidak menghapus perangkat saat users di-drop
CREATE TABLE IF NOT EXISTS user_devices_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_token_hash TEXT NOT NULL,
    device_name TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    bound_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
INSERT INTO user_devices_new (id, user_id, device_token_hash, device_name, ip_address, user_agent, is_active, bound_at, last_seen_at)
SELECT id, user_id, device_token_hash, device_name, ip_address, user_agent, is_active, bound_at, last_seen_at
FROM user_devices;
DROP TABLE user_devices;
ALTER TABLE user_devices_new RENAME TO user_devices;

CREATE INDEX IF NOT EXISTS idx_user_devices_user_active ON user_devices(user_id, is_active);

-- D. device_reset_codes: Hapus ON DELETE CASCADE
CREATE TABLE IF NOT EXISTS device_reset_codes_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    CONSTRAINT chk_reset_codes_status CHECK (status IN ('active', 'used', 'revoked', 'expired')),
    CONSTRAINT chk_reset_codes_usage CHECK (used_count >= 0 AND used_count <= max_uses AND max_uses = 1)
);
INSERT INTO device_reset_codes_new (id, user_id, code_hash, created_by, status, max_uses, used_count, expires_at, used_at, created_at)
SELECT id, user_id, code_hash, created_by, status, max_uses, used_count, expires_at, used_at, created_at
FROM device_reset_codes;
DROP TABLE device_reset_codes;
ALTER TABLE device_reset_codes_new RENAME TO device_reset_codes;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reset_codes_hash ON device_reset_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_reset_codes_user ON device_reset_codes(user_id, status);
CREATE INDEX IF NOT EXISTS idx_reset_codes_created_by ON device_reset_codes(created_by);

CREATE TRIGGER IF NOT EXISTS trg_prevent_reset_code_reuse
BEFORE UPDATE OF status, used_count ON device_reset_codes
FOR EACH ROW
WHEN OLD.used_count >= 1 OR OLD.status != 'active' OR OLD.expires_at <= CURRENT_TIMESTAMP
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_USE_ALREADY_USED_OR_EXPIRED_RESET_CODE');
END;

-- E. videos: Ubah ON DELETE RESTRICT ke NO ACTION
CREATE TABLE IF NOT EXISTS videos_new (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    product_name TEXT NOT NULL,
    product_url TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    uploaded_by_admin_id TEXT NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (uploaded_by_admin_id) REFERENCES users(id),
    CONSTRAINT chk_videos_status CHECK (status IN ('active', 'inactive')),
    CONSTRAINT chk_videos_file_size CHECK (file_size > 0 AND file_size <= 104857600),
    CONSTRAINT chk_videos_download_count CHECK (download_count >= 0)
);
INSERT INTO videos_new (id, title, description, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id, download_count, created_at, updated_at)
SELECT id, title, description, product_name, product_url, r2_key, content_type, file_size, status, uploaded_by_admin_id, download_count, created_at, updated_at
FROM videos;
DROP TABLE videos;
ALTER TABLE videos_new RENAME TO videos;

CREATE UNIQUE INDEX IF NOT EXISTS uq_videos_r2_key ON videos(r2_key);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);
CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by ON videos(uploaded_by_admin_id);

-- F. audit_logs: Perluasan CHECK constraint action dan ubah ON DELETE RESTRICT ke NO ACTION
CREATE TABLE IF NOT EXISTS audit_logs_new (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_user_id TEXT,
    details TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES users(id),
    FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_audit_logs_action CHECK (action IN (
        'CREATE_ACTIVATION_CODE',
        'REVOKE_ACTIVATION_CODE',
        'ISSUE_RESET_CODE',
        'REVOKE_RESET_CODE',
        'RESET_DEVICE',
        'SUSPEND_USER',
        'ACTIVATE_USER',
        'UPLOAD_VIDEO',
        'UPDATE_VIDEO',
        'DELETE_VIDEO',
        'CREATE_ADMIN',
        'SUSPEND_ADMIN',
        'ACTIVATE_ADMIN',
        'CREATE_MEMBER'
    ))
);
INSERT INTO audit_logs_new (id, admin_id, action, target_user_id, details, ip_address, user_agent, created_at)
SELECT id, admin_id, action, target_user_id, details, ip_address, user_agent, created_at
FROM audit_logs;
DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(admin_id);

-- -----------------------------------------------------------------------------
-- 2. RESTRUKTURISASI TABEL users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users_new (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active',
    activation_code_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id),
    CONSTRAINT chk_users_role CHECK (role IN ('super_admin', 'admin', 'member')),
    CONSTRAINT chk_users_status CHECK (status IN ('active', 'suspended'))
);

INSERT INTO users_new (id, username, password_hash, password_salt, role, status, activation_code_id, created_at, updated_at)
SELECT
    id,
    username,
    password_hash,
    password_salt,
    CASE
        WHEN role = 'admin' AND id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1) THEN 'super_admin'
        WHEN role = 'admin' THEN 'admin'
        WHEN role = 'user' THEN 'member'
        ELSE role
    END AS role,
    status,
    activation_code_id,
    created_at,
    updated_at
FROM users;

DROP TABLE IF EXISTS users;
ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_activation_code ON users(activation_code_id) WHERE activation_code_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- -----------------------------------------------------------------------------
-- 3. PEMBARUAN TRIGGERS PADA TABEL users
-- -----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_enforce_valid_activation_code
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.role = 'member' AND NEW.activation_code_id IS NOT NULL
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

CREATE TRIGGER IF NOT EXISTS trg_limit_super_admin_insert
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.role = 'super_admin'
BEGIN
    SELECT RAISE(ABORT, 'MAX_SUPER_ADMIN_EXCEEDED')
    WHERE (SELECT COUNT(*) FROM users WHERE role = 'super_admin') >= 3;
END;

CREATE TRIGGER IF NOT EXISTS trg_limit_super_admin_update
BEFORE UPDATE OF role ON users
FOR EACH ROW
WHEN NEW.role = 'super_admin' AND OLD.role != 'super_admin'
BEGIN
    SELECT RAISE(ABORT, 'MAX_SUPER_ADMIN_EXCEEDED')
    WHERE (SELECT COUNT(*) FROM users WHERE role = 'super_admin') >= 3;
END;

CREATE TRIGGER IF NOT EXISTS trg_protect_super_admin_delete
BEFORE DELETE ON users
FOR EACH ROW
WHEN OLD.role = 'super_admin'
BEGIN
    SELECT RAISE(ABORT, 'SUPER_ADMIN_CANNOT_BE_DELETED');
END;

CREATE TRIGGER IF NOT EXISTS trg_protect_super_admin_status
BEFORE UPDATE OF status, role ON users
FOR EACH ROW
WHEN OLD.role = 'super_admin' AND (NEW.status != 'active' OR NEW.role != 'super_admin')
BEGIN
    SELECT RAISE(ABORT, 'SUPER_ADMIN_CANNOT_BE_SUSPENDED_OR_DEMOTED');
END;

-- -----------------------------------------------------------------------------
-- 4. PEMBARUAN KEBIJAKAN PERANGKAT (user_devices)
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS uq_user_devices_user;

CREATE TRIGGER IF NOT EXISTS trg_enforce_single_active_device_insert
BEFORE INSERT ON user_devices
FOR EACH ROW
WHEN NEW.is_active = 1 AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role IN ('admin', 'member'))
BEGIN
    SELECT RAISE(ABORT, 'SINGLE_DEVICE_ENFORCEMENT_VIOLATION')
    WHERE EXISTS (
        SELECT 1 FROM user_devices
        WHERE user_id = NEW.user_id AND is_active = 1 AND id != NEW.id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_enforce_single_active_device_update
BEFORE UPDATE OF is_active, user_id ON user_devices
FOR EACH ROW
WHEN NEW.is_active = 1 AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role IN ('admin', 'member'))
BEGIN
    SELECT RAISE(ABORT, 'SINGLE_DEVICE_ENFORCEMENT_VIOLATION')
    WHERE EXISTS (
        SELECT 1 FROM user_devices
        WHERE user_id = NEW.user_id AND is_active = 1 AND id != NEW.id
    );
END;

CREATE INDEX IF NOT EXISTS idx_user_devices_user_active ON user_devices(user_id, is_active);

-- -----------------------------------------------------------------------------
-- 5. PEMBARUAN METADATA SKEMA
-- -----------------------------------------------------------------------------
UPDATE system_metadata
SET value = '1.2.0', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';

PRAGMA defer_foreign_keys = OFF;
