/**
 * frontend/src/api/client.ts
 * Klien HTTP terpusat untuk berinteraksi dengan API backend Cloudflare Worker.
 *
 * Kebijakan Keamanan:
 * 1. Menggunakan `credentials: 'same-origin'` untuk seluruh request, sehingga
 *    cookie HttpOnly (__Host-gvs_device dan __Host-gvs_session) dikelola otomatis oleh browser.
 * 2. Tidak ada token yang disimpan di localStorage, sessionStorage, atau IndexedDB.
 * 3. Menangani penolakan perangkat (DEVICE_NOT_AUTHORIZED) dan otorisasi dengan tipe terstruktur.
 */

import {
  MeResponse,
  LoginPayload,
  ActivatePayload,
  ResetDevicePayload,
  AuthSuccessResponse,
  ListActivationCodesResponse,
  CreateActivationCodePayload,
  CreateActivationCodeResponse,
  ListUsersOptions,
  ListUsersResponse,
  ListUserGroupsResponse,
  IssueResetCodePayload,
  IssueResetCodeResponse,
  ListAuditLogsResponse,
  ApiErrorResponse,
  VideoItem,
  AdminVideoItem,
  ListVideosResponse,
  ListAdminVideosResponse,
  UploadVideoPayload,
  UpdateVideoPayload,
  CreateAdminPayload,
  CreateAdminResponse,
  UpdateAdminStatusPayload,
  UpdateAdminStatusResponse,
  ListAdminsResponse,
  CreateMemberPayload,
  CreateMemberResponse,
  UpdateMemberStatusPayload,
  UpdateMemberStatusResponse,
  DeleteMemberPayload,
  DeleteMemberResponse,
  ListShopeeRequestsResponse,
  ShopeeAccountRequest,
  SubmitShopeeRequestPayload,
  ReviewShopeeRequestPayload,
  User,
  RackItem,
  ListRacksResponse,
  CreateRackPayload,
  UpdateRackPayload,
  ChangePasswordPayload,
  ChangeUsernamePayload,
  ResetUserPasswordPayload,
  AdminUpdateUsernamePayload,
  DeleteAccountPayload,
  MoveVideoRackPayload,
  CommissionProofResponse
} from './types';

export class ApiClientError extends Error {
  public status: number;
  public errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});

  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // Wajib same-origin untuk keamanan cookie HttpOnly dan pencegahan CSRF
  const config: RequestInit = {
    ...options,
    headers,
    credentials: 'same-origin'
  };

  let response: Response;
  try {
    response = await fetch(endpoint, config);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Koneksi jaringan terputus';
    throw new ApiClientError(0, 'NETWORK_ERROR', `Gagal menghubungi server: ${errorMsg}`);
  }

  // Tangani respons kosong
  const contentType = response.headers.get('Content-Type') || '';
  const isJson = contentType.includes('application/json');

  if (!response.ok) {
    if (isJson) {
      try {
        const errorData = (await response.json()) as ApiErrorResponse;
        throw new ApiClientError(
          response.status,
          errorData.error || 'SERVER_ERROR',
          errorData.message || `Permintaan gagal dengan status ${response.status}`
        );
      } catch (e) {
        if (e instanceof ApiClientError) throw e;
      }
    }
    throw new ApiClientError(
      response.status,
      'HTTP_ERROR',
      `Permintaan gagal dengan status HTTP ${response.status}`
    );
  }

  if (isJson) {
    return (await response.json()) as T;
  }

  return (await response.text()) as unknown as T;
}

export const authApi = {
  /**
   * Mengambil data profil dan sesi pengguna yang sedang aktif (GET /api/auth/me)
   */
  async getMe(): Promise<MeResponse> {
    return request<MeResponse>('/api/auth/me', { method: 'GET' });
  },

  /**
   * Login dengan username dan password (POST /api/auth/login)
   * Memerlukan browser yang telah memiliki cookie perangkat terikat.
   */
  async login(payload: LoginPayload): Promise<AuthSuccessResponse> {
    return request<AuthSuccessResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Aktivasi akun pertama kali dengan kode aktivasi sekali pakai (POST /api/auth/activate)
   */
  async activate(payload: ActivatePayload): Promise<AuthSuccessResponse> {
    return request<AuthSuccessResponse>('/api/auth/activate', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Reset ikatan perangkat menggunakan kode reset yang diterbitkan admin (POST /api/auth/reset-device)
   */
  async resetDevice(payload: ResetDevicePayload): Promise<AuthSuccessResponse> {
    return request<AuthSuccessResponse>('/api/auth/reset-device', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Logout dan mencabut sesi saat ini (POST /api/auth/logout)
   */
  async logout(): Promise<{ status: string; message: string }> {
    return request<{ status: string; message: string }>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({})
    });
  },

  /**
   * Mengubah kata sandi mandiri (POST /api/auth/change-password)
   */
  async changePassword(payload: ChangePasswordPayload): Promise<{ status: string; message: string }> {
    return request<{ status: string; message: string }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Mengubah nama pengguna mandiri (POST /api/auth/change-username)
   */
  async changeUsername(payload: ChangeUsernamePayload): Promise<{ status: string; message: string; user: User }> {
    return request<{ status: string; message: string; user: User }>('/api/auth/change-username', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
};

export interface ListVideosOptions {
  rackId?: string;
  cursor?: string;
  limit?: number;
  q?: string;
}

export interface ListAdminVideosOptions {
  rackId?: string;
  status?: 'active' | 'inactive';
  cursor?: string;
  limit?: number;
  q?: string;
}

export const adminApi = {
  /**
   * Mengambil daftar kode aktivasi (GET /api/admin/activation-codes)
   */
  async listActivationCodes(): Promise<ListActivationCodesResponse> {
    return request<ListActivationCodesResponse>('/api/admin/activation-codes', {
      method: 'GET'
    });
  },

  /**
   * Membuat kode aktivasi sekali pakai baru (POST /api/admin/activation-codes)
   */
  async createActivationCode(payload: CreateActivationCodePayload): Promise<CreateActivationCodeResponse> {
    return request<CreateActivationCodeResponse>('/api/admin/activation-codes', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Mengambil daftar pengguna terdaftar (GET /api/admin/users)
   * Mendukung server-side pagination, filter, dan pencarian (opts: q, status, role, registration_path, inviter, page, limit)
   */
  async listUsers(opts?: ListUsersOptions): Promise<ListUsersResponse> {
    const params = new URLSearchParams();
    if (opts) {
      if (opts.q && opts.q.trim()) params.set('q', opts.q.trim());
      if (opts.status && opts.status !== 'all') params.set('status', opts.status);
      if (opts.role && opts.role !== 'all') params.set('role', opts.role);
      if (opts.registration_path && opts.registration_path !== 'all') params.set('registration_path', opts.registration_path);
      if (opts.inviter && opts.inviter !== 'all') params.set('inviter', opts.inviter);
      if (opts.page) params.set('page', String(opts.page));
      if (opts.limit) params.set('limit', String(opts.limit));
    }
    const query = params.toString();
    const url = query ? `/api/admin/users?${query}` : '/api/admin/users';
    return request<ListUsersResponse>(url, {
      method: 'GET'
    });
  },

  /**
   * Mengambil ringkasan pengelompokan anggota berdasarkan pengundang (GET /api/admin/users/groups)
   */
  async listUserGroups(opts?: Omit<ListUsersOptions, 'page' | 'limit'>): Promise<ListUserGroupsResponse> {
    const params = new URLSearchParams();
    if (opts) {
      if (opts.q && opts.q.trim()) params.set('q', opts.q.trim());
      if (opts.status && opts.status !== 'all') params.set('status', opts.status);
      if (opts.role && opts.role !== 'all') params.set('role', opts.role);
      if (opts.registration_path && opts.registration_path !== 'all') params.set('registration_path', opts.registration_path);
      if (opts.inviter && opts.inviter !== 'all') params.set('inviter', opts.inviter);
    }
    const query = params.toString();
    const url = query ? `/api/admin/users/groups?${query}` : '/api/admin/users/groups';
    return request<ListUserGroupsResponse>(url, {
      method: 'GET'
    });
  },

  /**
   * Menerbitkan kode reset perangkat untuk pengguna tertentu (POST /api/admin/users/:id/reset-code)
   */
  async issueResetCode(userId: string, payload: IssueResetCodePayload): Promise<IssueResetCodeResponse> {
    return request<IssueResetCodeResponse>(`/api/admin/users/${encodeURIComponent(userId)}/reset-code`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Mengubah status Member (aktif/nonaktif) oleh Admin atau Super Admin (PATCH /api/admin/users/:id/status)
   */
  async updateUserStatus(
    userId: string,
    payload: UpdateMemberStatusPayload
  ): Promise<UpdateMemberStatusResponse> {
    return request<UpdateMemberStatusResponse>(
      `/api/admin/users/${encodeURIComponent(userId)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );
  },

  /**
   * Menghapus akun Member secara aman dengan konfirmasi username (DELETE /api/admin/users/:id)
   */
  async deleteUser(
    userId: string,
    payload: DeleteMemberPayload
  ): Promise<DeleteMemberResponse> {
    return request<DeleteMemberResponse>(
      `/api/admin/users/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        body: JSON.stringify(payload)
      }
    );
  },

  /**
   * Mengambil rekaman log audit keamanan (GET /api/admin/audit-logs)
   */
  async listAuditLogs(): Promise<ListAuditLogsResponse> {
    return request<ListAuditLogsResponse>('/api/admin/audit-logs', {
      method: 'GET'
    });
  },

  /**
   * Mengambil daftar seluruh video (aktif dan nonaktif) untuk admin (GET /api/admin/videos)
   */
  async listVideos(optsOrRackId?: string | ListAdminVideosOptions): Promise<ListAdminVideosResponse> {
    const params = new URLSearchParams();
    if (typeof optsOrRackId === 'string') {
      if (optsOrRackId && optsOrRackId !== 'all') params.set('rack_id', optsOrRackId);
    } else if (optsOrRackId && typeof optsOrRackId === 'object') {
      if (optsOrRackId.rackId && optsOrRackId.rackId !== 'all') params.set('rack_id', optsOrRackId.rackId);
      if (optsOrRackId.status) params.set('status', optsOrRackId.status);
      if (optsOrRackId.cursor) params.set('cursor', optsOrRackId.cursor);
      if (optsOrRackId.limit) params.set('limit', String(optsOrRackId.limit));
      if (optsOrRackId.q) params.set('q', optsOrRackId.q);
    }
    const q = params.toString() ? `?${params.toString()}` : '';
    return request<ListAdminVideosResponse>(`/api/admin/videos${q}`, {
      method: 'GET'
    });
  },

  /**
   * Mengambil daftar rak video untuk admin (GET /api/admin/racks)
   */
  async listRacks(): Promise<ListRacksResponse> {
    return request<ListRacksResponse>('/api/admin/racks', {
      method: 'GET'
    });
  },

  /**
   * Membuat rak video baru (POST /api/admin/racks)
   */
  async createRack(payload: CreateRackPayload): Promise<{ status: string; message: string; rack: RackItem }> {
    return request<{ status: string; message: string; rack: RackItem }>('/api/admin/racks', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Mengubah nama rak (PATCH /api/admin/racks/:id)
   */
  async updateRack(id: string, payload: UpdateRackPayload): Promise<{ status: string; message: string; rack: RackItem }> {
    return request<{ status: string; message: string; rack: RackItem }>(`/api/admin/racks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Menghapus rak video (DELETE /api/admin/racks/:id)
   */
  async deleteRack(id: string): Promise<{ status: string; message: string; moved_video_count: number }> {
    return request<{ status: string; message: string; moved_video_count: number }>(`/api/admin/racks/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  },

  /**
   * Memindahkan video ke rak tujuan (PATCH /api/admin/videos/:id/rack)
   */
  async moveVideoRack(videoId: string, payload: MoveVideoRackPayload): Promise<{ status: string; message: string; video_id: string; rack_id: string; rack_name: string }> {
    return request<{ status: string; message: string; video_id: string; rack_id: string; rack_name: string }>(
      `/api/admin/videos/${encodeURIComponent(videoId)}/rack`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );
  },

  /**
   * Mengunggah file video baru beserta metadata (POST /api/admin/videos)
   */
  async uploadVideo(payload: UploadVideoPayload): Promise<{ status: string; message: string; video: VideoItem }> {
    const formData = new FormData();
    formData.append('file', payload.file);
    formData.append('title', payload.title);
    formData.append('product_name', payload.product_name);
    formData.append('product_url', payload.product_url);
    if (payload.description) {
      formData.append('description', payload.description);
    }
    if (payload.status) {
      formData.append('status', payload.status);
    }
    if (payload.rack_id) {
      formData.append('rack_id', payload.rack_id);
    }
    return request<{ status: string; message: string; video: VideoItem }>('/api/admin/videos', {
      method: 'POST',
      body: formData
    });
  },

  /**
   * Memperbarui metadata video (PUT /api/admin/videos/:id)
   */
  async updateVideo(
    id: string,
    payload: UpdateVideoPayload
  ): Promise<{ status: string; message: string; video: AdminVideoItem }> {
    return request<{ status: string; message: string; video: AdminVideoItem }>(
      `/api/admin/videos/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload)
      }
    );
  },

  /**
   * Menghapus file video dari R2 dan metadata dari D1 (DELETE /api/admin/videos/:id)
   */
  async deleteVideo(id: string): Promise<{ status: string; message: string }> {
    return request<{ status: string; message: string }>(`/api/admin/videos/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }
};

export const superAdminApi = {
  /**
   * Mengambil daftar seluruh administrator (GET /api/super-admin/admins)
   */
  async listAdmins(): Promise<ListAdminsResponse> {
    return request<ListAdminsResponse>('/api/super-admin/admins', {
      method: 'GET'
    });
  },

  /**
   * Membuat akun Administrator baru (POST /api/super-admin/admins)
   */
  async createAdmin(payload: CreateAdminPayload): Promise<CreateAdminResponse> {
    return request<CreateAdminResponse>('/api/super-admin/admins', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Mengubah status Administrator aktif/nonaktif (PATCH /api/super-admin/admins/:id/status)
   */
  async updateAdminStatus(
    id: string,
    payload: UpdateAdminStatusPayload
  ): Promise<UpdateAdminStatusResponse> {
    return request<UpdateAdminStatusResponse>(
      `/api/super-admin/admins/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );
  },

  /**
   * Membuat akun Member langsung tanpa kode aktivasi (POST /api/super-admin/members)
   */
  async createMember(payload: CreateMemberPayload): Promise<CreateMemberResponse> {
    return request<CreateMemberResponse>('/api/super-admin/members', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Menghapus akun Admin atau Member secara aman (DELETE /api/super-admin/users/:id)
   */
  async deleteAccount(userId: string, payload: DeleteAccountPayload): Promise<{ status: string; message: string }> {
    return request<{ status: string; message: string }>(`/api/super-admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Reset kata sandi pengguna oleh Super Admin (POST /api/super-admin/users/:id/reset-password)
   */
  async resetUserPassword(userId: string, payload: ResetUserPasswordPayload): Promise<{ status: string; message: string }> {
    return request<{ status: string; message: string }>(`/api/super-admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Memperbarui username pengguna oleh Super Admin (PATCH /api/super-admin/users/:id/username)
   */
  async updateUsername(userId: string, payload: AdminUpdateUsernamePayload): Promise<{ status: string; message: string; user: { id: string; username: string; role: string } }> {
    return request<{ status: string; message: string; user: { id: string; username: string; role: string } }>(
      `/api/super-admin/users/${encodeURIComponent(userId)}/username`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );
  }
};

export const videoApi = {
  /**
   * Mengambil daftar katalog video aktif untuk member (GET /api/videos)
   */
  async listVideos(optsOrRackId?: string | ListVideosOptions): Promise<ListVideosResponse> {
    const params = new URLSearchParams();
    if (typeof optsOrRackId === 'string') {
      if (optsOrRackId && optsOrRackId !== 'all') params.set('rack_id', optsOrRackId);
    } else if (optsOrRackId && typeof optsOrRackId === 'object') {
      if (optsOrRackId.rackId && optsOrRackId.rackId !== 'all') params.set('rack_id', optsOrRackId.rackId);
      if (optsOrRackId.cursor) params.set('cursor', optsOrRackId.cursor);
      if (optsOrRackId.limit) params.set('limit', String(optsOrRackId.limit));
      if (optsOrRackId.q) params.set('q', optsOrRackId.q);
    }
    const q = params.toString() ? `?${params.toString()}` : '';
    return request<ListVideosResponse>(`/api/videos${q}`, {
      method: 'GET'
    });
  },

  /**
   * Mengambil daftar rak video untuk member (GET /api/racks)
   */
  async listRacks(): Promise<ListRacksResponse> {
    return request<ListRacksResponse>('/api/racks', {
      method: 'GET'
    });
  },

  /**
   * Mengambil detail video aktif (GET /api/videos/:id)
   */
  async getVideo(id: string): Promise<{ status: string; video: VideoItem }> {
    return request<{ status: string; video: VideoItem }>(`/api/videos/${encodeURIComponent(id)}`, {
      method: 'GET'
    });
  },

  /**
   * Mendapatkan endpoint streaming unduhan video
   */
  getDownloadUrl(id: string): string {
    return `/api/videos/${encodeURIComponent(id)}/download`;
  },

  /**
   * Mendapatkan endpoint streaming pemutaran/pratinjau inline video (mendukung HTTP Range)
   */
  getStreamUrl(id: string): string {
    return `/api/videos/${encodeURIComponent(id)}/stream`;
  },

  /**
   * Alias untuk endpoint pratinjau video
   */
  getPreviewUrl(id: string): string {
    return `/api/videos/${encodeURIComponent(id)}/stream`;
  }
};

export const shopeeApi = {
  /**
   * Pendaftaran tautan Shopee awal bagi member lama / dibuat langsung (POST /api/member/shopee-account/initial)
   */
  async setInitialLink(shopeeLink: string): Promise<{ status: string; message: string; shopee_link: string }> {
    return request<{ status: string; message: string; shopee_link: string }>('/api/member/shopee-account/initial', {
      method: 'POST',
      body: JSON.stringify({ shopee_link: shopeeLink })
    });
  },

  /**
   * Pengajuan perubahan tautan akun Shopee oleh member (POST /api/member/shopee-account/requests)
   */
  async submitRequest(payload: SubmitShopeeRequestPayload): Promise<{ status: string; message: string; data: ShopeeAccountRequest }> {
    return request<{ status: string; message: string; data: ShopeeAccountRequest }>('/api/member/shopee-account/requests', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * Mengambil riwayat permohonan perubahan akun Shopee milik member login (GET /api/member/shopee-account/requests)
   */
  async listMemberRequests(): Promise<ListShopeeRequestsResponse> {
    return request<ListShopeeRequestsResponse>('/api/member/shopee-account/requests', {
      method: 'GET'
    });
  },

  /**
   * Mengambil daftar permohonan perubahan akun Shopee untuk ditinjau admin (GET /api/admin/shopee-requests)
   */
  async listAdminRequests(statusFilter?: string): Promise<ListShopeeRequestsResponse> {
    const q = statusFilter && statusFilter !== 'all' ? `?status=${encodeURIComponent(statusFilter)}` : '';
    return request<ListShopeeRequestsResponse>(`/api/admin/shopee-requests${q}`, {
      method: 'GET'
    });
  },

  /**
   * Menyetujui atau menolak permohonan perubahan akun Shopee (POST /api/admin/shopee-requests/:id/review)
   */
  async reviewRequest(id: string, payload: ReviewShopeeRequestPayload): Promise<{ status: string; message: string; data?: any }> {
    return request<{ status: string; message: string; data?: any }>(`/api/admin/shopee-requests/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
};

/**
 * Layanan API Bukti Komisi Mingguan (Fitur 9)
 */
export const commissionApi = {
  /**
   * Mengambil metadata bukti komisi aktif milik member yang login (GET /api/member/commission-proof)
   */
  async getMemberProof(): Promise<CommissionProofResponse> {
    return request<CommissionProofResponse>('/api/member/commission-proof', {
      method: 'GET'
    });
  },

  /**
   * Mengunggah atau mengganti bukti komisi aktif milik member (POST /api/member/commission-proof)
   */
  async uploadMemberProof(file: File): Promise<CommissionProofResponse> {
    const formData = new FormData();
    formData.append('file', file);
    return request<CommissionProofResponse>('/api/member/commission-proof', {
      method: 'POST',
      body: formData
    });
  },

  /**
   * Mengambil metadata bukti komisi aktif milik member tertentu oleh Admin (GET /api/admin/users/:id/commission-proof)
   */
  async getAdminMemberProof(userId: string): Promise<CommissionProofResponse> {
    return request<CommissionProofResponse>(`/api/admin/users/${encodeURIComponent(userId)}/commission-proof`, {
      method: 'GET'
    });
  },

  /**
   * Menghapus bukti komisi aktif milik member oleh Admin (DELETE /api/admin/users/:id/commission-proof)
   */
  async deleteAdminMemberProof(userId: string): Promise<{ status: string; message: string }> {
    return request<{ status: string; message: string }>(`/api/admin/users/${encodeURIComponent(userId)}/commission-proof`, {
      method: 'DELETE'
    });
  },

  /**
   * Menghasilkan URL pratinjau/streaming file bukti komisi
   */
  getProofFileUrl(proofId: string): string {
    return `/api/commission-proofs/${encodeURIComponent(proofId)}/file`;
  }
};
