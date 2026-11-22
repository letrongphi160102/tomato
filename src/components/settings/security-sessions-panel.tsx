'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Laptop,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  UserCheck,
} from 'lucide-react';

import { ChangePasswordCard } from '@/components/settings/change-password-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authFetch } from '@/lib/auth-client';

interface UserProfilePayload {
  readonly public_id: string;
  readonly username: string;
  readonly fullName: string;
  readonly gender: string;
  readonly status: string;
}

interface SessionItemPayload {
  readonly public_id: string;
  readonly deviceInfo: string;
  readonly ipAddress: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly isCurrent: boolean;
}

interface SessionsResponsePayload {
  readonly sessions: readonly SessionItemPayload[];
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
  if (!ipAddress || ipAddress === '0.0.0.0') {
    return 'Không xác định (Local)';
  }
  return ipAddress;
}

function renderDeviceIcon(deviceInfo: string) {
  const lower = deviceInfo.toLowerCase();
  if (lower.includes('ios') || lower.includes('android') || lower.includes('ipados')) {
    return <Smartphone className="size-5 text-primary" aria-hidden="true" />;
  }
  if (
    lower.includes('windows') ||
    lower.includes('macos') ||
    lower.includes('linux') ||
    lower.includes('chromeos')
  ) {
    return <Laptop className="size-5 text-primary" aria-hidden="true" />;
  }
  return <Globe className="size-5 text-primary" aria-hidden="true" />;
}

export function SecuritySessionsPanel() {
  const router = useRouter();

  const [profile, setProfile] = React.useState<UserProfilePayload | null>(null);
  const [sessions, setSessions] = React.useState<readonly SessionItemPayload[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const [revokingSessionId, setRevokingSessionId] = React.useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);
  const [revokingAll, setRevokingAll] = React.useState(false);
  const [loggingOutCurrent, setLoggingOutCurrent] = React.useState(false);

  const [notice, setNotice] = React.useState<{
    readonly variant: 'success' | 'destructive';
    readonly title: string;
    readonly message: string;
  } | null>(null);

  const fetchAccountAndSessions = React.useCallback(async () => {
    // Cả 2 request đều dùng `authFetch` có khóa Single-Flight Refresh nên nếu Access Token
    // vừa hết hạn 15 phút, chỉ 1 lời gọi `/refresh` duy nhất được thực hiện.
    const [meRes, sessionsRes] = await Promise.all([
      authFetch('/api/v1/auth/me', { method: 'GET' }),
      authFetch('/api/v1/auth/sessions', { method: 'GET' }),
    ]);

    if (meRes.status === 401 || sessionsRes.status === 401) {
      return { kind: 'unauthorized' as const };
    }

    if (!meRes.ok || !sessionsRes.ok) {
      const errJson = (await (meRes.ok ? sessionsRes : meRes)
        .json()
        .catch(() => ({}))) as ApiErrorPayload;
      return {
        kind: 'error' as const,
        message: errJson.error?.message ?? 'Đã có lỗi xảy ra khi tải dữ liệu bảo mật.',
      };
    }

    const meData = (await meRes.json()) as UserProfilePayload;
    const sessionsData = (await sessionsRes.json()) as SessionsResponsePayload;

    return {
      kind: 'ok' as const,
      profile: meData,
      sessions: sessionsData.sessions,
    };
  }, []);

  React.useEffect(() => {
    let active = true;

    async function loadInitial() {
      try {
        const result = await fetchAccountAndSessions();
        if (!active) {
          return;
        }
        if (result.kind === 'unauthorized') {
          router.replace('/login?next=/settings/security');
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
        setProfile(result.profile);
        setSessions(result.sessions);
      } catch {
        if (active) {
          setNotice({
            variant: 'destructive',
            title: 'Lỗi kết nối máy chủ',
            message: 'Không thể tải thông tin phiên đăng nhập. Vui lòng thử lại.',
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
  }, [fetchAccountAndSessions, router]);

  async function handleRefreshSessions() {
    if (refreshing || revokingAll || loggingOutCurrent) {
      return;
    }
    setRefreshing(true);
    try {
      const result = await fetchAccountAndSessions();
      if (result.kind === 'unauthorized') {
        router.replace('/login?next=/settings/security');
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
      setProfile(result.profile);
      setSessions(result.sessions);
    } catch {
      setNotice({
        variant: 'destructive',
        title: 'Lỗi kết nối máy chủ',
        message: 'Không thể tải thông tin phiên đăng nhập. Vui lòng thử lại.',
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLogoutCurrent() {
    if (loggingOutCurrent) {
      return;
    }
    setLoggingOutCurrent(true);
    setNotice(null);

    try {
      const response = await authFetch(
        '/api/v1/auth/logout',
        { method: 'POST' },
        { retryOnUnauthorized: false },
      );

      if (response.ok || response.status === 401) {
        router.replace('/login');
        router.refresh();
        return;
      }

      const errJson = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      setNotice({
        variant: 'destructive',
        title: 'Đăng xuất chưa thành công',
        message: errJson.error?.message ?? 'Không thể đăng xuất phiên hiện tại.',
      });
    } catch {
      setNotice({
        variant: 'destructive',
        title: 'Lỗi kết nối máy chủ',
        message: 'Không thể kết nối đến máy chủ để đăng xuất.',
      });
    } finally {
      setLoggingOutCurrent(false);
    }
  }

  async function handleRevokeSession(sessionItem: SessionItemPayload) {
    if (revokingSessionId || revokingAll || loggingOutCurrent) {
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
        router.replace('/login?next=/settings/security');
        return;
      }

      if (response.ok) {
        if (sessionItem.isCurrent) {
          router.replace('/login');
          router.refresh();
          return;
        }

        const data = (await response.json()) as { message?: string };
        setSessions((prev) => prev.filter((item) => item.public_id !== sessionItem.public_id));
        setNotice({
          variant: 'success',
          title: 'Đã thu hồi thiết bị',
          message:
            data.message ??
            `Đã đăng xuất thiết bị "${sessionItem.deviceInfo}". Phiên này không còn hiệu lực.`,
        });
        return;
      }

      const errJson = (await response.json().catch(() => ({}))) as ApiErrorPayload;
      setNotice({
        variant: 'destructive',
        title: 'Không thể đăng xuất thiết bị',
        message: errJson.error?.message ?? 'Phiên không tồn tại hoặc đã bị thu hồi trước đó.',
      });
    } catch {
      setNotice({
        variant: 'destructive',
        title: 'Lỗi kết nối máy chủ',
        message: 'Không thể thực hiện yêu cầu thu hồi thiết bị. Vui lòng thử lại.',
      });
    } finally {
      setRevokingSessionId(null);
    }
  }

  async function handleRevokeAllOtherSessions() {
    if (revokingAll || revokingSessionId || loggingOutCurrent) {
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
        router.replace('/login?next=/settings/security');
        return;
      }

      if (response.ok) {
        const data = (await response.json()) as { revokedCount: number; message: string };
        setConfirmRevokeAll(false);
        setSessions((prev) => prev.filter((item) => item.isCurrent));
        setNotice({
          variant: 'success',
          title: 'Đã đăng xuất tất cả thiết bị khác',
          message:
            data.revokedCount > 0
              ? `${data.message} (${data.revokedCount} phiên đã bị thu hồi ngay lập tức).`
              : 'Không có thiết bị nào khác đang đăng nhập ngoài thiết bị hiện tại.',
        });
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
          <p className="text-sm text-muted-foreground">Đang tải thông tin bảo mật và thiết bị...</p>
        </CardContent>
      </Card>
    );
  }

  const otherSessionsCount = sessions.filter((item) => !item.isCurrent).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bảo mật &amp; Thiết bị</h1>
          <p className="text-sm text-muted-foreground">
            Kiểm soát toàn bộ thiết bị đang đăng nhập vào tài khoản TOMATO của bạn.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleRefreshSessions()}
            disabled={refreshing || revokingAll || loggingOutCurrent}
          >
            <RefreshCw
              className={refreshing ? 'size-4 animate-spin' : 'size-4'}
              aria-hidden="true"
            />
            Làm mới
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleLogoutCurrent}
            disabled={loggingOutCurrent || revokingAll}
          >
            {loggingOutCurrent ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogOut className="size-4" aria-hidden="true" />
            )}
            Đăng xuất
          </Button>
        </div>
      </div>

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

      {profile ? (
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <UserCheck className="size-5 text-primary" aria-hidden="true" />
              <CardTitle className="text-base">Tài khoản đang đăng nhập</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-foreground">{profile.fullName}</p>
              <p className="font-mono text-xs text-muted-foreground">@{profile.username}</p>
            </div>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-emerald-600/30 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Đang hoạt động ({profile.status})
            </span>
          </CardContent>
        </Card>
      ) : null}

      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">Thiết bị đang đăng nhập ({sessions.length})</CardTitle>
            <CardDescription>
              Nếu thấy thiết bị lạ, hãy đăng xuất thiết bị đó ngay lập tức để bảo vệ tài khoản.
            </CardDescription>
          </div>

          {!confirmRevokeAll ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={otherSessionsCount === 0 || revokingAll || loggingOutCurrent}
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
                    Đang thu hồi...
                  </>
                ) : (
                  `Xác nhận đăng xuất ${otherSessionsCount} thiết bị khác`
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
        </CardHeader>

        <CardContent className="divide-y pt-2">
          {sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Không có phiên đăng nhập nào đang hoạt động.
            </p>
          ) : (
            sessions.map((item) => {
              const isItemRevoking = revokingSessionId === item.public_id;
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
                          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                            Thiết bị hiện tại
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>IP: {formatDisplayIp(item.ipAddress)}</span>
                        <span>Đăng nhập: {formatVietnameseDateTime(item.createdAt)}</span>
                        <span>Hoạt động gần nhất: {formatVietnameseDateTime(item.lastUsedAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center justify-end">
                    <Button
                      type="button"
                      variant={item.isCurrent ? 'outline' : 'secondary'}
                      size="sm"
                      disabled={isItemRevoking || revokingAll || loggingOutCurrent}
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

      <ChangePasswordCard onPasswordChanged={handleRefreshSessions} />
    </div>
  );
}
