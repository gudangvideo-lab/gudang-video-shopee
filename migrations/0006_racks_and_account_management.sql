-- =============================================================================
-- Migration: 0006_racks_and_account_management.sql
-- Deskripsi: Penambahan sistem rak (kategori) video dengan rak default 'General',
--            penambahan kolom rack_id pada tabel videos, perluasan audit_logs
--            untuk manajemen akun (ganti username, ganti password, reset password,
--            pembuatan super admin, penghapusan user, dan operasi rak).
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. PEMBUATAN TABEL: racks (Sistem Rak / Kategori Video)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS racks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_racks_default CHECK (is_default IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_racks_name ON racks(name);
CREATE INDEX IF NOT EXISTS idx_racks_default ON racks(is_default);

-- Lindungi Rak General bawaan agar tidak dapat dihapus
CREATE TRIGGER IF NOT EXISTS trg_protect_default_rack_delete
BEFORE DELETE ON racks
FOR EACH ROW
WHEN OLD.is_default = 1 OR OLD.id = '00000000-0000-0000-0000-000000000001'
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_DELETE_DEFAULT_RACK');
END;

-- Lindungi Rak General bawaan agar tidak dapat diubah namanya
CREATE TRIGGER IF NOT EXISTS trg_protect_default_rack_update
BEFORE UPDATE OF name, is_default ON racks
FOR EACH ROW
WHEN OLD.is_default = 1 OR OLD.id = '00000000-0000-0000-0000-000000000001'
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_MODIFY_DEFAULT_RACK');
END;

-- Sisipkan rak default 'General'
INSERT OR IGNORE INTO racks (id, name, is_default, created_by, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'General', 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- -----------------------------------------------------------------------------
-- 2. PENAMBAHAN KOLOM rack_id PADA TABEL videos
-- -----------------------------------------------------------------------------
ALTER TABLE videos ADD COLUMN rack_id TEXT REFERENCES racks(id);

UPDATE videos
SET rack_id = '00000000-0000-0000-0000-000000000001'
WHERE rack_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_videos_rack_id ON videos(rack_id);

-- -----------------------------------------------------------------------------
-- 3. RESTRUKTURISASI TABEL: audit_logs
-- Relaksasi foreign key admin_id ke SET NULL dan perluasan action
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs_new (
    id TEXT PRIMARY KEY,
    admin_id TEXT,
    action TEXT NOT NULL,
    target_user_id TEXT,
    details TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL,
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
        'CREATE_MEMBER',
        'REQUEST_SHOPEE_LINK_CHANGE',
        'APPROVE_SHOPEE_LINK_CHANGE',
        'REJECT_SHOPEE_LINK_CHANGE',
        'SET_INITIAL_SHOPEE_LINK',
        'CHANGE_USERNAME',
        'CHANGE_PASSWORD',
        'RESET_PASSWORD',
        'CREATE_SUPER_ADMIN',
        'DELETE_USER',
        'REVOKE_SESSIONS',
        'CREATE_RACK',
        'UPDATE_RACK',
        'DELETE_RACK',
        'MOVE_VIDEO_RACK'
    ))
);

INSERT INTO audit_logs_new (id, admin_id, action, target_user_id, details, ip_address, user_agent, created_at)
SELECT id, admin_id, action, target_user_id, details, ip_address, user_agent, created_at
FROM audit_logs;

DROP TABLE IF EXISTS audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(admin_id);

-- -----------------------------------------------------------------------------
-- 4. PEMBARUAN METADATA SKEMA
-- -----------------------------------------------------------------------------
UPDATE system_metadata
SET value = '1.4.0', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';

PRAGMA defer_foreign_keys = OFF;
