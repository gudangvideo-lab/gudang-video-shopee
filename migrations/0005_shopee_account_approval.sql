-- =============================================================================
-- Migration: 0005_shopee_account_approval.sql
-- Deskripsi: Penambahan kolom shopee_link pada tabel users, tabel permohonan
--            perubahan akun Shopee (shopee_account_requests) dengan batasan
--            maksimal 1 permohonan pending per member, dan perluasan audit_logs.
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. PENAMBAHAN KOLOM shopee_link PADA TABEL users
-- -----------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN shopee_link TEXT;

-- -----------------------------------------------------------------------------
-- 2. PEMBUATAN TABEL: shopee_account_requests
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopee_account_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    current_shopee_link TEXT,
    requested_shopee_link TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    reviewed_by_admin_id TEXT,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by_admin_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_shopee_req_status CHECK (status IN ('pending', 'approved', 'rejected'))
);

-- Penegakan tepat MAKSIMAL 1 permohonan pending per member (Unique Partial Index)
CREATE UNIQUE INDEX IF NOT EXISTS uq_shopee_requests_user_pending
ON shopee_account_requests(user_id)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_shopee_requests_status ON shopee_account_requests(status);
CREATE INDEX IF NOT EXISTS idx_shopee_requests_user ON shopee_account_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_shopee_requests_created_at ON shopee_account_requests(created_at);

-- -----------------------------------------------------------------------------
-- 3. RESTRUKTURISASI TABEL: audit_logs
-- Memperluas check constraint action untuk mencakup manajemen akun Shopee
-- -----------------------------------------------------------------------------
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
        'CREATE_MEMBER',
        'REQUEST_SHOPEE_LINK_CHANGE',
        'APPROVE_SHOPEE_LINK_CHANGE',
        'REJECT_SHOPEE_LINK_CHANGE',
        'SET_INITIAL_SHOPEE_LINK'
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
SET value = '1.3.0', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';

PRAGMA defer_foreign_keys = OFF;
