-- =============================================================================
-- Migration: 0007_max_two_super_admins.sql
-- Deskripsi: Penegakan kebijakan keamanan maksimal 2 akun Super Admin,
--            pembaruan trigger pembatasan Super Admin (insert/update),
--            dan proteksi akun Super Admin terakhir agar tidak dapat dihapus,
--            dinonaktifkan, atau diturunkan rolenya.
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. HAPUS TRIGGER LAMA DARI MIGRASI SEBELUMNYA
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_limit_super_admin_insert;
DROP TRIGGER IF EXISTS trg_limit_super_admin_update;
DROP TRIGGER IF EXISTS trg_protect_super_admin_delete;
DROP TRIGGER IF EXISTS trg_protect_super_admin_status;
DROP TRIGGER IF EXISTS trg_protect_last_super_admin_delete;
DROP TRIGGER IF EXISTS trg_protect_last_super_admin_status;

-- -----------------------------------------------------------------------------
-- 2. PEMBATASAN MAKSIMAL 2 SUPER ADMIN PADA TINGKAT DATABASE
-- -----------------------------------------------------------------------------

-- Batasi pembuatan Super Admin baru tepat maksimal 2 akun
CREATE TRIGGER IF NOT EXISTS trg_limit_super_admin_insert
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.role = 'super_admin'
BEGIN
    SELECT RAISE(ABORT, 'MAX_SUPER_ADMIN_EXCEEDED')
    WHERE (SELECT COUNT(*) FROM users WHERE role = 'super_admin') >= 2;
END;

-- Cegah promosi akun menjadi Super Admin jika sudah ada 2 Super Admin
CREATE TRIGGER IF NOT EXISTS trg_limit_super_admin_update
BEFORE UPDATE OF role ON users
FOR EACH ROW
WHEN NEW.role = 'super_admin' AND OLD.role != 'super_admin'
BEGIN
    SELECT RAISE(ABORT, 'MAX_SUPER_ADMIN_EXCEEDED')
    WHERE (SELECT COUNT(*) FROM users WHERE role = 'super_admin') >= 2;
END;

-- -----------------------------------------------------------------------------
-- 3. PERLINDUNGAN AKUN SUPER ADMIN TERAKHIR
-- Memastikan sistem tidak pernah kehilangan seluruh akun Super Admin aktif
-- -----------------------------------------------------------------------------

-- Lindungi Super Admin terakhir dari penghapusan
CREATE TRIGGER IF NOT EXISTS trg_protect_last_super_admin_delete
BEFORE DELETE ON users
FOR EACH ROW
WHEN OLD.role = 'super_admin'
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_DELETE_LAST_SUPER_ADMIN')
    WHERE (SELECT COUNT(*) FROM users WHERE role = 'super_admin') <= 1;
END;

-- Lindungi Super Admin aktif terakhir dari penonaktifan atau penurunan role
CREATE TRIGGER IF NOT EXISTS trg_protect_last_super_admin_status
BEFORE UPDATE OF status, role ON users
FOR EACH ROW
WHEN OLD.role = 'super_admin' AND (NEW.status != 'active' OR NEW.role != 'super_admin')
BEGIN
    SELECT RAISE(ABORT, 'CANNOT_SUSPEND_OR_DEMOTE_LAST_SUPER_ADMIN')
    WHERE (SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND status = 'active' AND id != OLD.id) = 0;
END;

-- -----------------------------------------------------------------------------
-- 4. PEMBARUAN METADATA SKEMA KE 1.5.0
-- -----------------------------------------------------------------------------
UPDATE system_metadata
SET value = '1.5.0', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';

PRAGMA defer_foreign_keys = OFF;
