/**
 * frontend/src/components/Badge.tsx
 * Komponen label status dengan gaya visual profesional.
 */

import React from 'react';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'shopee';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({ variant = 'neutral', children, className = '' }) => {
  return <span className={`badge badge-${variant} ${className}`}>{children}</span>;
};
