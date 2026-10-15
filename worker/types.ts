export interface Env {
  // Binding ke Cloudflare D1 Database (akan dikonfigurasi via wrangler.jsonc)
  DB?: D1Database;

  // Binding ke Cloudflare R2 Bucket (akan dikonfigurasi via wrangler.jsonc)
  VIDEOS_BUCKET?: R2Bucket;

  // Binding ke Static Assets (Frontend) saat menggunakan Cloudflare Workers Static Assets
  ASSETS?: Fetcher;

  // Variabel lingkungan opsional
  ENVIRONMENT?: string;
}
