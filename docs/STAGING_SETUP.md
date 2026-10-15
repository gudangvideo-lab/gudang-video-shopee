# PANDUAN PENYIAPAN & VALIDASI LINGKUNGAN STAGING

Dokumentasi ini menjelaskan prosedur resmi penyiapan dan penggunaan lingkungan staging terisolasi untuk proyek **Gudang Video Shopee Affiliate**.

---

## 1. Pemisahan Resource Produksi vs Staging

Lingkungan staging dirancang untuk sepenuhnya terpisah dari produksi pada level infrastruktur Cloudflare:

| Resource | Lingkungan Produksi | Lingkungan Staging |
| :--- | :--- | :--- |
| **File Konfigurasi** | `wrangler.jsonc` | `wrangler.staging.jsonc` |
| **Worker Name** | `gudang-video-shopee` | `gudang-video-shopee-staging` |
| **Domain Worker** | `https://gudang-video-shopee.gudangvideoshopee.workers.dev` | `https://gudang-video-shopee-staging.gudangvideoshopee.workers.dev` |
| **Cloudflare D1 Name** | `gudang-video-db` | `gudang-video-db-staging` |
| **D1 Database UUID** | `562ff396-402c-4633-9449-e7ce591c9225` | *UUID Baru (Diperoleh saat pembuatan D1 Staging)* |
| **Cloudflare R2 Bucket** | `gudang-video-storage` | `gudang-video-storage-staging` |
| **Binding D1 / R2** | `DB` / `VIDEOS_BUCKET` | `DB` / `VIDEOS_BUCKET` |

---

## 2. Placeholder Kritis pada `wrangler.staging.jsonc`

Pada file [`wrangler.staging.jsonc`](../wrangler.staging.jsonc), kolom `database_id` dikonfigurasi dengan nilai penanda eksplisit:
```jsonc
"database_id": "REPLACE_WITH_REAL_STAGING_D1_ID"
```

> [!CAUTION]
> **ATURAN MUTLAK KESELAMATAN:**
> 1. DILARANG menjalankan migrasi D1 atau deployment Worker staging sebelum nilai placeholder di atas diganti dengan UUID riil dari database staging baru.
> 2. DILARANG KERAS menyalin atau memasukkan UUID D1 produksi (`562ff396-402c-4633-9449-e7ce591c9225`) ke dalam file konfigurasi staging!

---

## 3. Urutan Pembuatan Resource Staging (Tahap Terpisah)

*Catatan: Langkah-langkah di bawah hanya dijalankan ketika persetujuan pembuatan resource Cloudflare telah diberikan secara resmi.*

### Langkah 1: Buat Database D1 Staging
```powershell
npx wrangler d1 create gudang-video-db-staging
```
Catat `database_id` (UUID baru) yang dikembalikan oleh Cloudflare di terminal.

### Langkah 2: Buat Bucket R2 Staging
```powershell
npx wrangler r2 bucket create gudang-video-storage-staging
```

### Langkah 3: Update `wrangler.staging.jsonc`
Ganti nilai `"database_id": "REPLACE_WITH_REAL_STAGING_D1_ID"` dengan UUID riil hasil Langkah 1.

---

## 4. Prosedur Verifikasi Isolasi Resource

Sebelum mengeksekusi migrasi atau deployment di staging, lakukan verifikasi independen:

### A. Verifikasi UUID Database D1
Pastikan ID database staging berbeda secara harfiah dari UUID produksi:
- UUID Produksi: `562ff396-402c-4633-9449-e7ce591c9225`
- UUID Staging: *(Harus berupa UUID yang berbeda 100%)*

### B. Verifikasi Binding R2 Storage
Pastikan file `wrangler.staging.jsonc` memiliki blok R2 yang mengarah ke bucket staging:
```jsonc
"r2_buckets": [
  {
    "binding": "VIDEOS_BUCKET",
    "bucket_name": "gudang-video-storage-staging"
  }
]
```

---

## 5. Urutan Migrasi dan Pengujian Staging

### Fase 1: Pembentukan Baseline Sintetis (Skema 1.1.0)
Terapkan migrasi 0001 hingga 0003 ke database staging baru:
```powershell
npx wrangler d1 execute gudang-video-db-staging --file=./migrations/0001_initial_schema.sql --config wrangler.staging.jsonc
npx wrangler d1 execute gudang-video-db-staging --file=./migrations/0002_authentication_schema.sql --config wrangler.staging.jsonc
npx wrangler d1 execute gudang-video-db-staging --file=./migrations/0003_videos_schema.sql --config wrangler.staging.jsonc
```

**Verifikasi Baseline:**
- Versi skema wajib `'1.1.0'`.
- Hitungan tabel pasca-0003: Tepat **8 tabel aplikasi** dan **1 tabel `d1_migrations`** (Total **9 tabel**).

### Fase 2: Pengujian Migrasi 0004 (Tiga Level Akun)
Setelah dataset sintetis awal terisi, eksekusi migrasi 0004:
```powershell
npx wrangler d1 execute gudang-video-db-staging --file=./migrations/0004_three_tier_roles.sql --config wrangler.staging.jsonc
```

**Verifikasi Pasca-0004:**
- Versi skema naik ke `'1.2.0'`.
- Akun admin sintetis otomatis menjadi `'super_admin'`.
- `PRAGMA foreign_key_check;` mengembalikan 0 pelanggaran.

### Fase 3: Pengujian Migrasi 0005 (Fitur Shopee)
Pastikan kolom `shopee_link` belum ada, lalu eksekusi migrasi 0005:
```powershell
npx wrangler d1 execute gudang-video-db-staging --file=./migrations/0005_shopee_account_approval.sql --config wrangler.staging.jsonc
```

**Verifikasi Pasca-0005:**
- Versi skema final naik ke `'1.3.0'`.
- Kolom `users.shopee_link` terdaftar.
- Tabel `shopee_account_requests` terdaftar.
- Hitungan tabel pasca-0005: Tepat **9 tabel aplikasi** dan **1 tabel `d1_migrations`** (Total **10 tabel**).

### Fase 4: Deployment Worker Staging
```powershell
npm run deploy:staging
# atau secara eksplisit:
npx wrangler deploy --config wrangler.staging.jsonc
```

---

## 6. Kebijakan Data Sintetis (Zero Production PII)

> [!IMPORTANT]
> **DILARANG MENYALIN DATA PRODUKSI KE STAGING.**  
> Seluruh pengujian staging wajib menggunakan data sintetis murni:
> - **Akun Super Admin Staging:** Username unik (misal: `staging_superadmin`) dengan password uji coba baru yang dibuat via utilitas hashing lokal.
> - **Akun Member Staging:** Didaftarkan melalui alur aktivasi normal menggunakan kode aktivasi baru yang di-generate di staging.
> - **File Video Staging:** Gunakan sampel video non-sensitif berukuran kecil (< 1 MB) yang diunggah khusus ke bucket `gudang-video-storage-staging`.

---

## 7. Peringatan Eksekusi Perintah CLI

1. **Perintah Default Mengarah ke Produksi:**  
   Menjalankan `npx wrangler deploy` tanpa opsi `--config` akan mengevaluasi `wrangler.jsonc` (lingkungan default produksi). Seluruh perintah staging **WAJIB MENYERTAKAN `--config wrangler.staging.jsonc`**.
2. **Shortcut Aman:**  
   Gunakan script `npm run deploy:staging` yang sudah terkonfigurasi dengan flag `--config wrangler.staging.jsonc`.
