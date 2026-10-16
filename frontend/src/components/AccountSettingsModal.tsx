/**
 * frontend/src/components/AccountSettingsModal.tsx
 * Modal pengelolaan akun mandiri (Self-Service) untuk semua role:
 * 1. Ubah username sendiri (memerlukan kata sandi saat ini)
 * 2. Ubah kata sandi sendiri (memerlukan kata sandi lama)
 */

import React, { useState } from 'react';
import { Modal } from './Modal';
import { Input } from './Input';
import { Button } from './Button';
import { Alert } from './Alert';
import { useAuth } from '../context/AuthContext';
import { authApi, ApiClientError } from '../api/client';

interface AccountSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AccountSettingsModal: React.FC<AccountSettingsModalProps> = ({
  isOpen,
  onClose
}) => {
  const { user, refreshUser } = useAuth();
  const [activeTab, setActiveTab] = useState<'username' | 'password'>('username');

  // Form State: Username
  const [newUsername, setNewUsername] = useState('');
  const [usernamePassword, setUsernamePassword] = useState('');
  const [usernameLoading, setUsernameLoading] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSuccess, setUsernameSuccess] = useState<string | null>(null);

  // Form State: Password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  const resetFormState = () => {
    setNewUsername('');
    setUsernamePassword('');
    setUsernameError(null);
    setUsernameSuccess(null);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError(null);
    setPasswordSuccess(null);
  };

  const handleClose = () => {
    resetFormState();
    onClose();
  };

  const handleUpdateUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    setUsernameError(null);
    setUsernameSuccess(null);

    if (!newUsername.trim()) {
      setUsernameError('Nama pengguna baru wajib diisi.');
      return;
    }

    if (!usernamePassword) {
      setUsernameError('Kata sandi saat ini wajib diisi untuk verifikasi.');
      return;
    }

    setUsernameLoading(true);
    try {
      const res = await authApi.changeUsername({
        new_username: newUsername.trim(),
        current_password: usernamePassword
      });
      setUsernameSuccess(res.message || 'Nama pengguna berhasil diperbarui.');
      await refreshUser();
      setNewUsername('');
      setUsernamePassword('');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setUsernameError(err.message);
      } else {
        setUsernameError('Gagal memperbarui nama pengguna.');
      }
    } finally {
      setUsernameLoading(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (!currentPassword) {
      setPasswordError('Kata sandi saat ini wajib diisi.');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('Kata sandi baru minimal 8 karakter.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('Konfirmasi kata sandi baru tidak cocok.');
      return;
    }

    setPasswordLoading(true);
    try {
      const res = await authApi.changePassword({
        current_password: currentPassword,
        new_password: newPassword
      });
      setPasswordSuccess(res.message || 'Kata sandi berhasil diperbarui.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setPasswordError(err.message);
      } else {
        setPasswordError('Gagal memperbarui kata sandi.');
      }
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Pengaturan Akun & Keamanan"
      maxWidth="500px"
    >
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', borderBottom: '1px solid #e5e7eb', paddingBottom: '10px' }}>
        <button
          type="button"
          className={`btn btn-sm ${activeTab === 'username' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => { setActiveTab('username'); setUsernameError(null); setUsernameSuccess(null); }}
        >
          👤 Ganti Username
        </button>
        <button
          type="button"
          className={`btn btn-sm ${activeTab === 'password' ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => { setActiveTab('password'); setPasswordError(null); setPasswordSuccess(null); }}
        >
          🔒 Ganti Password
        </button>
      </div>

      {activeTab === 'username' && (
        <form onSubmit={handleUpdateUsername}>
          <div style={{ marginBottom: '16px', background: '#f9fafb', padding: '12px', borderRadius: '6px' }}>
            <span style={{ fontSize: '0.85rem', color: '#6b7280' }}>Username Saat Ini:</span>
            <div style={{ fontWeight: 600, color: '#111827', fontSize: '1rem' }}>{user?.username}</div>
          </div>

          {usernameError && <Alert type="danger" className="mb-3">{usernameError}</Alert>}
          {usernameSuccess && <Alert type="success" className="mb-3">{usernameSuccess}</Alert>}

          <Input
            label="Nama Pengguna Baru"
            placeholder="Ketik username baru (3-30 karakter)"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            disabled={usernameLoading}
            required
          />

          <Input
            label="Kata Sandi Saat Ini"
            type="password"
            placeholder="Masukkan kata sandi untuk konfirmasi"
            value={usernamePassword}
            onChange={(e) => setUsernamePassword(e.target.value)}
            disabled={usernameLoading}
            required
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
            <Button type="button" variant="outline" onClick={handleClose} disabled={usernameLoading}>
              Tutup
            </Button>
            <Button type="submit" variant="primary" loading={usernameLoading}>
              Simpan Username
            </Button>
          </div>
        </form>
      )}

      {activeTab === 'password' && (
        <form onSubmit={handleUpdatePassword}>
          {passwordError && <Alert type="danger" className="mb-3">{passwordError}</Alert>}
          {passwordSuccess && <Alert type="success" className="mb-3">{passwordSuccess}</Alert>}

          <Input
            label="Kata Sandi Lama"
            type="password"
            placeholder="Masukkan kata sandi saat ini"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={passwordLoading}
            required
          />

          <Input
            label="Kata Sandi Baru"
            type="password"
            placeholder="Minimal 8 karakter"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={passwordLoading}
            required
          />

          <Input
            label="Konfirmasi Kata Sandi Baru"
            type="password"
            placeholder="Ulangi kata sandi baru"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={passwordLoading}
            required
          />

          <p style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '8px' }}>
            ℹ️ Memperbarui kata sandi akan mencabut sesi aktif lainnya di browser yang berbeda.
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
            <Button type="button" variant="outline" onClick={handleClose} disabled={passwordLoading}>
              Tutup
            </Button>
            <Button type="submit" variant="primary" loading={passwordLoading}>
              Perbarui Kata Sandi
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
};
