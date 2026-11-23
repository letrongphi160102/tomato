import { describe, expect, it } from 'vitest';

import type { SessionRow, UserRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import {
  EMPTY_SOCIAL_RELATIONSHIP,
  SOCIAL_LIST_DEFAULT_LIMIT,
  SOCIAL_LIST_MAX_LIMIT,
  assertSocialAuthorized,
  authorizeSocialAction,
  canViewTargetConnections,
  decodeSocialCursor,
  encodeSocialCursor,
  publicIdRouteParamSchema,
  socialConnectionListQuerySchema,
  socialSimpleListQuerySchema,
  updatePrivacyInputSchema,
  type SocialRelationshipSnapshot,
} from '@/modules/social';

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-23T10:00:00.000Z');
  return {
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'alice_m7',
    handle: 'alice_m7',
    handleNormalized: 'alice_m7',
    fullName: 'Alice M7',
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
    dateOfBirth: '1999-05-10',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrincipal(userOverrides: Partial<UserRow> = {}): AuthenticatedPrincipal {
  const user = makeUser(userOverrides);
  const now = new Date('2026-11-23T10:00:00.000Z');
  const session: SessionRow = {
    id: '0195a000-0000-7000-8000-000000000099',
    publicId: '99999999-9999-4999-8999-999999999999',
    userId: user.id,
    familyId: '88888888-8888-4888-8888-888888888888',
    refreshTokenHash: 'synthetic-session-hash',
    deviceInfo: 'Chrome on Windows',
    ipAddress: '127.0.0.1',
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    revokedAt: null,
    revokeReason: null,
    createdAt: now,
  };
  return { user, session };
}

describe('Unit M7: social.policy.ts (ReBAC Deny-by-default & Fail-closed)', () => {
  const actorA = makePrincipal();
  const publicB = makeUser({
    id: '0195a000-0000-7000-8000-000000000002',
    publicId: '22222222-2222-4222-8222-222222222222',
    handle: 'bob_m7',
    handleNormalized: 'bob_m7',
    isPrivate: false,
  });
  const privateP = makeUser({
    id: '0195a000-0000-7000-8000-000000000003',
    publicId: '33333333-3333-4333-8333-333333333333',
    handle: 'private_m7',
    handleNormalized: 'private_m7',
    isPrivate: true,
  });

  it('từ chối mọi hành động khi thiếu actor, phiên bị thu hồi hoặc actor không active', () => {
    const revokedActor: AuthenticatedPrincipal = {
      ...actorA,
      session: { ...actorA.session, revokedAt: new Date() },
    };
    const suspendedActor = makePrincipal({ status: 'suspended' });
    const deletedActor = makePrincipal({ status: 'deleted', deletedAt: new Date() });

    for (const invalidActor of [null, undefined, revokedActor, suspendedActor, deletedActor]) {
      expect(
        authorizeSocialAction(invalidActor, 'profile:view', {
          targetUser: publicB,
          relationship: EMPTY_SOCIAL_RELATIONSHIP,
        }),
      ).toBe(false);
      expect(authorizeSocialAction(invalidActor, 'privacy:read')).toBe(false);
    }
  });

  it('fail-closed khi thiếu relationship snapshot cho tài khoản khác và chặn hai chiều', () => {
    // Thiếu relationship -> fail-closed
    expect(authorizeSocialAction(actorA, 'profile:view', { targetUser: publicB })).toBe(false);
    expect(
      authorizeSocialAction(actorA, 'profile:view', { targetUser: publicB, relationship: null }),
    ).toBe(false);

    const blockedByActor: SocialRelationshipSnapshot = {
      ...EMPTY_SOCIAL_RELATIONSHIP,
      blockedByActor: true,
    };
    const blockedByTarget: SocialRelationshipSnapshot = {
      ...EMPTY_SOCIAL_RELATIONSHIP,
      blockedByTarget: true,
    };

    for (const blockedRel of [blockedByActor, blockedByTarget]) {
      expect(
        authorizeSocialAction(actorA, 'profile:view', {
          targetUser: publicB,
          relationship: blockedRel,
        }),
      ).toBe(false);
      expect(
        authorizeSocialAction(actorA, 'profile:view_connections', {
          targetUser: publicB,
          relationship: blockedRel,
        }),
      ).toBe(false);
      expect(
        authorizeSocialAction(actorA, 'social:follow', {
          targetUser: publicB,
          relationship: blockedRel,
        }),
      ).toBe(false);
      expect(() =>
        assertSocialAuthorized(actorA, 'profile:view', {
          targetUser: publicB,
          relationship: blockedRel,
        }),
      ).toThrowError(expect.objectContaining({ status: 404, code: 'NOT_FOUND' }));
    }
  });

  it('cưỡng chế chính xác quyền xem danh sách Followers/Following của tài khoản Riêng tư', () => {
    const ownPrivate = makePrincipal({ isPrivate: true });

    // Chính chủ luôn được xem danh sách của chính mình.
    expect(
      authorizeSocialAction(ownPrivate, 'profile:view_connections', {
        targetUser: ownPrivate.user,
        relationship: EMPTY_SOCIAL_RELATIONSHIP,
      }),
    ).toBe(true);

    // Người lạ (none) và người mới gửi yêu cầu (requested) xem danh sách Private -> bị từ chối 404.
    expect(
      canViewTargetConnections(actorA.user.id, privateP, {
        ...EMPTY_SOCIAL_RELATIONSHIP,
        actorFollowStatus: 'none',
      }),
    ).toBe(false);
    expect(
      canViewTargetConnections(actorA.user.id, privateP, {
        ...EMPTY_SOCIAL_RELATIONSHIP,
        actorFollowStatus: 'requested',
      }),
    ).toBe(false);
    expect(() =>
      assertSocialAuthorized(actorA, 'profile:view_connections', {
        targetUser: privateP,
        relationship: { ...EMPTY_SOCIAL_RELATIONSHIP, actorFollowStatus: 'requested' },
      }),
    ).toThrowError(expect.objectContaining({ status: 404, code: 'NOT_FOUND' }));

    // Follower đã được duyệt (following) và không bị chặn -> được phép.
    expect(
      authorizeSocialAction(actorA, 'profile:view_connections', {
        targetUser: privateP,
        relationship: { ...EMPTY_SOCIAL_RELATIONSHIP, actorFollowStatus: 'following' },
      }),
    ).toBe(true);
  });

  it('cho phép bỏ chặn tài khoản đã bị locked/suspended khi chính mình đang chặn họ, nhưng từ chối khi chưa chặn', () => {
    const suspendedTarget = makeUser({
      id: '0195a000-0000-7000-8000-000000000004',
      publicId: '44444444-4444-4444-8444-444444444444',
      status: 'suspended',
    });

    // Đang có bản ghi chặn do actor tạo -> cho phép bỏ chặn dù tài khoản kia suspended/locked.
    expect(
      authorizeSocialAction(actorA, 'social:unblock', {
        targetUser: suspendedTarget,
        relationship: { ...EMPTY_SOCIAL_RELATIONSHIP, blockedByActor: true },
      }),
    ).toBe(true);

    // Chưa chặn tài khoản suspended -> từ chối 404.
    expect(
      authorizeSocialAction(actorA, 'social:unblock', {
        targetUser: suspendedTarget,
        relationship: EMPTY_SOCIAL_RELATIONSHIP,
      }),
    ).toBe(false);

    // B đã chặn A trước (A chưa chặn B) -> A cố gọi block hoặc unblock đều bị từ chối 404 (chống dò).
    const blockedByTargetOnly: SocialRelationshipSnapshot = {
      ...EMPTY_SOCIAL_RELATIONSHIP,
      blockedByTarget: true,
    };
    expect(
      authorizeSocialAction(actorA, 'social:block', {
        targetUser: publicB,
        relationship: blockedByTargetOnly,
      }),
    ).toBe(false);
    expect(
      authorizeSocialAction(actorA, 'social:unblock', {
        targetUser: publicB,
        relationship: blockedByTargetOnly,
      }),
    ).toBe(false);
  });
});

describe('Unit M7: Cursor keyset & Zod .strict() schemas', () => {
  it('mã hóa & giải mã cursor theo cặp (createdAt microsecond, publicId UUIDv4) và chặn dữ liệu giả mạo', () => {
    const validCursor = encodeSocialCursor({
      createdAtIso: '2026-11-23T11:22:33.456789Z',
      publicId: '22222222-2222-4222-8222-222222222222',
    });
    expect(decodeSocialCursor(validCursor)).toEqual({
      createdAtIso: '2026-11-23T11:22:33.456789Z',
      publicId: '22222222-2222-4222-8222-222222222222',
    });

    // Từ chối UUIDv7 (không phải UUIDv4 public_id).
    const uuidV7Cursor = Buffer.from(
      JSON.stringify({
        t: '2026-11-23T11:22:33.456789Z',
        p: '0195a000-0000-7000-8000-000000000001',
      }),
      'utf8',
    ).toString('base64url');
    expect(decodeSocialCursor(uuidV7Cursor)).toBeNull();

    // Từ chối payload chứa field thừa.
    const extraFieldCursor = Buffer.from(
      JSON.stringify({
        t: '2026-11-23T11:22:33.456789Z',
        p: '22222222-2222-4222-8222-222222222222',
        id: 'leaked',
      }),
      'utf8',
    ).toString('base64url');
    expect(decodeSocialCursor(extraFieldCursor)).toBeNull();

    expect(decodeSocialCursor('not-valid-json')).toBeNull();
    expect(decodeSocialCursor('a'.repeat(300))).toBeNull();
  });

  it('cưỡng chế limit <= 30, từ chối tham số lạ (Mass Assignment) và kiểm tra publicId UUIDv4', () => {
    const defaultParsed = socialConnectionListQuerySchema.parse({});
    expect(defaultParsed.limit).toBe(SOCIAL_LIST_DEFAULT_LIMIT);
    expect(defaultParsed.cursor).toBeUndefined();
    expect(defaultParsed.q).toBeUndefined();

    const maxParsed = socialConnectionListQuerySchema.parse({
      limit: String(SOCIAL_LIST_MAX_LIMIT),
      q: '  @alice_01  ',
    });
    expect(maxParsed.limit).toBe(30);
    expect(maxParsed.q).toBe('alice_01');

    // Limit > 30 hoặc <= 0 bị từ chối.
    expect(socialConnectionListQuerySchema.safeParse({ limit: '31' }).success).toBe(false);
    expect(socialConnectionListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    // Field lạ bị từ chối bởi .strict().
    expect(socialConnectionListQuerySchema.safeParse({ limit: '10', userId: 'abc' }).success).toBe(
      false,
    );
    expect(socialSimpleListQuerySchema.safeParse({ limit: '10', q: 'unexpected' }).success).toBe(
      false,
    );

    // Privacy PATCH từ chối field lạ.
    expect(updatePrivacyInputSchema.safeParse({ isPrivate: true }).success).toBe(true);
    expect(
      updatePrivacyInputSchema.safeParse({ isPrivate: false, acceptPendingRequests: false })
        .success,
    ).toBe(true);
    expect(
      updatePrivacyInputSchema.safeParse({ isPrivate: false, followersCount: 999 }).success,
    ).toBe(false);

    // Path param chỉ chấp nhận UUIDv4.
    expect(publicIdRouteParamSchema.safeParse('22222222-2222-4222-8222-222222222222').success).toBe(
      true,
    );
    expect(publicIdRouteParamSchema.safeParse('0195a000-0000-7000-8000-000000000001').success).toBe(
      false,
    );
    expect(publicIdRouteParamSchema.safeParse('invalid-id').success).toBe(false);
  });
});
