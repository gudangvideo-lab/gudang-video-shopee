/**
 * frontend/src/pages/ResetDevicePage.tsx
 * Halaman untuk memindahkan atau mereset ikatan perangkat ke browser baru.
 * Memerlukan kredensial pengguna dan Kode Reset Perangkat (30 menit) dari admin.
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter, Link } from '../router/Router';
import { authApi, ApiClientError } from '../api/client';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Alert } from '../components/Alert';

export const ResetDevicePage: React.FC = () => {
  const { refreshUser } = useAuth();
  const { navigate, params } = useRouter();

  const [username, setUsername] = useState(params.get('username') || '');
  const [password, setPassword] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [deviceName, setDeviceName] = useState('');

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const cleanUsername = username.trim();
    const cleanResetCode = resetCode.trim().toUpperCase();

    if (!cleanUsername) {
      setErrorMsg('Nama pengguna wajib diisi.');
      return;
    }
    if (!password) {
      setErrorMsg('Kata sandi akun wajib diisi.');
      return;
    }
    if (!cleanResetCode) {
      setErrorMsg('Kode reset perangkat wajib diisi.');
      return;
    }

    setLoading(true);
    try {
      const res = await authApi.resetDevice({
        username: cleanUsername,
        password,
        reset_code: cleanResetCode,
        device_name: deviceName.trim() || undefined
      });

      setSuccessMsg(res.message || 'Perangkat berhasil direset dan browser ini telah terikat!');
      await refreshUser();

      setTimeout(() => {
        navigate('/');
      }, 1200);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Terjadi kesalahan saat memproses reset perangkat. Silakan coba kembali.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-badge">🔄</div>
          <h2>Reset Ikatan Perangkat</h2>
          <p className="auth-subtext">
            Ikat akun Anda ke peramban atau perangkat baru ini menggunakan Kode Reset dari Admin.
          </p>
        </div>

        {successMsg && (
          <Alert type="success" title="Reset Berhasil!">
            <p>{successMsg}</p>
            <p className="hint-text mt-1">Mengalihkan ke beranda...</p>
          </Alert>
        )}

        {errorMsg && (
          <Alert type="danger" onClose={() => setErrorMsg(null)}>
            {errorMsg}
          </Alert>
        )}

        <div className="security-notice-box warning-theme">
          <span className="notice-icon">⚠️</span>
          <div className="notice-text">
            <strong>Perhatian Keamanan:</strong>
            <p className="mt-1">
              Kode Reset Perangkat diterbitkan oleh Admin, hanya berlaku selama <strong>30 menit</strong>, dan bersifat sekali pakai.
              Setelah reset berhasil, akses di perangkat lama akan langsung dicabut secara permanen.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <Input
            label="Nama Pengguna"
            id="reset-username"
            name="username"
            type="text"
            placeholder="Nama pengguna akun Anda"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            disabled={loading || !!successMsg}
          />

          <Input
            label="Kata Sandi Akun"
            id="reset-password"
            name="password"
            type="password"
            placeholder="Masukkan kata sandi akun Anda"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading || !!successMsg}
          />

          <Input
            label="Kode Reset Perangkat"
            id="reset-code"
            name="reset_code"
            type="text"
            placeholder="Contoh: GVR-ABCDEF234567..."
            value={resetCode}
            onChange={(e) => setResetCode(e.target.value.toUpperCase())}
            required
            helperText="Dapatkan kode ini dari administrator setelah verifikasi identitas Anda."
            disabled={loading || !!successMsg}
          />

          <Input
            label="Nama Perangkat Baru (Opsional)"
            id="reset-device-name"
            name="device_name"
            type="text"
            placeholder="Contoh: Chrome Windows Rumah"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            helperText="Label untuk mengenali perangkat/browser baru ini."
            disabled={loading || !!successMsg}
          />

          <Button
            type="submit"
            variant="primary"
            loading={loading}
            loadingText="Memverifikasi & Mengikat Perangkat Baru..."
            className="w-full mt-2"
            disabled={!!successMsg}
          >
            Ikat Browser Ini Sekarang
          </Button>
        </form>

        <div className="auth-card-footer">
          <div className="footer-links">
            <p>
              Belum meminta kode reset?{' '}
              <span className="text-muted">Hubungi Admin Shopee Affiliate Anda.</span>
            </p>
            <p>
              Kembali ke halaman login?{' '}
              <Link to="/login" className="text-shopee font-medium">
                Masuk
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
