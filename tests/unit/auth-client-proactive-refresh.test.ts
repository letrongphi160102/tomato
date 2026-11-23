import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCESS_TOKEN_TTL_MS,
  PROACTIVE_REFRESH_LEAD_MS,
  authFetch,
  clearAccessTokenFreshness,
  isAccessTokenExpiringSoon,
  markAccessTokenFresh,
  refreshAuthSession,
  seedAccessTokenFreshness,
} from '@/lib/auth-client';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe('Unit: Proactive Silent Refresh (Cross-Tab Safe) & Non-Modal DropdownMenu CSP Guard', () => {
  const originalFetch = globalThis.fetch;
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('document', { cookie: '__Host-tomato_csrf=synthetic-csrf-for-test' });
    clearAccessTokenFreshness();
  });

  afterEach(() => {
    clearAccessTokenFreshness();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('theo dõi mốc hết hạn Access Token chính xác, chỉ lưu timestamp thuần (không lưu token/PII) và bảo vệ mốc vừa refresh từ tab khác', () => {
    const baseNow = 1_700_000_000_000;

    expect(isAccessTokenExpiringSoon(PROACTIVE_REFRESH_LEAD_MS, baseNow)).toBe(false);

    markAccessTokenFresh(ACCESS_TOKEN_TTL_MS, baseNow);
    const rawStored = storage.getItem('tomato_auth_at_freshness_v1');
    expect(rawStored).toBeTruthy();
    const parsedStored = JSON.parse(rawStored ?? '{}') as Record<string, unknown>;
    expect(Object.keys(parsedStored).sort()).toEqual(['freshUntilMs', 'refreshedAtMs']);

    // Còn 10 phút -> chưa cần làm mới chủ động.
    expect(isAccessTokenExpiringSoon(PROACTIVE_REFRESH_LEAD_MS, baseNow + 5 * 60 * 1000)).toBe(
      false,
    );
    // Mốc 13p30s (còn đúng 90 giây) -> kích hoạt làm mới chủ động.
    expect(
      isAccessTokenExpiringSoon(
        PROACTIVE_REFRESH_LEAD_MS,
        baseNow + ACCESS_TOKEN_TTL_MS - PROACTIVE_REFRESH_LEAD_MS,
      ),
    ).toBe(true);

    // Nếu tab khác vừa refresh 2 giây trước, seed SSR cũ (còn 2 phút) không được ghi đè ngược mốc tươi mới hơn.
    seedAccessTokenFreshness(2 * 60 * 1000, baseNow + 2_000);
    expect(isAccessTokenExpiringSoon(PROACTIVE_REFRESH_LEAD_MS, baseNow + 5 * 60 * 1000)).toBe(
      false,
    );

    // Khi đăng xuất -> xóa sạch dấu mốc.
    clearAccessTokenFreshness();
    expect(storage.getItem('tomato_auth_at_freshness_v1')).toBeNull();
    expect(isAccessTokenExpiringSoon(PROACTIVE_REFRESH_LEAD_MS, baseNow + 20 * 60 * 1000)).toBe(
      false,
    );
  });

  it('authFetch gom 2 request song song (/heartbeat + /notifications) sau 15 phút: chỉ gọi duy nhất 1 /refresh trước, 0 lỗi 401', async () => {
    const callOrder: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      callOrder.push(url);
      if (url === '/api/v1/auth/refresh') {
        const headers = new Headers(init?.headers);
        expect(headers.get('X-CSRF-Token')).toBe('synthetic-csrf-for-test');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify({ refreshed: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    // Giả lập Access Token chỉ còn 30 giây (đã bước vào cửa sổ làm mới chủ động 90 giây).
    seedAccessTokenFreshness(30_000);

    const [heartbeatRes, notificationsRes] = await Promise.all([
      authFetch('/api/v1/presence/heartbeat', { method: 'POST', body: '{}' }),
      authFetch('/api/v1/notifications?limit=20', { method: 'GET' }),
    ]);

    expect(heartbeatRes.status).toBe(200);
    expect(notificationsRes.status).toBe(200);
    expect(callOrder[0]).toBe('/api/v1/auth/refresh');
    expect(callOrder.filter((url) => url === '/api/v1/auth/refresh')).toHaveLength(1);
    expect(callOrder).toHaveLength(3);
    expect(isAccessTokenExpiringSoon()).toBe(false);
  });

  it('dùng Web Locks liên-tab: nếu tab khác vừa hoàn tất refresh trong lúc chờ lock, tab hiện tại KHÔNG gọi trùng /refresh', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const lockRequestMock = vi.fn(
      async (_name: string, callback: () => Promise<boolean>): Promise<boolean> => {
        // Giả lập Tab A vừa hoàn tất refresh và cập nhật localStorage ngay trước khi Tab B vào lock.
        markAccessTokenFresh();
        return callback();
      },
    );
    vi.stubGlobal('navigator', { locks: { request: lockRequestMock } });

    // Trước khi vào lock, Tab B thấy Access Token đã quá hạn.
    seedAccessTokenFreshness(0);
    expect(isAccessTokenExpiringSoon()).toBe(true);

    const refreshed = await refreshAuthSession({ onlyIfExpiringSoon: true });
    expect(refreshed).toBe(true);
    expect(lockRequestMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chống va chạm xoay vòng Refresh Token khi gặp 401 song song giữa 2 tab (skipIfRefreshedSinceMs)', async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/v1/notifications?limit=20') {
        apiCalls += 1;
        return new Response(JSON.stringify({ ok: apiCalls > 1 }), {
          status: apiCalls === 1 ? 401 : 200,
        });
      }
      throw new Error(`Không được gọi trùng ${url} khi tab khác đã refresh xong`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const lockRequestMock = vi.fn(
      async (_name: string, callback: () => Promise<boolean>): Promise<boolean> => {
        // Tab A vừa refresh thành công sau khi request của Tab B bắt đầu.
        markAccessTokenFresh();
        return callback();
      },
    );
    vi.stubGlobal('navigator', { locks: { request: lockRequestMock } });

    const response = await authFetch('/api/v1/notifications?limit=20', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(apiCalls).toBe(2);
    expect(lockRequestMock).toHaveBeenCalledTimes(1);
  });

  it('authFetch KHÔNG tự làm mới chủ động khi retryOnUnauthorized=false (ví dụ /api/v1/auth/logout)', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calledUrls.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ loggedOut: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    seedAccessTokenFreshness(0);
    await authFetch('/api/v1/auth/logout', { method: 'POST' }, { retryOnUnauthorized: false });

    expect(calledUrls).toEqual(['/api/v1/auth/logout']);
  });

  it('DropdownMenu mặc định chạy non-modal (modal=false) để không kích hoạt react-remove-scroll gây vi phạm CSP style-src-elem', () => {
    const dropdownSource = readFileSync(
      join(process.cwd(), 'src/components/ui/dropdown-menu.tsx'),
      'utf8',
    );
    const bellSource = readFileSync(
      join(process.cwd(), 'src/components/layout/notification-bell.tsx'),
      'utf8',
    );

    expect(dropdownSource).toMatch(/modal\s*=\s*false/);
    expect(bellSource).toMatch(/<DropdownMenu[\s\S]*?modal=\{false\}/);
  });
});
