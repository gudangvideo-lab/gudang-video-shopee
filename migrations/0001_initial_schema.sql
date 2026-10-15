-- =============================================================================
-- Migration: 0001_initial_schema.sql
-- Deskripsi: Fondasi skema awal database Cloudflare D1 (SQLite) untuk Gudang Video Shopee.
-- Catatan: File ini TIDAK memuat data pengguna sungguhan.
-- =============================================================================

-- Tabel metadata sistem untuk mencatat inisialisasi database
CREATE TABLE IF NOT EXISTS system_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Inisialisasi status versi skema dasar
INSERT OR IGNORE INTO system_metadata (key, value)
VALUES ('schema_version', '1.0.0');

-- =============================================================================
-- DOKUMENTASI STRUKTUR TABEL MASA DEPAN (Contoh Struktur Placeholder):
-- Struktur tabel di bawah dapat diaktifkan pada migrasi berikutnya saat fitur dikembangkan.
--
-- CREATE TABLE IF NOT EXISTS videos (
--     id TEXT PRIMARY KEY,
--     title TEXT NOT NULL,
--     r2_key TEXT NOT NULL,
--     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
-- );
-- =============================================================================
