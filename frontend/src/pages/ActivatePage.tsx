/**
 * frontend/src/pages/ActivatePage.tsx
 * Halaman Aktivasi Akun pertama kali menggunakan Kode Aktivasi sekali pakai.
 * Mengikat akun secara permanen ke browser/perangkat saat ini.
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter, Link } from '../router/Router';
import { authApi, ApiClientError } from '../api/client';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Alert } from '../components/Alert';

export const ActivatePage: React.FC = () => {
  const { refreshUser } = useAuth();
  const { navigate } = useRouter();

  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [shopeeLink, setShopeeLink] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [registrationPath, setRegistrationPath] = useState<'direct' | 'referral'>('direct');
  const [inviterName, setInviterName] = useState('');
  const [deviceName, setDeviceName] = useState('');

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const cleanCode = code.trim().toUpperCase();
    const cleanUsername = username.trim();
    const cleanShopeeLink = shopeeLink.trim();
    const cleanWhatsapp = whatsapp.trim().replace(/[\s-]/g, '');

    if (!cleanCode) {
      setErrorMsg('Kode aktivasi wajib diisi.');
      return;
    }

    if (!cleanShopeeLink) {
      setErrorMsg('Tautan akun/profil Shopee Affiliate wajib diisi.');
      return;
    }

    if (!cleanWhatsapp) {
      setErrorMsg('Nomor WhatsApp wajib diisi.');
      return;
    }

    let normalizedWa = cleanWhatsapp;
    if (normalizedWa.startsWith('+62')) {
      normalizedWa = '62' + normalizedWa.slice(3);
    } else if (normalizedWa.startsWith('08')) {
      normalizedWa = '628' + normalizedWa.slice(2);
    }

    if (!/^628[1-9][0-9]{7,11}$/.test(normalizedWa)) {
      setErrorMsg('Nomor WhatsApp tidak valid. Gunakan format nomor Indonesia (contoh: 08123456789 atau 628123456789).');
      return;
    }

    if (registrationPath === 'referral') {
      const cleanInviter = inviterName.trim();
      if (!cleanInviter) {
        setErrorMsg('Nama pengundang wajib diisi jika mendaftar melalui undangan.');
        return;
      }
      if (cleanInviter.length < 2 || cleanInviter.length > 100) {
        setErrorMsg('Nama pengundang harus berupa 2-100 karakter.');
        return;
      }
    }

    if (!cleanUsername) {
      setErrorMsg('Nama pengguna wajib diisi.');
      return;
    }

    if (!/^[a-zA-Z0-9_]{3,30}$/.test(cleanUsername)) {
      setErrorMsg('Nama pengguna harus berupa 3-30 karakter alfanumerik atau garis bawah (_).');
      return;
    }

    if (password.length < 8) {
      setErrorMsg('Kata sandi minimal 8 karakter demi keamanan akun Anda.');
      return;
    }

    if (password !== confirmPassword) {
      setErrorMsg('Konfirmasi kata sandi tidak cocok.');
      return;
    }

    setLoading(true);
    try {
      const res = await authApi.activate({
        activation_code: cleanCode,
        username: cleanUsername,
        password,
        shopee_link: cleanShopeeLink,
        whatsapp: normalizedWa,
        registration_path: registrationPath,
        inviter_name: registrationPath === 'referral' ? inviterName.trim() : null,
        device_name: deviceName.trim() || undefined
      });

      setSuccessMsg(res.message || 'Akun dan perangkat berhasil diaktifkan!');
      await refreshUser();

      // Berikan jeda sejenak agar pengguna membaca konfirmasi sukses sebelum dialihkan
      setTimeout(() => {
        navigate('/');
      }, 1200);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal mengaktifkan akun. Silakan periksa koneksi Anda dan coba lagi.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-badge">🔑</div>
          <h2>Aktivasi Akun Baru</h2>
          <p className="auth-subtext">
            Masukkan kode aktivasi resmi dari admin untuk mengikat akun dan browser ini.
          </p>
        </div>

        {successMsg && (
          <Alert type="success" title="Aktivasi Berhasil!">
            <p>{successMsg}</p>
            <p className="hint-text mt-1">Mengalihkan Anda ke portal...</p>
          </Alert>
        )}

        {errorMsg && (
          <Alert type="danger" onClose={() => setErrorMsg(null)}>
            {errorMsg}
          </Alert>
        )}

        <div className="security-notice-box">
          <span className="notice-icon">🛡️</span>
          <span className="notice-text">
            <strong>Penting:</strong> Akun ini akan terikat secara permanen pada browser ini. Pastikan Anda melakukan aktivasi pada perangkat kerja utama Anda.
          </span>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <Input
            label="Kode Aktivasi"
            id="activate-code"
            name="activation_code"
            type="text"
            placeholder="Contoh: GVS-ABCDEF234567..."
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            required
            helperText="Kode 130-bit sekali pakai yang Anda terima setelah pembelian akses."
            disabled={loading || !!successMsg}
          />

          <Input
            label="Nama Pengguna Baru"
            id="activate-username"
            name="username"
            type="text"
            placeholder="Pilih nama pengguna (3-30 karakter)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            disabled={loading || !!successMsg}
          />

          <Input
            label="Kata Sandi Baru"
            id="activate-password"
            name="password"
            type="password"
            placeholder="Minimal 8 karakter"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            disabled={loading || !!successMsg}
          />

          <Input
            label="Ulangi Kata Sandi"
            id="activate-confirm-password"
            name="confirm_password"
            type="password"
            placeholder="Ketik ulang kata sandi yang sama"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
            disabled={loading || !!successMsg}
          />

          <Input
            label="Tautan Akun / Profil Shopee Affiliate"
            id="activate-shopee-link"
            name="shopee_link"
            type="url"
            placeholder="Contoh: https://shopee.co.id/username atau https://shope.ee/..."
            value={shopeeLink}
            onChange={(e) => setShopeeLink(e.target.value)}
            required
            helperText="Wajib: Tautan profil atau affiliate Shopee Anda. Akun Anda akan terikat pada profil ini."
            disabled={loading || !!successMsg}
          />

          <Input
            label="Nomor WhatsApp"
            id="activate-whatsapp"
            name="whatsapp"
            type="tel"
            placeholder="Contoh: 08123456789 atau 628123456789"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            required
            helperText="Wajib: Nomor WhatsApp aktif Anda (format Indonesia)."
            disabled={loading || !!successMsg}
          />

          <div className="form-group">
            <label className="form-label">
              Jalur Pendaftaran
              <span className="required-mark"> *</span>
            </label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  id="activate-reg-direct"
                  name="registration_path"
                  value="direct"
                  checked={registrationPath === 'direct'}
                  onChange={() => setRegistrationPath('direct')}
                  disabled={loading || !!successMsg}
                />
                <span>Daftar sendiri</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  id="activate-reg-referral"
                  name="registration_path"
                  value="referral"
                  checked={registrationPath === 'referral'}
                  onChange={() => setRegistrationPath('referral')}
                  disabled={loading || !!successMsg}
                />
                <span>Melalui undangan anggota lain</span>
              </label>
            </div>
            <p className="form-helper-text">
              Pilih apakah Anda mendaftar mandiri atau atas rekomendasi anggota lain.
            </p>
          </div>

          {registrationPath === 'referral' && (
            <Input
              label="Nama Pengundang"
              id="activate-inviter-name"
              name="inviter_name"
              type="text"
              placeholder="Ketik nama atau panggilan pengundang Anda"
              value={inviterName}
              onChange={(e) => setInviterName(e.target.value)}
              required
              helperText="Wajib: 2-100 karakter nama anggota yang mengundang Anda."
              disabled={loading || !!successMsg}
            />
          )}

          <Input
            label="Nama Perangkat (Opsional)"
            id="activate-device-name"
            name="device_name"
            type="text"
            placeholder="Contoh: MacBook Air Kantor / PC Rumah"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            helperText="Label pengenal perangkat untuk memudahkan identifikasi."
            disabled={loading || !!successMsg}
          />

          <Button
            type="submit"
            variant="primary"
            loading={loading}
            loadingText="Mengaktifkan & Mengikat Perangkat..."
            className="w-full mt-2"
            disabled={!!successMsg}
          >
            Aktifkan Akun & Masuk
          </Button>
        </form>

        <div className="auth-card-footer">
          <p>
            Sudah pernah aktivasi akun?{' '}
            <Link to="/login" className="text-shopee font-medium">
              Masuk di Sini
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};
