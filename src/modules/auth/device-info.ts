const MAX_USER_AGENT_PARSE_LENGTH = 512;
const MAX_DEVICE_INFO_LENGTH = 255;
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;

export const UNKNOWN_DEVICE_LABEL = 'Thiết bị không xác định';

function matchMajorVersion(ua: string, pattern: RegExp): string | null {
  const match = pattern.exec(ua);
  const version = match?.[1];
  return version && /^\d{1,4}$/.test(version) ? version : null;
}

function detectBrowser(ua: string): string | null {
  const edgeVersion = matchMajorVersion(ua, /\b(?:Edg|EdgA|EdgiOS)\/(\d{1,4})/);
  if (edgeVersion) {
    return `Edge ${edgeVersion}`;
  }

  const operaVersion = matchMajorVersion(ua, /\b(?:OPR|Opera)\/(\d{1,4})/);
  if (operaVersion) {
    return `Opera ${operaVersion}`;
  }

  const samsungVersion = matchMajorVersion(ua, /\bSamsungBrowser\/(\d{1,4})/);
  if (samsungVersion) {
    return `Samsung Internet ${samsungVersion}`;
  }

  const firefoxVersion = matchMajorVersion(ua, /\b(?:Firefox|FxiOS)\/(\d{1,4})/);
  if (firefoxVersion) {
    return `Firefox ${firefoxVersion}`;
  }

  const chromeVersion = matchMajorVersion(ua, /\b(?:Chrome|CriOS)\/(\d{1,4})/);
  if (chromeVersion) {
    return `Chrome ${chromeVersion}`;
  }

  if (/\bSafari\//.test(ua)) {
    const safariVersion = matchMajorVersion(ua, /\bVersion\/(\d{1,4})/);
    return safariVersion ? `Safari ${safariVersion}` : 'Safari';
  }

  const curlVersion = matchMajorVersion(ua, /\bcurl\/(\d{1,4})/);
  if (curlVersion) {
    return `curl ${curlVersion}`;
  }

  if (/\bPostmanRuntime\//.test(ua)) {
    return 'Postman';
  }

  return null;
}

function detectOperatingSystem(ua: string): string | null {
  if (/\biPad\b/.test(ua)) {
    return 'iPadOS';
  }
  if (/\b(?:iPhone|iPod)\b/.test(ua)) {
    return 'iOS';
  }

  const androidVersion = matchMajorVersion(ua, /\bAndroid\s+(\d{1,3})/);
  if (androidVersion) {
    return `Android ${androidVersion}`;
  }
  if (/\bAndroid\b/.test(ua)) {
    return 'Android';
  }

  if (/\bWindows NT 10\.0\b/.test(ua)) {
    return 'Windows 10/11';
  }
  if (/\bWindows NT 6\.3\b/.test(ua)) {
    return 'Windows 8.1';
  }
  if (/\bWindows NT 6\.1\b/.test(ua)) {
    return 'Windows 7';
  }
  if (/\bWindows\b/.test(ua)) {
    return 'Windows';
  }

  if (/\b(?:Macintosh|Mac OS X)\b/.test(ua)) {
    return 'macOS';
  }

  if (/\bCrOS\b/.test(ua)) {
    return 'ChromeOS';
  }

  if (/\bLinux\b/.test(ua)) {
    return 'Linux';
  }

  return null;
}

/**
 * Phân tích chuỗi `User-Agent` sang tên thiết bị dễ đọc cho bảng `sessions` (Mục 4.3).
 * Cắt giới hạn đầu vào 512 ký tự và chỉ dùng biểu thức chính quy tuyến tính để triệt tiêu ReDoS.
 */
export function parseDeviceInfo(rawUserAgent?: string | null): string {
  if (!rawUserAgent) {
    return UNKNOWN_DEVICE_LABEL;
  }

  const cleaned = rawUserAgent
    .slice(0, MAX_USER_AGENT_PARSE_LENGTH)
    .replace(CONTROL_CHARS_REGEX, '')
    .trim();

  if (!cleaned) {
    return UNKNOWN_DEVICE_LABEL;
  }

  const browser = detectBrowser(cleaned);
  const os = detectOperatingSystem(cleaned);

  let label: string;
  if (browser && os) {
    label = `${browser} / ${os}`;
  } else if (browser) {
    label = browser;
  } else if (os) {
    label = os;
  } else {
    label = UNKNOWN_DEVICE_LABEL;
  }

  return label.length > MAX_DEVICE_INFO_LENGTH ? label.slice(0, MAX_DEVICE_INFO_LENGTH) : label;
}
