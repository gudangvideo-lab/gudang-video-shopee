-- =============================================================================
-- Migration: 0009_commission_proofs.sql
-- Deskripsi: Penambahan tabel bukti komisi mingguan member (commission_proofs)
--            dengan penegakan tepat SATU bukti aktif per member (UNIQUE(user_id)),
--            serta perluasan aksi pada tabel audit_logs untuk pencatatan upload,
--            penggantian, dan penghapusan bukti komisi.
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. PEMBUATAN TABEL: commission_proofs
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_proofs (
    id TEXT PRIMARY KEY,                                      -- UUID v4
    user_id TEXT NOT NULL UNIQUE,                            -- FK ke users.id (Tepat 1 bukti aktif per member)
    r2_key TEXT NOT NULL UNIQUE,                             -- Object key acak privat di Cloudflare R2
    original_filename TEXT NOT NULL,                         -- Nama file yang disanitasi
    file_size INTEGER NOT NULL,                              -- Ukuran file dalam bytes (Maks 5 MB)
    content_type TEXT NOT NULL,                              -- MIME type biner terverifikasi (image/jpeg, image/png, image/webp)
    uploaded_by_user_id TEXT,                                -- FK ke users.id pengunggah (member itu sendiri / admin)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_commission_proof_size CHECK (file_size > 0 AND file_size <= 5242880)
);

CREATE INDEX IF NOT EXISTS idx_commission_proofs_user ON commission_proofs(user_id);
CREATE INDEX IF NOT EXISTS idx_commission_proofs_created_at ON commission_proofs(created_at);

-- -----------------------------------------------------------------------------
-- 2. RESTRUKTURISASI TABEL: audit_logs
-- Memperluas check constraint action untuk mencakup:
-- 'UPLOAD_COMMISSION_PROOF', 'REPLACE_COMMISSION_PROOF', 'DELETE_COMMISSION_PROOF'
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
        'MOVE_VIDEO_RACK',
        'UPLOAD_COMMISSION_PROOF',
        'REPLACE_COMMISSION_PROOF',
        'DELETE_COMMISSION_PROOF'
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
-- 3. PEMBARUAN METADATA SKEMA KE 1.6.0
-- -----------------------------------------------------------------------------
UPDATE system_metadata
SET value = '1.6.0', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';

PRAGMA defer_foreign_keys = OFF;
