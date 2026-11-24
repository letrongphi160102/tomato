import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearRealtimeNotificationRamCache,
  getOrInitUserRealtimeNotificationRamCache,
} from '@/components/realtime/realtime-presence-context';
import type { NotificationItemDto } from '@/modules/notifications/notification.service';

function makeSampleNotification(id: string): NotificationItemDto {
  return {
    public_id: id,
    type: 'new_follower',
    entityPublicId: null,
    readAt: null,
    createdAt: '2026-11-24T12:00:00.000Z',
    actor: {
      public_id: '22222222-2222-4222-8222-222222222222',
      handle: 'bob',
      fullName: 'Bob Nguyen',
      avatarUrl: null,
      isPrivate: false,
    },
    followRequestPending: false,
  };
}

describe('RealtimePresence RAM Cache — chống nhấp nháy huy hiệu thông báo khi chuyển "/" <-> Dashboard', () => {
  afterEach(() => {
    clearRealtimeNotificationRamCache();
  });

  it('giữ nguyên unreadCount và danh sách thông báo trong RAM khi provider unmount/remount cho cùng một tài khoản', () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const cache = getOrInitUserRealtimeNotificationRamCache(userId);
    expect(cache.unreadCount).toBe(0);
    expect(cache.hasLoadedInitial).toBe(false);

    const sampleItem = makeSampleNotification('33333333-3333-4333-8333-333333333333');
    cache.notifications = [sampleItem];
    cache.unreadCount = 1;
    cache.nextCursor = 'cursor-page-2';
    cache.hasLoadedInitial = true;
    cache.e2eeReady = true;
    cache.lastHeartbeatAtMs = 1_760_000_000_000;

    // Mô phỏng RealtimePresenceProvider mount mới khi người dùng đi từ "/" sang "/messages" hoặc "/settings".
    const rehydrated = getOrInitUserRealtimeNotificationRamCache(`  ${userId.toUpperCase()}  `);
    expect(rehydrated).toBe(cache);
    expect(rehydrated.unreadCount).toBe(1);
    expect(rehydrated.notifications).toEqual([sampleItem]);
    expect(rehydrated.nextCursor).toBe('cursor-page-2');
    expect(rehydrated.hasLoadedInitial).toBe(true);
    expect(rehydrated.e2eeReady).toBe(true);
    expect(rehydrated.lastHeartbeatAtMs).toBe(1_760_000_000_000);
  });

  it('cô lập hoàn toàn giữa các tài khoản khác nhau và xóa sạch RAM khi đăng xuất', () => {
    const userA = '11111111-1111-4111-8111-111111111111';
    const userB = '99999999-9999-4999-8999-999999999999';

    const cacheA = getOrInitUserRealtimeNotificationRamCache(userA);
    cacheA.notifications = [makeSampleNotification('33333333-3333-4333-8333-333333333333')];
    cacheA.unreadCount = 3;
    cacheA.hasLoadedInitial = true;

    // Chuyển sang tài khoản B không bao giờ kế thừa dữ liệu của A.
    const cacheB = getOrInitUserRealtimeNotificationRamCache(userB);
    expect(cacheB).not.toBe(cacheA);
    expect(cacheB.unreadCount).toBe(0);
    expect(cacheB.notifications).toEqual([]);
    expect(cacheB.hasLoadedInitial).toBe(false);

    // Gọi clearRealtimeNotificationRamCache() khi đăng xuất phải dọn sạch hoàn toàn.
    cacheB.unreadCount = 5;
    clearRealtimeNotificationRamCache();

    const afterLogout = getOrInitUserRealtimeNotificationRamCache(userB);
    expect(afterLogout.unreadCount).toBe(0);
    expect(afterLogout.notifications).toEqual([]);
    expect(afterLogout.hasLoadedInitial).toBe(false);
    expect(afterLogout.e2eeReady).toBe(false);
    expect(afterLogout.lastHeartbeatAtMs).toBe(0);
  });

  it('không lưu singleton khi userPublicId rỗng hoặc undefined', () => {
    const emptyA = getOrInitUserRealtimeNotificationRamCache(undefined);
    emptyA.unreadCount = 9;
    const emptyB = getOrInitUserRealtimeNotificationRamCache('');
    expect(emptyB.unreadCount).toBe(0);
    expect(emptyB).not.toBe(emptyA);
  });
});

describe('Auth UI Regression Guard — chống tràn nút w-full trong container sm:flex-row', () => {
  it('không còn biểu mẫu xác thực nào đặt nút w-full bên trong flex-row gây tràn khỏi Card', () => {
    const authDir = join(process.cwd(), 'src/components/auth');
    const authFiles = readdirSync(authDir).filter((file) => file.endsWith('.tsx'));
    expect(authFiles.length).toBeGreaterThan(0);

    for (const fileName of authFiles) {
      const content = readFileSync(join(authDir, fileName), 'utf8');
      expect(content, `${fileName} không được dùng sm:flex-row cho cụm nút w-full`).not.toContain(
        'sm:flex-row',
      );
    }

    const verifySource = readFileSync(join(authDir, 'verify-email-form.tsx'), 'utf8');
    const forgotSource = readFileSync(join(authDir, 'forgot-password-form.tsx'), 'utf8');
    const resetSource = readFileSync(join(authDir, 'reset-password-form.tsx'), 'utf8');

    expect(verifySource).toContain('grid grid-cols-1 gap-2 sm:grid-cols-2');
    expect(forgotSource).toContain('grid grid-cols-1 gap-2 sm:grid-cols-2');
    expect(resetSource).toContain('grid grid-cols-1 gap-2 sm:grid-cols-2');
  });
});
