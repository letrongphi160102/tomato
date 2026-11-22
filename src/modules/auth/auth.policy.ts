import 'server-only';

import type { SessionRow, UserRow } from '@/core/db/schema';
import { AuthDomainError } from '@/modules/auth/auth.errors';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';

/**
 * Danh tính đã xác thực ở tầng server (chứa khóa chính nội bộ UUIDv7).
 * Tuyệt đối KHÔNG trả trực tiếp đối tượng này ra HTTP response.
 */
export interface AuthenticatedPrincipal {
  readonly user: UserRow;
  readonly session: SessionRow;
}

function isActivePrincipal(
  principal: AuthenticatedPrincipal | null | undefined,
): principal is AuthenticatedPrincipal {
  if (!principal) {
    return false;
  }
  return (
    principal.user.status === 'active' &&
    principal.session.revokedAt === null &&
    principal.session.userId === principal.user.id
  );
}

/**
 * Nguyên tắc Deny by default (Mục 6.5):
 * Chỉ cho phép xem hoặc thao tác tập phiên của đúng chủ sở hữu tài khoản đang hoạt động.
 */
export function canAccessUserSessions(
  principal: AuthenticatedPrincipal | null | undefined,
  targetUserId: string | null | undefined,
): boolean {
  if (!isActivePrincipal(principal) || !targetUserId) {
    return false;
  }
  return principal.user.id === targetUserId;
}

/**
 * Nguyên tắc Deny by default chống IDOR / BOLA:
 * Chỉ cho phép thu hồi phiên khi phiên tồn tại và `targetSession.userId === principal.user.id`.
 */
export function canRevokeSession(
  principal: AuthenticatedPrincipal | null | undefined,
  targetSession: Pick<SessionRow, 'userId'> | null | undefined,
): boolean {
  if (!isActivePrincipal(principal) || !targetSession) {
    return false;
  }
  return targetSession.userId === principal.user.id;
}

/**
 * Kiểm tra quyền sở hữu phiên trước khi thu hồi 1 thiết bị cụ thể.
 * Nếu phiên không tồn tại HOẶC thuộc về người dùng khác, luôn trả cùng mã `404 Not Found`
 * để ngăn kẻ tấn công dò sự tồn tại phiên của người khác (IDOR / BOLA).
 */
export function assertCanRevokeSession(
  principal: AuthenticatedPrincipal | null | undefined,
  targetSession: SessionRow | null | undefined,
): asserts targetSession is SessionRow {
  if (!canRevokeSession(principal, targetSession)) {
    throw new AuthDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: AUTH_MESSAGES.sessionNotFound,
    });
  }
}

export function assertCanAccessUserSessions(
  principal: AuthenticatedPrincipal | null | undefined,
  targetUserId: string | null | undefined,
): void {
  if (!canAccessUserSessions(principal, targetUserId)) {
    throw new AuthDomainError({
      status: 403,
      code: 'FORBIDDEN',
      message: AUTH_MESSAGES.forbidden,
    });
  }
}

export function assertCanRevokeUserSessions(
  principal: AuthenticatedPrincipal | null | undefined,
  targetUserId: string | null | undefined,
): void {
  if (!canAccessUserSessions(principal, targetUserId)) {
    throw new AuthDomainError({
      status: 403,
      code: 'FORBIDDEN',
      message: AUTH_MESSAGES.forbidden,
    });
  }
}

/**
 * Nguyên tắc Deny by default: chỉ cho phép chính chủ tài khoản `active` có phiên hợp lệ
 * yêu cầu OTP và thực hiện đổi mật khẩu cho chính tài khoản của mình.
 */
export function canChangeOwnPassword(
  principal: AuthenticatedPrincipal | null | undefined,
): boolean {
  return isActivePrincipal(principal);
}

export function assertCanChangeOwnPassword(
  principal: AuthenticatedPrincipal | null | undefined,
): asserts principal is AuthenticatedPrincipal {
  if (!canChangeOwnPassword(principal)) {
    throw new AuthDomainError({
      status: 403,
      code: 'FORBIDDEN',
      message: AUTH_MESSAGES.forbidden,
    });
  }
}
