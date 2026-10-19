/**
 * frontend/src/pages/UserDashboardPage.tsx
 * Halaman utama anggota (User Dashboard).
 * Menampilkan profil pengguna, telemetri perangkat terikat, dan katalog video privat dari Cloudflare R2.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter } from '../router/Router';
import { videoApi, shopeeApi, commissionApi, ApiClientError } from '../api/client';
import { VideoItem, ShopeeAccountRequest, RackItem, CommissionProof } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Alert } from '../components/Alert';
import { Modal } from '../components/Modal';
import { Input } from '../components/Input';
import { VideoPlayerModal } from '../components/VideoPlayerModal';

export const UserDashboardPage: React.FC = () => {
  const { user, device, logout, refreshUser } = useAuth();
  const { navigate } = useRouter();

  const catalogRequestIdRef = useRef<number>(0);

  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [previewVideo, setPreviewVideo] = useState<VideoItem | null>(null);
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

  // Commission proof state (Fitur 9)
  const [commissionProof, setCommissionProof] = useState<CommissionProof | null>(null);
  const [loadingProof, setLoadingProof] = useState<boolean>(false);
  const [showUploadProofModal, setShowUploadProofModal] = useState(false);
  const [uploadingProof, setUploadingProof] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [proofSuccess, setProofSuccess] = useState<string | null>(null);
  const [selectedProofFile, setSelectedProofFile] = useState<File | null>(null);
  const [showProofPreviewModal, setShowProofPreviewModal] = useState(false);

  // Pagination state
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState<number>(1);

  const fetchCommissionProof = useCallback(async () => {
    if (user?.role === 'member') {
      try {
        setLoadingProof(true);
        const res = await commissionApi.getMemberProof();
        setCommissionProof(res.proof);
      } catch {
        // Abaikan error background fetch
      } finally {
        setLoadingProof(false);
      }
    }
  }, [user?.role]);

  const handleUploadProofSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProofFile) {
      setProofError('Pilih file gambar bukti komisi terlebih dahulu.');
      return;
    }
    setUploadingProof(true);
    setProofError(null);
    setProofSuccess(null);
    try {
      const res = await commissionApi.uploadMemberProof(selectedProofFile);
      setCommissionProof(res.proof);
      setProofSuccess(res.message || 'Bukti komisi berhasil disimpan.');
      setSelectedProofFile(null);
      setShowUploadProofModal(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setProofError(err.message);
      } else {
        setProofError('Gagal mengunggah bukti komisi.');
      }
    } finally {
      setUploadingProof(false);
    }
  };

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

  const fetchCatalog = useCallback(async (options?: {
    rackId?: string;
    cursor?: string | null;
    page?: number;
    q?: string;
  }) => {
    // Jika member belum memiliki shopee_link, tunda memuat katalog
    if (user?.role === 'member' && !user.shopee_link) {
      setLoadingVideos(false);
      return;
    }

    const currentRequestId = ++catalogRequestIdRef.current;
    setLoadingVideos(true);
    setVideoError(null);
    try {
      const activeRack = options?.rackId !== undefined ? options.rackId : selectedRackId;
      const activeCursor = options?.cursor !== undefined ? (options.cursor || undefined) : (currentCursor || undefined);
      const activeQ = options?.q !== undefined ? options.q : searchQuery;

      const res = await videoApi.listVideos({
        rackId: activeRack !== 'all' ? activeRack : undefined,
        cursor: activeCursor,
        limit: 24,
        q: activeQ.trim() || undefined
      });

      // Abaikan respons jika ada request baru yang telah diluncurkan
      if (currentRequestId !== catalogRequestIdRef.current) return;

      setVideos(res.videos || []);
      setHasMore(res.pagination?.has_more ?? false);
      setNextCursor(res.pagination?.next_cursor ?? null);
      if (options?.page !== undefined) {
        setPageIndex(options.page);
      }
    } catch (err) {
      if (currentRequestId !== catalogRequestIdRef.current) return;
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
      if (currentRequestId === catalogRequestIdRef.current) {
        setLoadingVideos(false);
      }
    }
  }, [user?.role, user?.shopee_link, selectedRackId, currentCursor, searchQuery, navigate]);

  const handleNextPage = () => {
    if (!nextCursor || loadingVideos) return;
    setCursorHistory((prev) => [...prev, currentCursor || '']);
    setCurrentCursor(nextCursor);
    fetchCatalog({ cursor: nextCursor, page: pageIndex + 1 });
  };

  const handlePrevPage = () => {
    if (pageIndex <= 1 || loadingVideos) return;
    const newHistory = [...cursorHistory];
    const prevCursor = newHistory.pop() || null;
    setCursorHistory(newHistory);
    setCurrentCursor(prevCursor);
    fetchCatalog({ cursor: prevCursor, page: pageIndex - 1 });
  };

  const handleRackChange = (rackId: string) => {
    setSelectedRackId(rackId);
    setCursorHistory([]);
    setCurrentCursor(null);
    setPageIndex(1);
    fetchCatalog({ rackId, cursor: null, page: 1 });
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCursorHistory([]);
    setCurrentCursor(null);
    setPageIndex(1);
    fetchCatalog({ cursor: null, page: 1, q: searchQuery });
  };

  useEffect(() => {
    if (user) {
      fetchRacks();
      fetchCatalog({ cursor: null, page: 1 });
      if (user.role === 'member') {
        fetchShopeeRequests();
        fetchCommissionProof();
      }
    }
  }, [user, fetchRacks, fetchCatalog, fetchShopeeRequests, fetchCommissionProof]);

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
              <p className="card-caption">Status proteksi login satu akun satu perangkat</p>
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
                <h3 className="card-title">Penyimpanan & Keamanan Konten</h3>
                <p className="card-caption">Aset video dilindungi dengan akses privat resmi</p>
              </div>
            </div>

            <ul className="security-guidelines">
              <li>
                <strong>Akses Resmi:</strong> Video hanya dapat diakses dan diunduh oleh akun anggota resmi yang aktif.
              </li>
              <li>
                <strong>Verifikasi Perangkat:</strong> Setiap pengunduhan diverifikasi terhadap akun aktif di perangkat ini.
              </li>
              <li>
                <strong>Materi Promosi:</strong> Unduh materi video untuk mendukung promosi tautan afiliasi Shopee Anda.
              </li>
            </ul>
          </div>
        )}

        {/* Card Bukti Komisi Mingguan (Fitur 9) */}
        {user.role === 'member' && (
          <div className="dashboard-card">
            <div className="card-header-cluster">
              <span className="card-icon">💰</span>
              <div>
                <h3 className="card-title">Bukti Komisi Mingguan</h3>
                <p className="card-caption">Screenshot komisi Shopee Affiliate resmi Anda</p>
              </div>
            </div>

            {loadingProof ? (
              <p className="text-xs text-muted py-2">Memuat status bukti komisi...</p>
            ) : commissionProof ? (
              <>
                <div className="telemetry-list">
                  <div className="telemetry-item">
                    <span className="telemetry-label">Status Bukti:</span>
                    <span className="telemetry-val text-success font-medium">✓ Sudah Mengunggah Bukti Komisi</span>
                  </div>
                  <div className="telemetry-item">
                    <span className="telemetry-label">Nama Berkas:</span>
                    <span className="telemetry-val font-mono truncate max-w-xs">{commissionProof.original_filename}</span>
                  </div>
                  <div className="telemetry-item">
                    <span className="telemetry-label">Ukuran Berkas:</span>
                    <span className="telemetry-val">{(commissionProof.file_size / 1024).toFixed(1)} KB</span>
                  </div>
                  <div className="telemetry-item">
                    <span className="telemetry-label">Waktu Unggah:</span>
                    <span className="telemetry-val">{formatDate(commissionProof.updated_at)}</span>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="btn-sm"
                    onClick={() => setShowProofPreviewModal(true)}
                  >
                    🔍 Lihat Bukti
                  </Button>
                  <Button
                    variant="outline"
                    className="btn-sm text-shopee border-shopee hover:bg-orange-50"
                    onClick={() => {
                      setProofError(null);
                      setProofSuccess(null);
                      setSelectedProofFile(null);
                      setShowUploadProofModal(true);
                    }}
                  >
                    🔄 Ganti Bukti Komisi
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 mb-4">
                  <p className="font-semibold">Belum Mengunggah Bukti Komisi</p>
                  <p className="mt-1">
                    Silakan unggah screenshot bukti pembagian komisi mingguan Anda untuk memverifikasi keaktifan akun.
                  </p>
                </div>
                <Button
                  variant="primary"
                  className="btn-sm"
                  onClick={() => {
                    setProofError(null);
                    setProofSuccess(null);
                    setSelectedProofFile(null);
                    setShowUploadProofModal(true);
                  }}
                >
                  📤 Unggah Bukti Komisi
                </Button>
              </>
            )}

            {proofSuccess && (
              <div className="mt-3">
                <Alert type="success" onClose={() => setProofSuccess(null)}>
                  {proofSuccess}
                </Alert>
              </div>
            )}
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

            <form onSubmit={handleSearchSubmit} className="catalog-controls">
              <input
                type="text"
                className="form-input search-input"
                placeholder="Cari judul atau nama produk..."
                value={searchQuery}
                maxLength={100}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <Button
                type="submit"
                variant="outline"
                className="btn-sm"
                loading={loadingVideos}
                loadingText="Mencari..."
              >
                Cari
              </Button>
              <Button
                type="button"
                variant="outline"
                className="btn-sm"
                onClick={() => {
                  setSearchQuery('');
                  setCursorHistory([]);
                  setCurrentCursor(null);
                  setPageIndex(1);
                  fetchCatalog({ rackId: selectedRackId, cursor: null, page: 1, q: '' });
                }}
                disabled={loadingVideos}
              >
                Segarkan
              </Button>
            </form>
          </div>

          {/* Bilah Filter Kategori / Rak */}
          <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', margin: '16px 0', paddingBottom: '6px' }}>
            <button
              type="button"
              className={`btn btn-xs ${selectedRackId === 'all' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => handleRackChange('all')}
            >
              Semua Rak
            </button>
            {racks.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`btn btn-xs ${selectedRackId === r.id ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => handleRackChange(r.id)}
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
              <p className="mt-2 text-muted text-sm">Memuat katalog video...</p>
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
                  : 'Katalog video sedang disiapkan oleh tim. Seluruh berkas video tersimpan aman dan akan muncul di sini segera setelah dirilis.'}
              </p>
              <div className="empty-pills">
                <span className="empty-pill">📁 Katalog Video Resmi</span>
                <span className="empty-pill">🔒 Khusus Anggota Aktif</span>
                <span className="empty-pill">🎬 Format MP4 & WebM</span>
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

                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => setPreviewVideo(video)}
                        title="Putar pratinjau video"
                      >
                        ▶ Putar
                      </button>

                      <a
                        href={videoApi.getDownloadUrl(video.id)}
                        download
                        className="btn btn-primary btn-sm download-btn"
                      >
                        ⬇ Unduh
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Kontrol Navigasi Halaman (Pagination) */}
          {videos.length > 0 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: '24px',
                paddingTop: '16px',
                borderTop: '1px solid #e5e7eb',
                flexWrap: 'wrap',
                gap: '12px'
              }}
            >
              <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                Halaman <strong>{pageIndex}</strong> &bull; Menampilkan {videos.length} video {hasMore ? '(Ada halaman berikutnya)' : '(Akhir katalog)'}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button
                  variant="outline"
                  className="btn-sm"
                  disabled={pageIndex <= 1 || loadingVideos}
                  onClick={handlePrevPage}
                >
                  &larr; Halaman Sebelumnya
                </Button>
                <Button
                  variant="primary"
                  className="btn-sm"
                  disabled={!hasMore || loadingVideos}
                  onClick={handleNextPage}
                >
                  Halaman Berikutnya &rarr;
                </Button>
              </div>
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
      {/* Modal Upload / Ganti Bukti Komisi (Fitur 9) */}
      <Modal
        isOpen={showUploadProofModal}
        onClose={() => {
          if (!uploadingProof) {
            setShowUploadProofModal(false);
            setSelectedProofFile(null);
            setProofError(null);
          }
        }}
        title={commissionProof ? 'Ganti Bukti Komisi Mingguan' : 'Unggah Bukti Komisi Mingguan'}
      >
        <form onSubmit={handleUploadProofSubmit} className="space-y-4">
          <p className="text-xs text-muted">
            {commissionProof
              ? 'Mengunggah file baru akan langsung menggantikan bukti aktif sebelumnya. Berkas lama akan otomatis dibersihkan dari penyimpanan.'
              : 'Unggah screenshot halaman komisi Shopee Affiliate Anda. File yang diizinkan berupa gambar JPG, PNG, atau WebP maksimal 5 MB.'}
          </p>

          {proofError && (
            <Alert type="danger" onClose={() => setProofError(null)}>
              {proofError}
            </Alert>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Pilih Berkas Gambar (Maks. 5 MB)
            </label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const files = e.target.files;
                if (files && files[0]) {
                  setSelectedProofFile(files[0]);
                }
              }}
              disabled={uploadingProof}
              className="block w-full text-xs text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-primary file:text-white hover:file:bg-primary-dark cursor-pointer"
              required
            />
          </div>

          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowUploadProofModal(false);
                setSelectedProofFile(null);
                setProofError(null);
              }}
              disabled={uploadingProof}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!selectedProofFile || uploadingProof}
              loading={uploadingProof}
              loadingText={commissionProof ? 'Mengganti Bukti...' : 'Mengunggah...'}
            >
              {commissionProof ? 'Simpan Penggantian' : 'Unggah Bukti'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal Pratinjau Bukti Komisi (Fitur 9) */}
      <Modal
        isOpen={showProofPreviewModal && !!commissionProof}
        onClose={() => setShowProofPreviewModal(false)}
        title="Pratinjau Bukti Komisi Mingguan"
      >
        {commissionProof && (
          <div className="space-y-4">
            <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[70vh] flex items-center justify-center bg-slate-900">
              <img
                src={commissionApi.getProofFileUrl(commissionProof.id)}
                alt="Bukti Komisi"
                className="max-h-[65vh] max-w-full object-contain"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).alt = 'Gagal memuat gambar bukti komisi';
                }}
              />
            </div>
            <div className="text-xs text-muted flex justify-between items-center">
              <span>{commissionProof.original_filename} ({(commissionProof.file_size / 1024).toFixed(1)} KB)</span>
              <span>Diperbarui: {formatDate(commissionProof.updated_at)}</span>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setShowProofPreviewModal(false)}>
                Tutup
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal Pratinjau Video */}
      <VideoPlayerModal
        isOpen={!!previewVideo}
        onClose={() => setPreviewVideo(null)}
        video={previewVideo}
      />
    </div>
  );
};
