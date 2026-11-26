---
trigger: glob
globs: 'src/app/api/**, src/modules/**, src/core/**, src/proxy.ts'
description: 'Quy chuẩn bảo mật Backend OWASP 2025, Proxy/CSP Headers, Auth/CSRF, ReBAC Policy 2 lớp, Realtime/Storage/TURN và Redaction'
---

# Quy Chuẩn Bảo Mật & Kiến Trúc Backend (TOMATO)

## 1. Runtime, Next.js 16 Proxy & Security Headers

- Route Handlers dùng gói native/socket (`@node-rs/argon2`, `sharp`, `nodemailer`, `pg`) bắt buộc khai báo `export const runtime = 'nodejs'` (cấm Edge Runtime) và giữ `serverExternalPackages` trong `next.config.ts`.
- Cổng HTTP đặt tại `src/proxy.ts` (`export function proxy`) kết hợp `src/core/security/headers.ts` (`generateCspNonce`, `buildSecurityHeaders`, `buildContentSecurityPolicy`):
  - Production dùng CSP `'nonce-...'` + `'strict-dynamic'`, **cấm `'unsafe-eval'`**, tách `style-src-elem`/`style-src-attr`, gắn `Permissions-Policy: camera=(self), microphone=(self), geolocation=()` và `API_CSP_VALUE` cho `/api/*`.
  - Trang `/reset-password` bắt buộc ép `Referrer-Policy: no-referrer` + `Cache-Control: no-store, max-age=0`; tham số `?next=` phải lọc qua `sanitizeRedirectPath()` (`src/lib/auth-client.ts`).

## 2. Cookie `__Host-`, CSRF 3 Lớp & Hợp Đồng HTTP

- Quản lý cookie qua `src/core/security/cookies.ts` (`getCookieNames`, `setAuthCookies`, `clearAuthCookies`, `setPasswordChangeTicketCookie`): Production HTTPS dùng `__Host-tomato_at`, `__Host-tomato_rt`, `__Host-tomato_csrf`, `__Host-tomato_pwd_ticket` (`Secure; Path=/; SameSite=Lax`, **cấm đặt `domain`**); `development`/`test` tự bỏ tiền tố `__Host-`.
- Mọi request `POST`/`PUT`/`PATCH`/`DELETE` bắt buộc gọi `enforceCsrfAndOrigin(request)` (`src/core/security/csrf.ts`): kiểm tra `Sec-Fetch-Site`, `Origin` khớp `ALLOWED_ORIGINS`, và Double-Submit `x-csrf-token` bằng `timingSafeEqualUtf8` (`403 CSRF_VALIDATION_FAILED` khi sai).
- Trả response qua `createAuthJsonResponse`, `createErrorResponse`, `formatZodErrorDetails` (`src/core/security/http-response.ts`) kèm `Cache-Control: no-store, max-age=0`, không echo lại mật khẩu/OTP lỗi; đọc JSON body giới hạn byte theo stream (`parseAuthJsonBody` tại `src/app/api/v1/auth/_utils.ts`).

## 3. Validation, Chống Mass Assignment & Bảo Vệ `UUIDv7` (BOPLA)

- Đặt `import '@/core/validation/zod-config';` trước `import { z } from 'zod';`; schema đầu vào API bắt buộc dùng `.strict()`; biến môi trường đọc qua `getEnv()` (`src/core/config/env.ts`).
- Định danh trên URL/body chỉ nhận UUIDv4 (`PUBLIC_ID_UUID_V4_REGEX`, `chatPublicIdParamSchema`) hoặc `@handle` (`src/modules/profile/handle.ts`), từ chối UUIDv7 nội bộ. Chỉ trả DTO allowlist (`toPublicUserProfile`, `toUserProfileDto`...) — cấm trả trực tiếp `UserRow`, `SessionRow` hay `AuthenticatedPrincipal`.

## 4. ReBAC Policy Tập Trung & Cưỡng Chế Nghiệp Vụ Server-Side (BOLA)

- Lấy `AuthenticatedPrincipal` từ Access Token đã xác minh (không tin `user_id` từ client). Chạy `getRateLimiter()`, `LoginBruteForceGuard`, `PinResetOtpStore` (`src/core/redis/`) **trước** truy vấn DB nặng hoặc Argon2id.
- Mọi truy cập phải qua Policy tập trung (`auth`, `profile`, `social`, `notification`, `presence`, `chat`, `call` `.policy.ts` và `src/core/realtime/policy.ts`) theo nguyên tắc **Deny-by-default, fail-closed**: kiểm tra user `active`, thành viên tài nguyên và `isBidirectionallyBlocked`; trả **`404 NOT_FOUND` đồng nhất** (`assertSocialAuthorized`, `assertChatAuthorized`, `assertCallAuthorized`, `assertCanReadProfile`, `assertCanRevokeSession`).
- **Luật nghiệp vụ cưỡng chế 100% ở Server**:
  - Sửa (`text`, tối đa 5 lần) & Thu hồi tin nhắn chỉ trong **5 phút đầu (`300_000ms`)** theo giờ Server/PostgreSQL; thu hồi xóa `ciphertext = NULL`, `crypto_header = NULL`.
  - Hội thoại `pending`: chỉ `text`, tối đa 3 tin, tối đa 5 người lạ/ngày, cấm media/gọi điện/ghim/thả cảm xúc/chuyển tiếp.
  - Quyền riêng tư **Đối xứng**: `canViewTargetPresence` và `canExposeSymmetricReadReceipt`. Chặn user tự cắt follow/request 2 chiều, ẩn thông báo và ngắt ngay cuộc gọi đang diễn ra.

## 5. Kênh Phụ (Realtime, Media, TURN) & Redaction Đa Tầng

- **Realtime (`src/core/realtime/channel.ts`)**: `/api/v1/realtime/token` chỉ cấp quyền `subscribe` trên `buildUserRealtimeChannel(actor.user.publicId)` (`buildSubscribeOnlyCapability`, cấm `publish`); mọi sự kiện phát đi phải qua `assertRealtimePayloadSafe` (chặn `id`, `user_id`, `email`, `token`, `ciphertext`, `crypto_header`, `wrapped_keys`).
- **Media (`src/core/media/avatar-pipeline.ts`, `src/core/storage/`)**: `processAvatarImage` kiểm magic bytes `file-type` (JPEG/PNG/WebP, cấm SVG), `AVATAR_MAX_INPUT_PIXELS = 25_000_000`, `sharp` nén WebP 512×512 xóa sạch EXIF/GPS. Đính kèm chat lưu bản mã trên `MediaStorageProvider`, kiểm tra thành viên + chưa thu hồi khi tải, xóa blob khi thu hồi.
- **TURN (`src/core/webrtc/turn-credential-provider.ts`)**: `MeteredTurnCredentialProvider` giữ kín `METERED_DOMAIN`, `METERED_SECRET_KEY`, `METERED_TURN_API_KEY` ở Server (TTL ≤ 900s, fallback `StunFallbackTurnProvider`), lọc qua `sanitizeIceServers`, cấm log `error.message` chứa URL mang key.
- **Redaction**: Khi thêm trường nhạy cảm mới, cập nhật đồng bộ `SENSITIVE_KEYS` (`src/core/logger/index.ts`), `SENSITIVE_KEY_PATTERN` / `scrubSentryEvent` (`src/core/monitoring/sentry-scrub.ts`) và `AuditLogService` (`src/core/security/audit-log.service.ts`). Chỉ gửi lỗi `5xx` lên Sentry.
