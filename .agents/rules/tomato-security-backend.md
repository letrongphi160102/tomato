---
trigger: glob
globs: 'src/app/api/**, src/modules/**, src/core/**, src/proxy.ts'
description: 'Quy chuẩn bảo mật Backend OWASP 2025, Proxy/CSP Headers, Auth/CSRF, ReBAC Policy 2 lớp, Realtime/Storage/TURN và Redaction'
---

# Quy Chuẩn Bảo Mật & Kiến Trúc Backend (TOMATO)

## 1. Runtime, Next.js 16 Proxy & Security Headers

- Route Handlers dùng gói native/socket (`@node-rs/argon2`, `sharp`, `nodemailer`, `pg`) bắt buộc khai báo `export const runtime = 'nodejs'` (cấm Edge) và giữ `serverExternalPackages` trong `next.config.ts`.
- Cổng HTTP tại `src/proxy.ts` (`export function proxy`) + `src/core/security/headers.ts` (`generateCspNonce`, `buildSecurityHeaders`, `buildContentSecurityPolicy`):
  - Production dùng CSP `'nonce-...'` + `'strict-dynamic'`, **cấm `'unsafe-eval'`**, tách `style-src-elem`/`style-src-attr`, gắn `Permissions-Policy: camera=(self), microphone=(self), geolocation=()` và `API_CSP_VALUE` cho `/api/*`.
  - `/reset-password` ép `Referrer-Policy: no-referrer` + `Cache-Control: no-store, max-age=0`; `?next=` phải lọc qua `sanitizeRedirectPath()` (`src/lib/auth-client.ts`).

## 2. Cookie `__Host-`, CSRF 3 Lớp & Hợp Đồng HTTP

- Quản lý cookie qua `src/core/security/cookies.ts` (`getCookieNames`, `setAuthCookies`, `clearAuthCookies`, `setPasswordChangeTicketCookie`): Production dùng `__Host-tomato_at`, `__Host-tomato_rt`, `__Host-tomato_csrf`, `__Host-tomato_pwd_ticket` (`Secure; Path=/; SameSite=Lax`, **cấm đặt `domain`**); `development`/`test` bỏ tiền tố `__Host-`.
- Mọi `POST`/`PUT`/`PATCH`/`DELETE` bắt buộc gọi `enforceCsrfAndOrigin(request)` (`src/core/security/csrf.ts`): kiểm tra `Sec-Fetch-Site`, `Origin` khớp `ALLOWED_ORIGINS`, và `x-csrf-token` qua `timingSafeEqualUtf8` (`403 CSRF_VALIDATION_FAILED`).
- Trả response qua `createAuthJsonResponse`, `createErrorResponse`, `formatZodErrorDetails` (`src/core/security/http-response.ts`) kèm `Cache-Control: no-store, max-age=0`, không echo mật khẩu/OTP lỗi; đọc body giới hạn byte qua `parseAuthJsonBody` (`src/app/api/v1/auth/_utils.ts`).

## 3. Validation, Chống Mass Assignment & Bảo Vệ `UUIDv7` (BOPLA)

- Đặt `import '@/core/validation/zod-config';` trước `import { z } from 'zod';`; schema đầu vào dùng `.strict()`; biến môi trường qua `getEnv()` (`src/core/config/env.ts`).
- URL/body chỉ nhận UUIDv4 (`PUBLIC_ID_UUID_V4_REGEX`, `chatPublicIdParamSchema`) hoặc `@handle` (`src/modules/profile/handle.ts`), từ chối UUIDv7 nội bộ. Chỉ trả DTO allowlist (`toPublicUserProfile`, `toUserProfileDto`...) — cấm trả thẳng `UserRow`, `SessionRow`, `AuthenticatedPrincipal`.

## 4. ReBAC Policy, Nghiệp Vụ Server-Side & Tối Ưu Truy Vấn

- Lấy `AuthenticatedPrincipal` từ Access Token; chạy `getRateLimiter()`, `LoginBruteForceGuard`, `PinResetOtpStore` (`src/core/redis/`) **trước** DB nặng hoặc Argon2id.
- Mọi truy cập qua `.policy.ts` tập trung (`auth`, `profile`, `social`, `notification`, `presence`, `chat`, `call`, `realtime`) theo **Deny-by-default**: kiểm tra user `active`, thành viên và `isBidirectionallyBlocked`; trả **`404 NOT_FOUND` đồng nhất** (`assertSocialAuthorized`, `assertChatAuthorized`, `assertCallAuthorized`, `assertCanReadProfile`, `assertCanRevokeSession`).
- **Luật nghiệp vụ Server-side**: Sửa (`text`, ≤5 lần) & Thu hồi chỉ trong **5 phút (`300_000ms`)** giờ Server/PG (thu hồi xóa `ciphertext = NULL`, `crypto_header = NULL`); `pending` chỉ `text`, ≤3 tin, ≤5 người lạ/ngày, cấm media/gọi/ghim/cảm xúc/chuyển tiếp; cưỡng chế đối xứng `canViewTargetPresence`, `canExposeSymmetricReadReceipt`; Block cắt ngay follow/request 2 chiều, thông báo và cuộc gọi đang diễn ra.
- **Chống N+1, Khóa `FOR UPDATE` & An toàn Subquery Drizzle**:
  - Cấm lặp N+1 trong `runInRlsTx`; preview danh sách chat (`listConversationsForUser`) gộp bằng `DISTINCT ON (m.conversation_id)` giữ đủ `m.seq > cp.cleared_before_seq` và `NOT EXISTS message_user_deletions`.
  - Trong transaction `FOR UPDATE` theo lô (`updateOwnPrivacySettings`), chỉ batch `INSERT ... ON CONFLICT`; đẩy việc đếm `GROUP BY recipient_id` (`countUnreadForRecipients`) và bắn Realtime ra **sau commit**.
  - Trong câu `.select().from(users)` **không có `.innerJoin()`**, cấm dùng `${users.id}` bên trong subquery trên `blocks`/`follows` (Drizzle lược thành `"id"` trần bị cột `"id"` bảng con che khuất) — luôn truyền thẳng tham số `${targetUserId}` hoặc tên bảng tường minh.

## 5. Kênh Phụ (Realtime, Media, TURN) & Redaction Đa Tầng

- **Realtime (`src/core/realtime/channel.ts`)**: `/api/v1/realtime/token` chỉ cấp `subscribe` trên `buildUserRealtimeChannel(actor.user.publicId)` (`buildSubscribeOnlyCapability`); mọi sự kiện phát qua `assertRealtimePayloadSafe` (chặn `id`, `user_id`, `email`, `token`, `ciphertext`, `crypto_header`, `wrapped_keys`).
- **Media (`src/core/media/avatar-pipeline.ts`, `src/core/storage/`)**: `processAvatarImage` kiểm magic bytes `file-type` (JPEG/PNG/WebP, cấm SVG), `AVATAR_MAX_INPUT_PIXELS = 25_000_000`, `sharp` nén WebP 512×512 xóa EXIF/GPS; đính kèm chat lưu bản mã, xóa blob khi thu hồi.
- **TURN (`src/core/webrtc/turn-credential-provider.ts`)**: `MeteredTurnCredentialProvider` giữ kín secret ở Server (TTL ≤900s, fallback `StunFallbackTurnProvider`), lọc `sanitizeIceServers`, cấm log URL chứa key.
- **Redaction**: Đồng bộ trường nhạy cảm ở `SENSITIVE_KEYS` (`src/core/logger/index.ts`), `SENSITIVE_KEY_PATTERN` / `scrubSentryEvent` (`src/core/monitoring/sentry-scrub.ts`) và `AuditLogService`. Chỉ gửi lỗi `5xx` lên Sentry.
