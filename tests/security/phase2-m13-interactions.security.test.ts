import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { GET as pinsListGet } from '@/app/api/v1/conversations/[conversationPublicId]/pins/route';
import { PATCH as preferencesPatch } from '@/app/api/v1/conversations/[conversationPublicId]/preferences/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { GET as forwardTargetsGet } from '@/app/api/v1/conversations/forward-targets/route';
import {
  DELETE as messagePinDelete,
  POST as messagePinPost,
} from '@/app/api/v1/messages/[messagePublicId]/pin/route';
import {
  DELETE as messageReactionDelete,
  PUT as messageReactionPut,
} from '@/app/api/v1/messages/[messagePublicId]/reaction/route';
import { POST as messageRecallPost } from '@/app/api/v1/messages/[messagePublicId]/recall/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import type { DatabaseTransaction } from '@/core/db';
import type {
  ConversationInboxState,
  ConversationParticipantRow,
  ConversationRow,
  MessagePinRow,
  MessageReactionRow,
  MessageRow,
  SessionRow,
  UserRow,
} from '@/core/db/schema';
import { InMemoryRealtimeAdapter, type LocalRealtimeEventMessage } from '@/core/realtime';
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
import {
  EMPTY_SOCIAL_RELATIONSHIP,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';

const TEST_CSRF = 'synthetic-csrf-token-for-m13-security-tests';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
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
    id: generateUuidV7(),
    publicId: generatePublicId(),
    username: 'user_test',
    handle: 'user_test',
    handleNormalized: 'user_test',
    fullName: 'User Test',
    bio: '',
    avatarUrl: null,
    avatarStorageKey: null,
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    followersCount: 0,
    followingCount: 0,
    handleChangedAt: null,
    gender: 'other',
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
    id: generateUuidV7(),
    publicId: generatePublicId(),
    userId: user.id,
    familyId: generatePublicId(),
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

function createAuthHeaders(
  origin: string,
  token: string | null,
  options: { includeCsrf?: boolean; contentType?: string } = {},
): Record<string, string> {
  const includeCsrf = options.includeCsrf ?? true;
  const cookies = [...(token ? [`tomato_at=${token}`] : []), `tomato_csrf=${TEST_CSRF}`];
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: cookies.join('; '),
    ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
    ...(includeCsrf ? { [CSRF_HEADER_NAME]: TEST_CSRF } : {}),
  };
}

afterEach(() => {
  resetSessionServiceForTesting();
  resetChatServiceForTesting();
  clearMemoryKeystoreForTesting();
  vi.restoreAllMocks();
});

describe('Security M13: Reactions, Reply, Forward eligibility, Message Pins (max 5 + deadlock), Conv Pins (max 3) & Mute Privacy', () => {
  function setupHarness() {
    const now = new Date('2026-11-24T12:00:00.000Z');
    const userA = makeUserRow({
      handle: 'alice_m13',
      handleNormalized: 'alice_m13',
      fullName: 'Alice M13',
    });
    const userB = makeUserRow({
      handle: 'bob_m13',
      handleNormalized: 'bob_m13',
      fullName: 'Bob M13',
    });
    const userC = makeUserRow({
      handle: 'charlie_blk',
      handleNormalized: 'charlie_blk',
      fullName: 'Charlie Blocked',
    });
    const userD = makeUserRow({
      handle: 'david_out',
      handleNormalized: 'david_out',
      fullName: 'David Outsider',
    });
    const userE = makeUserRow({
      handle: 'eva_mutual',
      handleNormalized: 'eva_mutual',
      fullName: 'Eva Mutual',
    });
    const userF = makeUserRow({
      handle: 'frank_oneway',
      handleNormalized: 'frank_oneway',
      fullName: 'Frank OneWay',
    });
    const userG = makeUserRow({
      handle: 'grace_chat',
      handleNormalized: 'grace_chat',
      fullName: 'Grace Chat',
    });
    const userH = makeUserRow({
      handle: 'henry_chat',
      handleNormalized: 'henry_chat',
      fullName: 'Henry Chat',
    });

    const allUsers = [userA, userB, userC, userD, userE, userF, userG, userH];
    const usersById = new Map(allUsers.map((u) => [u.id, u]));

    const tokenMap: Record<string, AuthenticatedPrincipal> = {
      'tok-a': makePrincipal(userA),
      'tok-b': makePrincipal(userB),
      'tok-c': makePrincipal(userC),
      'tok-d': makePrincipal(userD),
      'tok-e': makePrincipal(userE),
      'tok-f': makePrincipal(userF),
    };
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn(async (tok?: string | null) => {
        if (tok && tokenMap[tok]) return tokenMap[tok];
        const { AuthDomainError } = await import('@/modules/auth/auth.errors');
        throw new AuthDomainError({ status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }),
    } as unknown as SessionService);

    const conversationsById = new Map<string, ConversationRow>();
    const participantsByConv = new Map<string, ConversationParticipantRow[]>();
    const messagesById = new Map<string, MessageRow>();
    const deletions = new Set<string>();
    const reactionsByKey = new Map<string, MessageReactionRow>();
    const pinsByKey = new Map<string, MessagePinRow>();
    const realtime = new InMemoryRealtimeAdapter({ isolated: true });

    const getRelationshipSnapshot = vi.fn(
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
        // A <-> B: mutual following; A <-> E: mutual following; F -> A: 1-way follow only!
        if (
          (actorId === userA.id && (targetId === userB.id || targetId === userE.id)) ||
          ((actorId === userB.id || actorId === userE.id) && targetId === userA.id)
        ) {
          return {
            ...EMPTY_SOCIAL_RELATIONSHIP,
            actorFollowStatus: 'following',
            targetFollowStatus: 'following',
          };
        }
        if (actorId === userA.id && targetId === userF.id) {
          return { ...EMPTY_SOCIAL_RELATIONSHIP, targetFollowStatus: 'following' };
        }
        if (actorId === userF.id && targetId === userA.id) {
          return { ...EMPTY_SOCIAL_RELATIONSHIP, actorFollowStatus: 'following' };
        }
        // G & H follow A so A-G, A-H can be primary conversations.
        if (actorId === userA.id && (targetId === userG.id || targetId === userH.id)) {
          return {
            ...EMPTY_SOCIAL_RELATIONSHIP,
            actorFollowStatus: 'following',
            targetFollowStatus: 'following',
          };
        }
        return EMPTY_SOCIAL_RELATIONSHIP;
      },
    );

    const hasPriorPrimary = (u1: string, u2: string): boolean => {
      for (const conv of conversationsById.values()) {
        if (conv.lastSeq <= 0) continue;
        const parts = participantsByConv.get(conv.id) ?? [];
        const p1 = parts.find((p) => p.userId === u1);
        const p2 = parts.find((p) => p.userId === u2);
        if (p1?.inboxState === 'primary' && p2?.inboxState === 'primary') {
          return true;
        }
      }
      return false;
    };

    const chatRepo: Partial<ChatRepository> = {
      runInRlsTx: async <T>(_actorId: string, fn: (tx: DatabaseTransaction) => Promise<T>) =>
        fn({} as DatabaseTransaction),
      getDatabaseNow: vi.fn(async () => now),
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
      getRelationshipSnapshot,
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
      lockConversationById: vi.fn(async (cid: string) => conversationsById.get(cid) ?? null),
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
        const nextList = list.map((p) => {
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
      countPinnedPrimaryConversationsForUser: vi.fn(async (uid: string) => {
        let count = 0;
        for (const list of participantsByConv.values()) {
          const p = list.find((x) => x.userId === uid);
          if (p && p.inboxState === 'primary' && p.hiddenAt === null && p.pinnedAt !== null) {
            count += 1;
          }
        }
        return count;
      }),
      countUnreadPrimaryConversationsForUser: vi.fn(async (uid: string) => {
        let count = 0;
        for (const [cid, list] of participantsByConv.entries()) {
          const p = list.find((x) => x.userId === uid);
          const conv = conversationsById.get(cid);
          if (
            p &&
            conv &&
            p.inboxState === 'primary' &&
            p.hiddenAt === null &&
            p.mutedAt === null &&
            conv.lastSeq > Math.max(p.lastReadSeq, p.clearedBeforeSeq)
          ) {
            count += 1;
          }
        }
        return count;
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
        if (!existing || existing.senderId !== input.senderId || existing.recalledAt !== null) {
          return null;
        }
        const updated: MessageRow = {
          ...existing,
          ciphertext: null,
          cryptoHeader: null,
          attachmentStorageKey: null,
          recalledAt: now,
        };
        messagesById.set(existing.id, updated);
        return updated;
      }),
      upsertMessageReaction: vi.fn(async (params) => {
        const key = `${params.messageId}:${params.userId}`;
        const row: MessageReactionRow = {
          conversationId: params.conversationId,
          messageId: params.messageId,
          userId: params.userId,
          emoji: params.emoji,
          createdAt: params.now,
          updatedAt: params.now,
        };
        reactionsByKey.set(key, row);
        return row;
      }),
      deleteMessageReaction: vi.fn(async (mid: string, uid: string) =>
        reactionsByKey.delete(`${mid}:${uid}`),
      ),
      deleteAllReactionsForMessage: vi.fn(async (mid: string) => {
        for (const [k, v] of Array.from(reactionsByKey.entries())) {
          if (v.messageId === mid) reactionsByKey.delete(k);
        }
      }),
      listReactionsForMessageIds: vi.fn(async (cid: string, mids: readonly string[]) => {
        const set = new Set(mids);
        return Array.from(reactionsByKey.values())
          .filter((r) => r.conversationId === cid && set.has(r.messageId))
          .map((r) => ({
            messageId: r.messageId,
            userPublicId: usersById.get(r.userId)!.publicId,
            emoji: r.emoji,
            updatedAt: r.updatedAt,
          }));
      }),
      listPinnedMessageIdsInSet: vi.fn(async (cid: string, mids: readonly string[]) => {
        const set = new Set(mids);
        const out = new Set<string>();
        for (const p of pinsByKey.values()) {
          if (p.conversationId === cid && set.has(p.messageId)) out.add(p.messageId);
        }
        return out;
      }),
      listPinnedMessagesRawForConversation: vi.fn(async (cid: string) => {
        return Array.from(pinsByKey.values())
          .filter((p) => p.conversationId === cid)
          .sort((a, b) => b.pinnedAt.getTime() - a.pinnedAt.getTime())
          .map((pin) => {
            const msg = messagesById.get(pin.messageId)!;
            return {
              pin,
              message: msg,
              senderPublicId: usersById.get(msg.senderId)!.publicId,
              pinnedByPublicId: usersById.get(pin.pinnedByUserId)!.publicId,
            };
          });
      }),
      listMessageDeletionsForMessagesAndUsers: vi.fn(
        async (mids: readonly string[], uids: readonly string[]) => {
          const out: Array<{ readonly messageId: string; readonly userId: string }> = [];
          for (const mid of mids) {
            for (const uid of uids) {
              if (deletions.has(`${mid}:${uid}`)) out.push({ messageId: mid, userId: uid });
            }
          }
          return out;
        },
      ),
      insertMessagePin: vi.fn(async (params) => {
        const key = `${params.conversationId}:${params.messageId}`;
        if (pinsByKey.has(key)) return null;
        const row: MessagePinRow = {
          conversationId: params.conversationId,
          messageId: params.messageId,
          pinnedByUserId: params.pinnedByUserId,
          pinnedAt: params.now,
        };
        pinsByKey.set(key, row);
        return row;
      }),
      deleteMessagePinsByIds: vi.fn(async (cid: string, mids: readonly string[]) => {
        const deleted: string[] = [];
        for (const mid of mids) {
          if (pinsByKey.delete(`${cid}:${mid}`)) deleted.push(mid);
        }
        return deleted;
      }),
      hasPriorPrimaryConversationBetweenUsers: vi.fn(async (u1: string, u2: string) =>
        hasPriorPrimary(u1, u2),
      ),
      listEligibleForwardTargets: vi.fn(async (params) => {
        const out = [];
        for (const u of allUsers) {
          if (u.id === params.actorUserId) continue;
          const rel = await getRelationshipSnapshot(params.actorUserId, u.id);
          if (rel.blockedByActor || rel.blockedByTarget) continue;
          const isMutual =
            rel.actorFollowStatus === 'following' && rel.targetFollowStatus === 'following';
          const prior = hasPriorPrimary(params.actorUserId, u.id);
          if (!isMutual && !prior) continue;
          if (params.query) {
            const q = params.query.toLowerCase();
            if (!u.handleNormalized.includes(q) && !u.fullName.toLowerCase().includes(q)) continue;
          }
          out.push({
            publicId: u.publicId,
            handle: u.handle,
            fullName: u.fullName,
            avatarUrl: u.avatarUrl,
            isPrivate: u.isPrivate,
            conversationPublicId: null,
            lastMessageAt: null,
          });
        }
        return out.slice(0, params.limit);
      }),
      listMessagesForConversation: vi.fn(async (params) => {
        return Array.from(messagesById.values())
          .filter(
            (m) =>
              m.conversationId === params.conversationId &&
              m.seq > params.clearedBeforeSeq &&
              !deletions.has(`${m.id}:${params.viewerUserId}`),
          )
          .sort((a, b) => b.seq - a.seq)
          .map((row) => ({ row, senderPublicId: usersById.get(row.senderId)!.publicId }));
      }),
      findReplyTargetsMetadataByIds: vi.fn(async (params) => {
        const map = new Map();
        for (const id of params.messageIds) {
          const m = messagesById.get(id);
          if (m && m.conversationId === params.conversationId) {
            map.set(id, {
              messagePublicId: m.publicId,
              senderPublicId: usersById.get(m.senderId)!.publicId,
              seq: m.seq,
              messageType: m.messageType,
              recalledAt: m.recalledAt,
              deletedForViewer:
                m.seq <= params.clearedBeforeSeq || deletions.has(`${m.id}:${params.viewerUserId}`),
            });
          }
        }
        return map;
      }),
      findLatestVisibleMessageForConversation: vi.fn(async () => null),
    };

    setChatServiceForTesting(
      new ChatService({
        repository: chatRepo as ChatRepository,
        rateLimiter: createAllowAllRateLimiter(),
        realtimeProvider: realtime,
        notificationService: null,
        now: () => now,
      }),
    );

    return {
      userA,
      userB,
      userC,
      userD,
      userE,
      userF,
      userG,
      userH,
      conversationsById,
      participantsByConv,
      messagesById,
      deletions,
      pinsByKey,
      reactionsByKey,
      realtime,
    };
  }

  it('cưỡng chế đầy đủ BOLA 404, CSRF 403, PUT reaction idempotent, cross-conv reply 404 & thu hồi dọn cảm xúc/ghim', async () => {
    const origin = getTestOrigin();
    const { userA, userB, userD, messagesById, realtime } = setupHarness();

    // Tạo hội thoại primary A-B & pending A-D.
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

    const aMat = await getOrCreatePrimaryDeviceKeyMaterial(userA.publicId);
    const bMat = await getOrCreatePrimaryDeviceKeyMaterial(userB.publicId);
    const dMat = await getOrCreatePrimaryDeviceKeyMaterial(userD.publicId);

    const encAb = await encryptDirectMessage({
      conversationPublicId: abConvId,
      senderPublicId: userA.publicId,
      clientMsgId: 'msg-ab-1',
      plaintext: 'Chào Bob',
      senderDevice: aMat,
      recipientDevices: [
        {
          devicePublicId: bMat.devicePublicId,
          keyFingerprint: bMat.keyFingerprint,
          identityPublicKeyJwk: bMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bMat.signingPublicKeyJwk,
        },
      ],
    });
    const abMsgId = (
      (await (
        await messagesPost(
          new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({
              clientMsgId: 'msg-ab-1',
              messageType: 'text',
              ciphertext: encAb.ciphertext,
              cryptoHeader: encAb.cryptoHeader,
            }),
          }),
          { params: Promise.resolve({ conversationPublicId: abConvId }) },
        )
      ).json()) as { message: { public_id: string } }
    ).message.public_id;

    const encAd = await encryptDirectMessage({
      conversationPublicId: adConvId,
      senderPublicId: userA.publicId,
      clientMsgId: 'msg-ad-1',
      plaintext: 'Tin nhắn chờ',
      senderDevice: aMat,
      recipientDevices: [
        {
          devicePublicId: dMat.devicePublicId,
          keyFingerprint: dMat.keyFingerprint,
          identityPublicKeyJwk: dMat.identityPublicKeyJwk,
          signingPublicKeyJwk: dMat.signingPublicKeyJwk,
        },
      ],
    });
    const adMsgId = (
      (await (
        await messagesPost(
          new Request(`${origin}/api/v1/conversations/${adConvId}/messages`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({
              clientMsgId: 'msg-ad-1',
              messageType: 'text',
              ciphertext: encAd.ciphertext,
              cryptoHeader: encAd.cryptoHeader,
            }),
          }),
          { params: Promise.resolve({ conversationPublicId: adConvId }) },
        )
      ).json()) as { message: { public_id: string } }
    ).message.public_id;

    // 1. Anon 401, thiếu CSRF 403, emoji không hợp lệ 400, BOLA 404 (C & D).
    expect(
      (
        await messageReactionPut(
          new Request(`${origin}/api/v1/messages/${abMsgId}/reaction`, {
            method: 'PUT',
            headers: createAuthHeaders(origin, null, { contentType: 'application/json' }),
            body: JSON.stringify({ emoji: '❤️' }),
          }),
          { params: Promise.resolve({ messagePublicId: abMsgId }) },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await messageReactionPut(
          new Request(`${origin}/api/v1/messages/${abMsgId}/reaction`, {
            method: 'PUT',
            headers: createAuthHeaders(origin, 'tok-b', {
              includeCsrf: false,
              contentType: 'application/json',
            }),
            body: JSON.stringify({ emoji: '❤️' }),
          }),
          { params: Promise.resolve({ messagePublicId: abMsgId }) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await messageReactionPut(
          new Request(`${origin}/api/v1/messages/${abMsgId}/reaction`, {
            method: 'PUT',
            headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
            body: JSON.stringify({ emoji: '<script>' }),
          }),
          { params: Promise.resolve({ messagePublicId: abMsgId }) },
        )
      ).status,
    ).toBe(400);

    for (const outsiderTok of ['tok-c', 'tok-d'] as const) {
      expect(
        (
          await messageReactionPut(
            new Request(`${origin}/api/v1/messages/${abMsgId}/reaction`, {
              method: 'PUT',
              headers: createAuthHeaders(origin, outsiderTok, { contentType: 'application/json' }),
              body: JSON.stringify({ emoji: '❤️' }),
            }),
            { params: Promise.resolve({ messagePublicId: abMsgId }) },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await messagePinPost(
            new Request(`${origin}/api/v1/messages/${abMsgId}/pin`, {
              method: 'POST',
              headers: createAuthHeaders(origin, outsiderTok, { contentType: 'application/json' }),
              body: '{}',
            }),
            { params: Promise.resolve({ messagePublicId: abMsgId }) },
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
              headers: createAuthHeaders(origin, outsiderTok, { contentType: 'application/json' }),
              body: JSON.stringify({ muted: true }),
            }),
            { params: Promise.resolve({ conversationPublicId: abConvId }) },
          )
        ).status,
      ).toBe(404);
    }

    // 2. Tin nhắn đang chờ (pending) -> cấm thả cảm xúc & ghim (403).
    expect(
      (
        await messageReactionPut(
          new Request(`${origin}/api/v1/messages/${adMsgId}/reaction`, {
            method: 'PUT',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({ emoji: '❤️' }),
          }),
          { params: Promise.resolve({ messagePublicId: adMsgId }) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await messagePinPost(
          new Request(`${origin}/api/v1/messages/${adMsgId}/pin`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: '{}',
          }),
          { params: Promise.resolve({ messagePublicId: adMsgId }) },
        )
      ).status,
    ).toBe(403);

    // 3. PUT reaction là idempotent thuần túy (gọi 2 lần vẫn giữ nguyên emoji, không tự xóa); DELETE gỡ sạch.
    const r1 = await messageReactionPut(
      new Request(`${origin}/api/v1/messages/${abMsgId}/reaction`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
        body: JSON.stringify({ emoji: '😂' }),
      }),
      { params: Promise.resolve({ messagePublicId: abMsgId }) },
    );
    expect(r1.status).toBe(200);
    expect(r1.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const r2 = await messageReactionPut(
      new Request(`${origin}/api/v1/messages/${abMsgId}/reaction`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
        body: JSON.stringify({ emoji: '😂' }),
      }),
      { params: Promise.resolve({ messagePublicId: abMsgId }) },
    );
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { reactions: unknown[] }).reactions).toHaveLength(1);

    const rDel = await messageReactionDelete(
      new Request(`${origin}/api/v1/messages/${abMsgId}/reaction`, {
        method: 'DELETE',
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ messagePublicId: abMsgId }) },
    );
    expect(rDel.status).toBe(200);
    expect(((await rDel.json()) as { reactions: unknown[] }).reactions).toHaveLength(0);

    // 4. Cross-conversation reply injection (dùng messageId của hội thoại A-D để trả lời trong hội thoại A-B) -> 404!
    const crossReplyEnc = await encryptDirectMessage({
      conversationPublicId: abConvId,
      senderPublicId: userA.publicId,
      clientMsgId: 'msg-ab-cross-reply',
      plaintext: 'Cố trỏ chéo hội thoại',
      senderDevice: aMat,
      recipientDevices: [
        {
          devicePublicId: bMat.devicePublicId,
          keyFingerprint: bMat.keyFingerprint,
          identityPublicKeyJwk: bMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bMat.signingPublicKeyJwk,
        },
      ],
    });
    const crossReplyRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({
          clientMsgId: 'msg-ab-cross-reply',
          messageType: 'text',
          replyToMessagePublicId: adMsgId,
          ciphertext: crossReplyEnc.ciphertext,
          cryptoHeader: crossReplyEnc.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: abConvId }) },
    );
    expect(crossReplyRes.status).toBe(404);

    // 5. Ghim & thả cảm xúc rồi Thu hồi -> dọn sạch cảm xúc & gỡ ghim, đẩy event pin.updated(false).
    await messageReactionPut(
      new Request(`${origin}/api/v1/messages/${abMsgId}/reaction`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
        body: JSON.stringify({ emoji: '❤️' }),
      }),
      { params: Promise.resolve({ messagePublicId: abMsgId }) },
    );
    const pinOk = await messagePinPost(
      new Request(`${origin}/api/v1/messages/${abMsgId}/pin`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: abMsgId }) },
    );
    expect(pinOk.status).toBe(200);

    const bEvents: LocalRealtimeEventMessage[] = [];
    const unsubB = realtime.subscribeLocal(userB.publicId, (e) => bEvents.push(e));
    const recallRes = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${abMsgId}/recall`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
      }),
      { params: Promise.resolve({ messagePublicId: abMsgId }) },
    );
    expect(recallRes.status).toBe(200);
    unsubB();

    expect(
      bEvents.some(
        (e) =>
          e.event === 'chat.message.pin.updated' &&
          e.data.messagePublicId === abMsgId &&
          e.data.pinned === false,
      ),
    ).toBe(true);

    // Chèn một tin call_event và kiểm chứng bị từ chối 409 khi thả cảm xúc/ghim.
    const abConvInternalId = Array.from(messagesById.values())[0]!.conversationId;
    const callEventPubId = generatePublicId();
    messagesById.set(generateUuidV7(), {
      id: generateUuidV7(),
      publicId: callEventPubId,
      conversationId: abConvInternalId,
      senderId: userA.id,
      seq: 99,
      clientMsgId: 'call_evt_99',
      messageType: 'call_event',
      ciphertext: null,
      cryptoHeader: null,
      callEventMeta: {
        callPublicId: generatePublicId(),
        callType: 'audio',
        callerPublicId: userA.publicId,
        status: 'ended',
        durationSeconds: 10,
      },
      attachmentStorageKey: null,
      replyToMessageId: null,
      isForwarded: false,
      editCount: 0,
      editedAt: null,
      recalledAt: null,
      createdAt: new Date('2026-11-24T12:00:00.000Z'),
    });
    expect(
      (
        await messageReactionPut(
          new Request(`${origin}/api/v1/messages/${callEventPubId}/reaction`, {
            method: 'PUT',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: JSON.stringify({ emoji: '❤️' }),
          }),
          { params: Promise.resolve({ messagePublicId: callEventPubId }) },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await messagePinPost(
          new Request(`${origin}/api/v1/messages/${callEventPubId}/pin`, {
            method: 'POST',
            headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
            body: '{}',
          }),
          { params: Promise.resolve({ messagePublicId: callEventPubId }) },
        )
      ).status,
    ).toBe(409);
  });

  it('cưỡng chế điều kiện Chuyển tiếp (chỉ Mutual Follow ∪ Đã từng trò chuyện; chặn người lạ, follow 1 chiều chưa nhắn & Block)', async () => {
    const origin = getTestOrigin();
    const { userB, userC, userD, userE, userF } = setupHarness();

    // GET /forward-targets: Anon 401, extra query param -> Zod strict 400, A chỉ thấy Mutual (B, E, G, H) & không thấy C/D/F!
    expect(
      (await forwardTargetsGet(new Request(`${origin}/api/v1/conversations/forward-targets`)))
        .status,
    ).toBe(401);
    expect(
      (
        await forwardTargetsGet(
          new Request(`${origin}/api/v1/conversations/forward-targets?evil=1`, {
            headers: createAuthHeaders(origin, 'tok-a'),
          }),
        )
      ).status,
    ).toBe(400);

    const targetsRes = await forwardTargetsGet(
      new Request(`${origin}/api/v1/conversations/forward-targets`, {
        headers: createAuthHeaders(origin, 'tok-a'),
      }),
    );
    expect(targetsRes.status).toBe(200);
    expect(targetsRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const targetsJson = (await targetsRes.json()) as { items: Array<{ public_id: string }> };
    const targetIds = new Set(targetsJson.items.map((i) => i.public_id));
    expect(targetIds.has(userB.publicId)).toBe(true);
    expect(targetIds.has(userE.publicId)).toBe(true);
    expect(targetIds.has(userC.publicId)).toBe(false);
    expect(targetIds.has(userD.publicId)).toBe(false);
    expect(targetIds.has(userF.publicId)).toBe(false);

    // POST /conversations/direct { purpose: 'forward' }:
    // - Người lạ D -> 403 CHAT_FORWARD_TARGET_NOT_ELIGIBLE
    // - Follow 1 chiều F (chưa từng trò chuyện) -> 403 CHAT_FORWARD_TARGET_NOT_ELIGIBLE
    // - Người bị chặn C -> 404 NOT_FOUND
    // - Mutual Follow E -> 201 OK
    const fwdStranger = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ recipientPublicId: userD.publicId, purpose: 'forward' }),
      }),
    );
    expect(fwdStranger.status).toBe(403);
    expect(((await fwdStranger.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_FORWARD_TARGET_NOT_ELIGIBLE',
    );

    const fwdOneWay = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ recipientPublicId: userF.publicId, purpose: 'forward' }),
      }),
    );
    expect(fwdOneWay.status).toBe(403);

    const fwdBlocked = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ recipientPublicId: userC.publicId, purpose: 'forward' }),
      }),
    );
    expect(fwdBlocked.status).toBe(404);

    const fwdMutual = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ recipientPublicId: userE.publicId, purpose: 'forward' }),
      }),
    );
    expect(fwdMutual.status).toBe(201);
  });

  it('cưỡng chế tối đa 5 tin nhắn ghim + xử lý deadlock tin ẩn, tối đa 3 đoạn chat ghim & bảo mật riêng tư khi tắt thông báo', async () => {
    const origin = getTestOrigin();
    const { userA, userB, userE, userG, userH, participantsByConv, conversationsById, realtime } =
      setupHarness();

    const createPrimary = async (peerPublicId: string) =>
      (
        (await (
          await directConversationPost(
            new Request(`${origin}/api/v1/conversations/direct`, {
              method: 'POST',
              headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
              body: JSON.stringify({ recipientPublicId: peerPublicId }),
            }),
          )
        ).json()) as { conversation: { public_id: string } }
      ).conversation.public_id;

    const convAB = await createPrimary(userB.publicId);
    const convAE = await createPrimary(userE.publicId);
    const convAG = await createPrimary(userG.publicId);
    const convAH = await createPrimary(userH.publicId);

    // 1. Tối đa 3 đoạn chat ghim -> đoạn thứ 4 trả 409 CHAT_PINNED_CONVERSATIONS_LIMIT_REACHED.
    const aPrefEvents: LocalRealtimeEventMessage[] = [];
    const bPrefEvents: LocalRealtimeEventMessage[] = [];
    const unsubA = realtime.subscribeLocal(userA.publicId, (e) => aPrefEvents.push(e));
    const unsubB = realtime.subscribeLocal(userB.publicId, (e) => bPrefEvents.push(e));

    for (const cid of [convAB, convAE, convAG]) {
      const res = await preferencesPatch(
        new Request(`${origin}/api/v1/conversations/${cid}/preferences`, {
          method: 'PATCH',
          headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
          body: JSON.stringify({ pinned: true }),
        }),
        { params: Promise.resolve({ conversationPublicId: cid }) },
      );
      expect(res.status).toBe(200);
    }

    const fourthPin = await preferencesPatch(
      new Request(`${origin}/api/v1/conversations/${convAH}/preferences`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ pinned: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convAH }) },
    );
    expect(fourthPin.status).toBe(409);
    expect(((await fourthPin.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_PINNED_CONVERSATIONS_LIMIT_REACHED',
    );

    // Tắt thông báo đoạn chat A-B: sự kiện preferences.updated CHỈ bắn tới kênh A, tuyệt đối KHÔNG bắn sang B!
    const muteRes = await preferencesPatch(
      new Request(`${origin}/api/v1/conversations/${convAB}/preferences`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: JSON.stringify({ muted: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convAB }) },
    );
    expect(muteRes.status).toBe(200);
    unsubA();
    unsubB();

    expect(aPrefEvents.some((e) => e.event === 'chat.conversation.preferences.updated')).toBe(true);
    expect(bPrefEvents.some((e) => e.event === 'chat.conversation.preferences.updated')).toBe(
      false,
    );

    // 2. Tối đa 5 tin nhắn ghim trong A-B + chống deadlock khi User B đã xóa đoạn chat (`clearedBeforeSeq`).
    const aMat = await getOrCreatePrimaryDeviceKeyMaterial(userA.publicId);
    const bMat = await getOrCreatePrimaryDeviceKeyMaterial(userB.publicId);
    const msgIds: string[] = [];

    for (let i = 1; i <= 6; i += 1) {
      const clientMsgId = `pin-test-${i}`;
      const enc = await encryptDirectMessage({
        conversationPublicId: convAB,
        senderPublicId: userA.publicId,
        clientMsgId,
        plaintext: `Tin số ${i}`,
        senderDevice: aMat,
        recipientDevices: [
          {
            devicePublicId: bMat.devicePublicId,
            keyFingerprint: bMat.keyFingerprint,
            identityPublicKeyJwk: bMat.identityPublicKeyJwk,
            signingPublicKeyJwk: bMat.signingPublicKeyJwk,
          },
        ],
      });
      const res = await messagesPost(
        new Request(`${origin}/api/v1/conversations/${convAB}/messages`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
          body: JSON.stringify({
            clientMsgId,
            messageType: 'text',
            ciphertext: enc.ciphertext,
            cryptoHeader: enc.cryptoHeader,
          }),
        }),
        { params: Promise.resolve({ conversationPublicId: convAB }) },
      );
      msgIds.push(((await res.json()) as { message: { public_id: string } }).message.public_id);
    }

    // Ghim 5 tin đầu tiên (1..5).
    for (let i = 0; i < 5; i += 1) {
      const res = await messagePinPost(
        new Request(`${origin}/api/v1/messages/${msgIds[i]!}/pin`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
          body: '{}',
        }),
        { params: Promise.resolve({ messagePublicId: msgIds[i]! }) },
      );
      expect(res.status).toBe(200);
    }

    // Tin thứ 6 -> 409 CHAT_PINNED_MESSAGES_LIMIT_REACHED.
    const sixthPin = await messagePinPost(
      new Request(`${origin}/api/v1/messages/${msgIds[5]!}/pin`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a', { contentType: 'application/json' }),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: msgIds[5]! }) },
    );
    expect(sixthPin.status).toBe(409);
    expect(((await sixthPin.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_PINNED_MESSAGES_LIMIT_REACHED',
    );

    // Giả lập User B đã xóa đoạn chat qua tin số 5 (`clearedBeforeSeq = 5`):
    // B chỉ thấy 0/5 tin ghim, nhưng `totalPinnedCount = 5` & `hiddenPinnedCount = 5`.
    const convInternal = Array.from(conversationsById.values()).find((c) => c.publicId === convAB)!;
    const parts = participantsByConv.get(convInternal.id)!;
    participantsByConv.set(
      convInternal.id,
      parts.map((p) => (p.userId === userB.id ? { ...p, clearedBeforeSeq: 5 } : p)),
    );

    const bPinsRes = await pinsListGet(
      new Request(`${origin}/api/v1/conversations/${convAB}/pins`, {
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ conversationPublicId: convAB }) },
    );
    expect(bPinsRes.status).toBe(200);
    const bPinsJson = (await bPinsRes.json()) as {
      items: unknown[];
      totalPinnedCount: number;
      hiddenPinnedCount: number;
    };
    expect(bPinsJson.items).toHaveLength(0);
    expect(bPinsJson.totalPinnedCount).toBe(5);
    expect(bPinsJson.hiddenPinnedCount).toBe(5);

    // B có thể ghim tin số 6 bằng cờ `unpinOldestHiddenIfFull: true` (thoát deadlock sạch sẽ!).
    const recoverPin = await messagePinPost(
      new Request(`${origin}/api/v1/messages/${msgIds[5]!}/pin`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b', { contentType: 'application/json' }),
        body: JSON.stringify({ unpinOldestHiddenIfFull: true }),
      }),
      { params: Promise.resolve({ messagePublicId: msgIds[5]! }) },
    );
    expect(recoverPin.status).toBe(200);
    const recoverJson = (await recoverPin.json()) as {
      isPinned: boolean;
      totalPinnedCount: number;
      unpinnedHiddenMessagePublicId: string | null;
    };
    expect(recoverJson.isPinned).toBe(true);
    expect(recoverJson.totalPinnedCount).toBe(5);
    expect(recoverJson.unpinnedHiddenMessagePublicId).toBeTruthy();

    // B gỡ ghim tin số 6 -> 200.
    const unpinSix = await messagePinDelete(
      new Request(`${origin}/api/v1/messages/${msgIds[5]!}/pin`, {
        method: 'DELETE',
        headers: createAuthHeaders(origin, 'tok-b'),
      }),
      { params: Promise.resolve({ messagePublicId: msgIds[5]! }) },
    );
    expect(unpinSix.status).toBe(200);

    // Kiểm tra listMessages trả metadata phản ứng / ghim mà không lộ internal id.
    const listRes = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${convAB}/messages`, {
        headers: createAuthHeaders(origin, 'tok-a'),
      }),
      { params: Promise.resolve({ conversationPublicId: convAB }) },
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain(convInternal.id);
  });
});
