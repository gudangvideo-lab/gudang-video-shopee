/**
 * frontend/src/components/Alert.tsx
 * Komponen kotak peringatan/pesan informasi dengan berbagai tingkat keparahan.
 */

import React from 'react';

export type AlertType = 'info' | 'success' | 'warning' | 'danger';

interface AlertProps {
  type?: AlertType;
  title?: string;
  children: React.ReactNode;
  onClose?: () => void;
  className?: string;
}

export const Alert: React.FC<AlertProps> = ({
  type = 'info',
  title,
  children,
  onClose,
  className = ''
}) => {
  return (
    <div className={`alert-box alert-${type} ${className}`} role="alert">
      <div className="alert-content">
        {title && <strong className="alert-title">{title}</strong>}
        <div className="alert-message">{children}</div>
      </div>
      {onClose && (
        <button
          type="button"
          className="alert-close-btn"
          onClick={onClose}
          aria-label="Tutup pemberitahuan"
        >
          &times;
        </button>
      )}
    </div>
  );
};
