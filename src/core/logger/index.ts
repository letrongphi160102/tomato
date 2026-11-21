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
  'verificationToken',
  'captchaToken',
  'tokenHash',
  'token_hash',
  'otp',
  'otpCode',
  'otp_code',
  'otpTokenHash',
  'otp_token_hash',
  'secret',
  'pepper',
  'pepperSecret',
  'pepper_secret',
  'apiKey',
  'api_key',
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
  'cookie',
  'Cookie',
  'cookies',
  'authorization',
  'Authorization',
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
    'req.headers.cookie',
    'req.headers.Cookie',
    'req.headers["set-cookie"]',
    'req.headers["Set-Cookie"]',
    'req.headers["x-csrf-token"]',
    'req.headers["X-CSRF-Token"]',
    'req.headers["X-Csrf-Token"]',
    'res.headers["set-cookie"]',
    'res.headers["Set-Cookie"]',
    'headers.authorization',
    'headers.Authorization',
    'headers.cookie',
    'headers.Cookie',
    'headers["set-cookie"]',
    'headers["Set-Cookie"]',
    'headers["x-csrf-token"]',
    'headers["X-CSRF-Token"]',
    'headers["X-Csrf-Token"]',
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
