export interface IceServerConfigDto {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/**
 * DTO allowlist trả về từ `POST /api/v1/calls/ice-servers`.
 * Tuyệt đối chỉ chứa `iceServers` đã làm sạch (`urls`, `username`, `credential`) và `ttlSeconds`;
 * không bao giờ lộ `apiKey`, `secretKey` hay chi tiết cấu hình nội bộ.
 */
export interface IceServersResponseDto {
  readonly iceServers: readonly IceServerConfigDto[];
  readonly ttlSeconds: number;
}

export type TurnCredentialSource = 'metered_ephemeral' | 'metered_api_key' | 'stun_fallback';

export interface TurnCredentialFetchResult {
  readonly iceServers: readonly IceServerConfigDto[];
  readonly ttlSeconds: number;
  readonly source: TurnCredentialSource;
}

export interface TurnCredentialProvider {
  readonly name: 'metered' | 'stun_fallback';
  getIceServers(): Promise<TurnCredentialFetchResult>;
}

/** Thời hạn tối đa của ephemeral TURN credential cấp cho trình duyệt: 900 giây (15 phút). */
export const EPHEMERAL_TURN_TTL_SECONDS = 900;

/**
 * Thời gian lưu đệm ngắn phía Server (tối đa 5 phút trong tổng hạn 15 phút)
 * để tái sử dụng credential đã lan truyền trên mạng biên Metered cho cả người gọi và người nhận,
 * đồng thời luôn đảm bảo khóa trả về trình duyệt tự hết hạn sau <= 15 phút.
 */
export const EPHEMERAL_TURN_SERVER_CACHE_SECONDS = 300;

export const PUBLIC_STUN_ICE_SERVERS: readonly IceServerConfigDto[] = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun1.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
]);
