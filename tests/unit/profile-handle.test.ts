import { describe, expect, it } from 'vitest';

import {
  RESERVED_HANDLES,
  escapeSqlLikePattern,
  isReservedHandle,
  normalizeBio,
  normalizeHandle,
  normalizeSearchQuery,
  validateNormalizedHandle,
} from '@/modules/profile/handle';
import {
  handleRouteParamSchema,
  searchUsersQuerySchema,
  updateOwnProfileInputSchema,
} from '@/modules/profile/profile.schemas';

describe('Unit M6: Chuẩn hóa @handle, từ khóa cấm & validation hồ sơ', () => {
  it('chuẩn hóa NFKC, gỡ tối đa 1 dấu @ đầu và chuyển chữ thường', () => {
    expect(normalizeHandle('@Minh_Anh.2026')).toBe('minh_anh.2026');
    expect(normalizeHandle('＠ＡｂＣ_123')).toBe('abc_123');
    expect(normalizeHandle('Nguyen.Van.A')).toBe('nguyen.van.a');
    expect(normalizeHandle('@@double_at')).toBe('@double_at');
  });

  it('chấp nhận các @handle hợp lệ dài 3–30 ký tự gồm [a-z0-9._]', () => {
    for (const valid of ['abc', 'a.b', 'user_01', 'nguyen.minh_anh.2026', 'a'.repeat(30)]) {
      const result = validateNormalizedHandle(valid);
      expect(result, `Handle "${valid}" phải hợp lệ`).toEqual({
        valid: true,
        normalized: valid,
      });
    }
  });

  it('chặn @handle sai độ dài, chứa khoảng trắng, dấu tiếng Việt, homoglyph Cyrillic hoặc dấu chấm sai quy tắc', () => {
    const cases: Array<[string, string]> = [
      ['', 'REQUIRED'],
      ['@', 'REQUIRED'],
      ['ab', 'TOO_SHORT'],
      ['a'.repeat(31), 'TOO_LONG'],
      ['minh anh', 'NO_SPACES'],
      [' minhanh', 'NO_SPACES'],
      ['minhanh ', 'NO_SPACES'],
      ['minh-anh', 'INVALID_CHARS'],
      ['minh_ánh', 'INVALID_CHARS'],
      ['@@minhanh', 'INVALID_CHARS'],
      // Ký tự Cyrillic đồng dạng ('а' U+0430 thay vì ASCII 'a') -> phải bị chặn chống giả mạo.
      ['\u0430dmin_fake', 'INVALID_CHARS'],
      ['minh\u202eanh', 'INVALID_CHARS'],
      ['.minhanh', 'INVALID_DOTS'],
      ['minhanh.', 'INVALID_DOTS'],
      ['minh..anh', 'INVALID_DOTS'],
    ];

    for (const [input, expectedCode] of cases) {
      const result = validateNormalizedHandle(input);
      expect(result, `Handle "${input}" phải trả lỗi ${expectedCode}`).toEqual({
        valid: false,
        code: expectedCode,
      });
    }
  });

  it('chặn toàn bộ từ khóa hệ thống dành riêng (Giai đoạn 1 + Giai đoạn 2)', () => {
    for (const reserved of [
      'admin',
      '@ADMIN',
      'support',
      'tomato',
      'settings',
      'messages',
      'api',
      'login',
      'register',
      'explore',
      'notifications',
      'profile',
      'privacy',
      'calls',
      'official',
      'system',
      'root',
    ]) {
      expect(isReservedHandle(reserved), `"${reserved}" phải nằm trong danh sách cấm`).toBe(true);
      expect(validateNormalizedHandle(reserved)).toEqual({
        valid: false,
        code: 'RESERVED',
      });
    }
    expect(RESERVED_HANDLES.size).toBeGreaterThanOrEqual(40);
  });

  it('updateOwnProfileInputSchema dùng .strict() từ chối field lạ và chặn ký tự Bidi/RTL override', () => {
    const valid = updateOwnProfileInputSchema.parse({
      fullName: '  Nguyễn Minh Anh  ',
      handle: '@Minh.Anh_99',
      bio: '  Xin chào Tomato\r\nThích chụp ảnh  ',
    });
    expect(valid).toEqual({
      fullName: 'Nguyễn Minh Anh',
      handle: 'minh.anh_99',
      bio: 'Xin chào Tomato\nThích chụp ảnh',
    });

    // Mass Assignment / BOPLA: từ chối mọi trường lạ.
    const withExtraField = updateOwnProfileInputSchema.safeParse({
      fullName: 'Nguyễn Minh Anh',
      isPrivate: true,
    });
    expect(withExtraField.success).toBe(false);

    // Chặn payload rỗng không đổi trường nào.
    expect(updateOwnProfileInputSchema.safeParse({}).success).toBe(false);

    // Chặn RTL override U+202E và các ký tự Bidi isolate trong fullName và bio.
    expect(updateOwnProfileInputSchema.safeParse({ fullName: 'Minh \u202EAnh' }).success).toBe(
      false,
    );
    expect(
      updateOwnProfileInputSchema.safeParse({ bio: 'Xin chào \u2066Tomato\u2069' }).success,
    ).toBe(false);

    // Bio quá 160 ký tự hoặc quá 4 dòng bị chặn.
    expect(updateOwnProfileInputSchema.safeParse({ bio: 'a'.repeat(161) }).success).toBe(false);
    expect(updateOwnProfileInputSchema.safeParse({ bio: '1\n2\n3\n4\n5' }).success).toBe(false);
    expect(normalizeBio('  dòng 1\r\ndòng 2  ')).toBe('dòng 1\ndòng 2');
  });

  it('chuẩn hóa từ khóa tìm kiếm, escape wildcard SQL và validate query chặt', () => {
    expect(normalizeSearchQuery('  @Minh_Anh  ')).toBe('Minh_Anh');
    expect(normalizeSearchQuery('a\u202Ebc')).toBe('abc');
    expect(escapeSqlLikePattern('100%_test\\path')).toBe('100\\%\\_test\\\\path');

    expect(searchUsersQuerySchema.parse({ q: ' @an ' })).toEqual({ q: 'an', limit: 20 });
    expect(searchUsersQuerySchema.parse({ q: 'minh', limit: '5' })).toEqual({
      q: 'minh',
      limit: 5,
    });
    expect(searchUsersQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(searchUsersQuerySchema.safeParse({ q: 'minh', limit: '21' }).success).toBe(false);
    expect(searchUsersQuerySchema.safeParse({ q: 'minh', email: 'x@y.com' }).success).toBe(false);

    expect(handleRouteParamSchema.parse('@Minh.Anh')).toBe('minh.anh');
    expect(handleRouteParamSchema.safeParse('../etc/passwd').success).toBe(false);
  });
});
