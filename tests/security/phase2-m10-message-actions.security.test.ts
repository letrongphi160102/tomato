import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as declineConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/decline/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { POST as readConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/read/route';
import {
  DELETE as conversationDelete,
  GET as conversationDetailGet,
} from '@/app/api/v1/conversations/[conversationPublicId]/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { GET as conversationsListGet } from '@/app/api/v1/conversations/route';
import { DELETE as messageDeleteForMe } from '@/app/api/v1/messages/[messagePublicId]/for-me/route';
import { POST as messageRecallPost } from '@/app/api/v1/messages/[messagePublicId]/recall/route';
import {
  GET as messageDetailGet,
  PATCH as messageEditPatch,
} from '@/app/api/v1/messages/[messagePublicId]/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import type { DatabaseTransaction } from '@/core/db';
import type {
  ConversationInboxState,
  ConversationParticipantRow,
  ConversationRow,
  MessageRow,
  SessionRow,
  UserRow,
} from '@/core/db/schema';
import { InMemoryRealtimeAdapter } from '@/core/realtime';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  clearMemoryKeystoreForTesting,
  decryptDirectMessage,
  encryptDirectMessage,
  getOrCreatePrimaryDeviceKeyMaterial,
  reEncryptEditedDirectMessage,
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
import type { SocialRelationshipSnapshot } from '@/modules/social/social.policy';
import { proxy } from '@/proxy';

const TEST_CSRF = 'synthetic-csrf-token-for-m10-security-tests';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-24T12:00:00.000Z');
  return {
    id: '0195b000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'alice_m10',
    handle: 'alice_m10',
    handleNormalized: 'alice_m10',
    fullName: 'Alice M10',
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
  const now = new Date('2026-11-24T12:00:00.000Z');
  const session: SessionRow = {
    id: '0195b000-0000-7000-8000-000000000090',
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

describe('Security M10: Ma trận BOLA 5 nhân vật, Sửa/Thu hồi trong 5 phút (Server Clock), Xóa 1 phía & Xóa đoạn chat không lộ Đã xem giả', () => {
  const userA = makeUserRow({
    id: '0195b000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    handle: 'alice_m10',
    handleNormalized: 'alice_m10',
    fullName: 'Alice M10',
  });
  const userB = makeUserRow({
    id: '0195b000-0000-7000-8000-000000000002',
    publicId: '22222222-2222-4222-8222-222222222222',
    handle: 'bob_m10',
    handleNormalized: 'bob_m10',
    fullName: 'Bob M10',
  });
  const userC = makeUserRow({
    id: '0195b000-0000-7000-8000-000000000003',
    publicId: '33333333-3333-4333-8333-333333333333',
    handle: 'charlie_blocked',
    handleNormalized: 'charlie_blocked',
    fullName: 'Charlie Blocked',
  });
  const userD = makeUserRow({
    id: '0195b000-0000-7000-8000-000000000004',
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

  function createInMemoryM10Environment(options?: {
    readonly bobFollowsAlice?: boolean;
    readonly initialNowMs?: number;
  }) {
    let currentTimeMs = options?.initialNowMs ?? Date.parse('2026-11-24T12:00:00.000Z');
    const nowFn = () => new Date(currentTimeMs);

    const usersById = new Map<string, UserRow>([
      [userA.id, userA],
      [userB.id, userB],
      [userC.id, userC],
      [userD.id, userD],
    ]);
    const conversationsById = new Map<string, ConversationRow>();
    const participantsByConv = new Map<string, ConversationParticipantRow[]>();
    const messagesById = new Map<string, MessageRow>();
    const deletions = new Set<string>(); // `${messageId}:${userId}`
    let bobFollowsAlice = options?.bobFollowsAlice ?? true;
    const recalledAttachments: string[] = [];

    const rateLimiter = {
      consume: vi.fn().mockResolvedValue({
        allowed: true,
        limit: 60,
        remaining: 59,
        resetAt: currentTimeMs + 60_000,
        retryAfterSeconds: 0,
      }),
    };
    const realtime = new InMemoryRealtimeAdapter({ isolated: true, now: () => currentTimeMs });

    const listVisibleMsgsForUser = (convId: string, uid: string, clearedBeforeSeq: number) =>
      Array.from(messagesById.values())
        .filter(
          (m) =>
            m.conversationId === convId &&
            m.seq > clearedBeforeSeq &&
            !deletions.has(`${m.id}:${uid}`),
        )
        .sort((a, b) => a.seq - b.seq);

    const repo: Partial<ChatRepository> = {
      runInRlsTx: async <T>(
        _actorId: string,
        fn: (tx: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => fn({} as DatabaseTransaction),
      getDatabaseNow: vi.fn(async () => nowFn()),
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
          return {
            blockedByActor: isBlocked && actorId === userA.id,
            blockedByTarget: isBlocked && targetId === userA.id,
            actorFollowStatus:
              actorId === userB.id && targetId === userA.id && bobFollowsAlice
                ? 'following'
                : 'none',
            targetFollowStatus:
              actorId === userA.id && targetId === userB.id && bobFollowsAlice
                ? 'following'
                : 'none',
          };
        },
      ),
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
      findConversationById: vi.fn(async (cid: string) => conversationsById.get(cid) ?? null),
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
            pinnedAt: null,
            mutedAt: null,
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
      advanceParticipantLastReadSeq: vi.fn(async (params) => {
        const list = participantsByConv.get(params.conversationId) ?? [];
        const safe = Math.max(0, Math.min(params.targetSeq, params.conversationLastSeq));
        let updated: ConversationParticipantRow | null = null;
        const nextList: ConversationParticipantRow[] = list.map((p) => {
          if (p.userId === params.userId) {
            const merged: ConversationParticipantRow = {
              ...p,
              lastReadSeq: Math.max(Number(p.lastReadSeq), safe),
            };
            updated = merged;
            return merged;
          }
          return p;
        });
        participantsByConv.set(params.conversationId, nextList);
        return updated;
      }),
      clearAndHideConversationForUser: vi.fn(async (params) => {
        const list = participantsByConv.get(params.conversationId) ?? [];
        let updated: ConversationParticipantRow | null = null;
        const nextList: ConversationParticipantRow[] = list.map((p) => {
          if (p.userId === params.userId) {
            // Điều chỉnh (2): KHÔNG tăng `lastReadSeq`.
            const merged: ConversationParticipantRow = {
              ...p,
              clearedBeforeSeq: Math.max(Number(p.clearedBeforeSeq), params.conversationLastSeq),
              hiddenAt: params.now,
            };
            updated = merged;
            return merged;
          }
          return p;
        });
        participantsByConv.set(params.conversationId, nextList);
        return updated;
      }),
      findLatestVisibleMessageForConversation: vi.fn(async (params) => {
        const visible = listVisibleMsgsForUser(
          params.conversationId,
          params.viewerUserId,
          params.clearedBeforeSeq,
        );
        const last = visible[visible.length - 1];
        if (!last) return null;
        return { row: last, senderPublicId: usersById.get(last.senderId)!.publicId };
      }),
      countUnreadPrimaryConversationsForUser: vi.fn(async (uid: string) => {
        let count = 0;
        for (const [cid, parts] of participantsByConv.entries()) {
          const conv = conversationsById.get(cid);
          const myPart = parts.find((p) => p.userId === uid);
          const peerPart = parts.find((p) => p.userId !== uid);
          if (
            !conv ||
            !myPart ||
            !peerPart ||
            myPart.inboxState !== 'primary' ||
            myPart.hiddenAt !== null ||
            conv.lastSeq <= myPart.clearedBeforeSeq
          ) {
            continue;
          }
          const isBlocked =
            (uid === userA.id && peerPart.userId === userC.id) ||
            (uid === userC.id && peerPart.userId === userA.id);
          if (isBlocked) continue;

          const allMsgs = Array.from(messagesById.values()).filter((m) => m.conversationId === cid);
          let maxOwnSeq = 0;
          for (const m of allMsgs) {
            if (m.senderId === uid && m.seq > maxOwnSeq) {
              maxOwnSeq = m.seq;
            }
          }
          const readFloor = Math.max(
            Number(myPart.lastReadSeq),
            Number(myPart.clearedBeforeSeq),
            maxOwnSeq,
          );
          const hasUnread = allMsgs.some(
            (m) => m.senderId !== uid && m.seq > readFloor && !deletions.has(`${m.id}:${uid}`),
          );
          if (hasUnread) {
            count += 1;
          }
        }
        return count;
      }),
      countPendingConversationsForUser: vi.fn(async (uid: string) => {
        let count = 0;
        for (const [cid, parts] of participantsByConv.entries()) {
          const conv = conversationsById.get(cid);
          const myPart = parts.find((p) => p.userId === uid);
          if (
            conv &&
            myPart &&
            myPart.inboxState === 'pending' &&
            myPart.hiddenAt === null &&
            conv.lastSeq > myPart.clearedBeforeSeq
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
            actorParticipant.hiddenAt !== null ||
            conv.lastSeq <= actorParticipant.clearedBeforeSeq
          ) {
            continue;
          }
          const peerUser = usersById.get(peerParticipant.userId)!;
          const visible = listVisibleMsgsForUser(
            cid,
            params.userId,
            Number(actorParticipant.clearedBeforeSeq),
          );
          const lastMsg = visible[visible.length - 1] ?? null;
          out.push({
            conversation: conv,
            actorParticipant,
            peerParticipant,
            peerUser,
            lastMessage: lastMsg
              ? { row: lastMsg, senderPublicId: usersById.get(lastMsg.senderId)!.publicId }
              : null,
          });
        }
        return out;
      }),
      findMessageByClientMsgId: vi.fn(async (cid, sid, clientMsgId) => {
        for (const m of messagesById.values()) {
          if (m.conversationId === cid && m.senderId === sid && m.clientMsgId === clientMsgId) {
            return m;
          }
        }
        return null;
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
          callEventMeta: null,
          attachmentStorageKey: null,
          replyToMessageId: params.replyToMessageId ?? null,
          isForwarded: params.isForwarded === true,
          editCount: 0,
          editedAt: null,
          recalledAt: null,
          createdAt: params.now,
        };
        messagesById.set(msg.id, msg);
        return msg;
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
        for (const m of messagesById.values()) {
          if (m.publicId === pid) return m;
        }
        return null;
      }),
      isMessageDeletedForUser: vi.fn(async (mid: string, uid: string) =>
        deletions.has(`${mid}:${uid}`),
      ),
      updateEditedMessageAtomically: vi.fn(async (params) => {
        const existing = messagesById.get(params.messageId);
        if (
          !existing ||
          existing.senderId !== params.senderId ||
          existing.messageType !== 'text' ||
          existing.recalledAt !== null ||
          existing.editCount >= params.maxEditCount ||
          currentTimeMs - existing.createdAt.getTime() > params.editWindowSeconds * 1000
        ) {
          return null;
        }
        const updated: MessageRow = {
          ...existing,
          ciphertext: params.ciphertext,
          cryptoHeader: params.cryptoHeader,
          editCount: existing.editCount + 1,
          editedAt: nowFn(),
        };
        messagesById.set(existing.id, updated);
        return updated;
      }),
      recallMessageAtomically: vi.fn(async (params) => {
        const existing = messagesById.get(params.messageId);
        if (
          !existing ||
          existing.senderId !== params.senderId ||
          existing.recalledAt !== null ||
          currentTimeMs - existing.createdAt.getTime() > params.recallWindowSeconds * 1000
        ) {
          return null;
        }
        const recalled: MessageRow = {
          ...existing,
          ciphertext: null,
          cryptoHeader: null,
          attachmentStorageKey: null,
          recalledAt: nowFn(),
        };
        messagesById.set(existing.id, recalled);
        return recalled;
      }),
      insertMessageUserDeletion: vi.fn(async (params) => {
        deletions.add(`${params.messageId}:${params.userId}`);
      }),
      listMessagesForConversation: vi.fn(async (params) => {
        const minSeq = Math.max(params.clearedBeforeSeq, params.afterSeq ?? 0);
        const list = Array.from(messagesById.values()).filter(
          (m) =>
            m.conversationId === params.conversationId &&
            m.seq > minSeq &&
            (params.cursorSeq === undefined || m.seq < params.cursorSeq) &&
            (!params.viewerUserId || !deletions.has(`${m.id}:${params.viewerUserId}`)),
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
      notificationService: null,
      now: nowFn,
      onAttachmentRecalled: async (key) => {
        recalledAttachments.push(key);
      },
    });
    setChatServiceForTesting(service);

    return {
      rateLimiter,
      realtime,
      recalledAttachments,
      advanceClockMs: (deltaMs: number) => {
        currentTimeMs += deltaMs;
      },
      setBobFollowsAlice: (val: boolean) => {
        bobFollowsAlice = val;
      },
      getRawMessageByPublicId: (pid: string): MessageRow | null => {
        for (const m of messagesById.values()) {
          if (m.publicId === pid) return m;
        }
        return null;
      },
      seedAttachmentKeyOnMessage: (pid: string, key: string) => {
        for (const m of messagesById.values()) {
          if (m.publicId === pid) {
            messagesById.set(m.id, { ...m, attachmentStorageKey: key });
          }
        }
      },
      setMessageTypeForTesting: (pid: string, messageType: MessageRow['messageType']) => {
        for (const m of messagesById.values()) {
          if (m.publicId === pid) {
            messagesById.set(m.id, { ...m, messageType });
          }
        }
      },
      getParticipantRow: (convPublicId: string, uid: string): ConversationParticipantRow | null => {
        for (const [cid, conv] of conversationsById.entries()) {
          if (conv.publicId === convPublicId) {
            return participantsByConv.get(cid)?.find((p) => p.userId === uid) ?? null;
          }
        }
        return null;
      },
      getParticipantInboxState: (
        convPublicId: string,
        uid: string,
      ): ConversationInboxState | null => {
        for (const [cid, conv] of conversationsById.entries()) {
          if (conv.publicId === convPublicId) {
            return participantsByConv.get(cid)?.find((p) => p.userId === uid)?.inboxState ?? null;
          }
        }
        return null;
      },
    };
  }

  it('từ chối ẩn danh (401) + Cache-Control: no-store & cưỡng chế CSRF 3 lớp (403) trên toàn bộ 5 endpoint M10 và proxy()', async () => {
    const origin = getTestOrigin();
    const msgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const convId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const validCsrfNoAuth = {
      origin,
      'sec-fetch-site': 'same-origin',
      cookie: `tomato_csrf=${TEST_CSRF}`,
      [CSRF_HEADER_NAME]: TEST_CSRF,
      'Content-Type': 'application/json',
    };

    const anonResponses = await Promise.all([
      messageDetailGet(new Request(`${origin}/api/v1/messages/${msgId}`), {
        params: Promise.resolve({ messagePublicId: msgId }),
      }),
      messageEditPatch(
        new Request(`${origin}/api/v1/messages/${msgId}`, {
          method: 'PATCH',
          headers: validCsrfNoAuth,
          body: '{}',
        }),
        { params: Promise.resolve({ messagePublicId: msgId }) },
      ),
      messageRecallPost(
        new Request(`${origin}/api/v1/messages/${msgId}/recall`, {
          method: 'POST',
          headers: validCsrfNoAuth,
          body: '{}',
        }),
        { params: Promise.resolve({ messagePublicId: msgId }) },
      ),
      messageDeleteForMe(
        new Request(`${origin}/api/v1/messages/${msgId}/for-me`, {
          method: 'DELETE',
          headers: validCsrfNoAuth,
        }),
        { params: Promise.resolve({ messagePublicId: msgId }) },
      ),
      conversationDelete(
        new Request(`${origin}/api/v1/conversations/${convId}`, {
          method: 'DELETE',
          headers: validCsrfNoAuth,
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
    ]);

    for (const res of anonResponses) {
      expect(res.status).toBe(401);
      expect(res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    }

    const proxyRes = proxy(new NextRequest(`http://localhost:3000/api/v1/messages/${msgId}`));
    expect(proxyRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);

    // CSRF 3 lớp (thiếu header x-csrf-token -> 403 CSRF_VALIDATION_FAILED).
    const noCsrfHeaders = createAuthHeaders(origin, 'tok-a', false);
    const csrfResponses = await Promise.all([
      messageEditPatch(
        new Request(`${origin}/api/v1/messages/${msgId}`, {
          method: 'PATCH',
          headers: noCsrfHeaders,
          body: '{}',
        }),
        { params: Promise.resolve({ messagePublicId: msgId }) },
      ),
      messageRecallPost(
        new Request(`${origin}/api/v1/messages/${msgId}/recall`, {
          method: 'POST',
          headers: noCsrfHeaders,
          body: '{}',
        }),
        { params: Promise.resolve({ messagePublicId: msgId }) },
      ),
      messageDeleteForMe(
        new Request(`${origin}/api/v1/messages/${msgId}/for-me`, {
          method: 'DELETE',
          headers: noCsrfHeaders,
        }),
        { params: Promise.resolve({ messagePublicId: msgId }) },
      ),
      conversationDelete(
        new Request(`${origin}/api/v1/conversations/${convId}`, {
          method: 'DELETE',
          headers: noCsrfHeaders,
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
    ]);

    for (const res of csrfResponses) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'CSRF_VALIDATION_FAILED',
      );
    }
  });

  it('Sửa & Thu hồi theo đồng hồ Server (phút 4 thành công, phút 5+1s từ chối), tối đa 5 lần sửa, chặn tái sử dụng IV, Tombstone NULL & Ma trận BOLA (User B/C/D)', async () => {
    const origin = getTestOrigin();
    installSessionLookup({
      'tok-a': makePrincipal(userA),
      'tok-b': makePrincipal(userB),
      'tok-c': makePrincipal(userC),
      'tok-d': makePrincipal(userD),
    });

    const env = createInMemoryM10Environment({ bobFollowsAlice: true });
    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(userA.publicId);
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(userB.publicId);
    const bobTargets = [
      {
        devicePublicId: bobDevice.devicePublicId,
        keyFingerprint: bobDevice.keyFingerprint,
        identityPublicKeyJwk: bobDevice.identityPublicKeyJwk,
        signingPublicKeyJwk: bobDevice.signingPublicKeyJwk,
      },
    ];

    // 1. Alice tạo hội thoại primary với Bob và gửi 3 tin nhắn (2 tin text, 1 tin image).
    const convRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    const convId = ((await convRes.json()) as { conversation: { public_id: string } }).conversation
      .public_id;

    async function sendMsg(
      clientMsgId: string,
      text: string,
      messageType: 'text' | 'image' = 'text',
    ) {
      const envelope = await encryptDirectMessage({
        conversationPublicId: convId,
        senderPublicId: userA.publicId,
        clientMsgId,
        plaintext: text,
        senderDevice: aliceDevice,
        recipientDevices: bobTargets,
      });
      const res = await messagesPost(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-a'),
          body: JSON.stringify({
            clientMsgId,
            messageType,
            ciphertext: envelope.ciphertext,
            cryptoHeader: envelope.cryptoHeader,
          }),
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        message: { public_id: string; clientMsgId: string; cryptoHeader: { iv: string } };
      };
      return { publicId: body.message.public_id, envelope, clientMsgId };
    }

    const msgEdit = await sendMsg('m10_msg_edit_1', 'Nội dung ban đầu');
    const msgRecall = await sendMsg('m10_msg_recall_1', 'Tin sẽ thu hồi');
    const msgExpire = await sendMsg('m10_msg_expire_1', 'Tin sẽ quá hạn');
    const msgImage = await sendMsg('m10_msg_image_1', 'Ảnh HD', 'text');
    env.setMessageTypeForTesting(msgImage.publicId, 'image');

    // 2. Chống tái sử dụng IV AES-GCM: gửi lại đúng cryptoHeader.iv cũ -> Server từ chối 400.
    const reusedIvRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgEdit.publicId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          ciphertext: msgEdit.envelope.ciphertext,
          cryptoHeader: msgEdit.envelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msgEdit.publicId }) },
    );
    expect(reusedIvRes.status).toBe(400);

    // Zod .strict(): từ chối field lạ.
    const extraFieldEditRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgEdit.publicId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          ciphertext: msgEdit.envelope.ciphertext,
          cryptoHeader: msgEdit.envelope.cryptoHeader,
          editCount: 0,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msgEdit.publicId }) },
    );
    expect(extraFieldEditRes.status).toBe(400);

    // 3. Chỉnh sửa tin nhắn ở phút thứ 4 (+240s) -> thành công 200 với IV mới, Bob tải lại 1 bản ghi và giải mã khớp.
    env.advanceClockMs(240_000);
    env.realtime.clearPublishedEvents();

    let prevIv = msgEdit.envelope.cryptoHeader.iv;
    for (let editNum = 1; editNum <= 5; editNum += 1) {
      const reEncrypted = await reEncryptEditedDirectMessage({
        conversationPublicId: convId,
        senderPublicId: userA.publicId,
        clientMsgId: msgEdit.clientMsgId,
        plaintext: `Bản sửa lần ${editNum}`,
        senderDevice: aliceDevice,
        recipientDevices: bobTargets,
        previousIv: prevIv,
      });
      expect(reEncrypted.cryptoHeader.iv).not.toBe(prevIv);
      prevIv = reEncrypted.cryptoHeader.iv;

      const editRes = await messageEditPatch(
        new Request(`${origin}/api/v1/messages/${msgEdit.publicId}`, {
          method: 'PATCH',
          headers: createAuthHeaders(origin, 'tok-a'),
          body: JSON.stringify({
            ciphertext: reEncrypted.ciphertext,
            cryptoHeader: reEncrypted.cryptoHeader,
          }),
        }),
        { params: Promise.resolve({ messagePublicId: msgEdit.publicId }) },
      );
      expect(editRes.status).toBe(200);
      const editBody = (await editRes.json()) as {
        message: { editCount: number; editedAt: string | null };
      };
      expect(editBody.message.editCount).toBe(editNum);
      expect(editBody.message.editedAt).not.toBeNull();
    }

    // Kiểm tra sự kiện realtime `chat.message.updated`: gửi cho A & B, TUYỆT ĐỐI KHÔNG chứa ciphertext / cryptoHeader!
    const updatedEvents = env.realtime
      .getPublishedEvents()
      .filter((e) => e.event === 'chat.message.updated');
    expect(updatedEvents.some((e) => e.channel === `user:${userB.publicId}`)).toBe(true);
    for (const ev of updatedEvents) {
      expect(ev.data).toHaveProperty('messagePublicId', msgEdit.publicId);
      expect(ev.data).not.toHaveProperty('ciphertext');
      expect(ev.data).not.toHaveProperty('cryptoHeader');
    }

    // Bob gọi GET /api/v1/messages/[id] tải đúng 1 bản ghi và giải mã ra "Bản sửa lần 5".
    const bobSingleGetRes = await messageDetailGet(
      new Request(`${origin}/api/v1/messages/${msgEdit.publicId}`, {
        headers: { cookie: 'tomato_at=tok-b' },
      }),
      { params: Promise.resolve({ messagePublicId: msgEdit.publicId }) },
    );
    expect(bobSingleGetRes.status).toBe(200);
    const bobSingleDto = (
      (await bobSingleGetRes.json()) as {
        message: {
          conversationPublicId: string;
          senderPublicId: string;
          clientMsgId: string;
          ciphertext: string;
          cryptoHeader: Parameters<typeof decryptDirectMessage>[0]['cryptoHeader'];
        };
      }
    ).message;
    const decryptedByBob = await decryptDirectMessage({
      conversationPublicId: bobSingleDto.conversationPublicId,
      senderPublicId: bobSingleDto.senderPublicId,
      clientMsgId: bobSingleDto.clientMsgId,
      ciphertext: bobSingleDto.ciphertext,
      cryptoHeader: bobSingleDto.cryptoHeader,
      receiverKeyMaterials: [bobDevice],
    });
    expect(decryptedByBob.text).toBe('Bản sửa lần 5');

    // Lần sửa thứ 6 -> từ chối 409 CHAT_MESSAGE_EDIT_LIMIT_REACHED.
    const sixthEnv = await reEncryptEditedDirectMessage({
      conversationPublicId: convId,
      senderPublicId: userA.publicId,
      clientMsgId: msgEdit.clientMsgId,
      plaintext: 'Lần sửa thứ 6 bị chặn',
      senderDevice: aliceDevice,
      recipientDevices: bobTargets,
      previousIv: prevIv,
    });
    const sixthEditRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgEdit.publicId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          ciphertext: sixthEnv.ciphertext,
          cryptoHeader: sixthEnv.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msgEdit.publicId }) },
    );
    expect(sixthEditRes.status).toBe(409);
    expect(((await sixthEditRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_MESSAGE_EDIT_LIMIT_REACHED',
    );

    // Sửa tin nhắn ảnh (không phải text) -> từ chối 409 CHAT_MESSAGE_EDIT_UNSUPPORTED_TYPE.
    const editImgEnv = await reEncryptEditedDirectMessage({
      conversationPublicId: convId,
      senderPublicId: userA.publicId,
      clientMsgId: msgImage.clientMsgId,
      plaintext: 'Sửa ảnh',
      senderDevice: aliceDevice,
      recipientDevices: bobTargets,
      previousIv: msgImage.envelope.cryptoHeader.iv,
    });
    const editImgRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgImage.publicId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          ciphertext: editImgEnv.ciphertext,
          cryptoHeader: editImgEnv.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msgImage.publicId }) },
    );
    expect(editImgRes.status).toBe(409);
    expect(((await editImgRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_MESSAGE_EDIT_UNSUPPORTED_TYPE',
    );

    // 4. Thu hồi tin nhắn ở phút thứ 4 -> thành công 200, xóa sạch ciphertext/cryptoHeader về NULL & kích hoạt hook M11.
    env.seedAttachmentKeyOnMessage(msgRecall.publicId, 'encrypted/m11-sample-blob.bin');
    env.realtime.clearPublishedEvents();

    const recallRes = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${msgRecall.publicId}/recall`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: msgRecall.publicId }) },
    );
    expect(recallRes.status).toBe(200);
    const recallBody = (await recallRes.json()) as {
      message: { ciphertext: string | null; cryptoHeader: unknown; recalledAt: string | null };
    };
    expect(recallBody.message.ciphertext).toBeNull();
    expect(recallBody.message.cryptoHeader).toBeNull();
    expect(recallBody.message.recalledAt).not.toBeNull();

    const rawRecalled = env.getRawMessageByPublicId(msgRecall.publicId);
    expect(rawRecalled?.ciphertext).toBeNull();
    expect(rawRecalled?.cryptoHeader).toBeNull();
    expect(rawRecalled?.attachmentStorageKey).toBeNull();
    expect(env.recalledAttachments).toEqual(['encrypted/m11-sample-blob.bin']);

    // Cố sửa tin đã thu hồi -> 409 CHAT_MESSAGE_ALREADY_RECALLED.
    const editRecalledRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgRecall.publicId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          ciphertext: sixthEnv.ciphertext,
          cryptoHeader: sixthEnv.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msgRecall.publicId }) },
    );
    expect(editRecalledRes.status).toBe(409);
    expect(((await editRecalledRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_MESSAGE_ALREADY_RECALLED',
    );

    // 5. Ma trận BOLA:
    //    - User B (thành viên nhưng không phải chủ tin) cố sửa / thu hồi tin của A -> 403 FORBIDDEN.
    const bobEditAliceRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgExpire.publicId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-b'),
        body: JSON.stringify({
          ciphertext: sixthEnv.ciphertext,
          cryptoHeader: sixthEnv.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msgExpire.publicId }) },
    );
    expect(bobEditAliceRes.status).toBe(403);

    const bobRecallAliceRes = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${msgExpire.publicId}/recall`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: msgExpire.publicId }) },
    );
    expect(bobRecallAliceRes.status).toBe(403);

    //    - User D (ngoài cuộc) & User C (bị chặn) cố gọi toàn bộ 5 endpoint -> 404 NOT_FOUND đồng nhất!
    for (const token of ['tok-d', 'tok-c']) {
      const checks = await Promise.all([
        messageDetailGet(
          new Request(`${origin}/api/v1/messages/${msgExpire.publicId}`, {
            headers: { cookie: `tomato_at=${token}` },
          }),
          { params: Promise.resolve({ messagePublicId: msgExpire.publicId }) },
        ),
        messageEditPatch(
          new Request(`${origin}/api/v1/messages/${msgExpire.publicId}`, {
            method: 'PATCH',
            headers: createAuthHeaders(origin, token),
            body: JSON.stringify({
              ciphertext: sixthEnv.ciphertext,
              cryptoHeader: sixthEnv.cryptoHeader,
            }),
          }),
          { params: Promise.resolve({ messagePublicId: msgExpire.publicId }) },
        ),
        messageRecallPost(
          new Request(`${origin}/api/v1/messages/${msgExpire.publicId}/recall`, {
            method: 'POST',
            headers: createAuthHeaders(origin, token),
            body: '{}',
          }),
          { params: Promise.resolve({ messagePublicId: msgExpire.publicId }) },
        ),
        messageDeleteForMe(
          new Request(`${origin}/api/v1/messages/${msgExpire.publicId}/for-me`, {
            method: 'DELETE',
            headers: createAuthHeaders(origin, token),
          }),
          { params: Promise.resolve({ messagePublicId: msgExpire.publicId }) },
        ),
        conversationDelete(
          new Request(`${origin}/api/v1/conversations/${convId}`, {
            method: 'DELETE',
            headers: createAuthHeaders(origin, token),
          }),
          { params: Promise.resolve({ conversationPublicId: convId }) },
        ),
      ]);
      for (const res of checks) {
        expect(res.status).toBe(404);
      }
    }

    // 6. Vượt mốc 5 phút (+61s nữa => tổng 301 giây sau khi tạo): cả Sửa & Thu hồi đều bị Server từ chối 403!
    env.advanceClockMs(61_000);
    const expiredEditEnv = await reEncryptEditedDirectMessage({
      conversationPublicId: convId,
      senderPublicId: userA.publicId,
      clientMsgId: msgExpire.clientMsgId,
      plaintext: 'Sửa ở giây 301',
      senderDevice: aliceDevice,
      recipientDevices: bobTargets,
      previousIv: msgExpire.envelope.cryptoHeader.iv,
    });
    const expiredEditRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgExpire.publicId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          ciphertext: expiredEditEnv.ciphertext,
          cryptoHeader: expiredEditEnv.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msgExpire.publicId }) },
    );
    expect(expiredEditRes.status).toBe(403);
    expect(((await expiredEditRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_MESSAGE_EDIT_WINDOW_EXPIRED',
    );

    const expiredRecallRes = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${msgExpire.publicId}/recall`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: msgExpire.publicId }) },
    );
    expect(expiredRecallRes.status).toBe(403);
    expect(((await expiredRecallRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_MESSAGE_RECALL_WINDOW_EXPIRED',
    );
  });

  it('Xóa 1 phía, Xóa đoạn chat (KHÔNG tăng last_read_seq tránh Đã xem giả), Mở lại direct không lộ preview cũ, Gỡ hidden_at cho cả actor & peer khi nhắn lại & Luật im lặng declined', async () => {
    const origin = getTestOrigin();
    installSessionLookup({
      'tok-a': makePrincipal(userA),
      'tok-b': makePrincipal(userB),
      'tok-d': makePrincipal(userD),
    });

    const env = createInMemoryM10Environment({ bobFollowsAlice: true });
    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(userA.publicId);
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(userB.publicId);
    const davidDevice = await getOrCreatePrimaryDeviceKeyMaterial(userD.publicId);

    const convRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    const convId = ((await convRes.json()) as { conversation: { public_id: string } }).conversation
      .public_id;

    async function sendBy(
      token: string,
      senderPublicId: string,
      senderDev: typeof aliceDevice,
      recipientDev: typeof bobDevice,
      targetConvId: string,
      clientMsgId: string,
      text: string,
    ) {
      const envelope = await encryptDirectMessage({
        conversationPublicId: targetConvId,
        senderPublicId,
        clientMsgId,
        plaintext: text,
        senderDevice: senderDev,
        recipientDevices: [
          {
            devicePublicId: recipientDev.devicePublicId,
            keyFingerprint: recipientDev.keyFingerprint,
            identityPublicKeyJwk: recipientDev.identityPublicKeyJwk,
            signingPublicKeyJwk: recipientDev.signingPublicKeyJwk,
          },
        ],
      });
      const res = await messagesPost(
        new Request(`${origin}/api/v1/conversations/${targetConvId}/messages`, {
          method: 'POST',
          headers: createAuthHeaders(origin, token),
          body: JSON.stringify({
            clientMsgId,
            messageType: 'text',
            ciphertext: envelope.ciphertext,
            cryptoHeader: envelope.cryptoHeader,
          }),
        }),
        { params: Promise.resolve({ conversationPublicId: targetConvId }) },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { message: { public_id: string; seq: number } }).message;
    }

    const msg1 = await sendBy(
      'tok-a',
      userA.publicId,
      aliceDevice,
      bobDevice,
      convId,
      'm10_dm_msg_01',
      'Tin 1',
    );
    const msg2 = await sendBy(
      'tok-a',
      userA.publicId,
      aliceDevice,
      bobDevice,
      convId,
      'm10_dm_msg_02',
      'Tin 2',
    );

    // Bob đọc tin 1 (`lastReadSeq = 1`), còn tin 2 chưa đọc -> Bob có unreadConversationsCount = 1.
    await readConversationPost(
      new Request(`${origin}/api/v1/conversations/${convId}/read`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
        body: JSON.stringify({ lastReadSeq: 1 }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );

    // 1. Alice xóa tin 2 ở phía mình (`DELETE /for-me`) -> biến mất ở Alice (preview lùi về Tin 1), còn nguyên ở Bob!
    env.realtime.clearPublishedEvents();
    const delForMeRes = await messageDeleteForMe(
      new Request(`${origin}/api/v1/messages/${msg2.public_id}/for-me`, {
        method: 'DELETE',
        headers: createAuthHeaders(origin, 'tok-a'),
      }),
      { params: Promise.resolve({ messagePublicId: msg2.public_id }) },
    );
    expect(delForMeRes.status).toBe(200);
    const delForMeBody = (await delForMeRes.json()) as {
      nextLastMessage: { public_id: string } | null;
    };
    expect(delForMeBody.nextLastMessage?.public_id).toBe(msg1.public_id);

    // Realtime `chat.message.deleted_for_me` CHỈ bắn về kênh Alice, TUYỆT ĐỐI KHÔNG bắn cho Bob!
    expect(
      env.realtime.getPublishedEvents().every((e) => e.channel === `user:${userA.publicId}`),
    ).toBe(true);

    // Idempotent retry trả 200.
    const delForMeRetry = await messageDeleteForMe(
      new Request(`${origin}/api/v1/messages/${msg2.public_id}/for-me`, {
        method: 'DELETE',
        headers: createAuthHeaders(origin, 'tok-a'),
      }),
      { params: Promise.resolve({ messagePublicId: msg2.public_id }) },
    );
    expect(delForMeRetry.status).toBe(200);

    // Alice không thấy msg2 trong GET /messages và GET /messages/[id] trả 404; Bob vẫn thấy cả 2 tin bình thường!
    const [aliceMsgsRes, aliceSingleDeletedRes, bobMsgsRes] = await Promise.all([
      messagesGet(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          headers: { cookie: 'tomato_at=tok-a' },
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
      messageDetailGet(
        new Request(`${origin}/api/v1/messages/${msg2.public_id}`, {
          headers: { cookie: 'tomato_at=tok-a' },
        }),
        { params: Promise.resolve({ messagePublicId: msg2.public_id }) },
      ),
      messagesGet(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          headers: { cookie: 'tomato_at=tok-b' },
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
    ]);
    expect(((await aliceMsgsRes.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(aliceSingleDeletedRes.status).toBe(404);
    expect(((await bobMsgsRes.json()) as { items: unknown[] }).items).toHaveLength(2);

    // 2. Điều chỉnh (2): Bob xóa đoạn hội thoại khi đang có tin 2 CHƯA ĐỌC (`lastReadSeq = 1`, `lastSeq = 2`):
    //    - `unreadConversationsCount` của Bob giảm sạch về 0.
    //    - `lastReadSeq` của Bob VẪN GIỮ NGUYÊN = 1 (KHÔNG tăng lên 2 -> Alice tải lại vẫn chỉ thấy `peerLastReadSeq = 1`, không bị lộ "Đã xem" giả!).
    //    - Không phát bất kỳ sự kiện realtime nào sang kênh Alice.
    env.realtime.clearPublishedEvents();
    const bobDelConvRes = await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(bobDelConvRes.status).toBe(200);
    const bobDelConvBody = (await bobDelConvRes.json()) as {
      clearedBeforeSeq: number;
      unreadConversationsCount: number;
    };
    expect(bobDelConvBody.clearedBeforeSeq).toBe(2);
    expect(bobDelConvBody.unreadConversationsCount).toBe(0);

    const bobParticipantAfterDelete = env.getParticipantRow(convId, userB.id);
    expect(bobParticipantAfterDelete?.clearedBeforeSeq).toBe(2);
    expect(bobParticipantAfterDelete?.lastReadSeq).toBe(1); // Không bị tăng giả lên 2!
    expect(bobParticipantAfterDelete?.hiddenAt).not.toBeNull();

    expect(
      env.realtime.getPublishedEvents().some((e) => e.channel === `user:${userA.publicId}`),
    ).toBe(false);

    // Alice tải lại chi tiết hội thoại -> `peerLastReadSeq` vẫn là 1 (KHÔNG nhảy sang 2!).
    const aliceDetailAfterBobDelete = await conversationDetailGet(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        headers: { cookie: 'tomato_at=tok-a' },
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(
      (
        (await aliceDetailAfterBobDelete.json()) as {
          conversation: { peerLastReadSeq: number | null };
        }
      ).conversation.peerLastReadSeq,
    ).toBe(1);

    // 3. Điều chỉnh (1a): Bob mở lại đoạn chat đã xóa qua `POST /api/v1/conversations/direct` (`last_seq === cleared_before_seq = 2`):
    //    PHẢI trả về `lastMessage: null` sạch sẽ, không lộ preview tin cũ, và chưa hiện trong inbox list khi chưa có tin mới!
    const bobReopenDirectRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
        body: JSON.stringify({ recipientPublicId: userA.publicId }),
      }),
    );
    expect(bobReopenDirectRes.status).toBe(200);
    const bobReopenDirectBody = (await bobReopenDirectRes.json()) as {
      conversation: { lastMessage: unknown; myState: { clearedBeforeSeq?: number } };
    };
    expect(bobReopenDirectBody.conversation.lastMessage).toBeNull();
    expect(bobReopenDirectBody.conversation.myState.clearedBeforeSeq).toBe(2);

    // Bob lại xóa đoạn chat rồi chủ động gửi tin trực tiếp (`hiddenAt !== null` cho chính `actorParticipant` = Bob):
    // Điều chỉnh (1b): `sendMessage` phải gỡ `hidden_at = NULL` cho chính `actorParticipant` để hội thoại hiện lại bình thường!
    await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(env.getParticipantRow(convId, userB.id)?.hiddenAt).not.toBeNull();

    await sendBy(
      'tok-b',
      userB.publicId,
      bobDevice,
      aliceDevice,
      convId,
      'dm_3_from_bob',
      'Bob nhắn lại sau khi xóa đoạn chat',
    );
    expect(env.getParticipantRow(convId, userB.id)?.hiddenAt).toBeNull();

    const bobListAfterSelfResend = await conversationsListGet(
      new Request(`${origin}/api/v1/conversations?tab=primary`, {
        headers: { cookie: 'tomato_at=tok-b' },
      }),
    );
    expect(((await bobListAfterSelfResend.json()) as { items: unknown[] }).items).toHaveLength(1);

    // 4. Alice xóa đoạn chat (`clearedBeforeSeq = 3, hiddenAt = NOW()`), sau đó Bob gửi tin thứ 4 ->
    //    `sendMessage` tự gỡ `hidden_at = NULL` cho `peerParticipant` (Alice), hội thoại hiện lại ở Alice
    //    và GET /messages bên Alice CHỈ thấy tin thứ 4 (`seq > 3`), không lộ tin 1–3!
    await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: createAuthHeaders(origin, 'tok-a'),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(env.getParticipantRow(convId, userA.id)?.hiddenAt).not.toBeNull();

    await sendBy(
      'tok-b',
      userB.publicId,
      bobDevice,
      aliceDevice,
      convId,
      'dm_4_reopen_alice',
      'Tin mới mở lại cho Alice',
    );
    expect(env.getParticipantRow(convId, userA.id)?.hiddenAt).toBeNull();

    const aliceMsgsAfterReopen = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        headers: { cookie: 'tomato_at=tok-a' },
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    const aliceReopenItems = (
      (await aliceMsgsAfterReopen.json()) as { items: Array<{ seq: number }> }
    ).items;
    expect(aliceReopenItems.map((m) => m.seq)).toEqual([4]);

    // 5. Bảo toàn luật im lặng `declined` từ M9: David gửi tin chờ cho Bob -> Bob từ chối (`decline`) ->
    //    David gửi tiếp tin thứ 2 -> `hiddenAt` của Bob VẪN giữ nguyên không gỡ ẩn và không bắn realtime cho Bob!
    env.setBobFollowsAlice(false);
    const convDBRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-d'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    const convDBId = ((await convDBRes.json()) as { conversation: { public_id: string } })
      .conversation.public_id;
    await sendBy(
      'tok-d',
      userD.publicId,
      davidDevice,
      bobDevice,
      convDBId,
      'm10_db_msg_01',
      'Chào Bob',
    );
    await declineConversationPost(
      new Request(`${origin}/api/v1/conversations/${convDBId}/decline`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ conversationPublicId: convDBId }) },
    );
    expect(env.getParticipantInboxState(convDBId, userB.id)).toBe('declined');

    env.realtime.clearPublishedEvents();
    await sendBy(
      'tok-d',
      userD.publicId,
      davidDevice,
      bobDevice,
      convDBId,
      'm10_db_msg_02',
      'Tin thứ 2 sau decline',
    );
    expect(env.getParticipantRow(convDBId, userB.id)?.hiddenAt).not.toBeNull();
    expect(
      env.realtime.getPublishedEvents().some((e) => e.channel === `user:${userB.publicId}`),
    ).toBe(false);
  });

  it('cưỡng chế Rate Limit (429 + Retry-After) trên endpoint chỉnh sửa tin nhắn M10', async () => {
    const origin = getTestOrigin();
    installSessionLookup({ 'tok-a': makePrincipal(userA) });
    const env = createInMemoryM10Environment();

    env.rateLimiter.consume.mockResolvedValueOnce({
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      retryAfterSeconds: 30,
    });

    const msgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const res = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: msgId }) },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });
});
