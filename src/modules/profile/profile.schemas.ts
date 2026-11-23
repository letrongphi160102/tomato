import '@/core/validation/zod-config';
import { z } from 'zod';

import { FULL_NAME_MAX_LENGTH, FULL_NAME_MIN_LENGTH } from '@/modules/auth/auth.schemas';
import {
  BIO_MAX_LENGTH,
  BIO_MAX_LINES,
  HANDLE_ALLOWED_REGEX,
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  RESERVED_HANDLES,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
  SEARCH_RESULT_MAX_LIMIT,
  UNSAFE_MULTILINE_CHARS_REGEX,
  UNSAFE_SINGLE_LINE_CHARS_REGEX,
  normalizeBio,
  normalizeHandle,
  normalizeSearchQuery,
} from '@/modules/profile/handle';
import { PROFILE_MESSAGES } from '@/modules/profile/profile.messages';

const WHITESPACE_REGEX = /\s/;

export const profileHandleSchema = z
  .string({ error: PROFILE_MESSAGES.handleRequired })
  .transform((val) => normalizeHandle(val))
  .refine((val) => val.length > 0, { message: PROFILE_MESSAGES.handleRequired })
  .refine((val) => !WHITESPACE_REGEX.test(val), { message: PROFILE_MESSAGES.handleNoSpaces })
  .refine((val) => val.length >= HANDLE_MIN_LENGTH, { message: PROFILE_MESSAGES.handleTooShort })
  .refine((val) => val.length <= HANDLE_MAX_LENGTH, { message: PROFILE_MESSAGES.handleTooLong })
  .refine((val) => HANDLE_ALLOWED_REGEX.test(val), { message: PROFILE_MESSAGES.handleInvalidChars })
  .refine((val) => !val.startsWith('.') && !val.endsWith('.') && !val.includes('..'), {
    message: PROFILE_MESSAGES.handleInvalidDots,
  })
  .refine((val) => !RESERVED_HANDLES.has(val), { message: PROFILE_MESSAGES.handleReserved });

export const profileFullNameSchema = z
  .string({ error: PROFILE_MESSAGES.fullNameRequired })
  .transform((val) => val.trim().normalize('NFKC'))
  .refine((val) => val.length > 0, { message: PROFILE_MESSAGES.fullNameRequired })
  .refine((val) => !UNSAFE_SINGLE_LINE_CHARS_REGEX.test(val), {
    message: PROFILE_MESSAGES.fullNameInvalidChars,
  })
  .refine((val) => val.length >= FULL_NAME_MIN_LENGTH, {
    message: PROFILE_MESSAGES.fullNameTooShort,
  })
  .refine((val) => val.length <= FULL_NAME_MAX_LENGTH, {
    message: PROFILE_MESSAGES.fullNameTooLong,
  });

export const profileBioSchema = z
  .string()
  .transform((val) => normalizeBio(val))
  .refine((val) => !UNSAFE_MULTILINE_CHARS_REGEX.test(val), {
    message: PROFILE_MESSAGES.bioInvalidChars,
  })
  .refine((val) => val.length <= BIO_MAX_LENGTH, {
    message: PROFILE_MESSAGES.bioTooLong,
  })
  .refine((val) => (val === '' ? 0 : val.split('\n').length) <= BIO_MAX_LINES, {
    message: PROFILE_MESSAGES.bioTooManyLines,
  });

/**
 * Schema cập nhật hồ sơ cá nhân: bắt buộc `.strict()` để từ chối mọi trường lạ (chống Mass Assignment / BOPLA).
 */
export const updateOwnProfileInputSchema = z
  .object({
    fullName: profileFullNameSchema.optional(),
    handle: profileHandleSchema.optional(),
    bio: profileBioSchema.optional(),
  })
  .strict()
  .refine(
    (data) => data.fullName !== undefined || data.handle !== undefined || data.bio !== undefined,
    {
      message: PROFILE_MESSAGES.updateEmptyPayload,
    },
  );

export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileInputSchema>;

/**
 * Schema tra cứu đường dẫn `/api/v1/users/:handle`: kiểm tra sơ bộ ký tự hợp lệ trước khi truy DB.
 */
export const handleRouteParamSchema = z
  .string()
  .transform((val) => normalizeHandle(val))
  .refine((val) => val.length >= HANDLE_MIN_LENGTH && val.length <= HANDLE_MAX_LENGTH, {
    message: PROFILE_MESSAGES.profileNotFound,
  })
  .refine((val) => HANDLE_ALLOWED_REGEX.test(val), {
    message: PROFILE_MESSAGES.profileNotFound,
  })
  .refine((val) => !val.startsWith('.') && !val.endsWith('.') && !val.includes('..'), {
    message: PROFILE_MESSAGES.profileNotFound,
  });

/**
 * Schema truy vấn tìm kiếm `GET /api/v1/users/search?q=...&limit=...` (`.strict()` từ chối query lạ).
 */
export const searchUsersQuerySchema = z
  .object({
    q: z
      .string({ error: PROFILE_MESSAGES.searchQueryTooShort })
      .transform((val) => normalizeSearchQuery(val))
      .refine((val) => val.length >= SEARCH_QUERY_MIN_LENGTH, {
        message: PROFILE_MESSAGES.searchQueryTooShort,
      })
      .refine((val) => val.length <= SEARCH_QUERY_MAX_LENGTH, {
        message: PROFILE_MESSAGES.searchQueryTooLong,
      }),
    limit: z
      .union([z.number(), z.string()])
      .optional()
      .transform((val) => {
        if (val === undefined || val === '') {
          return SEARCH_RESULT_MAX_LIMIT;
        }
        return typeof val === 'number' ? val : Number(val);
      })
      .refine((val) => Number.isInteger(val) && val >= 1 && val <= SEARCH_RESULT_MAX_LIMIT, {
        message: PROFILE_MESSAGES.searchLimitInvalid,
      }),
  })
  .strict();

export type SearchUsersQueryInput = z.infer<typeof searchUsersQuerySchema>;
