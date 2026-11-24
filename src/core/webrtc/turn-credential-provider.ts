import 'server-only';

import { logger } from '@/core/logger';
import {
  EPHEMERAL_TURN_SERVER_CACHE_SECONDS,
  EPHEMERAL_TURN_TTL_SECONDS,
  PUBLIC_STUN_ICE_SERVERS,
  type IceServerConfigDto,
  type TurnCredentialFetchResult,
  type TurnCredentialProvider,
} from '@/core/webrtc/types';

const ALLOWED_ICE_URL_PREFIX_REGEX = /^(?:stuns?|turns?):[^\s]+$/i;
const SAFE_METERED_HOSTNAME_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const DEFAULT_FETCH_TIMEOUT_MS = 4_000;
const MAX_ICE_SERVERS_RETURNED = 16;

function isValidIceUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 256 &&
    ALLOWED_ICE_URL_PREFIX_REGEX.test(value.trim())
  );
}

/**
 * Lọc phòng thủ danh sách `iceServers` trả về từ dịch vụ ngoài theo allowlist chặt chẽ:
 * chỉ giữ `urls` (`stun:`/`stuns:`/`turn:`/`turns:`), `username` và `credential`;
 * loại bỏ hoàn toàn mọi trường thừa như `apiKey`, `secretKey`, `password`, `label`.
 */
export function sanitizeIceServers(raw: unknown): IceServerConfigDto[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const sanitized: IceServerConfigDto[] = [];
  for (const entry of raw) {
    if (sanitized.length >= MAX_ICE_SERVERS_RETURNED) {
      break;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    let cleanUrls: string | readonly string[] | null = null;

    if (isValidIceUrl(record.urls)) {
      cleanUrls = record.urls.trim();
    } else if (Array.isArray(record.urls)) {
      const validList = record.urls
        .filter(isValidIceUrl)
        .map((url) => url.trim())
        .slice(0, 6);
      if (validList.length > 0) {
        cleanUrls = validList;
      }
    }

    if (!cleanUrls) {
      continue;
    }

    const username =
      typeof record.username === 'string' && record.username.trim().length > 0
        ? record.username.trim()
        : undefined;
    const credential =
      typeof record.credential === 'string' && record.credential.trim().length > 0
        ? record.credential.trim()
        : undefined;

    sanitized.push({
      urls: cleanUrls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    });
  }

  return sanitized;
}

/**
 * Xây dựng bộ ICE servers Metered tiêu chuẩn từ cặp `(username, password)` tạm thời
 * phòng trường hợp endpoint tạo ephemeral credential không trả kèm `apiKey` phụ.
 */
export function buildMeteredFallbackRelayServers(
  username: string,
  password: string,
): IceServerConfigDto[] {
  const cleanUser = username.trim();
  const cleanPass = password.trim();
  if (!cleanUser || !cleanPass) {
    return [];
  }

  return [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: cleanUser, credential: cleanPass },
    {
      urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: cleanUser,
      credential: cleanPass,
    },
    { urls: 'turn:global.relay.metered.ca:443', username: cleanUser, credential: cleanPass },
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: cleanUser,
      credential: cleanPass,
    },
  ];
}

export function normalizeMeteredDomain(rawDomain: string): string | null {
  const normalized = rawDomain.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 253 ||
    !SAFE_METERED_HOSTNAME_REGEX.test(normalized) ||
    /^\d+(?:\.\d+){3}$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export class StunFallbackTurnProvider implements TurnCredentialProvider {
  public readonly name = 'stun_fallback' as const;

  async getIceServers(): Promise<TurnCredentialFetchResult> {
    return {
      iceServers: PUBLIC_STUN_ICE_SERVERS.map((server) => ({ ...server })),
      ttlSeconds: EPHEMERAL_TURN_TTL_SECONDS,
      source: 'stun_fallback',
    };
  }
}

export interface MeteredTurnCredentialProviderOptions {
  readonly domain: string;
  readonly secretKey?: string;
  readonly turnApiKey?: string;
  readonly ttlSeconds?: number;
  readonly cacheMaxAgeSeconds?: number;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

interface CachedEphemeralTurnEntry {
  readonly iceServers: readonly IceServerConfigDto[];
  readonly expiresAtMs: number;
  readonly cacheUntilMs: number;
}

/**
 * Adapter cấp phát TURN credential ngắn hạn từ Metered (0đ trọn đời) với 3 tầng ưu tiên:
 * 1. `METERED_DOMAIN` + `METERED_SECRET_KEY`: tạo ephemeral credential ngắn hạn (`TTL <= 900s`) rồi lấy `iceServers`.
 * 2. `METERED_DOMAIN` + `METERED_TURN_API_KEY`: fallback khi chưa có `METERED_SECRET_KEY` hoặc Tầng 1 lỗi.
 * 3. STUN công khai: fallback an toàn khi mất kết nối hoặc môi trường local/CI.
 *
 * Tuyệt đối không bao giờ ghi URL chứa `secretKey`/`apiKey` hoặc mật khẩu TURN ra log/Sentry.
 */
export class MeteredTurnCredentialProvider implements TurnCredentialProvider {
  public readonly name = 'metered' as const;
  private readonly domain: string | null;
  private readonly secretKey?: string;
  private readonly turnApiKey?: string;
  private readonly ttlSeconds: number;
  private readonly cacheMaxAgeSeconds: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private ephemeralCache: CachedEphemeralTurnEntry | null = null;
  private inFlightEphemeral: Promise<TurnCredentialFetchResult | null> | null = null;

  constructor(options: MeteredTurnCredentialProviderOptions) {
    this.domain = normalizeMeteredDomain(options.domain);
    this.secretKey = options.secretKey?.trim() || undefined;
    this.turnApiKey = options.turnApiKey?.trim() || undefined;
    this.ttlSeconds = Math.min(
      EPHEMERAL_TURN_TTL_SECONDS,
      Math.max(60, Math.floor(options.ttlSeconds ?? EPHEMERAL_TURN_TTL_SECONDS)),
    );
    this.cacheMaxAgeSeconds = Math.min(
      Math.floor(this.ttlSeconds / 2),
      Math.max(0, Math.floor(options.cacheMaxAgeSeconds ?? EPHEMERAL_TURN_SERVER_CACHE_SECONDS)),
    );
    this.timeoutMs = Math.max(500, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  private async fetchJsonSafely(
    url: string,
    init: RequestInit,
    tier: 'metered_ephemeral_create' | 'metered_ephemeral_list' | 'metered_api_key',
  ): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        logger.warn(
          {
            component: 'webrtc-turn',
            tier,
            statusCode: response.status,
          },
          'Dịch vụ TURN trả về mã lỗi HTTP, chuyển sang phương án dự phòng',
        );
        return { ok: false, status: response.status, body: null };
      }

      const body: unknown = await response.json().catch(() => null);
      return { ok: true, status: response.status, body };
    } catch (error) {
      // Tuyệt đối KHÔNG log `error.message` vì các HTTP client có thể nhúng URL chứa secretKey/apiKey.
      logger.warn(
        {
          component: 'webrtc-turn',
          tier,
          errorName: error instanceof Error ? error.name : 'FetchError',
        },
        'Không thể kết nối dịch vụ TURN, chuyển sang phương án dự phòng',
      );
      return { ok: false, status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchIceServersByApiKey(
    domain: string,
    apiKey: string,
    tier: 'metered_ephemeral_list' | 'metered_api_key',
  ): Promise<IceServerConfigDto[]> {
    const endpoint = `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
    const res = await this.fetchJsonSafely(endpoint, { method: 'GET' }, tier);
    if (!res.ok) {
      return [];
    }
    return sanitizeIceServers(res.body);
  }

  private async tryEphemeralTier(domain: string): Promise<TurnCredentialFetchResult | null> {
    if (!this.secretKey) {
      return null;
    }

    const nowMs = this.now();
    if (
      this.ephemeralCache &&
      nowMs < this.ephemeralCache.cacheUntilMs &&
      nowMs < this.ephemeralCache.expiresAtMs - 60_000
    ) {
      const remainingSeconds = Math.max(
        60,
        Math.min(
          EPHEMERAL_TURN_TTL_SECONDS,
          Math.floor((this.ephemeralCache.expiresAtMs - nowMs) / 1000),
        ),
      );
      return {
        iceServers: this.ephemeralCache.iceServers.map((server) => ({ ...server })),
        ttlSeconds: remainingSeconds,
        source: 'metered_ephemeral',
      };
    }

    if (this.inFlightEphemeral) {
      return this.inFlightEphemeral;
    }

    const task = (async (): Promise<TurnCredentialFetchResult | null> => {
      const createUrl = `https://${domain}/api/v1/turn/credential?secretKey=${encodeURIComponent(this.secretKey!)}`;
      const created = await this.fetchJsonSafely(
        createUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expiryInSeconds: this.ttlSeconds,
            label: 'tomato-call',
          }),
        },
        'metered_ephemeral_create',
      );

      if (
        !created.ok ||
        typeof created.body !== 'object' ||
        created.body === null ||
        Array.isArray(created.body)
      ) {
        return null;
      }

      const payload = created.body as Record<string, unknown>;
      const rawExpiry =
        typeof payload.expiryInSeconds === 'number' && Number.isFinite(payload.expiryInSeconds)
          ? payload.expiryInSeconds
          : this.ttlSeconds;
      const effectiveTtl = Math.min(
        EPHEMERAL_TURN_TTL_SECONDS,
        Math.max(60, Math.floor(rawExpiry)),
      );

      const ephemeralApiKey =
        typeof payload.apiKey === 'string' && payload.apiKey.trim().length > 0
          ? payload.apiKey.trim()
          : null;
      const username =
        typeof payload.username === 'string' && payload.username.trim().length > 0
          ? payload.username.trim()
          : null;
      const password =
        typeof payload.password === 'string' && payload.password.trim().length > 0
          ? payload.password.trim()
          : null;

      let iceServers: IceServerConfigDto[] = [];

      // Một số phiên bản API có thể trả thẳng `iceServers` hoặc trả `apiKey` tạm thời.
      if (Array.isArray(payload.iceServers)) {
        iceServers = sanitizeIceServers(payload.iceServers);
      }
      if (iceServers.length === 0 && ephemeralApiKey) {
        iceServers = await this.fetchIceServersByApiKey(
          domain,
          ephemeralApiKey,
          'metered_ephemeral_list',
        );
      }
      if (iceServers.length === 0 && username && password) {
        iceServers = buildMeteredFallbackRelayServers(username, password);
      }

      if (iceServers.length === 0) {
        return null;
      }

      const issuedAtMs = this.now();
      if (this.cacheMaxAgeSeconds > 0) {
        this.ephemeralCache = {
          iceServers,
          expiresAtMs: issuedAtMs + effectiveTtl * 1000,
          cacheUntilMs: issuedAtMs + this.cacheMaxAgeSeconds * 1000,
        };
      }

      return {
        iceServers: iceServers.map((server) => ({ ...server })),
        ttlSeconds: effectiveTtl,
        source: 'metered_ephemeral',
      };
    })().finally(() => {
      if (this.inFlightEphemeral === task) {
        this.inFlightEphemeral = null;
      }
    });

    this.inFlightEphemeral = task;
    return task;
  }

  private async tryTurnApiKeyTier(domain: string): Promise<TurnCredentialFetchResult | null> {
    if (!this.turnApiKey) {
      return null;
    }
    const iceServers = await this.fetchIceServersByApiKey(
      domain,
      this.turnApiKey,
      'metered_api_key',
    );
    if (iceServers.length === 0) {
      return null;
    }
    return {
      iceServers,
      ttlSeconds: this.ttlSeconds,
      source: 'metered_api_key',
    };
  }

  async getIceServers(): Promise<TurnCredentialFetchResult> {
    if (this.domain) {
      const tier1 = await this.tryEphemeralTier(this.domain);
      if (tier1) {
        return tier1;
      }

      const tier2 = await this.tryTurnApiKeyTier(this.domain);
      if (tier2) {
        return tier2;
      }
    }

    return {
      iceServers: PUBLIC_STUN_ICE_SERVERS.map((server) => ({ ...server })),
      ttlSeconds: this.ttlSeconds,
      source: 'stun_fallback',
    };
  }
}
