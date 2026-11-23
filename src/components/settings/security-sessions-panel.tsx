'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Globe,
  History,
  Laptop,
  Loader2,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  ShieldAlert,
  Smartphone,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authFetch, clearAccessTokenFreshness } from '@/lib/auth-client';
import {
  groupDevicesForDisplay,
  type ActiveDeviceGroup,
  type DeviceHistoryRecord,
  type DeviceSessionRecord,
} from '@/lib/device-groups';

interface SessionsResponsePayload {
  readonly sessions: readonly DeviceSessionRecord[];
  readonly history?: readonly DeviceHistoryRecord[];
}

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

function formatVietnameseDateTime(isoString: string): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(isoString));
  } catch {
    return isoString;
  }
}

function formatDisplayIp(ipAddress: string): string {
  if (!ipAddress || ipAddress === '0.0.0.0' || ipAddress === '::' || ipAddress === '::1') {
    return 'Mạng cục bộ';
  }
  return ipAddress;
}

function renderDeviceIcon(deviceInfo: string, muted = false) {
  const colorClass = muted ? 'size-5 text-muted-foreground' : 'size-5 text-primary';
  const lower = deviceInfo.toLowerCase();
  if (lower.includes('ios') || lower.includes('android') || lower.includes('ipados')) {
    return <Smartphone className={colorClass} aria-hidden="true" />;
  }
  if (
    lower.includes('windows') ||
    lower.includes('macos') ||
    lower.includes('linux') ||
    lower.includes('chromeos')
  ) {
    return <Laptop className={colorClass} aria-hidden="true" />;
  }
  return <Globe className={colorClass} aria-hidden="true" />;
}

export function SecuritySessionsPanel() {
  const router = useRouter();

  const [sessions, setSessions] = React.useState<readonly DeviceSessionRecord[]>([]);
  const [history, setHistory] = React.useState<readonly DeviceHistoryRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const [revokingKey, setRevokingKey] = React.useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);
  const [revokingAll, setRevokingAll] = React.useState(false);
  const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(() => new Set());

  const [notice, setNotice] = React.useState<{
    readonly variant: 'success' | 'destructive';
    readonly title: string;
    readonly message: string;
  } | null>(null);

  const toggleExpanded = React.useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const fetchSessions = React.useCallback(async () => {
    const sessionsRes = await authFetch('/api/v1/auth/sessions', { method: 'GET' });

    if (sessionsRes.status === 401) {
      return { kind: 'unauthorized' as const };
    }

    if (!sessionsRes.ok) {
      const errJson = (await sessionsRes.json().catch(() => ({}))) as ApiErrorPayload;
      return {
        kind: 'error' as const,
        message: errJson.error?.message ?? 'Đã có lỗi xảy ra khi tải danh sách thiết bị.',
      };
    }

    const sessionsData = (await sessionsRes.json()) as SessionsResponsePayload;
    return {
      kind: 'ok' as const,
      sessions: sessionsData.sessions,
      history: sessionsData.history ?? [],
    };
  }, []);

  React.useEffect(() => {
    let active = true;

    async function loadInitial() {
      try {
        const result = await fetchSessions();
        if (!active) {
          return;
        }
        if (result.kind === 'unauthorized') {
          router.replace('/login?next=/settings/devices');
          return;
        }
        if (result.kind === 'error') {
          setNotice({
            variant: 'destructive',
            title: 'Không thể tải danh sách thiết bị',
            message: result.message,
          });
          return;
        }
        setSessions(result.sessions);
        setHistory(result.history);
      } catch {
        if (active) {
          setNotice({
            variant: 'destructive',
            title: 'Lỗi kết nối máy chủ',
            message: 'Không thể tải danh sách thiết bị. Vui lòng thử lại.',
          });
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadInitial();
    return () => {
      active = false;
    };
  }, [fetchSessions, router]);

  async function handleRefreshSessions() {
    if (refreshing || revokingAll) {
      return;
    }
    setRefreshing(true);
    try {
      const result = await fetchSessions();
      if (result.kind === 'unauthorized') {
        router.replace('/login?next=/settings/devices');
        return;
      }
      if (result.kind === 'error') {
        setNotice({
          variant: 'destructive',
          title: 'Không thể tải danh sách thiết bị',
          message: result.message,
        });
        return;
      }
      setSessions(result.sessions);
      setHistory(result.history);
    } catch {
      setNotice({
        variant: 'destructive',
        title: 'Lỗi kết nối máy chủ',
        message: 'Không thể tải danh sách thiết bị. Vui lòng thử lại.',
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRevokeSingleSession(sessionItem: DeviceSessionRecord) {
    if (revokingKey || revokingAll) {
      return;
    }

    setRevokingKey(sessionItem.public_id);
    setNotice(null);

    try {
      const response = await authFetch(
        `/api/v1/auth/sessions/${encodeURIComponent(sessionItem.public_id)}`,
        { method: 'DELETE' },
      );

      if (response.status === 401) {
        router.replace('/login?next=/settings/devices');
        return;
      }

      if (response.ok) {
        if (sessionItem.isCurrent) {
          clearAccessTokenFreshness();
          router.replace('/login');
          router.refresh();
          return;
        }

        const data = (await response.json()) as { message?: string };
        setNotice({
          variant: 'success',
          title: 'Đã đăng xuất thiết bị',
          message:
            data.message ?? `Đã đăng xuất "${sessionItem.deviceInfo}" khỏi tài khoản của bạn.`,
        });
        const refreshed = await fetchSessions();
        if (refreshed.kind === 'ok') {
          setSessions(refreshed.sessions);
          setHistory(refreshed.history);
        }
        return;
      }

      const errJson = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      setNotice({
        variant: 'destructive',
        title: 'Không thể đăng xuất thiết bị',
        message:
          errJson.error?.message ?? 'Thiết bị không còn hoạt động hoặc đã đăng xuất trước đó.',
      });
    } catch {
      setNotice({
        variant: 'destructive',
        title: 'Lỗi kết nối máy chủ',
        message: 'Không thể đăng xuất thiết bị lúc này. Vui lòng thử lại.',
      });
    } finally {
      setRevokingKey(null);
    }
  }

  async function handleRevokeDeviceGroup(group: ActiveDeviceGroup) {
    if (revokingKey || revokingAll) {
      return;
    }

    // Nếu nhóm chứa thiết bị hiện tại -> chỉ đăng xuất phiên hiện tại (giống nút Đăng xuất trực tiếp).
    if (group.hasCurrent) {
      await handleRevokeSingleSession(group.primary);
      return;
    }

    // Nếu thiết bị khác có 1 phiên -> gọi đăng xuất phiên đơn.
    if (group.sessions.length === 1) {
      await handleRevokeSingleSession(group.primary);
      return;
    }

    // Nếu cùng một thiết bị khác mở nhiều phiên song song -> đăng xuất sạch tất cả các phiên trong nhóm.
    setRevokingKey(group.groupKey);
    setNotice(null);

    try {
      let revokedCount = 0;
      for (const item of group.sessions) {
        const res = await authFetch(`/api/v1/auth/sessions/${encodeURIComponent(item.public_id)}`, {
          method: 'DELETE',
        });
        if (res.status === 401) {
          router.replace('/login?next=/settings/devices');
          return;
        }
        if (res.ok) {
          revokedCount += 1;
        }
      }

      if (revokedCount > 0) {
        setNotice({
          variant: 'success',
          title: 'Đã đăng xuất thiết bị',
          message: `Đã đăng xuất toàn bộ ${revokedCount} phiên trên "${group.deviceInfo}".`,
        });
      } else {
        setNotice({
          variant: 'destructive',
          title: 'Không thể đăng xuất thiết bị',
          message: 'Các phiên trên thiết bị này đã kết thúc trước đó.',
        });
      }

      const refreshed = await fetchSessions();
      if (refreshed.kind === 'ok') {
        setSessions(refreshed.sessions);
        setHistory(refreshed.history);
      }
    } catch {
      setNotice({
        variant: 'destructive',
        title: 'Lỗi kết nối máy chủ',
        message: 'Không thể đăng xuất thiết bị lúc này. Vui lòng thử lại.',
      });
    } finally {
      setRevokingKey(null);
    }
  }

  async function handleRevokeAllOtherSessions() {
    if (revokingAll || revokingKey) {
      return;
    }

    setRevokingAll(true);
    setNotice(null);

    try {
      const response = await authFetch('/api/v1/auth/sessions/revoke-all', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ includeCurrent: false }),
      });

      if (response.status === 401) {
        router.replace('/login?next=/settings/devices');
        return;
      }

      if (response.ok) {
        const data = (await response.json()) as { revokedCount: number; message: string };
        setConfirmRevokeAll(false);
        setNotice({
          variant: 'success',
          title: 'Đã đăng xuất tất cả thiết bị khác',
          message:
            data.revokedCount > 0
              ? `${data.message} (${data.revokedCount} thiết bị đã được đăng xuất).`
              : 'Không có thiết bị nào khác đang đăng nhập ngoài thiết bị hiện tại.',
        });
        const refreshed = await fetchSessions();
        if (refreshed.kind === 'ok') {
          setSessions(refreshed.sessions);
          setHistory(refreshed.history);
        }
        return;
      }

      const errJson = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      setNotice({
        variant: 'destructive',
        title: 'Không thể đăng xuất tất cả thiết bị khác',
        message: errJson.error?.message ?? 'Đã có lỗi xảy ra. Vui lòng thử lại.',
      });
    } catch {
      setNotice({
        variant: 'destructive',
        title: 'Lỗi kết nối máy chủ',
        message: 'Không thể kết nối đến máy chủ. Vui lòng thử lại.',
      });
    } finally {
      setRevokingAll(false);
    }
  }

  const { activeGroups, historyGroups } = React.useMemo(
    () => groupDevicesForDisplay(sessions, history),
    [sessions, history],
  );

  if (loading) {
    return (
      <Card className="shadow-sm">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Đang tải danh sách thiết bị...</p>
        </CardContent>
      </Card>
    );
  }

  const otherSessionsCount = sessions.filter((item) => !item.isCurrent).length;

  return (
    <div className="space-y-6">
      <div aria-live="polite">
        {notice ? (
          <Alert variant={notice.variant}>
            {notice.variant === 'success' ? (
              <CheckCircle2 aria-hidden="true" />
            ) : (
              <AlertCircle aria-hidden="true" />
            )}
            <div>
              <AlertTitle>{notice.title}</AlertTitle>
              <AlertDescription>{notice.message}</AlertDescription>
            </div>
          </Alert>
        ) : null}
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <MonitorSmartphone className="size-5 text-primary" aria-hidden="true" />
              <CardTitle className="text-lg">
                Thiết bị đang đăng nhập ({activeGroups.length})
              </CardTitle>
            </div>
            <CardDescription className="mt-1">
              Nếu bạn thấy thiết bị không quen thuộc, hãy đăng xuất thiết bị đó ngay để bảo vệ tài
              khoản.
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleRefreshSessions()}
              disabled={refreshing || revokingAll}
            >
              <RefreshCw
                className={refreshing ? 'size-4 animate-spin' : 'size-4'}
                aria-hidden="true"
              />
              Làm mới
            </Button>

            {!confirmRevokeAll ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={otherSessionsCount === 0 || revokingAll}
                onClick={() => setConfirmRevokeAll(true)}
              >
                <ShieldAlert className="size-4" aria-hidden="true" />
                Đăng xuất tất cả thiết bị khác
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={revokingAll}
                  onClick={handleRevokeAllOtherSessions}
                >
                  {revokingAll ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Đang đăng xuất...
                    </>
                  ) : (
                    `Xác nhận (${otherSessionsCount} phiên)`
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={revokingAll}
                  onClick={() => setConfirmRevokeAll(false)}
                >
                  Hủy
                </Button>
              </div>
            )}
          </div>
        </CardHeader>

        <CardContent className="divide-y pt-2">
          {activeGroups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Hiện chưa có thiết bị nào đang đăng nhập.
            </p>
          ) : (
            activeGroups.map((group) => {
              const expandId = `active:${group.groupKey}`;
              const isExpanded = expandedKeys.has(expandId);
              const hasDetails = group.sessions.length > 1 || group.pastLogins.length > 0;
              const isGroupRevoking =
                revokingKey === group.groupKey || revokingKey === group.primary.public_id;
              const isOnline = group.activityStatus === 'online';

              return (
                <div key={group.groupKey} className="py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        {renderDeviceIcon(group.deviceInfo)}
                      </div>
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-foreground">{group.deviceInfo}</p>
                          {group.hasCurrent ? (
                            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                              Thiết bị hiện tại
                            </span>
                          ) : null}
                          {group.sessions.length > 1 ? (
                            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              {group.sessions.length} phiên đang mở
                            </span>
                          ) : null}
                          {isOnline ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                              <span
                                aria-hidden="true"
                                className="size-1.5 rounded-full bg-emerald-600"
                              />
                              Đang hoạt động
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              <span
                                aria-hidden="true"
                                className="size-1.5 rounded-full bg-muted-foreground/60"
                              />
                              Ngoại tuyến
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>IP: {formatDisplayIp(group.ipAddress)}</span>
                          <span>
                            Đăng nhập: {formatVietnameseDateTime(group.primary.createdAt)}
                          </span>
                          <span>
                            {isOnline
                              ? `Hoạt động gần nhất: ${formatVietnameseDateTime(group.primary.lastUsedAt)}`
                              : `Hoạt động lần cuối: ${formatVietnameseDateTime(group.primary.lastUsedAt)}`}
                          </span>
                        </div>

                        {hasDetails ? (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(expandId)}
                            aria-expanded={isExpanded}
                            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                          >
                            {isExpanded ? (
                              <ChevronDown className="size-3.5" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="size-3.5" aria-hidden="true" />
                            )}
                            <span>
                              {group.sessions.length > 1
                                ? `Xem chi tiết ${group.sessions.length} phiên`
                                : `Xem ${group.pastLogins.length} lần đăng nhập trước trên thiết bị này`}
                            </span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center justify-end">
                      <Button
                        type="button"
                        variant={group.hasCurrent ? 'outline' : 'secondary'}
                        size="sm"
                        disabled={isGroupRevoking || revokingAll || Boolean(revokingKey)}
                        onClick={() => void handleRevokeDeviceGroup(group)}
                      >
                        {isGroupRevoking ? (
                          <>
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                            Đang đăng xuất...
                          </>
                        ) : (
                          <>
                            <LogOut className="size-3.5" aria-hidden="true" />
                            Đăng xuất
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {isExpanded && hasDetails ? (
                    <div className="mt-3 ml-0 space-y-2 rounded-lg border bg-muted/25 p-3 sm:ml-13">
                      {group.sessions.length > 1 ? (
                        <div className="space-y-1.5">
                          <p className="text-xs font-medium text-foreground">
                            Các phiên đang hoạt động trên thiết bị này
                          </p>
                          {group.sessions.map((sessionItem) => {
                            const isRowRevoking = revokingKey === sessionItem.public_id;
                            return (
                              <div
                                key={sessionItem.public_id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background/80 px-2.5 py-2 text-xs"
                              >
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                                  <span className="font-medium text-foreground">
                                    {sessionItem.isCurrent ? 'Phiên hiện tại' : 'Phiên khác'}
                                  </span>
                                  <span>
                                    Đăng nhập: {formatVietnameseDateTime(sessionItem.createdAt)}
                                  </span>
                                  <span>
                                    Gần nhất: {formatVietnameseDateTime(sessionItem.lastUsedAt)}
                                  </span>
                                </div>
                                {!sessionItem.isCurrent ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={isRowRevoking || revokingAll || Boolean(revokingKey)}
                                    onClick={() => void handleRevokeSingleSession(sessionItem)}
                                    className="h-7 px-2 text-xs"
                                  >
                                    {isRowRevoking ? (
                                      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                      <LogOut className="size-3" aria-hidden="true" />
                                    )}
                                    Đăng xuất
                                  </Button>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}

                      {group.pastLogins.length > 0 ? (
                        <div className="space-y-1.5">
                          <p className="text-xs font-medium text-foreground">
                            Lần đăng nhập trước đây trên thiết bị này ({group.pastLogins.length})
                          </p>
                          <ul className="space-y-1">
                            {group.pastLogins.map((entry) => (
                              <li
                                key={entry.public_id}
                                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-background/70 px-2.5 py-1.5 text-xs text-muted-foreground"
                              >
                                <span>Đăng nhập: {formatVietnameseDateTime(entry.createdAt)}</span>
                                <span>
                                  {entry.historyStatus === 'logged_out'
                                    ? 'Đã đăng xuất:'
                                    : 'Hết hạn:'}{' '}
                                  {formatVietnameseDateTime(entry.endedAt)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="border-b pb-4">
          <div className="flex items-center gap-2">
            <History className="size-5 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-lg">
              Lịch sử đăng nhập trên thiết bị khác ({historyGroups.length})
            </CardTitle>
          </div>
          <CardDescription>
            Các thiết bị khác đã đăng xuất hoặc hết thời hạn truy cập gần đây.
          </CardDescription>
        </CardHeader>

        <CardContent className="divide-y pt-2">
          {historyGroups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Chưa có lịch sử đăng nhập trên thiết bị nào khác.
            </p>
          ) : (
            historyGroups.map((group) => {
              const expandId = `history:${group.groupKey}`;
              const isExpanded = expandedKeys.has(expandId);
              const hasMultiple = group.entries.length > 1;
              const latest = group.latest;

              return (
                <div key={group.groupKey} className="py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                        {renderDeviceIcon(group.deviceInfo, true)}
                      </div>
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-foreground">{group.deviceInfo}</p>
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            {latest.historyStatus === 'logged_out' ? 'Đã đăng xuất' : 'Đã hết hạn'}
                          </span>
                          {hasMultiple ? (
                            <span className="inline-flex items-center rounded-full bg-muted/80 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              {group.entries.length} lần
                            </span>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>IP: {formatDisplayIp(group.ipAddress)}</span>
                          <span>Đăng nhập: {formatVietnameseDateTime(latest.createdAt)}</span>
                          <span>
                            {latest.historyStatus === 'logged_out'
                              ? 'Đăng xuất lúc:'
                              : 'Hết hạn lúc:'}{' '}
                            {formatVietnameseDateTime(latest.endedAt)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {hasMultiple ? (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(expandId)}
                        aria-expanded={isExpanded}
                        aria-label={`Xem ${group.entries.length} lần đăng nhập trên ${group.deviceInfo}`}
                        className="mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        {isExpanded ? (
                          <ChevronDown className="size-4" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-4" aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                  </div>

                  {isExpanded && hasMultiple ? (
                    <ul className="mt-3 ml-0 space-y-1.5 rounded-lg border bg-muted/25 p-3 sm:ml-13">
                      {group.entries.map((entry) => (
                        <li
                          key={entry.public_id}
                          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-background/80 px-2.5 py-1.5 text-xs text-muted-foreground"
                        >
                          <span>Đăng nhập: {formatVietnameseDateTime(entry.createdAt)}</span>
                          <span>
                            {entry.historyStatus === 'logged_out'
                              ? 'Đăng xuất lúc:'
                              : 'Hết hạn lúc:'}{' '}
                            {formatVietnameseDateTime(entry.endedAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
