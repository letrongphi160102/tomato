import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { DELETE as conversationDelete } from '@/app/api/v1/conversations/[conversationPublicId]/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { POST as pinResetConfirmPost } from '@/app/api/v1/e2ee/backup/reset/confirm/route';
import { POST as pinResetRequestPost } from '@/app/api/v1/e2ee/backup/reset/request/route';
import { GET as e2eeBackupGet, PUT as e2eeBackupPut } from '@/app/api/v1/e2ee/backup/route';
import { POST as e2eeDevicesPost } from '@/app/api/v1/e2ee/devices/route';
import { GET as e2eeUserKeysGet } from '@/app/api/v1/e2ee/users/[userPublicId]/keys/route';
import { DELETE as messageDeleteForMe } from '@/app/api/v1/messages/[messagePublicId]/for-me/route';
import { PATCH as messageEditPatch } from '@/app/api/v1/messages/[messagePublicId]/route';
import { POST as blockUserPost } from '@/app/api/v1/social/blocks/[userPublicId]/route';
import { POST as followPost } from '@/app/api/v1/social/follow/[userPublicId]/route';
import { GET as userProfileByHandleGet } from '@/app/api/v1/users/[handle]/route';
import { resolvePinSyncState } from '@/components/messages/chat-store-context';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb, withRlsContext } from '@/core/db';
import { auditLogs, authIdentities, userE2eeDevices, users } from '@/core/db/schema';
import type { EmailMessage, EmailProvider } from '@/core/email';
import {
  InMemoryRealtimeAdapter,
  resetRealtimeProviderForTesting,
  setRealtimeProviderForTesting,
} from '@/core/realtime';
import {
  CHAT_RATE_LIMITS,
  LoginBruteForceGuard,
  RateLimiter,
  RedisPinResetOtpStore,
  closeRedisClient,
  getRedisClient,
} from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import {
  clearMemoryKeystoreForTesting,
  createPinProtectedKeyBackup,
  decryptDirectMessage,
  encryptDirectMessage,
  getOrCreatePrimaryDeviceKeyMaterial,
  listLocalDeviceKeyMaterials,
  reEncryptEditedDirectMessage,
  reEncryptPinProtectedKeyBackup,
  restorePinProtectedKeyBackup,
  saveDeviceKeyMaterial,
} from '@/lib/e2ee';
import {
  AuthRepository,
  AuthService,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
} from '@/modules/auth';
import {
  ChatRepository,
  ChatService,
  resetChatServiceForTesting,
  setChatServiceForTesting,
  type ChatMessageDto,
  type E2eeKeyBackupDto,
  type UserE2eeKeyBundleDto,
} from '@/modules/chat';
import {
  NotificationRepository,
  NotificationService,
  resetNotificationServiceForTesting,
  setNotificationServiceForTesting,
} from '@/modules/notifications';
import {
  ProfileRepository,
  ProfileService,
  resetProfileServiceForTesting,
  setProfileServiceForTesting,
} from '@/modules/profile';
import {
  SocialRepository,
  SocialService,
  resetSocialServiceForTesting,
  setSocialServiceForTesting,
} from '@/modules/social';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

let ipCounter = 210;
function nextTestIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 200) + 20}`;
}

function makeUniqueTag(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
}

class CapturingEmailProvider implements EmailProvider {
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

function extractOtp(email: EmailMessage): string {
  const match = email.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) {
    throw new Error('Không tìm thấy mã OTP 6 chữ số trong email');
  }
  return match[1];
}

interface SeededUser {
  readonly id: string;
  readonly publicId: string;
  readonly handle: string;
  readonly email: string;
  readonly ip: string;
  jar: CookieJar;
}

const createdUserIds: string[] = [];
const TEST_PASSWORD = 'TomatoPhase2_PinInt_Password!88';

async function seedAndLoginUser(prefix: string, fullName: string): Promise<SeededUser> {
  const db = getDb();
  const tag = makeUniqueTag(prefix);
  const id = generateUuidV7();
  const publicId = generatePublicId();
  const email = `${tag}@tomato.test`;
  const handle = tag.toLowerCase();
  const now = new Date();
  const hashed = await hashPassword(TEST_PASSWORD);

  await db.insert(users).values({
    id,
    publicId,
    username: handle,
    handle,
    handleNormalized: handle,
    fullName,
    bio: `Tiểu sử ${fullName}`,
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    gender: 'other',
    dateOfBirth: '1999-06-15',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(authIdentities).values({
    id: generateUuidV7(),
    userId: id,
    provider: 'email_password',
    identifierNormalized: email,
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
      headers: createHeaders({}, ip, { json: true }),
      body: JSON.stringify({ email, password: TEST_PASSWORD }),
    }),
  );
  expect(loginRes.status).toBe(200);

  return {
    id,
    publicId,
    handle,
    email,
    ip,
    jar: extractCookies(loginRes),
  };
}

let emailProvider: CapturingEmailProvider;
let realtimeAdapter: InMemoryRealtimeAdapter;
let rateLimiter: RateLimiter;

beforeEach(() => {
  const redis = getRedisClient();
  rateLimiter = new RateLimiter(redis, { keyPrefix: `tomato:int:pin:${Date.now()}` });
  const otpStore = new RedisPinResetOtpStore(redis, {
    keyPrefix: `tomato:int:pinotp:${Date.now()}`,
  });
  const loginProtection = new LoginBruteForceGuard(redis, {
    keyPrefix: `tomato:int:bf:${Date.now()}`,
  });
  emailProvider = new CapturingEmailProvider();
  realtimeAdapter = new InMemoryRealtimeAdapter();
  const auditLogService = new AuditLogService();
  const authRepo = new AuthRepository();
  const sessionService = new SessionService({ repository: authRepo, rateLimiter, auditLogService });
  const authService = new AuthService({
    repository: authRepo,
    sessionService,
    rateLimiter,
    loginProtection,
    emailProvider,
    auditLogService,
  });
  const notificationService = new NotificationService({
    repository: new NotificationRepository(),
    rateLimiter,
    realtimeProvider: realtimeAdapter,
  });
  const socialService = new SocialService({
    repository: new SocialRepository(),
    rateLimiter,
    auditLogService,
    notificationService,
  });
  const profileService = new ProfileService({
    repository: new ProfileRepository(),
    socialRepository: new SocialRepository(),
    rateLimiter,
    auditLogService,
  });
  const chatService = new ChatService({
    repository: new ChatRepository(),
    rateLimiter,
    realtimeProvider: realtimeAdapter,
    notificationService,
    pinResetOtpStore: otpStore,
    emailProvider,
    auditLogService,
  });

  setRealtimeProviderForTesting(realtimeAdapter);
  setSessionServiceForTesting(sessionService);
  setAuthServiceForTesting(authService);
  setNotificationServiceForTesting(notificationService);
  setSocialServiceForTesting(socialService);
  setProfileServiceForTesting(profileService);
  setChatServiceForTesting(chatService);
  clearMemoryKeystoreForTesting();
});

afterAll(async () => {
  resetChatServiceForTesting();
  resetProfileServiceForTesting();
  resetSocialServiceForTesting();
  resetNotificationServiceForTesting();
  resetAuthServiceForTesting();
  resetSessionServiceForTesting();
  resetRealtimeProviderForTesting();
  clearMemoryKeystoreForTesting();

  if (createdUserIds.length > 0) {
    await getDb().delete(users).where(inArray(users.id, createdUserIds));
  }
  await closeRedisClient();
  await closeDatabasePool();
});

describe('Integration: Chia sẻ liên kết trang cá nhân (Chặn 2 chiều 404) & Trọn vòng đời Mã PIN 6 số + RLS + Redis', () => {
  it('A chặn B -> B truy cập trực tiếp liên kết chia sẻ /api/v1/users/[handle] trả 404 sạch, không lộ hồ sơ', async () => {
    const origin = getTestOrigin();
    const alice = await seedAndLoginUser('share_a', 'Alice Share');
    const bob = await seedAndLoginUser('share_b', 'Bob Share');

    // Trước khi chặn: Bob xem được trang cá nhân của Alice.
    const okRes = await userProfileByHandleGet(
      new Request(`${origin}/api/v1/users/${alice.handle}`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
      { params: Promise.resolve({ handle: alice.handle }) },
    );
    expect(okRes.status).toBe(200);

    // Alice chặn Bob.
    const blockRes = await blockUserPost(
      new Request(`${origin}/api/v1/social/blocks/${bob.publicId}`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    expect(blockRes.status).toBe(200);

    // Bob mở trực tiếp liên kết `/u/[handle]` của Alice -> 404 sạch.
    const blockedRes1 = await userProfileByHandleGet(
      new Request(`${origin}/api/v1/users/${alice.handle}`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
      { params: Promise.resolve({ handle: alice.handle }) },
    );
    expect(blockedRes1.status).toBe(404);
    expect(await blockedRes1.text()).not.toContain('Alice Share');

    // Chiều ngược lại: Alice mở liên kết của Bob cũng trả 404 sạch (chặn 2 chiều).
    const blockedRes2 = await userProfileByHandleGet(
      new Request(`${origin}/api/v1/users/${bob.handle}`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ handle: bob.handle }) },
    );
    expect(blockedRes2.status).toBe(404);
  });

  it('Trọn vòng đời Mã PIN (Tạo -> Gửi/Sửa/Xóa M10 -> Trình duyệt mới khôi phục -> Đổi PIN -> Quên PIN Email OTP) kèm kiểm chứng PostgreSQL RLS', async () => {
    const origin = getTestOrigin();
    const alice = await seedAndLoginUser('pin_a', 'Alice PIN');
    const bob = await seedAndLoginUser('pin_b', 'Bob PIN');

    // Hai người theo dõi nhau để nhắn tin vào hộp thư Chính.
    const f1 = await followPost(
      new Request(`${origin}/api/v1/social/follow/${bob.publicId}`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    expect(f1.status).toBe(200);
    const f2 = await followPost(
      new Request(`${origin}/api/v1/social/follow/${alice.publicId}`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );
    expect(f2.status).toBe(200);

    // 1. Cả Alice và Bob tạo Mã PIN 6 số bắt buộc (atomically lưu backup + đăng ký khóa đồng bộ `is_sync_key = true`).
    const aliceInitialPin = await createPinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '123456',
      persistLocally: true,
    });
    const alicePrimary1 = await getOrCreatePrimaryDeviceKeyMaterial(alice.publicId);

    const alicePutBackup = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          ...aliceInitialPin.backup,
          ...aliceInitialPin.publicRegistration,
        }),
      }),
    );
    expect(alicePutBackup.status).toBe(200);

    await e2eeDevicesPost(
      new Request(`${origin}/api/v1/e2ee/devices`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          identityPublicKeyJwk: alicePrimary1.identityPublicKeyJwk,
          signingPublicKeyJwk: alicePrimary1.signingPublicKeyJwk,
          keyFingerprint: alicePrimary1.keyFingerprint,
          deviceLabel: 'Trình duyệt A1',
        }),
      }),
    );

    clearMemoryKeystoreForTesting();
    const bobInitialPin = await createPinProtectedKeyBackup({
      userPublicId: bob.publicId,
      pin: '654321',
      persistLocally: true,
    });
    const bobPrimary1 = await getOrCreatePrimaryDeviceKeyMaterial(bob.publicId);
    const bobPutBackup = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          ...bobInitialPin.backup,
          ...bobInitialPin.publicRegistration,
        }),
      }),
    );
    expect(bobPutBackup.status).toBe(200);
    await e2eeDevicesPost(
      new Request(`${origin}/api/v1/e2ee/devices`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          identityPublicKeyJwk: bobPrimary1.identityPublicKeyJwk,
          signingPublicKeyJwk: bobPrimary1.signingPublicKeyJwk,
          keyFingerprint: bobPrimary1.keyFingerprint,
          deviceLabel: 'Trình duyệt B1',
        }),
      }),
    );

    // 2. Đăng ký thêm 11 trình duyệt phụ cho Alice (> 10 thiết bị) để kiểm chứng Khóa Đồng bộ KHÔNG BAO GIỜ bị cắt hay thu hồi!
    for (let i = 0; i < 11; i += 1) {
      clearMemoryKeystoreForTesting();
      const extraMat = await getOrCreatePrimaryDeviceKeyMaterial(`alice-extra-${i}`);
      const regExtra = await e2eeDevicesPost(
        new Request(`${origin}/api/v1/e2ee/devices`, {
          method: 'POST',
          headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
          body: JSON.stringify({
            identityPublicKeyJwk: extraMat.identityPublicKeyJwk,
            signingPublicKeyJwk: extraMat.signingPublicKeyJwk,
            keyFingerprint: extraMat.keyFingerprint,
            deviceLabel: `Extra ${i}`,
          }),
        }),
      );
      expect(regExtra.status).toBe(200);
    }

    // Bob truy vấn khóa công khai của Alice -> Khóa Đồng bộ của Alice PHẢI đứng đầu tiên (`devices[0].isSyncKey === true`),
    // và trình duyệt A1 cũ đã bị tự thu hồi nằm trong `historicalSigningKeys`!
    const aliceBundleForBobRes = await e2eeUserKeysGet(
      new Request(`${origin}/api/v1/e2ee/users/${alice.publicId}/keys`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );
    expect(aliceBundleForBobRes.status).toBe(200);
    const aliceBundleForBob = (await aliceBundleForBobRes.json()) as UserE2eeKeyBundleDto;
    expect(aliceBundleForBob.devices[0]?.isSyncKey).toBe(true);
    expect(aliceBundleForBob.devices[0]?.keyFingerprint).toBe(
      aliceInitialPin.publicRegistration.keyFingerprint,
    );
    expect(
      aliceBundleForBob.historicalSigningKeys?.some(
        (k) => k.keyFingerprint === alicePrimary1.keyFingerprint,
      ),
    ).toBe(true);

    const bobBundleForAliceRes = await e2eeUserKeysGet(
      new Request(`${origin}/api/v1/e2ee/users/${bob.publicId}/keys`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    const bobBundleForAlice = (await bobBundleForAliceRes.json()) as UserE2eeKeyBundleDto;
    expect(bobBundleForAlice.devices[0]?.isSyncKey).toBe(true);

    // 3. Tạo cuộc hội thoại & gửi 2 tin nhắn (tin 1 chỉnh sửa M10, tin 2 xóa 1 phía M10).
    const convRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ recipientPublicId: bob.publicId }),
      }),
    );
    expect(convRes.status).toBe(201);
    const { conversation } = (await convRes.json()) as { conversation: { public_id: string } };
    const convId = conversation.public_id;

    // Gửi tin 1 từ trình duyệt A1 (đã bị tự thu hồi bởi 11 thiết bị phụ -> kiểm chứng historicalSigningKeys!).
    const envMsg1 = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: 'int_msg_1',
      plaintext: 'Nội dung gốc tin 1',
      senderDevice: alicePrimary1,
      recipientDevices: bobBundleForAlice.devices,
      senderOtherDevices: aliceBundleForBob.devices,
    });
    const send1Res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          clientMsgId: 'int_msg_1',
          messageType: 'text',
          ciphertext: envMsg1.ciphertext,
          cryptoHeader: envMsg1.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(send1Res.status).toBe(201);
    const sent1 = ((await send1Res.json()) as { message: ChatMessageDto }).message;

    // Chỉnh sửa tin 1 (M10).
    const editedEnv1 = await reEncryptEditedDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: 'int_msg_1',
      plaintext: 'Nội dung đã sửa tin 1',
      senderDevice: alicePrimary1,
      recipientDevices: bobBundleForAlice.devices,
      senderOtherDevices: aliceBundleForBob.devices,
      previousIv: envMsg1.cryptoHeader.iv,
    });
    const patch1Res = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${sent1.public_id}`, {
        method: 'PATCH',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          ciphertext: editedEnv1.ciphertext,
          cryptoHeader: editedEnv1.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: sent1.public_id }) },
    );
    expect(patch1Res.status).toBe(200);

    // Gửi tin 2 từ Bob rồi Alice "Xóa ở phía bạn" (M10).
    const envMsg2 = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: bob.publicId,
      clientMsgId: 'int_msg_2',
      plaintext: 'Tin nhắn Bob gửi rồi Alice xóa 1 phía',
      senderDevice: bobPrimary1,
      recipientDevices: aliceBundleForBob.devices,
      senderOtherDevices: bobBundleForAlice.devices,
    });
    const send2Res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          clientMsgId: 'int_msg_2',
          messageType: 'text',
          ciphertext: envMsg2.ciphertext,
          cryptoHeader: envMsg2.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(send2Res.status).toBe(201);
    const sent2 = ((await send2Res.json()) as { message: ChatMessageDto }).message;

    const delForMeRes = await messageDeleteForMe(
      new Request(`${origin}/api/v1/messages/${sent2.public_id}/for-me`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ messagePublicId: sent2.public_id }) },
    );
    expect(delForMeRes.status).toBe(200);

    // 4. Mô phỏng Trình duyệt MỚI của Alice (IndexedDB rỗng):
    clearMemoryKeystoreForTesting();
    const aliceNewBrowser = await getOrCreatePrimaryDeviceKeyMaterial(alice.publicId);
    await e2eeDevicesPost(
      new Request(`${origin}/api/v1/e2ee/devices`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          identityPublicKeyJwk: aliceNewBrowser.identityPublicKeyJwk,
          signingPublicKeyJwk: aliceNewBrowser.signingPublicKeyJwk,
          keyFingerprint: aliceNewBrowser.keyFingerprint,
          deviceLabel: 'Trình duyệt Mới',
        }),
      }),
    );

    // Trước khi nhập PIN: gửi tin 3 trên trình duyệt mới vẫn thành công và bọc kèm Khóa Đồng bộ!
    const aliceOwnKeysRes = await e2eeUserKeysGet(
      new Request(`${origin}/api/v1/e2ee/users/${alice.publicId}/keys`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );
    const aliceOwnBundle = (await aliceOwnKeysRes.json()) as UserE2eeKeyBundleDto;
    expect(aliceOwnBundle.hasKeyBackup).toBe(true);
    expect(resolvePinSyncState(aliceOwnBundle, false)).toBe('needs_restore');

    const envMsg3 = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: 'int_msg_3',
      plaintext: 'Tin mới gửi trước khi nhập mã PIN',
      senderDevice: aliceNewBrowser,
      recipientDevices: bobBundleForAlice.devices,
      senderOtherDevices: aliceOwnBundle.devices,
    });
    const send3Res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          clientMsgId: 'int_msg_3',
          messageType: 'text',
          ciphertext: envMsg3.ciphertext,
          cryptoHeader: envMsg3.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(send3Res.status).toBe(201);

    // Nhập đúng mã PIN `123456` trên trình duyệt mới -> giải mã 100% tin cũ + tin mới,
    // đồng thời tin 2 đã xóa 1 phía ở M10 vẫn bị ẩn tuyệt đối!
    const backupGetRes = await e2eeBackupGet(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
    );
    const { backup: serverBackup } = (await backupGetRes.json()) as { backup: E2eeKeyBackupDto };
    const restoredMat = await restorePinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '123456',
      backup: serverBackup,
    });
    await saveDeviceKeyMaterial(restoredMat, 'backup');

    const msgsRes = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${convId}/messages?limit=25`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(msgsRes.status).toBe(200);
    const { items: aliceMsgs } = (await msgsRes.json()) as { items: ChatMessageDto[] };
    // Chỉ gồm tin 1 (đã sửa) và tin 3; tin 2 đã xóa 1 phía hoàn toàn vắng mặt!
    expect(aliceMsgs.map((m) => m.clientMsgId)).toEqual(['int_msg_1', 'int_msg_3']);

    const verificationDevices = [
      ...aliceOwnBundle.devices,
      ...(aliceOwnBundle.historicalSigningKeys ?? []).map((h) => ({
        devicePublicId: h.keyFingerprint,
        ...h,
      })),
    ];
    const aliceLocalMats = await listLocalDeviceKeyMaterials(alice.publicId);
    const dec1 = await decryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: aliceMsgs[0]!.clientMsgId,
      ciphertext: aliceMsgs[0]!.ciphertext!,
      cryptoHeader: aliceMsgs[0]!.cryptoHeader!,
      receiverKeyMaterials: aliceLocalMats,
      expectedSenderDevices: verificationDevices,
    });
    const dec3 = await decryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: aliceMsgs[1]!.clientMsgId,
      ciphertext: aliceMsgs[1]!.ciphertext!,
      cryptoHeader: aliceMsgs[1]!.cryptoHeader!,
      receiverKeyMaterials: aliceLocalMats,
      expectedSenderDevices: verificationDevices,
    });
    expect(dec1.text).toBe('Nội dung đã sửa tin 1');
    expect(dec3.text).toBe('Tin mới gửi trước khi nhập mã PIN');

    // 5. Đổi mã PIN (không cần email: `123456` -> `777888`) -> version tăng lên 2, trình duyệt C nhập `777888` giải mã 100% tin cũ!
    const changed = await reEncryptPinProtectedKeyBackup({
      userPublicId: alice.publicId,
      currentPin: '123456',
      newPin: '777888',
      backup: serverBackup,
      persistLocally: false,
    });
    const changePutRes = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          ...changed.backup,
          ...changed.publicRegistration,
        }),
      }),
    );
    expect(changePutRes.status).toBe(200);
    const { backup: backupV2 } = (await changePutRes.json()) as { backup: E2eeKeyBackupDto };
    expect(backupV2.version).toBe(2);
    expect(backupV2.keyFingerprint).toBe(serverBackup.keyFingerprint);

    // Mô phỏng trình duyệt C: khôi phục bằng PIN mới `777888` -> vẫn đọc được tin 1 từ trước khi đổi PIN!
    clearMemoryKeystoreForTesting();
    const restoredV2 = await restorePinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '777888',
      backup: backupV2,
    });
    const dec1OnBrowserC = await decryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: aliceMsgs[0]!.clientMsgId,
      ciphertext: aliceMsgs[0]!.ciphertext!,
      cryptoHeader: aliceMsgs[0]!.cryptoHeader!,
      receiverKeyMaterials: [restoredV2],
      expectedSenderDevices: verificationDevices,
    });
    expect(dec1OnBrowserC.text).toBe('Nội dung đã sửa tin 1');

    // 6. Quên mã PIN qua Email OTP trên Redis thật:
    const resetReq1 = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
    );
    expect(resetReq1.status).toBe(200);
    const resetReqBody1 = (await resetReq1.json()) as {
      maskedEmail: string;
      resendAfterSeconds: number;
    };
    expect(resetReqBody1.maskedEmail).toMatch(/^[a-z0-9]\*\*\*@tomato\.test$/);
    expect(resetReqBody1.resendAfterSeconds).toBe(60);

    // Cooldown 60s chặn gửi lại ngay lập tức (429).
    const immediateResend = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
    );
    expect(immediateResend.status).toBe(429);

    const otp1 = extractOtp(emailProvider.sent[emailProvider.sent.length - 1]!);
    const resetKeypack = await createPinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '998877',
      persistLocally: false,
    });

    // Nhập sai OTP 5 lần -> Redis tự hủy OTP.
    const badOtp = otp1 === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const failConfirm = await pinResetConfirmPost(
        new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
          method: 'POST',
          headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
          body: JSON.stringify({
            otpCode: badOtp,
            encryptedKeyBlob: resetKeypack.backup.encryptedKeyBlob,
            kdfSalt: resetKeypack.backup.kdfSalt,
            kdfParams: resetKeypack.backup.kdfParams,
            iv: resetKeypack.backup.iv,
            keyFingerprint: resetKeypack.backup.keyFingerprint,
            identityPublicKeyJwk: resetKeypack.publicRegistration.identityPublicKeyJwk,
            signingPublicKeyJwk: resetKeypack.publicRegistration.signingPublicKeyJwk,
            deviceLabel: resetKeypack.publicRegistration.deviceLabel,
          }),
        }),
      );
      expect(failConfirm.status).toBe(400);
    }

    // Xóa cooldown để xin OTP đợt 2 và xác nhận thành công.
    await rateLimiter.reset(
      `chat:e2ee:pin-reset:request:cooldown:user:${alice.id}`,
      CHAT_RATE_LIMITS.pinResetRequestCooldown,
    );
    const resetReq2 = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
    );
    expect(resetReq2.status).toBe(200);
    const otp2 = extractOtp(emailProvider.sent[emailProvider.sent.length - 1]!);

    const confirmOk = await pinResetConfirmPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          otpCode: otp2,
          encryptedKeyBlob: resetKeypack.backup.encryptedKeyBlob,
          kdfSalt: resetKeypack.backup.kdfSalt,
          kdfParams: resetKeypack.backup.kdfParams,
          iv: resetKeypack.backup.iv,
          keyFingerprint: resetKeypack.backup.keyFingerprint,
          identityPublicKeyJwk: resetKeypack.publicRegistration.identityPublicKeyJwk,
          signingPublicKeyJwk: resetKeypack.publicRegistration.signingPublicKeyJwk,
          deviceLabel: resetKeypack.publicRegistration.deviceLabel,
        }),
      }),
    );
    expect(confirmOk.status).toBe(200);
    const confirmBody = (await confirmOk.json()) as {
      backup: E2eeKeyBackupDto;
      device: { isSyncKey: boolean; keyFingerprint: string };
    };
    expect(confirmBody.backup.version).toBe(3);
    expect(confirmBody.backup.keyFingerprint).toBe(resetKeypack.backup.keyFingerprint);
    expect(confirmBody.device.isSyncKey).toBe(true);

    // Dùng lại OTP lần 2 -> 400.
    const replayConfirm = await pinResetConfirmPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          otpCode: otp2,
          encryptedKeyBlob: resetKeypack.backup.encryptedKeyBlob,
          kdfSalt: resetKeypack.backup.kdfSalt,
          kdfParams: resetKeypack.backup.kdfParams,
          iv: resetKeypack.backup.iv,
          keyFingerprint: resetKeypack.backup.keyFingerprint,
          identityPublicKeyJwk: resetKeypack.publicRegistration.identityPublicKeyJwk,
          signingPublicKeyJwk: resetKeypack.publicRegistration.signingPublicKeyJwk,
          deviceLabel: resetKeypack.publicRegistration.deviceLabel,
        }),
      }),
    );
    expect(replayConfirm.status).toBe(400);

    // Kiểm chứng DB: chỉ có ĐÚNG 1 Khóa Đồng bộ đang hoạt động cho Alice (unique partial index) & audit_logs không chứa OTP/PIN.
    const activeSyncDevices = await getDb()
      .select()
      .from(userE2eeDevices)
      .where(eq(userE2eeDevices.userId, alice.id));
    const currentSyncRows = activeSyncDevices.filter((d) => d.isSyncKey && d.revokedAt === null);
    expect(currentSyncRows).toHaveLength(1);
    expect(currentSyncRows[0]?.keyFingerprint).toBe(resetKeypack.backup.keyFingerprint);

    const aliceAuditRows = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, alice.id));
    expect(aliceAuditRows.some((r) => r.action === 'E2EE_PIN_RESET_COMPLETED')).toBe(true);
    expect(JSON.stringify(aliceAuditRows)).not.toContain(otp2);
    expect(JSON.stringify(aliceAuditRows)).not.toContain('998877');

    // Gửi tin 4 sau khi đặt lại PIN -> Trình duyệt D khôi phục bằng PIN mới `998877` giải mã mượt mà,
    // và `resolvePinSyncState` === 'synced' (KHÔNG lặp đòi PIN đối với tin 1 trước lúc đặt lại).
    const aliceKeysAfterResetRes = await e2eeUserKeysGet(
      new Request(`${origin}/api/v1/e2ee/users/${alice.publicId}/keys`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );
    const aliceKeysAfterReset = (await aliceKeysAfterResetRes.json()) as UserE2eeKeyBundleDto;
    expect(aliceKeysAfterReset.devices[0]?.keyFingerprint).toBe(resetKeypack.backup.keyFingerprint);
    expect(resolvePinSyncState(aliceKeysAfterReset, true)).toBe('synced');

    const envMsg4 = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: bob.publicId,
      clientMsgId: 'int_msg_4_after_reset',
      plaintext: 'Tin mới sau khi đặt lại mã PIN',
      senderDevice: bobPrimary1,
      recipientDevices: aliceKeysAfterReset.devices,
      senderOtherDevices: bobBundleForAlice.devices,
    });
    const send4Res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          clientMsgId: 'int_msg_4_after_reset',
          messageType: 'text',
          ciphertext: envMsg4.ciphertext,
          cryptoHeader: envMsg4.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(send4Res.status).toBe(201);

    clearMemoryKeystoreForTesting();
    const restoredAfterReset = await restorePinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '998877',
      backup: confirmBody.backup,
    });
    const dec4 = await decryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: bob.publicId,
      clientMsgId: 'int_msg_4_after_reset',
      ciphertext: envMsg4.ciphertext,
      cryptoHeader: envMsg4.cryptoHeader,
      receiverKeyMaterials: [restoredAfterReset],
    });
    expect(dec4.text).toBe('Tin mới sau khi đặt lại mã PIN');

    // Xóa đoạn chat (M10) -> xác minh `cleared_before_seq` ẩn sạch tin cũ kể cả khi đã có khóa đồng bộ mới!
    const delConvRes = await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(delConvRes.status).toBe(200);

    const afterClearMsgsRes = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${convId}/messages?limit=25`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(afterClearMsgsRes.status).toBe(200);
    const { items: afterClearItems } = (await afterClearMsgsRes.json()) as {
      items: ChatMessageDto[];
    };
    expect(afterClearItems).toHaveLength(0);

    // Kiểm chứng PostgreSQL RLS với role không có BYPASSRLS: Bob tuyệt đối không đọc được `user_e2ee_key_backups` của Alice.
    await withRlsContext(bob.id, async (tx) => {
      await tx.execute(sql`DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tomato_rls_tester') THEN
            CREATE ROLE tomato_rls_tester NOLOGIN NOBYPASSRLS;
          END IF;
        END $$;`);
      await tx.execute(sql`GRANT USAGE ON SCHEMA public TO tomato_rls_tester`);
      await tx.execute(
        sql`GRANT SELECT ON public.user_e2ee_key_backups, public.user_e2ee_devices TO tomato_rls_tester`,
      );
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_tester`);

      const leakedBackups = await tx.execute<{ user_id: string }>(
        sql`SELECT user_id FROM public.user_e2ee_key_backups WHERE user_id = ${alice.id}::uuid`,
      );
      expect(leakedBackups.rows).toHaveLength(0);

      // Bob vẫn đọc được khóa công khai `is_sync_key = true` của Alice qua `user_e2ee_devices`.
      const visibleSyncKey = await tx.execute<{ key_fingerprint: string }>(
        sql`SELECT key_fingerprint FROM public.user_e2ee_devices WHERE user_id = ${alice.id}::uuid AND is_sync_key = true AND revoked_at IS NULL`,
      );
      expect(visibleSyncKey.rows).toHaveLength(1);
      expect(visibleSyncKey.rows[0]?.key_fingerprint).toBe(resetKeypack.backup.keyFingerprint);
    });
  }, 45_000);
});
