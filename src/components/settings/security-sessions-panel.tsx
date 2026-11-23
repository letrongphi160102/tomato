'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
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
import { authFetch } from '@/lib/auth-client';

interface SessionItemPayload {
  readonly public_id: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly isCurrent: boolean;
  readonly activityStatus?: 'online' | 'offline';
}

interface SessionHistoryItemPayload {
  readonly public_id: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly endedAt: string;
  readonly historyStatus: 'logged_out' | 'expired';
}

interface SessionsResponsePayload {
  readonly sessions: readonly SessionItemPayload[];
  readonly history?: readonly SessionHistoryItemPayload[];
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

  const [sessions, setSessions] = React.useState<readonly SessionItemPayload[]>([]);
  const [history, setHistory] = React.useState<readonly SessionHistoryItemPayload[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const [revokingSessionId, setRevokingSessionId] = React.useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);
  const [revokingAll, setRevokingAll] = React.useState(false);

  const [notice, setNotice] = React.useState<{
    readonly variant: 'success' | 'destructive';
    readonly title: string;
    readonly message: string;
  } | null>(null);

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

  async function handleRevokeSession(sessionItem: SessionItemPayload) {
    if (revokingSessionId || revokingAll) {
      return;
    }

    setRevokingSessionId(sessionItem.public_id);
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
          router.replace('/');
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
        // Tải lại danh sách để thiết bị vừa đăng xuất chuyển ngay sang mục Lịch sử đăng nhập gần đây.
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
      setRevokingSessionId(null);
    }
  }

  async function handleRevokeAllOtherSessions() {
    if (revokingAll || revokingSessionId) {
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
              <CardTitle className="text-lg">Thiết bị đang đăng nhập ({sessions.length})</CardTitle>
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
                    `Xác nhận (${otherSessionsCount} thiết bị)`
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
          {sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Hiện chưa có thiết bị nào đang đăng nhập.
            </p>
          ) : (
            sessions.map((item) => {
              const isItemRevoking = revokingSessionId === item.public_id;
              const isOnline = item.isCurrent || item.activityStatus !== 'offline';
              return (
                <div
                  key={item.public_id}
                  className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      {renderDeviceIcon(item.deviceInfo)}
                    </div>
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-foreground">{item.deviceInfo}</p>
                        {item.isCurrent ? (
                          <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            Thiết bị hiện tại
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
                        <span>IP: {formatDisplayIp(item.ipAddress)}</span>
                        <span>Đăng nhập: {formatVietnameseDateTime(item.createdAt)}</span>
                        <span>
                          {isOnline
                            ? `Hoạt động gần nhất: ${formatVietnameseDateTime(item.lastUsedAt)}`
                            : `Hoạt động lần cuối: ${formatVietnameseDateTime(item.lastUsedAt)}`}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center justify-end">
                    <Button
                      type="button"
                      variant={item.isCurrent ? 'outline' : 'secondary'}
                      size="sm"
                      disabled={isItemRevoking || revokingAll}
                      onClick={() => void handleRevokeSession(item)}
                    >
                      {isItemRevoking ? (
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
              );
            })
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="border-b pb-4">
          <div className="flex items-center gap-2">
            <History className="size-5 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-lg">Lịch sử đăng nhập gần đây ({history.length})</CardTitle>
          </div>
          <CardDescription>
            Các thiết bị đã đăng xuất hoặc hết thời hạn truy cập trước đó.
          </CardDescription>
        </CardHeader>

        <CardContent className="divide-y pt-2">
          {history.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Chưa có lịch sử đăng nhập nào khác.
            </p>
          ) : (
            history.map((item) => (
              <div
                key={item.public_id}
                className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    {renderDeviceIcon(item.deviceInfo, true)}
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-foreground">{item.deviceInfo}</p>
                      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {item.historyStatus === 'logged_out' ? 'Đã đăng xuất' : 'Đã hết hạn'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>IP: {formatDisplayIp(item.ipAddress)}</span>
                      <span>Đăng nhập: {formatVietnameseDateTime(item.createdAt)}</span>
                      <span>
                        {item.historyStatus === 'logged_out' ? 'Đăng xuất lúc:' : 'Hết hạn lúc:'}{' '}
                        {formatVietnameseDateTime(item.endedAt)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
