/**
 * frontend/src/components/Input.tsx
 * Komponen Input form terstandar dengan label, pesan validasi,
 * dan dukungan toggle show/hide password yang aksesibel.
 */

import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helperText?: string;
  error?: string;
  required?: boolean;
}

export const Input: React.FC<InputProps> = ({
  label,
  helperText,
  error,
  required,
  id,
  className = '',
  type,
  ...props
}) => {
  const [showPassword, setShowPassword] = React.useState(false);
  const inputId = id || props.name || Math.random().toString(36).substring(2, 9);
  const isPassword = type === 'password';

  return (
    <div className={`form-group ${error ? 'has-error' : ''} ${className}`}>
      {label && (
        <label htmlFor={inputId} className="form-label">
          {label}
          {required && <span className="required-mark"> *</span>}
        </label>
      )}

      {isPassword ? (
        <div className="password-input-wrapper">
          <input
            id={inputId}
            {...props}
            type={showPassword ? 'text' : 'password'}
            className={`form-input password-input ${error ? 'input-error' : ''}`}
            aria-invalid={!!error}
            aria-describedby={error ? `${inputId}-error` : helperText ? `${inputId}-help` : undefined}
          />
          <button
            type="button"
            className="password-toggle-btn"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
            title={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
            tabIndex={0}
          >
            {showPassword ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
      ) : (
        <input
          id={inputId}
          {...props}
          type={type}
          className={`form-input ${error ? 'input-error' : ''}`}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : helperText ? `${inputId}-help` : undefined}
        />
      )}

      {error ? (
        <p id={`${inputId}-error`} className="form-error-msg">
          {error}
        </p>
      ) : helperText ? (
        <p id={`${inputId}-help`} className="form-helper-text">
          {helperText}
        </p>
      ) : null}
    </div>
  );
};
