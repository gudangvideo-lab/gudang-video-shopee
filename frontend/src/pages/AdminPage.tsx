/**
 * frontend/src/pages/AdminPage.tsx
 * Panel Manajemen Administrator Gudang Video Shopee Affiliate.
 * Meliputi pengelolaan video R2, kode aktivasi, pengguna & reset perangkat, serta audit log.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter } from '../router/Router';
import { adminApi, superAdminApi, videoApi, shopeeApi, commissionApi, ApiClientError } from '../api/client';
import {
  ActivationCodeItem,
  AdminUserItem,
  AuditLogItem,
  AdminVideoItem,
  ShopeeAccountRequest,
  RackItem,
  UserGroupSummary,
  CommissionProof
} from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Alert } from '../components/Alert';
import { Modal } from '../components/Modal';
import { VideoPlayerModal } from '../components/VideoPlayerModal';

type AdminTab = 'overview' | 'videos' | 'racks' | 'codes' | 'users' | 'shopee' | 'admins' | 'logs';

/**
 * Memvalidasi dan mengekstrak tautan profil/akun Shopee yang aman untuk tautan eksternal.
 * Hanya mengizinkan protokol https: atau http:, serta domain resmi Shopee (*.shopee.co.id, *.shope.ee).
 * Menolak javascript:, data:, dan protokol atau domain tidak aman lainnya.
 * Mengembalikan null jika tautan kosong atau tidak valid.
 */
export function getSafeShopeeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'shopee.co.id' ||
      hostname.endsWith('.shopee.co.id') ||
      hostname === 'shope.ee' ||
      hostname.endsWith('.shope.ee')
    ) {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export const AdminPage: React.FC<{ initialTab?: AdminTab }> = ({ initialTab = 'overview' }) => {
  const { user } = useAuth();
  const { navigate } = useRouter();

  const adminVideosRequestIdRef = useRef<number>(0);
  const adminUsersRequestIdRef = useRef<number>(0);
  const initialUsersLoadedRef = useRef<boolean>(false);

  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab);

  // Data state
  const [videos, setVideos] = useState<AdminVideoItem[]>([]);
  const [racks, setRacks] = useState<RackItem[]>([]);
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


  // Modal Change Username (Super Admin only)
  const [targetUserForUsername, setTargetUserForUsername] = useState<AdminUserItem | null>(null);
  const [newTargetUsername, setNewTargetUsername] = useState('');
  const [updatingUsername, setUpdatingUsername] = useState(false);

  // Modal Reset Password (Super Admin only)
  const [targetUserForPasswordReset, setTargetUserForPasswordReset] = useState<AdminUserItem | null>(null);
  const [newTargetPassword, setNewTargetPassword] = useState('');
  const [resettingUserPassword, setResettingUserPassword] = useState(false);

  // Modal Delete Account (Fitur 8)
  const [targetUserForDeletion, setTargetUserForDeletion] = useState<AdminUserItem | null>(null);
  const [confirmDeleteUsername, setConfirmDeleteUsername] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);

  // Modal Member Status (Nonaktifkan / Aktifkan - Fitur 8)
  const [targetUserForStatus, setTargetUserForStatus] = useState<{ user: AdminUserItem; action: 'suspend' | 'activate' } | null>(null);
  const [statusReason, setStatusReason] = useState('');
  const [updatingUserStatus, setUpdatingUserStatus] = useState(false);

  // Modal Bukti Komisi Member (Fitur 9)
  const [selectedMemberForProof, setSelectedMemberForProof] = useState<AdminUserItem | null>(null);
  const [memberCommissionProof, setMemberCommissionProof] = useState<CommissionProof | null>(null);
  const [loadingMemberProof, setLoadingMemberProof] = useState<boolean>(false);
  const [deletingMemberProof, setDeletingMemberProof] = useState<boolean>(false);
  const [confirmDeleteMemberProof, setConfirmDeleteMemberProof] = useState<boolean>(false);
  const [memberProofError, setMemberProofError] = useState<string | null>(null);

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
  const [uploadRackId, setUploadRackId] = useState('');
  const [uploadStatus, setUploadStatus] = useState<'active' | 'inactive'>('active');
  const [uploading, setUploading] = useState(false);

  // Modal Edit Video
  const [editingVideo, setEditingVideo] = useState<AdminVideoItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editProductName, setEditProductName] = useState('');
  const [editProductUrl, setEditProductUrl] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRackId, setEditRackId] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'inactive'>('active');
  const [savingEdit, setSavingEdit] = useState(false);

  // Modal Delete Video
  const [deletingVideo, setDeletingVideo] = useState<AdminVideoItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Modal Preview Video
  const [previewVideo, setPreviewVideo] = useState<AdminVideoItem | null>(null);

  // Rack Modals
  const [showCreateRackModal, setShowCreateRackModal] = useState(false);
  const [newRackName, setNewRackName] = useState('');
  const [creatingRack, setCreatingRack] = useState(false);

  const [editingRack, setEditingRack] = useState<RackItem | null>(null);
  const [editRackName, setEditRackName] = useState('');
  const [savingRack, setSavingRack] = useState(false);

  const [deletingRack, setDeletingRack] = useState<RackItem | null>(null);
  const [deletingRackState, setDeletingRackState] = useState(false);

  // Move Video Rack Modal
  const [movingVideo, setMovingVideo] = useState<AdminVideoItem | null>(null);
  const [targetRackId, setTargetRackId] = useState('');
  const [movingVideoState, setMovingVideoState] = useState(false);

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

  // User Search, Filter, Grouping & Pagination state (Fitur 6)
  const [userSearch, setUserSearch] = useState<string>('');
  const [userFilterStatus, setUserFilterStatus] = useState<'all' | 'active' | 'suspended'>('all');
  const [userFilterPath, setUserFilterPath] = useState<'all' | 'direct' | 'referral'>('all');
  const [userFilterRole, setUserFilterRole] = useState<'all' | 'member' | 'admin' | 'super_admin'>('all');
  const [userFilterInviter, setUserFilterInviter] = useState<string>('all');
  const [userViewMode, setUserViewMode] = useState<'list' | 'grouped'>('list');
  const [userPage, setUserPage] = useState<number>(1);
  const [userPageSize, setUserPageSize] = useState<number>(15);
  const [userTotalCount, setUserTotalCount] = useState<number>(0);
  const [userTotalPages, setUserTotalPages] = useState<number>(1);
  const [loadingUsersTab, setLoadingUsersTab] = useState<boolean>(false);
  const [userGroups, setUserGroups] = useState<UserGroupSummary[]>([]);
  const [loadingGroups, setLoadingGroups] = useState<boolean>(false);
  const [availableInvitersList, setAvailableInvitersList] = useState<string[]>([]);
  const [expandedGroupMembers, setExpandedGroupMembers] = useState<
    Record<string, { users: AdminUserItem[]; loading: boolean; page: number; totalPages: number; total: number }>
  >({});

  // Video Pagination & Filter state
  const [videoCursorHistory, setVideoCursorHistory] = useState<string[]>([]);
  const [videoCurrentCursor, setVideoCurrentCursor] = useState<string | null>(null);
  const [videoHasMore, setVideoHasMore] = useState<boolean>(false);
  const [videoNextCursor, setVideoNextCursor] = useState<string | null>(null);
  const [videoPageIndex, setVideoPageIndex] = useState<number>(1);
  const [videoSearch, setVideoSearch] = useState<string>('');
  const [videoFilterRackId, setVideoFilterRackId] = useState<string>('all');
  const [videoFilterStatus, setVideoFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [loadingVideosTab, setLoadingVideosTab] = useState<boolean>(false);

  const fetchVideosData = useCallback(async (options?: {
    cursor?: string | null;
    rackId?: string;
    status?: 'all' | 'active' | 'inactive';
    q?: string;
    page?: number;
  }) => {
    const currentRequestId = ++adminVideosRequestIdRef.current;
    setLoadingVideosTab(true);
    try {
      const activeCursor = options?.cursor !== undefined ? options.cursor : videoCurrentCursor;
      const activeRack = options?.rackId !== undefined ? options.rackId : videoFilterRackId;
      const activeStatus = options?.status !== undefined ? options.status : videoFilterStatus;
      const activeQ = options?.q !== undefined ? options.q : videoSearch;

      const videosRes = await adminApi.listVideos({
        cursor: activeCursor || undefined,
        limit: 24,
        rackId: activeRack !== 'all' ? activeRack : undefined,
        status: activeStatus !== 'all' ? activeStatus : undefined,
        q: activeQ.trim() || undefined
      });

      if (currentRequestId !== adminVideosRequestIdRef.current) return;

      setVideos(videosRes.videos || []);
      setVideoHasMore(videosRes.pagination?.has_more ?? false);
      setVideoNextCursor(videosRes.pagination?.next_cursor ?? null);
      if (options?.page !== undefined) {
        setVideoPageIndex(options.page);
      }
    } catch (err) {
      if (currentRequestId !== adminVideosRequestIdRef.current) return;
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      }
    } finally {
      if (currentRequestId === adminVideosRequestIdRef.current) {
        setLoadingVideosTab(false);
      }
    }
  }, [videoCurrentCursor, videoFilterRackId, videoFilterStatus, videoSearch]);

  const handleAdminVideoNextPage = () => {
    if (!videoNextCursor || loadingVideosTab) return;
    setVideoCursorHistory((prev) => [...prev, videoCurrentCursor || '']);
    setVideoCurrentCursor(videoNextCursor);
    fetchVideosData({ cursor: videoNextCursor, page: videoPageIndex + 1 });
  };

  const handleAdminVideoPrevPage = () => {
    if (videoPageIndex <= 1 || loadingVideosTab) return;
    const newHistory = [...videoCursorHistory];
    const prevCursor = newHistory.pop() || null;
    setVideoCursorHistory(newHistory);
    setVideoCurrentCursor(prevCursor);
    fetchVideosData({ cursor: prevCursor, page: videoPageIndex - 1 });
  };

  const handleAdminVideoFilterChange = (
    newRackId?: string,
    newStatus?: 'all' | 'active' | 'inactive',
    newQ?: string
  ) => {
    const rId = newRackId !== undefined ? newRackId : videoFilterRackId;
    const st = newStatus !== undefined ? newStatus : videoFilterStatus;
    const q = newQ !== undefined ? newQ : videoSearch;
    if (newRackId !== undefined) setVideoFilterRackId(newRackId);
    if (newStatus !== undefined) setVideoFilterStatus(newStatus);
    if (newQ !== undefined) setVideoSearch(newQ);
    setVideoCursorHistory([]);
    setVideoCurrentCursor(null);
    setVideoPageIndex(1);
    fetchVideosData({ rackId: rId, status: st, q, cursor: null, page: 1 });
  };

  // Server-Driven User Database, Filter, Grouping & Pagination Helpers (Fitur 6)
  const fetchUsersData = useCallback(async (options?: {
    page?: number;
    pageSize?: number;
    q?: string;
    role?: 'all' | 'member' | 'admin' | 'super_admin';
    status?: 'all' | 'active' | 'suspended';
    path?: 'all' | 'direct' | 'referral';
    inviter?: string;
  }) => {
    const currentRequestId = ++adminUsersRequestIdRef.current;
    setLoadingUsersTab(true);
    try {
      const activePage = options?.page !== undefined ? options.page : userPage;
      const activePageSize = options?.pageSize !== undefined ? options.pageSize : userPageSize;
      const activeQ = options?.q !== undefined ? options.q : userSearch;
      const activeRole = options?.role !== undefined ? options.role : userFilterRole;
      const activeStatus = options?.status !== undefined ? options.status : userFilterStatus;
      const activePath = options?.path !== undefined ? options.path : userFilterPath;
      const activeInviter = options?.inviter !== undefined ? options.inviter : userFilterInviter;

      const res = await adminApi.listUsers({
        page: activePage,
        limit: activePageSize,
        q: activeQ.trim() || undefined,
        role: activeRole !== 'all' ? activeRole : undefined,
        status: activeStatus !== 'all' ? activeStatus : undefined,
        registration_path: activePath !== 'all' ? activePath : undefined,
        inviter: activeInviter !== 'all' ? activeInviter : undefined,
      });

      if (currentRequestId !== adminUsersRequestIdRef.current) return;

      setUsers(res.users || []);
      if (res.pagination) {
        setUserTotalCount(res.pagination.total);
        setUserTotalPages(res.pagination.total_pages);
        setUserPage(res.pagination.page);
      } else {
        setUserTotalCount(res.users?.length || 0);
        setUserTotalPages(Math.max(1, Math.ceil((res.users?.length || 0) / activePageSize)));
      }
    } catch (err) {
      if (currentRequestId !== adminUsersRequestIdRef.current) return;
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      }
    } finally {
      if (currentRequestId === adminUsersRequestIdRef.current) {
        setLoadingUsersTab(false);
      }
    }
  }, [userPage, userPageSize, userSearch, userFilterRole, userFilterStatus, userFilterPath, userFilterInviter]);

  const fetchUserGroupsData = useCallback(async (options?: {
    q?: string;
    role?: 'all' | 'member' | 'admin' | 'super_admin';
    status?: 'all' | 'active' | 'suspended';
    path?: 'all' | 'direct' | 'referral';
    inviter?: string;
  }) => {
    setLoadingGroups(true);
    try {
      const activeQ = options?.q !== undefined ? options.q : userSearch;
      const activeRole = options?.role !== undefined ? options.role : userFilterRole;
      const activeStatus = options?.status !== undefined ? options.status : userFilterStatus;
      const activePath = options?.path !== undefined ? options.path : userFilterPath;
      const activeInviter = options?.inviter !== undefined ? options.inviter : userFilterInviter;

      const res = await adminApi.listUserGroups({
        q: activeQ.trim() || undefined,
        role: activeRole !== 'all' ? activeRole : undefined,
        status: activeStatus !== 'all' ? activeStatus : undefined,
        registration_path: activePath !== 'all' ? activePath : undefined,
        inviter: activeInviter !== 'all' ? activeInviter : undefined,
      });

      setUserGroups(res.groups || []);
      setExpandedGroupMembers({});
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      }
    } finally {
      setLoadingGroups(false);
    }
  }, [userSearch, userFilterRole, userFilterStatus, userFilterPath, userFilterInviter]);

  const handleUserFilterChange = (
    newRole?: typeof userFilterRole,
    newStatus?: typeof userFilterStatus,
    newPath?: typeof userFilterPath,
    newInviter?: string
  ) => {
    const r = newRole !== undefined ? newRole : userFilterRole;
    const s = newStatus !== undefined ? newStatus : userFilterStatus;
    const p = newPath !== undefined ? newPath : userFilterPath;
    const inv = newInviter !== undefined ? newInviter : userFilterInviter;

    if (newRole !== undefined) setUserFilterRole(newRole);
    if (newStatus !== undefined) setUserFilterStatus(newStatus);
    if (newPath !== undefined) setUserFilterPath(newPath);
    if (newInviter !== undefined) setUserFilterInviter(newInviter);

    setUserPage(1);
    fetchUsersData({ role: r, status: s, path: p, inviter: inv, page: 1 });
    fetchUserGroupsData({ role: r, status: s, path: p, inviter: inv });
  };

  const handleResetUserFilters = () => {
    setUserSearch('');
    setUserFilterStatus('all');
    setUserFilterPath('all');
    setUserFilterRole('all');
    setUserFilterInviter('all');
    setUserPage(1);
    fetchUsersData({ q: '', status: 'all', path: 'all', role: 'all', inviter: 'all', page: 1 });
    fetchUserGroupsData({ q: '', status: 'all', path: 'all', role: 'all', inviter: 'all' });
  };

  // Debounce search effect to avoid excessive API requests
  useEffect(() => {
    if (!initialUsersLoadedRef.current) return;
    const timer = setTimeout(() => {
      setUserPage(1);
      fetchUsersData({ q: userSearch, page: 1 });
      fetchUserGroupsData({ q: userSearch });
    }, 300);
    return () => clearTimeout(timer);
  }, [userSearch]);

  const handleToggleGroup = async (groupKey: string, isDirect: boolean, targetPage: number = 1) => {
    if (
      expandedGroupMembers[groupKey] &&
      targetPage === expandedGroupMembers[groupKey].page &&
      expandedGroupMembers[groupKey].users.length > 0 &&
      !expandedGroupMembers[groupKey].loading
    ) {
      setExpandedGroupMembers((prev) => {
        const copy = { ...prev };
        delete copy[groupKey];
        return copy;
      });
      return;
    }

    setExpandedGroupMembers((prev) => ({
      ...prev,
      [groupKey]: {
        users: prev[groupKey]?.users || [],
        loading: true,
        page: targetPage,
        totalPages: prev[groupKey]?.totalPages || 1,
        total: prev[groupKey]?.total || 0
      }
    }));

    try {
      const res = await adminApi.listUsers({
        page: targetPage,
        limit: 10,
        q: userSearch.trim() || undefined,
        role: 'member',
        status: userFilterStatus !== 'all' ? userFilterStatus : undefined,
        registration_path: userFilterPath !== 'all' ? userFilterPath : undefined,
        inviter: isDirect ? '__none__' : groupKey
      });

      setExpandedGroupMembers((prev) => ({
        ...prev,
        [groupKey]: {
          users: res.users || [],
          loading: false,
          page: res.pagination?.page || targetPage,
          totalPages: res.pagination?.total_pages || 1,
          total: res.pagination?.total || (res.users?.length || 0)
        }
      }));
    } catch (err) {
      setExpandedGroupMembers((prev) => ({
        ...prev,
        [groupKey]: {
          ...prev[groupKey],
          loading: false
        }
      }));
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      }
    }
  };

  const fetchAllData = useCallback(async () => {
    const currentVideosRequestId = ++adminVideosRequestIdRef.current;
    setLoading(true);
    setErrorMsg(null);
    try {
      const [videosRes, codesRes, usersRes, logsRes, shopeeRes, racksRes, groupsRes] = await Promise.all([
        adminApi.listVideos({
          cursor: videoCurrentCursor || undefined,
          limit: 24,
          rackId: videoFilterRackId !== 'all' ? videoFilterRackId : undefined,
          status: videoFilterStatus !== 'all' ? videoFilterStatus : undefined,
          q: videoSearch.trim() || undefined
        }),
        adminApi.listActivationCodes(),
        adminApi.listUsers({ page: 1, limit: userPageSize }),
        adminApi.listAuditLogs(),
        shopeeApi.listAdminRequests('all'),
        adminApi.listRacks(),
        adminApi.listUserGroups()
      ]);

      if (currentVideosRequestId === adminVideosRequestIdRef.current) {
        setVideos(videosRes.videos || []);
        setVideoHasMore(videosRes.pagination?.has_more ?? false);
        setVideoNextCursor(videosRes.pagination?.next_cursor ?? null);
      }

      setCodes(codesRes.codes || []);
      setUsers(usersRes.users || []);
      if (usersRes.pagination) {
        setUserTotalCount(usersRes.pagination.total);
        setUserTotalPages(usersRes.pagination.total_pages);
        setUserPage(usersRes.pagination.page);
      } else {
        setUserTotalCount(usersRes.users?.length || 0);
        setUserTotalPages(1);
      }

      setUserGroups(groupsRes.groups || []);
      const namedInviters = (groupsRes.groups || [])
        .filter((g) => !g.is_direct && g.inviter_name)
        .map((g) => g.inviter_name);
      setAvailableInvitersList(namedInviters);

      setLogs(logsRes.logs || []);
      setShopeeRequests(shopeeRes.requests || []);
      setRacks(racksRes.racks || []);

      const defRack = (racksRes.racks || []).find((r) => r.is_default);
      if (defRack) {
        setUploadRackId((prev) => prev || defRack.id);
      }

      if (user?.role === 'super_admin') {
        try {
          const adminsRes = await superAdminApi.listAdmins();
          setAdmins(adminsRes.admins || []);
        } catch {}
      }

      initialUsersLoadedRef.current = true;
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal memuat data administratif dari server.');
      }
    } finally {
      setLoading(false);
    }
  }, [user?.role, userPageSize, videoCurrentCursor, videoFilterRackId, videoFilterStatus, videoSearch]);

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
        rack_id: uploadRackId || undefined,
        status: uploadStatus
      });
      setActionSuccessMsg('Video berhasil diunggah ke Cloudflare R2 privat!');
      setShowUploadModal(false);
      setUploadFile(null);
      setUploadTitle('');
      setUploadProductName('');
      setUploadProductUrl('');
      setUploadDescription('');
      const defRack = racks.find((r) => r.is_default);
      setUploadRackId(defRack ? defRack.id : '');
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
    setEditRackId(video.rack_id || '');
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
        rack_id: editRackId || undefined,
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


  const handleUpdateUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUserForUsername || !newTargetUsername.trim()) return;

    setUpdatingUsername(true);
    setErrorMsg(null);
    try {
      await superAdminApi.updateUsername(targetUserForUsername.id, {
        new_username: newTargetUsername.trim()
      });
      setActionSuccessMsg(`Username berhasil diubah dari "${targetUserForUsername.username}" menjadi "${newTargetUsername.trim()}".`);
      setTargetUserForUsername(null);
      setNewTargetUsername('');
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal mengubah username.');
      }
    } finally {
      setUpdatingUsername(false);
    }
  };

  const handleResetUserPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUserForPasswordReset || !newTargetPassword) return;

    setResettingUserPassword(true);
    setErrorMsg(null);
    try {
      await superAdminApi.resetUserPassword(targetUserForPasswordReset.id, {
        new_password: newTargetPassword
      });
      setActionSuccessMsg(`Password pengguna "${targetUserForPasswordReset.username}" berhasil direset. Sesi aktif pengguna telah dicabut.`);
      setTargetUserForPasswordReset(null);
      setNewTargetPassword('');
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal mereset password pengguna.');
      }
    } finally {
      setResettingUserPassword(false);
    }
  };

  const handleUpdateUserStatusSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUserForStatus) return;
    setUpdatingUserStatus(true);
    setErrorMsg(null);
    try {
      const newStatus = targetUserForStatus.action === 'suspend' ? 'suspended' : 'active';
      const res = await adminApi.updateUserStatus(targetUserForStatus.user.id, {
        status: newStatus,
        reason: statusReason.trim() || undefined
      });
      setActionSuccessMsg(res.message);
      setTargetUserForStatus(null);
      setStatusReason('');
      await fetchAllData();
      if (userViewMode === 'grouped') {
        fetchUserGroupsData();
      } else {
        fetchUsersData();
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal memperbarui status akun member.');
      }
    } finally {
      setUpdatingUserStatus(false);
    }
  };

  const handleDeleteAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUserForDeletion || !confirmDeleteUsername.trim()) return;
    if (confirmDeleteUsername.trim().toLowerCase() !== targetUserForDeletion.username.toLowerCase()) {
      setErrorMsg('Konfirmasi username tidak cocok dengan akun yang dipilih.');
      return;
    }

    setDeletingAccount(true);
    setErrorMsg(null);
    try {
      if (user?.role === 'super_admin' && targetUserForDeletion.role !== 'member') {
        await superAdminApi.deleteAccount(targetUserForDeletion.id, {
          confirm_username: confirmDeleteUsername.trim()
        });
      } else {
        await adminApi.deleteUser(targetUserForDeletion.id, {
          confirm_username: confirmDeleteUsername.trim()
        });
      }
      setActionSuccessMsg(`Akun "${targetUserForDeletion.username}" (${targetUserForDeletion.role === 'admin' ? 'Administrator' : 'Member'}) berhasil dihapus permanen secara aman.`);
      setTargetUserForDeletion(null);
      setConfirmDeleteUsername('');
      await fetchAllData();
      if (userViewMode === 'grouped') {
        fetchUserGroupsData();
      } else {
        fetchUsersData();
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal menghapus akun.');
      }
    } finally {
      setDeletingAccount(false);
    }
  };

  const handleOpenMemberProof = async (member: AdminUserItem) => {
    setSelectedMemberForProof(member);
    setMemberCommissionProof(null);
    setLoadingMemberProof(true);
    setConfirmDeleteMemberProof(false);
    setMemberProofError(null);
    try {
      const res = await commissionApi.getAdminMemberProof(member.id);
      setMemberCommissionProof(res.proof);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setMemberProofError(err.message);
      } else {
        setMemberProofError('Gagal memuat bukti komisi member.');
      }
    } finally {
      setLoadingMemberProof(false);
    }
  };

  const handleDeleteMemberProofSubmit = async () => {
    if (!selectedMemberForProof) return;
    setDeletingMemberProof(true);
    setMemberProofError(null);
    try {
      const res = await commissionApi.deleteAdminMemberProof(selectedMemberForProof.id);
      setMemberCommissionProof(null);
      setConfirmDeleteMemberProof(false);
      setActionSuccessMsg(res.message || `Bukti komisi milik "${selectedMemberForProof.username}" berhasil dihapus.`);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setMemberProofError(err.message);
      } else {
        setMemberProofError('Gagal menghapus bukti komisi.');
      }
    } finally {
      setDeletingMemberProof(false);
    }
  };

  const handleCreateRackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRackName.trim()) return;

    setCreatingRack(true);
    setErrorMsg(null);
    try {
      await adminApi.createRack({
        name: newRackName.trim()
      });
      setActionSuccessMsg(`Rak "${newRackName.trim()}" berhasil dibuat!`);
      setShowCreateRackModal(false);
      setNewRackName('');
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal membuat rak baru.');
      }
    } finally {
      setCreatingRack(false);
    }
  };

  const handleUpdateRackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRack || !editRackName.trim()) return;

    setSavingRack(true);
    setErrorMsg(null);
    try {
      await adminApi.updateRack(editingRack.id, {
        name: editRackName.trim()
      });
      setActionSuccessMsg(`Rak "${editRackName.trim()}" berhasil diperbarui!`);
      setEditingRack(null);
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal memperbarui data rak.');
      }
    } finally {
      setSavingRack(false);
    }
  };

  const handleDeleteRackSubmit = async () => {
    if (!deletingRack) return;

    setDeletingRackState(true);
    setErrorMsg(null);
    try {
      const res = await adminApi.deleteRack(deletingRack.id);
      setActionSuccessMsg(res.message || `Rak "${deletingRack.name}" berhasil dihapus.`);
      setDeletingRack(null);
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal menghapus rak.');
      }
    } finally {
      setDeletingRackState(false);
    }
  };

  const handleMoveVideoRackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!movingVideo || !targetRackId) return;

    setMovingVideoState(true);
    setErrorMsg(null);
    try {
      await adminApi.moveVideoRack(movingVideo.id, {
        target_rack_id: targetRackId
      });
      setActionSuccessMsg(`Video "${movingVideo.title}" berhasil dipindahkan ke rak tujuan!`);
      setMovingVideo(null);
      await fetchAllData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Gagal memindahkan video ke rak.');
      }
    } finally {
      setMovingVideoState(false);
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
          className={`tab-btn ${activeTab === 'racks' ? 'active' : ''}`}
          onClick={() => setActiveTab('racks')}
        >
          Rak Video ({racks.length})
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
              <span className="stat-icon">📁</span>
              <div className="stat-value">{racks.length}</div>
              <div className="stat-label">Kategori / Rak Video</div>
              <div className="stat-desc">
                {racks.filter((r) => !r.is_default).length} kustom / 1 bawaan sistem
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
          <div className="table-header-bar" style={{ flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h3>Daftar Video di R2 Privat ({videos.length})</h3>
              <p className="text-xs text-muted mt-1">
                Katalog video Cloudflare R2 dengan navigasi cursor-based dan filter server-side.
              </p>
            </div>
            <Button
              variant="primary"
              className="btn-sm"
              onClick={() => setShowUploadModal(true)}
            >
              + Unggah Video Baru
            </Button>
          </div>

          {/* Filter & Search Bar */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', margin: '16px 0', flexWrap: 'wrap' }}>
            <input
              type="text"
              className="form-input"
              style={{ maxWidth: '260px' }}
              placeholder="Cari judul / produk..."
              value={videoSearch}
              maxLength={100}
              onChange={(e) => setVideoSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdminVideoFilterChange(undefined, undefined, videoSearch);
                }
              }}
            />
            <Button
              variant="outline"
              className="btn-sm"
              onClick={() => handleAdminVideoFilterChange(undefined, undefined, videoSearch)}
              loading={loadingVideosTab}
              loadingText="Mencari..."
            >
              Cari
            </Button>
            <select
              className="form-input"
              style={{ maxWidth: '180px' }}
              value={videoFilterRackId}
              onChange={(e) => handleAdminVideoFilterChange(e.target.value, undefined, undefined)}
            >
              <option value="all">Semua Rak</option>
              {racks.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <select
              className="form-input"
              style={{ maxWidth: '140px' }}
              value={videoFilterStatus}
              onChange={(e) => handleAdminVideoFilterChange(undefined, e.target.value as 'all' | 'active' | 'inactive', undefined)}
            >
              <option value="all">Semua Status</option>
              <option value="active">Aktif</option>
              <option value="inactive">Nonaktif</option>
            </select>
            <Button
              variant="outline"
              className="btn-sm"
              onClick={() => {
                setVideoSearch('');
                setVideoFilterRackId('all');
                setVideoFilterStatus('all');
                handleAdminVideoFilterChange('all', 'all', '');
              }}
            >
              Reset Filter
            </Button>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Judul Video</th>
                  <th>Rak / Kategori</th>
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
                    <td colSpan={8} className="text-center text-muted p-6">
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
                        <span className="badge badge-info text-xs">{item.rack_name || 'General'}</span>
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
                          <Button
                            variant="outline"
                            className="btn-xs"
                            onClick={() => setPreviewVideo(item)}
                            title="Putar pratinjau video"
                          >
                            ▶ Putar
                          </Button>
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
                            onClick={() => {
                              setMovingVideo(item);
                              setTargetRackId(item.rack_id || '');
                            }}
                          >
                            Pindah Rak
                          </Button>
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

          {/* Kontrol Navigasi Halaman (Pagination) */}
          {videos.length > 0 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: '16px',
                paddingTop: '16px',
                borderTop: '1px solid #e5e7eb',
                flexWrap: 'wrap',
                gap: '12px'
              }}
            >
              <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                Halaman <strong>{videoPageIndex}</strong> &bull; Menampilkan {videos.length} video {videoHasMore ? '(Ada halaman berikutnya)' : '(Akhir katalog)'}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button
                  variant="outline"
                  className="btn-sm"
                  disabled={videoPageIndex <= 1 || loadingVideosTab}
                  onClick={handleAdminVideoPrevPage}
                >
                  &larr; Halaman Sebelumnya
                </Button>
                <Button
                  variant="primary"
                  className="btn-sm"
                  disabled={!videoHasMore || loadingVideosTab}
                  onClick={handleAdminVideoNextPage}
                >
                  Halaman Berikutnya &rarr;
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB: MANAJEMEN RAK */}
      {activeTab === 'racks' && (
        <div className="tab-pane">
          <div className="table-header-bar">
            <div>
              <h3>Manajemen Rak / Kategori Video ({racks.length})</h3>
              <p className="text-xs text-muted mt-1">
                Kelola pengelompokan rak video katalog. Rak "General" adalah rak sistem bawaan yang tidak dapat diubah atau dihapus. Menghapus rak kustom otomatis memindahkan videonya ke General.
              </p>
            </div>
            <Button
              variant="primary"
              className="btn-sm"
              onClick={() => setShowCreateRackModal(true)}
            >
              + Tambah Rak Baru
            </Button>
          </div>

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Nama Rak</th>
                  <th>Jumlah Video</th>
                  <th>Tipe Rak</th>
                  <th>Dibuat</th>
                  <th>Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {racks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center text-muted p-6">
                      Belum ada data rak.
                    </td>
                  </tr>
                ) : (
                  racks.map((rack) => (
                    <tr key={rack.id}>
                      <td className="font-semibold">
                        <span className="text-base mr-2">📁</span>
                        {rack.name}
                      </td>
                      <td>
                        <span className="font-semibold">{rack.video_count ?? 0}</span> video
                      </td>
                      <td>
                        {rack.is_default ? (
                          <Badge variant="warning">Bawaan Sistem</Badge>
                        ) : (
                          <Badge variant="info">Kustom</Badge>
                        )}
                      </td>
                      <td className="text-xs">{formatDate(rack.created_at)}</td>
                      <td>
                        {rack.is_default ? (
                          <span className="text-xs text-muted">Terkunci (Sistem)</span>
                        ) : (
                          <div className="action-buttons-row">
                            <Button
                              variant="outline"
                              className="btn-xs"
                              onClick={() => {
                                setEditingRack(rack);
                                setEditRackName(rack.name);
                              }}
                            >
                              Ubah
                            </Button>
                            <Button
                              variant="danger"
                              className="btn-xs"
                              onClick={() => setDeletingRack(rack)}
                            >
                              Hapus
                            </Button>
                          </div>
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

      {/* TAB 3: KODE AKTIVASI */}
      {activeTab === 'codes' && (
        <div className="tab-pane">
          <div className="table-header-bar">
            <div>
              <h3>Daftar Kode Aktivasi ({codes.length})</h3>
              <p className="text-xs text-muted mt-1">
                Kode aktivasi sekali pakai dengan entropi 130-bit untuk pendaftaran akun Member baru.
              </p>
            </div>
            {(user?.role === 'admin' || user?.role === 'super_admin') && (
              <Button
                variant="primary"
                className="btn-sm"
                onClick={() => setShowCreateCodeModal(true)}
              >
                + Buat Kode Aktivasi Member
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

      {/* TAB 4: MANAJEMEN PENGGUNA & DATABASE ANGGOTA */}
      {activeTab === 'users' && (
        <div className="tab-pane">
          <div className="table-header-bar">
            <div>
              <h3>Daftar Seluruh Pengguna & Anggota ({userTotalCount})</h3>
              <p className="text-xs text-muted mt-1">
                Database anggota affiliate terdaftar, administrator operasional, dan Super Administrator.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                className="btn-sm"
                onClick={() => setShowCreateCodeModal(true)}
              >
                + Tambah Member
              </Button>
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
          </div>

          {/* Baris Pencarian dan Filter Pengguna */}
          <div className="flex flex-col gap-3 my-4">
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="form-input"
                style={{ maxWidth: '280px' }}
                placeholder="Cari username, WhatsApp, pengundang..."
                value={userSearch}
                maxLength={100}
                onChange={(e) => {
                  setUserSearch(e.target.value);
                }}
              />

              <select
                className="form-input"
                style={{ maxWidth: '160px' }}
                value={userFilterRole}
                onChange={(e) => handleUserFilterChange(e.target.value as any, undefined, undefined, undefined)}
                title="Filter Peran Akun"
              >
                <option value="all">Semua Peran</option>
                <option value="member">Khusus Member</option>
                <option value="admin">Admin</option>
                <option value="super_admin">Super Admin</option>
              </select>

              <select
                className="form-input"
                style={{ maxWidth: '160px' }}
                value={userFilterStatus}
                onChange={(e) => handleUserFilterChange(undefined, e.target.value as any, undefined, undefined)}
                title="Filter Status Akun"
              >
                <option value="all">Semua Status</option>
                <option value="active">Aktif</option>
                <option value="suspended">Dibekukan</option>
              </select>

              <select
                className="form-input"
                style={{ maxWidth: '180px' }}
                value={userFilterPath}
                onChange={(e) => handleUserFilterChange(undefined, undefined, e.target.value as any, undefined)}
                title="Filter Jalur Pendaftaran"
              >
                <option value="all">Semua Jalur</option>
                <option value="direct">Daftar Mandiri</option>
                <option value="referral">Undangan (Referral)</option>
              </select>

              <select
                className="form-input"
                style={{ maxWidth: '200px' }}
                value={userFilterInviter}
                onChange={(e) => handleUserFilterChange(undefined, undefined, undefined, e.target.value)}
                title="Filter Pengundang / Referrer"
              >
                <option value="all">Semua Pengundang</option>
                <option value="__none__">Tanpa Pengundang</option>
                {availableInvitersList.map((inv) => (
                  <option key={inv} value={inv}>
                    {inv}
                  </option>
                ))}
              </select>

              <Button
                variant="outline"
                className="btn-sm"
                onClick={handleResetUserFilters}
              >
                Reset Filter
              </Button>
            </div>

            {/* Toolbar Mode Tampilan & Info Jumlah */}
            <div className="flex justify-between items-center flex-wrap gap-2 text-xs text-muted pt-1">
              <div>
                Menampilkan <strong>{userTotalCount > 0 ? (userPage - 1) * userPageSize + 1 : 0} - {Math.min(userPage * userPageSize, userTotalCount)}</strong> dari total <strong>{userTotalCount}</strong> pengguna
                {(userSearch || userFilterRole !== 'all' || userFilterStatus !== 'all' || userFilterPath !== 'all' || userFilterInviter !== 'all') && (
                  <span className="text-primary font-medium ml-1">(Filter aktif)</span>
                )}
              </div>

              {/* Toggle Mode Tampilan: Daftar vs Kelompok */}
              <div className="flex items-center gap-1 bg-secondary p-1 rounded">
                <button
                  type="button"
                  className={`btn-xs px-2 py-1 rounded font-medium ${userViewMode === 'list' ? 'bg-white shadow-sm text-primary font-semibold' : 'text-muted hover:text-primary'}`}
                  onClick={() => setUserViewMode('list')}
                >
                  📋 Daftar Lengkap
                </button>
                <button
                  type="button"
                  className={`btn-xs px-2 py-1 rounded font-medium ${userViewMode === 'grouped' ? 'bg-white shadow-sm text-primary font-semibold' : 'text-muted hover:text-primary'}`}
                  onClick={() => {
                    setUserViewMode('grouped');
                    if (userGroups.length === 0 && !loadingGroups) {
                      fetchUserGroupsData();
                    }
                  }}
                >
                  👥 Kelompokkan per Pengundang
                </button>
              </div>
            </div>
          </div>

          {/* MODE 1: DAFTAR LENGKAP DENGAN PAGINASI SERVER */}
          {userViewMode === 'list' && (
            <>
              <div className="table-responsive">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Nama Pengguna</th>
                      <th>Peran</th>
                      <th>Status Akun</th>
                      <th>Akun Shopee</th>
                      <th>WhatsApp</th>
                      <th>Jalur Pendaftaran</th>
                      <th>Perangkat Terikat</th>
                      <th>Aktivitas Terakhir</th>
                      <th>Tindakan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingUsersTab && users.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="text-center text-muted p-6">
                          Memuat data pengguna dari server...
                        </td>
                      </tr>
                    ) : users.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="text-center text-muted p-6">
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
                            {(() => {
                              const safeUrl = getSafeShopeeUrl(item.shopee_link);
                              return safeUrl ? (
                                <a
                                  href={safeUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline truncate-text inline-block max-w-[180px] align-middle text-xs"
                                  title={safeUrl}
                                >
                                  {safeUrl} &#8599;
                                </a>
                              ) : (
                                <span className="text-muted text-xs">—</span>
                              );
                            })()}
                          </td>
                          <td>
                            {item.whatsapp ? (
                              <span className="font-mono text-xs">{item.whatsapp}</span>
                            ) : (
                              <span className="text-muted text-xs">—</span>
                            )}
                          </td>
                          <td>
                            {item.registration_path === 'referral' ? (
                              <div className="text-xs">
                                <span className="badge badge-warning text-xs">Undangan</span>
                                {item.inviter_name && (
                                  <span className="text-muted ml-1" title={item.inviter_name}>
                                    ({item.inviter_name})
                                  </span>
                                )}
                              </div>
                            ) : item.registration_path === 'direct' ? (
                              <span className="badge badge-neutral text-xs">Daftar Sendiri</span>
                            ) : (
                              <span className="text-muted text-xs">—</span>
                            )}
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
                            <div className="action-buttons-row">
                              {item.role === 'super_admin' ? (
                                <span className="text-xs text-muted">Multi-Perangkat</span>
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
                                  Reset Perangkat
                                </Button>
                              )}
                              {item.role === 'member' && (
                                <>
                                  <Button
                                    variant="outline"
                                    className="btn-xs text-blue-700 border-blue-300 hover:bg-blue-50"
                                    onClick={() => handleOpenMemberProof(item)}
                                  >
                                    Bukti Komisi
                                  </Button>
                                  {item.status === 'active' ? (
                                    <Button
                                      variant="outline"
                                      className="btn-xs text-amber-700 border-amber-300 hover:bg-amber-50"
                                      onClick={() => {
                                        setTargetUserForStatus({ user: item, action: 'suspend' });
                                        setStatusReason('');
                                      }}
                                    >
                                      Nonaktifkan
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="outline"
                                      className="btn-xs text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                                      onClick={() => {
                                        setTargetUserForStatus({ user: item, action: 'activate' });
                                        setStatusReason('');
                                      }}
                                    >
                                      Aktifkan
                                    </Button>
                                  )}
                                  <Button
                                    variant="danger"
                                    className="btn-xs"
                                    onClick={() => {
                                      setTargetUserForDeletion(item);
                                      setConfirmDeleteUsername('');
                                    }}
                                  >
                                    Hapus
                                  </Button>
                                </>
                              )}
                              {user?.role === 'super_admin' && (
                                <>
                                  <Button
                                    variant="outline"
                                    className="btn-xs"
                                    onClick={() => {
                                      setTargetUserForUsername(item);
                                      setNewTargetUsername(item.username);
                                    }}
                                  >
                                    Ganti Username
                                  </Button>
                                  <Button
                                    variant="outline"
                                    className="btn-xs"
                                    onClick={() => {
                                      setTargetUserForPasswordReset(item);
                                      setNewTargetPassword('');
                                    }}
                                  >
                                    Reset Password
                                  </Button>
                                  {item.role === 'admin' && (
                                    <Button
                                      variant="danger"
                                      className="btn-xs"
                                      onClick={() => {
                                        setTargetUserForDeletion(item);
                                        setConfirmDeleteUsername('');
                                      }}
                                    >
                                      Hapus
                                    </Button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Navigasi Paginasi Pengguna */}
              {userTotalCount > 0 && (
                <div className="flex justify-between items-center flex-wrap gap-3 mt-3 text-xs text-muted">
                  <div>
                    Halaman <strong>{userPage}</strong> dari <strong>{userTotalPages}</strong> ({userTotalCount > 0 ? (userPage - 1) * userPageSize + 1 : 0} - {Math.min(userPage * userPageSize, userTotalCount)} dari {userTotalCount} pengguna)
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs">
                      <span>Per halaman:</span>
                      <select
                        className="form-input text-xs py-1 px-2"
                        style={{ width: 'auto', display: 'inline-block' }}
                        value={userPageSize}
                        onChange={(e) => {
                          const newSize = Number(e.target.value);
                          setUserPageSize(newSize);
                          setUserPage(1);
                          fetchUsersData({ pageSize: newSize, page: 1 });
                        }}
                      >
                        <option value={10}>10</option>
                        <option value={15}>15</option>
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                      </select>
                    </label>

                    <Button
                      variant="outline"
                      className="btn-xs"
                      disabled={userPage <= 1 || loadingUsersTab}
                      onClick={() => {
                        const prevPage = Math.max(1, userPage - 1);
                        setUserPage(prevPage);
                        fetchUsersData({ page: prevPage });
                      }}
                    >
                      &laquo; Sebelumnya
                    </Button>

                    <Button
                      variant="outline"
                      className="btn-xs"
                      disabled={userPage >= userTotalPages || loadingUsersTab}
                      onClick={() => {
                        const nextPage = Math.min(userTotalPages, userPage + 1);
                        setUserPage(nextPage);
                        fetchUsersData({ page: nextPage });
                      }}
                    >
                      Berikutnya &raquo;
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* MODE 2: PENGELOMPOKAN BERDASARKAN PENGUNDANG */}
          {userViewMode === 'grouped' && (
            <div className="space-y-6">
              <div className="alert-box alert-info">
                <p className="text-xs">
                  Dikelompokkan berdasarkan Pengundang / Referrer dari seluruh data pendaftaran anggota di database. Anggota tanpa pengundang dikelompokkan ke <strong>Tanpa Pengundang (Daftar Mandiri)</strong>. Klik <strong>Buka Anggota</strong> pada kelompok untuk memuat anggotanya.
                </p>
              </div>

              {loadingGroups && userGroups.length === 0 ? (
                <div className="text-center text-muted p-8 bg-surface rounded border">
                  Menghitung kelompok pengundang dari server...
                </div>
              ) : userGroups.length === 0 ? (
                <div className="text-center text-muted p-8 bg-surface rounded border">
                  {userFilterRole === 'admin' || userFilterRole === 'super_admin'
                    ? 'Pengelompokan pengundang hanya berlaku untuk akun Member.'
                    : 'Tidak ada pengguna ditemukan.'}
                </div>
              ) : (
                userGroups.map((group) => {
                  const expandedInfo = expandedGroupMembers[group.group_key];
                  const isExpanded = Boolean(expandedInfo);

                  return (
                    <div key={group.group_key} className="border border-border rounded-lg bg-surface overflow-hidden shadow-sm mb-4">
                      <div className="flex justify-between items-center p-3 bg-secondary border-b border-border">
                        <div className="flex items-center gap-2">
                          <span className="text-base">{group.is_direct ? '🌐' : '👥'}</span>
                          <span className="font-semibold text-sm">
                            {group.is_direct ? 'Tanpa Pengundang (Daftar Mandiri)' : `Pengundang: ${group.inviter_name}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={group.is_direct ? 'neutral' : 'warning'}>
                            {group.member_count} Anggota
                          </Badge>
                          <Button
                            variant="outline"
                            className="btn-xs"
                            onClick={() => handleToggleGroup(group.group_key, group.is_direct, 1)}
                          >
                            {isExpanded ? '▲ Tutup' : '▼ Buka Anggota'}
                          </Button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="p-2">
                          {expandedInfo.loading ? (
                            <div className="p-4 text-center text-xs text-muted">
                              Memuat anggota kelompok...
                            </div>
                          ) : expandedInfo.users.length === 0 ? (
                            <div className="p-4 text-center text-xs text-muted">
                              Tidak ada anggota yang cocok dengan kriteria filter saat ini.
                            </div>
                          ) : (
                            <>
                              <div className="table-responsive" style={{ border: 'none', borderRadius: 0, boxShadow: 'none' }}>
                                <table className="admin-table">
                                  <thead>
                                    <tr>
                                      <th>Nama Pengguna</th>
                                      <th>Peran</th>
                                      <th>Status Akun</th>
                                      <th>Akun Shopee</th>
                                      <th>WhatsApp</th>
                                      <th>Jalur Pendaftaran</th>
                                      <th>Perangkat Terikat</th>
                                      <th>Aktivitas Terakhir</th>
                                      <th>Tindakan</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {expandedInfo.users.map((item) => (
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
                                          {(() => {
                                            const safeUrl = getSafeShopeeUrl(item.shopee_link);
                                            return safeUrl ? (
                                              <a
                                                href={safeUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-primary hover:underline truncate-text inline-block max-w-[180px] align-middle text-xs"
                                                title={safeUrl}
                                              >
                                                {safeUrl} &#8599;
                                              </a>
                                            ) : (
                                              <span className="text-muted text-xs">—</span>
                                            );
                                          })()}
                                        </td>
                                        <td>
                                          {item.whatsapp ? (
                                            <span className="font-mono text-xs">{item.whatsapp}</span>
                                          ) : (
                                            <span className="text-muted text-xs">—</span>
                                          )}
                                        </td>
                                        <td>
                                          {item.registration_path === 'referral' ? (
                                            <div className="text-xs">
                                              <span className="badge badge-warning text-xs">Undangan</span>
                                              {item.inviter_name && (
                                                <span className="text-muted ml-1" title={item.inviter_name}>
                                                  ({item.inviter_name})
                                                </span>
                                              )}
                                            </div>
                                          ) : item.registration_path === 'direct' ? (
                                            <span className="badge badge-neutral text-xs">Daftar Sendiri</span>
                                          ) : (
                                            <span className="text-muted text-xs">—</span>
                                          )}
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
                                          <div className="action-buttons-row">
                                            {item.role === 'super_admin' ? (
                                              <span className="text-xs text-muted">Multi-Perangkat</span>
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
                                                Reset Perangkat
                                              </Button>
                                            )}
                                            {item.role === 'member' && (
                                              <>
                                                <Button
                                                  variant="outline"
                                                  className="btn-xs text-blue-700 border-blue-300 hover:bg-blue-50"
                                                  onClick={() => handleOpenMemberProof(item)}
                                                >
                                                  Bukti Komisi
                                                </Button>
                                                {item.status === 'active' ? (
                                                  <Button
                                                    variant="outline"
                                                    className="btn-xs text-amber-700 border-amber-300 hover:bg-amber-50"
                                                    onClick={() => {
                                                      setTargetUserForStatus({ user: item, action: 'suspend' });
                                                      setStatusReason('');
                                                    }}
                                                  >
                                                    Nonaktifkan
                                                  </Button>
                                                ) : (
                                                  <Button
                                                    variant="outline"
                                                    className="btn-xs text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                                                    onClick={() => {
                                                      setTargetUserForStatus({ user: item, action: 'activate' });
                                                      setStatusReason('');
                                                    }}
                                                  >
                                                    Aktifkan
                                                  </Button>
                                                )}
                                                <Button
                                                  variant="danger"
                                                  className="btn-xs"
                                                  onClick={() => {
                                                    setTargetUserForDeletion(item);
                                                    setConfirmDeleteUsername('');
                                                  }}
                                                >
                                                  Hapus
                                                </Button>
                                              </>
                                            )}
                                            {user?.role === 'super_admin' && (
                                              <>
                                                <Button
                                                  variant="outline"
                                                  className="btn-xs"
                                                  onClick={() => {
                                                    setTargetUserForUsername(item);
                                                    setNewTargetUsername(item.username);
                                                  }}
                                                >
                                                  Ganti Username
                                                </Button>
                                                <Button
                                                  variant="outline"
                                                  className="btn-xs"
                                                  onClick={() => {
                                                    setTargetUserForPasswordReset(item);
                                                    setNewTargetPassword('');
                                                  }}
                                                >
                                                  Reset Password
                                                </Button>
                                                {item.role === 'admin' && (
                                                  <Button
                                                    variant="danger"
                                                    className="btn-xs"
                                                    onClick={() => {
                                                      setTargetUserForDeletion(item);
                                                      setConfirmDeleteUsername('');
                                                    }}
                                                  >
                                                    Hapus
                                                  </Button>
                                                )}
                                              </>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              {/* Paginasi Internal Kelompok */}
                              {expandedInfo.totalPages > 1 && (
                                <div className="flex justify-between items-center px-3 py-2 text-xs text-muted border-t border-border">
                                  <div>
                                    Halaman <strong>{expandedInfo.page}</strong> dari <strong>{expandedInfo.totalPages}</strong> (Total {expandedInfo.total} anggota)
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="outline"
                                      className="btn-xs"
                                      disabled={expandedInfo.page <= 1 || expandedInfo.loading}
                                      onClick={() => handleToggleGroup(group.group_key, group.is_direct, expandedInfo.page - 1)}
                                    >
                                      &laquo; Sebelumnya
                                    </Button>
                                    <Button
                                      variant="outline"
                                      className="btn-xs"
                                      disabled={expandedInfo.page >= expandedInfo.totalPages || expandedInfo.loading}
                                      onClick={() => handleToggleGroup(group.group_key, group.is_direct, expandedInfo.page + 1)}
                                    >
                                      Berikutnya &raquo;
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
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
          <div className="table-header-bar flex flex-wrap justify-between items-center gap-4">
            <div>
              <h3>Manajemen Akun Administrator ({admins.length})</h3>
              <p className="text-xs text-muted mt-1">
                Kelola akun Administrator operasional untuk mengunggah video, memantau katalog, dan mereset perangkat member.
              </p>
            </div>
            <div>
              <Button
                variant="primary"
                className="btn-sm"
                onClick={() => setShowCreateAdminModal(true)}
              >
                + Tambah Admin Baru
              </Button>
            </div>
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
                          <Button
                            variant="outline"
                            className="btn-xs"
                            onClick={() => {
                              setTargetUserForUsername(item);
                              setNewTargetUsername(item.username);
                            }}
                          >
                            Ganti Username
                          </Button>
                          <Button
                            variant="outline"
                            className="btn-xs"
                            onClick={() => {
                              setTargetUserForPasswordReset(item);
                              setNewTargetPassword('');
                            }}
                          >
                            Reset Password
                          </Button>
                          {item.id !== user?.id && (
                            <Button
                              variant="danger"
                              className="btn-xs"
                              onClick={() => {
                                setTargetUserForDeletion(item);
                                setConfirmDeleteUsername('');
                              }}
                            >
                              Hapus
                            </Button>
                          )}
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
            <label className="form-label">Rak / Kategori Video</label>
            <select
              className="form-input"
              value={uploadRackId}
              onChange={(e) => setUploadRackId(e.target.value)}
              disabled={uploading}
            >
              {racks.map((rack) => (
                <option key={rack.id} value={rack.id}>
                  {rack.name} {rack.is_default ? '(Bawaan Sistem)' : ''}
                </option>
              ))}
            </select>
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
            <label className="form-label">Rak / Kategori Video</label>
            <select
              className="form-input"
              value={editRackId}
              onChange={(e) => setEditRackId(e.target.value)}
              disabled={savingEdit}
            >
              {racks.map((rack) => (
                <option key={rack.id} value={rack.id}>
                  {rack.name} {rack.is_default ? '(Bawaan Sistem)' : ''}
                </option>
              ))}
            </select>
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

      {/* MODAL: PRATINJAU VIDEO */}
      <VideoPlayerModal
        isOpen={!!previewVideo}
        onClose={() => setPreviewVideo(null)}
        video={previewVideo}
      />

      {/* MODAL: BUAT KODE AKTIVASI */}
      <Modal
        isOpen={showCreateCodeModal}
        onClose={() => setShowCreateCodeModal(false)}
        title="Buat Kode Aktivasi Member (Tambah Member Baru)"
      >
        <form onSubmit={handleCreateCodeSubmit} className="space-y-4">
          <div className="alert-box alert-info">
            <p className="text-xs">
              Kode aktivasi sekali pakai akan dibuat. Berikan kode ini secara pribadi kepada calon Member untuk melakukan pendaftaran mandiri melalui halaman <code>/activate</code>.
            </p>
          </div>

          <Input
            label="Catatan Calon Member / Penerima"
            id="code-note"
            name="note"
            type="text"
            placeholder="Contoh: Calon Member Affiliate (WhatsApp 0812...)"
            value={newCodeNote}
            onChange={(e) => setNewCodeNote(e.target.value)}
            helperText="Catatan internal admin untuk mengidentifikasi calon Member penerima kode ini."
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

      {/* MODAL: UBAH USERNAME PENGGUNA (SUPER ADMIN) */}
      <Modal
        isOpen={!!targetUserForUsername}
        onClose={() => setTargetUserForUsername(null)}
        title={`Ubah Username Pengguna: ${targetUserForUsername?.username}`}
      >
        <form onSubmit={handleUpdateUsernameSubmit} className="space-y-4">
          <Input
            label="Username Baru"
            id="target-new-username"
            name="new_username"
            type="text"
            placeholder="Username baru"
            value={newTargetUsername}
            onChange={(e) => setNewTargetUsername(e.target.value)}
            required
            helperText="Alfanumerik atau underscore (3-30 karakter). Perubahan akan dicatat dalam audit log."
          />
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setTargetUserForUsername(null)}
              disabled={updatingUsername}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={updatingUsername}
              loadingText="Menyimpan..."
            >
              Simpan Username Baru
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: RESET PASSWORD PENGGUNA (SUPER ADMIN) */}
      <Modal
        isOpen={!!targetUserForPasswordReset}
        onClose={() => setTargetUserForPasswordReset(null)}
        title={`Reset Password Pengguna: ${targetUserForPasswordReset?.username}`}
      >
        <form onSubmit={handleResetUserPasswordSubmit} className="space-y-4">
          <div className="alert-box alert-warning">
            <p className="text-xs">
              Mereset password akan <strong>mencabut seluruh sesi login aktif</strong> pengguna ini di semua perangkat untuk memverifikasi ulang identitas.
            </p>
          </div>
          <Input
            label="Password Baru Pengguna"
            id="target-new-password"
            name="new_password"
            type="password"
            placeholder="Minimal 8 karakter"
            value={newTargetPassword}
            onChange={(e) => setNewTargetPassword(e.target.value)}
            required
            helperText="Minimal 8 karakter dan maksimal 64 karakter."
          />
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setTargetUserForPasswordReset(null)}
              disabled={resettingUserPassword}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="danger"
              loading={resettingUserPassword}
              loadingText="Mereset Password..."
            >
              Reset Password & Cabut Sesi
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: NONAKTIFKAN / AKTIFKAN MEMBER (FITUR 8) */}
      <Modal
        isOpen={!!targetUserForStatus}
        onClose={() => {
          setTargetUserForStatus(null);
          setStatusReason('');
        }}
        title={
          targetUserForStatus?.action === 'suspend'
            ? `Nonaktifkan Member: ${targetUserForStatus?.user.username}`
            : `Aktifkan Kembali Member: ${targetUserForStatus?.user.username}`
        }
      >
        <form onSubmit={handleUpdateUserStatusSubmit} className="space-y-4">
          {targetUserForStatus?.action === 'suspend' ? (
            <>
              <div className="alert-box alert-warning">
                <p className="text-xs font-semibold">Perhatian Penonaktifan Akun:</p>
                <p className="text-xs mt-1">
                  Akun Member <strong>{targetUserForStatus.user.username}</strong> akan dinonaktifkan. Seluruh sesi aktif dan ikatan perangkat akan langsung dicabut seketika sehingga member tidak dapat mengakses gudang video hingga diaktifkan kembali.
                </p>
              </div>
              <Input
                label="Alasan Penonaktifan (Opsional)"
                id="status-reason"
                name="reason"
                type="text"
                placeholder="Contoh: Permintaan member / melanggar ketentuan lisensi"
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                helperText="Alasan akan dicatat pada audit log administratif."
              />
              <div className="modal-actions-cluster mt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setTargetUserForStatus(null);
                    setStatusReason('');
                  }}
                  disabled={updatingUserStatus}
                >
                  Batal
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  loading={updatingUserStatus}
                  loadingText="Menonaktifkan..."
                >
                  Nonaktifkan Member
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="alert-box alert-info">
                <p className="text-xs font-semibold">Konfirmasi Pengaktifan Kembali:</p>
                <p className="text-xs mt-1">
                  Akun Member <strong>{targetUserForStatus?.user.username}</strong> akan diaktifkan kembali. Member dapat kembali masuk menggunakan kredensial akunnya.
                </p>
              </div>
              <div className="modal-actions-cluster mt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setTargetUserForStatus(null);
                    setStatusReason('');
                  }}
                  disabled={updatingUserStatus}
                >
                  Batal
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={updatingUserStatus}
                  loadingText="Mengaktifkan..."
                >
                  Aktifkan Member
                </Button>
              </div>
            </>
          )}
        </form>
      </Modal>

      {/* MODAL: HAPUS AKUN (FITUR 8) */}
      <Modal
        isOpen={!!targetUserForDeletion}
        onClose={() => {
          setTargetUserForDeletion(null);
          setConfirmDeleteUsername('');
        }}
        title={`Hapus Akun Pengguna: ${targetUserForDeletion?.username}`}
      >
        <form onSubmit={handleDeleteAccountSubmit} className="space-y-4">
          <div className="alert-box alert-danger">
            <p className="text-xs font-semibold">Tindakan ini tidak dapat dibatalkan!</p>
            <p className="text-xs mt-1">
              Akun <strong>{targetUserForDeletion?.username}</strong> ({targetUserForDeletion?.role === 'admin' ? 'Administrator' : 'Member'}) akan dihapus permanen dari sistem.
            </p>
            <p className="text-xs mt-1">
              Seluruh file video katalog, tautan produk Shopee, dan catatan riwayat audit log keamanan tetap tersimpan aman dan tidak akan hilang.
            </p>
          </div>
          <Input
            label={`Ketik "${targetUserForDeletion?.username}" untuk mengonfirmasi`}
            id="confirm-delete-username"
            name="confirm_username"
            type="text"
            placeholder={targetUserForDeletion?.username || ''}
            value={confirmDeleteUsername}
            onChange={(e) => setConfirmDeleteUsername(e.target.value)}
            required
            autoComplete="off"
          />
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setTargetUserForDeletion(null);
                setConfirmDeleteUsername('');
              }}
              disabled={deletingAccount}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={confirmDeleteUsername.trim().toLowerCase() !== targetUserForDeletion?.username.toLowerCase() || deletingAccount}
              loading={deletingAccount}
              loadingText="Menghapus..."
            >
              Hapus Akun Permanen
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: BUKTI KOMISI MEMBER (FITUR 9) */}
      <Modal
        isOpen={!!selectedMemberForProof}
        onClose={() => {
          if (!deletingMemberProof) {
            setSelectedMemberForProof(null);
            setMemberCommissionProof(null);
            setConfirmDeleteMemberProof(false);
            setMemberProofError(null);
          }
        }}
        title={`Bukti Komisi Mingguan: ${selectedMemberForProof?.username || ''}`}
        maxWidth="680px"
      >
        <div className="space-y-4">
          {memberProofError && (
            <Alert type="danger" onClose={() => setMemberProofError(null)}>
              {memberProofError}
            </Alert>
          )}

          {loadingMemberProof ? (
            <div className="text-center py-8 text-muted text-sm">
              Memuat data bukti komisi...
            </div>
          ) : memberCommissionProof ? (
            <div className="space-y-4">
              <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[60vh] flex items-center justify-center bg-slate-900">
                <img
                  src={commissionApi.getProofFileUrl(memberCommissionProof.id)}
                  alt="Bukti Komisi Member"
                  className="max-h-[55vh] max-w-full object-contain"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).alt = 'Gagal memuat gambar bukti komisi';
                  }}
                />
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded p-3 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted">Nama Berkas:</span>
                  <span className="font-mono font-medium">{memberCommissionProof.original_filename}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Ukuran:</span>
                  <span>{(memberCommissionProof.file_size / 1024).toFixed(1)} KB</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Tipe Konten:</span>
                  <span>{memberCommissionProof.content_type}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Waktu Upload Terakhir:</span>
                  <span>{formatDate(memberCommissionProof.updated_at)}</span>
                </div>
              </div>

              {confirmDeleteMemberProof ? (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-800 space-y-3">
                  <p className="font-semibold">Konfirmasi Penghapusan Bukti Komisi</p>
                  <p>
                    Apakah Anda yakin ingin menghapus bukti komisi aktif milik Member <strong>{selectedMemberForProof?.username}</strong>? Berkas akan dihapus permanen dari penyimpanan R2.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="btn-xs"
                      onClick={() => setConfirmDeleteMemberProof(false)}
                      disabled={deletingMemberProof}
                    >
                      Batal
                    </Button>
                    <Button
                      variant="danger"
                      className="btn-xs"
                      onClick={handleDeleteMemberProofSubmit}
                      loading={deletingMemberProof}
                      loadingText="Menghapus..."
                    >
                      Ya, Hapus Bukti
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-between items-center pt-2">
                  <Button
                    variant="danger"
                    className="btn-sm"
                    onClick={() => setConfirmDeleteMemberProof(true)}
                  >
                    🗑️ Hapus Bukti Aktif
                  </Button>
                  <Button
                    variant="outline"
                    className="btn-sm"
                    onClick={() => setSelectedMemberForProof(null)}
                  >
                    Tutup
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="py-6 text-center space-y-2">
              <div className="text-3xl">📭</div>
              <p className="text-sm font-semibold text-slate-700">Belum Memiliki Bukti Komisi Aktif</p>
              <p className="text-xs text-muted">
                Member <strong>{selectedMemberForProof?.username}</strong> belum mengunggah screenshot pembagian komisi mingguan.
              </p>
              <div className="pt-4">
                <Button variant="outline" className="btn-sm" onClick={() => setSelectedMemberForProof(null)}>
                  Tutup
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* MODAL: BUAT RAK BARU */}
      <Modal
        isOpen={showCreateRackModal}
        onClose={() => setShowCreateRackModal(false)}
        title="Tambah Rak Video Baru"
      >
        <form onSubmit={handleCreateRackSubmit} className="space-y-4">
          <Input
            label="Nama Rak"
            id="rack-name"
            name="name"
            type="text"
            placeholder="Contoh: Elektronik & Gadget"
            value={newRackName}
            onChange={(e) => setNewRackName(e.target.value)}
            required
            helperText="1-50 karakter."
          />
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCreateRackModal(false)}
              disabled={creatingRack}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={creatingRack}
              loadingText="Membuat Rak..."
            >
              Buat Rak Baru
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: EDIT RAK */}
      <Modal
        isOpen={!!editingRack}
        onClose={() => setEditingRack(null)}
        title={`Ubah Rak: ${editingRack?.name}`}
      >
        <form onSubmit={handleUpdateRackSubmit} className="space-y-4">
          <Input
            label="Nama Rak"
            id="edit-rack-name"
            name="name"
            type="text"
            value={editRackName}
            onChange={(e) => setEditRackName(e.target.value)}
            required
            helperText="1-50 karakter."
          />
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingRack(null)}
              disabled={savingRack}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={savingRack}
              loadingText="Menyimpan..."
            >
              Simpan Perubahan
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL: HAPUS RAK */}
      <Modal
        isOpen={!!deletingRack}
        onClose={() => setDeletingRack(null)}
        title="Konfirmasi Hapus Rak Video"
      >
        <div className="space-y-4">
          <p>
            Apakah Anda yakin ingin menghapus rak <strong>"{deletingRack?.name}"</strong>?
          </p>
          <div className="alert-box alert-warning">
            <p className="text-xs font-semibold">Video Anda Aman</p>
            <p className="text-xs mt-1">
              Rak ini saat ini berisi <strong>{deletingRack?.video_count ?? 0} video</strong>. Menghapus rak ini <strong>TIDAK AKAN</strong> menghapus videonya. Seluruh video akan otomatis dialihkan ke rak bawaan <strong>General</strong>.
            </p>
          </div>
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeletingRack(null)}
              disabled={deletingRackState}
            >
              Batal
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDeleteRackSubmit}
              loading={deletingRackState}
              loadingText="Menghapus Rak..."
            >
              Ya, Hapus Rak & Pindahkan Video
            </Button>
          </div>
        </div>
      </Modal>

      {/* MODAL: PINDAH RAK VIDEO */}
      <Modal
        isOpen={!!movingVideo}
        onClose={() => setMovingVideo(null)}
        title={`Pindahkan Rak Video: ${movingVideo?.title}`}
      >
        <form onSubmit={handleMoveVideoRackSubmit} className="space-y-4">
          <p className="text-sm text-muted">
            Pilih rak tujuan untuk video <strong>"{movingVideo?.title}"</strong>:
          </p>
          <div className="form-group">
            <label className="form-label">Rak Tujuan</label>
            <select
              className="form-input"
              value={targetRackId}
              onChange={(e) => setTargetRackId(e.target.value)}
              required
            >
              <option value="">-- Pilih Rak Tujuan --</option>
              {racks.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} {r.is_default ? '(Bawaan Sistem)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="modal-actions-cluster mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setMovingVideo(null)}
              disabled={movingVideoState}
            >
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!targetRackId || targetRackId === movingVideo?.rack_id || movingVideoState}
              loading={movingVideoState}
              loadingText="Memindahkan..."
            >
              Pindahkan Video
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
