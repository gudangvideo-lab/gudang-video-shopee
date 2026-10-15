/**
 * frontend/src/App.tsx
 * Komponen utama aplikasi Gudang Video Shopee Affiliate.
 */

import React from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { RouterProvider, useRouter } from './router/Router';
import { Navbar } from './components/Navbar';
import { LoginPage } from './pages/LoginPage';
import { ActivatePage } from './pages/ActivatePage';
import { ResetDevicePage } from './pages/ResetDevicePage';
import { UserDashboardPage } from './pages/UserDashboardPage';
import { AdminPage } from './pages/AdminPage';

const AppRoutes: React.FC = () => {
  const { user, loading } = useAuth();
  const { path } = useRouter();

  if (loading) {
    return (
      <div className="app-loading-screen">
        <div className="loading-card">
          <div className="spinner-large" />
          <h3 className="mt-4 font-semibold text-slate-800">Gudang Video Shopee</h3>
          <p className="text-muted mt-1 text-sm">Memeriksa status sesi & perangkat...</p>
        </div>
      </div>
    );
  }

  const renderCurrentPage = () => {
    switch (path) {
      case '/login':
        return <LoginPage />;
      case '/activate':
        return <ActivatePage />;
      case '/reset-device':
        return <ResetDevicePage />;
      case '/admin':
      case '/admin/codes':
      case '/admin/users':
      case '/admin/logs':
        return <AdminPage />;
      case '/':
      default:
        // Jika belum login dan mengakses halaman utama, arahkan ke login
        if (!user) {
          return <LoginPage />;
        }
        return <UserDashboardPage />;
    }
  };

  return (
    <div className="app-layout">
      <Navbar />
      <main className="main-content">{renderCurrentPage()}</main>
      <footer className="app-footer">
        <div className="footer-container">
          <p className="text-muted text-xs">
            &copy; {new Date().getFullYear()} Gudang Video Shopee Affiliate &bull; Cloudflare Workers &bull; D1 Database &bull; R2 Private Storage
          </p>
        </div>
      </footer>
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <RouterProvider>
        <AppRoutes />
      </RouterProvider>
    </AuthProvider>
  );
};

export default App;
