/**
 * frontend/src/components/VideoPlayerModal.tsx
 * Komponen Modal Pratinjau Pemutar Video HTML5 Responsif.
 * Memungkinkan Member, Admin, dan Super Admin memutar video inline dengan aman.
 *
 * Fitur:
 * - HTML5 <video controls preload="metadata" playsInline>
 * - Rasio proporsional dan responsif di desktop maupun perangkat sentuh mobile.
 * - Tanpa autoplay bersuara (kontrol penuh oleh pengguna).
 * - Penanganan status error dan informasi produk Shopee.
 * - Integrasi tombol unduh langsung dari endpoint privat terverifikasi.
 */

import React, { useState } from 'react';
import { Modal } from './Modal';
import { Alert } from './Alert';
import { Badge } from './Badge';
import { videoApi } from '../api/client';

export interface VideoPreviewData {
  id: string;
  title: string;
  description?: string | null;
  product_name?: string;
  product_url?: string;
  file_size?: number;
  content_type?: string;
  status?: string;
  rack_name?: string | null;
}

interface VideoPlayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  video: VideoPreviewData | null;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({
  isOpen,
  onClose,
  video
}) => {
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset error state saat video berubah atau modal dibuka
  React.useEffect(() => {
    setHasError(false);
    setErrorMessage(null);
  }, [video?.id, isOpen]);

  if (!isOpen || !video) return null;

  const streamUrl = videoApi.getStreamUrl(video.id);
  const downloadUrl = videoApi.getDownloadUrl(video.id);

  const handleVideoError = () => {
    setHasError(true);
    setErrorMessage(
      'Gagal memutar video. Berkas mungkin sedang diproses di penyimpanan R2 atau format tidak didukung oleh browser Anda.'
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Pratinjau: ${video.title}`}
      maxWidth="680px"
      footer={
        <div className="modal-actions-cluster w-full flex justify-between items-center">
          <a
            href={downloadUrl}
            download
            className="btn btn-primary btn-sm"
            title="Unduh file video ke perangkat Anda"
          >
            ⬇ Unduh Video
          </a>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onClose}
          >
            Tutup
          </button>
        </div>
      }
    >
      <div className="video-player-container">
        {hasError && errorMessage && (
          <Alert type="danger" className="mb-4">
            {errorMessage}
          </Alert>
        )}

        <div className="video-player-frame">
          <video
            key={video.id}
            controls
            preload="metadata"
            playsInline
            controlsList="nodownload"
            className="video-element"
            onError={handleVideoError}
          >
            <source src={streamUrl} type={video.content_type || 'video/mp4'} />
            Browser Anda tidak mendukung pemutaran video HTML5 standar.
          </video>
        </div>

        <div className="video-preview-details mt-4">
          <div className="flex flex-wrap gap-2 items-center mb-2">
            {video.status && (
              <Badge variant={video.status === 'active' ? 'success' : 'neutral'}>
                {video.status === 'active' ? 'Status: Aktif' : 'Status: Nonaktif'}
              </Badge>
            )}
            <span className="badge badge-info text-xs">
              📂 {video.rack_name || 'General'}
            </span>
            {video.file_size !== undefined && (
              <span className="file-size-badge">
                {formatBytes(video.file_size)}
              </span>
            )}
            {video.content_type && (
              <span className="content-type-badge">
                {video.content_type.split('/')[1]?.toUpperCase() || 'MP4'}
              </span>
            )}
          </div>

          <h4 className="font-semibold text-base mb-1">{video.title}</h4>

          {video.description && (
            <p className="text-xs text-muted mb-3 whitespace-pre-wrap">
              {video.description}
            </p>
          )}

          {video.product_name && video.product_url && (
            <div className="product-info-box mt-3">
              <span className="product-icon">🛍️</span>
              <div className="flex-1">
                <span className="product-label">Produk Shopee:</span>
                <strong className="product-name block">{video.product_name}</strong>
              </div>
              <a
                href={video.product_url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline btn-xs"
              >
                Buka Shopee &#8599;
              </a>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
