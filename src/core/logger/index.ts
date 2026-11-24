import 'server-only';

import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

// Pino sử dụng fast-redact (không hỗ trợ recursive wildcard `**`),
// vì vậy phải liệt kê tường minh các trường nhạy cảm ở nhiều tầng lồng nhau và header HTTP.
const SENSITIVE_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'passwordHash',
  'password_hash',
  'pass',
  'smtpPass',
  'SMTP_PASS',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'refreshTokenHash',
  'refresh_token_hash',
  'csrfToken',
  'csrf_token',
  'resetToken',
  'reset_token',
  'password_reset_token',
  'rawToken',
  'rawResetToken',
  'rawTicket',
  'resetUrl',
  'reset_url',
  'verificationToken',
  'captchaToken',
  'tokenHash',
  'token_hash',
  'otp',
  'otpCode',
  'otp_code',
  'otpTokenHash',
  'otp_token_hash',
  'passwordChangeTicket',
  'password_change_ticket',
  'pwdTicket',
  'ticket',
  'ticketHash',
  'ticket_hash',
  'tomato_at',
  'tomato_rt',
  'tomato_csrf',
  'tomato_pwd_ticket',
  '__Host-tomato_at',
  '__Host-tomato_rt',
  '__Host-tomato_csrf',
  '__Host-tomato_pwd_ticket',
  'secret',
  'pepper',
  'pepperSecret',
  'pepper_secret',
  'apiKey',
  'api_key',
  'api-key',
  'x-api-key',
  'X-Api-Key',
  'X-API-Key',
  'connectionString',
  'databaseUrl',
  'DATABASE_URL',
  'redisUrl',
  'REDIS_URL',
  'JWT_SECRET',
  'OTP_SECRET',
  'TURNSTILE_SECRET_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  'BREVO_API_KEY',
  'PASSWORD_PEPPER_SECRETS',
  'SENTRY_DSN',
  'NEXT_PUBLIC_SENTRY_DSN',
  'SENTRY_AUTH_TOKEN',
  'GMAIL_APP_PASSWORD',
  'BLOB_READ_WRITE_TOKEN',
  'blobReadWriteToken',
  'blob_read_write_token',
  'ABLY_API_KEY',
  'ablyApiKey',
  'ably_api_key',
  'tokenRequest',
  'token_request',
  'mac',
  'ciphertext',
  'cryptoHeader',
  'crypto_header',
  'wrappedKeys',
  'wrappedKey',
  'encryptedKeyBlob',
  'encrypted_key_blob',
  'kdfSalt',
  'kdf_salt',
  'recoveryPin',
  'pin',
  'currentPin',
  'current_pin',
  'newPin',
  'new_pin',
  'confirmPin',
  'confirm_pin',
  'identityPrivateJwk',
  'signingPrivateJwk',
  'bootstrapKeyPair',
  'cookie',
  'Cookie',
  'cookies',
  'authorization',
  'Authorization',
  'proxy-authorization',
  'Proxy-Authorization',
  'x-csrf-token',
  'X-CSRF-Token',
  'X-Csrf-Token',
  'set-cookie',
  'Set-Cookie',
] as const;

function quoteKeyIfNeeded(key: string): string {
  return key.includes('-') ? `["${key}"]` : key;
}

function buildRedactPaths(): string[] {
  const paths = new Set<string>([
    'req.headers.authorization',
    'req.headers.Authorization',
    'req.headers["proxy-authorization"]',
    'req.headers["Proxy-Authorization"]',
    'req.headers.cookie',
    'req.headers.Cookie',
    'req.headers["set-cookie"]',
    'req.headers["Set-Cookie"]',
    'req.headers["x-csrf-token"]',
    'req.headers["X-CSRF-Token"]',
    'req.headers["X-Csrf-Token"]',
    'req.headers["api-key"]',
    'req.headers["x-api-key"]',
    'req.headers["X-API-Key"]',
    'res.headers["set-cookie"]',
    'res.headers["Set-Cookie"]',
    'headers.authorization',
    'headers.Authorization',
    'headers["proxy-authorization"]',
    'headers["Proxy-Authorization"]',
    'headers.cookie',
    'headers.Cookie',
    'headers["set-cookie"]',
    'headers["Set-Cookie"]',
    'headers["x-csrf-token"]',
    'headers["X-CSRF-Token"]',
    'headers["X-Csrf-Token"]',
    'headers["api-key"]',
    'headers["x-api-key"]',
    'headers["X-API-Key"]',
  ]);

  for (const key of SENSITIVE_KEYS) {
    const segment = quoteKeyIfNeeded(key);
    const prefix = key.includes('-') ? '' : '.';
    paths.add(segment);
    paths.add(`*${prefix}${segment}`);
    paths.add(`*.*${prefix}${segment}`);
    paths.add(`*.*.*${prefix}${segment}`);
  }

  return Array.from(paths);
}

export const REDACT_PATHS: readonly string[] = Object.freeze(buildRedactPaths());

export interface CreateLoggerOptions {
  level?: string;
  pretty?: boolean;
  destination?: DestinationStream;
}

function resolveDefaultLogLevel(): string {
  const configured = process.env.LOG_LEVEL?.trim();
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === 'test') {
    return 'silent';
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? resolveDefaultLogLevel();
  const usePretty =
    options.pretty ?? (process.env.NODE_ENV === 'development' && !options.destination);

  const pinoOptions: LoggerOptions = {
    level,
    base: {
      service: 'tomato-web',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (usePretty) {
    pinoOptions.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

const globalForLogger = globalThis as typeof globalThis & {
  __tomatoLogger?: Logger;
};

export const logger: Logger = globalForLogger.__tomatoLogger ?? createLogger();

if (process.env.NODE_ENV !== 'production') {
  globalForLogger.__tomatoLogger = logger;
}
