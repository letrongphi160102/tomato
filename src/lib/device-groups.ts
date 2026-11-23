export interface DeviceSessionRecord {
  readonly public_id: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly isCurrent: boolean;
  readonly activityStatus?: 'online' | 'offline';
}

export interface DeviceHistoryRecord {
  readonly public_id: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly endedAt: string;
  readonly historyStatus: 'logged_out' | 'expired';
}

export interface ActiveDeviceGroup {
  readonly groupKey: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly primary: DeviceSessionRecord;
  readonly sessions: readonly DeviceSessionRecord[];
  readonly pastLogins: readonly DeviceHistoryRecord[];
  readonly hasCurrent: boolean;
  readonly activityStatus: 'online' | 'offline';
}

export interface GroupedHistoryDevice {
  readonly groupKey: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly latest: DeviceHistoryRecord;
  readonly entries: readonly DeviceHistoryRecord[];
}

export interface GroupedDevicesResult {
  readonly activeGroups: readonly ActiveDeviceGroup[];
  readonly historyGroups: readonly GroupedHistoryDevice[];
}

export function makeDeviceGroupKey(deviceInfo: string, ipAddress: string): string {
  return `${deviceInfo.trim().toLowerCase()}|${ipAddress.trim().toLowerCase()}`;
}

function toTimestamp(isoString: string): number {
  const value = Date.parse(isoString);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Gom nhóm thiết bị giống nhau (cùng `deviceInfo` + `ipAddress`) theo phong cách Facebook:
 * - Các phiên đang hoạt động trên cùng thiết bị và IP được gom vào 1 thẻ thiết bị duy nhất
 *   (thiết bị hiện tại luôn đứng đầu; vẫn giữ đủ `public_id` từng phiên để đăng xuất chính xác).
 * - Các lần đăng nhập cũ của chính thiết bị đang hoạt động được đính gọn vào `pastLogins`
 *   của thiết bị đó thay vì lặp lại dưới danh sách lịch sử.
 * - Các lần đăng nhập cũ trên thiết bị khác được gom theo `(deviceInfo, ipAddress)` thành 1 dòng
 *   kèm danh sách mốc thời gian để mở rộng xem chi tiết; khác IP luôn tách riêng để dễ phát hiện truy cập lạ.
 */
export function groupDevicesForDisplay(
  sessions: readonly DeviceSessionRecord[],
  history: readonly DeviceHistoryRecord[],
): GroupedDevicesResult {
  const activeMap = new Map<
    string,
    {
      readonly deviceInfo: string;
      readonly ipAddress: string;
      readonly sessions: DeviceSessionRecord[];
      readonly pastLogins: DeviceHistoryRecord[];
    }
  >();

  for (const session of sessions) {
    const key = makeDeviceGroupKey(session.deviceInfo, session.ipAddress);
    const existing = activeMap.get(key);
    if (existing) {
      existing.sessions.push(session);
    } else {
      activeMap.set(key, {
        deviceInfo: session.deviceInfo,
        ipAddress: session.ipAddress,
        sessions: [session],
        pastLogins: [],
      });
    }
  }

  const historyMap = new Map<
    string,
    {
      readonly deviceInfo: string;
      readonly ipAddress: string;
      readonly entries: DeviceHistoryRecord[];
    }
  >();

  for (const item of history) {
    const key = makeDeviceGroupKey(item.deviceInfo, item.ipAddress);
    const matchingActive = activeMap.get(key);
    if (matchingActive) {
      matchingActive.pastLogins.push(item);
      continue;
    }

    const existingHistory = historyMap.get(key);
    if (existingHistory) {
      existingHistory.entries.push(item);
    } else {
      historyMap.set(key, {
        deviceInfo: item.deviceInfo,
        ipAddress: item.ipAddress,
        entries: [item],
      });
    }
  }

  const activeGroups: ActiveDeviceGroup[] = [];
  for (const [groupKey, bucket] of activeMap.entries()) {
    bucket.sessions.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) {
        return a.isCurrent ? -1 : 1;
      }
      return toTimestamp(b.lastUsedAt) - toTimestamp(a.lastUsedAt);
    });
    bucket.pastLogins.sort((a, b) => toTimestamp(b.endedAt) - toTimestamp(a.endedAt));

    const primary = bucket.sessions[0]!;
    const hasCurrent = bucket.sessions.some((item) => item.isCurrent);
    const isOnline =
      hasCurrent || bucket.sessions.some((item) => item.activityStatus !== 'offline');

    activeGroups.push({
      groupKey,
      deviceInfo: bucket.deviceInfo,
      ipAddress: bucket.ipAddress,
      primary,
      sessions: bucket.sessions,
      pastLogins: bucket.pastLogins,
      hasCurrent,
      activityStatus: isOnline ? 'online' : 'offline',
    });
  }

  activeGroups.sort((a, b) => {
    if (a.hasCurrent !== b.hasCurrent) {
      return a.hasCurrent ? -1 : 1;
    }
    return toTimestamp(b.primary.lastUsedAt) - toTimestamp(a.primary.lastUsedAt);
  });

  const historyGroups: GroupedHistoryDevice[] = [];
  for (const [groupKey, bucket] of historyMap.entries()) {
    bucket.entries.sort((a, b) => toTimestamp(b.endedAt) - toTimestamp(a.endedAt));
    historyGroups.push({
      groupKey,
      deviceInfo: bucket.deviceInfo,
      ipAddress: bucket.ipAddress,
      latest: bucket.entries[0]!,
      entries: bucket.entries,
    });
  }

  historyGroups.sort((a, b) => toTimestamp(b.latest.endedAt) - toTimestamp(a.latest.endedAt));

  return { activeGroups, historyGroups };
}
