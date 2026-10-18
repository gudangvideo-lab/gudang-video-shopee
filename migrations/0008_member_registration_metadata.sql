-- =============================================================================
-- Migration: 0008_member_registration_metadata.sql
-- Deskripsi: Penambahan metadata pendaftaran anggota pada tabel users:
--            nomor WhatsApp, jalur pendaftaran (direct/referral), dan nama pengundang.
--            Kompatibel penuh dengan data akun lama (nullable / default 'direct').
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. PENAMBAHAN KOLOM PADA TABEL users
-- -----------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN whatsapp TEXT;
ALTER TABLE users ADD COLUMN registration_path TEXT DEFAULT 'direct';
ALTER TABLE users ADD COLUMN inviter_name TEXT;

-- -----------------------------------------------------------------------------
-- 2. INDEKS UNTUK PENCARIAN / FILTER JALUR PENDAFTARAN
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_registration_path ON users(registration_path);
