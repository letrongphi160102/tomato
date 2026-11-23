import { z } from 'zod';

import { normalizeEmail, normalizePassword, normalizeUsername } from '@/core/crypto/normalize';
import { USER_GENDERS } from '@/core/db/schema/enums';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import { isCommonOrWeakPassword } from '@/modules/auth/common-passwords';
import { RESERVED_HANDLES } from '@/modules/profile/handle';

export const EMAIL_MAX_LENGTH = 254;
export const FULL_NAME_MIN_LENGTH = 2;
export const FULL_NAME_MAX_LENGTH = 50;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const MIN_REGISTRATION_AGE_YEARS = 13;
export const MAX_REGISTRATION_AGE_YEARS = 130;
export const OTP_CODE_REGEX = /^\d{6}$/;

const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
// Cấm ký tự điều khiển ASCII (CR, LF, NUL...) để tránh Email Header Injection và lỗi hiển thị.
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/;
const WHITESPACE_REGEX = /\s/;
const USERNAME_ALLOWED_REGEX = /^[a-z0-9._]+$/;
// Chặn ký tự có dấu tiếng Việt (dấu thanh/mũ/móc tổ hợp NFD U+0300–U+036F và chữ đ/Đ U+0110–U+0111).
const VIETNAMESE_DIACRITIC_NFD_REGEX = /[\u0300-\u036f\u0110\u0111\u1EA0-\u1EF9]/;

const RESERVED_USERNAMES: ReadonlySet<string> = RESERVED_HANDLES;

/**
 * Kiểm tra chuỗi có chứa dấu tiếng Việt hoặc chữ `đ`/`Đ` (hỗ trợ cả NFC dựng sẵn lẫn NFD tổ hợp).
 */
export function hasVietnameseDiacritics(value: string): boolean {
  return VIETNAMESE_DIACRITIC_NFD_REGEX.test(value.normalize('NFD'));
}

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

const fullNameSchema = z
  .string({ error: AUTH_MESSAGES.fullNameRequired })
  .transform((val) => val.trim().normalize('NFKC'))
  .refine((val) => val.length > 0, { message: AUTH_MESSAGES.fullNameRequired })
  .refine((val) => !CONTROL_CHARS_REGEX.test(val), {
    message: AUTH_MESSAGES.fullNameInvalidChars,
  })
  .refine((val) => val.length >= FULL_NAME_MIN_LENGTH, {
    message: AUTH_MESSAGES.fullNameTooShort,
  })
  .refine((val) => val.length <= FULL_NAME_MAX_LENGTH, {
    message: AUTH_MESSAGES.fullNameTooLong,
  });

const usernameSchema = z
  .string({ error: AUTH_MESSAGES.usernameRequired })
  .transform((val) => normalizeUsername(val))
  .refine((val) => val.length > 0, { message: AUTH_MESSAGES.usernameRequired })
  .refine((val) => !WHITESPACE_REGEX.test(val), { message: AUTH_MESSAGES.usernameNoSpaces })
  .refine((val) => val.length >= USERNAME_MIN_LENGTH, {
    message: AUTH_MESSAGES.usernameTooShort,
  })
  .refine((val) => val.length <= USERNAME_MAX_LENGTH, {
    message: AUTH_MESSAGES.usernameTooLong,
  })
  .refine((val) => USERNAME_ALLOWED_REGEX.test(val), {
    message: AUTH_MESSAGES.usernameInvalidChars,
  })
  .refine((val) => !val.startsWith('.') && !val.endsWith('.') && !val.includes('..'), {
    message: AUTH_MESSAGES.usernameInvalidDots,
  })
  .refine((val) => !RESERVED_USERNAMES.has(val), {
    message: AUTH_MESSAGES.usernameReserved,
  });

const genderSchema = z.enum(USER_GENDERS, {
  error: AUTH_MESSAGES.genderRequired,
});

export const PASSWORD_RESET_TOKEN_MIN_LENGTH = 32;
export const PASSWORD_RESET_TOKEN_MAX_LENGTH = 512;

export interface PasswordUserContext {
  readonly email: string;
  readonly fullName: string;
  readonly username: string;
}

/**
 * Kiểm tra mật khẩu mới có trùng/chứa email, trùng họ tên, trùng username hoặc nằm trong danh sách
 * mật khẩu quá phổ biến hay không (áp dụng thống nhất cho Đăng ký, Đặt lại mật khẩu và Đổi mật khẩu).
 */
export function getWeakPasswordContextViolation(
  normalizedPassword: string,
  userContext: PasswordUserContext,
): string | null {
  const passwordComparable = normalizedPassword.trim().toLowerCase();
  const emailComparable = userContext.email.trim().toLowerCase();
  const fullNameComparable = userContext.fullName.trim().toLowerCase();
  const usernameComparable = userContext.username.trim().toLowerCase();

  if (
    emailComparable.length > 0 &&
    (passwordComparable === emailComparable || passwordComparable.includes(emailComparable))
  ) {
    return AUTH_MESSAGES.passwordMatchesEmail;
  }
  if (fullNameComparable.length > 0 && passwordComparable === fullNameComparable) {
    return AUTH_MESSAGES.passwordMatchesFullName;
  }
  if (usernameComparable.length > 0 && passwordComparable === usernameComparable) {
    return AUTH_MESSAGES.passwordMatchesUsername;
  }
  if (isCommonOrWeakPassword(normalizedPassword)) {
    return AUTH_MESSAGES.passwordTooCommon;
  }
  return null;
}

// Áp dụng chuẩn hóa NFKC nhưng TUYỆT ĐỐI không `.trim()` và không cắt ngắn mật khẩu > 128 ký tự;
// không ép kiểu ký tự (hoa/số/đặc biệt) nhưng chặn dấu tiếng Việt.
export const strongPasswordSchema = z
  .string({ error: AUTH_MESSAGES.passwordRequired })
  .transform((val) => normalizePassword(val))
  .refine((val) => val.length > 0, { message: AUTH_MESSAGES.passwordRequired })
  .refine((val) => !hasVietnameseDiacritics(val), {
    message: AUTH_MESSAGES.passwordNoVietnameseDiacritics,
  })
  .refine((val) => val.length >= PASSWORD_MIN_LENGTH, {
    message: AUTH_MESSAGES.passwordTooShort,
  })
  .refine((val) => val.length <= PASSWORD_MAX_LENGTH, {
    message: AUTH_MESSAGES.passwordTooLong,
  });

const newPasswordPolicySchema = strongPasswordSchema.refine((val) => !isCommonOrWeakPassword(val), {
  message: AUTH_MESSAGES.passwordTooCommon,
});

export function createRegisterInputSchema(now: () => Date = () => new Date()) {
  return z
    .object({
      fullName: fullNameSchema,
      username: usernameSchema,
      gender: genderSchema,
      email: normalizedEmailSchema,
      password: strongPasswordSchema,
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

      // 2. Cấm mật khẩu trùng email, trùng họ tên, trùng ID tài khoản hoặc nằm trong danh sách mật khẩu phổ biến.
      const passwordViolation = getWeakPasswordContextViolation(data.password, {
        email: data.email,
        fullName: data.fullName,
        username: data.username,
      });
      if (passwordViolation) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: passwordViolation,
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

// Đăng nhập chấp nhận mọi mật khẩu không rỗng <= 128 ký tự (chuẩn hóa NFKC, không trim)
// để mật khẩu sai ngắn hơn 12 ký tự vẫn đi qua nhánh xác minh đồng nhất và trả 401 INVALID_CREDENTIALS.
const loginPasswordSchema = z
  .string({ error: AUTH_MESSAGES.passwordRequired })
  .transform((val) => normalizePassword(val))
  .refine((val) => val.length > 0, { message: AUTH_MESSAGES.passwordRequired })
  .refine((val) => val.length <= PASSWORD_MAX_LENGTH, {
    message: AUTH_MESSAGES.passwordTooLong,
  });

export const loginInputSchema = z.object({
  email: normalizedEmailSchema,
  password: loginPasswordSchema,
  // Trường tùy chọn sẵn sàng cho ngưỡng Turnstile nâng cao tại Cột mốc M5.
  captchaToken: z.string().trim().max(4096).optional(),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

export const SESSION_PUBLIC_ID_REGEX = /^[A-Za-z0-9_-]{1,36}$/;

export const sessionPublicIdParamSchema = z
  .string()
  .trim()
  .regex(SESSION_PUBLIC_ID_REGEX, AUTH_MESSAGES.sessionNotFound);

export const revokeAllSessionsInputSchema = z.object({
  includeCurrent: z.boolean().default(false),
});

export type RevokeAllSessionsInput = z.infer<typeof revokeAllSessionsInputSchema>;

export const forgotPasswordInputSchema = z.object({
  email: normalizedEmailSchema,
  // Trường tùy chọn sẵn sàng cho ngưỡng Turnstile nâng cao tại Cột mốc M5 (giống `/login`).
  captchaToken: z.string().trim().max(4096).optional(),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordInputSchema>;

export const resetPasswordInputSchema = z.object({
  token: z
    .string({ error: AUTH_MESSAGES.resetTokenInvalidOrExpired })
    .trim()
    .min(PASSWORD_RESET_TOKEN_MIN_LENGTH, AUTH_MESSAGES.resetTokenInvalidOrExpired)
    .max(PASSWORD_RESET_TOKEN_MAX_LENGTH, AUTH_MESSAGES.resetTokenInvalidOrExpired),
  newPassword: newPasswordPolicySchema,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;

const currentPasswordSchema = z
  .string({ error: AUTH_MESSAGES.currentPasswordRequired })
  .transform((val) => normalizePassword(val))
  .refine((val) => val.length > 0, { message: AUTH_MESSAGES.currentPasswordRequired })
  .refine((val) => val.length <= PASSWORD_MAX_LENGTH, {
    message: AUTH_MESSAGES.passwordTooLong,
  });

export const verifyPasswordChangeOtpInputSchema = z.object({
  otpCode: z
    .string({ error: AUTH_MESSAGES.otpFormatInvalid })
    .trim()
    .regex(OTP_CODE_REGEX, AUTH_MESSAGES.otpFormatInvalid),
});

export type VerifyPasswordChangeOtpInput = z.infer<typeof verifyPasswordChangeOtpInputSchema>;

export const changePasswordInputSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    newPassword: newPasswordPolicySchema,
  })
  .superRefine((data, ctx) => {
    if (data.newPassword === data.currentPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['newPassword'],
        message: AUTH_MESSAGES.newPasswordSameAsCurrent,
      });
    }
  });

export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
