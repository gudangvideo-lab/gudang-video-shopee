/**
 * frontend/src/pages/LoginPage.tsx
 * Halaman masuk ke portal Gudang Video Shopee Affiliate.
 * Dilengkapi penanganan khusus untuk penegakan satu perangkat (DEVICE_NOT_AUTHORIZED).
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter, Link } from '../router/Router';
import { authApi, ApiClientError } from '../api/client';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Alert } from '../components/Alert';

export const LoginPage: React.FC = () => {
  const { refreshUser } = useAuth();
  const { navigate, params } = useRouter();

  const [username, setUsername] = useState(params.get('username') || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setDeviceError(false);

    const cleanUsername = username.trim();
    if (!cleanUsername) {
      setErrorMsg('Silakan masukkan nama pengguna Anda.');
      return;
    }
    if (!password) {
      setErrorMsg('Silakan masukkan kata sandi Anda.');
      return;
    }

    setLoading(true);
    try {
      await authApi.login({ username: cleanUsername, password });
      const success = await refreshUser();
      if (success) {
        navigate('/');
      } else {
        setErrorMsg('Login berhasil namun verifikasi sesi gagal. Silakan muat ulang halaman.');
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.errorCode === 'DEVICE_NOT_AUTHORIZED') {
          setDeviceError(true);
          setErrorMsg(
            'Browser atau perangkat ini belum terdaftar untuk akun Anda. Kebijakan keamanan Gudang Video Shopee hanya mengizinkan 1 perangkat aktif per akun.'
          );
        } else {
          setErrorMsg(err.message);
        }
      } else {
        setErrorMsg('Terjadi kesalahan yang tidak terduga saat mencoba login.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-badge">🛍️</div>
          <h2>Masuk ke Gudang Video</h2>
          <p className="auth-subtext">
            Gunakan akun affiliate yang telah diaktivasi pada perangkat ini.
          </p>
        </div>

        {deviceError && (
          <Alert type="warning" title="Perangkat Belum Terdaftar">
            <p>
              {errorMsg}
            </p>
            <div className="alert-action-box">
              <p className="hint-text">
                Pindah laptop/HP atau membersihkan browser? Hubungi Admin untuk meminta <strong>Kode Reset Perangkat</strong> (berlaku 30 menit).
              </p>
              <Button
                variant="outline"
                className="btn-sm"
                onClick={() => navigate(`/reset-device?username=${encodeURIComponent(username.trim())}`)}
              >
                Pindah / Reset Perangkat Sekarang &rarr;
              </Button>
            </div>
          </Alert>
        )}

        {!deviceError && errorMsg && (
          <Alert type="danger" onClose={() => setErrorMsg(null)}>
            {errorMsg}
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <Input
            label="Nama Pengguna"
            id="login-username"
            name="username"
            type="text"
            placeholder="Contoh: affiliator_sukses"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            disabled={loading}
          />

          <Input
            label="Kata Sandi"
            id="login-password"
            name="password"
            type="password"
            placeholder="Masukkan kata sandi akun"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            disabled={loading}
          />

          <Button
            type="submit"
            variant="primary"
            loading={loading}
            loadingText="Memverifikasi Akun..."
            className="w-full mt-2"
          >
            Masuk ke Portal
          </Button>
        </form>

        <div className="auth-card-footer">
          <div className="footer-links">
            <p>
              Punya kode pembelian baru?{' '}
              <Link to="/activate" className="text-shopee font-medium">
                Aktivasi Akun
              </Link>
            </p>
            <p>
              Ganti perangkat atau browser?{' '}
              <Link
                to={username.trim() ? `/reset-device?username=${encodeURIComponent(username.trim())}` : '/reset-device'}
                className="text-shopee font-medium"
              >
                Reset Ikatan Perangkat
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
