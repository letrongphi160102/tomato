/**
 * Danh sách mật khẩu cực kỳ phổ biến cơ bản (đã viết thường) bổ sung cho quy tắc tối thiểu 12 ký tự.
 * Giai đoạn P1 sẽ mở rộng thêm kiểm tra HIBP k-anonymity theo Mục 2.2.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789012345',
  '1234567890123456',
  '012345678901',
  '0123456789012',
  '123123123123',
  '123412341234',
  '000000000000',
  '111111111111',
  '999999999999',
  'password1234',
  'password12345',
  'password123456',
  'password123!',
  'password@123',
  'password@1234',
  'p@ssword1234',
  'passw0rd1234',
  'qwerty123456',
  'qwertyuiop12',
  'qwertyuiopas',
  'qwertyuiopasdf',
  'asdfghjkl123',
  'zxcvbnm12345',
  'iloveyou1234',
  'iloveyou12345',
  'admin1234567',
  'admin@123456',
  'administrator',
  'administrator1',
  'welcome12345',
  'welcome123456',
  'letmein12345',
  'letmein123456',
  'monkey123456',
  'dragon123456',
  'football1234',
  'baseball1234',
  'sunshine1234',
  'princess1234',
  'trustno12345',
  'changeme1234',
  'correcthorsebatterystaple',
  'abcdefghijkl',
  'abcdefghijklm',
  'abcdefghijklmnop',
  'tomato123456',
  'tomato@12345',
  'tomatopassword',
  'matkhau12345',
  'matkhau123456',
  'matkhau@1234',
  'vietnam12345',
  'vietnam123456',
  'anhyeuem1234',
  'anhyeuem12345',
  'emyeuanh1234',
  'khongbiet123',
  'khongcomatkhau',
  '123456789abc',
  'abc123456789',
]);

const REPEATED_SINGLE_CHAR_REGEX = /^(.)\1+$/u;
const ASCENDING_DIGITS = '012345678901234567890123456789';
const DESCENDING_DIGITS = '987654321098765432109876543210';

/**
 * Kiểm tra mật khẩu đã chuẩn hóa NFKC có rơi vào danh sách cực kỳ phổ biến,
 * toàn ký tự lặp đơn lẻ (ví dụ `aaaaaaaaaaaa`) hoặc dãy số liên tiếp thuần túy hay không.
 */
export function isCommonOrWeakPassword(normalizedPassword: string): boolean {
  const lowered = normalizedPassword.trim().toLowerCase();
  if (!lowered) {
    return true;
  }

  if (COMMON_PASSWORDS.has(lowered)) {
    return true;
  }

  if (REPEATED_SINGLE_CHAR_REGEX.test(lowered)) {
    return true;
  }

  if (
    /^\d+$/.test(lowered) &&
    lowered.length <= 20 &&
    (ASCENDING_DIGITS.includes(lowered) || DESCENDING_DIGITS.includes(lowered))
  ) {
    return true;
  }

  return false;
}
