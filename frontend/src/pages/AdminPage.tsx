/**
 * frontend/src/pages/AdminPage.tsx
 * Panel Manajemen Administrator Gudang Video Shopee Affiliate.
 * Meliputi pengelolaan video R2, kode aktivasi, pengguna & reset perangkat, serta audit log.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter } from '../router/Router';
import { adminApi, superAdminApi, videoApi, shopeeApi, ApiClientError } from '../api/client';
import {
  ActivationCodeItem,
  AdminUserItem,
  AuditLogItem,
  AdminVideoItem,
  ShopeeAccountRequest
} from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Alert } from '../components/Alert';
import { Modal } from '../components/Modal';

type AdminTab = 'overview' | 'videos' | 'codes' | 'users' | 'shopee' | 'admins' | 'logs';

export const AdminPage: React.FC = () => {
  const { user } = useAuth();
  const { navigate } = useRouter();

  const [activeTab, setActiveTab] = useState<AdminTab>('overview');

  // Data state
  const [videos, setVideos] = useState<AdminVideoItem[]>([]);
  const [codes, setCodes] = useState<ActivationCodeItem[]>([]);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [admins, setAdmins] = useState<AdminUserItem[]>([]);
  const [logs, setLogs] = useState<AuditLogItem[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);

  // Modal Create Admin (Super Admin only)
  const [showCreateAdminModal, setShowCreateAdminModal] = useState(false);
  const [newAdminUsername, setNewAdminUsername] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [creatingAdmin, setCreatingAdmin] = useState(false);
  const [togglingAdminId, setTogglingAdminId] = useState<string | null>(null);

  // Modal Create Member Langsung (Super Admin only)
  const [showCreateMemberModal, setShowCreateMemberModal] = useState(false);
  const [newMemberUsername, setNewMemberUsername] = useState('');
  const [newMemberPassword, setNewMemberPassword] = useState('');
  const [creatingMember, setCreatingMember] = useState(false);

  // Modal Upload Video
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadProductName, setUploadProductName] = useState('');
  const [uploadProductUrl, setUploadProductUrl] = useState('');
  const [uploadDescription, setUploadDescription] = useState('');
  const [uploadStatus, setUploadStatus] = useState<'active' | 'inactive'>('active');
  const [uploading, setUploading] = useState(false);

  // Modal Edit Video
  const [editingVideo, setEditingVideo] = useState<AdminVideoItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editProductName, setEditProductName] = useState('');
  const [editProductUrl, setEditProductUrl] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'inactive'>('active');
  const [savingEdit, setSavingEdit] = useState(false);

  // Modal Delete Video
  const [deletingVideo, setDeletingVideo] = useState<AdminVideoItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Modal Create Activation Code
  const [showCreateCodeModal, setShowCreateCodeModal] = useState(false);
  const [newCodeNote, setNewCodeNote] = useState('');
  const [newCodeDays, setNewCodeDays] = useState(30);
  const [creatingCode, setCreatingCode] = useState(false);
  const [createdCodeResult, setCreatedCodeResult] = useState<{ code: string; note: string | null } | null>(null);

  // Modal Issue Reset Code
  const [selectedUserForReset, setSelectedUserForReset] = useState<AdminUserItem | null>(null);
  const [resetReason, setResetReason] = useState('');
  const [issuingReset, setIssuingReset] = useState(false);
  const [issuedResetResult, setIssuedResetResult] = useState<{
    username: string;
    code: string;
    expiresInMinutes: number;
  } | null>(null);

  // Shopee Requests state
  const [shopeeRequests, setShopeeRequests] = useState<ShopeeAccountRequest[]>([]);
  const [shopeeFilter, setShopeeFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [approvingRequest, setApprovingRequest] = useState<ShopeeAccountRequest | null>(null);
  const [submittingApproval, setSubmittingApproval] = useState(false);
  const [rejectingRequest, setRejectingRequest] = useState<ShopeeAccountRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [submittingRejection, setSubmittingRejection] = useState(false);

  // Copy indicator state
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchAllData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [videosRes, codesRes, usersRes, logsRes, shopeeRes] = await Promise.all([
        adminApi.listVideos(),
        adminApi.listActivationCodes(),
        adminApi.listUsers(),
        adminApi.listAuditLogs(),
        shopeeApi.listAdminRequests('all')
      ]);
      setVideos(videosRes.videos || []);
      setCodes(codesRes.codes || []);
      setUsers(usersRes.users || []);
      setLogs(logsRes.logs || []);
      setShopeeRequests(shopeeRes.requests || []);

      if (user?.role === 'super_admin') {
        try {
          const adminsRes = await superAdminApi.listAdmins();
          setAdmins(adminsRes.admins || []);
        } catch {}
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal memuat data administratif dari server.');
      }
    } finally {
      setLoading(false);
    }
  }, [user?.role]);

  useEffect(() => {
    if (user && (user.role === 'admin' || user.role === 'super_admin')) {
      fetchAllData();
    }
  }, [user, fetchAllData]);

  // Perlindungan hak akses Administrator & Super Administrator
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
    return (
      <div className="container-page">
        <div className="card text-center p-8">
          <div className="text-4xl mb-2">🚫</div>
          <h3>Akses Ditolak (403 Forbidden)</h3>
          <p className="text-muted mt-2">
            Halaman ini hanya dapat diakses oleh Administrator resmi Gudang Video Shopee (Super Admin / Admin).
          </p>
          <Button variant="primary" onClick={() => navigate('/')} className="mt-4">
            Kembali ke Beranda
          </Button>
        </div>
      </div>
    );
  }

  const handleCopy = (text: string, key: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2500);
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile) {
      setErrorMsg('Pilih berkas video terlebih dahulu.');
      return;
    }

    setUploading(true);
    setErrorMsg(null);
    try {
      await adminApi.uploadVideo({
        file: uploadFile,
        title: uploadTitle.trim(),
        product_name: uploadProductName.trim(),
        product_url: uploadProductUrl.trim(),
        description: uploadDescription.trim() || undefined,
        status: uploadStatus
      });
      setActionSuccessMsg('Video berhasil diunggah ke Cloudflare R2 privat!');
      setShowUploadModal(false);
      setUploadFile(null);
      setUploadTitle('');
      setUploadProductName('');
      setUploadProductUrl('');
      setUploadDescription('');
      setUploadStatus('active');
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal mengunggah video ke penyimpanan R2.');
      }
    } finally {
      setUploading(false);
    }
  };

  const openEditModal = (video: AdminVideoItem) => {
    setEditingVideo(video);
    setEditTitle(video.title);
    setEditProductName(video.product_name);
    setEditProductUrl(video.product_url);
    setEditDescription(video.description || '');
    setEditStatus(video.status);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVideo) return;

    setSavingEdit(true);
    setErrorMsg(null);
    try {
      await adminApi.updateVideo(editingVideo.id, {
        title: editTitle.trim(),
        product_name: editProductName.trim(),
        product_url: editProductUrl.trim(),
        description: editDescription.trim() || undefined,
        status: editStatus
      });
      setActionSuccessMsg('Metadata video berhasil diperbarui!');
      setEditingVideo(null);
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal memperbarui metadata video.');
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteSubmit = async () => {
    if (!deletingVideo) return;

    setDeleting(true);
    setErrorMsg(null);
    try {
      await adminApi.deleteVideo(deletingVideo.id);
      setActionSuccessMsg(`Video "${deletingVideo.title}" dan berkas R2 berhasil dihapus.`);
      setDeletingVideo(null);
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal menghapus video dari R2 dan database.');
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleCreateCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingCode(true);
    setErrorMsg(null);
    try {
      const res = await adminApi.createActivationCode({
        note: newCodeNote.trim() || undefined,
        expires_in_days: Number(newCodeDays) || 30
      });
      setCreatedCodeResult({
        code: res.data.code,
        note: res.data.note
      });
      setShowCreateCodeModal(false);
      setNewCodeNote('');
      setNewCodeDays(30);
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal membuat kode aktivasi.');
      }
    } finally {
      setCreatingCode(false);
    }
  };

  const handleIssueResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserForReset) return;

    setIssuingReset(true);
    setErrorMsg(null);
    try {
      const res = await adminApi.issueResetCode(selectedUserForReset.id, {
        reason: resetReason.trim() || undefined
      });
      setIssuedResetResult({
        username: res.data.username,
        code: res.data.reset_code,
        expiresInMinutes: res.data.expires_in_minutes
      });
      setSelectedUserForReset(null);
      setResetReason('');
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal menerbitkan kode reset perangkat.');
      }
    } finally {
      setIssuingReset(false);
    }
  };

  const handleCreateAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAdminUsername.trim() || !newAdminPassword) return;

    setCreatingAdmin(true);
    setErrorMsg(null);
    try {
      await superAdminApi.createAdmin({
        username: newAdminUsername.trim(),
        password: newAdminPassword
      });
      setActionSuccessMsg(`Admin baru "${newAdminUsername.trim()}" berhasil dibuat!`);
      setShowCreateAdminModal(false);
      setNewAdminUsername('');
      setNewAdminPassword('');
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal membuat akun administrator.');
      }
    } finally {
      setCreatingAdmin(false);
    }
  };

  const handleToggleAdminStatus = async (targetAdmin: AdminUserItem) => {
    const nextStatus = targetAdmin.status === 'active' ? 'suspended' : 'active';
    const confirmPrompt =
      nextStatus === 'suspended'
        ? `Apakah Anda yakin ingin menonaktifkan admin "${targetAdmin.username}"? Seluruh sesi login admin ini akan langsung dicabut.`
        : `Aktifkan kembali admin "${targetAdmin.username}"?`;

    if (!window.confirm(confirmPrompt)) return;

    setTogglingAdminId(targetAdmin.id);
    setErrorMsg(null);
    try {
      await superAdminApi.updateAdminStatus(targetAdmin.id, {
        status: nextStatus,
        reason: 'Diubah melalui panel Super Admin'
      });
      setActionSuccessMsg(
        `Status admin "${targetAdmin.username}" berhasil diubah menjadi ${nextStatus === 'active' ? 'Aktif' : 'Dinonaktifkan'}.`
      );
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal mengubah status administrator.');
      }
    } finally {
      setTogglingAdminId(null);
    }
  };

  const handleCreateMemberSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemberUsername.trim() || !newMemberPassword) return;

    setCreatingMember(true);
    setErrorMsg(null);
    try {
      await superAdminApi.createMember({
        username: newMemberUsername.trim(),
        password: newMemberPassword
      });
      setActionSuccessMsg(`Akun Member "${newMemberUsername.trim()}" berhasil dibuat secara langsung!`);
      setShowCreateMemberModal(false);
      setNewMemberUsername('');
      setNewMemberPassword('');
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal membuat akun member.');
      }
    } finally {
      setCreatingMember(false);
    }
  };

  const handleApproveSubmit = async () => {
    if (!approvingRequest) return;
    setSubmittingApproval(true);
    setErrorMsg(null);
    try {
      await shopeeApi.reviewRequest(approvingRequest.id, { action: 'approve' });
      setActionSuccessMsg(`Permohonan akun Shopee untuk "${approvingRequest.username}" berhasil disetujui! Tautan member telah diperbarui.`);
      setApprovingRequest(null);
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal menyetujui permohonan akun Shopee.');
      }
    } finally {
      setSubmittingApproval(false);
    }
  };

  const handleRejectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingRequest) return;
    const cleanReason = rejectionReason.trim();
    if (!cleanReason) {
      setErrorMsg('Alasan penolakan wajib diisi agar member memahami perbaikan yang diperlukan.');
      return;
    }

    setSubmittingRejection(true);
    setErrorMsg(null);
    try {
      await shopeeApi.reviewRequest(rejectingRequest.id, {
        action: 'reject',
        rejection_reason: cleanReason
      });
      setActionSuccessMsg(`Permohonan akun Shopee untuk "${rejectingRequest.username}" telah ditolak.`);
      setRejectingRequest(null);
      setRejectionReason('');
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal menolak permohonan akun Shopee.');
      }
    } finally {
      setSubmittingRejection(false);
    }
  };

  const formatDate = (isoString?: string | null) => {
    if (!isoString) return '-';
    try {
      const date = new Date(isoString.replace(' ', 'T') + 'Z');
      return date.toLocaleString('id-ID', {
        dateStyle: 'short',
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

  return (
    <div className="container-page">
      {/* Header Admin */}
      <div className="admin-header">
        <div>
          <div className="admin-badge-cluster">
            <span className="text-xl">{user?.role === 'super_admin' ? '👑' : '⚙️'}</span>
            <h1 className="admin-page-title">
              {user?.role === 'super_admin' ? 'Panel Super Administrator' : 'Panel Operasional Admin'}
            </h1>
          </div>
          <p className="admin-page-subtitle">
            {user?.role === 'super_admin'
              ? 'Kelola seluruh sistem: akun Administrator, penerbitan kode lisensi, katalog video R2, dan audit log komprehensif.'
              : 'Kelola katalog video R2 privat, pemeriksaan konten, dan pemantauan operasional member.'}
          </p>
        </div>

        <div className="admin-header-actions">
          <Button
            variant="outline"
            className="btn-sm"
            onClick={fetchAllData}
            loading={loading}
            loadingText="Menyinkronkan..."
          >
            Segarkan Data
          </Button>
          <Button
            variant="primary"
            className="btn-sm"
            onClick={() => setShowUploadModal(true)}
          >
            + Unggah Video R2
          </Button>
        </div>
      </div>

      {actionSuccessMsg && (
        <Alert type="success" onClose={() => setActionSuccessMsg(null)}>
          {actionSuccessMsg}
        </Alert>
      )}

      {errorMsg && (
        <Alert type="danger" onClose={() => setErrorMsg(null)}>
          {errorMsg}
        </Alert>
      )}

      {/* Modal / Banner Hasil Pembuatan Kode Aktivasi */}
      {createdCodeResult && (
        <div className="highlight-banner success-border mb-6">
          <div className="banner-header">
            <h4>🎉 Kode Aktivasi Baru Berhasil Dibuat</h4>
            <button
              className="close-link"
              onClick={() => setCreatedCodeResult(null)}
            >
              Tutup &times;
            </button>
          </div>
          <p className="text-sm text-muted mt-1">
            Salin kode di bawah dan kirimkan kepada pembeli akses affiliate.
            <strong> PENTING: Kode ini hanya ditampilkan sekali demi keamanan.</strong>
          </p>
          <div className="code-display-box mt-3">
            <code className="raw-code">{createdCodeResult.code}</code>
            <Button
              variant="primary"
              className="btn-sm"
              onClick={() => handleCopy(createdCodeResult.code, 'created-code')}
            >
              {copiedKey === 'created-code' ? '✓ Tersalin!' : 'Salin Kode'}
            </Button>
          </div>
        </div>
      )}

      {/* Modal / Banner Hasil Penerbitan Kode Reset */}
      {issuedResetResult && (
        <div className="highlight-banner warning-border mb-6">
          <div className="banner-header">
            <h4>🔑 Kode Reset Perangkat Diterbitkan untuk: {issuedResetResult.username}</h4>
            <button
              className="close-link"
              onClick={() => setIssuedResetResult(null)}
            >
              Tutup &times;
            </button>
          </div>
          <p className="text-sm text-muted mt-1">
            Berikan kode ini kepada pengguna. Berlaku selama <strong>{issuedResetResult.expiresInMinutes} menit</strong> dan bersifat sekali pakai.
          </p>
          <div className="code-display-box mt-3">
            <code className="raw-code">{issuedResetResult.code}</code>
            <Button
              variant="primary"
              className="btn-sm"
              onClick={() => handleCopy(issuedResetResult.code, 'reset-code')}
            >
              {copiedKey === 'reset-code' ? '✓ Tersalin!' : 'Salin Kode Reset'}
            </Button>
          </div>
        </div>
      )}

      {/* Tab Navigasi Admin */}
      <div className="admin-tabs">
        <button
          className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Ikhtisar
        </button>
        <button
          className={`tab-btn ${activeTab === 'videos' ? 'active' : ''}`}
          onClick={() => setActiveTab('videos')}
        >
          Katalog Video ({videos.length})
        </button>
        <button
          className={`tab-btn ${activeTab === 'codes' ? 'active' : ''}`}
          onClick={() => setActiveTab('codes')}
        >
          Kode Aktivasi ({codes.length})
        </button>
        <button
          className={`tab-btn ${activeTab === 'users' ? 'active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          Pengguna ({users.length})
        </button>
        <button
          className={`tab-btn ${activeTab === 'shopee' ? 'active' : ''}`}
          onClick={() => setActiveTab('shopee')}
        >
          Akun Shopee {shopeeRequests.filter((r) => r.status === 'pending').length > 0 && (
            <span className="badge badge-warning text-xs ml-1">
              {shopeeRequests.filter((r) => r.status === 'pending').length}
            </span>
          )}
        </button>
        {user?.role === 'super_admin' && (
          <button
            className={`tab-btn ${activeTab === 'admins' ? 'active' : ''}`}
            onClick={() => setActiveTab('admins')}
          >
            Manajemen Admin ({admins.length})
          </button>
        )}
        <button
          className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          Log Audit ({logs.length})
        </button>
      </div>

      {/* TAB 1: IKHTISAR */}
      {activeTab === 'overview' && (
        <div className="tab-pane">
          <div className="stat-cards-grid">
            <div className="stat-card">
              <span className="stat-icon">🎬</span>
              <div className="stat-value">{videos.length}</div>
              <div className="stat-label">Total Video di R2</div>
              <div className="stat-desc">
                {videos.filter((v) => v.status === 'active').length} aktif / {videos.filter((v) => v.status === 'inactive').length} nonaktif
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-icon">🎟️</span>
              <div className="stat-value">{codes.length}</div>
              <div className="stat-label">Total Kode Aktivasi</div>
              <div className="stat-desc">
                {codes.filter((c) => c.status === 'active').length} siap pakai / {codes.filter((c) => c.status === 'used').length} diklaim
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-icon">👥</span>
              <div className="stat-value">{users.length}</div>
              <div className="stat-label">Pengguna Terdaftar</div>
              <div className="stat-desc">
                {users.filter((u) => u.role === 'member').length} member / {users.filter((u) => u.role === 'admin').length} admin / {users.filter((u) => u.role === 'super_admin').length} super admin
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-icon">📜</span>
              <div className="stat-value">{logs.length}</div>
              <div className="stat-label">Catatan Log Audit</div>
              <div className="stat-desc">Aktivitas administratif terlacak</div>
            </div>
          </div>

          <div className="overview-info-card mt-6">
            <h3>Arsitektur Keamanan Cloudflare R2 Privat</h3>
            <ul className="guidelines-list mt-2">
              <li>
                <strong>Penyimpanan Non-Publik:</strong> Seluruh berkas video disimpan dalam bucket R2 privat tanpa URL publik permanen.
              </li>
              <li>
                <strong>Pemeriksaan Otorisasi Berlapis:</strong> Sebelum streaming video dikirim, Worker memvalidasi keberadaan sesi, status keaktifan akun, status aktif video, dan kecocokan perangkat.
              </li>
              <li>
                <strong>Pencegahan Orphan Object:</strong> Jika proses penyimpanan database gagal saat pengunggahan, objek di R2 langsung di-rollback (dihapus).
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* TAB 2: KATALOG VIDEO */}
      {activeTab === 'videos' && (
        <div className="tab-pane">
          <div className="table-header-bar">
            <h3>Daftar Video di R2 Privat ({videos.length})</h3>
            <Button
              variant="primary"
              className="btn-sm"
              onClick={() => setShowUploadModal(true)}
            >
              + Unggah Video Baru
            </Button>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Judul Video</th>
                  <th>Produk Shopee</th>
                  <th>Ukuran</th>
                  <th>Total Unduhan</th>
                  <th>Pengunggah</th>
                  <th>Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {videos.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center text-muted p-6">
                      Belum ada video yang diunggah ke penyimpanan R2.
                    </td>
                  </tr>
                ) : (
                  videos.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Badge variant={item.status === 'active' ? 'success' : 'neutral'}>
                          {item.status === 'active' ? 'Aktif' : 'Nonaktif'}
                        </Badge>
                      </td>
                      <td>
                        <div className="font-semibold">{item.title}</div>
                        {item.description && (
                          <div className="text-xs text-muted truncate-text">{item.description}</div>
                        )}
                      </td>
                      <td>
                        <div className="font-medium">{item.product_name}</div>
                        <a
                          href={item.product_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-shopee"
                        >
                          Tautan Shopee &#8599;
                        </a>
                      </td>
                      <td><code className="text-xs">{formatFileSize(item.file_size)}</code></td>
                      <td><span className="font-semibold">{item.download_count}x</span></td>
                      <td>{item.uploaded_by_username ? <code>{item.uploaded_by_username}</code> : '-'}</td>
                      <td>
                        <div className="action-buttons-row">
                          <a
                            href={videoApi.getDownloadUrl(item.id)}
                            download
                            className="btn btn-outline btn-xs"
                            title="Unduh untuk verifikasi"
                          >
                            Unduh
                          </a>
                          <Button
                            variant="outline"
                            className="btn-xs"
                            onClick={() => openEditModal(item)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="danger"
                            className="btn-xs"
                            onClick={() => setDeletingVideo(item)}
                          >
                            Hapus
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: KODE AKTIVASI */}
      {activeTab === 'codes' && (
        <div className="tab-pane">
          <div className="table-header-bar">
            <div>
              <h3>Daftar Kode Aktivasi ({codes.length})</h3>
              <p className="text-xs text-muted mt-1">
                {user?.role === 'super_admin'
                  ? 'Kode aktivasi sekali pakai dengan entropi 130-bit untuk pendaftaran akun Member.'
                  : 'Daftar kode aktivasi (Penerbitan kode aktivasi baru hanya dapat dilakukan oleh Super Administrator).'}
              </p>
            </div>
            {user?.role === 'super_admin' && (
              <Button
                variant="primary"
                className="btn-sm"
                onClick={() => setShowCreateCodeModal(true)}
              >
                + Buat Kode Baru
              </Button>
            )}
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Catatan Penerima</th>
                  <th>Digunakan Oleh</th>
                  <th>Kadaluarsa</th>
                  <th>Dibuat</th>
                </tr>
              </thead>
              <tbody>
                {codes.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center text-muted p-6">
                      Belum ada kode aktivasi yang dibuat.
                    </td>
                  </tr>
                ) : (
                  codes.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Badge
                          variant={
                            item.status === 'active'
                              ? 'success'
                              : item.status === 'used'
                              ? 'neutral'
                              : 'danger'
                          }
                        >
                          {item.status === 'active'
                            ? 'Aktif'
                            : item.status === 'used'
                            ? 'Terpakai'
                            : 'Kedaluwarsa'}
                        </Badge>
                      </td>
                      <td className="font-medium">{item.note || '-'}</td>
                      <td>{item.used_by_username ? <code>{item.used_by_username}</code> : '-'}</td>
                      <td>{formatDate(item.expires_at)}</td>
                      <td>{formatDate(item.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: MANAJEMEN PENGGUNA */}
      {activeTab === 'users' && (
        <div className="tab-pane">
          <div className="table-header-bar">
            <div>
              <h3>Daftar Seluruh Pengguna ({users.length})</h3>
              <p className="text-xs text-muted mt-1">
                Daftar akun terdaftar mencakup Super Admin, Admin operasional, dan Member affiliate.
              </p>
            </div>
            {user?.role === 'super_admin' && (
              <Button
                variant="outline"
                className="btn-sm"
                onClick={() => setShowCreateMemberModal(true)}
              >
                + Buat Member Langsung
              </Button>
            )}
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Nama Pengguna</th>
                  <th>Peran</th>
                  <th>Status Akun</th>
                  <th>Perangkat Terikat</th>
                  <th>Aktivitas Terakhir</th>
                  <th>Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-muted p-6">
                      Tidak ada pengguna ditemukan.
                    </td>
                  </tr>
                ) : (
                  users.map((item) => (
                    <tr key={item.id}>
                      <td className="font-semibold">{item.username}</td>
                      <td>
                        <Badge
                          variant={
                            item.role === 'super_admin'
                              ? 'danger'
                              : item.role === 'admin'
                              ? 'warning'
                              : 'neutral'
                          }
                        >
                          {item.role === 'super_admin'
                            ? 'Super Admin'
                            : item.role === 'admin'
                            ? 'Admin'
                            : 'Member'}
                        </Badge>
                      </td>
                      <td>
                        <Badge variant={item.status === 'active' ? 'success' : 'danger'}>
                          {item.status === 'active' ? 'Aktif' : 'Dibekukan'}
                        </Badge>
                      </td>
                      <td>
                        {item.device_name ? (
                          <span>💻 {item.device_name}</span>
                        ) : (
                          <span className="text-muted">
                            {item.role === 'super_admin' ? 'Multi-Perangkat' : 'Belum terikat'}
                          </span>
                        )}
                      </td>
                      <td>{formatDate(item.device_last_seen_at || item.created_at)}</td>
                      <td>
                        {item.role === 'super_admin' ? (
                          <span className="text-xs text-muted">Multi-Perangkat (Kebal Reset)</span>
                        ) : item.role === 'admin' && user?.role !== 'super_admin' ? (
                          <span className="text-xs text-muted">Khusus Super Admin</span>
                        ) : (
                          <Button
                            variant="outline"
                            className="btn-xs"
                            onClick={() => {
                              setSelectedUserForReset(item);
                              setResetReason('');
                            }}
                          >
                            Terbitkan Kode Reset
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: MANAJEMEN AKUN SHOPEE */}
      {activeTab === 'shopee' && (
        <div className="tab-pane">
          <div className="table-header-bar flex flex-wrap justify-between items-center gap-4">
            <div>
              <h3>Manajemen & Verifikasi Akun Shopee Affiliate ({shopeeRequests.length})</h3>
              <p className="text-xs text-muted mt-1">
                Tinjau permohonan perubahan akun/profil Shopee milik member. Menyetujui permohonan akan langsung memperbarui tautan akun aktif member.
              </p>
            </div>

            {/* Filter Status */}
            <div className="flex gap-2">
              <Button
                variant={shopeeFilter === 'all' ? 'primary' : 'outline'}
                className="btn-xs"
                onClick={() => setShopeeFilter('all')}
              >
                Semua ({shopeeRequests.length})
              </Button>
              <Button
                variant={shopeeFilter === 'pending' ? 'primary' : 'outline'}
                className="btn-xs"
                onClick={() => setShopeeFilter('pending')}
              >
                Menunggu ({shopeeRequests.filter((r) => r.status === 'pending').length})
              </Button>
              <Button
                variant={shopeeFilter === 'approved' ? 'primary' : 'outline'}
                className="btn-xs"
                onClick={() => setShopeeFilter('approved')}
              >
                Disetujui ({shopeeRequests.filter((r) => r.status === 'approved').length})
              </Button>
              <Button
                variant={shopeeFilter === 'rejected' ? 'primary' : 'outline'}
                className="btn-xs"
                onClick={() => setShopeeFilter('rejected')}
              >
                Ditolak ({shopeeRequests.filter((r) => r.status === 'rejected').length})
              </Button>
            </div>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Pengguna</th>
                  <th>Tautan Saat Ini</th>
                  <th>Tautan Baru Diajukan</th>
                  <th>Tanggal Pengajuan</th>
                  <th>Status</th>
                  <th>Catatan / Alasan</th>
                  <th>Tindakan / Verifikator</th>
                </tr>
              </thead>
              <tbody>
                {shopeeRequests
                  .filter((req) => (shopeeFilter === 'all' ? true : req.status === shopeeFilter))
                  .length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center text-muted p-6">
                      Tidak ada permohonan akun Shopee pada kategori ini.
                    </td>
                  </tr>
                ) : (
                  shopeeRequests
                    .filter((req) => (shopeeFilter === 'all' ? true : req.status === shopeeFilter))
                    .map((req) => (
                      <tr key={req.id}>
                        <td className="font-semibold">{req.username}</td>
                        <td className="max-w-xs truncate">
                          {req.current_shopee_link ? (
                            <a
                              href={req.current_shopee_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-shopee hover:underline text-xs"
                              title={req.current_shopee_link}
                            >
                              {req.current_shopee_link} &#8599;
                            </a>
                          ) : (
                            <span className="text-muted text-xs">Belum ada</span>
                          )}
                        </td>
                        <td className="max-w-xs truncate">
                          <a
                            href={req.requested_shopee_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline font-medium text-xs"
                            title={req.requested_shopee_link}
                          >
                            {req.requested_shopee_link} &#8599;
                          </a>
                        </td>
                        <td className="whitespace-nowrap text-xs">{formatDate(req.created_at)}</td>
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
                              : 'Menunggu'}
                          </Badge>
                        </td>
                        <td className="text-xs text-muted max-w-xs truncate" title={req.rejection_reason || ''}>
                          {req.rejection_reason || '-'}
                        </td>
                        <td>
                          {req.status === 'pending' ? (
                            <div className="action-buttons-row">
                              <Button
                                variant="primary"
                                className="btn-xs"
                                onClick={() => setApprovingRequest(req)}
                              >
                                Setujui
                              </Button>
                              <Button
                                variant="danger"
                                className="btn-xs"
                                onClick={() => {
                                  setRejectingRequest(req);
                                  setRejectionReason('');
                                }}
                              >
                                Tolak
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted">
                              Oleh: <strong>{req.reviewed_by_username || '-'}</strong> ({formatDate(req.reviewed_at)})
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: MANAJEMEN ADMIN (SUPER ADMIN ONLY) */}
      {activeTab === 'admins' && user?.role === 'super_admin' && (
        <div className="tab-pane">
          <div className="table-header-bar">
            <div>
              <h3>Manajemen Akun Administrator ({admins.length})</h3>
              <p className="text-xs text-muted mt-1">
                Kelola akun Administrator operasional untuk mengunggah video, memantau katalog, dan mereset perangkat member.
              </p>
            </div>
            <Button
              variant="primary"
              className="btn-sm"
              onClick={() => setShowCreateAdminModal(true)}
            >
              + Tambah Admin Baru
            </Button>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Nama Pengguna</th>
                  <th>Peran</th>
                  <th>Status Akun</th>
                  <th>Perangkat Terikat</th>
                  <th>Dibuat</th>
                  <th>Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {admins.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-muted p-6">
                      Belum ada akun Administrator tambahan. Klik tombol di atas untuk menambah admin baru.
                    </td>
                  </tr>
                ) : (
                  admins.map((item) => (
                    <tr key={item.id}>
                      <td className="font-semibold">{item.username}</td>
                      <td>
                        <Badge variant="warning">Administrator</Badge>
                      </td>
                      <td>
                        <Badge variant={item.status === 'active' ? 'success' : 'danger'}>
                          {item.status === 'active' ? 'Aktif' : 'Dinonaktifkan'}
                        </Badge>
                      </td>
                      <td>
                        {item.device_name ? (
                          <span>💻 {item.device_name}</span>
                        ) : (
                          <span className="text-muted">Belum login pertama</span>
                        )}
                      </td>
                      <td>{formatDate(item.created_at)}</td>
                      <td>
                        <div className="action-buttons-row">
                          <Button
                            variant={item.status === 'active' ? 'danger' : 'outline'}
                            className="btn-xs"
                            disabled={togglingAdminId === item.id}
                            loading={togglingAdminId === item.id}
                            onClick={() => handleToggleAdminStatus(item)}
                          >
                            {item.status === 'active' ? 'Nonaktifkan' : 'Aktifkan'}
                          </Button>
                          <Button
                            variant="outline"
                            className="btn-xs"
                            onClick={() => {
                              setSelectedUserForReset(item);
                              setResetReason('Reset perangkat admin disetujui Super Admin');
                            }}
                          >
                            Reset Perangkat
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: LOG AUDIT */}
      {activeTab === 'logs' && (
        <div className="tab-pane">
          <div className="table-header-bar">
            <h3>Catatan Log Audit Keamanan ({logs.length})</h3>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Aksi</th>
                  <th>Pelaksana (Admin)</th>
                  <th>Pengguna Target</th>
                  <th>Rincian</th>
                  <th>IP Address</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-muted p-6">
                      Belum ada log aktivitas tercatat.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.id}>
                      <td>{formatDate(log.created_at)}</td>
                      <td>
                        <Badge
                          variant={
                            log.action === 'ISSUE_RESET_CODE'
                              ? 'warning'
                              : log.action === 'UPLOAD_VIDEO'
                              ? 'success'
                              : log.action === 'DELETE_VIDEO'
                              ? 'danger'
                              : 'info'
                          }
                        >
                          {log.action}
                        </Badge>
                      </td>
                      <td>{log.admin_username ? <code>{log.admin_username}</code> : '-'}</td>
                      <td>{log.target_username ? <code>{log.target_username}</code> : '-'}</td>
                      <td className="text-sm">{log.details}</td>
                      <td><code className="text-xs">{log.ip_address || '-'}</code></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: UNGGAH VIDEO BARU */}
      <Modal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        title="Unggah Video Baru ke Cloudflare R2"
        maxWidth="600px"
      >
        <form onSubmit={handleUploadSubmit} className="space-y-4">
          <div className="form-group">
            <label className="form-label">
              Berkas Video (.mp4, .webm, .mov)<span className="required-mark"> *</span>
            </label>
            <input
              type="file"
              accept=".mp4,.webm,.mov,video/mp4,video/webm,video/quicktime"
              className="form-input"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  setUploadFile(e.target.files[0]);
                }
              }}
              required
              disabled={uploading}
            />
            <p className="form-helper-text">
              Maksimum 100 MB per file. Disimpan ke Cloudflare R2 privat tanpa akses publik.
            </p>
          </div>

          <Input
            label="Judul Video"
            id="video-title"
            name="title"
            type="text"
            placeholder="Contoh: Review Headset TWS ANC Wireless"
            value={uploadTitle}
            onChange={(e) => setUploadTitle(e.target.value)}
            required
            disabled={uploading}
          />

          <Input
            label="Nama Produk Shopee"
            id="video-product-name"
            name="product_name"
            type="text"
            placeholder="Contoh: TWS Bluetooth 5.3 Pro ANC"
            value={uploadProductName}
            onChange={(e) => setUploadProductName(e.target.value)}
            required
            disabled={uploading}
          />

          <Input
            label="URL Produk Shopee"
            id="video-product-url"
            name="product_url"
            type="url"
            placeholder="https://shopee.co.id/product/..."
            value={uploadProductUrl}
            onChange={(e) => setUploadProductUrl(e.target.value)}
            required
            disabled={uploading}
            helperText="Tautan produk yang akan dibuka affiliator saat mempromosikan."
          />

          <div className="form-group">
            <label className="form-label">Deskripsi / Panduan Promosi (Opsional)</label>
            <textarea
              className="form-input"
              rows={3}
              placeholder="Rincian fitur produk atau saran kata kunci promosi..."
              value={uploadDescription}
              onChange={(e) => setUploadDescription(e.target.value)}
              disabled={uploading}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Status Tayang</label>
            <select
              className="form-input"
              value={uploadStatus}
              onChange={(e) => setUploadStatus(e.target.value as 'active' | 'inactive')}
              disabled={uploading}
            >
              <option value="active">Aktif (Tersedia untuk Member)</option>
              <option value="inactive">Nonaktif (Draf / Tersembunyi)</option>
            </select>
          </div>

          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowUploadModal(false)}
              disabled={uploading}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={uploading}
              loadingText="Mengunggah ke R2..."
            >
              Unggah Video Sekarang
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: EDIT METADATA VIDEO */}
      <Modal
        isOpen={!!editingVideo}
        onClose={() => setEditingVideo(null)}
        title="Edit Metadata Video"
        maxWidth="560px"
      >
        <form onSubmit={handleEditSubmit} className="space-y-4">
          <Input
            label="Judul Video"
            id="edit-title"
            name="title"
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            required
            disabled={savingEdit}
          />

          <Input
            label="Nama Produk Shopee"
            id="edit-product-name"
            name="product_name"
            type="text"
            value={editProductName}
            onChange={(e) => setEditProductName(e.target.value)}
            required
            disabled={savingEdit}
          />

          <Input
            label="URL Produk Shopee"
            id="edit-product-url"
            name="product_url"
            type="url"
            value={editProductUrl}
            onChange={(e) => setEditProductUrl(e.target.value)}
            required
            disabled={savingEdit}
          />

          <div className="form-group">
            <label className="form-label">Deskripsi (Opsional)</label>
            <textarea
              className="form-input"
              rows={3}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              disabled={savingEdit}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Status Tayang</label>
            <select
              className="form-input"
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value as 'active' | 'inactive')}
              disabled={savingEdit}
            >
              <option value="active">Aktif (Tersedia untuk Member)</option>
              <option value="inactive">Nonaktif (Draf / Tersembunyi)</option>
            </select>
          </div>

          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingVideo(null)}
              disabled={savingEdit}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={savingEdit}
              loadingText="Menyimpan..."
            >
              Simpan Perubahan
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: KONFIRMASI HAPUS VIDEO */}
      <Modal
        isOpen={!!deletingVideo}
        onClose={() => setDeletingVideo(null)}
        title="Konfirmasi Penghapusan Video"
        maxWidth="480px"
      >
        <div className="space-y-3">
          <p>
            Apakah Anda yakin ingin menghapus video <strong>"{deletingVideo?.title}"</strong>?
          </p>
          <div className="alert-box alert-danger">
            <p className="text-xs">
              Tindakan ini permanen. File video akan dihapus dari Cloudflare R2 privat dan catatan database akan dibersihkan.
            </p>
          </div>
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeletingVideo(null)}
              disabled={deleting}
            >
              Batal
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDeleteSubmit}
              loading={deleting}
              loadingText="Menghapus..."
            >
              Ya, Hapus Permanen
            </Button>
          </div>
        </div>
      </Modal>

      {/* MODAL: BUAT KODE AKTIVASI */}
      <Modal
        isOpen={showCreateCodeModal}
        onClose={() => setShowCreateCodeModal(false)}
        title="Buat Kode Aktivasi Sekali Pakai"
      >
        <form onSubmit={handleCreateCodeSubmit} className="space-y-4">
          <Input
            label="Catatan Penerima / Pembeli"
            id="code-note"
            name="note"
            type="text"
            placeholder="Contoh: Akses Affiliate Pak Budi (WhatsApp 0812...)"
            value={newCodeNote}
            onChange={(e) => setNewCodeNote(e.target.value)}
            helperText="Catatan internal admin untuk mengidentifikasi pembeli kode ini."
          />

          <Input
            label="Masa Berlaku Kode (Hari)"
            id="code-days"
            name="days"
            type="number"
            min={1}
            max={365}
            value={newCodeDays}
            onChange={(e) => setNewCodeDays(Number(e.target.value))}
            required
            helperText="Batas waktu kode sebelum kedaluwarsa jika belum diklaim (1 - 365 hari)."
          />

          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCreateCodeModal(false)}
              disabled={creatingCode}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={creatingCode}
              loadingText="Menghasilkan Kode..."
            >
              Hasilkan Kode Baru
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: TERBITKAN KODE RESET */}
      <Modal
        isOpen={!!selectedUserForReset}
        onClose={() => setSelectedUserForReset(null)}
        title={`Terbitkan Kode Reset untuk: ${selectedUserForReset?.username}`}
      >
        <form onSubmit={handleIssueResetSubmit} className="space-y-4">
          <div className="alert-box alert-warning">
            <p className="text-sm">
              Kode reset berumur <strong>30 menit</strong>. Berikan hanya kepada pengguna yang telah terverifikasi identitasnya.
            </p>
          </div>

          <Input
            label="Alasan Reset Perangkat"
            id="reset-reason"
            name="reason"
            type="text"
            placeholder="Contoh: Member ganti laptop kerja baru"
            value={resetReason}
            onChange={(e) => setResetReason(e.target.value)}
            helperText="Alasan akan dicatat ke dalam log audit administratif."
          />

          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelectedUserForReset(null)}
              disabled={issuingReset}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="danger"
              loading={issuingReset}
              loadingText="Menerbitkan Kode..."
            >
              Terbitkan Kode (30 Menit)
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: BUAT ADMIN BARU (SUPER ADMIN ONLY) */}
      <Modal
        isOpen={showCreateAdminModal}
        onClose={() => setShowCreateAdminModal(false)}
        title="Tambah Akun Administrator Baru"
      >
        <form onSubmit={handleCreateAdminSubmit} className="space-y-4">
          <Input
            label="Username Administrator"
            id="new-admin-user"
            name="username"
            type="text"
            placeholder="misal: admin_konten"
            value={newAdminUsername}
            onChange={(e) => setNewAdminUsername(e.target.value)}
            required
            helperText="Alfanumerik atau underscore sepanjang 3-30 karakter."
          />
          <Input
            label="Password Administrator"
            id="new-admin-pass"
            name="password"
            type="password"
            placeholder="Minimal 8 karakter"
            value={newAdminPassword}
            onChange={(e) => setNewAdminPassword(e.target.value)}
            required
            helperText="Minimal 8 karakter dan maksimal 64 karakter."
          />
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCreateAdminModal(false)}
              disabled={creatingAdmin}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={creatingAdmin}
              loadingText="Membuat Administrator..."
            >
              Buat Administrator
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: BUAT MEMBER LANGSUNG (SUPER ADMIN ONLY) */}
      <Modal
        isOpen={showCreateMemberModal}
        onClose={() => setShowCreateMemberModal(false)}
        title="Buat Akun Member Langsung"
      >
        <form onSubmit={handleCreateMemberSubmit} className="space-y-4">
          <Input
            label="Username Member"
            id="new-member-user"
            name="username"
            type="text"
            placeholder="misal: member_affiliate1"
            value={newMemberUsername}
            onChange={(e) => setNewMemberUsername(e.target.value)}
            required
            helperText="Alfanumerik atau underscore sepanjang 3-30 karakter."
          />
          <Input
            label="Password Member"
            id="new-member-pass"
            name="password"
            type="password"
            placeholder="Minimal 8 karakter"
            value={newMemberPassword}
            onChange={(e) => setNewMemberPassword(e.target.value)}
            required
            helperText="Minimal 8 karakter dan maksimal 64 karakter."
          />
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCreateMemberModal(false)}
              disabled={creatingMember}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={creatingMember}
              loadingText="Membuat Member..."
            >
              Buat Member
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: KONFIRMASI SETUJUI PERUBAHAN AKUN SHOPEE */}
      <Modal
        isOpen={!!approvingRequest}
        onClose={() => {
          if (!submittingApproval) setApprovingRequest(null);
        }}
        title="Setujui Perubahan Akun Shopee Affiliate"
      >
        {approvingRequest && (
          <div>
            <p className="text-sm text-muted mb-4">
              Apakah Anda yakin ingin menyetujui permohonan perubahan akun Shopee untuk pengguna <strong>{approvingRequest.username}</strong>?
            </p>

            <div className="p-3 bg-secondary rounded text-xs space-y-2 mb-4">
              <div>
                <span className="text-muted">Tautan Saat Ini:</span>
                <p className="font-mono text-muted truncate">{approvingRequest.current_shopee_link || '-'}</p>
              </div>
              <div>
                <span className="font-semibold text-primary">Tautan Baru yang Akan Diaktifkan:</span>
                <p className="font-mono text-primary font-medium truncate">{approvingRequest.requested_shopee_link}</p>
              </div>
            </div>

            <p className="text-xs text-muted mb-4">
              Menyetujui permohonan ini akan langsung memperbarui tautan akun aktif member dan mencatatnya ke dalam log audit keamanan.
            </p>

            <div className="modal-actions-cluster">
              <Button
                type="button"
                variant="outline"
                onClick={() => setApprovingRequest(null)}
                disabled={submittingApproval}
              >
                Batal
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={submittingApproval}
                loadingText="Menyetujui..."
                onClick={handleApproveSubmit}
              >
                Ya, Setujui Perubahan
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* MODAL: TOLAK PERUBAHAN AKUN SHOPEE */}
      <Modal
        isOpen={!!rejectingRequest}
        onClose={() => {
          if (!submittingRejection) {
            setRejectingRequest(null);
            setRejectionReason('');
          }
        }}
        title="Tolak Permohonan Akun Shopee Affiliate"
      >
        {rejectingRequest && (
          <form onSubmit={handleRejectSubmit}>
            <p className="text-sm text-muted mb-3">
              Tolak permohonan perubahan akun Shopee untuk pengguna <strong>{rejectingRequest.username}</strong>.
            </p>

            <div className="p-3 bg-secondary rounded text-xs mb-4">
              <span className="text-muted">Tautan yang Diajukan:</span>
              <p className="font-mono text-danger truncate mt-1">{rejectingRequest.requested_shopee_link}</p>
            </div>

            <Input
              label="Alasan Penolakan"
              id="rejection-reason"
              name="rejection_reason"
              type="text"
              placeholder="Contoh: Format URL tidak valid / akun bukan affiliate resmi"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              required
              helperText="Wajib diisi agar member memahami perbaikan atau alasan penolakan."
              disabled={submittingRejection}
            />

            <div className="modal-actions-cluster mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRejectingRequest(null);
                  setRejectionReason('');
                }}
                disabled={submittingRejection}
              >
                Batal
              </Button>
              <Button
                type="submit"
                variant="danger"
                loading={submittingRejection}
                loadingText="Menolak..."
              >
                Tolak Permohonan
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
};
