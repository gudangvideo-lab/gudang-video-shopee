/**
 * frontend/src/pages/UserDashboardPage.tsx
 * Halaman utama anggota (User Dashboard).
 * Menampilkan profil pengguna, telemetri perangkat terikat, dan katalog video privat dari Cloudflare R2.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter } from '../router/Router';
import { videoApi, shopeeApi, ApiClientError } from '../api/client';
import { VideoItem, ShopeeAccountRequest, RackItem } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Alert } from '../components/Alert';
import { Modal } from '../components/Modal';
import { Input } from '../components/Input';

export const UserDashboardPage: React.FC = () => {
  const { user, device, logout, refreshUser } = useAuth();
  const { navigate } = useRouter();

  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [racks, setRacks] = useState<RackItem[]>([]);
  const [selectedRackId, setSelectedRackId] = useState<string>('all');
  const [loadingVideos, setLoadingVideos] = useState<boolean>(true);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Shopee Affiliate state
  const [shopeeRequests, setShopeeRequests] = useState<ShopeeAccountRequest[]>([]);
  const [initialShopeeLink, setInitialShopeeLink] = useState('');
  const [savingInitialLink, setSavingInitialLink] = useState(false);
  const [initialLinkError, setInitialLinkError] = useState<string | null>(null);
  const [initialLinkSuccess, setInitialLinkSuccess] = useState<string | null>(null);

  // Change request modal state
  const [showChangeModal, setShowChangeModal] = useState(false);
  const [requestedLink, setRequestedLink] = useState('');
  const [submittingChange, setSubmittingChange] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeSuccess, setChangeSuccess] = useState<string | null>(null);

  // Request history modal state
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  const fetchShopeeRequests = useCallback(async () => {
    if (user?.role === 'member') {
      try {
        const res = await shopeeApi.listMemberRequests();
        setShopeeRequests(res.requests || []);
      } catch {
        // Abaikan error background fetch
      }
    }
  }, [user?.role]);

  const fetchRacks = useCallback(async () => {
    try {
      const res = await videoApi.listRacks();
      setRacks(res.racks || []);
    } catch {
      // Abaikan error background fetch
    }
  }, []);

  const fetchCatalog = useCallback(async (rackIdToFilter?: string) => {
    // Jika member belum memiliki shopee_link, tunda memuat katalog
    if (user?.role === 'member' && !user.shopee_link) {
      setLoadingVideos(false);
      return;
    }

    setLoadingVideos(true);
    setVideoError(null);
    try {
      const activeFilter = rackIdToFilter !== undefined ? rackIdToFilter : selectedRackId;
      const res = await videoApi.listVideos(activeFilter !== 'all' ? activeFilter : undefined);
      setVideos(res.videos || []);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 401) {
          navigate('/login');
          return;
        }
        setVideoError(err.message);
      } else {
        setVideoError('Gagal memuat katalog video dari server.');
      }
    } finally {
      setLoadingVideos(false);
    }
  }, [user?.role, user?.shopee_link, selectedRackId, navigate]);

  useEffect(() => {
    if (user) {
      fetchRacks();
      fetchCatalog(selectedRackId);
      if (user.role === 'member') {
        fetchShopeeRequests();
      }
    }
  }, [user, selectedRackId, fetchRacks, fetchCatalog, fetchShopeeRequests]);

  const handleInitialLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setInitialLinkError(null);
    setInitialLinkSuccess(null);

    const clean = initialShopeeLink.trim();
    if (!clean) {
      setInitialLinkError('Tautan akun Shopee Affiliate wajib diisi.');
      return;
    }

    setSavingInitialLink(true);
    try {
      const res = await shopeeApi.setInitialLink(clean);
      setInitialLinkSuccess(res.message || 'Tautan Shopee Affiliate berhasil didaftarkan!');
      await refreshUser();
      setInitialShopeeLink('');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setInitialLinkError(err.message);
      } else {
        setInitialLinkError('Gagal menyimpan tautan akun Shopee.');
      }
    } finally {
      setSavingInitialLink(false);
    }
  };

  const handleChangeRequestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangeError(null);
    setChangeSuccess(null);

    const clean = requestedLink.trim();
    if (!clean) {
      setChangeError('Tautan akun Shopee baru wajib diisi.');
      return;
    }

    setSubmittingChange(true);
    try {
      const res = await shopeeApi.submitRequest({ requested_shopee_link: clean });
      setChangeSuccess(res.message || 'Permohonan perubahan akun Shopee berhasil dikirim.');
      setRequestedLink('');
      await fetchShopeeRequests();
      setTimeout(() => {
        setShowChangeModal(false);
        setChangeSuccess(null);
      }, 1500);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setChangeError(err.message);
      } else {
        setChangeError('Gagal mengirim permohonan perubahan akun Shopee.');
      }
    } finally {
      setSubmittingChange(false);
    }
  };

  const pendingRequest = shopeeRequests.find((r) => r.status === 'pending');

  if (!user) {
    return (
      <div className="container-page">
        <div className="card text-center p-8">
          <h3>Sesi Tidak Ditemukan</h3>
          <p className="text-muted mt-2">Silakan masuk terlebih dahulu untuk mengakses katalog video.</p>
          <Button variant="primary" onClick={() => navigate('/login')} className="mt-4">
            Menuju Halaman Masuk
          </Button>
        </div>
      </div>
    );
  }

  const formatDate = (isoString?: string | null) => {
    if (!isoString) return '-';
    try {
      const date = new Date(isoString.replace(' ', 'T') + 'Z');
      return date.toLocaleString('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
    } catch {
      return isoString;
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const filteredVideos = videos.filter((v) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      v.title.toLowerCase().includes(q) ||
      v.product_name.toLowerCase().includes(q) ||
      (v.description && v.description.toLowerCase().includes(q))
    );
  });

  return (
    <div className="container-page">
      {/* Sambutan & Profil Pengguna */}
      <section className="dashboard-hero">
        <div className="hero-content">
          <div className="hero-avatar">👤</div>
          <div>
            <h1 className="hero-title">Halo, {user.username}!</h1>
            <p className="hero-subtitle">
              Portal distribusi konten affiliate resmi Gudang Video Shopee.
            </p>
          </div>
        </div>

        <div className="hero-badges">
          <Badge
            variant={
              user.role === 'super_admin'
                ? 'danger'
                : user.role === 'admin'
                ? 'warning'
                : 'shopee'
            }
          >
            {user.role === 'super_admin'
              ? 'Super Administrator'
              : user.role === 'admin'
              ? 'Administrator'
              : 'Member Affiliate'}
          </Badge>
          <Badge variant={user.status === 'active' ? 'success' : 'danger'}>
            Status: {user.status === 'active' ? 'Akun Aktif' : 'Dibekukan'}
          </Badge>
        </div>
      </section>

      {/* Peringatan Wajib Registrasi Shopee jika Member belum memiliki link */}
      {user.role === 'member' && !user.shopee_link && (
        <section className="dashboard-card mb-6 border-warning">
          <div className="card-header-cluster">
            <span className="card-icon">⚠️</span>
            <div>
              <h3 className="card-title text-warning">Registrasi Akun Shopee Affiliate Wajib</h3>
              <p className="card-caption">
                Anda belum mendaftarkan tautan akun Shopee Affiliate resmi Anda. Akses katalog dan pengunduhan materi video ditangguhkan hingga Anda melengkapi tautan profil/akun Shopee Anda.
              </p>
            </div>
          </div>

          {initialLinkSuccess && (
            <Alert type="success" className="mt-4">
              {initialLinkSuccess}
            </Alert>
          )}

          {initialLinkError && (
            <Alert type="danger" onClose={() => setInitialLinkError(null)} className="mt-4">
              {initialLinkError}
            </Alert>
          )}

          <form onSubmit={handleInitialLinkSubmit} className="mt-4 max-w-xl">
            <Input
              label="Tautan Akun / Profil Shopee Affiliate"
              id="initial-shopee-link"
              type="url"
              placeholder="Contoh: https://shopee.co.id/username atau https://shope.ee/..."
              value={initialShopeeLink}
              onChange={(e) => setInitialShopeeLink(e.target.value)}
              required
              helperText="Format yang diterima: tautan resmi shopee.co.id atau shope.ee. Akun Anda akan terikat pada akun Shopee ini."
              disabled={savingInitialLink}
            />
            <Button
              type="submit"
              variant="primary"
              loading={savingInitialLink}
              loadingText="Menyimpan..."
              className="mt-2"
            >
              Simpan & Buka Akses Katalog
            </Button>
          </form>
        </section>
      )}

      {/* Grid Telemetri Perangkat & Keamanan */}
      <section className="telemetry-grid">
        <div className="dashboard-card">
          <div className="card-header-cluster">
            <span className="card-icon">💻</span>
            <div>
              <h3 className="card-title">Perangkat Terikat Aktif</h3>
              <p className="card-caption">Status ikatan peramban (Single Device Binding)</p>
            </div>
          </div>

          <div className="telemetry-list">
            <div className="telemetry-item">
              <span className="telemetry-label">Nama Perangkat:</span>
              <span className="telemetry-val font-semibold">{device?.name || 'Browser Saat Ini'}</span>
            </div>
            <div className="telemetry-item">
              <span className="telemetry-label">Terikat Sejak:</span>
              <span className="telemetry-val">{formatDate(device?.boundAt)}</span>
            </div>
            <div className="telemetry-item">
              <span className="telemetry-label">Aktivitas Terakhir:</span>
              <span className="telemetry-val">{formatDate(device?.lastSeenAt)}</span>
            </div>
            <div className="telemetry-item">
              <span className="telemetry-label">Status Proteksi:</span>
              <span className="telemetry-val text-success font-medium">✓ 1 Akun = 1 Perangkat Aktif</span>
            </div>
          </div>
        </div>

        {user.role === 'member' && user.shopee_link ? (
          <div className="dashboard-card">
            <div className="card-header-cluster">
              <span className="card-icon">🛍️</span>
              <div>
                <h3 className="card-title">Akun Shopee Affiliate Terikat</h3>
                <p className="card-caption">Identitas resmi untuk distribusi konten affiliate</p>
              </div>
            </div>

            <div className="telemetry-list">
              <div className="telemetry-item">
                <span className="telemetry-label">Tautan Terdaftar:</span>
                <a
                  href={user.shopee_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="telemetry-val font-semibold text-shopee truncate max-w-xs"
                >
                  {user.shopee_link} &#8599;
                </a>
              </div>
              <div className="telemetry-item">
                <span className="telemetry-label">Status Verifikasi:</span>
                <span className="telemetry-val text-success font-medium">✓ Terverifikasi Aktif</span>
              </div>
              {pendingRequest && (
                <div className="telemetry-item">
                  <span className="telemetry-label">Permohonan Ganti:</span>
                  <Badge variant="warning">Sedang Ditinjau Admin</Badge>
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="btn-sm"
                onClick={() => setShowChangeModal(true)}
                disabled={!!pendingRequest}
              >
                {pendingRequest ? 'Permohonan Sedang Diproses' : 'Ajukan Perubahan Akun'}
              </Button>
              {shopeeRequests.length > 0 && (
                <Button
                  variant="outline"
                  className="btn-sm"
                  onClick={() => setShowHistoryModal(true)}
                >
                  Riwayat Pengajuan ({shopeeRequests.length})
                </Button>
              )}
            </div>
            {pendingRequest && (
              <p className="text-xs text-muted mt-2">
                Anda memiliki permohonan perubahan yang sedang menunggu peninjauan admin. Tautan lama Anda tetap aktif.
              </p>
            )}
          </div>
        ) : (
          <div className="dashboard-card">
            <div className="card-header-cluster">
              <span className="card-icon">🛡️</span>
              <div>
                <h3 className="card-title">Penyimpanan & Keamanan R2</h3>
                <p className="card-caption">Aset video disimpan di Cloudflare R2 Privat</p>
              </div>
            </div>

            <ul className="security-guidelines">
              <li>
                <strong>Penyimpanan Privat:</strong> Video tidak memiliki link publik; hanya dapat diunduh melalui streaming terverifikasi backend.
              </li>
              <li>
                <strong>Sesi & Akses:</strong> Unduhan langsung diverifikasi terhadap sesi aktif di browser ini.
              </li>
              <li>
                <strong>Siap Komisi:</strong> Unduh materi promosi tanpa watermark dan sematkan tautan afiliasi Shopee Anda.
              </li>
            </ul>
          </div>
        )}
      </section>

      {/* Katalog Video atau Peringatan Terkunci */}
      {user.role === 'member' && !user.shopee_link ? (
        <section className="catalog-section">
          <div className="catalog-empty-state">
            <div className="empty-icon-box">🔒</div>
            <h3 className="empty-title">Katalog Video Ditangguhkan</h3>
            <p className="empty-description">
              Silakan daftarkan tautan profil / akun Shopee Affiliate resmi Anda pada formulir di atas untuk membuka akses ke katalog video dan unduhan materi affiliate.
            </p>
          </div>
        </section>
      ) : (
        <section className="catalog-section">
          <div className="section-header-bar">
            <div>
              <h2 className="section-title">Katalog Video Affiliate Shopee</h2>
              <p className="section-subtitle">
                Materi konten video resolusi tinggi siap posting dengan tautan produk Shopee resmi.
              </p>
            </div>

            <div className="catalog-controls">
              <input
                type="text"
                className="form-input search-input"
                placeholder="Cari judul atau nama produk..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <Button
                variant="outline"
                className="btn-sm"
                onClick={() => fetchCatalog(selectedRackId)}
                loading={loadingVideos}
                loadingText="Memuat..."
              >
                Segarkan
              </Button>
            </div>
          </div>

          {/* Bilah Filter Kategori / Rak */}
          <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', margin: '16px 0', paddingBottom: '6px' }}>
            <button
              type="button"
              className={`btn btn-xs ${selectedRackId === 'all' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setSelectedRackId('all')}
            >
              Semua Rak ({videos.length})
            </button>
            {racks.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`btn btn-xs ${selectedRackId === r.id ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setSelectedRackId(r.id)}
              >
                📂 {r.name} ({r.video_count})
              </button>
            ))}
          </div>

          {videoError && (
            <Alert type="danger" onClose={() => setVideoError(null)} className="mt-4">
              {videoError}
            </Alert>
          )}

          {loadingVideos ? (
            <div className="catalog-loading-state">
              <span className="spinner" />
              <p className="mt-2 text-muted text-sm">Mengambil katalog video dari Cloudflare R2...</p>
            </div>
          ) : filteredVideos.length === 0 ? (
            <div className="catalog-empty-state">
              <div className="empty-icon-box">🎬</div>
              <h3 className="empty-title">
                {searchQuery.trim()
                  ? 'Tidak Ada Video yang Sesuai Pencarian'
                  : 'Belum Ada Video Affiliate Aktif'}
              </h3>
              <p className="empty-description">
                {searchQuery.trim()
                  ? `Tidak ditemukan video dengan kata kunci "${searchQuery}". Coba kata kunci lain.`
                  : 'Katalog video sedang disiapkan oleh tim. Seluruh berkas video tersimpan di Cloudflare R2 privat dan akan muncul di sini segera setelah dirilis.'}
              </p>
              <div className="empty-pills">
                <span className="empty-pill">⚡ Private Cloudflare R2</span>
                <span className="empty-pill">🔒 Shopee Verified Member</span>
                <span className="empty-pill">📦 Zero-Watermark Ready</span>
              </div>
            </div>
          ) : (
            <div className="video-grid mt-6">
              {filteredVideos.map((video) => (
                <div key={video.id} className="video-card">
                  <div className="video-card-header">
                    <div className="video-card-badge-row">
                      <span className="file-size-badge">{formatFileSize(video.file_size)}</span>
                      <span className="content-type-badge">{video.content_type.split('/')[1]?.toUpperCase()}</span>
                      <span style={{ fontSize: '0.75rem', background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: '4px', fontWeight: 500 }}>
                        📂 {video.rack_name || 'General'}
                      </span>
                    </div>
                    <h3 className="video-title">{video.title}</h3>
                  </div>

                  <div className="video-card-body">
                    <div className="product-info-box">
                      <span className="product-icon">🛍️</span>
                      <div>
                        <span className="product-label">Produk Shopee:</span>
                        <strong className="product-name">{video.product_name}</strong>
                      </div>
                    </div>

                    {video.description && (
                      <p className="video-desc">{video.description}</p>
                    )}
                  </div>

                  <div className="video-card-footer">
                    <a
                      href={video.product_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-outline btn-sm product-link-btn"
                    >
                      Buka Produk Shopee &#8599;
                    </a>

                    <a
                      href={videoApi.getDownloadUrl(video.id)}
                      download
                      className="btn btn-primary btn-sm download-btn"
                    >
                      ⬇ Unduh Video
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Modal Ajukan Perubahan Akun Shopee */}
      <Modal
        isOpen={showChangeModal}
        onClose={() => {
          if (!submittingChange) {
            setShowChangeModal(false);
            setChangeError(null);
            setChangeSuccess(null);
          }
        }}
        title="Ajukan Perubahan Akun Shopee Affiliate"
      >
        <div>
          <p className="text-sm text-muted mb-4">
            Untuk menjaga integritas hak akses, perubahan tautan profil Shopee wajib diverifikasi dan disetujui oleh Administrator. Tautan lama Anda akan tetap aktif hingga permohonan disetujui.
          </p>

          <div className="mb-4 p-3 bg-secondary rounded text-xs">
            <strong>Tautan Shopee Saat Ini:</strong>
            <p className="font-mono text-muted truncate mt-1">{user.shopee_link || '-'}</p>
          </div>

          {changeSuccess && (
            <Alert type="success" className="mb-4">
              {changeSuccess}
            </Alert>
          )}

          {changeError && (
            <Alert type="danger" onClose={() => setChangeError(null)} className="mb-4">
              {changeError}
            </Alert>
          )}

          <form onSubmit={handleChangeRequestSubmit}>
            <Input
              label="Tautan Akun Shopee Baru"
              id="requested-shopee-link"
              type="url"
              placeholder="Contoh: https://shopee.co.id/akunbaru atau https://shope.ee/..."
              value={requestedLink}
              onChange={(e) => setRequestedLink(e.target.value)}
              required
              helperText="Format yang diterima: shopee.co.id atau shope.ee."
              disabled={submittingChange}
            />

            <div className="flex justify-end gap-2 mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowChangeModal(false)}
                disabled={submittingChange}
              >
                Batal
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={submittingChange}
                loadingText="Mengirim..."
              >
                Kirim Permohonan
              </Button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Modal Riwayat Pengajuan Perubahan Akun Shopee */}
      <Modal
        isOpen={showHistoryModal}
        onClose={() => setShowHistoryModal(false)}
        title="Riwayat Permohonan Akun Shopee"
        maxWidth="640px"
      >
        <div>
          {shopeeRequests.length === 0 ? (
            <p className="text-muted text-sm text-center py-4">Belum ada riwayat permohonan.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="admin-table text-sm">
                <thead>
                  <tr>
                    <th>Tautan Diminta</th>
                    <th>Tanggal</th>
                    <th>Status</th>
                    <th>Catatan</th>
                  </tr>
                </thead>
                <tbody>
                  {shopeeRequests.map((req) => (
                    <tr key={req.id}>
                      <td className="max-w-xs truncate" title={req.requested_shopee_link}>
                        {req.requested_shopee_link}
                      </td>
                      <td className="whitespace-nowrap">{formatDate(req.created_at)}</td>
                      <td>
                        <Badge
                          variant={
                            req.status === 'approved'
                              ? 'success'
                              : req.status === 'rejected'
                              ? 'danger'
                              : 'warning'
                          }
                        >
                          {req.status === 'approved'
                            ? 'Disetujui'
                            : req.status === 'rejected'
                            ? 'Ditolak'
                            : 'Menunggu Review'}
                        </Badge>
                      </td>
                      <td className="text-xs text-muted">
                        {req.rejection_reason || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end mt-4">
            <Button variant="outline" onClick={() => setShowHistoryModal(false)}>
              Tutup
            </Button>
          </div>
        </div>
      </Modal>

      {/* Aksi Bantuan */}
      <footer className="dashboard-footer-actions">
        <p className="text-muted">
          Perlu mengganti peramban kerja? Silakan hubungi admin untuk menerbitkan kode reset perangkat.
        </p>
        <Button
          variant="outline"
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
          className="btn-sm"
        >
          Keluar dari Sesi
        </Button>
      </footer>
    </div>
  );
};
