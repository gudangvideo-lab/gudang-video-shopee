# Panduan Binding Cloudflare D1 dan Cloudflare R2

Dokumen ini menjelaskan cara mengonfigurasi binding Cloudflare D1 (database relasional SQLite terdistribusi) dan Cloudflare R2 (object storage untuk file video) pada proyek **Gudang Video Shopee Affiliate**.

---

## 1. Konsep Dasar Cloudflare Bindings

*Binding* memungkinkan Cloudflare Worker berinteraksi langsung dengan layanan Cloudflare lainnya (seperti D1 dan R2) tanpa perlu mengelola kredensial API eksternal secara manual. Binding diinjeksi secara aman ke parameter `env` pada runtime Worker.

---

## 2. Cloudflare D1 (Database)

### A. Membuat Database D1

Anda dapat membuat database melalui salah satu cara berikut:

1. **Melalui Cloudflare Dashboard:**
   - Buka Cloudflare Dashboard > **Storage & Databases** > **D1**.
   - Klik **Create database**.
   - Beri nama database, misalnya: `gudang-video-db`.
   - Catat **Database ID** yang ditampilkan.

2. **Melalui Wrangler CLI:**
   ```bash
   npx wrangler d1 create gudang-video-db
   ```
   Wrangler akan menampilkan output berupa potongan konfigurasi JSON/TOML yang memuat `database_id`.

### B. Mendaftarkan Binding di `wrangler.jsonc`

Perbarui bagian `d1_databases` di file `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "gudang-video-db",
    "database_id": "<MASUKKAN_DATABASE_ID_DARI_CLOUDFLARE>"
  }
]
```

### C. Menjalankan SQL Migrations

File migrasi tersimpan di folder `migrations/`.

- **Uji coba di lingkungan lokal:**
  ```bash
  npx wrangler d1 execute gudang-video-db --local --file=./migrations/0001_initial_schema.sql
  ```
- **Eksekusi ke Cloudflare D1 (Production/Remote):**
  ```bash
  npx wrangler d1 execute gudang-video-db --remote --file=./migrations/0001_initial_schema.sql
  ```

---

## 3. Cloudflare R2 (Penyimpanan Video)

### A. Membuat R2 Bucket

1. **Melalui Cloudflare Dashboard:**
   - Buka Cloudflare Dashboard > **Storage & Databases** > **R2**.
   - Klik **Create bucket**.
   - Beri nama bucket, misalnya: `gudang-video-storage`.
   - Pilih lokasi default (misalnya automatic / APAC).

2. **Melalui Wrangler CLI:**
   ```bash
   npx wrangler r2 bucket create gudang-video-storage
   ```

### B. Mendaftarkan Binding di `wrangler.jsonc`

Perbarui bagian `r2_buckets` di file `wrangler.jsonc`:

```jsonc
"r2_buckets": [
  {
    "binding": "VIDEOS_BUCKET",
    "bucket_name": "gudang-video-storage"
  }
]
```

### C. Mengakses di Kode Worker

Di dalam handler Worker (`worker/index.ts`), R2 dapat diakses melalui `env.VIDEOS_BUCKET`:

```typescript
// Contoh pembacaan file (read object)
const videoObject = await env.VIDEOS_BUCKET.get("video-sample.mp4");

// Contoh penyimpanan file (put object)
await env.VIDEOS_BUCKET.put("video-sample.mp4", streamOrBuffer, {
  httpMetadata: { contentType: "video/mp4" }
});
```

---

## 4. Keamanan dan Praktik Terbaik

1. **Jangan Commit Secret ke Git:**
   - File konfigurasi `wrangler.jsonc` hanya memuat nama binding dan database ID yang bersifat metadata.
   - Variabel rahasia lokal disimpan di `.dev.vars` yang sudah diabaikan oleh `.gitignore`.
2. **Pengujian Lokal:**
   - Wrangler menyediakan simulasi lokal penuh untuk D1 (menggunakan SQLite lokal) dan R2 (menggunakan local storage) dengan flag `--local` tanpa menyentuh data produksi di Cloudflare.
3. **Penyimpanan Video:**
   - Pastikan video tidak dibuka untuk publik secara sembarangan jika memerlukan proteksi kuota atau autentikasi affiliate. Gunakan Worker sebagai pengatur akses streaming / unduhan.
