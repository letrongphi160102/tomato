import { describe, expect, it } from 'vitest';

import {
  calculateAgeYears,
  changePasswordInputSchema,
  createRegisterInputSchema,
  forgotPasswordInputSchema,
  getWeakPasswordContextViolation,
  hasVietnameseDiacritics,
  parseStrictIsoDate,
  resendVerificationInputSchema,
  resetPasswordInputSchema,
  verifyEmailInputSchema,
} from '@/modules/auth/auth.schemas';

const FIXED_NOW = () => new Date('2026-11-22T00:00:00.000Z');
const registerSchema = createRegisterInputSchema(FIXED_NOW);

function buildValidRegisterPayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: '  Nguyễn Minh Anh  ',
    username: 'Minh_Anh.2026',
    gender: 'female',
    email: '  Minh.Anh@Example.COM  ',
    password: 'my secure passphrase 2026',
    dateOfBirth: '2000-05-10',
    acceptedTerms: true,
    captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
    ...overrides,
  };
}

describe('Unit M2: Auth Zod Schemas & Validation Rules', () => {
  it('chuẩn hóa email, fullName, username (@handle) và giữ nguyên khoảng trắng đầu cuối mật khẩu không dấu', () => {
    const rawPassword = '  safe pass phrase 2026!  ';
    const parsed = registerSchema.parse(
      buildValidRegisterPayload({
        email: '  Ｕｓｅｒ＠Example.COM ',
        username: '@Minh_Anh.99',
        fullName: '  Nguyễn Minh Anh  ',
        gender: 'male',
        password: rawPassword,
      }),
    );

    expect(parsed.email).toBe('user@example.com');
    expect(parsed.username).toBe('minh_anh.99');
    expect(parsed.fullName).toBe('Nguyễn Minh Anh');
    expect(parsed.gender).toBe('male');
    // Tuyệt đối không trim mật khẩu: khoảng trắng đầu/cuối phải được bảo toàn.
    expect(parsed.password).toBe(rawPassword.normalize('NFKC'));
  });

  it('chặn mật khẩu có dấu tiếng Việt (cả NFC lẫn NFD và chữ đ/Đ) nhưng không ép hoa/số/ký tự đặc biệt', () => {
    expect(hasVietnameseDiacritics('mat khau khong dau 2026')).toBe(false);
    expect(hasVietnameseDiacritics('mật khẩu có dấu')).toBe(true);
    expect(hasVietnameseDiacritics('dong ho dien tu')).toBe(false);
    expect(hasVietnameseDiacritics('đồng hồ điện tử')).toBe(true);
    expect(hasVietnameseDiacritics('Đơn giản thôi')).toBe(true);
    expect(hasVietnameseDiacritics('mat khau a\u0301 2026')).toBe(true);

    // Không ép chữ hoa/số/ký tự đặc biệt: chỉ cần >= 12 ký tự không dấu tiếng Việt.
    const simpleLowercase = registerSchema.safeParse(
      buildValidRegisterPayload({ password: 'quiet river morning walk' }),
    );
    expect(simpleLowercase.success).toBe(true);

    // Chặn các mật khẩu có dấu tiếng Việt hoặc chữ đ/Đ.
    for (const vnPass of [
      'mật khẩu an toàn 2026',
      'Mat khau tieng Viet co dau 2026 á',
      'di choi dau do 2026 đ',
      'Duong pho Ha Noi Đ 2026',
      'safe pass a\u0301 2026',
    ]) {
      const res = registerSchema.safeParse(buildValidRegisterPayload({ password: vnPass }));
      expect(res.success, `Mật khẩu có dấu "${vnPass}" phải bị chặn`).toBe(false);
    }
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

  it('chặn mật khẩu trùng email, chứa email, trùng fullName, trùng username hoặc thuộc danh sách phổ biến', () => {
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

    const sameAsFullName = registerSchema.safeParse(
      buildValidRegisterPayload({
        fullName: 'Nguyen Minh Anh',
        password: 'nguyen minh anh',
      }),
    );
    expect(sameAsFullName.success).toBe(false);

    const sameAsUsername = registerSchema.safeParse(
      buildValidRegisterPayload({
        username: 'minh_anh_2026',
        password: 'minh_anh_2026',
      }),
    );
    expect(sameAsUsername.success).toBe(false);

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

  it('kiểm tra nghiêm ngặt ID Tài khoản (username không khoảng trắng, không dấu, giống @username TikTok/Instagram) và giới tính', () => {
    for (const invalidUsername of [
      '',
      'ab',
      'a'.repeat(31),
      'minh anh',
      ' minhanh',
      'minhanh ',
      'minh_ánh',
      'minh-anh',
      'minh@anh',
      '.minhanh',
      'minhanh.',
      'minh..anh',
      'admin',
      'tomato',
    ]) {
      const res = registerSchema.safeParse(
        buildValidRegisterPayload({ username: invalidUsername }),
      );
      expect(res.success, `Username không hợp lệ "${invalidUsername}" phải bị chặn`).toBe(false);
    }

    expect(registerSchema.safeParse(buildValidRegisterPayload({ gender: '' })).success).toBe(false);
    expect(registerSchema.safeParse(buildValidRegisterPayload({ gender: 'unknown' })).success).toBe(
      false,
    );
    expect(registerSchema.safeParse(buildValidRegisterPayload({ gender: 'other' })).success).toBe(
      true,
    );
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

  it('chặn fullName ngoài 2-50 ký tự, ký tự điều khiển, chưa tick điều khoản hoặc thiếu captchaToken', () => {
    expect(registerSchema.safeParse(buildValidRegisterPayload({ fullName: 'A' })).success).toBe(
      false,
    );
    expect(
      registerSchema.safeParse(buildValidRegisterPayload({ fullName: 'A'.repeat(51) })).success,
    ).toBe(false);
    expect(
      registerSchema.safeParse(buildValidRegisterPayload({ fullName: 'Minh\r\nBcc:evil@x.com' }))
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

  it('validate chính xác forgotPasswordInputSchema, resetPasswordInputSchema và changePasswordInputSchema (M4)', () => {
    const forgot = forgotPasswordInputSchema.parse({ email: '  Ｕｓｅｒ＠Tomato.VN  ' });
    expect(forgot.email).toBe('user@tomato.vn');

    const validResetToken = 'a'.repeat(43);
    const resetOk = resetPasswordInputSchema.safeParse({
      token: ` ${validResetToken} `,
      newPassword: '  my brand new safe passphrase 2026  ',
    });
    expect(resetOk.success).toBe(true);
    if (resetOk.success) {
      expect(resetOk.data.token).toBe(validResetToken);
      // Không trim khoảng trắng ở mật khẩu mới.
      expect(resetOk.data.newPassword).toBe('  my brand new safe passphrase 2026  ');
    }

    expect(
      resetPasswordInputSchema.safeParse({
        token: 'short-token',
        newPassword: 'valid passphrase long enough 2026',
      }).success,
    ).toBe(false);

    expect(
      resetPasswordInputSchema.safeParse({
        token: validResetToken,
        newPassword: 'mat khau co dau tieng viet á 2026',
      }).success,
    ).toBe(false);

    expect(
      resetPasswordInputSchema.safeParse({
        token: validResetToken,
        newPassword: 'password123456',
      }).success,
    ).toBe(false);

    // Đổi mật khẩu: cấm trùng mật khẩu hiện tại (kể cả sau chuẩn hóa NFKC).
    const samePass = changePasswordInputSchema.safeParse({
      currentPassword: 'old safe passphrase 2026!',
      newPassword: 'old safe passphrase 2026!',
      otpCode: '123456',
    });
    expect(samePass.success).toBe(false);
    if (!samePass.success) {
      expect(samePass.error.issues.some((i) => i.path[0] === 'newPassword')).toBe(true);
    }

    const changeOk = changePasswordInputSchema.safeParse({
      currentPassword: 'old safe passphrase 2026!',
      newPassword: 'brand new passphrase 2027!',
      otpCode: ' 049821 ',
    });
    expect(changeOk.success).toBe(true);
    if (changeOk.success) {
      expect(changeOk.data.otpCode).toBe('049821');
    }

    expect(
      getWeakPasswordContextViolation('prefix-alice@example.com-suffix', {
        email: 'alice@example.com',
        fullName: 'Alice Nguyen',
        username: 'alice_ng',
      }),
    ).toBeTruthy();
    expect(
      getWeakPasswordContextViolation('completely independent passphrase 2026', {
        email: 'alice@example.com',
        fullName: 'Alice Nguyen',
        username: 'alice_ng',
      }),
    ).toBeNull();
  });
});
