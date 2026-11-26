import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_LRU_CACHED_CONVERSATION_THREADS,
  clearChatRamMemorySingleton,
  getChatRamCacheEpoch,
  getOrInitUserChatRamCache,
  putLruConversationThreadCache,
  putLruMediaObjectUrlCache,
  type CachedConversationThreadState,
  type DecryptedMediaObjectUrlCacheEntry,
  type DecryptedMessageViewItem,
} from '@/components/messages/chat-store-context';
import {
  clearE2eeClientBootstrapState,
  clearMemoryKeystoreForTesting,
  decryptDirectMessage,
  encryptDirectMessage,
  getDeviceKeyMaterialByFingerprint,
  getOrCreatePrimaryDeviceKeyMaterial,
  getPrimaryDeviceKeyMaterial,
  listLocalDeviceKeyMaterials,
} from '@/lib/e2ee';
import { PeerCallEngine, type CallSignalPayload } from '@/lib/webrtc/call-engine';

interface FakeTrack {
  readonly id: string;
  readonly kind: 'audio' | 'video';
  enabled: boolean;
  readyState: 'live' | 'ended';
  stopCalls: number;
  stop: () => void;
}

function createFakeTrack(kind: 'audio' | 'video', id: string): FakeTrack {
  const track: FakeTrack = {
    id,
    kind,
    enabled: true,
    readyState: 'live',
    stopCalls: 0,
    stop() {
      track.stopCalls += 1;
      track.readyState = 'ended';
    },
  };
  return track;
}

class FakeMediaStream {
  private tracks: FakeTrack[];

  constructor(initialTracks: readonly FakeTrack[] = []) {
    this.tracks = [...initialTracks];
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  addTrack(track: FakeTrack): void {
    if (!this.tracks.includes(track)) {
      this.tracks.push(track);
    }
  }

  removeTrack(track: FakeTrack): void {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

describe('Phase 2 System & UI Audit Optimizations — Unit Guards', () => {
  const originalMediaStream = globalThis.MediaStream;
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const originalRevokeObjectUrl = globalThis.URL?.revokeObjectURL;

  afterEach(() => {
    clearChatRamMemorySingleton();
    clearE2eeClientBootstrapState();
    clearMemoryKeystoreForTesting();

    if (originalMediaStream) {
      globalThis.MediaStream = originalMediaStream;
    } else {
      Reflect.deleteProperty(globalThis, 'MediaStream');
    }

    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }

    if (originalIndexedDbDescriptor) {
      Object.defineProperty(globalThis, 'indexedDB', originalIndexedDbDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'indexedDB');
    }

    if (globalThis.URL && originalRevokeObjectUrl) {
      globalThis.URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it('[P0-2] PeerCallEngine.setCameraEnabled(false) gọi replaceTrack(null) + stop() để tắt đèn LED, bảo toàn audio track và tái gắn mượt khi bật lại', async () => {
    globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;

    const initialAudioTrack = createFakeTrack('audio', 'aud-1');
    const initialVideoTrack = createFakeTrack('video', 'vid-1');
    const reopenedVideoTrack = createFakeTrack('video', 'vid-2');

    const getUserMediaCalls: MediaStreamConstraints[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
            getUserMediaCalls.push(constraints);
            return new FakeMediaStream([reopenedVideoTrack]) as unknown as MediaStream;
          }),
        },
      },
    });

    const replaceTrackCalls: Array<MediaStreamTrack | null> = [];
    const senders: Array<{
      track: MediaStreamTrack | null;
      replaceTrack: (next: MediaStreamTrack | null) => Promise<void>;
    }> = [];
    const transceivers: Array<{
      direction: RTCRtpTransceiverDirection;
      sender: {
        track: MediaStreamTrack | null;
        replaceTrack: (next: MediaStreamTrack | null) => Promise<void>;
      };
      receiver: { track: { kind: string } };
    }> = [];

    let offerCounter = 0;
    const sentSignals: CallSignalPayload[] = [];
    const localStreamSnapshots: Array<MediaStream | null> = [];

    const fakePc = {
      signalingState: 'stable' as RTCSignalingState,
      onicecandidate: null,
      ontrack: null,
      onconnectionstatechange: null,
      addTrack(track: MediaStreamTrack) {
        const sender: {
          track: MediaStreamTrack | null;
          replaceTrack: (next: MediaStreamTrack | null) => Promise<void>;
        } = {
          track,
          async replaceTrack(next: MediaStreamTrack | null) {
            replaceTrackCalls.push(next);
            sender.track = next;
          },
        };
        senders.push(sender);
        transceivers.push({
          direction: 'sendrecv',
          sender,
          receiver: { track: { kind: track.kind } },
        });
        return sender as unknown as RTCRtpSender;
      },
      getSenders() {
        return senders as unknown as RTCRtpSender[];
      },
      getTransceivers() {
        return transceivers as unknown as RTCRtpTransceiver[];
      },
      async createOffer() {
        offerCounter += 1;
        return { type: 'offer' as const, sdp: `v=0\r\na=offer-${offerCounter}\r\n` };
      },
      async setLocalDescription() {
        // no-op
      },
      close() {
        // no-op
      },
    };

    const engine = new PeerCallEngine({
      isCaller: true,
      peerConnectionFactory: () => fakePc as unknown as RTCPeerConnection,
      callbacks: {
        onSendSignal: async (signal) => {
          sentSignals.push(signal);
        },
        onLocalStreamChanged: (stream) => {
          localStreamSnapshots.push(stream);
        },
        onRemoteStreamChanged: () => undefined,
        onConnectionStateChanged: () => undefined,
      },
    });

    const initialStream = new FakeMediaStream([
      initialAudioTrack,
      initialVideoTrack,
    ]) as unknown as MediaStream;
    engine.setLocalStream(initialStream);
    engine.initializePeerConnection([{ urls: 'stun:stun.tomato.local:3478' }]);

    // 1. Tắt camera: phải giải phóng phần cứng video, KHÔNG dừng audio, chuyển transceiver sang `recvonly` + gửi SDP offer.
    const disableRes = await engine.setCameraEnabled(false);
    expect(disableRes).toEqual({ enabled: false });
    expect(replaceTrackCalls).toEqual([null]);
    expect(initialVideoTrack.stopCalls).toBe(1);
    expect(initialVideoTrack.readyState).toBe('ended');
    expect(initialAudioTrack.stopCalls).toBe(0);
    expect(initialAudioTrack.readyState).toBe('live');

    const videoTransceiver = transceivers.find((t) => t.receiver.track.kind === 'video');
    expect(videoTransceiver?.direction).toBe('recvonly');
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.type).toBe('offer');
    expect(engine.getLocalStream()?.getVideoTracks()).toHaveLength(0);
    expect(engine.getLocalStream()?.getAudioTracks()).toHaveLength(1);

    // 2. Bật lại camera: chỉ xin video (audio: false), gắn lại qua replaceTrack(reopenedVideoTrack), khôi phục `sendrecv` + gửi SDP offer.
    const enableRes = await engine.setCameraEnabled(true);
    expect(enableRes).toEqual({ enabled: true });
    expect(getUserMediaCalls).toHaveLength(1);
    expect(getUserMediaCalls[0]?.audio).toBe(false);
    expect(replaceTrackCalls).toEqual([null, reopenedVideoTrack as unknown as MediaStreamTrack]);
    expect(videoTransceiver?.direction).toBe('sendrecv');
    expect(sentSignals).toHaveLength(2);
    expect(initialAudioTrack.stopCalls).toBe(0);
    expect(initialAudioTrack.readyState).toBe('live');
    expect(engine.getLocalStream()?.getVideoTracks()).toHaveLength(1);
    expect(engine.getLocalStream()?.getAudioTracks()).toHaveLength(1);

    engine.destroy();
    expect(initialAudioTrack.stopCalls).toBe(1);
    expect(reopenedVideoTrack.stopCalls).toBe(1);
  });

  it('[P0-3 & P1-6] Epoch phiên Chat RAM tăng đơn điệu khi đăng xuất/đổi user và LRU eviction thu hồi đầy đủ ObjectURL + localPreviewUrl', () => {
    const revokedUrls: string[] = [];
    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });

    const epoch0 = getChatRamCacheEpoch();
    const userACache = getOrInitUserChatRamCache('usr_alpha_01');
    expect(getChatRamCacheEpoch()).toBe(epoch0);

    const threadsMap = userACache.threadsByConvId;
    const mediaMap = userACache.mediaObjectUrlsByMsgId;

    const buildDummyThread = (
      convId: string,
      lastAccessedAt: number,
      previewUrl?: string,
    ): CachedConversationThreadState => ({
      conversationPublicId: convId,
      items: previewUrl
        ? [
            {
              dto: {
                public_id: `msg_${convId}`,
                conversationPublicId: convId,
                senderPublicId: 'usr_alpha_01',
                seq: 1,
                messageType: 'image',
                ciphertext: '',
                cryptoHeader: null,
                replyTo: null,
                isForwarded: false,
                reactions: [],
                isPinned: false,
                editCount: 0,
                editedAt: null,
                recalledAt: null,
                createdAt: new Date(lastAccessedAt).toISOString(),
              },
              plaintext: '',
              decryptionFailed: false,
              localPreviewUrl: previewUrl,
            } as unknown as DecryptedMessageViewItem,
          ]
        : [],
      nextBeforeSeq: null,
      highestSeq: 1,
      hasInitialized: true,
      loadingInitial: false,
      loadingOlder: false,
      lastAccessedAt,
    });

    // Chèn vượt ngưỡng MAX_LRU_CACHED_CONVERSATION_THREADS (10 -> chèn 11 hội thoại).
    for (let i = 1; i <= MAX_LRU_CACHED_CONVERSATION_THREADS + 1; i += 1) {
      const convId = `conv_${String(i).padStart(2, '0')}`;
      const mediaEntry: DecryptedMediaObjectUrlCacheEntry = {
        messagePublicId: `msg_${convId}`,
        conversationPublicId: convId,
        objectUrl: `blob:tomato-media-${convId}`,
        mimeType: 'image/webp',
      };
      putLruMediaObjectUrlCache(mediaMap, mediaEntry);
      putLruConversationThreadCache(
        threadsMap,
        convId,
        buildDummyThread(convId, 1_000 + i * 10, `blob:tomato-preview-${convId}`),
        mediaMap,
      );
    }

    // Hội thoại cũ nhất `conv_01` bị đuổi khỏi LRU -> cả `localPreviewUrl` và `mediaObjectUrlsByMsgId` của `conv_01` phải được revoke ngay!
    expect(threadsMap.size).toBe(MAX_LRU_CACHED_CONVERSATION_THREADS);
    expect(threadsMap.has('conv_01')).toBe(false);
    expect(mediaMap.has('msg_conv_01')).toBe(false);
    expect(revokedUrls).toContain('blob:tomato-preview-conv_01');
    expect(revokedUrls).toContain('blob:tomato-media-conv_01');

    // Chuyển sang tài khoản khác -> tự động gọi clearChatRamMemorySingleton(), tăng epoch và revoke sạch 10 hội thoại còn lại.
    getOrInitUserChatRamCache('usr_bravo_02');
    expect(getChatRamCacheEpoch()).toBe(epoch0 + 1);
    expect(revokedUrls).toContain('blob:tomato-preview-conv_11');
    expect(revokedUrls).toContain('blob:tomato-media-conv_11');

    clearChatRamMemorySingleton();
    expect(getChatRamCacheEpoch()).toBe(epoch0 + 2);
  });

  it('[P1-4] Keystore tái sử dụng kết nối IndexedDB đơn nhất + read-through RAM cache, và dọn sạch cache WebCrypto khi đăng xuất', async () => {
    const idbBackingMap = new Map<string, unknown>();
    let openCalls = 0;
    let idbGetCalls = 0;
    let idbPutCalls = 0;

    const fakeDb = {
      onversionchange: null,
      onclose: null,
      objectStoreNames: {
        contains: () => true,
      },
      createObjectStore: () => ({}),
      close: () => undefined,
      transaction: () => ({
        objectStore: () => ({
          get(key: string) {
            idbGetCalls += 1;
            const req: {
              result: unknown;
              error: Error | null;
              onsuccess: (() => void) | null;
              onerror: (() => void) | null;
            } = {
              result: idbBackingMap.get(key),
              error: null,
              onsuccess: null,
              onerror: null,
            };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          },
          put(value: unknown, key: string) {
            idbPutCalls += 1;
            idbBackingMap.set(key, value);
            const req: {
              error: Error | null;
              onsuccess: (() => void) | null;
              onerror: (() => void) | null;
            } = {
              error: null,
              onsuccess: null,
              onerror: null,
            };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          },
        }),
      }),
    };

    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open: vi.fn(() => {
          openCalls += 1;
          const req: {
            result: typeof fakeDb;
            error: Error | null;
            onupgradeneeded: (() => void) | null;
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
          } = {
            result: fakeDb,
            error: null,
            onupgradeneeded: null,
            onsuccess: null,
            onerror: null,
          };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        }),
      },
    });

    clearE2eeClientBootstrapState();

    const aliceMat = await getOrCreatePrimaryDeviceKeyMaterial('usr_alice_idb');
    const bobMat = await getOrCreatePrimaryDeviceKeyMaterial('usr_bob_idb');

    // Kết nối IndexedDB chỉ mở đúng 1 lần duy nhất cho toàn phiên dù lưu khóa nhiều lần.
    expect(openCalls).toBe(1);
    expect(idbPutCalls).toBeGreaterThanOrEqual(4);

    // Các lần đọc tiếp theo đi thẳng qua read-through memoryKeystore (0 giao dịch IndexedDB mới).
    const getCallsBeforeReads = idbGetCalls;
    const readPrimary = await getPrimaryDeviceKeyMaterial('usr_alice_idb');
    const readByFp = await getDeviceKeyMaterialByFingerprint(
      'usr_alice_idb',
      aliceMat.keyFingerprint,
    );
    expect(readPrimary?.keyFingerprint).toBe(aliceMat.keyFingerprint);
    expect(readByFp?.keyFingerprint).toBe(aliceMat.keyFingerprint);
    expect(idbGetCalls - getCallsBeforeReads).toBe(0);

    // Giải mã nhiều tin liên tiếp với cache khóa xác minh ECDSA hoạt động chính xác 100%.
    const localMaterials = await listLocalDeviceKeyMaterials('usr_bob_idb');
    for (let idx = 1; idx <= 3; idx += 1) {
      const encrypted = await encryptDirectMessage({
        conversationPublicId: 'conv_cache_test',
        senderPublicId: 'usr_alice_idb',
        clientMsgId: `cmsg_${idx}`,
        plaintext: `Xin chào lần ${idx}`,
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
      const decrypted = await decryptDirectMessage({
        conversationPublicId: 'conv_cache_test',
        senderPublicId: 'usr_alice_idb',
        clientMsgId: `cmsg_${idx}`,
        ciphertext: encrypted.ciphertext,
        cryptoHeader: encrypted.cryptoHeader,
        receiverKeyMaterials: localMaterials,
        expectedSenderDevices: [
          {
            devicePublicId: aliceMat.devicePublicId,
            keyFingerprint: aliceMat.keyFingerprint,
            identityPublicKeyJwk: aliceMat.identityPublicKeyJwk,
            signingPublicKeyJwk: aliceMat.signingPublicKeyJwk,
          },
        ],
      });
      expect(decrypted.text).toBe(`Xin chào lần ${idx}`);
    }

    // Khi đăng xuất: clearE2eeClientBootstrapState xóa RAM cache, buộc lần đọc sau nạp lại từ IndexedDB trên cùng kết nối mở sẵn.
    clearE2eeClientBootstrapState();
    const getCallsAfterLogout = idbGetCalls;
    const reloaded = await getPrimaryDeviceKeyMaterial('usr_alice_idb');
    expect(reloaded?.keyFingerprint).toBe(aliceMat.keyFingerprint);
    expect(idbGetCalls).toBeGreaterThan(getCallsAfterLogout);
    expect(openCalls).toBe(1);
  });

  it('[P2-1 & P2-2] Giao diện xác thực sạch thuật ngữ nhà cung cấp và thang z-index 5 tầng nhất quán (z-[60] / z-[70])', () => {
    const turnstileSource = readFileSync(
      join(process.cwd(), 'src/components/auth/turnstile-widget.tsx'),
      'utf8',
    );
    const authMessagesSource = readFileSync(
      join(process.cwd(), 'src/modules/auth/auth.messages.ts'),
      'utf8',
    );
    expect(turnstileSource).not.toContain('Cloudflare Turnstile');
    expect(turnstileSource).not.toContain('chống bot');
    expect(authMessagesSource).not.toContain('Cloudflare');
    expect(authMessagesSource).not.toContain('Turnstile');
    expect(authMessagesSource).not.toContain('chống bot');

    const z60Files = [
      'src/components/ui/dropdown-menu.tsx',
      'src/components/ui/tooltip.tsx',
      'src/components/social/confirm-dialog.tsx',
      'src/components/messages/image-lightbox-modal.tsx',
      'src/components/messages/emoji-picker-popover.tsx',
      'src/components/messages/message-reaction-picker.tsx',
    ];
    for (const relPath of z60Files) {
      const content = readFileSync(join(process.cwd(), relPath), 'utf8');
      expect(content, `${relPath} phải dùng z-[60]`).toContain('z-[60]');
    }

    const z70Files = [
      'src/components/calls/active-call-screen.tsx',
      'src/components/calls/incoming-call-dialog.tsx',
    ];
    for (const relPath of z70Files) {
      const content = readFileSync(join(process.cwd(), relPath), 'utf8');
      expect(content, `${relPath} phải dùng z-[70]`).toContain('z-[70]');
    }
  });
});
