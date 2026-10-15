/**
 * frontend/src/context/AuthContext.tsx
 * Pengelola status autentikasi global di memory React.
 *
 * Prinsip:
 * - Tidak ada token yang disimpan di localStorage atau sessionStorage.
 * - Sesi diverifikasi langsung ke server via GET /api/auth/me saat aplikasi dimuat.
 * - Sesi cookie HttpOnly dikelola sepenuhnya oleh browser.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { User, DeviceInfo } from '../api/types';
import { authApi, ApiClientError } from '../api/client';

interface AuthContextType {
  user: User | null;
  device: DeviceInfo | null;
  loading: boolean;
  error: string | null;
  refreshUser: () => Promise<boolean>;
  logout: () => Promise<void>;
  setUserFromResponse: (user: User, device?: DeviceInfo) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refreshUser = useCallback(async (): Promise<boolean> => {
    try {
      const res = await authApi.getMe();
      setUser(res.user);
      setDevice(res.device);
      setError(null);
      return true;
    } catch (err) {
      setUser(null);
      setDevice(null);
      if (err instanceof ApiClientError && err.status === 401) {
        // Belum login atau sesi telah berakhir
        setError(null);
      } else if (err instanceof ApiClientError) {
        setError(err.message);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await authApi.logout();
    } catch {
      // Tetap bersihkan status lokal bila request gagal
    } finally {
      setUser(null);
      setDevice(null);
      setLoading(false);
    }
  }, []);

  const setUserFromResponse = useCallback((newUser: User, newDevice?: DeviceInfo) => {
    setUser(newUser);
    if (newDevice) {
      setDevice(newDevice);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        device,
        loading,
        error,
        refreshUser,
        logout,
        setUserFromResponse
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
