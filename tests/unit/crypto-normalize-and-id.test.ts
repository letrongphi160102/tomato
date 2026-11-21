import { describe, expect, it } from 'vitest';

import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { normalizeEmail, normalizePassword } from '@/core/crypto/normalize';

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('normalizeEmail & normalizePassword', () => {
  it('chuẩn hóa email: trim khoảng trắng, NFKC cho ký tự full-width và chuyển chữ thường', () => {
    expect(normalizeEmail('  User.Name+Tag@Example.COM \t\n ')).toBe('user.name+tag@example.com');
    // Ký tự Unicode full-width (ＵＳＥＲ＠ＥＸＡＭＰＬＥ．ＣＯＭ) phải quy về ASCII tương đương.
    expect(normalizeEmail('  ＵＳＥＲ＠ＥＸＡＭＰＬＥ．ＣＯＭ  ')).toBe('user@example.com');
    // Tổ hợp dấu tách rời (NFD) phải hợp nhất tương đương với bản dựng sẵn sau NFKC.
    const nfdEmail = 'nguye\u0302\u0303n@example.com';
    const nfcEmail = 'nguyễn@example.com';
    expect(normalizeEmail(nfdEmail)).toBe(normalizeEmail(nfcEmail));
  });

  it('chuẩn hóa mật khẩu theo NFKC và tuyệt đối KHÔNG trim khoảng trắng đầu/cuối', () => {
    expect(normalizePassword('  pass phrase with spaces  ')).toBe('  pass phrase with spaces  ');
    // Ký tự tương thích NFKC (ví dụ chữ số full-width hoặc ligature ﬁ) phải được chuẩn hóa đồng nhất.
    expect(normalizePassword(' Ｐａｓｓ１２３ﬁ ')).toBe(' Pass123fi ');
    expect(normalizePassword('  secret  ')).not.toBe(normalizePassword('secret'));
  });
});

describe('generateUuidV7 & generatePublicId', () => {
  it('generateUuidV7 sinh đúng định dạng UUIDv7 và tăng dần theo thời gian', () => {
    const ids = Array.from({ length: 20 }, () => generateUuidV7());

    for (const id of ids) {
      expect(id).toMatch(UUID_V7_REGEX);
    }

    expect(new Set(ids).size).toBe(ids.length);

    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it('generatePublicId sinh UUIDv4 ngẫu nhiên hợp lệ (<= 36 ký tự) và không trùng lặp', () => {
    const publicIds = Array.from({ length: 25 }, () => generatePublicId());

    for (const publicId of publicIds) {
      expect(publicId).toMatch(UUID_V4_REGEX);
      expect(publicId.length).toBe(36);
    }

    expect(new Set(publicIds).size).toBe(publicIds.length);
  });
});
