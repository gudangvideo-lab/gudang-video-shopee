import { describe, it, expect } from 'vitest';
import worker from '../worker/index';
import { Env } from '../worker/types';

describe('Worker /api/health endpoint', () => {
  const mockEnv: Env = {};

  it('mengembalikan status 200 dan payload status ok untuk GET /api/health', async () => {
    const request = new Request('http://localhost:8787/api/health', {
      method: 'GET'
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');

    const body = await response.json();
    expect(body).toHaveProperty('status', 'ok');
    expect(body).toHaveProperty('service', 'gudang-video-shopee-api');
    expect(body).toHaveProperty('timestamp');
  });

  it('mengembalikan status 404 untuk endpoint /api yang tidak dikenal', async () => {
    const request = new Request('http://localhost:8787/api/not-found', {
      method: 'GET'
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(404);
  });

  it('mendelegasikan request non-api ke binding ASSETS jika tersedia', async () => {
    const mockAssetResponse = new Response('<!doctype html><html>Mock Frontend</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
    const mockAssetsEnv: Env = {
      ASSETS: {
        fetch: async () => mockAssetResponse
      } as unknown as Fetcher
    };

    const request = new Request('http://localhost:8787/', {
      method: 'GET'
    });

    const response = await worker.fetch(request, mockAssetsEnv);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!doctype html><html>Mock Frontend</html>');
  });

  it('mengembalikan teks default jika binding ASSETS tidak tersedia untuk request non-api', async () => {
    const request = new Request('http://localhost:8787/', {
      method: 'GET'
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Gudang Video Shopee Affiliate Worker Active');
  });
});
