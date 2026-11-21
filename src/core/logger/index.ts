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
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'resetToken',
  'verificationToken',
  'captchaToken',
  'otp',
  'otpCode',
  'otp_code',
  'secret',
  'pepper',
  'cookie',
  'cookies',
  'authorization',
  'Authorization',
  'x-csrf-token',
  'set-cookie',
] as const;

function quoteKeyIfNeeded(key: string): string {
  return key.includes('-') ? `["${key}"]` : key;
}

function buildRedactPaths(): string[] {
  const paths = new Set<string>([
    'req.headers.authorization',
    'req.headers.Authorization',
    'req.headers.cookie',
    'req.headers["set-cookie"]',
    'req.headers["x-csrf-token"]',
    'res.headers["set-cookie"]',
    'headers.authorization',
    'headers.Authorization',
    'headers.cookie',
    'headers["set-cookie"]',
    'headers["x-csrf-token"]',
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
