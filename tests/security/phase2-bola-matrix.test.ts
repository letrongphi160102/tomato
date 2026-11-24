import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as callActionPost } from '@/app/api/v1/calls/[callPublicId]/action/route';
import { POST as callSignalPost } from '@/app/api/v1/calls/[callPublicId]/signal/route';
import { POST as iceServersPost } from '@/app/api/v1/calls/ice-servers/route';
import { POST as createCallPost } from '@/app/api/v1/calls/route';
import { POST as acceptConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/accept/route';
import { POST as uploadTokenPost } from '@/app/api/v1/conversations/[conversationPublicId]/attachments/upload-token/route';
import { POST as declineConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/decline/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { POST as readConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/read/route';
import { GET as pinsListGet } from '@/app/api/v1/conversations/[conversationPublicId]/pins/route';
import { PATCH as preferencesPatch } from '@/app/api/v1/conversations/[conversationPublicId]/preferences/route';
import {
  DELETE as conversationDelete,
  GET as conversationDetailGet,
} from '@/app/api/v1/conversations/[conversationPublicId]/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { GET as forwardTargetsGet } from '@/app/api/v1/conversations/forward-targets/route';
import { PUT as localChatMediaPut } from '@/app/api/v1/media/local/chat/[attachmentPublicId]/route';
import { GET as messageAttachmentGet } from '@/app/api/v1/messages/[messagePublicId]/attachment/route';
import { DELETE as messageDeleteForMe } from '@/app/api/v1/messages/[messagePublicId]/for-me/route';
import {
  DELETE as messagePinDelete,
  POST as messagePinPost,
} from '@/app/api/v1/messages/[messagePublicId]/pin/route';
import {
  DELETE as messageReactionDelete,
  PUT as messageReactionPut,
} from '@/app/api/v1/messages/[messagePublicId]/reaction/route';
import { POST as messageRecallPost } from '@/app/api/v1/messages/[messagePublicId]/recall/route';
import { PATCH as messageEditPatch } from '@/app/api/v1/messages/[messagePublicId]/route';
import { DELETE as notificationDelete } from '@/app/api/v1/notifications/[notificationPublicId]/route';
import { POST as notificationsReadPost } from '@/app/api/v1/notifications/read/route';
import { GET as notificationsGet } from '@/app/api/v1/notifications/route';
import { POST as presenceQueryPost } from '@/app/api/v1/presence/query/route';
import { POST as realtimeTokenPost } from '@/app/api/v1/realtime/token/route';
import { POST as blockPost } from '@/app/api/v1/social/blocks/[userPublicId]/route';
import { POST as followPost } from '@/app/api/v1/social/follow/[userPublicId]/route';
import { POST as acceptFollowRequestPost } from '@/app/api/v1/social/follow-requests/[userPublicId]/accept/route';
import { POST as declineFollowRequestPost } from '@/app/api/v1/social/follow-requests/[userPublicId]/decline/route';
import { GET as followersListGet } from '@/app/api/v1/social/users/[userPublicId]/followers/route';
import { GET as followingListGet } from '@/app/api/v1/social/users/[userPublicId]/following/route';
import { GET as userByHandleGet } from '@/app/api/v1/users/[handle]/route';
import { GET as searchUsersGet } from '@/app/api/v1/users/search/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import type { DatabaseTransaction } from '@/core/db';
import type {
  AttachmentMediaKind,
  CallSessionRow,
  ConversationInboxState,
  ConversationParticipantRow,
  ConversationRow,
  MessageAttachmentRow,
  MessageRow,
  SessionRow,
  UserRow,
} from '@/core/db/schema';
import {
  AblyRealtimeAdapter,
  InMemoryRealtimeAdapter,
  REALTIME_TOKEN_TTL_MS,
  resetRealtimeProviderForTesting,
  setRealtimeProviderForTesting,
  setRealtimeRateLimiterForTesting,
  type LocalRealtimeEventMessage,
} from '@/core/realtime';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import { InMemoryMediaStorageAdapter } from '@/core/storage';
import {
  StunFallbackTurnProvider,
  resetTurnCredentialProviderForTesting,
  setTurnCredentialProviderForTesting,
} from '@/core/webrtc';
import {
  clearMemoryKeystoreForTesting,
  encryptDirectMessage,
  encryptMediaBinary,
  getOrCreatePrimaryDeviceKeyMaterial,
} from '@/lib/e2ee';
import {
  resetSessionServiceForTesting,
  setSessionServiceForTesting,
  type AuthenticatedPrincipal,
  type SessionService,
} from '@/modules/auth';
import {
  CallSignalingService,
  InMemoryCallDeclineCooldownStore,
  resetCallSignalingServiceForTesting,
  setCallSignalingServiceForTesting,
  type CallRepository,
} from '@/modules/calls';
import {
  ChatService,
  resetChatServiceForTesting,
  setChatServiceForTesting,
  type ChatRepository,
} from '@/modules/chat';
import {
  NotificationService,
  resetNotificationServiceForTesting,
  setNotificationServiceForTesting,
  type NotificationRepository,
} from '@/modules/notifications';
import {
  PresenceService,
  buildPresenceRedisKey,
  resetPresenceServiceForTesting,
  setPresenceServiceForTesting,
  type PresenceRepository,
} from '@/modules/presence';
import {
  ProfileService,
  resetProfileServiceForTesting,
  setProfileServiceForTesting,
  type ProfileRepository,
} from '@/modules/profile';
import {
  EMPTY_SOCIAL_RELATIONSHIP,
  SocialService,
  resetSocialServiceForTesting,
  setSocialServiceForTesting,
  type SocialRelationshipSnapshot,
  type SocialRepository,
} from '@/modules/social';

const TEST_CSRF = 'synthetic-csrf-token-for-phase2-bola-matrix';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function createAllowAllRateLimiter() {
  return {
    consume: vi.fn().mockResolvedValue({
      allowed: true,
      limit: 60,
      remaining: 59,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 0,
    }),
  };
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-24T12:00:00.000Z');
  return {
    id: '0195c000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'alice_owner',
    handle: 'alice_owner',
    handleNormalized: 'alice_owner',
    fullName: 'Alice Owner',
    bio: 'Tiểu sử riêng tư của Alice',
    avatarUrl: null,
    avatarStorageKey: 'avatars/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp',
    isPrivate: true,
    showActiveStatus: true,
    showReadReceipts: true,
    followersCount: 1,
    followingCount: 1,
    handleChangedAt: null,
    gender: 'female',
    dateOfBirth: '1999-03-12',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrincipal(user: UserRow): AuthenticatedPrincipal {
  const now = new Date('2026-11-24T12:00:00.000Z');
  const session: SessionRow = {
    id: '0195c000-0000-7000-8000-000000000090',
    publicId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: user.id,
    familyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    refreshTokenHash: 'synthetic-hash',
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

function createAuthHeaders(
  origin: string,
  accessToken: string | null,
  options: { includeCsrf?: boolean; contentType?: string } = {},
): Record<string, string> {
  const includeCsrf = options.includeCsrf ?? true;
  const cookies = [
    ...(accessToken ? [`tomato_at=${accessToken}`] : []),
    `tomato_csrf=${TEST_CSRF}`,
  ];
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: cookies.join('; '),
    ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
    ...(includeCsrf ? { [CSRF_HEADER_NAME]: TEST_CSRF } : {}),
  };
}

/**
 * 5 nhân vật chuẩn kiểm thử ma trận BOLA Giai đoạn 2:
 * - User A: Chủ sở hữu tài nguyên / Người gọi (tài khoản Private)
 * - User B: Người theo dõi đã được duyệt & Bạn chat `primary` với A
 * - User C: Người bị A chặn 2 chiều (Block)
 * - User D: Người lạ ngoài cuộc (không theo dõi A, không nằm trong hội thoại A–B)
 * - Anon  : Chưa đăng nhập
 */
const userA = makeUserRow({
  id: '0195c000-0000-7000-8000-000000000001',
  publicId: '11111111-1111-4111-8111-111111111111',
  handle: 'alice_matrix',
  handleNormalized: 'alice_matrix',
  fullName: 'Alice Matrix',
  isPrivate: true,
});
const userB = makeUserRow({
  id: '0195c000-0000-7000-8000-000000000002',
  publicId: '22222222-2222-4222-8222-222222222222',
  handle: 'bob_peer',
  handleNormalized: 'bob_peer',
  fullName: 'Bob Peer',
  isPrivate: false,
});
const userC = makeUserRow({
  id: '0195c000-0000-7000-8000-000000000003',
  publicId: '33333333-3333-4333-8333-333333333333',
  handle: 'charlie_blocked',
  handleNormalized: 'charlie_blocked',
  fullName: 'Charlie Blocked',
  isPrivate: false,
});
const userD = makeUserRow({
  id: '0195c000-0000-7000-8000-000000000004',
  publicId: '44444444-4444-4444-8444-444444444444',
  handle: 'david_outsider',
  handleNormalized: 'david_outsider',
  fullName: 'David Outsider',
  isPrivate: false,
});

function installFiveActorSessions(overrides: Partial<Record<string, UserRow>> = {}) {
  const map: Record<string, AuthenticatedPrincipal> = {
    'tok-a': makePrincipal(overrides.a ?? userA),
    'tok-b': makePrincipal(overrides.b ?? userB),
    'tok-c': makePrincipal(overrides.c ?? userC),
    'tok-d': makePrincipal(overrides.d ?? userD),
  };
  setSessionServiceForTesting({
    authenticateAccessToken: vi.fn(async (token?: string | null) => {
      if (token && map[token]) {
        return map[token];
      }
      const { AuthDomainError } = await import('@/modules/auth/auth.errors');
      throw new AuthDomainError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Phiên đăng nhập không hợp lệ.',
      });
    }),
  } as unknown as SessionService);
}

afterEach(() => {
  resetSessionServiceForTesting();
  resetProfileServiceForTesting();
  resetSocialServiceForTesting();
  resetNotificationServiceForTesting();
  resetPresenceServiceForTesting();
  resetRealtimeProviderForTesting();
  resetChatServiceForTesting();
  resetCallSignalingServiceForTesting();
  resetTurnCredentialProviderForTesting();
  clearMemoryKeystoreForTesting();
  vi.restoreAllMocks();
});

describe('Security CI Matrix (M12): Ma trận BOLA 5 nhân vật (A/B/C/D/Anon) phủ toàn bộ 11 nhóm tính năng Giai đoạn 2', () => {
  it('Nhóm 1–4 (Profile, Search, Follow/Requests/Lists & Block): cưỡng chế ReBAC 404 đồng nhất cho Block/Private và chặn tự chặn 400', async () => {
    const origin = getTestOrigin();
    installFiveActorSessions();

    const usersById = new Map<string, UserRow>([
      [userA.id, userA],
      [userB.id, userB],
      [userC.id, userC],
      [userD.id, userD],
    ]);
    const usersByPublicId = new Map<string, UserRow>([
      [userA.publicId, userA],
      [userB.publicId, userB],
      [userC.publicId, userC],
      [userD.publicId, userD],
    ]);
    const usersByHandle = new Map<string, UserRow>([
      [userA.handleNormalized, userA],
      [userB.handleNormalized, userB],
      [userC.handleNormalized, userC],
      [userD.handleNormalized, userD],
    ]);

    const getRelationshipSnapshot = vi.fn(
      async (actorId: string, targetId: string): Promise<SocialRelationshipSnapshot> => {
        if (actorId === userA.id && targetId === userC.id) {
          return { ...EMPTY_SOCIAL_RELATIONSHIP, blockedByActor: true };
        }
        if (actorId === userC.id && targetId === userA.id) {
          return { ...EMPTY_SOCIAL_RELATIONSHIP, blockedByTarget: true };
        }
        if (actorId === userB.id && targetId === userA.id) {
          return { ...EMPTY_SOCIAL_RELATIONSHIP, actorFollowStatus: 'following' };
        }
        if (actorId === userA.id && targetId === userB.id) {
          return { ...EMPTY_SOCIAL_RELATIONSHIP, targetFollowStatus: 'following' };
        }
        return EMPTY_SOCIAL_RELATIONSHIP;
      },
    );

    const mockTx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    const mockSocialRepo = {
      findUserByPublicId: vi.fn(async (pid: string) => usersByPublicId.get(pid) ?? null),
      getRelationshipSnapshot,
      listFollowers: vi.fn(async () => [
        {
          publicId: userB.publicId,
          handle: userB.handle,
          fullName: userB.fullName,
          avatarUrl: null,
          isPrivate: false,
          viewerFollowStatus: 'none' as const,
          followedBy: false,
          isSelf: false,
          cursorCreatedAtIso: '2026-11-24T10:00:00.000000Z',
        },
      ]),
      listFollowing: vi.fn(async () => []),
      findFollowRow: vi.fn(async () => null),
      upgradePendingFollowToFollowing: vi.fn(async () => false),
      deleteFollowRow: vi.fn(async () => null),
      getDb: vi.fn(() => ({
        transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(mockTx),
      })),
      lockUsersInCanonicalOrder: vi.fn(async (ids: string[]) => {
        const m = new Map<string, UserRow>();
        for (const id of ids) {
          const u = usersById.get(id);
          if (u) m.set(id, u);
        }
        return m;
      }),
    } as unknown as SocialRepository;

    const mockProfileRepo = {
      findUserByHandleNormalized: vi.fn(async (h: string) => usersByHandle.get(h) ?? null),
      searchActiveUsers: vi.fn(async (params: { readonly viewerUserId: string }) => {
        // Loại bỏ người có quan hệ chặn 2 chiều (A <-> C).
        return Array.from(usersById.values())
          .filter((u) => {
            if (params.viewerUserId === userA.id && u.id === userC.id) return false;
            if (params.viewerUserId === userC.id && u.id === userA.id) return false;
            return true;
          })
          .map((u) => ({
            publicId: u.publicId,
            handle: u.handle,
            fullName: u.fullName,
            avatarUrl: u.avatarUrl,
            isPrivate: u.isPrivate,
          }));
      }),
    } as unknown as ProfileRepository;

    setSocialServiceForTesting(
      new SocialService({
        repository: mockSocialRepo,
        rateLimiter: createAllowAllRateLimiter() as never,
      }),
    );
    setProfileServiceForTesting(
      new ProfileService({
        repository: mockProfileRepo,
        socialRepository: mockSocialRepo,
        rateLimiter: createAllowAllRateLimiter() as never,
      }),
    );

    // Nhóm 1 (Profile): Anon -> 401; A & B -> 200 (full); C (blocked) -> 404; D (stranger) -> 200 vỏ Private (canViewFullProfile = false, ẩn bio).
    const anonProfile = await userByHandleGet(
      new Request(`${origin}/api/v1/users/${userA.handle}`),
      {
        params: Promise.resolve({ handle: userA.handle }),
      },
    );
    expect(anonProfile.status).toBe(401);
    expect(anonProfile.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);

    const bProfile = await userByHandleGet(
      new Request(`${origin}/api/v1/users/${userA.handle}`, {
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ handle: userA.handle }) },
    );
    expect(bProfile.status).toBe(200);
    const bProfileText = await bProfile.text();
    expect(bProfileText).not.toContain(userA.id);
    expect(bProfileText).not.toContain('avatarStorageKey');

    const cProfile = await userByHandleGet(
      new Request(`${origin}/api/v1/users/${userA.handle}`, {
        headers: createAuthHeaders(origin, 'tok-c'),
      }),
      { params: Promise.resolve({ handle: userA.handle }) },
    );
    expect(cProfile.status).toBe(404);

    const dProfile = await userByHandleGet(
      new Request(`${origin}/api/v1/users/${userA.handle}`, {
        headers: createAuthHeaders(origin, 'tok-d'),
      }),
      { params: Promise.resolve({ handle: userA.handle }) },
    );
    expect(dProfile.status).toBe(200);
    const dProfileJson = (await dProfile.json()) as {
      profile: { isPrivate: boolean; canViewConnections: boolean; followedBy: boolean };
    };
    expect(dProfileJson.profile.isPrivate).toBe(true);
    expect(dProfileJson.profile.canViewConnections).toBe(false);
    expect(dProfileJson.profile.followedBy).toBe(false);

    // Nhóm 2 (Search): Anon -> 401; A không bao giờ thấy C (đã chặn) và không tìm theo email.
    expect(
      (await searchUsersGet(new Request(`${origin}/api/v1/users/search?q=charlie`))).status,
    ).toBe(401);
    const aSearch = await searchUsersGet(
      new Request(`${origin}/api/v1/users/search?q=charlie`, {
        headers: createAuthHeaders(origin, 'tok-a'),
      }),
    );
    expect(aSearch.status).toBe(200);
    const aSearchJson = (await aSearch.json()) as { items: Array<{ public_id: string }> };
    expect(aSearchJson.items.some((i) => i.public_id === userC.publicId)).toBe(false);

    // Nhóm 3 (Follow/Requests/Lists): B được duyệt xem danh sách của A -> 200; C (blocked) & D (stranger) -> 404 đồng nhất.
    expect(
      (
        await followersListGet(
          new Request(`${origin}/api/v1/social/users/${userA.publicId}/followers`),
          { params: Promise.resolve({ userPublicId: userA.publicId }) },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await followersListGet(
          new Request(`${origin}/api/v1/social/users/${userA.publicId}/followers`, {
            headers: createAuthHeaders(origin, 'tok-b'),
          }),
          { params: Promise.resolve({ userPublicId: userA.publicId }) },
        )
      ).status,
    ).toBe(200);
    for (const tok of ['tok-c', 'tok-d'] as const) {
      expect(
        (
          await followersListGet(
            new Request(`${origin}/api/v1/social/users/${userA.publicId}/followers`, {
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ userPublicId: userA.publicId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await followingListGet(
            new Request(`${origin}/api/v1/social/users/${userA.publicId}/following`, {
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ userPublicId: userA.publicId }) },
          )
        ).status,
      ).toBe(404);
    }

    // C cố follow A -> 404; D cố chấp nhận/từ chối lời mời theo dõi thay A -> 404.
    expect(
      (
        await followPost(
          new Request(`${origin}/api/v1/social/follow/${userA.publicId}`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-c'),
          }),
          { params: Promise.resolve({ userPublicId: userA.publicId }) },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await acceptFollowRequestPost(
          new Request(`${origin}/api/v1/social/follow-requests/${userB.publicId}/accept`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-d'),
          }),
          { params: Promise.resolve({ userPublicId: userB.publicId }) },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await declineFollowRequestPost(
          new Request(`${origin}/api/v1/social/follow-requests/${userB.publicId}/decline`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-d'),
          }),
          { params: Promise.resolve({ userPublicId: userB.publicId }) },
        )
      ).status,
    ).toBe(404);

    // Nhóm 4 (Block): Tự chặn chính mình -> 400; C bị A chặn cố chặn ngược A -> 404; thiếu CSRF -> 403.
    expect(
      (
        await blockPost(
          new Request(`${origin}/api/v1/social/blocks/${userA.publicId}`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { includeCsrf: false }),
          }),
          { params: Promise.resolve({ userPublicId: userA.publicId }) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await blockPost(
          new Request(`${origin}/api/v1/social/blocks/${userA.publicId}`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a'),
          }),
          { params: Promise.resolve({ userPublicId: userA.publicId }) },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await blockPost(
          new Request(`${origin}/api/v1/social/blocks/${userA.publicId}`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-c'),
          }),
          { params: Promise.resolve({ userPublicId: userA.publicId }) },
        )
      ).status,
    ).toBe(404);
  });

  it('Nhóm 5–7 (Notifications, Realtime Token & Presence): cô lập thông báo 404, token subscribe-only & Presence đối xứng', async () => {
    const origin = getTestOrigin();
    const nowMs = 1_764_000_000_000;
    installFiveActorSessions();

    const notifOwnedByA = '55555555-5555-4555-8555-555555555555';
    const records = new Map<string, { publicId: string; recipientId: string; readAt: Date | null }>(
      [[notifOwnedByA, { publicId: notifOwnedByA, recipientId: userA.id, readAt: null }]],
    );
    const notifRepo: Partial<NotificationRepository> = {
      getDb: () => ({ transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}) }) as never,
      listForRecipient: vi.fn(async () => [
        {
          publicId: notifOwnedByA,
          type: 'new_follower' as const,
          entityPublicId: null,
          readAt: null,
          createdAt: new Date(nowMs),
          cursorCreatedAtIso: '2026-11-24T12:00:00.000000Z',
          actorPublicId: userB.publicId,
          actorHandle: userB.handle,
          actorFullName: userB.fullName,
          actorAvatarUrl: null,
          actorIsPrivate: false,
          followRequestPending: false,
        },
      ]),
      countUnreadForRecipient: vi.fn(async (recipientId: string) =>
        recipientId === userA.id && records.has(notifOwnedByA) ? 1 : 0,
      ),
      markReadForRecipient: vi.fn(async (recipientId: string) =>
        recipientId === userA.id ? [notifOwnedByA] : [],
      ),
      deleteOneForRecipient: vi.fn(async (recipientId: string, publicId: string) => {
        const found = records.get(publicId);
        if (!found || found.recipientId !== recipientId) return null;
        records.delete(publicId);
        return found;
      }),
    };
    setNotificationServiceForTesting(
      new NotificationService({
        repository: notifRepo as NotificationRepository,
        rateLimiter: createAllowAllRateLimiter(),
        realtimeProvider: new InMemoryRealtimeAdapter({ isolated: true }),
      }),
    );

    // Nhóm 5 (Notifications): Anon -> 401; B/C/D cố xóa thông báo của A -> 404 đồng nhất; A xóa được -> 200.
    expect((await notificationsGet(new Request(`${origin}/api/v1/notifications`))).status).toBe(
      401,
    );
    expect(
      (
        await notificationsReadPost(
          new Request(`${origin}/api/v1/notifications/read`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', {
              includeCsrf: false,
              contentType: 'application/json',
            }),
            body: JSON.stringify({ markAll: true }),
          }),
        )
      ).status,
    ).toBe(403);
    for (const tok of ['tok-b', 'tok-c', 'tok-d'] as const) {
      expect(
        (
          await notificationDelete(
            new Request(`${origin}/api/v1/notifications/${notifOwnedByA}`, {
              method: 'DELETE',
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ notificationPublicId: notifOwnedByA }) },
          )
        ).status,
      ).toBe(404);
    }
    expect(records.has(notifOwnedByA)).toBe(true);
    expect(
      (
        await notificationDelete(
          new Request(`${origin}/api/v1/notifications/${notifOwnedByA}`, {
            method: 'DELETE',
            headers: createAuthHeaders(origin, 'tok-a'),
          }),
          { params: Promise.resolve({ notificationPublicId: notifOwnedByA }) },
        )
      ).status,
    ).toBe(200);

    // Nhóm 6 (Realtime Token): Anon -> 401; thiếu CSRF -> 403; gửi channel giả -> 400; hợp lệ -> subscribe-only user:{A}.
    setRealtimeRateLimiterForTesting(createAllowAllRateLimiter());
    setRealtimeProviderForTesting(
      new AblyRealtimeAdapter({
        apiKey: 'syntheticApp.syntheticKey:syntheticSecretValueNotReal',
        client: {
          auth: {
            createTokenRequest: vi.fn(async (params: Record<string, unknown>) => ({
              keyName: 'syntheticApp.syntheticKey',
              ttl: Number(params.ttl),
              timestamp: nowMs,
              capability: String(params.capability),
              clientId: String(params.clientId),
              nonce: 'synthetic-nonce',
              mac: 'synthetic-mac',
            })),
          },
          channels: { get: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(undefined) })) },
        } as never,
      }),
    );

    expect(
      (
        await realtimeTokenPost(
          new Request(`${origin}/api/v1/realtime/token`, {
            method: 'POST',
            headers: createAuthHeaders(origin, null, { contentType: 'application/json' }),
            body: '{}',
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await realtimeTokenPost(
          new Request(`${origin}/api/v1/realtime/token`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', {
              includeCsrf: false,
              contentType: 'application/json',
            }),
            body: '{}',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await realtimeTokenPost(
          new Request(`${origin}/api/v1/realtime/token`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({ channel: `user:${userB.publicId}` }),
          }),
        )
      ).status,
    ).toBe(400);

    const tokenRes = await realtimeTokenPost(
      new Request(`${origin}/api/v1/realtime/token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: '{}',
      }),
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const tokenJson = (await tokenRes.json()) as {
      channel: string;
      ttlMs: number;
      tokenRequest: { capability: string };
    };
    expect(tokenJson.channel).toBe(`user:${userA.publicId}`);
    expect(tokenJson.ttlMs).toBe(REALTIME_TOKEN_TTL_MS);
    expect(JSON.parse(tokenJson.tokenRequest.capability)).toEqual({
      [`user:${userA.publicId}`]: ['subscribe'],
    });

    // Nhóm 7 (Presence): A thấy B online; C (blocked) & D (stranger) -> null đồng nhất; A tắt -> đối xứng 2 chiều null.
    const mutableUsers = new Map<string, UserRow>([
      [userA.id, { ...userA }],
      [userB.id, { ...userB }],
      [userC.id, { ...userC }],
      [userD.id, { ...userD }],
    ]);
    const redisStore = new Map<string, string>([
      [buildPresenceRedisKey(userA.id), String(nowMs - 15_000)],
      [buildPresenceRedisKey(userB.id), String(nowMs - 15_000)],
      [buildPresenceRedisKey(userC.id), String(nowMs - 15_000)],
      [buildPresenceRedisKey(userD.id), String(nowMs - 15_000)],
    ]);
    setPresenceServiceForTesting(
      new PresenceService({
        repository: {
          findUserPresenceRecordById: vi.fn(async (id: string) => mutableUsers.get(id) ?? null),
          findUsersPresenceRecordsByPublicIds: vi.fn(async (pids: readonly string[]) =>
            Array.from(mutableUsers.values()).filter((u) => pids.includes(u.publicId)),
          ),
          findBlockedPeerIds: vi.fn(async (vid: string) =>
            vid === userA.id
              ? new Set([userC.id])
              : vid === userC.id
                ? new Set([userA.id])
                : new Set(),
          ),
          findMutualFollowPeerIds: vi.fn(async (vid: string) =>
            vid === userA.id
              ? new Set([userB.id])
              : vid === userB.id
                ? new Set([userA.id])
                : new Set(),
          ),
          findPrimaryConversationPeerIds: vi.fn(async () => new Set<string>()),
        } as unknown as PresenceRepository,
        redis: {
          get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
          mget: vi.fn(async (...ks: string[]) => ks.map((k) => redisStore.get(k) ?? null)),
          set: vi.fn(async () => 'OK' as const),
          del: vi.fn(async () => 1),
        },
        rateLimiter: createAllowAllRateLimiter(),
        now: () => nowMs,
      }),
    );

    const pRes = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ userPublicIds: [userB.publicId, userC.publicId, userD.publicId] }),
      }),
    );
    expect(pRes.status).toBe(200);
    const pJson = (await pRes.json()) as {
      presences: Record<string, { isOnline: boolean } | null>;
    };
    expect(pJson.presences[userB.publicId]?.isOnline).toBe(true);
    expect(pJson.presences[userC.publicId]).toBeNull();
    expect(pJson.presences[userD.publicId]).toBeNull();

    // Đối xứng khi A tắt trạng thái hoạt động: cả A->B lẫn B->A đều null.
    mutableUsers.set(userA.id, { ...userA, showActiveStatus: false });
    const pSymB = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
        body: JSON.stringify({ userPublicIds: [userA.publicId] }),
      }),
    );
    const pSymBJson = (await pSymB.json()) as { presences: Record<string, unknown> };
    expect(pSymBJson.presences[userA.publicId]).toBeNull();
  });

  it('Nhóm 8–10 (Conversations/Pending, Messages & Encrypted Media): cưỡng chế BOLA 404, hạn mức 3 tin chờ, cấm media khi chờ, giới hạn 5 phút & bảo vệ call_event', async () => {
    const origin = getTestOrigin();
    let currentNow = new Date('2026-11-24T12:00:00.000Z');
    installFiveActorSessions();

    const usersById = new Map<string, UserRow>([
      [userA.id, userA],
      [userB.id, userB],
      [userC.id, userC],
      [userD.id, userD],
    ]);
    const conversationsById = new Map<string, ConversationRow>();
    const participantsByConv = new Map<string, ConversationParticipantRow[]>();
    const messagesById = new Map<string, MessageRow>();
    const attachmentsById = new Map<string, MessageAttachmentRow>();
    const deletions = new Set<string>();
    const storage = new InMemoryMediaStorageAdapter();
    const realtime = new InMemoryRealtimeAdapter({ isolated: true });

    const chatRepo: Partial<ChatRepository> = {
      runInRlsTx: async <T>(_actorId: string, fn: (tx: DatabaseTransaction) => Promise<T>) =>
        fn({} as DatabaseTransaction),
      getDatabaseNow: vi.fn(async () => currentNow),
      findUserByPublicId: vi.fn(async (pid: string) => {
        for (const u of usersById.values()) if (u.publicId === pid) return u;
        return null;
      }),
      findUserById: vi.fn(async (uid: string) => usersById.get(uid) ?? null),
      lockUsersInCanonicalOrder: vi.fn(async (uids: readonly string[]) => {
        const m = new Map<string, UserRow>();
        for (const id of uids) {
          const u = usersById.get(id);
          if (u) m.set(id, u);
        }
        return m;
      }),
      getRelationshipSnapshot: vi.fn(
        async (actorId: string, targetId: string): Promise<SocialRelationshipSnapshot> => {
          if (
            (actorId === userA.id && targetId === userC.id) ||
            (actorId === userC.id && targetId === userA.id)
          ) {
            return {
              ...EMPTY_SOCIAL_RELATIONSHIP,
              blockedByActor: actorId === userA.id,
              blockedByTarget: targetId === userA.id,
            };
          }
          // B follows A -> hội thoại A-B vào `primary`; D không follow A -> hội thoại A-D ở `pending`.
          if (actorId === userA.id && targetId === userB.id) {
            return { ...EMPTY_SOCIAL_RELATIONSHIP, targetFollowStatus: 'following' };
          }
          if (actorId === userB.id && targetId === userA.id) {
            return { ...EMPTY_SOCIAL_RELATIONSHIP, actorFollowStatus: 'following' };
          }
          return EMPTY_SOCIAL_RELATIONSHIP;
        },
      ),
      insertOrLockDirectConversation: vi.fn(async (pairKey: string, createdAt: Date) => {
        for (const c of conversationsById.values()) {
          if (c.directPairKey === pairKey) return { conversation: c, isNewlyCreated: false };
        }
        const conv: ConversationRow = {
          id: generateUuidV7(),
          publicId: generatePublicId(),
          type: 'direct',
          directPairKey: pairKey,
          lastSeq: 0,
          lastMessageAt: null,
          createdAt,
        };
        conversationsById.set(conv.id, conv);
        return { conversation: conv, isNewlyCreated: true };
      }),
      findConversationByPublicId: vi.fn(async (pid: string) => {
        for (const c of conversationsById.values()) if (c.publicId === pid) return c;
        return null;
      }),
      findConversationById: vi.fn(async (cid: string) => conversationsById.get(cid) ?? null),
      lockConversationByPublicId: vi.fn(async (pid: string) => {
        for (const c of conversationsById.values()) if (c.publicId === pid) return c;
        return null;
      }),
      listConversationParticipants: vi.fn(async (cid: string) => participantsByConv.get(cid) ?? []),
      lockConversationParticipants: vi.fn(async (cid: string) => participantsByConv.get(cid) ?? []),
      insertConversationParticipants: vi.fn(
        async (
          rows: readonly {
            readonly conversationId: string;
            readonly userId: string;
            readonly inboxState: ConversationInboxState;
            readonly pendingMessagesSent: number;
            readonly joinedAt: Date;
          }[],
        ) => {
          const created: ConversationParticipantRow[] = rows.map((r) => ({
            conversationId: r.conversationId,
            userId: r.userId,
            inboxState: r.inboxState,
            pendingMessagesSent: r.pendingMessagesSent,
            lastReadSeq: 0,
            clearedBeforeSeq: 0,
            hiddenAt: null,
            pinnedAt: null,
            mutedAt: null,
            joinedAt: r.joinedAt,
          }));
          if (rows[0]) participantsByConv.set(rows[0].conversationId, created);
          return created;
        },
      ),
      updateParticipantState: vi.fn(async (cid, uid, patch) => {
        const list = participantsByConv.get(cid) ?? [];
        let updated: ConversationParticipantRow | null = null;
        const nextList: ConversationParticipantRow[] = list.map((p) => {
          if (p.userId === uid) {
            const merged: ConversationParticipantRow = { ...p, ...patch };
            updated = merged;
            return merged;
          }
          return p;
        });
        participantsByConv.set(cid, nextList);
        return updated;
      }),
      findMessageByClientMsgId: vi.fn(async (cid, uid, clientMsgId) => {
        for (const m of messagesById.values()) {
          if (m.conversationId === cid && m.senderId === uid && m.clientMsgId === clientMsgId) {
            return m;
          }
        }
        return null;
      }),
      findMessageByPublicId: vi.fn(async (pid: string) => {
        for (const m of messagesById.values()) {
          if (m.publicId === pid) {
            return { row: m, senderPublicId: usersById.get(m.senderId)!.publicId };
          }
        }
        return null;
      }),
      lockMessageByPublicId: vi.fn(async (pid: string) => {
        for (const m of messagesById.values()) if (m.publicId === pid) return m;
        return null;
      }),
      isMessageDeletedForUser: vi.fn(async (mid: string, uid: string) =>
        deletions.has(`${mid}:${uid}`),
      ),
      insertMessageAndIncrementSeq: vi.fn(async (input) => {
        const conv = conversationsById.get(input.conversationId)!;
        conversationsById.set(conv.id, {
          ...conv,
          lastSeq: input.nextSeq,
          lastMessageAt: input.now,
        });
        const msg: MessageRow = {
          id: generateUuidV7(),
          publicId: generatePublicId(),
          conversationId: input.conversationId,
          senderId: input.senderId,
          seq: input.nextSeq,
          clientMsgId: input.clientMsgId,
          messageType: input.messageType,
          ciphertext: input.ciphertext,
          cryptoHeader: input.cryptoHeader,
          callEventMeta: null,
          attachmentStorageKey: input.attachmentStorageKey ?? null,
          replyToMessageId: input.replyToMessageId ?? null,
          isForwarded: input.isForwarded === true,
          editCount: 0,
          editedAt: null,
          recalledAt: null,
          createdAt: input.now,
        };
        messagesById.set(msg.id, msg);
        return msg;
      }),
      recallMessageAtomically: vi.fn(async (input) => {
        const existing = messagesById.get(input.messageId);
        if (
          !existing ||
          existing.senderId !== input.senderId ||
          existing.messageType === 'call_event'
        ) {
          return null;
        }
        if (currentNow.getTime() - existing.createdAt.getTime() > input.recallWindowMs) return null;
        const updated: MessageRow = {
          ...existing,
          ciphertext: null,
          cryptoHeader: null,
          attachmentStorageKey: null,
          recalledAt: currentNow,
        };
        messagesById.set(existing.id, updated);
        return updated;
      }),
      insertPendingAttachment: vi.fn(
        async (input: {
          readonly conversationId: string;
          readonly uploaderId: string;
          readonly mediaKind: AttachmentMediaKind;
          readonly storageKey: string;
          readonly ciphertextSizeBytes: number;
          readonly ciphertextSha256: string;
          readonly now: Date;
        }) => {
          const row: MessageAttachmentRow = {
            id: generateUuidV7(),
            publicId: generatePublicId(),
            conversationId: input.conversationId,
            uploaderId: input.uploaderId,
            messageId: null,
            mediaKind: input.mediaKind,
            storageKey: input.storageKey,
            storageUrl: null,
            ciphertextSizeBytes: input.ciphertextSizeBytes,
            ciphertextSha256: input.ciphertextSha256,
            deletedAt: null,
            createdAt: input.now,
          };
          attachmentsById.set(row.id, row);
          return row;
        },
      ),
      findAttachmentByPublicId: vi.fn(async (pid: string) => {
        for (const a of attachmentsById.values()) if (a.publicId === pid) return a;
        return null;
      }),
      lockAttachmentByPublicId: vi.fn(async (pid: string) => {
        for (const a of attachmentsById.values()) if (a.publicId === pid) return a;
        return null;
      }),
      markAttachmentStorageUrlUploaded: vi.fn(async (params) => {
        const existing = attachmentsById.get(params.attachmentId);
        if (!existing || existing.uploaderId !== params.uploaderId) return null;
        const updated: MessageAttachmentRow = { ...existing, storageUrl: params.storageUrl };
        attachmentsById.set(existing.id, updated);
        return updated;
      }),
      bindAttachmentToMessageAtomically: vi.fn(async (input) => {
        const existing = attachmentsById.get(input.attachmentId);
        if (
          !existing ||
          existing.conversationId !== input.conversationId ||
          existing.uploaderId !== input.uploaderId ||
          existing.messageId !== null
        ) {
          return null;
        }
        const updated: MessageAttachmentRow = {
          ...existing,
          messageId: input.messageId,
          storageUrl: input.storageUrl,
        };
        attachmentsById.set(existing.id, updated);
        return updated;
      }),
      findActiveAttachmentByMessageId: vi.fn(async (mid: string) => {
        for (const a of attachmentsById.values()) {
          if (a.messageId === mid && a.deletedAt === null) return a;
        }
        return null;
      }),
      softDeleteAttachmentsByMessageId: vi.fn(async (params) => {
        const removed: MessageAttachmentRow[] = [];
        for (const a of attachmentsById.values()) {
          if (
            a.messageId === params.messageId &&
            a.uploaderId === params.uploaderId &&
            a.deletedAt === null
          ) {
            const updated: MessageAttachmentRow = { ...a, deletedAt: currentNow };
            attachmentsById.set(a.id, updated);
            removed.push(updated);
          }
        }
        return removed;
      }),
      claimExpiredPendingAttachmentsForUser: vi.fn(async () => []),
      findLatestVisibleMessageForConversation: vi.fn(async () => null),
    };

    setChatServiceForTesting(
      new ChatService({
        repository: chatRepo as ChatRepository,
        rateLimiter: createAllowAllRateLimiter(),
        realtimeProvider: realtime,
        notificationService: null,
        mediaStorageProvider: storage,
        now: () => currentNow,
      }),
    );

    // Tạo hội thoại A-B (primary) & A-D (pending), A cố tạo với C (blocked) -> 404.
    expect(
      (
        await directConversationPost(
          new Request(`${origin}/api/v1/conversations/direct`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({ recipientPublicId: userC.publicId }),
          }),
        )
      ).status,
    ).toBe(404);

    const abConvId = (
      (await (
        await directConversationPost(
          new Request(`${origin}/api/v1/conversations/direct`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({ recipientPublicId: userB.publicId }),
          }),
        )
      ).json()) as { conversation: { public_id: string } }
    ).conversation.public_id;

    const adConvId = (
      (await (
        await directConversationPost(
          new Request(`${origin}/api/v1/conversations/direct`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({ recipientPublicId: userD.publicId }),
          }),
        )
      ).json()) as { conversation: { public_id: string } }
    ).conversation.public_id;

    // BOLA trên hội thoại A-B: Anon -> 401; C & D -> 404 đồng nhất trên mọi endpoint hội thoại.
    expect(
      (
        await conversationDetailGet(new Request(`${origin}/api/v1/conversations/${abConvId}`), {
          params: Promise.resolve({ conversationPublicId: abConvId }),
        })
      ).status,
    ).toBe(401);
    for (const tok of ['tok-c', 'tok-d'] as const) {
      expect(
        (
          await conversationDetailGet(
            new Request(`${origin}/api/v1/conversations/${abConvId}`, {
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await messagesGet(
            new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await acceptConversationPost(
            new Request(`${origin}/api/v1/conversations/${abConvId}/accept`, {
              method: 'POST',
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await declineConversationPost(
            new Request(`${origin}/api/v1/conversations/${abConvId}/decline`, {
              method: 'POST',
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await readConversationPost(
            new Request(`${origin}/api/v1/conversations/${abConvId}/read`, {
              method: 'POST',
              headers: createAuthHeaders(origin, tok, { contentType: 'application/json' }),
              body: JSON.stringify({ lastReadSeq: 1 }),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await conversationDelete(
            new Request(`${origin}/api/v1/conversations/${abConvId}`, {
              method: 'DELETE',
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
    }

    // Tin nhắn đang chờ (A->D): tối đa 3 tin text, tin thứ 4 -> 403; xin upload-token ảnh/thoại -> 403.
    const aMat = await getOrCreatePrimaryDeviceKeyMaterial(userA.publicId);
    const bMat = await getOrCreatePrimaryDeviceKeyMaterial(userB.publicId);
    const dMat = await getOrCreatePrimaryDeviceKeyMaterial(userD.publicId);

    for (let i = 1; i <= 4; i += 1) {
      const clientMsgId = `pending-${i}`;
      const enc = await encryptDirectMessage({
        conversationPublicId: adConvId,
        senderPublicId: userA.publicId,
        clientMsgId,
        plaintext: `Chờ ${i}`,
        senderDevice: aMat,
        recipientDevices: [
          {
            devicePublicId: generatePublicId(),
            keyFingerprint: dMat.keyFingerprint,
            identityPublicKeyJwk: dMat.identityPublicKeyJwk,
            signingPublicKeyJwk: dMat.signingPublicKeyJwk,
          },
        ],
      });
      const res = await messagesPost(
        new Request(`${origin}/api/v1/conversations/${adConvId}/messages`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
          body: JSON.stringify({
            clientMsgId,
            messageType: 'text',
            ciphertext: enc.ciphertext,
            cryptoHeader: enc.cryptoHeader,
          }),
        }),
        { params: Promise.resolve({ conversationPublicId: adConvId }) },
      );
      expect(res.status).toBe(i <= 3 ? 201 : 403);
    }

    const pendingMediaRes = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${adConvId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({
          mediaKind: 'image',
          ciphertextSizeBytes: 512,
          ciphertextSha256: 'a'.repeat(64),
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: adConvId }) },
    );
    expect(pendingMediaRes.status).toBe(403);

    // Nhóm 9 & 10 trên hội thoại A-B: gửi tin text & media E2EE, kiểm tra BOLA 404 & giới hạn 5 phút.
    const encMsg = await encryptDirectMessage({
      conversationPublicId: abConvId,
      senderPublicId: userA.publicId,
      clientMsgId: 'msg-ab-1',
      plaintext: 'Tin nhắn bí mật A->B',
      senderDevice: aMat,
      recipientDevices: [
        {
          devicePublicId: generatePublicId(),
          keyFingerprint: bMat.keyFingerprint,
          identityPublicKeyJwk: bMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bMat.signingPublicKeyJwk,
        },
      ],
    });
    const sendTextRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({
          clientMsgId: 'msg-ab-1',
          messageType: 'text',
          ciphertext: encMsg.ciphertext,
          cryptoHeader: encMsg.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: abConvId }) },
    );
    expect(sendTextRes.status).toBe(201);
    const textMsgId = ((await sendTextRes.json()) as { message: { public_id: string } }).message
      .public_id;

    // B (thành viên hội thoại nhưng không phải người gửi) cố sửa/thu hồi tin nhắn của A -> 403;
    // C (bị chặn) & D (ngoài cuộc) cố sửa/thu hồi/xóa 1 phía -> 404 đồng nhất.
    expect(
      (
        await messageEditPatch(
          new Request(`${origin}/api/v1/messages/${textMsgId}`, {
            method: 'PATCH',
            headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
            body: JSON.stringify({
              ciphertext: encMsg.ciphertext,
              cryptoHeader: encMsg.cryptoHeader,
            }),
          }),
          { params: Promise.resolve({ messagePublicId: textMsgId }) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await messageRecallPost(
          new Request(`${origin}/api/v1/messages/${textMsgId}/recall`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-b'),
          }),
          { params: Promise.resolve({ messagePublicId: textMsgId }) },
        )
      ).status,
    ).toBe(403);
    for (const outsiderTok of ['tok-c', 'tok-d'] as const) {
      expect(
        (
          await messageEditPatch(
            new Request(`${origin}/api/v1/messages/${textMsgId}`, {
              method: 'PATCH',
              headers: createAuthHeaders(origin, outsiderTok, {
                contentType: 'application/json',
              }),
              body: JSON.stringify({
                ciphertext: encMsg.ciphertext,
                cryptoHeader: encMsg.cryptoHeader,
              }),
            }),
            { params: Promise.resolve({ messagePublicId: textMsgId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await messageRecallPost(
            new Request(`${origin}/api/v1/messages/${textMsgId}/recall`, {
              method: 'POST',
              headers: createAuthHeaders(origin, outsiderTok),
            }),
            { params: Promise.resolve({ messagePublicId: textMsgId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await messageDeleteForMe(
            new Request(`${origin}/api/v1/messages/${textMsgId}/for-me`, {
              method: 'DELETE',
              headers: createAuthHeaders(origin, outsiderTok),
            }),
            { params: Promise.resolve({ messagePublicId: textMsgId }) },
          )
        ).status,
      ).toBe(404);
      // Nhóm 12 (M13 Interactions): C & D bị chặn 404 đồng nhất trên reaction, pin, pins, preferences.
      expect(
        (
          await messageReactionPut(
            new Request(`${origin}/api/v1/messages/${textMsgId}/reaction`, {
              method: 'PUT',
              headers: createAuthHeaders(origin, outsiderTok, {
                contentType: 'application/json',
              }),
              body: JSON.stringify({ emoji: '❤️' }),
            }),
            { params: Promise.resolve({ messagePublicId: textMsgId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await messageReactionDelete(
            new Request(`${origin}/api/v1/messages/${textMsgId}/reaction`, {
              method: 'DELETE',
              headers: createAuthHeaders(origin, outsiderTok),
            }),
            { params: Promise.resolve({ messagePublicId: textMsgId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await messagePinPost(
            new Request(`${origin}/api/v1/messages/${textMsgId}/pin`, {
              method: 'POST',
              headers: createAuthHeaders(origin, outsiderTok, {
                contentType: 'application/json',
              }),
              body: '{}',
            }),
            { params: Promise.resolve({ messagePublicId: textMsgId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await messagePinDelete(
            new Request(`${origin}/api/v1/messages/${textMsgId}/pin`, {
              method: 'DELETE',
              headers: createAuthHeaders(origin, outsiderTok),
            }),
            { params: Promise.resolve({ messagePublicId: textMsgId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await pinsListGet(
            new Request(`${origin}/api/v1/conversations/${abConvId}/pins`, {
              headers: createAuthHeaders(origin, outsiderTok),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await preferencesPatch(
            new Request(`${origin}/api/v1/conversations/${abConvId}/preferences`, {
              method: 'PATCH',
              headers: createAuthHeaders(origin, outsiderTok, {
                contentType: 'application/json',
              }),
              body: JSON.stringify({ muted: true }),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
    }

    // Forward targets endpoint: Anon -> 401.
    expect(
      (await forwardTargetsGet(new Request(`${origin}/api/v1/conversations/forward-targets`)))
        .status,
    ).toBe(401);

    // Tải ảnh E2EE lên hội thoại primary A-B:
    const mediaBlob = await encryptMediaBinary({
      plainBytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      conversationPublicId: abConvId,
      senderPublicId: userA.publicId,
      clientMsgId: 'msg-ab-media-1',
      mediaKind: 'image',
    });
    const shaHex = sha256Hex(mediaBlob.ciphertextBytes);
    const tokenMediaRes = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${abConvId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({
          mediaKind: 'image',
          ciphertextSizeBytes: mediaBlob.ciphertextBytes.byteLength,
          ciphertextSha256: shaHex,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: abConvId }) },
    );
    expect(tokenMediaRes.status).toBe(201);
    const uploadGrant = (await tokenMediaRes.json()) as {
      attachmentPublicId: string;
      uploadUrl: string;
    };

    const putRes = await localChatMediaPut(
      new Request(`${origin}${uploadGrant.uploadUrl}`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/octet-stream' }),
        body: Buffer.from(mediaBlob.ciphertextBytes),
      }),
      { params: Promise.resolve({ attachmentPublicId: uploadGrant.attachmentPublicId }) },
    );
    expect(putRes.status).toBe(200);

    const encMediaCaption = await encryptDirectMessage({
      conversationPublicId: abConvId,
      senderPublicId: userA.publicId,
      clientMsgId: 'msg-ab-media-1',
      plaintext: '',
      media: {
        kind: 'image',
        attachmentPublicId: uploadGrant.attachmentPublicId,
        fileKey: mediaBlob.fileKey,
        fileIv: mediaBlob.fileIv,
        ciphertextSha256: mediaBlob.ciphertextSha256,
        mimeType: 'image/webp',
        sizeBytes: 8,
      },
      senderDevice: aMat,
      recipientDevices: [
        {
          devicePublicId: generatePublicId(),
          keyFingerprint: bMat.keyFingerprint,
          identityPublicKeyJwk: bMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bMat.signingPublicKeyJwk,
        },
      ],
    });
    const sendMediaRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({
          clientMsgId: 'msg-ab-media-1',
          messageType: 'image',
          attachmentPublicId: uploadGrant.attachmentPublicId,
          ciphertext: encMediaCaption.ciphertext,
          cryptoHeader: encMediaCaption.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: abConvId }) },
    );
    expect(sendMediaRes.status).toBe(201);
    const mediaMsgId = ((await sendMediaRes.json()) as { message: { public_id: string } }).message
      .public_id;

    // B tải được ảnh (200, no-store); C & D tải -> 404 đồng nhất.
    const bAttRes = await messageAttachmentGet(
      new Request(`${origin}/api/v1/messages/${mediaMsgId}/attachment`, {
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ messagePublicId: mediaMsgId }) },
    );
    expect(bAttRes.status).toBe(200);
    expect(bAttRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    for (const tok of ['tok-c', 'tok-d'] as const) {
      expect(
        (
          await messageAttachmentGet(
            new Request(`${origin}/api/v1/messages/${mediaMsgId}/attachment`, {
              headers: createAuthHeaders(origin, tok),
            }),
            { params: Promise.resolve({ messagePublicId: mediaMsgId }) },
          )
        ).status,
      ).toBe(404);
    }

    // Thu hồi tin ảnh trong <= 5 phút -> xóa attachment, tải lại trả 404.
    expect(
      (
        await messageRecallPost(
          new Request(`${origin}/api/v1/messages/${mediaMsgId}/recall`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a'),
          }),
          { params: Promise.resolve({ messagePublicId: mediaMsgId }) },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await messageAttachmentGet(
          new Request(`${origin}/api/v1/messages/${mediaMsgId}/attachment`, {
            headers: createAuthHeaders(origin, 'tok-b'),
          }),
          { params: Promise.resolve({ messagePublicId: mediaMsgId }) },
        )
      ).status,
    ).toBe(404);

    // Sau > 5 phút: A không còn sửa hay thu hồi được tin text (403 quá hạn 5 phút).
    currentNow = new Date(currentNow.getTime() + 6 * 60 * 1000);
    expect(
      (
        await messageEditPatch(
          new Request(`${origin}/api/v1/messages/${textMsgId}`, {
            method: 'PATCH',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({
              ciphertext: encMsg.ciphertext,
              cryptoHeader: encMsg.cryptoHeader,
            }),
          }),
          { params: Promise.resolve({ messagePublicId: textMsgId }) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await messageRecallPost(
          new Request(`${origin}/api/v1/messages/${textMsgId}/recall`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a'),
          }),
          { params: Promise.resolve({ messagePublicId: textMsgId }) },
        )
      ).status,
    ).toBe(403);
  });

  it('Nhóm 11 (WebRTC Calls & Mid-Call Block): ICE no-store không lộ khóa, Pending 403, Signaling BOLA 404, Renegotiation 30KB SDP & Block ngắt gọi tức thì', async () => {
    const origin = getTestOrigin();
    const now = new Date('2026-11-24T12:00:00.000Z');
    installFiveActorSessions();

    const usersById = new Map<string, UserRow>([
      [userA.id, userA],
      [userB.id, userB],
      [userC.id, userC],
      [userD.id, userD],
    ]);
    const usersByPublicId = new Map<string, UserRow>([
      [userA.publicId, userA],
      [userB.publicId, userB],
      [userC.publicId, userC],
      [userD.publicId, userD],
    ]);

    const primaryConv: ConversationRow = {
      id: generateUuidV7(),
      publicId: generatePublicId(),
      type: 'direct',
      directPairKey: `${userA.id}:${userB.id}`,
      lastSeq: 0,
      lastMessageAt: null,
      createdAt: now,
    };
    const pendingConv: ConversationRow = {
      id: generateUuidV7(),
      publicId: generatePublicId(),
      type: 'direct',
      directPairKey: `${userA.id}:${userD.id}`,
      lastSeq: 0,
      lastMessageAt: null,
      createdAt: now,
    };
    const conversationsById = new Map<string, ConversationRow>([
      [primaryConv.id, primaryConv],
      [pendingConv.id, pendingConv],
    ]);
    const participantsByConv = new Map<string, ConversationParticipantRow[]>([
      [
        primaryConv.id,
        [
          {
            conversationId: primaryConv.id,
            userId: userA.id,
            inboxState: 'primary',
            pendingMessagesSent: 0,
            lastReadSeq: 0,
            clearedBeforeSeq: 0,
            hiddenAt: null,
            pinnedAt: null,
            mutedAt: null,
            joinedAt: now,
          },
          {
            conversationId: primaryConv.id,
            userId: userB.id,
            inboxState: 'primary',
            pendingMessagesSent: 0,
            lastReadSeq: 0,
            clearedBeforeSeq: 0,
            hiddenAt: null,
            pinnedAt: null,
            mutedAt: null,
            joinedAt: now,
          },
        ],
      ],
      [
        pendingConv.id,
        [
          {
            conversationId: pendingConv.id,
            userId: userA.id,
            inboxState: 'primary',
            pendingMessagesSent: 0,
            lastReadSeq: 0,
            clearedBeforeSeq: 0,
            hiddenAt: null,
            pinnedAt: null,
            mutedAt: null,
            joinedAt: now,
          },
          {
            conversationId: pendingConv.id,
            userId: userD.id,
            inboxState: 'pending',
            pendingMessagesSent: 0,
            lastReadSeq: 0,
            clearedBeforeSeq: 0,
            hiddenAt: null,
            pinnedAt: null,
            mutedAt: null,
            joinedAt: now,
          },
        ],
      ],
    ]);

    const callSessionsById = new Map<string, CallSessionRow>();
    const blockedPairs = new Set<string>([`${userA.id}:${userC.id}`]);
    const realtime = new InMemoryRealtimeAdapter({ isolated: true });

    const getRel = vi.fn(
      async (actorId: string, targetId: string): Promise<SocialRelationshipSnapshot> => ({
        ...EMPTY_SOCIAL_RELATIONSHIP,
        blockedByActor: blockedPairs.has(`${actorId}:${targetId}`),
        blockedByTarget: blockedPairs.has(`${targetId}:${actorId}`),
      }),
    );

    const mockTx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };

    const callRepo: Partial<CallRepository> = {
      runInRlsTx: async <T>(_actorId: string, fn: (tx: DatabaseTransaction) => Promise<T>) =>
        fn(mockTx as unknown as DatabaseTransaction),
      getDatabaseNow: vi.fn(async () => now),
      findUserById: vi.fn(async (uid: string) => usersById.get(uid) ?? null),
      lockUsersInCanonicalOrder: vi.fn(async (uids: readonly string[]) => {
        const m = new Map<string, UserRow>();
        for (const id of uids) {
          const u = usersById.get(id);
          if (u) m.set(id, u);
        }
        return m;
      }),
      getRelationshipSnapshot: getRel,
      findConversationByPublicId: vi.fn(async (pid: string) => {
        for (const c of conversationsById.values()) if (c.publicId === pid) return c;
        return null;
      }),
      findConversationById: vi.fn(async (cid: string) => conversationsById.get(cid) ?? null),
      lockConversationById: vi.fn(async (cid: string) => conversationsById.get(cid) ?? null),
      listConversationParticipants: vi.fn(async (cid: string) => participantsByConv.get(cid) ?? []),
      lockConversationParticipants: vi.fn(async (cid: string) => participantsByConv.get(cid) ?? []),
      findCallSessionByPublicId: vi.fn(async (pid: string) => {
        for (const s of callSessionsById.values()) if (s.publicId === pid) return s;
        return null;
      }),
      lockCallSessionByPublicId: vi.fn(async (pid: string) => {
        for (const s of callSessionsById.values()) if (s.publicId === pid) return s;
        return null;
      }),
      sweepStaleCallsVisibleToActor: vi.fn(async () => []),
      sweepStaleCallsForTargetViaDbFunction: vi.fn(async () => undefined),
      hasActiveCallViaDbFunction: vi.fn(async (uid: string) => {
        for (const s of callSessionsById.values()) {
          if (
            (s.callerId === uid || s.calleeId === uid) &&
            (s.status === 'ringing' || s.status === 'connected')
          ) {
            return true;
          }
        }
        return false;
      }),
      insertCallSession: vi.fn(async (input) => {
        const row: CallSessionRow = {
          id: generateUuidV7(),
          publicId: generatePublicId(),
          conversationId: input.conversationId,
          callerId: input.callerId,
          calleeId: input.calleeId,
          callType: input.callType,
          status: input.status,
          startedAt: input.startedAt,
          connectedAt: input.connectedAt ?? null,
          lastHeartbeatAt: input.lastHeartbeatAt,
          endedAt: input.endedAt ?? null,
        };
        callSessionsById.set(row.id, row);
        return row;
      }),
      updateCallSession: vi.fn(async (callId, patch) => {
        const existing = callSessionsById.get(callId);
        if (!existing) return null;
        const updated: CallSessionRow = { ...existing, ...patch };
        callSessionsById.set(callId, updated);
        return updated;
      }),
      terminateActiveCallsBetweenUsersInTx: vi.fn(async (u1: string, u2: string, endTime: Date) => {
        const out = [];
        for (const s of callSessionsById.values()) {
          const matchesPair =
            (s.callerId === u1 && s.calleeId === u2) || (s.callerId === u2 && s.calleeId === u1);
          if (matchesPair && (s.status === 'ringing' || s.status === 'connected')) {
            callSessionsById.set(s.id, { ...s, status: 'ended', endedAt: endTime });
            const conv = conversationsById.get(s.conversationId)!;
            out.push({
              callPublicId: s.publicId,
              conversationPublicId: conv.publicId,
              endedAt: endTime,
            });
          }
        }
        return out;
      }),
      insertCallEventMessageInTx: vi.fn(async () => null),
    };

    const turnProvider = new StunFallbackTurnProvider();
    const callService = new CallSignalingService({
      repository: callRepo as CallRepository,
      rateLimiter: createAllowAllRateLimiter(),
      realtimeProvider: realtime,
      turnCredentialProvider: turnProvider,
      declineCooldownStore: new InMemoryCallDeclineCooldownStore(),
      now: () => now,
    });
    setTurnCredentialProviderForTesting(turnProvider);
    setCallSignalingServiceForTesting(callService);

    const socialRepo = {
      findUserByPublicId: vi.fn(async (pid: string) => usersByPublicId.get(pid) ?? null),
      getRelationshipSnapshot: getRel,
      getDb: vi.fn(() => ({
        transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(mockTx),
      })),
      lockUsersInCanonicalOrder: vi.fn(async (ids: string[]) => {
        const m = new Map<string, UserRow>();
        for (const id of ids) {
          const u = usersById.get(id);
          if (u) m.set(id, u);
        }
        return m;
      }),
      insertBlockIfAbsent: vi.fn(async (blockerId: string, blockedId: string) => {
        blockedPairs.add(`${blockerId}:${blockedId}`);
        return true;
      }),
      deleteFollowsBothDirections: vi.fn(async () => []),
      adjustUserFollowCounters: vi.fn(async () => undefined),
    } as unknown as SocialRepository;

    setSocialServiceForTesting(
      new SocialService({
        repository: socialRepo,
        rateLimiter: createAllowAllRateLimiter() as never,
        auditLogService: { record: vi.fn().mockResolvedValue(undefined) } as never,
        notificationService: null,
        presenceService: null,
        callSignalingService: callService,
        now: () => now,
      }),
    );

    // 1. POST /api/v1/calls/ice-servers: Anon -> 401; thiếu CSRF -> 403; hợp lệ -> 200 no-store, không lộ khóa.
    expect(
      (
        await iceServersPost(
          new Request(`${origin}/api/v1/calls/ice-servers`, {
            method: 'POST',
            headers: createAuthHeaders(origin, null, { contentType: 'application/json' }),
            body: '{}',
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await iceServersPost(
          new Request(`${origin}/api/v1/calls/ice-servers`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', {
              includeCsrf: false,
              contentType: 'application/json',
            }),
            body: '{}',
          }),
        )
      ).status,
    ).toBe(403);
    const iceRes = await iceServersPost(
      new Request(`${origin}/api/v1/calls/ice-servers`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: '{}',
      }),
    );
    expect(iceRes.status).toBe(200);
    expect(iceRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const iceText = await iceRes.text();
    expect(iceText).not.toContain('secretKey');
    expect(iceText).not.toContain('apiKey');

    // 2. POST /api/v1/calls: pending conv -> 403 CHAT_PENDING_TEXT_ONLY; C & D trên conv A-B -> 404.
    const pendingCallRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ conversationPublicId: pendingConv.publicId, callType: 'audio' }),
      }),
    );
    expect(pendingCallRes.status).toBe(403);
    expect(((await pendingCallRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_PENDING_TEXT_ONLY',
    );

    for (const tok of ['tok-c', 'tok-d'] as const) {
      expect(
        (
          await createCallPost(
            new Request(`${origin}/api/v1/calls`, {
              method: 'POST',
              headers: createAuthHeaders(origin, tok, { contentType: 'application/json' }),
              body: JSON.stringify({
                conversationPublicId: primaryConv.publicId,
                callType: 'video',
              }),
            }),
          )
        ).status,
      ).toBe(404);
    }

    // 3. A gọi B trên hội thoại primary -> 201, B bấm accept -> connected.
    const callRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ conversationPublicId: primaryConv.publicId, callType: 'audio' }),
      }),
    );
    expect(callRes.status).toBe(201);
    const callPublicId = ((await callRes.json()) as { call: { public_id: string } }).call.public_id;

    expect(
      (
        await callActionPost(
          new Request(`${origin}/api/v1/calls/${callPublicId}/action`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
            body: JSON.stringify({ action: 'accept' }),
          }),
          { params: Promise.resolve({ callPublicId }) },
        )
      ).status,
    ).toBe(200);

    // 4. BOLA trên /signal & /action: C & D nhận 404 đồng nhất; A gửi renegotiation offer 30KB SDP khi connected -> 200.
    for (const tok of ['tok-c', 'tok-d'] as const) {
      expect(
        (
          await callSignalPost(
            new Request(`${origin}/api/v1/calls/${callPublicId}/signal`, {
              method: 'POST',
              headers: createAuthHeaders(origin, tok, { contentType: 'application/json' }),
              body: JSON.stringify({ type: 'offer', sdp: 'v=0\r\n' }),
            }),
            { params: Promise.resolve({ callPublicId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await callActionPost(
            new Request(`${origin}/api/v1/calls/${callPublicId}/action`, {
              method: 'POST',
              headers: createAuthHeaders(origin, tok, { contentType: 'application/json' }),
              body: JSON.stringify({ action: 'end' }),
            }),
            { params: Promise.resolve({ callPublicId }) },
          )
        ).status,
      ).toBe(404);
    }

    const renegotiationSdp = `v=0\r\n${'a=synthetic-video-codec-line\r\n'.repeat(1000)}`;
    expect(renegotiationSdp.length).toBeGreaterThan(25_000);
    expect(
      (
        await callSignalPost(
          new Request(`${origin}/api/v1/calls/${callPublicId}/signal`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({ type: 'offer', sdp: renegotiationSdp }),
          }),
          { params: Promise.resolve({ callPublicId }) },
        )
      ).status,
    ).toBe(200);

    // 5. A chặn B ngay giữa cuộc gọi -> cắt cuộc gọi tức thì, đẩy call.ended trung tính cho cả 2, signal kế tiếp của B -> 404.
    const aEvents: LocalRealtimeEventMessage[] = [];
    const bEvents: LocalRealtimeEventMessage[] = [];
    const unsubA = realtime.subscribeLocal(userA.publicId, (e) => aEvents.push(e));
    const unsubB = realtime.subscribeLocal(userB.publicId, (e) => bEvents.push(e));

    const blockMidCall = await blockPost(
      new Request(`${origin}/api/v1/social/blocks/${userB.publicId}`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
      }),
      { params: Promise.resolve({ userPublicId: userB.publicId }) },
    );
    expect(blockMidCall.status).toBe(200);
    expect(
      aEvents.some((e) => e.event === 'call.ended' && e.data.callPublicId === callPublicId),
    ).toBe(true);
    expect(
      bEvents.some((e) => e.event === 'call.ended' && e.data.callPublicId === callPublicId),
    ).toBe(true);
    expect(JSON.stringify(bEvents).toLowerCase()).not.toContain('block');

    expect(
      (
        await callSignalPost(
          new Request(`${origin}/api/v1/calls/${callPublicId}/signal`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
            body: JSON.stringify({
              type: 'ice-candidate',
              candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host',
            }),
          }),
          { params: Promise.resolve({ callPublicId }) },
        )
      ).status,
    ).toBe(404);

    unsubA();
    unsubB();
  });
});
