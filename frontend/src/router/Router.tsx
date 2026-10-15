/**
 * frontend/src/router/Router.tsx
 * Router berbasis browser History API tanpa dependensi eksternal.
 * Mendukung navigasi path standar (SPA) dan fallback hash.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export type RoutePath =
  | '/'
  | '/login'
  | '/activate'
  | '/reset-device'
  | '/admin'
  | '/admin/codes'
  | '/admin/users'
  | '/admin/logs';

interface RouterContextType {
  path: string;
  params: URLSearchParams;
  navigate: (to: string, replace?: boolean) => void;
}

const RouterContext = createContext<RouterContextType | undefined>(undefined);

function normalizePath(rawPath: string): string {
  // Dukung hash-routing jika pengguna membuka via '#/login'
  if (rawPath.startsWith('#')) {
    const hashClean = rawPath.replace(/^#/, '');
    return hashClean.startsWith('/') ? hashClean : `/${hashClean}`;
  }
  const clean = rawPath.split('?')[0].split('#')[0];
  return clean || '/';
}

export const RouterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentLocation, setCurrentLocation] = useState(() => {
    if (typeof window === 'undefined') return { path: '/', search: '' };
    const hash = window.location.hash;
    if (hash.startsWith('#/')) {
      const parts = hash.slice(1).split('?');
      return { path: parts[0], search: parts[1] ? `?${parts[1]}` : '' };
    }
    return { path: window.location.pathname, search: window.location.search };
  });

  useEffect(() => {
    const handleLocationChange = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#/')) {
        const parts = hash.slice(1).split('?');
        setCurrentLocation({ path: parts[0], search: parts[1] ? `?${parts[1]}` : '' });
      } else {
        setCurrentLocation({
          path: window.location.pathname,
          search: window.location.search
        });
      }
    };

    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);

    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, []);

  const navigate = useCallback((to: string, replace = false) => {
    if (typeof window === 'undefined') return;

    const url = new URL(to, window.location.origin);
    const targetPath = url.pathname;
    const targetSearch = url.search;

    if (replace) {
      window.history.replaceState({}, '', to);
    } else {
      window.history.pushState({}, '', to);
    }

    setCurrentLocation({ path: targetPath, search: targetSearch });
    window.scrollTo(0, 0);
  }, []);

  const normalized = normalizePath(currentLocation.path);
  const params = new URLSearchParams(currentLocation.search);

  return (
    <RouterContext.Provider value={{ path: normalized, params, navigate }}>
      {children}
    </RouterContext.Provider>
  );
};

export function useRouter(): RouterContextType {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useRouter must be used within a RouterProvider');
  }
  return context;
}

export const Link: React.FC<{
  to: string;
  className?: string;
  children: React.ReactNode;
  onClick?: () => void;
}> = ({ to, className, children, onClick }) => {
  const { navigate } = useRouter();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Biarkan browser menangani command/ctrl click untuk open in new tab
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (onClick) onClick();
    navigate(to);
  };

  return (
    <a href={to} className={className} onClick={handleClick}>
      {children}
    </a>
  );
};
