# gudang-video-shopee
Gudang Video Shopee Affiliate — aplikasi katalog dan distribusi video affiliate.

---

## 1. Deskripsi & Tujuan Aplikasi
**Gudang Video Shopee Affiliate** adalah platform web yang dirancang untuk mengelola katalog, pratinjau, dan distribusi konten video bagi para kreator affiliate Shopee. Aplikasi dibangun di atas infrastruktur serverless Cloudflare agar hemat biaya, memiliki latensi rendah, aman, dan mudah diskalakan.

Tahap saat ini adalah **fondasi awal (scaffolding dasar)** yang memisahkan frontend, backend worker, skema database, pengujian, dan dokumentasi secara bersih.

---

## 2. Arsitektur Teknologi
- **Frontend**: React 18, TypeScript, Vite.
- **Backend / API**: Cloudflare Workers (TypeScript).
- **Database**: Cloudflare D1 (Serverless SQLite).
- **Penyimpanan Objek**: Cloudflare R2 (Penyimpanan file video tanpa biaya egress data).
- **Static Asset Serving**: Cloudflare Workers Static Assets.
- **Pengujian**: Vitest.

---

## 3. Struktur Folder Proyek

```text
gudang-video-shopee/
├── .env.example              # Dokumentasi template variabel lingkungan
├── .gitignore                # Aturan file yang diabaikan Git (rahasia & build)
├── README.md                 # Dokumentasi utama proyek
├── package.json              # Konfigurasi dependensi dan skrip proyek
├── tsconfig.json             # Root TypeScript config (Project References)
├── tsconfig.frontend.json    # Konfigurasi TypeScript untuk Frontend React
├── tsconfig.worker.json      # Konfigurasi TypeScript untuk Worker & Tests
├── wrangler.jsonc            # Konfigurasi Cloudflare Wrangler & resource bindings
├── docs/                     # Dokumentasi arsitektur dan panduan setup
│   └── CLOUDFLARE_BINDINGS.md # Panduan konfigurasi Cloudflare D1 & R2
├── frontend/                 # Kode sumber Frontend (React + Vite)
│   ├── index.html            # Entry point HTML
│   ├── vite.config.ts        # Konfigurasi Vite & proxy lokal
│   ├── public/               # Asset statis publik
│   └── src/                  # Komponen dan logic React
│       ├── App.tsx           # Komponen root aplikasi
│       ├── main.tsx          # Bootstrap React DOM
│       ├── index.css         # Styling dasar
│       └── vite-env.d.ts     # Type definition Vite
├── migrations/               # Berkas skrip SQL Migrations untuk Cloudflare D1
│   └── 0001_initial_schema.sql # Skema inisialisasi minimal D1
├── tests/                    # Berkas pengujian otomatis (Unit Tests)
│   └── health.test.ts        # Pengujian endpoint pemeriksaan kesehatan Worker
└── worker/                   # Kode sumber Backend (Cloudflare Worker)
    ├── index.ts              # Handler Worker utama & endpoint /api/health
    └── types.ts              # Tipe data TypeScript untuk Env & Bindings
```

---

## 4. Persyaratan Sistem
Sebelum menjalankan proyek, pastikan sistem Anda telah terpasang:
- **Node.js**: Versi `^20.0.0` (LTS direkomendasikan)
- **npm**: Versi `^10.0.0`
- **Git**

---

## 5. Cara Instalasi dan Menjalankan Proyek Secara Lokal

### Langkah 1: Instalasi Dependensi
Jalankan perintah berikut di root folder proyek:
```bash
npm install
```

### Langkah 2: Menyiapkan File Lingkungan (Opsional)
Salin `.env.example` jika ingin menyesuaikan variabel lokal:
```bash
cp .env.example .env
```

### Langkah 3: Menjalankan Backend Worker
Jalankan Cloudflare Worker di lingkungan simulasi lokal:
```bash
npm run dev:worker
```
Worker akan berjalan di `http://localhost:8787`. Endpoint health check dapat diakses di:
`http://localhost:8787/api/health`

### Langkah 4: Menjalankan Frontend React
Di jendela terminal baru, jalankan server pengembangan Vite:
```bash
npm run dev:frontend
```
Frontend akan berjalan di `http://localhost:5173`. Request ke `/api/*` secara otomatis diarahkan ke Worker lokal via proxy Vite.

---

## 6. Pengujian dan Pengecekan Kode

- **Menjalankan Unit Test (Vitest):**
  ```bash
  npm test
  ```
- **Pengecekan Tipe TypeScript:**
  ```bash
  npm run typecheck
  ```
- **Build Frontend untuk Produksi:**
  ```bash
  npm run build
  ```

---

## 7. Konfigurasi Cloudflare D1 & R2
Untuk panduan menghubungkan Cloudflare D1 dan R2 bucket, silakan baca dokumentasi lengkap di:
[`docs/CLOUDFLARE_BINDINGS.md`](file:///d:/Projects/gudang-video-shopee/docs/CLOUDFLARE_BINDINGS.md).
