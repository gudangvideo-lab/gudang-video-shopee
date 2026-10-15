import { Env } from './types';
import { handleActivate, handleLogin, handleResetDevice, handleLogout, handleMe } from './auth';
import {
  handleCreateActivationCode,
  handleListActivationCodes,
  handleIssueResetCode,
  handleListUsers,
  handleListAuditLogs,
  handleListAdmins,
  handleCreateAdmin,
  handleUpdateAdminStatus,
  handleCreateMember
} from './admin';
import {
  handleListVideos,
  handleGetVideo,
  handleDownloadVideo,
  handleAdminUploadVideo,
  handleAdminListVideos,
  handleAdminUpdateVideo,
  handleAdminDeleteVideo
} from './videos';
import {
  handleInitialShopeeLink,
  handleSubmitShopeeRequest,
  handleListMemberShopeeRequests,
  handleAdminListShopeeRequests,
  handleAdminReviewShopeeRequest
} from './shopee';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. Endpoint health check - tidak memerlukan login dan tidak membocorkan data sensitif
    if (path === '/api/health' && method === 'GET') {
      const responseData = {
        status: 'ok',
        service: 'gudang-video-shopee-api',
        timestamp: new Date().toISOString()
      };

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 2. Routing API Autentikasi Pengguna
    if (path === '/api/auth/activate' && method === 'POST') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleActivate(request, env.DB);
    }

    if (path === '/api/auth/login' && method === 'POST') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleLogin(request, env.DB);
    }

    if (path === '/api/auth/reset-device' && method === 'POST') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleResetDevice(request, env.DB);
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleLogout(request, env.DB);
    }

    if (path === '/api/auth/me' && method === 'GET') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleMe(request, env.DB);
    }

    // 3. Routing API Administratif (Admin Only)
    if (path === '/api/admin/activation-codes') {
      if (!env.DB) return databaseUnavailableResponse();
      if (method === 'POST') return handleCreateActivationCode(request, env.DB);
      if (method === 'GET') return handleListActivationCodes(request, env.DB);
    }

    const resetCodeMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/reset-code$/);
    if (resetCodeMatch && method === 'POST') {
      if (!env.DB) return databaseUnavailableResponse();
      const targetUserId = decodeURIComponent(resetCodeMatch[1]);
      return handleIssueResetCode(request, env.DB, targetUserId);
    }

    if (path === '/api/admin/users' && method === 'GET') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleListUsers(request, env.DB);
    }

    if (path === '/api/admin/audit-logs' && method === 'GET') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleListAuditLogs(request, env.DB);
    }

    // 4. Routing API Super Administrator
    if (path === '/api/super-admin/admins') {
      if (!env.DB) return databaseUnavailableResponse();
      if (method === 'GET') return handleListAdmins(request, env.DB);
      if (method === 'POST') return handleCreateAdmin(request, env.DB);
    }

    const adminStatusMatch = path.match(/^\/api\/super-admin\/admins\/([^/]+)\/status$/);
    if (adminStatusMatch && method === 'PATCH') {
      if (!env.DB) return databaseUnavailableResponse();
      const adminId = decodeURIComponent(adminStatusMatch[1]);
      return handleUpdateAdminStatus(request, env.DB, adminId);
    }

    if (path === '/api/super-admin/members' && method === 'POST') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleCreateMember(request, env.DB);
    }

    // 4. Routing API Video (Pengguna & Admin)
    if (path === '/api/videos' && method === 'GET') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleListVideos(request, env.DB);
    }

    const videoDownloadMatch = path.match(/^\/api\/videos\/([^/]+)\/download$/);
    if (videoDownloadMatch && method === 'GET') {
      if (!env.DB) return databaseUnavailableResponse();
      const videoId = decodeURIComponent(videoDownloadMatch[1]);
      return handleDownloadVideo(request, env, videoId);
    }

    const videoDetailMatch = path.match(/^\/api\/videos\/([^/]+)$/);
    if (videoDetailMatch && method === 'GET') {
      if (!env.DB) return databaseUnavailableResponse();
      const videoId = decodeURIComponent(videoDetailMatch[1]);
      return handleGetVideo(request, env.DB, videoId);
    }

    if (path === '/api/admin/videos') {
      if (!env.DB) return databaseUnavailableResponse();
      if (method === 'POST') return handleAdminUploadVideo(request, env);
      if (method === 'GET') return handleAdminListVideos(request, env.DB);
    }

    const adminVideoMatch = path.match(/^\/api\/admin\/videos\/([^/]+)$/);
    if (adminVideoMatch) {
      if (!env.DB) return databaseUnavailableResponse();
      const videoId = decodeURIComponent(adminVideoMatch[1]);
      if (method === 'PUT' || method === 'PATCH') return handleAdminUpdateVideo(request, env.DB, videoId);
      if (method === 'DELETE') return handleAdminDeleteVideo(request, env, videoId);
    }

    // 5. Routing API Manajemen Akun Shopee (Member)
    if (path === '/api/member/shopee-account/initial' && method === 'POST') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleInitialShopeeLink(request, env.DB);
    }

    if (path === '/api/member/shopee-account/requests') {
      if (!env.DB) return databaseUnavailableResponse();
      if (method === 'POST') return handleSubmitShopeeRequest(request, env.DB);
      if (method === 'GET') return handleListMemberShopeeRequests(request, env.DB);
    }

    // 6. Routing API Manajemen Akun Shopee (Admin)
    if (path === '/api/admin/shopee-requests' && method === 'GET') {
      if (!env.DB) return databaseUnavailableResponse();
      return handleAdminListShopeeRequests(request, env.DB);
    }

    const reviewShopeeMatch = path.match(/^\/api\/admin\/shopee-requests\/([^/]+)\/review$/);
    if (reviewShopeeMatch && method === 'POST') {
      if (!env.DB) return databaseUnavailableResponse();
      const requestId = decodeURIComponent(reviewShopeeMatch[1]);
      return handleAdminReviewShopeeRequest(request, env.DB, requestId);
    }

    // 7. API yang belum didefinisikan
    if (path.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Endpoint tidak ditemukan' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=utf-8'
        }
      });
    }

    // 5. Penanganan Aset Statis Frontend (Cloudflare Workers Static Assets)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Gudang Video Shopee Affiliate Worker Active', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};

function databaseUnavailableResponse(): Response {
  return new Response(JSON.stringify({
    error: 'DATABASE_UNAVAILABLE',
    message: 'Database Cloudflare D1 tidak terhubung.'
  }), {
    status: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
