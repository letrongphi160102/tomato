import { describe, expect, it } from 'vitest';

import {
  calculateAgeYears,
  createRegisterInputSchema,
  parseStrictIsoDate,
  resendVerificationInputSchema,
  verifyEmailInputSchema,
} from '@/modules/auth/auth.schemas';

const FIXED_NOW = () => new Date('2026-11-22T00:00:00.000Z');
const registerSchema = createRegisterInputSchema(FIXED_NOW);

function buildValidRegisterPayload(overrides: Record<string, unknown> = {}) {
  return {
    email: '  Minh.Anh@Example.COM  ',
    password: 'cụm mật khẩu an toàn đủ dài 2026',
    displayName: '  Minh Anh  ',
    dateOfBirth: '2000-05-10',
    acceptedTerms: true,
    captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
    ...overrides,
  };
}

describe('Unit M2: Auth Zod Schemas & Validation Rules', () => {
  it('chuẩn hóa email NFKC + lowercase + trim, giữ nguyên khoảng trắng đầu cuối mật khẩu và chấp nhận Unicode', () => {
    const rawPassword = '  Mật khẩu tiếng Việt có dấu 🍅 2026  ';
    const parsed = registerSchema.parse(
      buildValidRegisterPayload({
        email: '  Ｕｓｅｒ＠Example.COM ',
        password: rawPassword,
      }),
    );

    expect(parsed.email).toBe('user@example.com');
    expect(parsed.displayName).toBe('Minh Anh');
    // Tuyệt đối không trim mật khẩu: khoảng trắng đầu/cuối phải được bảo toàn.
    expect(parsed.password).toBe(rawPassword.normalize('NFKC'));
  });

  it('chặn mật khẩu < 12 ký tự và > 128 ký tự (không tự cắt ngắn)', () => {
    const tooShort = registerSchema.safeParse(
      buildValidRegisterPayload({ password: 'abc12345678' }),
    );
    expect(tooShort.success).toBe(false);

    const exact12 = registerSchema.safeParse(
      buildValidRegisterPayload({ password: 'xK9!mQ2#vL8$' }),
    );
    expect(exact12.success).toBe(true);

    const exact128 = registerSchema.safeParse(
      buildValidRegisterPayload({ password: 'aB3!'.repeat(32) }),
    );
    expect(exact128.success).toBe(true);

    const tooLong129 = registerSchema.safeParse(
      buildValidRegisterPayload({ password: `${'aB3!'.repeat(32)}x` }),
    );
    expect(tooLong129.success).toBe(false);
    if (!tooLong129.success) {
      expect(tooLong129.error.issues.some((issue) => issue.path[0] === 'password')).toBe(true);
    }
  });

  it('chặn mật khẩu trùng email, chứa email, trùng displayName hoặc thuộc danh sách phổ biến', () => {
    const sameAsEmail = registerSchema.safeParse(
      buildValidRegisterPayload({
        email: 'alice.secure@example.com',
        password: 'ALICE.SECURE@EXAMPLE.COM',
      }),
    );
    expect(sameAsEmail.success).toBe(false);

    const containsEmail = registerSchema.safeParse(
      buildValidRegisterPayload({
        email: 'alice@example.com',
        password: 'prefix-alice@example.com-suffix',
      }),
    );
    expect(containsEmail.success).toBe(false);

    const sameAsDisplayName = registerSchema.safeParse(
      buildValidRegisterPayload({
        displayName: 'Nguyễn Minh Anh',
        password: 'nguyễn minh anh',
      }),
    );
    expect(sameAsDisplayName.success).toBe(false);

    for (const weak of [
      'password1234',
      '123456789012',
      'tomato123456',
      'matkhau12345',
      'aaaaaaaaaaaa',
      '987654321098',
    ]) {
      const res = registerSchema.safeParse(buildValidRegisterPayload({ password: weak }));
      expect(res.success, `Mật khẩu yếu "${weak}" phải bị chặn`).toBe(false);
    }
  });

  it('kiểm tra nghiêm ngặt ngày sinh hợp lệ và ranh giới đúng 13 tuổi (kể cả năm nhuận)', () => {
    // Ngày không tồn tại trên lịch thực tế.
    expect(parseStrictIsoDate('2024-02-30')).toBeNull();
    expect(parseStrictIsoDate('2023-02-29')).toBeNull();
    expect(parseStrictIsoDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });

    // Sinh nhật 29/02 năm nhuận: trước 01/03 chưa đủ 13 tuổi, sang 01/03 đủ 13 tuổi.
    const leapDob = parseStrictIsoDate('2012-02-29')!;
    expect(calculateAgeYears(leapDob, new Date('2025-02-28T12:00:00Z'))).toBe(12);
    expect(calculateAgeYears(leapDob, new Date('2025-03-01T12:00:00Z'))).toBe(13);

    // Đúng ngày sinh nhật 13 tuổi (2013-11-22 tại mốc 2026-11-22) -> HỢP LỆ.
    const exact13 = registerSchema.safeParse(
      buildValidRegisterPayload({ dateOfBirth: '2013-11-22' }),
    );
    expect(exact13.success).toBe(true);

    // Thiếu 1 ngày mới đủ 13 tuổi (2013-11-23 tại mốc 2026-11-22) -> BỊ CHẶN.
    const underageByOneDay = registerSchema.safeParse(
      buildValidRegisterPayload({ dateOfBirth: '2013-11-23' }),
    );
    expect(underageByOneDay.success).toBe(false);

    // Ngày ảo hoặc ngày tương lai -> BỊ CHẶN.
    expect(
      registerSchema.safeParse(buildValidRegisterPayload({ dateOfBirth: '2010-02-30' })).success,
    ).toBe(false);
    expect(
      registerSchema.safeParse(buildValidRegisterPayload({ dateOfBirth: '2027-01-01' })).success,
    ).toBe(false);
  });

  it('chặn displayName ngoài 2-50 ký tự, ký tự điều khiển, chưa tick điều khoản hoặc thiếu captchaToken', () => {
    expect(registerSchema.safeParse(buildValidRegisterPayload({ displayName: 'A' })).success).toBe(
      false,
    );
    expect(
      registerSchema.safeParse(buildValidRegisterPayload({ displayName: 'A'.repeat(51) })).success,
    ).toBe(false);
    expect(
      registerSchema.safeParse(buildValidRegisterPayload({ displayName: 'Minh\r\nBcc:evil@x.com' }))
        .success,
    ).toBe(false);
    expect(
      registerSchema.safeParse(buildValidRegisterPayload({ acceptedTerms: false })).success,
    ).toBe(false);
    expect(
      registerSchema.safeParse(buildValidRegisterPayload({ captchaToken: '   ' })).success,
    ).toBe(false);
  });

  it('validate chính xác verifyEmailInputSchema và resendVerificationInputSchema', () => {
    const verified = verifyEmailInputSchema.parse({
      email: ' Test@Example.com ',
      otpCode: ' 042198 ',
    });
    expect(verified).toEqual({ email: 'test@example.com', otpCode: '042198' });

    expect(
      verifyEmailInputSchema.safeParse({ email: 'test@example.com', otpCode: '12345' }).success,
    ).toBe(false);
    expect(
      verifyEmailInputSchema.safeParse({ email: 'test@example.com', otpCode: '12345a' }).success,
    ).toBe(false);

    const resend = resendVerificationInputSchema.parse({ email: '  USER@TOMATO.VN ' });
    expect(resend).toEqual({ email: 'user@tomato.vn' });
  });
});
