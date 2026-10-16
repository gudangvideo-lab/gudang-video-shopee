/**
 * frontend/src/components/Navbar.tsx
 * Komponen navigasi utama aplikasi dengan identitas Shopee Affiliate.
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter, Link } from '../router/Router';
import { Badge } from './Badge';
import { AccountSettingsModal } from './AccountSettingsModal';

export const Navbar: React.FC = () => {
  const { user, logout } = useAuth();
  const { path, navigate } = useRouter();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <header className="app-header">
      <div className="header-container">
        <Link to="/" className="brand-logo">
          <span className="brand-badge-icon">🛍️</span>
          <div className="brand-titles">
            <span className="brand-name">Gudang Video Shopee</span>
            <span className="brand-subtitle">Affiliate Creator Portal</span>
          </div>
        </Link>

        <nav className="nav-menu">
          {user ? (
            <div className="nav-user-cluster">
              <Link
                to="/"
                className={`nav-link ${path === '/' ? 'active' : ''}`}
              >
                Katalog Video
              </Link>

              {(user.role === 'admin' || user.role === 'super_admin') && (
                <Link
                  to="/admin"
                  className={`nav-link ${path.startsWith('/admin') ? 'active' : ''}`}
                >
                  {user.role === 'super_admin' ? 'Panel Super Admin' : 'Panel Admin'}
                </Link>
              )}

              <div
                className="user-profile-badge"
                style={{ cursor: 'pointer' }}
                onClick={() => setIsSettingsOpen(true)}
                title="Klik untuk membuka Pengaturan Akun & Keamanan"
              >
                <span className="username-display">⚙️ {user.username}</span>
                <Badge
                  variant={
                    user.role === 'super_admin'
                      ? 'danger'
                      : user.role === 'admin'
                      ? 'warning'
                      : 'success'
                  }
                >
                  {user.role === 'super_admin'
                    ? 'Super Admin'
                    : user.role === 'admin'
                    ? 'Administrator'
                    : 'Member Affiliate'}
                </Badge>
              </div>

              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setIsSettingsOpen(true)}
                title="Pengaturan Akun & Password"
              >
                Akun Saya
              </button>

              <button
                type="button"
                className="btn btn-outline btn-sm logout-btn"
                onClick={handleLogout}
              >
                Keluar
              </button>

              <AccountSettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
              />
            </div>
          ) : (
            <div className="nav-guest-cluster">
              <Link
                to="/login"
                className={`nav-link ${path === '/login' ? 'active' : ''}`}
              >
                Masuk
              </Link>
              <Link
                to="/activate"
                className={`nav-link ${path === '/activate' ? 'active' : ''}`}
              >
                Aktivasi Akun
              </Link>
              <Link
                to="/reset-device"
                className={`nav-link ${path === '/reset-device' ? 'active' : ''}`}
              >
                Reset Perangkat
              </Link>
            </div>
          )}
        </nav>
      </div>
    </header>
  );
};
