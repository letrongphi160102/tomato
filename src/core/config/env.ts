import 'server-only';

import { z } from 'zod';

// Các dummy key test công khai chính thức của Cloudflare Turnstile — chỉ cho phép ở dev/test.
const CLOUDFLARE_DUMMY_SITE_KEYS = new Set([
  '1x00000000000000000000AA',
  '2x00000000000000000000AB',
  '3x00000000000000000000FF',
]);

const CLOUDFLARE_DUMMY_SECRET_KEYS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

const MIN_SECRET_LENGTH = 32;

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
};

const optionalString = () => z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

const optionalUrl = () => z.preprocess(emptyToUndefined, z.url().optional());

// Tránh dùng z.coerce.boolean() vì trong JavaScript Boolean("false") === true.
const strictBooleanString = (defaultValue: boolean) =>
  z.preprocess(
    emptyToUndefined,
    z
      .enum(['true', 'false'])
      .transform((val) => val === 'true')
      .default(defaultValue),
  );

function isValidUrlWithProtocols(raw: string, allowedProtocols: readonly string[]): boolean {
  try {
    const parsed = new URL(raw);
    return allowedProtocols.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function parsePepperSecretsJson(raw: string): Record<number, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    return null;
  }

  const result: Record<number, string> = {};
  for (const [key, value] of entries) {
    if (!/^[1-9]\d*$/.test(key)) {
      return null;
    }
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) {
      return null;
    }
    result[Number(key)] = value;
  }

  return Object.freeze(result);
}

const rawEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.url({ protocol: /^https?$/ }),
    ALLOWED_ORIGINS: optionalString(),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    ),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL là bắt buộc')
      .refine((val) => isValidUrlWithProtocols(val, ['postgres:', 'postgresql:']), {
        message: 'DATABASE_URL phải là chuỗi kết nối PostgreSQL hợp lệ (postgresql://...)',
      }),
    DB_POOL_MAX: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(50).default(10)),

    REDIS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['local', 'upstash']).default('local')),
    REDIS_URL: optionalString(),
    UPSTASH_REDIS_REST_URL: optionalString(),
    UPSTASH_REDIS_REST_TOKEN: optionalString(),

    JWT_SECRET: z
      .string()
      .min(MIN_SECRET_LENGTH, `JWT_SECRET phải có tối thiểu ${MIN_SECRET_LENGTH} ký tự (256-bit)`),
    OTP_SECRET: z
      .string()
      .min(MIN_SECRET_LENGTH, `OTP_SECRET phải có tối thiểu ${MIN_SECRET_LENGTH} ký tự (256-bit)`),
    CURRENT_PEPPER_VERSION: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(1),
    ),
    PASSWORD_PEPPER_SECRETS: z.string().min(1, 'PASSWORD_PEPPER_SECRETS là bắt buộc'),

    EMAIL_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(['mailpit', 'gmail', 'brevo', 'smtp']).default('mailpit'),
    ),
    EMAIL_FROM: z.string().trim().min(3, 'EMAIL_FROM là bắt buộc'),
    SMTP_HOST: optionalString(),
    SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).optional()),
    SMTP_SECURE: strictBooleanString(false),
    SMTP_USER: optionalString(),
    SMTP_PASS: optionalString(),
    BREVO_API_KEY: optionalString(),

    NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().trim().min(1),
    TURNSTILE_SECRET_KEY: z.string().trim().min(1),

    SENTRY_DSN: optionalUrl(),
    NEXT_PUBLIC_SENTRY_DSN: optionalUrl(),

    STORAGE_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['local', 'vercel_blob']).optional()),
    LOCAL_STORAGE_DIR: optionalString(),
    BLOB_READ_WRITE_TOKEN: optionalString(),

    REALTIME_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['local', 'ably']).optional()),
    ABLY_API_KEY: optionalString(),
  })
  .superRefine((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production';

    // Production bắt buộc HTTPS để cookie __Host- và HSTS hoạt động đúng chuẩn bảo mật.
    if (isProduction && !isValidUrlWithProtocols(data.APP_URL, ['https:'])) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL bắt buộc dùng giao thức https:// trong môi trường production',
      });
    }

    // Kiểm tra danh sách ALLOWED_ORIGINS hợp lệ nếu được cung cấp.
    if (data.ALLOWED_ORIGINS !== undefined) {
      const origins = data.ALLOWED_ORIGINS.split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (origins.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['ALLOWED_ORIGINS'],
          message: 'ALLOWED_ORIGINS không được rỗng nếu đã khai báo',
        });
      }
      for (const origin of origins) {
        if (!isValidUrlWithProtocols(origin, ['http:', 'https:'])) {
          ctx.addIssue({
            code: 'custom',
            path: ['ALLOWED_ORIGINS'],
            message: 'ALLOWED_ORIGINS chứa URL không hợp lệ',
          });
          break;
        }
      }
    }

    // Kiểm tra cấu hình Redis theo từng adapter.
    if (data.REDIS_PROVIDER === 'local') {
      if (!data.REDIS_URL || !isValidUrlWithProtocols(data.REDIS_URL, ['redis:', 'rediss:'])) {
        ctx.addIssue({
          code: 'custom',
          path: ['REDIS_URL'],
          message:
            'REDIS_URL hợp lệ (redis:// hoặc rediss://) là bắt buộc khi REDIS_PROVIDER=local',
        });
      }
    } else {
      if (
        !data.UPSTASH_REDIS_REST_URL ||
        !isValidUrlWithProtocols(data.UPSTASH_REDIS_REST_URL, ['https:'])
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['UPSTASH_REDIS_REST_URL'],
          message: 'UPSTASH_REDIS_REST_URL (https://) là bắt buộc khi REDIS_PROVIDER=upstash',
        });
      }
      if (!data.UPSTASH_REDIS_REST_TOKEN) {
        ctx.addIssue({
          code: 'custom',
          path: ['UPSTASH_REDIS_REST_TOKEN'],
          message: 'UPSTASH_REDIS_REST_TOKEN là bắt buộc khi REDIS_PROVIDER=upstash',
        });
      }
    }

    // Không cho phép dùng chung khóa mật mã giữa JWT và OTP để cô lập rủi ro lộ khóa.
    if (data.JWT_SECRET === data.OTP_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_SECRET'],
        message: 'OTP_SECRET phải khác JWT_SECRET để tách biệt miền mật mã',
      });
    }

    // Kiểm tra bản đồ Pepper Secrets và đảm bảo CURRENT_PEPPER_VERSION có tồn tại.
    const pepperMap = parsePepperSecretsJson(data.PASSWORD_PEPPER_SECRETS);
    if (!pepperMap) {
      ctx.addIssue({
        code: 'custom',
        path: ['PASSWORD_PEPPER_SECRETS'],
        message: `PASSWORD_PEPPER_SECRETS phải là JSON object dạng {"1":"<secret >= ${MIN_SECRET_LENGTH} ký tự>"}`,
      });
    } else {
      const currentPepper = pepperMap[data.CURRENT_PEPPER_VERSION];
      if (!currentPepper) {
        ctx.addIssue({
          code: 'custom',
          path: ['CURRENT_PEPPER_VERSION'],
          message: `Không tìm thấy khóa pepper cho phiên bản CURRENT_PEPPER_VERSION=${data.CURRENT_PEPPER_VERSION}`,
        });
      } else if (
        Object.values(pepperMap).some(
          (secret) => secret === data.JWT_SECRET || secret === data.OTP_SECRET,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['PASSWORD_PEPPER_SECRETS'],
          message: 'Pepper secret phải độc lập, không được trùng với JWT_SECRET hoặc OTP_SECRET',
        });
      }
    }

    // Kiểm tra cấu hình Email Provider (`mailpit` | `gmail` | `brevo`, giữ `smtp` để tương thích ngược).
    if (data.EMAIL_PROVIDER === 'mailpit') {
      // Chặn tuyệt đối việc dùng Mailpit cục bộ trong môi trường production.
      if (isProduction) {
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_PROVIDER'],
          message:
            'Không được sử dụng EMAIL_PROVIDER=mailpit trong production (hãy chọn gmail hoặc brevo)',
        });
      }
    } else if (data.EMAIL_PROVIDER === 'gmail') {
      if (!data.SMTP_USER) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_USER'],
          message: 'SMTP_USER (địa chỉ Gmail) là bắt buộc khi EMAIL_PROVIDER=gmail',
        });
      }
      if (!data.SMTP_PASS) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_PASS'],
          message: 'SMTP_PASS (Gmail App Password) là bắt buộc khi EMAIL_PROVIDER=gmail',
        });
      }
    } else if (data.EMAIL_PROVIDER === 'smtp') {
      if (!data.SMTP_HOST) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_HOST'],
          message: 'SMTP_HOST là bắt buộc khi EMAIL_PROVIDER=smtp',
        });
      }
      if (data.SMTP_PORT === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_PORT'],
          message: 'SMTP_PORT là bắt buộc khi EMAIL_PROVIDER=smtp',
        });
      }
      if (isProduction && (!data.SMTP_USER || !data.SMTP_PASS)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_USER'],
          message: 'SMTP_USER và SMTP_PASS là bắt buộc khi chạy SMTP ở môi trường production',
        });
      }
    } else if (!data.BREVO_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['BREVO_API_KEY'],
        message: 'BREVO_API_KEY là bắt buộc khi EMAIL_PROVIDER=brevo',
      });
    }

    // Ngăn chặn tuyệt đối việc vô tình đưa dummy key Turnstile (luôn pass) lên Production.
    if (isProduction) {
      if (CLOUDFLARE_DUMMY_SITE_KEYS.has(data.NEXT_PUBLIC_TURNSTILE_SITE_KEY)) {
        ctx.addIssue({
          code: 'custom',
          path: ['NEXT_PUBLIC_TURNSTILE_SITE_KEY'],
          message: 'Không được sử dụng Cloudflare Turnstile dummy test site key trong production',
        });
      }
      if (CLOUDFLARE_DUMMY_SECRET_KEYS.has(data.TURNSTILE_SECRET_KEY)) {
        ctx.addIssue({
          code: 'custom',
          path: ['TURNSTILE_SECRET_KEY'],
          message: 'Không được sử dụng Cloudflare Turnstile dummy test secret key trong production',
        });
      }
    }

    // Kiểm tra cấu hình lưu trữ Media theo từng adapter (`local` | `vercel_blob`).
    const effectiveStorageProvider =
      data.STORAGE_PROVIDER ?? (data.BLOB_READ_WRITE_TOKEN ? 'vercel_blob' : 'local');
    if (effectiveStorageProvider === 'vercel_blob' && !data.BLOB_READ_WRITE_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['BLOB_READ_WRITE_TOKEN'],
        message: 'BLOB_READ_WRITE_TOKEN là bắt buộc khi STORAGE_PROVIDER=vercel_blob',
      });
    }

    // Kiểm tra cấu hình hạ tầng Realtime theo từng adapter (`local` | `ably`).
    // Ở môi trường test (`NODE_ENV=test`), mặc định chọn `'local'` nếu không chỉ định tường minh
    // để ngăn test cục bộ vô tình gọi mạng ra Ably dù `.env.local` có sẵn `ABLY_API_KEY`.
    const effectiveRealtimeProvider =
      data.REALTIME_PROVIDER ?? (data.NODE_ENV !== 'test' && data.ABLY_API_KEY ? 'ably' : 'local');
    if (effectiveRealtimeProvider === 'ably') {
      if (!data.ABLY_API_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['ABLY_API_KEY'],
          message: 'ABLY_API_KEY là bắt buộc khi REALTIME_PROVIDER=ably',
        });
      } else {
        const separatorIdx = data.ABLY_API_KEY.indexOf(':');
        const keyNamePart = separatorIdx > 0 ? data.ABLY_API_KEY.slice(0, separatorIdx) : '';
        const keySecretPart = separatorIdx > 0 ? data.ABLY_API_KEY.slice(separatorIdx + 1) : '';
        if (
          separatorIdx <= 0 ||
          !keyNamePart.includes('.') ||
          keySecretPart.trim().length < 8 ||
          /\s/.test(data.ABLY_API_KEY)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['ABLY_API_KEY'],
            message: 'ABLY_API_KEY không đúng định dạng chuẩn <appId>.<keyId>:<secret>',
          });
        }
      }
    }
  });

export interface Env {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly APP_URL: string;
  readonly ALLOWED_ORIGINS: readonly string[];
  readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly DATABASE_URL: string;
  readonly DB_POOL_MAX: number;
  readonly REDIS_PROVIDER: 'local' | 'upstash';
  readonly REDIS_URL?: string;
  readonly UPSTASH_REDIS_REST_URL?: string;
  readonly UPSTASH_REDIS_REST_TOKEN?: string;
  readonly JWT_SECRET: string;
  readonly OTP_SECRET: string;
  readonly CURRENT_PEPPER_VERSION: number;
  readonly PASSWORD_PEPPER_SECRETS: Readonly<Record<number, string>>;
  readonly EMAIL_PROVIDER: 'mailpit' | 'gmail' | 'brevo' | 'smtp';
  readonly EMAIL_FROM: string;
  readonly SMTP_HOST?: string;
  readonly SMTP_PORT?: number;
  readonly SMTP_SECURE: boolean;
  readonly SMTP_USER?: string;
  readonly SMTP_PASS?: string;
  readonly BREVO_API_KEY?: string;
  readonly NEXT_PUBLIC_TURNSTILE_SITE_KEY: string;
  readonly TURNSTILE_SECRET_KEY: string;
  readonly SENTRY_DSN?: string;
  readonly NEXT_PUBLIC_SENTRY_DSN?: string;
  readonly STORAGE_PROVIDER: 'local' | 'vercel_blob';
  readonly LOCAL_STORAGE_DIR: string;
  readonly BLOB_READ_WRITE_TOKEN?: string;
  readonly REALTIME_PROVIDER: 'local' | 'ably';
  readonly ABLY_API_KEY?: string;
}

export class EnvValidationError extends Error {
  public readonly issues: readonly { path: string; message: string }[];

  constructor(issues: readonly { path: string; message: string }[]) {
    // Tuyệt đối chỉ xuất tên biến và mô tả lỗi, KHÔNG xuất giá trị thực tế ra log/stderr.
    const summary = issues
      .map((issue) => `  - ${issue.path || 'ENV'}: ${issue.message}`)
      .join('\n');
    super(`Cấu hình biến môi trường không hợp lệ (fail-fast):\n${summary}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv(rawEnv: Record<string, string | undefined>): Env {
  const parsed = rawEnvSchema.safeParse(rawEnv);

  if (!parsed.success) {
    const safeIssues = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    throw new EnvValidationError(safeIssues);
  }

  const data = parsed.data;
  const pepperMap = parsePepperSecretsJson(data.PASSWORD_PEPPER_SECRETS);
  if (!pepperMap) {
    throw new EnvValidationError([
      { path: 'PASSWORD_PEPPER_SECRETS', message: 'Không thể phân tích PASSWORD_PEPPER_SECRETS' },
    ]);
  }

  const normalizedOrigins = data.ALLOWED_ORIGINS
    ? Array.from(
        new Set(
          data.ALLOWED_ORIGINS.split(',')
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => new URL(item).origin),
        ),
      )
    : [new URL(data.APP_URL).origin];

  const defaultLogLevel: Env['LOG_LEVEL'] =
    data.NODE_ENV === 'test' ? 'silent' : data.NODE_ENV === 'production' ? 'info' : 'debug';

  const effectiveStorageProvider: Env['STORAGE_PROVIDER'] =
    data.STORAGE_PROVIDER ?? (data.BLOB_READ_WRITE_TOKEN ? 'vercel_blob' : 'local');

  const effectiveRealtimeProvider: Env['REALTIME_PROVIDER'] =
    data.REALTIME_PROVIDER ?? (data.NODE_ENV !== 'test' && data.ABLY_API_KEY ? 'ably' : 'local');

  return Object.freeze({
    NODE_ENV: data.NODE_ENV,
    APP_URL: data.APP_URL,
    ALLOWED_ORIGINS: Object.freeze(normalizedOrigins),
    LOG_LEVEL: data.LOG_LEVEL ?? defaultLogLevel,
    DATABASE_URL: data.DATABASE_URL,
    DB_POOL_MAX: data.DB_POOL_MAX,
    REDIS_PROVIDER: data.REDIS_PROVIDER,
    REDIS_URL: data.REDIS_URL,
    UPSTASH_REDIS_REST_URL: data.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: data.UPSTASH_REDIS_REST_TOKEN,
    JWT_SECRET: data.JWT_SECRET,
    OTP_SECRET: data.OTP_SECRET,
    CURRENT_PEPPER_VERSION: data.CURRENT_PEPPER_VERSION,
    PASSWORD_PEPPER_SECRETS: pepperMap,
    EMAIL_PROVIDER: data.EMAIL_PROVIDER,
    EMAIL_FROM: data.EMAIL_FROM,
    SMTP_HOST: data.SMTP_HOST,
    SMTP_PORT: data.SMTP_PORT,
    SMTP_SECURE: data.SMTP_SECURE,
    SMTP_USER: data.SMTP_USER,
    SMTP_PASS: data.SMTP_PASS,
    BREVO_API_KEY: data.BREVO_API_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: data.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: data.TURNSTILE_SECRET_KEY,
    SENTRY_DSN: data.SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_DSN: data.NEXT_PUBLIC_SENTRY_DSN,
    STORAGE_PROVIDER: effectiveStorageProvider,
    LOCAL_STORAGE_DIR: data.LOCAL_STORAGE_DIR ?? '.tomato-storage',
    BLOB_READ_WRITE_TOKEN: data.BLOB_READ_WRITE_TOKEN,
    REALTIME_PROVIDER: effectiveRealtimeProvider,
    ABLY_API_KEY: data.ABLY_API_KEY,
  });
}

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = parseEnv(process.env);
  }
  return cachedEnv;
}

export function resetEnvCacheForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetEnvCacheForTesting chỉ được phép gọi trong môi trường test');
  }
  cachedEnv = null;
}
