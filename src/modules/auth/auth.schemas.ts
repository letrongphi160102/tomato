import { z } from 'zod';

import { normalizeEmail, normalizePassword } from '@/core/crypto/normalize';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import { isCommonOrWeakPassword } from '@/modules/auth/common-passwords';

export const EMAIL_MAX_LENGTH = 254;
export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 50;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const MIN_REGISTRATION_AGE_YEARS = 13;
export const MAX_REGISTRATION_AGE_YEARS = 130;
export const OTP_CODE_REGEX = /^\d{6}$/;

const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
// Cấm ký tự điều khiển ASCII (CR, LF, NUL...) để tránh Email Header Injection và lỗi hiển thị.
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/;

export interface ParsedCalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Phân tích ngày theo định dạng `YYYY-MM-DD` và xác minh tính tồn tại thực tế trên lịch
 * (chặn các ngày ảo như `2024-02-30` hoặc `2023-02-29` mà `new Date()` tự động cuộn sang tháng 3).
 */
export function parseStrictIsoDate(raw: string): ParsedCalendarDate | null {
  const match = ISO_DATE_ONLY_REGEX.exec(raw.trim());
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

/**
 * Tính chính xác số tuổi theo ngày lịch UTC (xử lý đúng sinh nhật trùng ngày hiện tại và năm nhuận 29/02).
 */
export function calculateAgeYears(
  dob: ParsedCalendarDate,
  referenceDate: Date = new Date(),
): number {
  const refYear = referenceDate.getUTCFullYear();
  const refMonth = referenceDate.getUTCMonth() + 1;
  const refDay = referenceDate.getUTCDate();

  let age = refYear - dob.year;
  if (refMonth < dob.month || (refMonth === dob.month && refDay < dob.day)) {
    age -= 1;
  }
  return age;
}

const normalizedEmailSchema = z
  .string({ error: AUTH_MESSAGES.emailRequired })
  .transform((val) => normalizeEmail(val))
  .refine((val) => val.length > 0, { message: AUTH_MESSAGES.emailRequired })
  .refine((val) => val.length <= EMAIL_MAX_LENGTH, { message: AUTH_MESSAGES.emailTooLong })
  .pipe(z.email({ message: AUTH_MESSAGES.emailInvalid }));

const displayNameSchema = z
  .string({ error: AUTH_MESSAGES.displayNameRequired })
  .transform((val) => val.trim().normalize('NFKC'))
  .refine((val) => val.length > 0, { message: AUTH_MESSAGES.displayNameRequired })
  .refine((val) => !CONTROL_CHARS_REGEX.test(val), {
    message: AUTH_MESSAGES.displayNameInvalidChars,
  })
  .refine((val) => val.length >= DISPLAY_NAME_MIN_LENGTH, {
    message: AUTH_MESSAGES.displayNameTooShort,
  })
  .refine((val) => val.length <= DISPLAY_NAME_MAX_LENGTH, {
    message: AUTH_MESSAGES.displayNameTooLong,
  });

// Áp dụng chuẩn hóa NFKC nhưng TUYỆT ĐỐI không `.trim()` và không cắt ngắn mật khẩu > 128 ký tự.
const registrationPasswordSchema = z
  .string({ error: AUTH_MESSAGES.passwordRequired })
  .transform((val) => normalizePassword(val))
  .refine((val) => val.length > 0, { message: AUTH_MESSAGES.passwordRequired })
  .refine((val) => val.length >= PASSWORD_MIN_LENGTH, {
    message: AUTH_MESSAGES.passwordTooShort,
  })
  .refine((val) => val.length <= PASSWORD_MAX_LENGTH, {
    message: AUTH_MESSAGES.passwordTooLong,
  });

export function createRegisterInputSchema(now: () => Date = () => new Date()) {
  return z
    .object({
      email: normalizedEmailSchema,
      password: registrationPasswordSchema,
      displayName: displayNameSchema,
      dateOfBirth: z
        .string({ error: AUTH_MESSAGES.dateOfBirthRequired })
        .trim()
        .min(1, AUTH_MESSAGES.dateOfBirthRequired),
      acceptedTerms: z.literal(true, {
        error: AUTH_MESSAGES.termsRequired,
      }),
      captchaToken: z
        .string({ error: AUTH_MESSAGES.captchaRequired })
        .trim()
        .min(1, AUTH_MESSAGES.captchaRequired)
        .max(4096, AUTH_MESSAGES.captchaInvalid),
    })
    .superRefine((data, ctx) => {
      // 1. Kiểm tra ngày sinh hợp lệ và đủ 13 tuổi tính đến ngày đăng ký.
      const parsedDob = parseStrictIsoDate(data.dateOfBirth);
      if (!parsedDob) {
        ctx.addIssue({
          code: 'custom',
          path: ['dateOfBirth'],
          message: AUTH_MESSAGES.dateOfBirthInvalid,
        });
      } else {
        const referenceDate = now();
        const age = calculateAgeYears(parsedDob, referenceDate);
        if (age < 0 || age > MAX_REGISTRATION_AGE_YEARS) {
          ctx.addIssue({
            code: 'custom',
            path: ['dateOfBirth'],
            message: AUTH_MESSAGES.dateOfBirthOutOfRange,
          });
        } else if (age < MIN_REGISTRATION_AGE_YEARS) {
          ctx.addIssue({
            code: 'custom',
            path: ['dateOfBirth'],
            message: AUTH_MESSAGES.dateOfBirthUnderage,
          });
        }
      }

      // 2. Cấm mật khẩu trùng email, trùng tên hiển thị hoặc nằm trong danh sách mật khẩu phổ biến.
      const passwordComparable = data.password.trim().toLowerCase();
      const displayNameComparable = data.displayName.trim().toLowerCase();

      if (passwordComparable === data.email || passwordComparable.includes(data.email)) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: AUTH_MESSAGES.passwordMatchesEmail,
        });
      } else if (passwordComparable === displayNameComparable) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: AUTH_MESSAGES.passwordMatchesDisplayName,
        });
      } else if (isCommonOrWeakPassword(data.password)) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: AUTH_MESSAGES.passwordTooCommon,
        });
      }
    });
}

export const registerInputSchema = createRegisterInputSchema();

export type RegisterInput = z.infer<typeof registerInputSchema>;

export const verifyEmailInputSchema = z.object({
  email: normalizedEmailSchema,
  otpCode: z
    .string({ error: AUTH_MESSAGES.otpFormatInvalid })
    .trim()
    .regex(OTP_CODE_REGEX, AUTH_MESSAGES.otpFormatInvalid),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailInputSchema>;

export const resendVerificationInputSchema = z.object({
  email: normalizedEmailSchema,
});

export type ResendVerificationInput = z.infer<typeof resendVerificationInputSchema>;
