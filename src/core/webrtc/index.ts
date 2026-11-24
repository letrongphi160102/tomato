import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import {
  MeteredTurnCredentialProvider,
  StunFallbackTurnProvider,
  buildMeteredFallbackRelayServers,
  normalizeMeteredDomain,
  sanitizeIceServers,
  type MeteredTurnCredentialProviderOptions,
} from '@/core/webrtc/turn-credential-provider';
import {
  EPHEMERAL_TURN_SERVER_CACHE_SECONDS,
  EPHEMERAL_TURN_TTL_SECONDS,
  PUBLIC_STUN_ICE_SERVERS,
  type IceServerConfigDto,
  type IceServersResponseDto,
  type TurnCredentialFetchResult,
  type TurnCredentialProvider,
  type TurnCredentialSource,
} from '@/core/webrtc/types';

export {
  EPHEMERAL_TURN_SERVER_CACHE_SECONDS,
  EPHEMERAL_TURN_TTL_SECONDS,
  MeteredTurnCredentialProvider,
  PUBLIC_STUN_ICE_SERVERS,
  StunFallbackTurnProvider,
  buildMeteredFallbackRelayServers,
  normalizeMeteredDomain,
  sanitizeIceServers,
};
export type {
  IceServerConfigDto,
  IceServersResponseDto,
  MeteredTurnCredentialProviderOptions,
  TurnCredentialFetchResult,
  TurnCredentialProvider,
  TurnCredentialSource,
};

type TurnEnvConfig = Pick<
  Env,
  'NODE_ENV' | 'METERED_DOMAIN' | 'METERED_SECRET_KEY' | 'METERED_TURN_API_KEY'
>;

export function createTurnCredentialProvider(config: TurnEnvConfig): TurnCredentialProvider {
  // Trong môi trường test (`NODE_ENV=test`), mặc định dùng STUN fallback offline
  // để toàn bộ test không bao giờ vô tình gọi mạng thật ra Metered dù `.env.local` có cấu hình.
  if (config.NODE_ENV === 'test') {
    return new StunFallbackTurnProvider();
  }

  if (config.METERED_DOMAIN && (config.METERED_SECRET_KEY || config.METERED_TURN_API_KEY)) {
    return new MeteredTurnCredentialProvider({
      domain: config.METERED_DOMAIN,
      secretKey: config.METERED_SECRET_KEY,
      turnApiKey: config.METERED_TURN_API_KEY,
    });
  }

  return new StunFallbackTurnProvider();
}

const globalForTurn = globalThis as typeof globalThis & {
  __tomatoTurnCredentialProvider?: TurnCredentialProvider;
};

export function getTurnCredentialProvider(): TurnCredentialProvider {
  if (!globalForTurn.__tomatoTurnCredentialProvider) {
    globalForTurn.__tomatoTurnCredentialProvider = createTurnCredentialProvider(getEnv());
  }
  return globalForTurn.__tomatoTurnCredentialProvider;
}

export function setTurnCredentialProviderForTesting(provider: TurnCredentialProvider): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setTurnCredentialProviderForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForTurn.__tomatoTurnCredentialProvider = provider;
}

export function resetTurnCredentialProviderForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'resetTurnCredentialProviderForTesting chỉ được phép gọi trong môi trường test',
    );
  }
  globalForTurn.__tomatoTurnCredentialProvider = undefined;
}
