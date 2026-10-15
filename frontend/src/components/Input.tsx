/**
 * frontend/src/components/Input.tsx
 * Komponen Input form terstandar dengan label dan pesan validasi.
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
  ...props
}) => {
  const inputId = id || props.name || Math.random().toString(36).substring(2, 9);

  return (
    <div className={`form-group ${error ? 'has-error' : ''} ${className}`}>
      {label && (
        <label htmlFor={inputId} className="form-label">
          {label}
          {required && <span className="required-mark"> *</span>}
        </label>
      )}
      <input
        id={inputId}
        {...props}
        className={`form-input ${error ? 'input-error' : ''}`}
        aria-invalid={!!error}
        aria-describedby={error ? `${inputId}-error` : helperText ? `${inputId}-help` : undefined}
      />
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
