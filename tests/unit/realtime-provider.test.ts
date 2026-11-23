import { describe, expect, it, vi } from 'vitest';

import {
  AblyRealtimeAdapter,
  InMemoryRealtimeAdapter,
  LOCAL_REALTIME_STREAM_URL,
  REALTIME_TOKEN_TTL_MS,
  assertRealtimePayloadSafe,
  buildSubscribeOnlyCapability,
  buildUserRealtimeChannel,
  createRealtimeProvider,
} from '@/core/realtime';

const USER_A_PUBLIC_ID = '11111111-1111-4111-8111-111111111111';
const USER_B_PUBLIC_ID = '22222222-2222-4222-8222-222222222222';
const SYNTHETIC_ABLY_KEY = 'syntheticApp.syntheticKey:syntheticSecretValueNotReal';

describe('Core Realtime Provider (Port & Adapter)', () => {
  it('chọn đúng adapter qua createRealtimeProvider và fail-fast khi thiếu key', () => {
    const localProvider = createRealtimeProvider({
      REALTIME_PROVIDER: 'local',
      ABLY_API_KEY: undefined,
    });
    expect(localProvider).toBeInstanceOf(InMemoryRealtimeAdapter);
    expect(localProvider.provider).toBe('local');

    const ablyProvider = createRealtimeProvider({
      REALTIME_PROVIDER: 'ably',
      ABLY_API_KEY: SYNTHETIC_ABLY_KEY,
    });
    expect(ablyProvider).toBeInstanceOf(AblyRealtimeAdapter);
    expect(ablyProvider.provider).toBe('ably');

    expect(() =>
      createRealtimeProvider({
        REALTIME_PROVIDER: 'ably',
        ABLY_API_KEY: undefined,
      }),
    ).toThrow();
  });

  it('AblyRealtimeAdapter cấp TokenRequest TTL 15 phút chỉ có duy nhất quyền subscribe cho kênh user:{publicId}', async () => {
    const issuedAt = 1_760_000_000_000;
    const createTokenRequestMock = vi.fn(async (params: Record<string, unknown>) => ({
      keyName: 'syntheticApp.syntheticKey',
      ttl: Number(params.ttl),
      timestamp: issuedAt,
      capability: String(params.capability),
      clientId: String(params.clientId),
      nonce: 'synthetic-nonce-value',
      mac: 'synthetic-hmac-signature',
    }));
    const publishMock = vi.fn().mockResolvedValue(undefined);

    const adapter = new AblyRealtimeAdapter({
      apiKey: SYNTHETIC_ABLY_KEY,
      now: () => issuedAt,
      client: {
        auth: {
          createTokenRequest: createTokenRequestMock,
        },
        channels: {
          get: vi.fn(() => ({ publish: publishMock })),
        },
      } as never,
    });

    const result = await adapter.createSubscribeToken(USER_A_PUBLIC_ID.toUpperCase());

    expect(createTokenRequestMock).toHaveBeenCalledTimes(1);
    const callArg = createTokenRequestMock.mock.calls[0]?.[0];
    expect(callArg).toEqual({
      clientId: USER_A_PUBLIC_ID,
      ttl: REALTIME_TOKEN_TTL_MS,
      capability: JSON.stringify({ [`user:${USER_A_PUBLIC_ID}`]: ['subscribe'] }),
    });
    expect(REALTIME_TOKEN_TTL_MS).toBe(900_000);

    // Kiểm tra quyền tối thiểu: chỉ subscribe đúng 1 kênh, không có publish/presence/wildcard.
    const parsedCapability = JSON.parse(String(result.tokenRequest?.capability)) as Record<
      string,
      string[]
    >;
    expect(Object.keys(parsedCapability)).toEqual([`user:${USER_A_PUBLIC_ID}`]);
    expect(parsedCapability[`user:${USER_A_PUBLIC_ID}`]).toEqual(['subscribe']);
    expect(JSON.stringify(result)).not.toContain('syntheticSecretValueNotReal');
    expect(result.channel).toBe(`user:${USER_A_PUBLIC_ID}`);
    expect(result.ttlMs).toBe(900_000);
    expect(result.expiresAt).toBe(new Date(issuedAt + 900_000).toISOString());

    await adapter.publishToUser(USER_B_PUBLIC_ID, 'notification.created', {
      unreadCount: 1,
      notification: {
        public_id: '33333333-3333-4333-8333-333333333333',
        type: 'new_follower',
      },
    });
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('chặn định danh kênh không phải UUIDv4 (UUIDv7/wildcard) và chặn payload chứa id nội bộ hay email/PII', () => {
    expect(buildUserRealtimeChannel(USER_A_PUBLIC_ID)).toBe(`user:${USER_A_PUBLIC_ID}`);
    expect(buildSubscribeOnlyCapability(`user:${USER_A_PUBLIC_ID}`)).toBe(
      JSON.stringify({ [`user:${USER_A_PUBLIC_ID}`]: ['subscribe'] }),
    );

    // Từ chối UUIDv7 nội bộ và wildcard Ably.
    expect(() => buildUserRealtimeChannel('0195a000-0000-7000-8000-000000000001')).toThrow();
    expect(() => buildUserRealtimeChannel('*')).toThrow();
    expect(() => buildUserRealtimeChannel(`user:${USER_A_PUBLIC_ID}`)).toThrow();
    expect(() => buildSubscribeOnlyCapability('user:*')).toThrow();

    // Chặn payload rò rỉ khóa nội bộ hoặc PII.
    expect(() =>
      assertRealtimePayloadSafe({ id: '0195a000-0000-7000-8000-000000000001' }),
    ).toThrow();
    expect(() => assertRealtimePayloadSafe({ nested: { email: 'alice@example.com' } })).toThrow();
    expect(() => assertRealtimePayloadSafe({ note: 'contact alice@example.com' })).toThrow();
    expect(() =>
      assertRealtimePayloadSafe({ actor: { userId: '0195a000-0000-7000-8000-000000000001' } }),
    ).toThrow();

    // Payload DTO công khai hợp lệ được phép đi qua.
    expect(() =>
      assertRealtimePayloadSafe({
        unreadCount: 2,
        notification: {
          public_id: USER_A_PUBLIC_ID,
          type: 'follow_request',
          actor: {
            public_id: USER_B_PUBLIC_ID,
            handle: 'bob_dev',
            fullName: 'Bob Dev',
            avatarUrl: null,
            isPrivate: false,
          },
        },
      }),
    ).not.toThrow();
  });

  it('InMemoryRealtimeAdapter cô lập tuyệt đối kênh giữa các user và giải phóng listener khi unsubscribe', async () => {
    const adapter = new InMemoryRealtimeAdapter({ isolated: true });
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];

    const tokenA = await adapter.createSubscribeToken(USER_A_PUBLIC_ID);
    expect(tokenA.provider).toBe('local');
    expect(tokenA.channel).toBe(`user:${USER_A_PUBLIC_ID}`);
    expect(tokenA.streamUrl).toBe(LOCAL_REALTIME_STREAM_URL);
    expect(tokenA.ttlMs).toBe(REALTIME_TOKEN_TTL_MS);

    const unsubA = adapter.subscribeLocal(USER_A_PUBLIC_ID, (msg) => receivedA.push(msg));
    const unsubB = adapter.subscribeLocal(USER_B_PUBLIC_ID, (msg) => receivedB.push(msg));

    expect(adapter.getListenerCount(USER_A_PUBLIC_ID)).toBe(1);
    expect(adapter.getListenerCount(USER_B_PUBLIC_ID)).toBe(1);

    await adapter.publishToUser(USER_B_PUBLIC_ID, 'notification.created', {
      unreadCount: 3,
    });

    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);

    unsubA();
    unsubA(); // idempotent
    unsubB();

    expect(adapter.getListenerCount(USER_A_PUBLIC_ID)).toBe(0);
    expect(adapter.getListenerCount(USER_B_PUBLIC_ID)).toBe(0);
  });
});
