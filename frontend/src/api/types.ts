/**
 * frontend/src/api/types.ts
 * Tipe data untuk permintaan dan respons API Gudang Video Shopee
 */

export type UserRole = 'super_admin' | 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  role: UserRole;
  status: 'active' | 'suspended';
  shopee_link?: string | null;
}

export interface DeviceInfo {
  id: string;
  name: string;
  boundAt: string;
  lastSeenAt: string;
}

export interface MeResponse {
  status: 'ok';
  user: User;
  device: DeviceInfo;
}

export interface LoginPayload {
  username: string;
  password: string;
}

export interface ActivatePayload {
  activation_code: string;
  username: string;
  password: string;
  shopee_link: string;
  device_name?: string;
}

export interface ResetDevicePayload {
  username: string;
  password: string;
  reset_code: string;
  device_name?: string;
}

export interface AuthSuccessResponse {
  status: 'ok';
  message: string;
  user?: {
    username: string;
    role: UserRole;
  };
}

export interface ActivationCodeItem {
  id: string;
  status: 'active' | 'used' | 'expired';
  used_count: number;
  used_by_user_id: string | null;
  note: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  used_by_username: string | null;
}

export interface ListActivationCodesResponse {
  status: 'ok';
  codes: ActivationCodeItem[];
}

export interface CreateActivationCodePayload {
  note?: string;
  expires_in_days?: number;
}

export interface CreateActivationCodeResponse {
  status: 'ok';
  message: string;
  data: {
    id: string;
    code: string;
    note: string | null;
    expires_in_days: number;
  };
}

export interface AdminUserItem {
  id: string;
  username: string;
  role: UserRole;
  status: 'active' | 'suspended';
  shopee_link?: string | null;
  created_at: string;
  device_name: string | null;
  device_bound_at: string | null;
  device_last_seen_at: string | null;
}

export interface ListUsersResponse {
  status: 'ok';
  users: AdminUserItem[];
}

export interface CreateAdminPayload {
  username: string;
  password: string;
}

export interface CreateAdminResponse {
  status: 'ok';
  message: string;
  admin: AdminUserItem;
}

export interface UpdateAdminStatusPayload {
  status: 'active' | 'suspended';
  reason?: string;
}

export interface UpdateAdminStatusResponse {
  status: 'ok';
  message: string;
  admin: AdminUserItem;
}

export interface ListAdminsResponse {
  status: 'ok';
  admins: AdminUserItem[];
}

export interface CreateMemberPayload {
  username: string;
  password: string;
}

export interface CreateMemberResponse {
  status: 'ok';
  message: string;
  member: {
    id: string;
    username: string;
    role: 'member';
    status: 'active';
  };
}

export interface IssueResetCodePayload {
  reason?: string;
}

export interface IssueResetCodeResponse {
  status: 'ok';
  message: string;
  data: {
    id: string;
    user_id: string;
    username: string;
    reset_code: string;
    expires_in_minutes: number;
  };
}

export interface AuditLogItem {
  id: string;
  admin_id: string;
  action: string;
  target_user_id: string | null;
  details: string;
  ip_address: string | null;
  created_at: string;
  admin_username: string | null;
  target_username: string | null;
}

export interface ListAuditLogsResponse {
  status: 'ok';
  logs: AuditLogItem[];
}

export interface VideoItem {
  id: string;
  title: string;
  description: string | null;
  product_name: string;
  product_url: string;
  file_size: number;
  content_type: string;
  created_at: string;
  rack_id?: string | null;
  rack_name?: string | null;
}

export interface AdminVideoItem extends VideoItem {
  status: 'active' | 'inactive';
  download_count: number;
  updated_at: string;
  uploaded_by_username: string | null;
}

export interface ListVideosResponse {
  status: 'ok';
  videos: VideoItem[];
}

export interface ListAdminVideosResponse {
  status: 'ok';
  videos: AdminVideoItem[];
}

export interface UploadVideoPayload {
  file: File;
  title: string;
  product_name: string;
  product_url: string;
  description?: string;
  status?: 'active' | 'inactive';
  rack_id?: string;
}

export interface UpdateVideoPayload {
  title?: string;
  product_name?: string;
  product_url?: string;
  description?: string;
  status?: 'active' | 'inactive';
  rack_id?: string;
}

export interface ApiErrorResponse {
  error: string;
  message?: string;
}

export type ShopeeRequestStatus = 'pending' | 'approved' | 'rejected';

export interface ShopeeAccountRequest {
  id: string;
  user_id: string;
  username?: string;
  current_shopee_link: string | null;
  requested_shopee_link: string;
  status: ShopeeRequestStatus;
  rejection_reason: string | null;
  reviewed_by_admin_id: string | null;
  reviewed_by_username?: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListShopeeRequestsResponse {
  status: 'ok';
  requests: ShopeeAccountRequest[];
}

export interface SubmitShopeeRequestPayload {
  requested_shopee_link: string;
}

export interface ReviewShopeeRequestPayload {
  action: 'approve' | 'reject';
  rejection_reason?: string;
}

export interface RackItem {
  id: string;
  name: string;
  is_default: number;
  created_at: string;
  updated_at: string;
  video_count: number;
}

export interface ListRacksResponse {
  status: 'ok';
  racks: RackItem[];
}

export interface CreateRackPayload {
  name: string;
}

export interface UpdateRackPayload {
  name: string;
}

export interface ChangePasswordPayload {
  current_password: string;
  new_password: string;
}

export interface ChangeUsernamePayload {
  current_password: string;
  new_username: string;
}

export interface ResetUserPasswordPayload {
  new_password: string;
}

export interface AdminUpdateUsernamePayload {
  new_username: string;
}

export interface DeleteAccountPayload {
  confirm_username: string;
}

export interface MoveVideoRackPayload {
  target_rack_id: string;
}
