import type { IceServerConfigDto } from '@/core/webrtc/types';

export type CallSignalPayload =
  | {
      readonly type: 'offer';
      readonly sdp: string;
    }
  | {
      readonly type: 'answer';
      readonly sdp: string;
    }
  | {
      readonly type: 'ice-candidate';
      readonly candidate: string;
      readonly sdpMid?: string | null;
      readonly sdpMLineIndex?: number | null;
      readonly usernameFragment?: string | null;
    };

export interface CallEngineCallbacks {
  readonly onSendSignal: (signal: CallSignalPayload) => Promise<void>;
  readonly onLocalStreamChanged: (stream: MediaStream | null) => void;
  readonly onRemoteStreamChanged: (stream: MediaStream | null) => void;
  readonly onConnectionStateChanged: (state: RTCPeerConnectionState) => void;
  readonly onMediaNotice?: (message: string) => void;
}

/**
 * Dịch lỗi quyền hoặc phần cứng micro/camera sang thông báo tiếng Việt tự nhiên (0% từ kỹ thuật).
 */
export function mapMediaDeviceErrorToFriendlyVi(error: unknown, requestedVideo: boolean): string {
  const errName = error instanceof Error ? error.name : '';
  if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
    return requestedVideo
      ? 'Bạn đã từ chối quyền truy cập micro hoặc camera. Hãy bấm vào biểu tượng ổ khóa trên thanh địa chỉ trình duyệt để cấp quyền rồi thử lại.'
      : 'Bạn đã từ chối quyền truy cập micro. Hãy bấm vào biểu tượng ổ khóa trên thanh địa chỉ trình duyệt để cấp quyền rồi thử lại.';
  }
  if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
    return requestedVideo
      ? 'Không tìm thấy micro hoặc camera trên thiết bị này.'
      : 'Không tìm thấy micro trên thiết bị này.';
  }
  if (errName === 'NotReadableError' || errName === 'TrackStartError') {
    return 'Micro hoặc camera đang được sử dụng bởi một ứng dụng khác. Hãy đóng ứng dụng đó rồi thử lại.';
  }
  if (errName === 'OverconstrainedError') {
    return 'Không thể khởi động camera với chất lượng mặc định trên thiết bị này.';
  }
  if (errName === 'SecurityError') {
    return 'Trình duyệt chỉ hỗ trợ gọi thoại và gọi video qua kết nối an toàn.';
  }
  return 'Không thể kết nối với micro hoặc camera lúc này. Vui lòng thử lại.';
}

/**
 * Thu luồng micro (và camera nếu gọi video). Nếu gọi video nhưng máy không có camera
 * hoặc không mở được camera, tự động thử hạ xuống chỉ micro và trả về thông báo nhẹ nhàng.
 */
export async function acquireLocalCallMediaStream(wantVideo: boolean): Promise<{
  readonly stream: MediaStream;
  readonly hasVideo: boolean;
  readonly notice?: string;
}> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('Trình duyệt hiện tại chưa hỗ trợ gọi thoại hoặc gọi video.');
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: wantVideo
        ? {
            facingMode: 'user',
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
          }
        : false,
    });
    return {
      stream,
      hasVideo: stream.getVideoTracks().length > 0,
    };
  } catch (error) {
    const errName = error instanceof Error ? error.name : '';
    if (
      wantVideo &&
      (errName === 'NotFoundError' ||
        errName === 'DevicesNotFoundError' ||
        errName === 'OverconstrainedError' ||
        errName === 'NotReadableError')
    ) {
      // Thử fallback xuống chỉ micro để vẫn trả lời/gọi được khi máy không có webcam.
      try {
        const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        return {
          stream: audioOnlyStream,
          hasVideo: false,
          notice: 'Không tìm thấy camera trên thiết bị — cuộc gọi đang dùng âm thanh.',
        };
      } catch (audioErr) {
        throw new Error(mapMediaDeviceErrorToFriendlyVi(audioErr, false));
      }
    }

    throw new Error(mapMediaDeviceErrorToFriendlyVi(error, wantVideo));
  }
}

export function stopAllMediaStreamTracks(stream: MediaStream | null | undefined): void {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Bỏ qua nếu track đã dừng trước đó.
    }
  }
}

/**
 * Engine quản lý kết nối cuộc gọi P2P (`RTCPeerConnection` với mã hóa bắt buộc DTLS-SRTP):
 * - Đệm (queue) toàn bộ `offer` và `ice-candidate` đến sớm (trước khi bấm Trả lời / trước `setRemoteDescription`),
 *   sau đó xả hàng đợi theo đúng thứ tự.
 * - Hỗ trợ tái đàm phán (renegotiation) an toàn (polite/impolite) khi nâng cấp từ gọi thoại lên video
 *   hoặc bật/tắt camera ngay trong lúc cuộc gọi đang diễn ra (`connected`).
 * - Giải phóng triệt để mọi `MediaStreamTrack` và đóng `RTCPeerConnection` khi kết thúc.
 */
export class PeerCallEngine {
  private readonly isPolite: boolean;
  private readonly callbacks: CallEngineCallbacks;
  private readonly peerConnectionFactory: (config: RTCConfiguration) => RTCPeerConnection;

  private pc: RTCPeerConnection | null = null;
  private videoSender: RTCRtpSender | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingOffers: string[] = [];
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private destroyed = false;

  constructor(options: {
    readonly isCaller: boolean;
    readonly callbacks: CallEngineCallbacks;
    readonly peerConnectionFactory?: (config: RTCConfiguration) => RTCPeerConnection;
  }) {
    // Người nhận (callee) đóng vai trò `polite` để tự động nhường khi xảy ra va chạm glare lúc nâng cấp video.
    this.isPolite = !options.isCaller;
    this.callbacks = options.callbacks;
    this.peerConnectionFactory =
      options.peerConnectionFactory ?? ((config) => new RTCPeerConnection(config));
  }

  isInitialized(): boolean {
    return this.pc !== null && !this.destroyed;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  getPendingOfferCount(): number {
    return this.pendingOffers.length;
  }

  getPendingIceCandidateCount(): number {
    return this.pendingIceCandidates.length;
  }

  setLocalStream(stream: MediaStream): void {
    if (this.destroyed) {
      stopAllMediaStreamTracks(stream);
      return;
    }
    this.localStream = stream;
    this.callbacks.onLocalStreamChanged(stream);
  }

  initializePeerConnection(iceServers: readonly IceServerConfigDto[]): void {
    if (this.destroyed || this.pc) {
      return;
    }

    const rtcIceServers: RTCIceServer[] = iceServers.map((server) => ({
      urls: typeof server.urls === 'string' ? server.urls : [...server.urls],
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    }));

    const pc = this.peerConnectionFactory({
      iceServers: rtcIceServers,
      iceCandidatePoolSize: 4,
    });
    this.pc = pc;

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        const sender = pc.addTrack(track, this.localStream);
        if (track.kind === 'video') {
          this.videoSender = sender;
        }
      }
    }

    pc.onicecandidate = (event) => {
      if (this.destroyed || !event.candidate) {
        return;
      }
      const candidateInit =
        typeof event.candidate.toJSON === 'function'
          ? event.candidate.toJSON()
          : {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            };

      if (!candidateInit.candidate) {
        return;
      }

      void this.callbacks
        .onSendSignal({
          type: 'ice-candidate',
          candidate: candidateInit.candidate,
          sdpMid: candidateInit.sdpMid ?? null,
          sdpMLineIndex:
            typeof candidateInit.sdpMLineIndex === 'number' ? candidateInit.sdpMLineIndex : null,
          usernameFragment: candidateInit.usernameFragment ?? null,
        })
        .catch(() => undefined);
    };

    pc.ontrack = (event) => {
      if (this.destroyed) {
        return;
      }
      if (!this.remoteStream && typeof MediaStream !== 'undefined') {
        this.remoteStream = new MediaStream();
      }
      if (event.streams && event.streams[0]) {
        const incomingStream = event.streams[0];
        if (!this.remoteStream) {
          this.remoteStream = incomingStream;
        } else {
          for (const track of incomingStream.getTracks()) {
            const exists = this.remoteStream.getTracks().some((t) => t.id === track.id);
            if (!exists) {
              this.remoteStream.addTrack(track);
            }
          }
        }
      } else if (event.track && this.remoteStream) {
        const exists = this.remoteStream.getTracks().some((t) => t.id === event.track.id);
        if (!exists) {
          this.remoteStream.addTrack(event.track);
        }
      }

      if (this.remoteStream) {
        // Tạo tham chiếu MediaStream mới chứa đúng tập track hiện tại để React cập nhật UI video mượt mà.
        const snapshot =
          typeof MediaStream !== 'undefined'
            ? new MediaStream(this.remoteStream.getTracks())
            : this.remoteStream;
        this.remoteStream = snapshot;
        this.callbacks.onRemoteStreamChanged(snapshot);
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.destroyed) {
        return;
      }
      this.callbacks.onConnectionStateChanged(pc.connectionState);
    };
  }

  /**
   * Tạo và gửi SDP Offer (dùng cho bước thiết lập ban đầu lẫn tái đàm phán nâng cấp thoại -> video).
   */
  async createAndSendOffer(options?: { readonly iceRestart?: boolean }): Promise<void> {
    if (this.destroyed || !this.pc) {
      return;
    }

    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        ...(options?.iceRestart ? { iceRestart: true } : {}),
      });
      if (this.destroyed || !this.pc) {
        return;
      }
      await this.pc.setLocalDescription(offer);
      const localSdp = this.pc.localDescription?.sdp ?? offer.sdp;
      if (localSdp) {
        await this.callbacks.onSendSignal({
          type: 'offer',
          sdp: localSdp,
        });
      }
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * Nhận tín hiệu từ đối phương:
   * - Nếu `RTCPeerConnection` chưa sẵn sàng (nhận sớm khi đang `ringing`), đệm toàn bộ vào hàng đợi.
   * - Nếu đã sẵn sàng, xử lý ngay theo đúng chuẩn polite/impolite và tự xả hàng đợi ICE sau `setRemoteDescription`.
   */
  async handleRemoteSignal(signal: CallSignalPayload): Promise<void> {
    if (this.destroyed) {
      return;
    }

    if (signal.type === 'ice-candidate') {
      const init: RTCIceCandidateInit = {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid ?? undefined,
        sdpMLineIndex: signal.sdpMLineIndex ?? undefined,
        usernameFragment: signal.usernameFragment ?? undefined,
      };
      if (!this.pc || !this.pc.remoteDescription) {
        this.pendingIceCandidates.push(init);
        return;
      }
      await this.safeAddIceCandidate(init);
      return;
    }

    if (signal.type === 'offer') {
      if (!this.pc) {
        // Giữ tối đa offer mới nhất nếu nhận sớm trước khi bấm Trả lời.
        this.pendingOffers = [signal.sdp];
        return;
      }
      await this.applyRemoteOfferAndAnswer(signal.sdp);
      return;
    }

    if (signal.type === 'answer') {
      if (!this.pc) {
        return;
      }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      await this.flushPendingIceCandidates();
    }
  }

  /**
   * Xả toàn bộ `offer` và `ice-candidate` đã đệm từ sớm theo đúng thứ tự
   * ngay sau khi `initializePeerConnection()` hoàn tất (ví dụ khi người nhận vừa bấm Trả lời).
   */
  async flushPendingSignalsAfterInit(): Promise<void> {
    if (this.destroyed || !this.pc) {
      return;
    }

    while (this.pendingOffers.length > 0 && !this.destroyed && this.pc) {
      const nextOfferSdp = this.pendingOffers.shift();
      if (nextOfferSdp) {
        await this.applyRemoteOfferAndAnswer(nextOfferSdp);
      }
    }

    if (this.pc?.remoteDescription) {
      await this.flushPendingIceCandidates();
    }
  }

  private async applyRemoteOfferAndAnswer(sdp: string): Promise<void> {
    if (this.destroyed || !this.pc) {
      return;
    }

    const offerCollision = this.makingOffer || this.pc.signalingState !== 'stable';
    this.ignoreOffer = !this.isPolite && offerCollision;
    if (this.ignoreOffer) {
      return;
    }

    if (offerCollision && this.pc.signalingState !== 'stable') {
      try {
        await this.pc.setLocalDescription({ type: 'rollback' });
      } catch {
        // Một số trình duyệt không cần rollback tường minh trước khi nhận offer mới.
      }
    }

    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flushPendingIceCandidates();

    if (this.destroyed || !this.pc) {
      return;
    }

    const answer = await this.pc.createAnswer();
    if (this.destroyed || !this.pc) {
      return;
    }
    await this.pc.setLocalDescription(answer);
    const localSdp = this.pc.localDescription?.sdp ?? answer.sdp;
    if (localSdp) {
      await this.callbacks.onSendSignal({
        type: 'answer',
        sdp: localSdp,
      });
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (this.destroyed || !this.pc || !this.pc.remoteDescription) {
      return;
    }
    const queue = this.pendingIceCandidates.splice(0, this.pendingIceCandidates.length);
    for (const candidate of queue) {
      if (this.destroyed || !this.pc) {
        break;
      }
      await this.safeAddIceCandidate(candidate);
    }
  }

  private async safeAddIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || this.destroyed) {
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // Bỏ qua candidate cũ/hết hạn trong lúc chuyển mạng hoặc đóng kết nối.
    }
  }

  setMicrophoneMuted(muted: boolean): boolean {
    if (!this.localStream) {
      return muted;
    }
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
    return muted;
  }

  private findVideoSender(): RTCRtpSender | null {
    if (!this.pc) {
      return null;
    }
    if (this.videoSender && this.pc.getSenders().includes(this.videoSender)) {
      return this.videoSender;
    }
    const activeVideoSender = this.pc.getSenders().find((sender) => sender.track?.kind === 'video');
    if (activeVideoSender) {
      this.videoSender = activeVideoSender;
      return activeVideoSender;
    }
    if (typeof this.pc.getTransceivers === 'function') {
      const videoTransceiver = this.pc
        .getTransceivers()
        .find((t) => t.receiver?.track?.kind === 'video' && Boolean(t.sender));
      if (videoTransceiver?.sender) {
        this.videoSender = videoTransceiver.sender;
        return videoTransceiver.sender;
      }
    }
    return this.videoSender;
  }

  /**
   * Bật/tắt camera trong lúc đang gọi:
   * - Khi tắt camera (`enable = false`): gọi `sender.replaceTrack(null)` + `track.stop()` để tắt ngay đèn LED phần cứng,
   *   tuyệt đối không chạm tới audio track, và gửi tín hiệu cập nhật chiều `recvonly` để máy đối phương chuyển mượt về avatar (0 khung hình đơ/đen).
   * - Khi bật lại camera (`enable = true`): cấp track video mới, gắn lại qua `replaceTrack` (hoặc `addTrack` nếu nâng cấp từ gọi thoại)
   *   và khôi phục chiều `sendrecv` mượt mà.
   */
  async setCameraEnabled(enable: boolean): Promise<{
    readonly enabled: boolean;
    readonly errorMessage?: string;
  }> {
    if (this.destroyed) {
      return { enabled: false };
    }

    const existingVideoTracks = this.localStream?.getVideoTracks() ?? [];
    if (!enable) {
      const sender = this.findVideoSender();
      if (sender) {
        try {
          await sender.replaceTrack(null);
        } catch {
          // Bỏ qua nếu kết nối đang đóng.
        }
      }

      for (const track of existingVideoTracks) {
        track.enabled = false;
        try {
          track.stop();
        } catch {
          // Bỏ qua nếu track đã dừng trước đó.
        }
        this.localStream?.removeTrack(track);
      }

      if (this.localStream && typeof MediaStream !== 'undefined') {
        const refreshed = new MediaStream(this.localStream.getTracks());
        this.localStream = refreshed;
        this.callbacks.onLocalStreamChanged(refreshed);
      }

      if (this.pc && sender && typeof this.pc.getTransceivers === 'function') {
        const transceiver = this.pc.getTransceivers().find((t) => t.sender === sender);
        if (
          transceiver &&
          (transceiver.direction === 'sendrecv' || transceiver.direction === 'sendonly')
        ) {
          transceiver.direction = transceiver.direction === 'sendonly' ? 'inactive' : 'recvonly';
          if (this.pc.signalingState === 'stable') {
            await this.createAndSendOffer();
          }
        }
      }

      return { enabled: false };
    }

    if (
      existingVideoTracks.length > 0 &&
      existingVideoTracks.some((t) => t.readyState === 'live')
    ) {
      for (const track of existingVideoTracks) {
        track.enabled = true;
      }
      if (this.localStream && typeof MediaStream !== 'undefined') {
        const refreshed = new MediaStream(this.localStream.getTracks());
        this.localStream = refreshed;
        this.callbacks.onLocalStreamChanged(refreshed);
      }
      return { enabled: true };
    }

    // Nâng cấp từ gọi thoại -> gọi video hoặc bật lại camera sau khi đã dừng phần cứng.
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      return {
        enabled: false,
        errorMessage: 'Thiết bị hiện tại không hỗ trợ bật camera.',
      };
    }

    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
        },
        audio: false,
      });

      const newVideoTrack = videoStream.getVideoTracks()[0];
      if (!newVideoTrack || this.destroyed) {
        stopAllMediaStreamTracks(videoStream);
        return { enabled: false };
      }

      if (!this.localStream && typeof MediaStream !== 'undefined') {
        this.localStream = new MediaStream();
      }
      if (this.localStream) {
        // Chỉ loại bỏ các video track cũ đã ended, tuyệt đối giữ nguyên audio track đang nói chuyện.
        for (const oldTrack of this.localStream.getVideoTracks()) {
          oldTrack.stop();
          this.localStream.removeTrack(oldTrack);
        }
        this.localStream.addTrack(newVideoTrack);
        const refreshed =
          typeof MediaStream !== 'undefined'
            ? new MediaStream(this.localStream.getTracks())
            : this.localStream;
        this.localStream = refreshed;
        this.callbacks.onLocalStreamChanged(refreshed);
      }

      if (this.pc) {
        const existingVideoSender = this.findVideoSender();
        if (existingVideoSender) {
          this.videoSender = existingVideoSender;
          await existingVideoSender.replaceTrack(newVideoTrack);
          if (typeof this.pc.getTransceivers === 'function') {
            const transceiver = this.pc
              .getTransceivers()
              .find((t) => t.sender === existingVideoSender);
            if (
              transceiver &&
              (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive')
            ) {
              transceiver.direction =
                transceiver.direction === 'inactive' ? 'sendonly' : 'sendrecv';
              if (this.pc.signalingState === 'stable') {
                await this.createAndSendOffer();
              }
            }
          }
        } else if (this.localStream) {
          this.videoSender = this.pc.addTrack(newVideoTrack, this.localStream);
          await this.createAndSendOffer();
        }
      }

      return { enabled: true };
    } catch (error) {
      return {
        enabled: false,
        errorMessage: mapMediaDeviceErrorToFriendlyVi(error, true),
      };
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.videoSender = null;
    this.pendingOffers = [];
    this.pendingIceCandidates = [];

    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        // Bỏ qua lỗi khi đóng peer connection.
      }
      this.pc = null;
    }
    this.videoSender = null;

    stopAllMediaStreamTracks(this.localStream);
    stopAllMediaStreamTracks(this.remoteStream);
    this.localStream = null;
    this.remoteStream = null;

    this.callbacks.onLocalStreamChanged(null);
    this.callbacks.onRemoteStreamChanged(null);
  }
}
