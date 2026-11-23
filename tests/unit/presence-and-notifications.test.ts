import { describe, expect, it } from 'vitest';

import type { SessionRow, UserRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import {
  authorizeNotificationAction,
  markNotificationsReadInputSchema,
  notificationListQuerySchema,
} from '@/modules/notifications';
import {
  PRESENCE_ONLINE_THRESHOLD_MS,
  canViewTargetPresence,
  formatCoarsePresenceStatus,
  presenceHeartbeatInputSchema,
  presenceQueryInputSchema,
} from '@/modules/presence';
import { EMPTY_SOCIAL_RELATIONSHIP } from '@/modules/social/social.policy';
import { updatePrivacyInputSchema } from '@/modules/social/social.schemas';

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-23T12:00:00.000Z');
  return {
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'alice',
    handle: 'alice',
    handleNormalized: 'alice',
    fullName: 'Alice',
    bio: '',
    avatarUrl: null,
    avatarStorageKey: null,
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    followersCount: 0,
    followingCount: 0,
    handleChangedAt: null,
    gender: 'female',
    dateOfBirth: '1999-01-01',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrincipal(user: UserRow): AuthenticatedPrincipal {
  const now = new Date('2026-11-23T12:00:00.000Z');
  const session: SessionRow = {
    id: '0195a000-0000-7000-8000-000000000099',
    publicId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: user.id,
    familyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    refreshTokenHash: 'synthetic-hash',
    deviceInfo: 'Chrome',
    ipAddress: '127.0.0.1',
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    revokedAt: null,
    revokeReason: null,
    createdAt: now,
  };
  return { user, session };
}

describe('Presence: làm tròn thời gian thô & Policy đối xứng', () => {
  const NOW = 1_760_000_000_000;

  it('làm tròn mốc thời gian thô đúng ngưỡng 105 giây và không lộ timestamp chính xác từng giây', () => {
    expect(PRESENCE_ONLINE_THRESHOLD_MS).toBe(105_000);

    // Trong ngưỡng 105 giây -> đang hoạt động.
    const activeNow = formatCoarsePresenceStatus(NOW - 60_000, NOW);
    expect(activeNow).toEqual({
      isOnline: true,
      bucket: 'active_now',
      label: 'Đang hoạt động',
    });
    expect(Object.keys(activeNow ?? {}).sort()).toEqual(['bucket', 'isOnline', 'label']);

    // Đúng ranh giới 105 giây vẫn là đang hoạt động.
    expect(formatCoarsePresenceStatus(NOW - 105_000, NOW)?.isOnline).toBe(true);

    // Quá 105 giây và dưới 5 phút -> vài phút trước.
    expect(formatCoarsePresenceStatus(NOW - 106_000, NOW)).toEqual({
      isOnline: false,
      bucket: 'few_minutes',
      label: 'Hoạt động vài phút trước',
    });

    // 5 phút .. 59 phút -> làm tròn xuống bội số 5 phút.
    expect(formatCoarsePresenceStatus(NOW - 9 * 60_000 - 59_000, NOW)).toEqual({
      isOnline: false,
      bucket: 'minutes',
      label: 'Hoạt động 5 phút trước',
    });
    expect(formatCoarsePresenceStatus(NOW - 14 * 60_000, NOW)).toEqual({
      isOnline: false,
      bucket: 'minutes',
      label: 'Hoạt động 10 phút trước',
    });
    expect(formatCoarsePresenceStatus(NOW - 59 * 60_000, NOW)).toEqual({
      isOnline: false,
      bucket: 'minutes',
      label: 'Hoạt động 55 phút trước',
    });

    // 1 giờ .. 23 giờ -> làm tròn xuống giờ nguyên.
    expect(formatCoarsePresenceStatus(NOW - 65 * 60_000, NOW)).toEqual({
      isOnline: false,
      bucket: 'hours',
      label: 'Hoạt động 1 giờ trước',
    });
    expect(formatCoarsePresenceStatus(NOW - 23 * 3600_000 - 120_000, NOW)).toEqual({
      isOnline: false,
      bucket: 'hours',
      label: 'Hoạt động 23 giờ trước',
    });

    // 1 .. 7 ngày -> làm tròn xuống ngày nguyên; > 7 ngày -> null.
    expect(formatCoarsePresenceStatus(NOW - 2 * 86_400_000 - 300_000, NOW)).toEqual({
      isOnline: false,
      bucket: 'days',
      label: 'Hoạt động 2 ngày trước',
    });
    expect(formatCoarsePresenceStatus(NOW - 7 * 86_400_000, NOW)).toEqual({
      isOnline: false,
      bucket: 'days',
      label: 'Hoạt động 7 ngày trước',
    });
    expect(formatCoarsePresenceStatus(NOW - 7 * 86_400_000 - 1, NOW)).toBeNull();
  });

  it('cưỡng chế đối xứng & chỉ hiển thị cho mutual follow hoặc hội thoại chính, chặn khi Block', () => {
    const viewer = makeUser({ id: '0195a000-0000-7000-8000-000000000001', showActiveStatus: true });
    const target = makeUser({ id: '0195a000-0000-7000-8000-000000000002', showActiveStatus: true });

    expect(
      canViewTargetPresence({
        viewer,
        target,
        isBidirectionallyBlocked: false,
        isMutualFollow: true,
        hasPrimaryConversation: false,
      }),
    ).toBe(true);

    expect(
      canViewTargetPresence({
        viewer,
        target,
        isBidirectionallyBlocked: false,
        isMutualFollow: false,
        hasPrimaryConversation: true,
      }),
    ).toBe(true);

    // Tắt ở phía người xem -> chặn đối xứng.
    expect(
      canViewTargetPresence({
        viewer: { ...viewer, showActiveStatus: false },
        target,
        isBidirectionallyBlocked: false,
        isMutualFollow: true,
        hasPrimaryConversation: true,
      }),
    ).toBe(false);

    // Tắt ở phía người được xem -> chặn đối xứng.
    expect(
      canViewTargetPresence({
        viewer,
        target: { ...target, showActiveStatus: false },
        isBidirectionallyBlocked: false,
        isMutualFollow: true,
        hasPrimaryConversation: true,
      }),
    ).toBe(false);

    // Bị chặn hai chiều -> từ chối tuyệt đối.
    expect(
      canViewTargetPresence({
        viewer,
        target,
        isBidirectionallyBlocked: true,
        isMutualFollow: true,
        hasPrimaryConversation: true,
      }),
    ).toBe(false);

    // Chưa mutual & chưa có hội thoại chính -> từ chối.
    expect(
      canViewTargetPresence({
        viewer,
        target,
        isBidirectionallyBlocked: false,
        isMutualFollow: false,
        hasPrimaryConversation: false,
      }),
    ).toBe(false);

    // Không tự trả presence cho chính mình.
    expect(
      canViewTargetPresence({
        viewer,
        target: viewer,
        isBidirectionallyBlocked: false,
        isMutualFollow: true,
        hasPrimaryConversation: true,
      }),
    ).toBe(false);
  });
});

describe('Notifications Policy & Strict Zod Schemas (M8)', () => {
  it('authorizeNotificationAction từ chối fail-closed khi bị chặn, tự gửi hoặc tài khoản không hoạt động', () => {
    const alice = makeUser({ id: '0195a000-0000-7000-8000-000000000001' });
    const bob = makeUser({ id: '0195a000-0000-7000-8000-000000000002' });
    const principalA = makePrincipal(alice);

    expect(authorizeNotificationAction(principalA, 'notification:list')).toBe(true);
    expect(authorizeNotificationAction(principalA, 'notification:mark_read')).toBe(true);
    expect(
      authorizeNotificationAction(principalA, 'notification:emit', {
        recipientUser: bob,
        relationship: EMPTY_SOCIAL_RELATIONSHIP,
      }),
    ).toBe(true);
    expect(
      authorizeNotificationAction(principalA, 'notification:emit', {
        recipientUser: bob,
        relationship: { ...EMPTY_SOCIAL_RELATIONSHIP, blockedByTarget: true },
      }),
    ).toBe(false);
    expect(
      authorizeNotificationAction(principalA, 'notification:emit', {
        recipientUser: alice,
        relationship: EMPTY_SOCIAL_RELATIONSHIP,
      }),
    ).toBe(false);
  });

  it('Zod .strict() từ chối trường lạ trên toàn bộ schema M8', () => {
    expect(notificationListQuerySchema.safeParse({ limit: '20', extra: '1' }).success).toBe(false);
    expect(markNotificationsReadInputSchema.safeParse({}).success).toBe(false);
    expect(
      markNotificationsReadInputSchema.safeParse({
        markAll: true,
        notificationPublicIds: ['11111111-1111-4111-8111-111111111111'],
      }).success,
    ).toBe(false);
    expect(
      markNotificationsReadInputSchema.safeParse({ markAll: true, userId: 'hack' }).success,
    ).toBe(false);
    expect(markNotificationsReadInputSchema.safeParse({ markAll: true }).success).toBe(true);

    expect(presenceHeartbeatInputSchema.safeParse({ timestamp: 123 }).success).toBe(false);
    expect(presenceHeartbeatInputSchema.safeParse({}).success).toBe(true);

    expect(
      presenceQueryInputSchema.safeParse({
        userPublicIds: ['11111111-1111-4111-8111-111111111111'],
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      presenceQueryInputSchema.safeParse({
        userPublicIds: ['0195a000-0000-7000-8000-000000000001'], // UUIDv7 bị từ chối
      }).success,
    ).toBe(false);

    // Privacy PATCH: cho phép cập nhật từng cờ riêng lẻ nhưng từ chối rỗng hoặc trường lạ.
    expect(updatePrivacyInputSchema.safeParse({}).success).toBe(false);
    expect(updatePrivacyInputSchema.safeParse({ showActiveStatus: false }).success).toBe(true);
    expect(updatePrivacyInputSchema.safeParse({ showReadReceipts: false }).success).toBe(true);
    expect(updatePrivacyInputSchema.safeParse({ acceptPendingRequests: true }).success).toBe(false);
    expect(
      updatePrivacyInputSchema.safeParse({ showActiveStatus: true, unknownField: 1 }).success,
    ).toBe(false);
  });
});
