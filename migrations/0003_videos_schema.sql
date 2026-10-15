-- =============================================================================
-- Migration: 0003_videos_schema.sql
-- Deskripsi: Skema penyimpanan metadata video Cloudflare R2 dan perluasan audit logs
--            untuk Gudang Video Shopee Affiliate.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABEL: videos
-- Menyimpan metadata video affiliate dan object key R2 privat.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,                              -- UUID v4
    title TEXT NOT NULL,                              -- Judul video (1-200 karakter)
    description TEXT,                                 -- Deskripsi/catatan konten (opsional)
    product_name TEXT NOT NULL,                       -- Nama produk Shopee terkait
    product_url TEXT NOT NULL,                        -- URL produk Shopee asli
    r2_key TEXT NOT NULL,                             -- Object key acak internal di bucket R2
    content_type TEXT NOT NULL,                       -- MIME type video (e.g. video/mp4, video/webm)
    file_size INTEGER NOT NULL,                       -- Ukuran file dalam bytes
    status TEXT NOT NULL DEFAULT 'active',            -- 'active' | 'inactive'
    uploaded_by_admin_id TEXT NOT NULL,               -- FK ke users.id (admin pengunggah)
    download_count INTEGER NOT NULL DEFAULT 0,        -- Total frekuensi unduhan
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (uploaded_by_admin_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_videos_status CHECK (status IN ('active', 'inactive')),
    CONSTRAINT chk_videos_file_size CHECK (file_size > 0 AND file_size <= 104857600), -- Maksimal 100 MB
    CONSTRAINT chk_videos_download_count CHECK (download_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_videos_r2_key ON videos(r2_key);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);
CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by ON videos(uploaded_by_admin_id);

-- -----------------------------------------------------------------------------
-- 2. PEMBARUAN TABEL: audit_logs
-- Memperluas check constraint action agar mencakup tindakan video operasional:
-- 'UPLOAD_VIDEO', 'UPDATE_VIDEO', 'DELETE_VIDEO'.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs_new (
    id TEXT PRIMARY KEY,                              -- UUID v4
    admin_id TEXT NOT NULL,                           -- FK ke users.id (admin pelaku)
    action TEXT NOT NULL,                             -- Aksi administratif
    target_user_id TEXT,                              -- FK ke users.id (opsional)
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
        'ACTIVATE_USER',
        'UPLOAD_VIDEO',
        'UPDATE_VIDEO',
        'DELETE_VIDEO'
    ))
);

-- Pindahkan data lama jika tabel audit_logs sudah ada
INSERT OR IGNORE INTO audit_logs_new (id, admin_id, action, target_user_id, details, ip_address, user_agent, created_at)
SELECT id, admin_id, action, target_user_id, details, ip_address, user_agent, created_at
FROM audit_logs;

DROP TABLE IF EXISTS audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_user_id);
