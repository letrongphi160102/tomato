import { inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as acceptConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/accept/route';
import { POST as messagesPost } from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { GET as conversationsListGet } from '@/app/api/v1/conversations/route';
import { POST as e2eeDevicesPost } from '@/app/api/v1/e2ee/devices/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { authIdentities, users } from '@/core/db/schema';
import type { EmailMessage, EmailProvider } from '@/core/email';
import {
  InMemoryRealtimeAdapter,
  buildUserRealtimeChannel,
  resetRealtimeProviderForTesting,
  setRealtimeProviderForTesting,
} from '@/core/realtime';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import {
  clearE2eeClientBootstrapState,
  clearMemoryKeystoreForTesting,
  encryptDirectMessage,
  getOrCreatePrimaryDeviceKeyMaterial,
  type E2eeDeviceKeyPairMaterial,
} from '@/lib/e2ee';
import {
  AuthRepository,
  AuthService,
  SessionService,
  getSessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
} from '@/modules/auth';
import {
  ChatRepository,
  ChatService,
  getChatService,
  resetChatServiceForTesting,
  setChatServiceForTesting,
  type ConversationSummaryDto,
} from '@/modules/chat';
import {
  NotificationRepository,
  NotificationService,
  resetNotificationServiceForTesting,
  setNotificationServiceForTesting,
} from '@/modules/notifications';
import {
  PresenceRepository,
  PresenceService,
  resetPresenceServiceForTesting,
  setPresenceServiceForTesting,
} from '@/modules/presence';
import {
  SocialRepository,
  SocialService,
  getSocialService,
  resetSocialServiceForTesting,
  setSocialServiceForTesting,
} from '@/modules/social';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

let ipCounter = 40;
function nextTestIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 200) + 20}`;
}

function makeUniqueTag(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
}

class SilentEmailProvider implements EmailProvider {
  public readonly provider = 'memory' as const;
  public readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

interface CookieJar {
  at?: string;
  rt?: string;
  csrf?: string;
}

function extractCookies(response: Response, previous: CookieJar = {}): CookieJar {
  const next: CookieJar = { ...previous };
  for (const header of response.headers.getSetCookie()) {
    const first = header.split(';')[0] ?? '';
    const eqIdx = first.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = first.slice(0, eqIdx).trim();
    const value = first.slice(eqIdx + 1).trim();
    const isCleared = /Max-Age=0/i.test(header) || value === '';

    if (name === 'tomato_at' || name === '__Host-tomato_at') {
      next.at = isCleared ? undefined : value;
    } else if (name === 'tomato_rt' || name === '__Host-tomato_rt') {
      next.rt = isCleared ? undefined : value;
    } else if (name === 'tomato_csrf' || name === '__Host-tomato_csrf') {
      next.csrf = isCleared ? undefined : value;
    }
  }
  return next;
}

function createHeaders(
  jar: CookieJar,
  ip: string,
  options: { includeCsrf?: boolean; json?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    origin: getTestOrigin(),
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': ip,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
  };
  const cookieParts: string[] = [];
  if (jar.at) cookieParts.push(`tomato_at=${jar.at}`);
  if (jar.rt) cookieParts.push(`tomato_rt=${jar.rt}`);
  if (jar.csrf) cookieParts.push(`tomato_csrf=${jar.csrf}`);
  if (cookieParts.length > 0) {
    headers.cookie = cookieParts.join('; ');
  }
  if (options.includeCsrf && jar.csrf) {
    headers[CSRF_HEADER_NAME] = jar.csrf;
  }
  if (options.json) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

interface SeededUser {
  readonly id: string;
  readonly publicId: string;
  readonly handle: string;
  readonly ip: string;
  jar: CookieJar;
}

const createdUserIds: string[] = [];
const SYNTHETIC_TEST_SECRET = ['AuditBatch', 'Pass', '2026!99'].join('_');

async function seedAndLoginUser(
  prefix: string,
  fullName: string,
  options: { readonly isPrivate?: boolean } = {},
): Promise<SeededUser> {
  const db = getDb();
  const tag = makeUniqueTag(prefix);
  const id = generateUuidV7();
  const publicId = generatePublicId();
  const email = `${tag}@tomato.test`;
  const handle = tag.toLowerCase();
  const now = new Date();
  const hashed = await hashPassword(SYNTHETIC_TEST_SECRET);

  await db.insert(users).values({
    id,
    publicId,
    username: handle,
    handle,
    handleNormalized: handle,
    fullName,
    bio: '',
    isPrivate: options.isPrivate ?? false,
    showActiveStatus: true,
    showReadReceipts: true,
    gender: 'other',
    dateOfBirth: '1998-08-20',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(authIdentities).values({
    id: generateUuidV7(),
    userId: id,
    provider: 'email_password',
    identifierNormalized: email.toLowerCase(),
    passwordHash: hashed.hash,
    pepperVersion: hashed.pepperVersion,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  createdUserIds.push(id);

  const ip = nextTestIp();
  const loginRes = await loginPost(
    new Request(`${getTestOrigin()}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        origin: getTestOrigin(),
        'sec-fetch-site': 'same-origin',
        'x-forwarded-for': ip,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password: SYNTHETIC_TEST_SECRET }),
    }),
  );
  expect(loginRes.status).toBe(200);
  const jar = extractCookies(loginRes);
  return { id, publicId, handle, ip, jar };
}

async function registerUserE2eeDevice(user: SeededUser): Promise<E2eeDeviceKeyPairMaterial> {
  const mat = await getOrCreatePrimaryDeviceKeyMaterial(user.publicId);
  const res = await e2eeDevicesPost(
    new Request(`${getTestOrigin()}/api/v1/e2ee/devices`, {
      method: 'POST',
      headers: createHeaders(user.jar, user.ip, { includeCsrf: true, json: true }),
      body: JSON.stringify({
        identityPublicKeyJwk: mat.identityPublicKeyJwk,
        signingPublicKeyJwk: mat.signingPublicKeyJwk,
        keyFingerprint: mat.keyFingerprint,
      }),
    }),
  );
  expect(res.status).toBe(200);
  return mat;
}

async function sendEncryptedText(params: {
  readonly sender: SeededUser;
  readonly senderMat: E2eeDeviceKeyPairMaterial;
  readonly recipientMat: E2eeDeviceKeyPairMaterial;
  readonly conversationPublicId: string;
  readonly clientMsgId: string;
  readonly plaintext: string;
}): Promise<{ readonly public_id: string; readonly seq: number }> {
  const envelope = await encryptDirectMessage({
    conversationPublicId: params.conversationPublicId,
    senderPublicId: params.sender.publicId,
    clientMsgId: params.clientMsgId,
    plaintext: params.plaintext,
    senderDevice: params.senderMat,
    recipientDevices: [
      {
        devicePublicId: params.recipientMat.devicePublicId,
        keyFingerprint: params.recipientMat.keyFingerprint,
        identityPublicKeyJwk: params.recipientMat.identityPublicKeyJwk,
        signingPublicKeyJwk: params.recipientMat.signingPublicKeyJwk,
      },
    ],
  });

  const res = await messagesPost(
    new Request(`${getTestOrigin()}/api/v1/conversations/${params.conversationPublicId}/messages`, {
      method: 'POST',
      headers: createHeaders(params.sender.jar, params.sender.ip, {
        includeCsrf: true,
        json: true,
      }),
      body: JSON.stringify({
        clientMsgId: params.clientMsgId,
        messageType: 'text',
        ciphertext: envelope.ciphertext,
        cryptoHeader: envelope.cryptoHeader,
      }),
    }),
    { params: Promise.resolve({ conversationPublicId: params.conversationPublicId }) },
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    readonly message: { readonly public_id: string; readonly seq: number };
  };
  return body.message;
}

describe('Integration Audit: P0-4 Batched DISTINCT ON Conversation Previews & P1-7 Multi-Recipient Unread Counts', () => {
  let realtimeAdapter: InMemoryRealtimeAdapter;

  beforeEach(() => {
    clearE2eeClientBootstrapState();
    clearMemoryKeystoreForTesting();
    const redis = getRedisClient();
    const keyPrefix = `tomato:test:audit:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    const rateLimiter = new RateLimiter(redis, { keyPrefix });
    const auditLogService = new AuditLogService();
    const authRepo = new AuthRepository();
    const sessionService = new SessionService({ repository: authRepo, rateLimiter });
    const authService = new AuthService({
      repository: authRepo,
      sessionService,
      rateLimiter,
      loginProtection: new LoginBruteForceGuard(redis, { keyPrefix: `${keyPrefix}:bf` }),
      emailProvider: new SilentEmailProvider(),
      captchaProvider: {
        provider: 'turnstile',
        verify: async () => ({ success: true, errorCodes: [] }),
      },
      auditLogService,
      minLoginFailureResponseMs: 0,
      minResendResponseMs: 0,
    });

    realtimeAdapter = new InMemoryRealtimeAdapter({ isolated: true });
    const notificationService = new NotificationService({
      repository: new NotificationRepository(),
      rateLimiter,
      realtimeProvider: realtimeAdapter,
    });
    const presenceService = new PresenceService({
      repository: new PresenceRepository(),
      redis,
      rateLimiter,
    });
    const socialService = new SocialService({
      repository: new SocialRepository(),
      rateLimiter,
      auditLogService,
      notificationService,
      presenceService,
    });
    const chatService = new ChatService({
      repository: new ChatRepository(),
      rateLimiter,
      realtimeProvider: realtimeAdapter,
      notificationService,
    });

    setRealtimeProviderForTesting(realtimeAdapter);
    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);
    setNotificationServiceForTesting(notificationService);
    setPresenceServiceForTesting(presenceService);
    setSocialServiceForTesting(socialService);
    setChatServiceForTesting(chatService);
  });

  afterAll(async () => {
    resetChatServiceForTesting();
    resetSocialServiceForTesting();
    resetPresenceServiceForTesting();
    resetNotificationServiceForTesting();
    resetAuthServiceForTesting();
    resetSessionServiceForTesting();
    resetRealtimeProviderForTesting();

    if (createdUserIds.length > 0) {
      const db = getDb();
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }

    await closeRedisClient();
    await closeDatabasePool();
  });

  it('[P0-4] listConversationsForUser DISTINCT ON lọc đúng cả NOT EXISTS message_user_deletions VÀ m.seq > cp.cleared_before_seq trên nhiều hội thoại', async () => {
    const origin = getTestOrigin();
    const alice = await seedAndLoginUser('p04_alice', 'Nguyễn Alice');
    const bob = await seedAndLoginUser('p04_bob', 'Trần Bob');
    const carol = await seedAndLoginUser('p04_carol', 'Lê Carol');

    const aliceMat = await registerUserE2eeDevice(alice);
    const bobMat = await registerUserE2eeDevice(bob);
    const carolMat = await registerUserE2eeDevice(carol);

    // Tạo 2 hội thoại (Alice <-> Bob và Alice <-> Carol) và chấp nhận cả hai vào hộp thư Chính.
    const createPrimaryConv = async (peer: SeededUser): Promise<string> => {
      const createRes = await directConversationPost(
        new Request(`${origin}/api/v1/conversations/direct`, {
          method: 'POST',
          headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
          body: JSON.stringify({ recipientPublicId: peer.publicId }),
        }),
      );
      expect([200, 201]).toContain(createRes.status);
      const body = (await createRes.json()) as { conversation: { public_id: string } };
      return body.conversation.public_id;
    };

    const convBobId = await createPrimaryConv(bob);
    const convCarolId = await createPrimaryConv(carol);

    // Gửi tin đầu tiên để Bob & Carol bấm Chấp nhận hội thoại vào Primary.
    const msgBob1 = await sendEncryptedText({
      sender: alice,
      senderMat: aliceMat,
      recipientMat: bobMat,
      conversationPublicId: convBobId,
      clientMsgId: 'bob_msg_1',
      plaintext: 'Bob tin 1',
    });
    const msgCarol1 = await sendEncryptedText({
      sender: alice,
      senderMat: aliceMat,
      recipientMat: carolMat,
      conversationPublicId: convCarolId,
      clientMsgId: 'carol_msg_1',
      plaintext: 'Carol tin 1',
    });

    const acceptBob = await acceptConversationPost(
      new Request(`${origin}/api/v1/conversations/${convBobId}/accept`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convBobId }) },
    );
    expect(acceptBob.status).toBe(200);

    const acceptCarol = await acceptConversationPost(
      new Request(`${origin}/api/v1/conversations/${convCarolId}/accept`, {
        method: 'POST',
        headers: createHeaders(carol.jar, carol.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convCarolId }) },
    );
    expect(acceptCarol.status).toBe(200);

    const msgBob2 = await sendEncryptedText({
      sender: bob,
      senderMat: bobMat,
      recipientMat: aliceMat,
      conversationPublicId: convBobId,
      clientMsgId: 'bob_msg_2',
      plaintext: 'Bob tin 2',
    });
    const msgBob3 = await sendEncryptedText({
      sender: bob,
      senderMat: bobMat,
      recipientMat: aliceMat,
      conversationPublicId: convBobId,
      clientMsgId: 'bob_msg_3',
      plaintext: 'Bob tin 3',
    });
    const msgCarol2 = await sendEncryptedText({
      sender: carol,
      senderMat: carolMat,
      recipientMat: aliceMat,
      conversationPublicId: convCarolId,
      clientMsgId: 'carol_msg_2',
      plaintext: 'Carol tin 2',
    });

    expect(msgBob1.seq).toBe(1);
    expect(msgBob2.seq).toBe(2);
    expect(msgBob3.seq).toBe(3);
    expect(msgCarol1.seq).toBe(1);
    expect(msgCarol2.seq).toBe(2);

    const alicePrincipal = await getSessionService().authenticateAccessToken(alice.jar.at ?? null);

    // Kịch bản A (`NOT EXISTS message_user_deletions`):
    // Alice xóa `msgBob3` (seq = 3) ở phía mình -> preview hội thoại Bob của Alice phải lùi về `seq = 2`,
    // hội thoại Carol giữ nguyên `seq = 2`, và phía Bob vẫn thấy nguyên `seq = 3`.
    await getChatService().deleteMessageForMe(alicePrincipal, msgBob3.public_id);

    const fetchPrimaryMap = async (
      viewer: SeededUser,
    ): Promise<Map<string, ConversationSummaryDto>> => {
      const res = await conversationsListGet(
        new Request(`${origin}/api/v1/conversations?tab=primary`, {
          method: 'GET',
          headers: createHeaders(viewer.jar, viewer.ip),
        }),
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { readonly items: readonly ConversationSummaryDto[] };
      return new Map(data.items.map((item) => [item.public_id, item]));
    };

    const aliceMapAfterDeleteMsg3 = await fetchPrimaryMap(alice);
    expect(aliceMapAfterDeleteMsg3.get(convBobId)?.lastMessage?.seq).toBe(2);
    expect(aliceMapAfterDeleteMsg3.get(convCarolId)?.lastMessage?.seq).toBe(2);

    const bobMapAfterAliceDelete = await fetchPrimaryMap(bob);
    expect(bobMapAfterAliceDelete.get(convBobId)?.lastMessage?.seq).toBe(3);

    // Kịch bản B (`m.seq > cp.cleared_before_seq` kết hợp `NOT EXISTS message_user_deletions`):
    // 1. Alice xóa toàn bộ đoạn chat với Bob (`cleared_before_seq = 3`).
    // 2. Bob gửi tin nhắn mới `seq = 4` làm đoạn chat xuất hiện lại trong hộp thư Chính của Alice với `lastMessage.seq === 4`.
    // 3. Alice tiếp tục xóa `seq = 4` ở phía mình (`deleteMessageForMe`) -> `lastMessage` BẮT BUỘC là `null`
    //    (tuyệt đối KHÔNG được làm sống lại `seq = 2` hay `seq = 1` trước mốc `cleared_before_seq = 3`!).
    await getChatService().deleteConversationForMe(alicePrincipal, convBobId);

    const aliceMapAfterClear = await fetchPrimaryMap(alice);
    expect(aliceMapAfterClear.has(convBobId)).toBe(false);

    const msgBob4 = await sendEncryptedText({
      sender: bob,
      senderMat: bobMat,
      recipientMat: aliceMat,
      conversationPublicId: convBobId,
      clientMsgId: 'bob_msg_4',
      plaintext: 'Bob tin 4 sau khi xóa đoạn chat',
    });
    expect(msgBob4.seq).toBe(4);

    const aliceMapAfterResurface = await fetchPrimaryMap(alice);
    expect(aliceMapAfterResurface.get(convBobId)?.lastMessage?.seq).toBe(4);

    await getChatService().deleteMessageForMe(alicePrincipal, msgBob4.public_id);

    const aliceMapAfterDeleteMsg4 = await fetchPrimaryMap(alice);
    const bobConvSummaryForAlice = aliceMapAfterDeleteMsg4.get(convBobId);
    expect(bobConvSummaryForAlice).toBeDefined();
    expect(bobConvSummaryForAlice?.myState.clearedBeforeSeq).toBe(3);
    expect(bobConvSummaryForAlice?.lastMessage).toBeNull();
    // Hội thoại Carol kế bên vẫn giữ nguyên preview `seq = 2` trong cùng truy vấn batch DISTINCT ON.
    expect(aliceMapAfterDeleteMsg4.get(convCarolId)?.lastMessage?.seq).toBe(2);
  });

  it('[P1-7] updateOwnPrivacySettings (Riêng tư -> Công khai) đếm chính xác unreadCount riêng cho từng người nhận qua GROUP BY recipient_id ngoài khóa FOR UPDATE', async () => {
    const [privateHost, requester1, requester2, extraFollower] = await Promise.all([
      seedAndLoginUser('p17_host', 'Phạm Host Riêng Tư', { isPrivate: true }),
      seedAndLoginUser('p17_req1', 'Võ Requester 1'),
      seedAndLoginUser('p17_req2', 'Đặng Requester 2'),
      seedAndLoginUser('p17_extra', 'Hoàng Extra'),
    ]);

    const [hostPrincipal, req1Principal, req2Principal, extraPrincipal] = await Promise.all([
      getSessionService().authenticateAccessToken(privateHost.jar.at ?? null),
      getSessionService().authenticateAccessToken(requester1.jar.at ?? null),
      getSessionService().authenticateAccessToken(requester2.jar.at ?? null),
      getSessionService().authenticateAccessToken(extraFollower.jar.at ?? null),
    ]);

    const clientCtx = {
      ipAddress: '198.51.100.200',
      rateLimitIpKey: '198.51.100.200',
      userAgent: 'Vitest-Integration',
    };

    // Tạo sẵn 1 thông báo chưa đọc (`new_follower`) cho `requester1` từ `extraFollower`,
    // trong khi `requester2` có 0 thông báo chưa đọc ban đầu -> kiểm chứng GROUP BY trả số đếm độc lập cho từng người!
    await getSocialService().followUser(extraPrincipal, requester1.publicId);

    // Cả `requester1` và `requester2` gửi yêu cầu theo dõi `privateHost`.
    const r1Follow = await getSocialService().followUser(req1Principal, privateHost.publicId);
    const r2Follow = await getSocialService().followUser(req2Principal, privateHost.publicId);
    expect(r1Follow.followStatus).toBe('requested');
    expect(r2Follow.followStatus).toBe('requested');

    realtimeAdapter.clearPublishedEvents();

    // `privateHost` chuyển từ Riêng tư -> Công khai (`acceptPendingRequests: true`).
    const privacyRes = await getSocialService().updateOwnPrivacySettings(
      hostPrincipal,
      { isPrivate: false, acceptPendingRequests: true },
      clientCtx,
    );
    expect(privacyRes.privacy.isPrivate).toBe(false);
    expect(privacyRes.acceptedRequestsCount).toBe(2);

    const published = realtimeAdapter.getPublishedEvents();
    const req1Channel = buildUserRealtimeChannel(requester1.publicId);
    const req2Channel = buildUserRealtimeChannel(requester2.publicId);

    const req1AcceptedEvents = published.filter(
      (m) => m.channel === req1Channel && m.event === 'notification.created',
    );
    const req2AcceptedEvents = published.filter(
      (m) => m.channel === req2Channel && m.event === 'notification.created',
    );

    expect(req1AcceptedEvents).toHaveLength(1);
    expect(req2AcceptedEvents).toHaveLength(1);

    // `requester1` vốn có 1 thông báo chưa đọc trước đó -> lên `2`; `requester2` có 0 trước đó -> lên `1`.
    expect((req1AcceptedEvents[0]?.data as { readonly unreadCount?: number }).unreadCount).toBe(2);
    expect((req2AcceptedEvents[0]?.data as { readonly unreadCount?: number }).unreadCount).toBe(1);
  });
});
