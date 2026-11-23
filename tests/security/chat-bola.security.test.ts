import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as acceptConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/accept/route';
import { POST as declineConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/decline/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { GET as conversationDetailGet } from '@/app/api/v1/conversations/[conversationPublicId]/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { GET as conversationsListGet } from '@/app/api/v1/conversations/route';
import { GET as e2eeBackupGet, PUT as e2eeBackupPut } from '@/app/api/v1/e2ee/backup/route';
import { POST as e2eeDevicesPost } from '@/app/api/v1/e2ee/devices/route';
import { GET as e2eeUserKeysGet } from '@/app/api/v1/e2ee/users/[userPublicId]/keys/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import type { DatabaseTransaction } from '@/core/db';
import type {
  ConversationInboxState,
  ConversationParticipantRow,
  ConversationRow,
  MessageRow,
  SessionRow,
  UserE2eeDeviceRow,
  UserE2eeKeyBackupRow,
  UserRow,
} from '@/core/db/schema';
import { InMemoryRealtimeAdapter } from '@/core/realtime';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  clearMemoryKeystoreForTesting,
  encryptDirectMessage,
  getOrCreatePrimaryDeviceKeyMaterial,
} from '@/lib/e2ee';
import {
  resetSessionServiceForTesting,
  setSessionServiceForTesting,
  type AuthenticatedPrincipal,
  type SessionService,
} from '@/modules/auth';
import {
  ChatService,
  resetChatServiceForTesting,
  setChatServiceForTesting,
  type ChatRepository,
} from '@/modules/chat';
import type { NotificationService } from '@/modules/notifications';
import type { SocialRelationshipSnapshot } from '@/modules/social/social.policy';
import { proxy } from '@/proxy';

const TEST_CSRF = 'synthetic-csrf-token-for-m9-security-tests';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-23T12:00:00.000Z');
  return {
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'alice_m9',
    handle: 'alice_m9',
    handleNormalized: 'alice_m9',
    fullName: 'Alice M9',
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
    dateOfBirth: '1999-03-12',
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
    id: '0195a000-0000-7000-8000-000000000090',
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

function createAuthHeaders(origin: string, accessToken: string, includeCsrf = true) {
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: `tomato_at=${accessToken}; tomato_csrf=${TEST_CSRF}`,
    'Content-Type': 'application/json',
    ...(includeCsrf ? { [CSRF_HEADER_NAME]: TEST_CSRF } : {}),
  };
}

afterEach(() => {
  resetSessionServiceForTesting();
  resetChatServiceForTesting();
  clearMemoryKeystoreForTesting();
  vi.restoreAllMocks();
});

describe('Security M9: Ma trận BOLA Nhắn tin 1-1 E2EE, Tin nhắn đang chờ (3 tin, text-only, decline im lặng) & Không đẩy Ciphertext qua Ably', () => {
  const userA = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    handle: 'alice_sender',
    handleNormalized: 'alice_sender',
    fullName: 'Alice Sender',
  });
  const userB = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000002',
    publicId: '22222222-2222-4222-8222-222222222222',
    handle: 'bob_recipient',
    handleNormalized: 'bob_recipient',
    fullName: 'Bob Recipient',
  });
  const userC = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000003',
    publicId: '33333333-3333-4333-8333-333333333333',
    handle: 'charlie_blocked',
    handleNormalized: 'charlie_blocked',
    fullName: 'Charlie Blocked',
  });
  const userD = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000004',
    publicId: '44444444-4444-4444-8444-444444444444',
    handle: 'david_outsider',
    handleNormalized: 'david_outsider',
    fullName: 'David Outsider',
  });

  function installSessionLookup(map: Record<string, AuthenticatedPrincipal>) {
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

  function createInMemoryChatEnvironment(options?: { readonly bobFollowsAlice?: boolean }) {
    const usersById = new Map<string, UserRow>([
      [userA.id, userA],
      [userB.id, userB],
      [userC.id, userC],
      [userD.id, userD],
    ]);
    const devicesByUser = new Map<string, UserE2eeDeviceRow[]>();
    const backupsByUser = new Map<string, UserE2eeKeyBackupRow>();
    const conversationsById = new Map<string, ConversationRow>();
    const participantsByConv = new Map<string, ConversationParticipantRow[]>();
    const messagesByConv = new Map<string, MessageRow[]>();
    let bobFollowsAlice = options?.bobFollowsAlice ?? false;

    const rateLimiter = {
      consume: vi.fn().mockResolvedValue({
        allowed: true,
        limit: 60,
        remaining: 59,
        resetAt: Date.now() + 60_000,
        retryAfterSeconds: 0,
      }),
    };

    const realtime = new InMemoryRealtimeAdapter({ isolated: true });
    const recordedNotifications: Array<{
      readonly recipientId: string;
      readonly actorId: string;
      readonly type: string;
      readonly entityPublicId?: string | null;
    }> = [];

    const mockNotificationService = {
      recordNotificationInTx: vi.fn(
        async (
          _tx: unknown,
          params: {
            readonly recipient: { readonly id: string; readonly publicId: string };
            readonly actor: { readonly id: string; readonly publicId: string };
            readonly type: string;
            readonly entityPublicId?: string | null;
          },
        ) => {
          recordedNotifications.push({
            recipientId: params.recipient.id,
            actorId: params.actor.id,
            type: params.type,
            entityPublicId: params.entityPublicId,
          });
          return {
            recipientPublicId: params.recipient.publicId,
            eventName: 'notification.created' as const,
            payload: {
              notification: {
                public_id: generatePublicId(),
                type: params.type,
                entityPublicId: params.entityPublicId ?? null,
              },
              unreadCount: recordedNotifications.length,
            },
          };
        },
      ),
      removeMessageRequestNotificationsInTx: vi.fn(
        async (
          _tx: unknown,
          params: {
            readonly recipientId: string;
            readonly recipientPublicId: string;
          },
        ) => ({
          recipientPublicId: params.recipientPublicId,
          eventName: 'notification.removed' as const,
          payload: {
            notificationPublicIds: ['removed-notif'],
            unreadCount: 0,
          },
        }),
      ),
      dispatchRealtimeEvents: vi.fn(
        async (
          events: ReadonlyArray<{
            readonly recipientPublicId: string;
            readonly eventName: 'notification.created' | 'notification.removed';
            readonly payload: Record<string, unknown>;
          } | null>,
        ) => {
          for (const ev of events) {
            if (ev) {
              await realtime.publishToUser(ev.recipientPublicId, ev.eventName, ev.payload);
            }
          }
        },
      ),
    } as unknown as NotificationService;

    const repo: Partial<ChatRepository> = {
      runInRlsTx: async <T>(
        _actorId: string,
        fn: (tx: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => fn({} as DatabaseTransaction),
      findUserByPublicId: vi.fn(async (pid: string) => {
        for (const u of usersById.values()) {
          if (u.publicId === pid) return u;
        }
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
          const isBlocked =
            (actorId === userA.id && targetId === userC.id) ||
            (actorId === userC.id && targetId === userA.id);
          const targetFollows =
            actorId === userA.id && targetId === userB.id && bobFollowsAlice ? 'following' : 'none';
          const actorFollows =
            actorId === userB.id && targetId === userA.id && bobFollowsAlice ? 'following' : 'none';
          return {
            blockedByActor: isBlocked && actorId === userA.id,
            blockedByTarget: isBlocked && targetId === userA.id,
            actorFollowStatus: actorFollows,
            targetFollowStatus: targetFollows,
          };
        },
      ),
      listActiveDevicesForUser: vi.fn(async (uid: string) =>
        (devicesByUser.get(uid) ?? []).filter((d) => d.revokedAt === null),
      ),
      upsertUserE2eeDevice: vi.fn(async (params) => {
        const list = devicesByUser.get(params.userId) ?? [];
        let existing = list.find((d) => d.keyFingerprint === params.keyFingerprint);
        if (existing) {
          existing = {
            ...existing,
            deviceLabel: params.deviceLabel,
            identityPublicKeyJwk: params.identityPublicKeyJwk,
            signingPublicKeyJwk: params.signingPublicKeyJwk,
            revokedAt: null,
            lastSeenAt: params.now,
          };
          devicesByUser.set(
            params.userId,
            list.map((d) => (d.id === existing!.id ? existing! : d)),
          );
        } else {
          existing = {
            id: generateUuidV7(),
            publicId: generatePublicId(),
            userId: params.userId,
            sessionFamilyId: params.sessionFamilyId,
            deviceLabel: params.deviceLabel,
            identityPublicKeyJwk: params.identityPublicKeyJwk,
            signingPublicKeyJwk: params.signingPublicKeyJwk,
            keyFingerprint: params.keyFingerprint,
            revokedAt: null,
            lastSeenAt: params.now,
            createdAt: params.now,
          };
          list.push(existing);
          devicesByUser.set(params.userId, list);
        }

        const active = (devicesByUser.get(params.userId) ?? []).filter((d) => d.revokedAt === null);
        const revokedDevicePublicIds: string[] = [];
        if (active.length > params.maxActiveDevices) {
          const oldest = active[0]!;
          oldest.revokedAt = params.now;
          revokedDevicePublicIds.push(oldest.publicId);
        }

        return { device: existing, revokedDevicePublicIds };
      }),
      findKeyBackupByUserId: vi.fn(async (uid: string) => backupsByUser.get(uid) ?? null),
      upsertKeyBackup: vi.fn(async (params) => {
        const row: UserE2eeKeyBackupRow = {
          userId: params.userId,
          encryptedKeyBlob: params.encryptedKeyBlob,
          kdfSalt: params.kdfSalt,
          kdfParams: params.kdfParams,
          iv: params.iv,
          keyFingerprint: params.keyFingerprint,
          version: params.version,
          updatedAt: params.now,
        };
        backupsByUser.set(params.userId, row);
        return row;
      }),
      insertOrLockDirectConversation: vi.fn(async (pairKey: string, now: Date) => {
        for (const c of conversationsById.values()) {
          if (c.directPairKey === pairKey) {
            return { conversation: c, isNewlyCreated: false };
          }
        }
        const conv: ConversationRow = {
          id: generateUuidV7(),
          publicId: generatePublicId(),
          type: 'direct',
          directPairKey: pairKey,
          lastSeq: 0,
          lastMessageAt: null,
          createdAt: now,
        };
        conversationsById.set(conv.id, conv);
        return { conversation: conv, isNewlyCreated: true };
      }),
      findConversationByPublicId: vi.fn(async (pid: string) => {
        for (const c of conversationsById.values()) {
          if (c.publicId === pid) return c;
        }
        return null;
      }),
      lockConversationByPublicId: vi.fn(async (pid: string) => {
        for (const c of conversationsById.values()) {
          if (c.publicId === pid) return c;
        }
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
            joinedAt: r.joinedAt,
          }));
          if (rows[0]) {
            participantsByConv.set(rows[0].conversationId, created);
          }
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
      resetAllParticipantsPendingCount: vi.fn(async (cid) => {
        const list = participantsByConv.get(cid) ?? [];
        participantsByConv.set(
          cid,
          list.map((p) => ({ ...p, pendingMessagesSent: 0 })),
        );
      }),
      countPendingConversationsForUser: vi.fn(async (uid: string) => {
        let count = 0;
        for (const [cid, parts] of participantsByConv.entries()) {
          const conv = conversationsById.get(cid);
          const myPart = parts.find((p) => p.userId === uid);
          if (
            conv &&
            conv.lastSeq > 0 &&
            myPart &&
            myPart.inboxState === 'pending' &&
            myPart.hiddenAt === null
          ) {
            count += 1;
          }
        }
        return count;
      }),
      listConversationsForUser: vi.fn(async (params) => {
        const out = [];
        for (const [cid, parts] of participantsByConv.entries()) {
          const conv = conversationsById.get(cid)!;
          const actorParticipant = parts.find((p) => p.userId === params.userId);
          const peerParticipant = parts.find((p) => p.userId !== params.userId);
          if (
            !actorParticipant ||
            !peerParticipant ||
            actorParticipant.inboxState !== params.tab ||
            actorParticipant.hiddenAt !== null
          ) {
            continue;
          }
          if (conv.lastSeq === 0) {
            continue;
          }
          const peerUser = usersById.get(peerParticipant.userId)!;
          const msgs = messagesByConv.get(cid) ?? [];
          const lastMsg = msgs[msgs.length - 1] ?? null;
          out.push({
            conversation: conv,
            actorParticipant,
            peerParticipant,
            peerUser,
            lastMessage: lastMsg
              ? {
                  row: lastMsg,
                  senderPublicId: usersById.get(lastMsg.senderId)!.publicId,
                }
              : null,
          });
        }
        return out;
      }),
      findMessageByClientMsgId: vi.fn(async (cid, sid, clientMsgId) => {
        const list = messagesByConv.get(cid) ?? [];
        return list.find((m) => m.senderId === sid && m.clientMsgId === clientMsgId) ?? null;
      }),
      insertMessageAndIncrementSeq: vi.fn(async (params) => {
        const conv = conversationsById.get(params.conversationId)!;
        conversationsById.set(params.conversationId, {
          ...conv,
          lastSeq: params.nextSeq,
          lastMessageAt: params.now,
        });
        const msg: MessageRow = {
          id: generateUuidV7(),
          publicId: generatePublicId(),
          conversationId: params.conversationId,
          senderId: params.senderId,
          seq: params.nextSeq,
          clientMsgId: params.clientMsgId,
          messageType: params.messageType,
          ciphertext: params.ciphertext,
          cryptoHeader: params.cryptoHeader,
          attachmentStorageKey: null,
          editCount: 0,
          editedAt: null,
          recalledAt: null,
          createdAt: params.now,
        };
        const list = messagesByConv.get(params.conversationId) ?? [];
        list.push(msg);
        messagesByConv.set(params.conversationId, list);
        return msg;
      }),
      listMessagesForConversation: vi.fn(async (params) => {
        const minSeq = Math.max(params.clearedBeforeSeq, params.afterSeq ?? 0);
        const list = (messagesByConv.get(params.conversationId) ?? []).filter(
          (m) => m.seq > minSeq && (params.cursorSeq === undefined || m.seq < params.cursorSeq),
        );
        const isForward = params.afterSeq !== undefined && params.cursorSeq === undefined;
        const sorted = isForward
          ? [...list].sort((a, b) => a.seq - b.seq)
          : [...list].sort((a, b) => b.seq - a.seq);
        return sorted.slice(0, params.limit + 1).map((row) => ({
          row,
          senderPublicId: usersById.get(row.senderId)!.publicId,
        }));
      }),
    };

    const service = new ChatService({
      repository: repo as ChatRepository,
      rateLimiter,
      realtimeProvider: realtime,
      notificationService: mockNotificationService,
    });
    setChatServiceForTesting(service);

    return {
      rateLimiter,
      realtime,
      recordedNotifications,
      setBobFollowsAlice: (val: boolean) => {
        bobFollowsAlice = val;
      },
      getParticipantState: (
        convPublicId: string,
        userId: string,
      ): ConversationInboxState | null => {
        for (const [cid, conv] of conversationsById.entries()) {
          if (conv.publicId === convPublicId) {
            return (
              participantsByConv.get(cid)?.find((p) => p.userId === userId)?.inboxState ?? null
            );
          }
        }
        return null;
      },
    };
  }

  it('từ chối ẩn danh (Anon -> 401) + Cache-Control: no-store trên toàn bộ 10 endpoint M9 và proxy()', async () => {
    const origin = getTestOrigin();
    const convId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const validCsrfNoAuth = {
      origin,
      'sec-fetch-site': 'same-origin',
      cookie: `tomato_csrf=${TEST_CSRF}`,
      [CSRF_HEADER_NAME]: TEST_CSRF,
      'Content-Type': 'application/json',
    };

    const responses = await Promise.all([
      e2eeDevicesPost(
        new Request(`${origin}/api/v1/e2ee/devices`, {
          method: 'POST',
          headers: validCsrfNoAuth,
          body: '{}',
        }),
      ),
      e2eeUserKeysGet(new Request(`${origin}/api/v1/e2ee/users/${userB.publicId}/keys`), {
        params: Promise.resolve({ userPublicId: userB.publicId }),
      }),
      e2eeBackupGet(new Request(`${origin}/api/v1/e2ee/backup`)),
      e2eeBackupPut(
        new Request(`${origin}/api/v1/e2ee/backup`, {
          method: 'PUT',
          headers: validCsrfNoAuth,
          body: '{}',
        }),
      ),
      conversationsListGet(new Request(`${origin}/api/v1/conversations`)),
      directConversationPost(
        new Request(`${origin}/api/v1/conversations/direct`, {
          method: 'POST',
          headers: validCsrfNoAuth,
          body: JSON.stringify({ recipientPublicId: userB.publicId }),
        }),
      ),
      conversationDetailGet(new Request(`${origin}/api/v1/conversations/${convId}`), {
        params: Promise.resolve({ conversationPublicId: convId }),
      }),
      acceptConversationPost(
        new Request(`${origin}/api/v1/conversations/${convId}/accept`, {
          method: 'POST',
          headers: validCsrfNoAuth,
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
      declineConversationPost(
        new Request(`${origin}/api/v1/conversations/${convId}/decline`, {
          method: 'POST',
          headers: validCsrfNoAuth,
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
      messagesGet(new Request(`${origin}/api/v1/conversations/${convId}/messages`), {
        params: Promise.resolve({ conversationPublicId: convId }),
      }),
      messagesPost(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          method: 'POST',
          headers: validCsrfNoAuth,
          body: '{}',
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    }

    for (const path of ['/api/v1/e2ee/devices', '/api/v1/conversations', '/messages']) {
      const proxyRes = proxy(new NextRequest(`http://localhost:3000${path}`));
      expect(proxyRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    }
  });

  it('cưỡng chế CSRF 3 lớp (403) trên mọi endpoint ghi của M9', async () => {
    const origin = getTestOrigin();
    const convId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const noCsrfHeaders = createAuthHeaders(origin, 'tok-a', false);

    const responses = await Promise.all([
      e2eeDevicesPost(
        new Request(`${origin}/api/v1/e2ee/devices`, {
          method: 'POST',
          headers: noCsrfHeaders,
          body: '{}',
        }),
      ),
      e2eeBackupPut(
        new Request(`${origin}/api/v1/e2ee/backup`, {
          method: 'PUT',
          headers: noCsrfHeaders,
          body: '{}',
        }),
      ),
      directConversationPost(
        new Request(`${origin}/api/v1/conversations/direct`, {
          method: 'POST',
          headers: noCsrfHeaders,
          body: JSON.stringify({ recipientPublicId: userB.publicId }),
        }),
      ),
      acceptConversationPost(
        new Request(`${origin}/api/v1/conversations/${convId}/accept`, {
          method: 'POST',
          headers: noCsrfHeaders,
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
      declineConversationPost(
        new Request(`${origin}/api/v1/conversations/${convId}/decline`, {
          method: 'POST',
          headers: noCsrfHeaders,
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
      messagesPost(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          method: 'POST',
          headers: noCsrfHeaders,
          body: '{}',
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'CSRF_VALIDATION_FAILED',
      );
    }
  });

  it('kiểm soát Tin nhắn đang chờ: tối đa 3 tin text, chặn ảnh/voice, idempotent client_msg_id, im lặng tuyệt đối sau khi decline & không đẩy ciphertext qua Ably', async () => {
    const origin = getTestOrigin();
    installSessionLookup({
      'tok-a': makePrincipal(userA),
      'tok-b': makePrincipal(userB),
      'tok-c': makePrincipal(userC),
      'tok-d': makePrincipal(userD),
    });

    const env = createInMemoryChatEnvironment({ bobFollowsAlice: false });

    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(userA.publicId);
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(userB.publicId);

    // 1. Đăng ký khóa thiết bị của Alice và Bob.
    const regAlice = await e2eeDevicesPost(
      new Request(`${origin}/api/v1/e2ee/devices`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          identityPublicKeyJwk: aliceDevice.identityPublicKeyJwk,
          signingPublicKeyJwk: aliceDevice.signingPublicKeyJwk,
          keyFingerprint: aliceDevice.keyFingerprint,
        }),
      }),
    );
    expect(regAlice.status).toBe(200);

    const regBob = await e2eeDevicesPost(
      new Request(`${origin}/api/v1/e2ee/devices`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
        body: JSON.stringify({
          identityPublicKeyJwk: bobDevice.identityPublicKeyJwk,
          signingPublicKeyJwk: bobDevice.signingPublicKeyJwk,
          keyFingerprint: bobDevice.keyFingerprint,
        }),
      }),
    );
    expect(regBob.status).toBe(200);

    // 2. Alice khởi tạo hội thoại với Bob (Bob chưa follow Alice -> Bob ở trạng thái `pending`).
    const createConvRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    expect(createConvRes.status).toBe(201);
    const createConvBody = (await createConvRes.json()) as {
      conversation: { public_id: string; isAwaitingPeerAcceptance: boolean };
    };
    const convPublicId = createConvBody.conversation.public_id;
    expect(createConvBody.conversation.isAwaitingPeerAcceptance).toBe(true);
    expect(env.getParticipantState(convPublicId, userB.id)).toBe('pending');

    async function buildEncryptedPayload(clientMsgId: string, text: string, messageType = 'text') {
      const envelope = await encryptDirectMessage({
        conversationPublicId: convPublicId,
        senderPublicId: userA.publicId,
        clientMsgId,
        plaintext: text,
        senderDevice: aliceDevice,
        recipientDevices: [
          {
            devicePublicId: bobDevice.devicePublicId,
            keyFingerprint: bobDevice.keyFingerprint,
            identityPublicKeyJwk: bobDevice.identityPublicKeyJwk,
            signingPublicKeyJwk: bobDevice.signingPublicKeyJwk,
          },
        ],
      });
      return {
        clientMsgId,
        messageType,
        ciphertext: envelope.ciphertext,
        cryptoHeader: envelope.cryptoHeader,
      };
    }

    // 3. Cố gửi ảnh hoặc voice khi đang `pending` -> bị chặn cứng 403 CHAT_PENDING_TEXT_ONLY.
    const imageInPendingRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify(await buildEncryptedPayload('msg_img_blocked', 'Ảnh', 'image')),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(imageInPendingRes.status).toBe(403);
    expect(((await imageInPendingRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_PENDING_TEXT_ONLY',
    );

    // 4. Alice gửi tin nhắn chữ thứ 1 -> thành công (201), phát thông báo message_request.
    env.realtime.clearPublishedEvents();
    const msg1Payload = await buildEncryptedPayload('msg_pending_001', 'Xin chào Bob 1');
    const msg1Res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify(msg1Payload),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(msg1Res.status).toBe(201);

    // Kiểm tra sự kiện Ably `chat.message.created` TUYỆT ĐỐI KHÔNG chứa ciphertext hay cryptoHeader.
    const publishedAfterMsg1 = env.realtime
      .getPublishedEvents()
      .filter((e) => e.event === 'chat.message.created');
    expect(publishedAfterMsg1.length).toBeGreaterThanOrEqual(1);
    for (const ev of publishedAfterMsg1) {
      expect(ev.data).toHaveProperty('conversationPublicId', convPublicId);
      expect(ev.data).toHaveProperty('seq', 1);
      expect(ev.data).not.toHaveProperty('ciphertext');
      expect(ev.data).not.toHaveProperty('cryptoHeader');
      expect(JSON.stringify(ev.data)).not.toContain(msg1Payload.ciphertext);
    }

    // Gửi trùng lại cùng `clientMsgId` (idempotent retry) -> trả 200, seq vẫn là 1, không tốn lượt gửi thứ 2.
    const msg1RetryRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify(msg1Payload),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(msg1RetryRes.status).toBe(200);
    const msg1RetryBody = (await msg1RetryRes.json()) as {
      deduplicated: boolean;
      message: { seq: number };
      conversation: { myState: { pendingMessagesSent: number } };
    };
    expect(msg1RetryBody.deduplicated).toBe(true);
    expect(msg1RetryBody.message.seq).toBe(1);
    expect(msg1RetryBody.conversation.myState.pendingMessagesSent).toBe(1);

    // 5. Bob bấm Xóa / Từ chối (`decline`) sau tin thứ 1 -> hộp thư Bob chuyển sang `declined`, im lặng với Alice.
    env.realtime.clearPublishedEvents();
    const declineRes = await declineConversationPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/decline`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(declineRes.status).toBe(200);
    expect(env.getParticipantState(convPublicId, userB.id)).toBe('declined');
    expect(
      env.realtime.getPublishedEvents().some((e) => e.channel === `user:${userA.publicId}`),
    ).toBe(false);

    // 6. Sau khi Bob đã `decline`, Alice gửi tiếp tin thứ 2 và thứ 3:
    //    - Hội thoại KHÔNG hiện lại ở tab Tin nhắn đang chờ của Bob (vẫn giữ `declined`).
    //    - KHÔNG phát lại thông báo `message_request` và KHÔNG bắn realtime cho Bob.
    const notifCountBeforeMsg2 = env.recordedNotifications.length;
    env.realtime.clearPublishedEvents();

    const msg2Res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify(await buildEncryptedPayload('msg_pending_002', 'Xin chào Bob 2')),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(msg2Res.status).toBe(201);

    const msg3Res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify(await buildEncryptedPayload('msg_pending_003', 'Xin chào Bob 3')),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(msg3Res.status).toBe(201);

    expect(env.getParticipantState(convPublicId, userB.id)).toBe('declined');
    expect(env.recordedNotifications).toHaveLength(notifCountBeforeMsg2);
    expect(
      env.realtime.getPublishedEvents().some((e) => e.channel === `user:${userB.publicId}`),
    ).toBe(false);

    const bobPendingListRes = await conversationsListGet(
      new Request(`${origin}/api/v1/conversations?tab=pending`, {
        headers: { cookie: 'tomato_at=tok-b' },
      }),
    );
    const bobPendingList = (await bobPendingListRes.json()) as { items: unknown[] };
    expect(bobPendingList.items).toHaveLength(0);

    // 7. Tin nhắn thứ 4 của Alice bị chặn cứng với 403 CHAT_PENDING_LIMIT_REACHED.
    const msg4Res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify(await buildEncryptedPayload('msg_pending_004', 'Tin thứ 4')),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(msg4Res.status).toBe(403);
    expect(((await msg4Res.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_PENDING_LIMIT_REACHED',
    );

    // 8. Khi Bob chấp nhận (`accept`) -> chuyển sang `primary`, mở khóa giới hạn 3 tin.
    const acceptRes = await acceptConversationPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/accept`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(acceptRes.status).toBe(200);
    expect(env.getParticipantState(convPublicId, userB.id)).toBe('primary');

    const msg4AfterAcceptRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify(await buildEncryptedPayload('msg_after_accept_4', 'Tin thứ 4 hợp lệ')),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(msg4AfterAcceptRes.status).toBe(201);

    // Delta-sync qua `GET /api/v1/conversations/:id/messages?afterSeq=3` chỉ trả đúng tin seq=4.
    const deltaRes = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages?afterSeq=3`, {
        headers: { cookie: 'tomato_at=tok-b' },
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(deltaRes.status).toBe(200);
    const deltaBody = (await deltaRes.json()) as {
      items: Array<{ seq: number; clientMsgId: string }>;
    };
    expect(deltaBody.items).toHaveLength(1);
    expect(deltaBody.items[0]?.seq).toBe(4);
    expect(deltaBody.items[0]?.clientMsgId).toBe('msg_after_accept_4');
  });

  it('Ma trận BOLA 5 nhân vật: chặn User C (Blocked -> 404), chặn User D (Outsider -> 404), validate iterations >= 600000 & giới hạn 10 thiết bị', async () => {
    const origin = getTestOrigin();
    installSessionLookup({
      'tok-a': makePrincipal(userA),
      'tok-b': makePrincipal(userB),
      'tok-c': makePrincipal(userC),
      'tok-d': makePrincipal(userD),
    });

    createInMemoryChatEnvironment({ bobFollowsAlice: true });

    // Alice tạo hội thoại với Bob (vì Bob đang follow Alice -> vào thẳng `primary`).
    const createRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    expect(createRes.status).toBe(201);
    const convPublicId = ((await createRes.json()) as { conversation: { public_id: string } })
      .conversation.public_id;

    // 1. User C (đã bị Alice chặn) gọi lấy khóa E2EE hoặc tạo hội thoại với Alice -> 404 đồng nhất.
    const blockedKeysRes = await e2eeUserKeysGet(
      new Request(`${origin}/api/v1/e2ee/users/${userA.publicId}/keys`, {
        headers: { cookie: 'tomato_at=tok-c' },
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(blockedKeysRes.status).toBe(404);

    const blockedConvRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-c'),
        body: JSON.stringify({ recipientPublicId: userA.publicId }),
      }),
    );
    expect(blockedConvRes.status).toBe(404);

    // 2. User D (người lạ ngoài cuộc) cố đọc chi tiết, đọc tin nhắn, gửi tin nhắn, accept/decline hội thoại A-B -> 404 đồng nhất.
    const outsiderChecks = await Promise.all([
      conversationDetailGet(
        new Request(`${origin}/api/v1/conversations/${convPublicId}`, {
          headers: { cookie: 'tomato_at=tok-d' },
        }),
        { params: Promise.resolve({ conversationPublicId: convPublicId }) },
      ),
      messagesGet(
        new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
          headers: { cookie: 'tomato_at=tok-d' },
        }),
        { params: Promise.resolve({ conversationPublicId: convPublicId }) },
      ),
      acceptConversationPost(
        new Request(`${origin}/api/v1/conversations/${convPublicId}/accept`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-d'),
        }),
        { params: Promise.resolve({ conversationPublicId: convPublicId }) },
      ),
      declineConversationPost(
        new Request(`${origin}/api/v1/conversations/${convPublicId}/decline`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-d'),
        }),
        { params: Promise.resolve({ conversationPublicId: convPublicId }) },
      ),
    ]);

    for (const res of outsiderChecks) {
      expect(res.status).toBe(404);
    }

    // 3. Validate PUT /api/v1/e2ee/backup: từ chối iterations < 600.000 hoặc truyền thêm field lạ (.strict()).
    const weakBackupRes = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          encryptedKeyBlob: 'a'.repeat(64),
          kdfSalt: 'b'.repeat(24),
          kdfParams: { alg: 'PBKDF2-SHA256', iterations: 100_000 },
          iv: 'c'.repeat(16),
          keyFingerprint: '0'.repeat(64),
          version: 1,
        }),
      }),
    );
    expect(weakBackupRes.status).toBe(400);

    // 4. Giới hạn tối đa 10 thiết bị E2EE hoạt động/người dùng: đăng ký 12 thiết bị -> chỉ giữ tối đa 10 thiết bị hoạt động.
    for (let i = 0; i < 12; i += 1) {
      clearMemoryKeystoreForTesting();
      const mat = await getOrCreatePrimaryDeviceKeyMaterial(userA.publicId);
      const regRes = await e2eeDevicesPost(
        new Request(`${origin}/api/v1/e2ee/devices`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-a'),
          body: JSON.stringify({
            identityPublicKeyJwk: mat.identityPublicKeyJwk,
            signingPublicKeyJwk: mat.signingPublicKeyJwk,
            keyFingerprint: mat.keyFingerprint,
            deviceLabel: `Device #${i + 1}`,
          }),
        }),
      );
      expect(regRes.status).toBe(200);
    }

    const keysBundleRes = await e2eeUserKeysGet(
      new Request(`${origin}/api/v1/e2ee/users/${userA.publicId}/keys`, {
        headers: { cookie: 'tomato_at=tok-a' },
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(keysBundleRes.status).toBe(200);
    const keysBundleText = await keysBundleRes.text();
    expect(keysBundleText).not.toContain(userA.id);
    const keysBundle = JSON.parse(keysBundleText) as { devices: unknown[] };
    expect(keysBundle.devices).toHaveLength(10);

    // 5. Kiểm tra Rate Limit (429) trên PUT /api/v1/e2ee/backup và quota 5 người lạ mới/ngày.
    const envForRl = createInMemoryChatEnvironment({ bobFollowsAlice: false });
    envForRl.rateLimiter.consume.mockResolvedValueOnce({
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 60,
    });
    const backupRlRes = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          encryptedKeyBlob: 'a'.repeat(64),
          kdfSalt: 'b'.repeat(24),
          kdfParams: { alg: 'PBKDF2-SHA256', iterations: 600_000 },
          iv: 'c'.repeat(16),
          keyFingerprint: '0'.repeat(64),
          version: 1,
        }),
      }),
    );
    expect(backupRlRes.status).toBe(429);
    expect(backupRlRes.headers.get('Retry-After')).toBe('60');

    // Lượt đầu (createConversationByUser) cho qua, lượt 2 (newPendingConversationDailyByUser = 5 người lạ/ngày) chặn 429.
    envForRl.rateLimiter.consume
      .mockResolvedValueOnce({
        allowed: true,
        limit: 30,
        remaining: 29,
        resetAt: Date.now() + 60_000,
        retryAfterSeconds: 0,
      })
      .mockResolvedValueOnce({
        allowed: false,
        limit: 5,
        remaining: 0,
        resetAt: Date.now() + 3600_000,
        retryAfterSeconds: 3600,
      });

    const sixthStrangerRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    expect(sixthStrangerRes.status).toBe(429);
  });
});
