import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import type { ErrorEvent } from '@sentry/nextjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const blobSdkMocks = vi.hoisted(() => ({
  put: vi.fn(),
  head: vi.fn(),
  del: vi.fn(),
  generateClientTokenFromReadWriteToken: vi.fn(),
}));

vi.mock('@vercel/blob', async () => {
  const actual = await vi.importActual<typeof import('@vercel/blob')>('@vercel/blob');
  return {
    ...actual,
    put: blobSdkMocks.put,
    head: blobSdkMocks.head,
    del: blobSdkMocks.del,
  };
});

vi.mock('@vercel/blob/client', async () => {
  const actual = await vi.importActual<typeof import('@vercel/blob/client')>('@vercel/blob/client');
  return {
    ...actual,
    generateClientTokenFromReadWriteToken: blobSdkMocks.generateClientTokenFromReadWriteToken,
  };
});

import { POST as uploadTokenPost } from '@/app/api/v1/conversations/[conversationPublicId]/attachments/upload-token/route';
import { POST as messagesPost } from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { PUT as localChatMediaPut } from '@/app/api/v1/media/local/chat/[attachmentPublicId]/route';
import { GET as messageAttachmentGet } from '@/app/api/v1/messages/[messagePublicId]/attachment/route';
import { POST as messageRecallPost } from '@/app/api/v1/messages/[messagePublicId]/recall/route';
import { PATCH as messageEditPatch } from '@/app/api/v1/messages/[messagePublicId]/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import type { DatabaseTransaction } from '@/core/db';
import type {
  AttachmentMediaKind,
  ConversationInboxState,
  ConversationParticipantRow,
  ConversationRow,
  MessageAttachmentRow,
  MessageRow,
  SessionRow,
  UserRow,
} from '@/core/db/schema';
import { createLogger } from '@/core/logger';
import { scrubSentryEvent } from '@/core/monitoring/sentry-scrub';
import { InMemoryRealtimeAdapter } from '@/core/realtime';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  InMemoryMediaStorageAdapter,
  VercelBlobStorageAdapter,
  generateChatMediaStorageKey,
} from '@/core/storage';
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
  ChatService,
  MAX_IMAGE_CIPHERTEXT_BYTES,
  MAX_VOICE_CIPHERTEXT_BYTES,
  resetChatServiceForTesting,
  setChatServiceForTesting,
  type ChatRepository,
} from '@/modules/chat';
import type { SocialRelationshipSnapshot } from '@/modules/social/social.policy';

const TEST_CSRF = 'synthetic-csrf-token-for-m11-security-tests';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-24T12:00:00.000Z');
  return {
    id: '0195b100-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'alice_m11',
    handle: 'alice_m11',
    handleNormalized: 'alice_m11',
    fullName: 'Alice M11',
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
    id: '0195b100-0000-7000-8000-000000000090',
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
  accessToken: string,
  options: { includeCsrf?: boolean; contentType?: string } = {},
) {
  const { includeCsrf = true, contentType = 'application/json' } = options;
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: `tomato_at=${accessToken}; tomato_csrf=${TEST_CSRF}`,
    ...(contentType ? { 'Content-Type': contentType } : {}),
    ...(includeCsrf ? { [CSRF_HEADER_NAME]: TEST_CSRF } : {}),
  };
}

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

afterEach(() => {
  resetSessionServiceForTesting();
  resetChatServiceForTesting();
  clearMemoryKeystoreForTesting();
  blobSdkMocks.put.mockReset();
  blobSdkMocks.head.mockReset();
  blobSdkMocks.del.mockReset();
  blobSdkMocks.generateClientTokenFromReadWriteToken.mockReset();
  vi.restoreAllMocks();
});

describe('Security M11: Ảnh HD & Tin nhắn thoại E2EE — BOLA/Pending/CSRF/413/429/VercelBlob/Redaction/Resilient Recall', () => {
  const userA = makeUserRow({
    id: '0195b100-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    handle: 'alice_m11',
    handleNormalized: 'alice_m11',
    fullName: 'Alice M11',
  });
  const userB = makeUserRow({
    id: '0195b100-0000-7000-8000-000000000002',
    publicId: '22222222-2222-4222-8222-222222222222',
    handle: 'bob_m11',
    handleNormalized: 'bob_m11',
    fullName: 'Bob M11',
  });
  const userC = makeUserRow({
    id: '0195b100-0000-7000-8000-000000000003',
    publicId: '33333333-3333-4333-8333-333333333333',
    handle: 'charlie_blocked',
    handleNormalized: 'charlie_blocked',
    fullName: 'Charlie Blocked',
  });
  const userD = makeUserRow({
    id: '0195b100-0000-7000-8000-000000000004',
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

  function createInMemoryM11Env(options?: {
    readonly bobFollowsAlice?: boolean;
    readonly rateLimitBlocked?: boolean;
  }) {
    const now = new Date('2026-11-24T12:00:00.000Z');
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
    const bobFollowsAlice = options?.bobFollowsAlice ?? true;
    const storage = new InMemoryMediaStorageAdapter();

    const rateLimiter = {
      consume: vi.fn(async (key: string) => {
        if (options?.rateLimitBlocked && key.startsWith('chat:attachments:upload:')) {
          return {
            allowed: false,
            limit: 30,
            remaining: 0,
            resetAt: now.getTime() + 60_000,
            retryAfterSeconds: 45,
          };
        }
        return {
          allowed: true,
          limit: 60,
          remaining: 59,
          resetAt: now.getTime() + 60_000,
          retryAfterSeconds: 0,
        };
      }),
    };
    const realtime = new InMemoryRealtimeAdapter({ isolated: true });

    const repo: Partial<ChatRepository> = {
      runInRlsTx: async <T>(_actorId: string, fn: (tx: DatabaseTransaction) => Promise<T>) =>
        fn({} as DatabaseTransaction),
      getDatabaseNow: vi.fn(async () => now),
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
        for (const m of messagesById.values()) {
          if (m.publicId === pid) return m;
        }
        return null;
      }),
      isMessageDeletedForUser: vi.fn(async (mid: string, uid: string) =>
        deletions.has(`${mid}:${uid}`),
      ),
      insertMessageAndIncrementSeq: vi.fn(async (input) => {
        const conv = conversationsById.get(input.conversationId)!;
        const nextConv: ConversationRow = {
          ...conv,
          lastSeq: input.nextSeq,
          lastMessageAt: input.now,
        };
        conversationsById.set(conv.id, nextConv);
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
        if (!existing || existing.senderId !== input.senderId) return null;
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
        for (const a of attachmentsById.values()) {
          if (a.publicId === pid) return a;
        }
        return null;
      }),
      lockAttachmentByPublicId: vi.fn(async (pid: string) => {
        for (const a of attachmentsById.values()) {
          if (a.publicId === pid) return a;
        }
        return null;
      }),
      markAttachmentStorageUrlUploaded: vi.fn(async (params) => {
        const existing = attachmentsById.get(params.attachmentId);
        if (
          !existing ||
          existing.uploaderId !== params.uploaderId ||
          existing.messageId !== null ||
          existing.deletedAt !== null
        ) {
          return null;
        }
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
          existing.messageId !== null ||
          existing.deletedAt !== null
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
            const updated: MessageAttachmentRow = { ...a, deletedAt: now };
            attachmentsById.set(a.id, updated);
            removed.push(updated);
          }
        }
        return removed;
      }),
      claimExpiredPendingAttachmentsForUser: vi.fn(async () => []),
      findLatestVisibleMessageForConversation: vi.fn(async () => null),
    };

    const chatService = new ChatService({
      repository: repo as ChatRepository,
      rateLimiter: rateLimiter as never,
      realtimeProvider: realtime,
      mediaStorageProvider: storage,
      auditLogService: { record: vi.fn(async () => undefined) } as never,
    });
    setChatServiceForTesting(chatService);

    installSessionLookup({
      tokenA: makePrincipal(userA),
      tokenB: makePrincipal(userB),
      tokenC: makePrincipal(userC),
      tokenD: makePrincipal(userD),
    });

    return { storage, rateLimiter, realtime };
  }

  it('VercelBlobStorageAdapter: khóa chặt maximumSizeInBytes=exactSizeBytes và dựng URL uy tín từ storeId cho head()', async () => {
    const storeId = 'storetest123';
    const syntheticRwToken = ['vercel', 'blob', 'rw', storeId, 'syntheticSecretPart'].join('_');
    const storageKey = generateChatMediaStorageKey();
    const expectedUrl = `https://${storeId}.public.blob.vercel-storage.com/${storageKey}`;
    const expiresAt = new Date('2026-11-24T12:10:00.000Z');

    blobSdkMocks.generateClientTokenFromReadWriteToken.mockResolvedValue('synthetic-client-token');
    blobSdkMocks.head.mockResolvedValue({
      url: expectedUrl,
      pathname: storageKey,
      size: 4096,
      contentType: 'application/octet-stream',
    });

    const adapter = new VercelBlobStorageAdapter({ token: syntheticRwToken });
    const grant = await adapter.createEncryptedUploadGrant({
      attachmentPublicId: '11111111-1111-4111-8111-111111111111',
      storageKey,
      exactSizeBytes: 4096,
      expiresAt,
    });

    expect(grant).toEqual({
      uploadMode: 'vercel_blob',
      pathname: storageKey,
      clientToken: 'synthetic-client-token',
      expiresAt: expiresAt.toISOString(),
    });
    expect(blobSdkMocks.generateClientTokenFromReadWriteToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: syntheticRwToken,
        pathname: storageKey,
        allowedContentTypes: ['application/octet-stream'],
        maximumSizeInBytes: 4096,
        validUntil: expiresAt.getTime(),
        addRandomSuffix: false,
        allowOverwrite: false,
      }),
    );

    // verifyUploadedObject phải gọi head() bằng URL uy tín dựng từ storeId, không tin URL do client gửi.
    const verified = await adapter.verifyUploadedObject(storageKey, { expectedSizeBytes: 4096 });
    expect(blobSdkMocks.head).toHaveBeenCalledWith(expectedUrl, { token: syntheticRwToken });
    expect(verified).toEqual({
      exists: true,
      url: expectedUrl,
      byteLength: 4096,
      contentType: 'application/octet-stream',
    });

    // Nếu kích thước lệch -> từ chối trả null.
    const mismatch = await adapter.verifyUploadedObject(storageKey, { expectedSizeBytes: 9999 });
    expect(mismatch).toBeNull();
  });

  it('BOLA 404 (Outsider D + Blocked C), CSRF 403, .strict() 400, 413 quá dung lượng, 409 cấm sửa ảnh/thoại & Resilient Recall 200 khi lỗi mạng Storage', async () => {
    const origin = getTestOrigin();
    const { storage } = createInMemoryM11Env({ bobFollowsAlice: true });

    // 1. Tạo hội thoại A-B (primary).
    const convRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    expect(convRes.status).toBe(201);
    const convId = ((await convRes.json()) as { conversation: { public_id: string } }).conversation
      .public_id;

    // 2. CSRF thiếu -> 403 trên upload-token.
    const noCsrfRes = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${convId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA', { includeCsrf: false }),
        body: JSON.stringify({
          mediaKind: 'image',
          ciphertextSizeBytes: 128,
          ciphertextSha256: 'a'.repeat(64),
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(noCsrfRes.status).toBe(403);

    // 3. Outsider D và Blocked C xin upload-token -> 404 chống BOLA.
    for (const token of ['tokenD', 'tokenC'] as const) {
      const res = await uploadTokenPost(
        new Request(`${origin}/api/v1/conversations/${convId}/attachments/upload-token`, {
          method: 'POST',
          headers: createAuthHeaders(origin, token),
          body: JSON.stringify({
            mediaKind: 'image',
            ciphertextSizeBytes: 128,
            ciphertextSha256: 'a'.repeat(64),
          }),
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      );
      expect(res.status).toBe(404);
    }

    // 4. Vượt dung lượng ảnh (>10MB) / thoại (>5MB) -> 413 PAYLOAD_TOO_LARGE; field thừa (.strict) -> 400.
    const tooLargeImg = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${convId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          mediaKind: 'image',
          ciphertextSizeBytes: MAX_IMAGE_CIPHERTEXT_BYTES + 1,
          ciphertextSha256: 'a'.repeat(64),
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(tooLargeImg.status).toBe(413);

    const tooLargeVoice = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${convId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          mediaKind: 'voice',
          ciphertextSizeBytes: MAX_VOICE_CIPHERTEXT_BYTES + 1,
          ciphertextSha256: 'b'.repeat(64),
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(tooLargeVoice.status).toBe(413);

    const extraFieldRes = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${convId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          mediaKind: 'image',
          ciphertextSizeBytes: 128,
          ciphertextSha256: 'a'.repeat(64),
          unexpectedField: true,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(extraFieldRes.status).toBe(400);

    // 5. Alice upload ảnh hợp lệ & gửi tin nhắn ảnh E2EE.
    const aliceMat = await getOrCreatePrimaryDeviceKeyMaterial(userA.publicId);
    const bobMat = await getOrCreatePrimaryDeviceKeyMaterial(userB.publicId);
    const clientMsgId = 'sec_img_001';
    const encBin = await encryptMediaBinary({
      plainBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]),
      conversationPublicId: convId,
      senderPublicId: userA.publicId,
      clientMsgId,
      mediaKind: 'image',
    });

    const tokenRes = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${convId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          mediaKind: 'image',
          ciphertextSizeBytes: encBin.ciphertextSizeBytes,
          ciphertextSha256: encBin.ciphertextSha256,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(tokenRes.status).toBe(201);
    const grant = (await tokenRes.json()) as {
      attachmentPublicId: string;
      uploadUrl: string;
    };

    // Outsider D không thể PUT vào attachment của Alice -> 404.
    const dPutRes = await localChatMediaPut(
      new Request(`${origin}${grant.uploadUrl}`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tokenD', { contentType: 'application/octet-stream' }),
        body: new Blob([encBin.ciphertextBytes], { type: 'application/octet-stream' }),
      }),
      { params: Promise.resolve({ attachmentPublicId: grant.attachmentPublicId }) },
    );
    expect(dPutRes.status).toBe(404);

    // Alice PUT hợp lệ.
    const aPutRes = await localChatMediaPut(
      new Request(`${origin}${grant.uploadUrl}`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tokenA', { contentType: 'application/octet-stream' }),
        body: new Blob([encBin.ciphertextBytes], { type: 'application/octet-stream' }),
      }),
      { params: Promise.resolve({ attachmentPublicId: grant.attachmentPublicId }) },
    );
    expect(aPutRes.status).toBe(200);

    const envelope = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: userA.publicId,
      clientMsgId,
      plaintext: '',
      media: {
        kind: 'image',
        attachmentPublicId: grant.attachmentPublicId,
        fileKey: encBin.fileKey,
        fileIv: encBin.fileIv,
        ciphertextSha256: encBin.ciphertextSha256,
        mimeType: 'image/png',
        sizeBytes: 12,
        width: 100,
        height: 100,
      },
      senderDevice: aliceMat,
      recipientDevices: [
        {
          devicePublicId: bobMat.devicePublicId,
          keyFingerprint: bobMat.keyFingerprint,
          identityPublicKeyJwk: bobMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bobMat.signingPublicKeyJwk,
        },
      ],
    });

    // Không cho gắn attachmentPublicId vào tin nhắn loại `text` -> 400.
    const badTextWithAttachment = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          clientMsgId: 'bad_text_attach',
          messageType: 'text',
          attachmentPublicId: grant.attachmentPublicId,
          ciphertext: envelope.ciphertext,
          cryptoHeader: envelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(badTextWithAttachment.status).toBe(400);

    // Không cho gửi tin nhắn `image` ở hội thoại `primary` mà thiếu `attachmentPublicId` -> 400.
    const missingAttachImg = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          clientMsgId: 'missing_attach_img',
          messageType: 'image',
          ciphertext: envelope.ciphertext,
          cryptoHeader: envelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(missingAttachImg.status).toBe(400);

    const sendRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          clientMsgId,
          messageType: 'image',
          attachmentPublicId: grant.attachmentPublicId,
          ciphertext: envelope.ciphertext,
          cryptoHeader: envelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(sendRes.status).toBe(201);
    const msgId = ((await sendRes.json()) as { message: { public_id: string } }).message.public_id;

    // 6. Outsider D tải đính kèm -> 404; Bob tải `?download=1` -> 200 với header bảo mật sandbox + nosniff + no-store.
    const dDownloadRes = await messageAttachmentGet(
      new Request(`${origin}/api/v1/messages/${msgId}/attachment?download=1`, {
        headers: createAuthHeaders(origin, 'tokenD', { includeCsrf: false, contentType: '' }),
      }),
      { params: Promise.resolve({ messagePublicId: msgId }) },
    );
    expect(dDownloadRes.status).toBe(404);

    const bDownloadRes = await messageAttachmentGet(
      new Request(`${origin}/api/v1/messages/${msgId}/attachment?download=1`, {
        headers: createAuthHeaders(origin, 'tokenB', { includeCsrf: false, contentType: '' }),
      }),
      { params: Promise.resolve({ messagePublicId: msgId }) },
    );
    expect(bDownloadRes.status).toBe(200);
    expect(bDownloadRes.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(bDownloadRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(bDownloadRes.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(bDownloadRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const downloadedBuf = new Uint8Array(await bDownloadRes.arrayBuffer());
    expect(sha256Hex(downloadedBuf)).toBe(encBin.ciphertextSha256);

    // 7. Cấm chỉnh sửa (`PATCH`) trên tin nhắn ảnh -> 409 CHAT_MESSAGE_EDIT_UNSUPPORTED_TYPE.
    const editImgRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msgId}`, {
        method: 'PATCH',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          ciphertext: envelope.ciphertext,
          cryptoHeader: envelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msgId }) },
    );
    expect(editImgRes.status).toBe(409);

    // 8. Resilient Recall: ngay cả khi Storage ném lỗi mạng tạm thời, thu hồi vẫn trả 200 OK & xóa sạch DB!
    storage.failDeleteOnceWithError = new Error('Simulated transient Vercel Blob network outage');
    const recallRes = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${msgId}/recall`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: msgId }) },
    );
    expect(recallRes.status).toBe(200);

    // Sau thu hồi: Bob không thể tải ảnh nữa -> 404.
    const afterRecallGet = await messageAttachmentGet(
      new Request(`${origin}/api/v1/messages/${msgId}/attachment`, {
        headers: createAuthHeaders(origin, 'tokenB', { includeCsrf: false, contentType: '' }),
      }),
      { params: Promise.resolve({ messagePublicId: msgId }) },
    );
    expect(afterRecallGet.status).toBe(404);
  });

  it('chặn gửi ảnh/thoại ở hộp thư Pending (`403 CHAT_PENDING_TEXT_ONLY`) và trả `429 + Retry-After` khi vượt Rate Limit', async () => {
    const origin = getTestOrigin();
    createInMemoryM11Env({ bobFollowsAlice: false });

    const convRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    expect(convRes.status).toBe(201);
    const convId = ((await convRes.json()) as { conversation: { public_id: string } }).conversation
      .public_id;

    // Đang chờ Bob chấp nhận (`pending`) -> cấm xin upload-token với mã 403 CHAT_PENDING_TEXT_ONLY.
    const pendingUploadRes = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${convId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          mediaKind: 'voice',
          ciphertextSizeBytes: 512,
          ciphertextSha256: 'c'.repeat(64),
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(pendingUploadRes.status).toBe(403);
    const pendingBody = (await pendingUploadRes.json()) as { error: { code: string } };
    expect(pendingBody.error.code).toBe('CHAT_PENDING_TEXT_ONLY');

    // Rate limit vượt ngưỡng -> 429 + Retry-After.
    createInMemoryM11Env({ bobFollowsAlice: true, rateLimitBlocked: true });
    const rlConvRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({ recipientPublicId: userB.publicId }),
      }),
    );
    expect(rlConvRes.status).toBe(201);
    const rlConvId = ((await rlConvRes.json()) as { conversation: { public_id: string } })
      .conversation.public_id;

    const rlRes = await uploadTokenPost(
      new Request(`${origin}/api/v1/conversations/${rlConvId}/attachments/upload-token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tokenA'),
        body: JSON.stringify({
          mediaKind: 'image',
          ciphertextSizeBytes: 512,
          ciphertextSha256: 'd'.repeat(64),
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: rlConvId }) },
    );
    expect(rlRes.status).toBe(429);
    expect(rlRes.headers.get('Retry-After')).toBe('45');
  });

  it('Pino logger và Sentry scrubber che sạch tuyệt đối fileKey, fileIv, clientToken và thumbnailDataUrl', () => {
    const chunks: string[] = [];
    const memoryStream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    const testLogger = createLogger({
      level: 'debug',
      pretty: false,
      destination: memoryStream,
    });

    const secrets = [
      'synthetic-aes256-file-key-base64url-value',
      'synthetic-gcm-file-iv-96bit',
      'synthetic-vercel-blob-client-token-value',
      'data:image/webp;base64,SyntheticThumbSecretPayload123',
    ];

    testLogger.info(
      {
        fileKey: secrets[0],
        fileIv: secrets[1],
        clientToken: secrets[2],
        thumbnailDataUrl: secrets[3],
        nested: {
          file_key: secrets[0],
          file_iv: secrets[1],
          client_token: secrets[2],
          thumbnail_data_url: secrets[3],
        },
      },
      'M11 media redaction test',
    );

    const logOutput = chunks.join('');
    for (const s of secrets) {
      expect(logOutput).not.toContain(s);
    }

    const scrubbedEvent = scrubSentryEvent({
      type: undefined,
      message: 'Media upload diagnostic',
      extra: {
        fileKey: secrets[0],
        fileIv: secrets[1],
        clientToken: secrets[2],
        thumbnailDataUrl: secrets[3],
      },
    } as ErrorEvent);
    const serializedSentry = JSON.stringify(scrubbedEvent);
    for (const s of secrets) {
      expect(serializedSentry).not.toContain(s);
    }
  });
});
