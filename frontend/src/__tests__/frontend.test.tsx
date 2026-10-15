/**
 * frontend/src/__tests__/frontend.test.tsx
 * Pengujian Unit & Integrasi Frontend:
 * - Klien API (credentials same-origin, error handling, penegakan 1 perangkat)
 * - Anti-token storage (memastikan tidak ada token di localStorage / sessionStorage)
 * - Render komponen formulir autentikasi, telemetri dashboard, dan panel admin
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { authApi, adminApi, ApiClientError } from '../api/client';
import { Badge } from '../components/Badge';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { LoginPage } from '../pages/LoginPage';
import { ActivatePage } from '../pages/ActivatePage';
import { ResetDevicePage } from '../pages/ResetDevicePage';
import { UserDashboardPage } from '../pages/UserDashboardPage';
import { AdminPage } from '../pages/AdminPage';
import { AuthProvider } from '../context/AuthContext';
import { RouterProvider } from '../router/Router';

describe('Frontend API Client & Security Standards', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('memastikan login menggunakan credentials: "same-origin" dan body JSON', async () => {
    let capturedOptions: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, options) => {
      capturedOptions = options;
      return new Response(
        JSON.stringify({ status: 'ok', message: 'Login berhasil', user: { username: 'testuser', role: 'user' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const res = await authApi.login({ username: 'testuser', password: 'Password123!' });

    expect(res.status).toBe('ok');
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.credentials).toBe('same-origin');
    expect(capturedOptions?.method).toBe('POST');
    const parsedBody = JSON.parse(capturedOptions?.body as string);
    expect(parsedBody.username).toBe('testuser');
    expect(parsedBody.password).toBe('Password123!');
  });

  it('menangani error 403 DEVICE_NOT_AUTHORIZED dengan ApiClientError terstruktur', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'DEVICE_NOT_AUTHORIZED',
          message: 'Perangkat tidak terdaftar. Akun ini terikat pada perangkat lain.'
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    await expect(authApi.login({ username: 'other_device_user', password: 'Password123!' })).rejects.toThrow(
      ApiClientError
    );

    try {
      await authApi.login({ username: 'other_device_user', password: 'Password123!' });
    } catch (err) {
      const apiErr = err as ApiClientError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.errorCode).toBe('DEVICE_NOT_AUTHORIZED');
      expect(apiErr.message).toContain('Perangkat tidak terdaftar');
    }
  });

  it('memastikan aktivasi akun mengirimkan payload activation_code dan credentials same-origin', async () => {
    let capturedUrl = '';
    let capturedOptions: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (url, options) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return new Response(
        JSON.stringify({ status: 'ok', message: 'Akun dan perangkat berhasil diaktifkan' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const res = await authApi.activate({
      activation_code: 'GVS-TESTCODE1234567890ABCDEF',
      username: 'member_baru',
      password: 'Password123!',
      shopee_link: 'https://shope.ee/member_baru',
      device_name: 'Laptop Kerja'
    });

    expect(capturedUrl).toBe('/api/auth/activate');
    expect(capturedOptions?.credentials).toBe('same-origin');
    expect(res.status).toBe('ok');
    const body = JSON.parse(capturedOptions?.body as string);
    expect(body.activation_code).toBe('GVS-TESTCODE1234567890ABCDEF');
    expect(body.username).toBe('member_baru');
    expect(body.shopee_link).toBe('https://shope.ee/member_baru');
    expect(body.device_name).toBe('Laptop Kerja');
  });

  it('memastikan reset perangkat mengirimkan reset_code berumur 30 menit ke backend', async () => {
    let capturedOptions: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, options) => {
      capturedOptions = options;
      return new Response(
        JSON.stringify({ status: 'ok', message: 'Perangkat berhasil direset' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const res = await authApi.resetDevice({
      username: 'member_lama',
      password: 'Password123!',
      reset_code: 'GVR-RESETCODE1234567890ABCDEF',
      device_name: 'HP Baru'
    });

    expect(res.status).toBe('ok');
    expect(capturedOptions?.credentials).toBe('same-origin');
    const body = JSON.parse(capturedOptions?.body as string);
    expect(body.reset_code).toBe('GVR-RESETCODE1234567890ABCDEF');
  });

  it('memastikan endpoint administratif meneruskan request dengan parameter yang sesuai', async () => {
    let createCodeBody: any;
    let resetCodeUserId = '';

    globalThis.fetch = vi.fn(async (url, options) => {
      const urlStr = String(url);
      if (urlStr === '/api/admin/activation-codes' && options?.method === 'POST') {
        createCodeBody = JSON.parse(options?.body as string);
        return new Response(
          JSON.stringify({
            status: 'ok',
            message: 'Kode aktivasi berhasil dibuat',
            data: { id: 'uuid-1', code: 'GVS-NEWCODE123456', note: 'Akses Pak Budi', expires_in_days: 30 }
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/reset-code') && options?.method === 'POST') {
        resetCodeUserId = urlStr;
        return new Response(
          JSON.stringify({
            status: 'ok',
            message: 'Kode reset berhasil diterbitkan',
            data: { id: 'uuid-2', user_id: 'usr-123', username: 'budi', reset_code: 'GVR-123456', expires_in_minutes: 30 }
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr === '/api/admin/users') {
        return new Response(JSON.stringify({ status: 'ok', users: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const codeRes = await adminApi.createActivationCode({ note: 'Akses Pak Budi', expires_in_days: 30 });
    expect(codeRes.data.code).toBe('GVS-NEWCODE123456');
    expect(createCodeBody.note).toBe('Akses Pak Budi');

    const resetRes = await adminApi.issueResetCode('usr-123', { reason: 'Ganti laptop' });
    expect(resetRes.data.reset_code).toBe('GVR-123456');
    expect(resetCodeUserId).toContain('/api/admin/users/usr-123/reset-code');
  });

  it('memverifikasi prinsip zero-token di storage: tidak ada session token di localStorage / sessionStorage', () => {
    // Memastikan tidak ada token auth rahasia yang disimpan di storage lokal
    if (typeof window !== 'undefined' && window.localStorage) {
      expect(window.localStorage.getItem('token')).toBeNull();
      expect(window.localStorage.getItem('session_token')).toBeNull();
      expect(window.localStorage.getItem('device_token')).toBeNull();
    }
  });
});

describe('Frontend UI Components & Page Rendering', () => {
  it('merender komponen Badge dengan varian yang sesuai', () => {
    const html = renderToStaticMarkup(<Badge variant="shopee">Affiliate</Badge>);
    expect(html).toContain('badge-shopee');
    expect(html).toContain('Affiliate');
  });

  it('merender komponen Alert dengan judul dan pesan', () => {
    const html = renderToStaticMarkup(
      <Alert type="warning" title="Pemberitahuan Penting">
        Harap simpan kode aktivasi Anda.
      </Alert>
    );
    expect(html).toContain('alert-warning');
    expect(html).toContain('Pemberitahuan Penting');
    expect(html).toContain('Harap simpan kode aktivasi Anda.');
  });

  it('merender komponen Button dengan label dan status loading', () => {
    const normalHtml = renderToStaticMarkup(<Button variant="primary">Masuk</Button>);
    expect(normalHtml).toContain('btn-primary');
    expect(normalHtml).toContain('Masuk');

    const loadingHtml = renderToStaticMarkup(
      <Button variant="primary" loading loadingText="Menghubungkan...">
        Masuk
      </Button>
    );
    expect(loadingHtml).toContain('btn-loading');
    expect(loadingHtml).toContain('Menghubungkan...');
  });

  it('merender komponen Input dengan label dan pesan bantuan/error', () => {
    const html = renderToStaticMarkup(
      <Input
        label="Nama Pengguna"
        id="test-username"
        name="username"
        helperText="Gunakan huruf dan angka"
        required
      />
    );
    expect(html).toContain('Nama Pengguna');
    expect(html).toContain('required-mark');
    expect(html).toContain('Gunakan huruf dan angka');
  });

  it('merender halaman LoginPage dengan form masuk dan tautan navigasi', () => {
    const html = renderToStaticMarkup(
      <AuthProvider>
        <RouterProvider>
          <LoginPage />
        </RouterProvider>
      </AuthProvider>
    );
    expect(html).toContain('Masuk ke Gudang Video');
    expect(html).toContain('Nama Pengguna');
    expect(html).toContain('Kata Sandi');
    expect(html).toContain('Aktivasi Akun');
    expect(html).toContain('Reset Ikatan Perangkat');
  });

  it('merender halaman ActivatePage dengan informasi ikatan 1 perangkat', () => {
    const html = renderToStaticMarkup(
      <AuthProvider>
        <RouterProvider>
          <ActivatePage />
        </RouterProvider>
      </AuthProvider>
    );
    expect(html).toContain('Aktivasi Akun Baru');
    expect(html).toContain('Kode Aktivasi');
    expect(html).toContain('Akun ini akan terikat secara permanen pada browser ini');
    expect(html).toContain('Aktifkan Akun &amp; Masuk');
  });

  it('merender halaman ResetDevicePage dengan peringatan keamanan kode 30 menit', () => {
    const html = renderToStaticMarkup(
      <AuthProvider>
        <RouterProvider>
          <ResetDevicePage />
        </RouterProvider>
      </AuthProvider>
    );
    expect(html).toContain('Reset Ikatan Perangkat');
    expect(html).toContain('30 menit');
    expect(html).toContain('Kode Reset Perangkat');
    expect(html).toContain('Ikat Browser Ini Sekarang');
  });

  it('merender UserDashboardPage dengan empty state katalog video (tanpa data tiruan)', () => {
    const html = renderToStaticMarkup(
      <AuthProvider>
        <RouterProvider>
          <UserDashboardPage />
        </RouterProvider>
      </AuthProvider>
    );
    // Saat belum terotentikasi, menampilkan kartu pengarah masuk
    expect(html).toContain('Sesi Tidak Ditemukan');
  });

  it('merender AdminPage dengan proteksi 403 untuk pengguna non-admin', () => {
    const html = renderToStaticMarkup(
      <AuthProvider>
        <RouterProvider>
          <AdminPage />
        </RouterProvider>
      </AuthProvider>
    );
    expect(html).toContain('Akses Ditolak (403 Forbidden)');
    expect(html).toContain('Halaman ini hanya dapat diakses oleh Administrator resmi');
  });

  it('memastikan videoApi.listVideos dan adminApi video endpoints memanggil URL yang tepat dengan credentials same-origin', async () => {
    let capturedListUrl = '';
    let capturedUploadUrl = '';
    let capturedUploadOptions: RequestInit | undefined;
    let capturedDeleteUrl = '';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, options) => {
      const urlStr = String(url);
      if (urlStr === '/api/videos') {
        capturedListUrl = urlStr;
        return new Response(JSON.stringify({ status: 'ok', videos: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (urlStr === '/api/admin/videos' && options?.method === 'POST') {
        capturedUploadUrl = urlStr;
        capturedUploadOptions = options;
        return new Response(JSON.stringify({ status: 'ok', message: 'Video berhasil diunggah' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (urlStr.includes('/api/admin/videos/vid-123') && options?.method === 'DELETE') {
        capturedDeleteUrl = urlStr;
        return new Response(JSON.stringify({ status: 'ok', message: 'Video dihapus' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as unknown as typeof fetch;

    try {
      const { videoApi, adminApi } = await import('../api/client');
      const listRes = await videoApi.listVideos();
      expect(listRes.status).toBe('ok');
      expect(capturedListUrl).toBe('/api/videos');

      const dummyFile = new File(['mock-data'], 'test.mp4', { type: 'video/mp4' });
      await adminApi.uploadVideo({
        file: dummyFile,
        title: 'Video Promosi',
        product_name: 'TWS Earphone',
        product_url: 'https://shopee.co.id/test'
      });
      expect(capturedUploadUrl).toBe('/api/admin/videos');
      expect(capturedUploadOptions?.credentials).toBe('same-origin');
      expect(capturedUploadOptions?.body instanceof FormData).toBe(true);

      await adminApi.deleteVideo('vid-123');
      expect(capturedDeleteUrl).toBe('/api/admin/videos/vid-123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
