import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  formatCallEventLabel,
  getConversationPreviewText,
} from '@/components/messages/message-actions';
import { assertRealtimePayloadSafe } from '@/core/realtime';
import {
  EPHEMERAL_TURN_TTL_SECONDS,
  MeteredTurnCredentialProvider,
  PUBLIC_STUN_ICE_SERVERS,
  StunFallbackTurnProvider,
  createTurnCredentialProvider,
  normalizeMeteredDomain,
  sanitizeIceServers,
} from '@/core/webrtc';
import { PeerCallEngine, type CallSignalPayload } from '@/lib/webrtc/call-engine';
import {
  MAX_CALL_ICE_CANDIDATE_LENGTH,
  MAX_CALL_SDP_LENGTH,
  authorizeCallAction,
  callActionInputSchema,
  callSignalInputSchema,
  createCallInputSchema,
} from '@/modules/calls';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';

const CONV_PUBLIC_ID = '33333333-3333-4333-8333-333333333333';
const CALL_PUBLIC_ID = '44444444-4444-4444-8444-444444444444';
const USER_A_PUBLIC_ID = '11111111-1111-4111-8111-111111111111';
const USER_B_PUBLIC_ID = '22222222-2222-4222-8222-222222222222';

function makeActor(id: string, publicId: string): AuthenticatedPrincipal {
  const now = new Date('2026-11-24T12:00:00.000Z');
  return {
    user: {
      id,
      publicId,
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
      dateOfBirth: '1999-01-01',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    session: {
      id: '0195a000-0000-7000-8000-000000000099',
      publicId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: id,
      familyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      refreshTokenHash: 'synthetic-hash',
      deviceInfo: 'Chrome',
      ipAddress: '127.0.0.1',
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      revokedAt: null,
      revokeReason: null,
      createdAt: now,
    },
  };
}

describe('Unit M12: TurnCredentialProvider (3 tầng ưu tiên 0đ & phòng thủ parse)', () => {
  it('Tầng 1 ưu tiên METERED_DOMAIN + METERED_SECRET_KEY tạo ephemeral credential TTL <= 900s, lọc sạch field lạ và cache ngắn', async () => {
    const requestedUrls: string[] = [];
    let nowMs = 1_760_000_000_000;
    const mockTempSubKey = 'test-key-000001';

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes('/api/v1/turn/credential?secretKey=')) {
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as { expiryInSeconds?: number };
        expect(parsedBody.expiryInSeconds).toBeLessThanOrEqual(EPHEMERAL_TURN_TTL_SECONDS);
        return new Response(
          JSON.stringify({
            username: 'ephemeral-user-1',
            password: 'ephemeral-pass-1',
            expiryInSeconds: 900,
            apiKey: mockTempSubKey,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes(`/api/v1/turn/credentials?apiKey=${mockTempSubKey}`)) {
        return new Response(
          JSON.stringify([
            { urls: 'stun:stun.relay.metered.ca:80' },
            {
              urls: 'turns:global.relay.metered.ca:443?transport=tcp',
              username: 'ephemeral-user-1',
              credential: 'ephemeral-pass-1',
              apiKey: 'must-be-stripped',
              secretKey: 'must-be-stripped',
            },
            { urls: 'https://evil.example.com/not-ice' },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    const provider = new MeteredTurnCredentialProvider({
      domain: 'tomato-social.metered.live',
      secretKey: 'synthetic-metered-secret-placeholder',
      turnApiKey: 'synthetic-metered-turn-placeholder',
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => nowMs,
    });

    const first = await provider.getIceServers();
    expect(first.source).toBe('metered_ephemeral');
    expect(first.ttlSeconds).toBeLessThanOrEqual(900);
    expect(first.iceServers).toEqual([
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: 'turns:global.relay.metered.ca:443?transport=tcp',
        username: 'ephemeral-user-1',
        credential: 'ephemeral-pass-1',
      },
    ]);
    expect(JSON.stringify(first)).not.toContain('must-be-stripped');
    expect(JSON.stringify(first)).not.toContain('evil.example.com');
    expect(requestedUrls).toHaveLength(2);

    // Gọi lần 2 trong thời gian cache ngắn (100s) -> dùng lại ephemeral credential đã tạo, không gọi lại Metered.
    nowMs += 100_000;
    const second = await provider.getIceServers();
    expect(second.source).toBe('metered_ephemeral');
    expect(second.ttlSeconds).toBeLessThanOrEqual(800);
    expect(requestedUrls).toHaveLength(2);
  });

  it('Tầng 1 tự dựng relay servers nếu Metered chỉ trả username/password mà không có apiKey phụ', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          username: 'ephemeral-u2',
          password: 'ephemeral-p2',
          expiryInSeconds: 600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new MeteredTurnCredentialProvider({
      domain: 'tomato-social.metered.live',
      secretKey: 'synthetic-metered-secret-placeholder',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await provider.getIceServers();
    expect(res.source).toBe('metered_ephemeral');
    expect(res.ttlSeconds).toBe(600);
    expect(res.iceServers.some((s) => String(s.urls).startsWith('turns:'))).toBe(true);
    expect(res.iceServers.find((s) => s.username)?.username).toBe('ephemeral-u2');
  });

  it('Tầng 1 lỗi mạng/định dạng lạ -> tự rơi êm sang Tầng 2 (METERED_TURN_API_KEY) và cuối cùng sang Tầng 3 (STUN công khai)', async () => {
    const mockFetchTier2 = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/turn/credential?secretKey=')) {
        // Phản hồi dị dạng không phải object/không có thông tin credential -> phải rơi êm sang Tầng 2.
        return new Response('<html>unexpected</html>', { status: 200 });
      }
      if (url.includes('/api/v1/turn/credentials?apiKey=')) {
        return new Response(
          JSON.stringify([
            {
              urls: 'turn:global.relay.metered.ca:443',
              username: 'fallback-u',
              credential: 'fallback-p',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('', { status: 500 });
    });

    const providerTier2 = new MeteredTurnCredentialProvider({
      domain: 'tomato-social.metered.live',
      secretKey: 'synthetic-metered-secret-placeholder',
      turnApiKey: 'synthetic-metered-turn-placeholder',
      fetchFn: mockFetchTier2 as unknown as typeof fetch,
    });
    const res2 = await providerTier2.getIceServers();
    expect(res2.source).toBe('metered_api_key');
    expect(res2.iceServers[0]?.username).toBe('fallback-u');

    // Cả Tầng 1 và Tầng 2 lỗi mạng -> rơi êm sang STUN công khai, không ném lỗi chứa secretKey/apiKey.
    const failingFetch = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`network failure contacting ${String(input)}`);
    });
    const providerTier3 = new MeteredTurnCredentialProvider({
      domain: 'tomato-social.metered.live',
      secretKey: 'synthetic-metered-secret-placeholder',
      turnApiKey: 'synthetic-metered-turn-placeholder',
      fetchFn: failingFetch as unknown as typeof fetch,
    });
    const res3 = await providerTier3.getIceServers();
    expect(res3.source).toBe('stun_fallback');
    expect(res3.iceServers).toEqual(PUBLIC_STUN_ICE_SERVERS);
  });

  it('chống SSRF tên miền Metered, lọc sạch sanitizeIceServers và mặc định dùng STUN offline trong NODE_ENV=test', () => {
    expect(normalizeMeteredDomain('tomato-social.metered.live')).toBe('tomato-social.metered.live');
    expect(normalizeMeteredDomain('https://tomato-social.metered.live')).toBeNull();
    expect(normalizeMeteredDomain('tomato-social.metered.live/path')).toBeNull();
    expect(normalizeMeteredDomain('user@tomato-social.metered.live')).toBeNull();
    expect(normalizeMeteredDomain('127.0.0.1')).toBeNull();

    expect(
      sanitizeIceServers([
        null,
        { urls: 'javascript:alert(1)' },
        { urls: ['stun:stun.l.google.com:19302', 'http://bad.local'] },
      ]),
    ).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);

    const testEnvProvider = createTurnCredentialProvider({
      NODE_ENV: 'test',
      METERED_DOMAIN: 'tomato-social.metered.live',
      METERED_SECRET_KEY: 'synthetic-metered-secret-placeholder',
      METERED_TURN_API_KEY: 'synthetic-metered-turn-placeholder',
    });
    expect(testEnvProvider).toBeInstanceOf(StunFallbackTurnProvider);
  });
});

describe('Unit M12: Call Schemas, ReBAC Policy & assertRealtimePayloadSafe() cho 5 sự kiện call.*', () => {
  it('validate Zod strict cho createCall, signal (SDP <= 32KB, candidate <= 2KB) và action (bao gồm heartbeat & timeout)', () => {
    expect(
      createCallInputSchema.safeParse({
        conversationPublicId: CONV_PUBLIC_ID,
        callType: 'video',
      }).success,
    ).toBe(true);
    // Từ chối field lạ (BOPLA) và từ chối UUIDv7 nội bộ.
    expect(
      createCallInputSchema.safeParse({
        conversationPublicId: CONV_PUBLIC_ID,
        callType: 'audio',
        callerId: '0195a000-0000-7000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      createCallInputSchema.safeParse({
        conversationPublicId: '0195a000-0000-7000-8000-000000000001',
        callType: 'audio',
      }).success,
    ).toBe(false);

    // SDP 32 KB hợp lệ, vượt quá 32 KB bị từ chối.
    const validLargeSdp = `v=0\r\n${'a'.repeat(MAX_CALL_SDP_LENGTH - 5)}`;
    expect(callSignalInputSchema.safeParse({ type: 'offer', sdp: validLargeSdp }).success).toBe(
      true,
    );
    expect(
      callSignalInputSchema.safeParse({ type: 'offer', sdp: `${validLargeSdp}x` }).success,
    ).toBe(false);

    // ICE candidate <= 2 KB hợp lệ, > 2 KB bị từ chối.
    expect(
      callSignalInputSchema.safeParse({
        type: 'ice-candidate',
        candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'ufrag123',
      }).success,
    ).toBe(true);
    expect(
      callSignalInputSchema.safeParse({
        type: 'ice-candidate',
        candidate: 'c'.repeat(MAX_CALL_ICE_CANDIDATE_LENGTH + 1),
      }).success,
    ).toBe(false);

    for (const action of ['accept', 'decline', 'end', 'timeout', 'heartbeat'] as const) {
      expect(callActionInputSchema.safeParse({ action }).success).toBe(true);
    }
    expect(callActionInputSchema.safeParse({ action: 'end', extra: true }).success).toBe(false);
  });

  it('call.policy.ts cưỡng chế Deny-by-Default cho người ngoài cuộc và chặn 2 chiều', () => {
    const actorA = makeActor('0195a000-0000-7000-8000-000000000001', USER_A_PUBLIC_ID);
    const peerB = {
      id: '0195a000-0000-7000-8000-000000000002',
      status: 'active' as const,
      deletedAt: null,
    };
    const conv = { id: '0195a000-0000-7000-8000-000000000010', publicId: CONV_PUBLIC_ID };

    expect(
      authorizeCallAction(actorA, 'call:create', {
        conversation: conv,
        actorParticipant: {
          conversationId: conv.id,
          userId: actorA.user.id,
          inboxState: 'primary',
        },
        peerParticipant: { conversationId: conv.id, userId: peerB.id, inboxState: 'primary' },
        peerUser: peerB,
        relationship: {
          actorFollowStatus: 'following',
          targetFollowStatus: 'following',
          blockedByActor: false,
          blockedByTarget: false,
        },
      }),
    ).toBe(true);

    // Chặn 2 chiều -> false (Service trả 404).
    expect(
      authorizeCallAction(actorA, 'call:create', {
        conversation: conv,
        actorParticipant: {
          conversationId: conv.id,
          userId: actorA.user.id,
          inboxState: 'primary',
        },
        peerParticipant: { conversationId: conv.id, userId: peerB.id, inboxState: 'primary' },
        peerUser: peerB,
        relationship: {
          actorFollowStatus: 'none',
          targetFollowStatus: 'none',
          blockedByActor: false,
          blockedByTarget: true,
        },
      }),
    ).toBe(false);

    // Người ngoài phiên gọi -> false.
    expect(
      authorizeCallAction(actorA, 'call:signal', {
        callSession: {
          id: '0195a000-0000-7000-8000-000000000050',
          conversationId: conv.id,
          callerId: '0195a000-0000-7000-8000-000000000003',
          calleeId: peerB.id,
          status: 'connected',
        },
        peerUser: peerB,
        relationship: {
          actorFollowStatus: 'none',
          targetFollowStatus: 'none',
          blockedByActor: false,
          blockedByTarget: false,
        },
      }),
    ).toBe(false);
  });

  it('assertRealtimePayloadSafe() cho phép cả 5 payload sự kiện call.* đi qua trơn tru và chặn id nội bộ / secret / apiKey', () => {
    // 1. call.incoming
    expect(() =>
      assertRealtimePayloadSafe({
        callPublicId: CALL_PUBLIC_ID,
        conversationPublicId: CONV_PUBLIC_ID,
        callType: 'video',
        startedAt: '2026-11-24T12:00:00.000Z',
        expiresAt: '2026-11-24T12:00:45.000Z',
        caller: {
          public_id: USER_A_PUBLIC_ID,
          handle: 'alice',
          fullName: 'Alice Nguyen',
          avatarUrl: null,
        },
      }),
    ).not.toThrow();

    // 2. call.accepted
    expect(() =>
      assertRealtimePayloadSafe({
        callPublicId: CALL_PUBLIC_ID,
        conversationPublicId: CONV_PUBLIC_ID,
        callType: 'video',
        connectedAt: '2026-11-24T12:00:05.000Z',
        acceptedByPublicId: USER_B_PUBLIC_ID,
      }),
    ).not.toThrow();

    // 3. call.declined
    expect(() =>
      assertRealtimePayloadSafe({
        callPublicId: CALL_PUBLIC_ID,
        conversationPublicId: CONV_PUBLIC_ID,
        callType: 'audio',
        status: 'declined',
        durationSeconds: null,
        endedAt: '2026-11-24T12:00:08.000Z',
      }),
    ).not.toThrow();

    // 4. call.ended
    expect(() =>
      assertRealtimePayloadSafe({
        callPublicId: CALL_PUBLIC_ID,
        conversationPublicId: CONV_PUBLIC_ID,
        callType: 'video',
        status: 'ended',
        durationSeconds: 125,
        endedAt: '2026-11-24T12:02:10.000Z',
      }),
    ).not.toThrow();

    // 5. call.signal (offer/answer + ice-candidate với đủ trường chuẩn WebRTC)
    expect(() =>
      assertRealtimePayloadSafe({
        callPublicId: CALL_PUBLIC_ID,
        conversationPublicId: CONV_PUBLIC_ID,
        fromPublicId: USER_A_PUBLIC_ID,
        type: 'offer',
        sdp: 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
      }),
    ).not.toThrow();

    expect(() =>
      assertRealtimePayloadSafe({
        callPublicId: CALL_PUBLIC_ID,
        conversationPublicId: CONV_PUBLIC_ID,
        fromPublicId: USER_A_PUBLIC_ID,
        type: 'ice-candidate',
        candidate: 'candidate:842163049 1 udp 1677729535 198.51.100.2 56143 typ srflx',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'ufrag99',
      }),
    ).not.toThrow();

    // Chặn tuyệt đối nếu vô tình lọt `id` nội bộ hoặc `apiKey` / `secret`.
    expect(() =>
      assertRealtimePayloadSafe({
        id: '0195a000-0000-7000-8000-000000000050',
        callPublicId: CALL_PUBLIC_ID,
        type: 'offer',
        sdp: 'v=0',
      }),
    ).toThrow();
    expect(() =>
      assertRealtimePayloadSafe({
        callPublicId: CALL_PUBLIC_ID,
        apiKey: 'leaked-key',
      }),
    ).toThrow();
  });
});

describe('Unit M12: PeerCallEngine (đệm Offer/ICE sớm, tái đàm phán & giải phóng track) và call_event UI', () => {
  it('đệm offer & ice-candidate đến sớm trước khi bấm Trả lời, xả đúng thứ tự sau init và giải phóng sạch track khi destroy()', async () => {
    const sentSignals: CallSignalPayload[] = [];
    const appliedRemoteDescriptions: RTCSessionDescriptionInit[] = [];
    const addedIceCandidates: RTCIceCandidateInit[] = [];
    const closeSpy = vi.fn();
    const stopTrackSpy = vi.fn();

    const fakePc = {
      signalingState: 'stable' as RTCSignalingState,
      connectionState: 'new' as RTCPeerConnectionState,
      localDescription: null as RTCSessionDescriptionInit | null,
      remoteDescription: null as RTCSessionDescriptionInit | null,
      onicecandidate: null,
      ontrack: null,
      onconnectionstatechange: null,
      addTrack: vi.fn(),
      getSenders: vi.fn(() => []),
      setRemoteDescription: vi.fn(async (desc: RTCSessionDescriptionInit) => {
        fakePc.remoteDescription = desc;
        appliedRemoteDescriptions.push(desc);
      }),
      createAnswer: vi.fn(async () => ({ type: 'answer' as const, sdp: 'v=0\r\ns=answer' })),
      createOffer: vi.fn(async () => ({ type: 'offer' as const, sdp: 'v=0\r\ns=reneg-offer' })),
      setLocalDescription: vi.fn(async (desc: RTCSessionDescriptionInit) => {
        fakePc.localDescription = desc;
      }),
      addIceCandidate: vi.fn(async (cand: RTCIceCandidateInit) => {
        addedIceCandidates.push(cand);
      }),
      close: closeSpy,
    };

    const fakeLocalStream = {
      getTracks: () => [{ id: 't1', kind: 'audio', enabled: true, stop: stopTrackSpy }],
      getAudioTracks: () => [{ id: 't1', kind: 'audio', enabled: true, stop: stopTrackSpy }],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    const engine = new PeerCallEngine({
      isCaller: false,
      peerConnectionFactory: () => fakePc as unknown as RTCPeerConnection,
      callbacks: {
        onSendSignal: async (sig) => {
          sentSignals.push(sig);
        },
        onLocalStreamChanged: () => undefined,
        onRemoteStreamChanged: () => undefined,
        onConnectionStateChanged: () => undefined,
      },
    });

    // Nhận sớm offer và 2 ice-candidate TRƯỚC khi bấm Trả lời (PC chưa khởi tạo).
    await engine.handleRemoteSignal({
      type: 'ice-candidate',
      candidate: 'candidate:early-1',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    await engine.handleRemoteSignal({
      type: 'offer',
      sdp: 'v=0\r\ns=early-offer',
    });
    await engine.handleRemoteSignal({
      type: 'ice-candidate',
      candidate: 'candidate:early-2',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });

    expect(engine.getPendingOfferCount()).toBe(1);
    expect(engine.getPendingIceCandidateCount()).toBe(2);

    // Người nhận bấm Trả lời -> gắn stream, khởi tạo PC và xả hàng đợi!
    engine.setLocalStream(fakeLocalStream);
    engine.initializePeerConnection(PUBLIC_STUN_ICE_SERVERS);
    await engine.flushPendingSignalsAfterInit();

    expect(appliedRemoteDescriptions).toEqual([{ type: 'offer', sdp: 'v=0\r\ns=early-offer' }]);
    expect(addedIceCandidates.map((c) => c.candidate)).toEqual([
      'candidate:early-1',
      'candidate:early-2',
    ]);
    expect(sentSignals).toEqual([{ type: 'answer', sdp: 'v=0\r\ns=answer' }]);

    // Giải phóng toàn bộ tài nguyên khi kết thúc cuộc gọi.
    engine.destroy();
    expect(stopTrackSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('hiển thị nhãn tiếng Việt tự nhiên cho thẻ lịch sử call_event và dòng xem trước hội thoại kể cả chưa nhập mã PIN', () => {
    expect(
      formatCallEventLabel({
        callPublicId: CALL_PUBLIC_ID,
        callType: 'video',
        status: 'ended',
        callerPublicId: USER_A_PUBLIC_ID,
        durationSeconds: 252,
      }),
    ).toBe('Cuộc gọi video · 04:12');

    expect(
      formatCallEventLabel({
        callPublicId: CALL_PUBLIC_ID,
        callType: 'audio',
        status: 'ended',
        callerPublicId: USER_A_PUBLIC_ID,
        durationSeconds: 65,
      }),
    ).toBe('Cuộc gọi thoại · 01:05');

    expect(
      formatCallEventLabel({
        callPublicId: CALL_PUBLIC_ID,
        callType: 'audio',
        status: 'missed',
        callerPublicId: USER_A_PUBLIC_ID,
        durationSeconds: null,
      }),
    ).toBe('Cuộc gọi nhỡ');

    const preview = getConversationPreviewText(
      {
        public_id: '55555555-5555-4555-8555-555555555555',
        conversationPublicId: CONV_PUBLIC_ID,
        senderPublicId: USER_A_PUBLIC_ID,
        isOwnMessage: true,
        seq: 4,
        clientMsgId: `call_event:${CALL_PUBLIC_ID}`,
        messageType: 'call_event',
        ciphertext: null,
        cryptoHeader: null,
        callEventMeta: {
          callPublicId: CALL_PUBLIC_ID,
          callType: 'video',
          status: 'ended',
          callerPublicId: USER_A_PUBLIC_ID,
          durationSeconds: 252,
        },
        editCount: 0,
        editedAt: null,
        recalledAt: null,
        createdAt: '2026-11-24T12:00:00.000Z',
      },
      undefined,
      true, // ngay cả khi cờ decryptionFailed được truyền nhầm, call_event vẫn luôn hiển thị bình thường!
    );
    expect(preview).toBe('Cuộc gọi video · 04:12');
  });
});

function collectTsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'api') {
        continue;
      }
      collectTsxFiles(full, acc);
    } else if (entry.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('Guard M12: 0% thuật ngữ kỹ thuật trên UI & Ghim commit SHA trong CI', () => {
  it('toàn bộ component giao diện trong src/app và src/components không chứa thuật ngữ kỹ thuật hay nhãn cột mốc/dev hiển thị cho người dùng', () => {
    const files = [
      ...collectTsxFiles(join(process.cwd(), 'src/app')),
      ...collectTsxFiles(join(process.cwd(), 'src/components')),
    ];
    expect(files.length).toBeGreaterThan(20);

    const forbiddenUiJargonRegex =
      /\b(?:E2EE|WebRTC|AES-256|AES-GCM|ECDH|ECDSA|HKDF|PBKDF2|BOLA|IDOR|RLS|Drizzle|DTLS|SRTP|Metered|STUN|TURN|Ably|Redis|JWT|CSRF|IndexedDB|Milestone)\b|Giai đoạn\s*[123]|Cột mốc\s*M\d+/;

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const trimmed = line.trim();
        // Bỏ qua dòng chú thích code và import đường dẫn nội bộ.
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('/*') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('import ') ||
          trimmed.startsWith('} from ') ||
          trimmed.includes('/api/v1/e2ee')
        ) {
          continue;
        }
        // Kiểm tra nội dung nằm trong JSX text (>...<) hoặc chuỗi nhãn người dùng (aria-label / title / placeholder).
        const jsxTextMatches = line.match(/>[^<>{]+</g) ?? [];
        const uiAttrMatches =
          line.match(/(?:aria-label|title|placeholder|description|label)=["'][^"']+["']/g) ?? [];
        for (const snippet of [...jsxTextMatches, ...uiAttrMatches]) {
          expect(
            forbiddenUiJargonRegex.test(snippet),
            `Phát hiện thuật ngữ kỹ thuật hiển thị trên UI tại ${filePath}:${i + 1} -> ${snippet}`,
          ).toBe(false);
        }
      }
    }
  });

  it('.github/workflows/ci.yml ghim 100% GitHub Actions theo commit SHA 40 ký tự, dùng npm ci và chạy gitleaks', () => {
    const ciYaml = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const usesLines = ciYaml
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('uses:'));

    expect(usesLines.length).toBeGreaterThanOrEqual(4);
    for (const usesLine of usesLines) {
      expect(usesLine, `Action chưa được ghim theo commit SHA 40 ký tự: ${usesLine}`).toMatch(
        /^uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}(?:\s+#.*)?$/,
      );
    }
    expect(ciYaml).toContain('npm ci');
    expect(ciYaml).toContain('gitleaks detect');
  });
});
