/**
 * frontend/src/components/Button.tsx
 * Komponen tombol interaktif dengan animasi loading dan state disabled.
 */

import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'outline';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingText?: string;
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  loading = false,
  loadingText,
  icon,
  children,
  disabled,
  className = '',
  ...props
}) => {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`btn btn-${variant} ${loading ? 'btn-loading' : ''} ${className}`}
    >
      {loading ? (
        <span className="btn-loading-wrapper">
          <span className="spinner" aria-hidden="true" />
          <span>{loadingText || 'Memproses...'}</span>
        </span>
      ) : (
        <span className="btn-content">
          {icon && <span className="btn-icon">{icon}</span>}
          <span>{children}</span>
        </span>
      )}
    </button>
  );
};
