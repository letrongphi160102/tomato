# TOMATO — Bất Biến Kiến Trúc & Bảo Mật Toàn Dự Án

## 1. Nguồn Sự Thật & Ngữ Cảnh

- **TOMATO** vận hành trên Next.js 16 (App Router), React 19, TypeScript 6 (`strict: true`), PostgreSQL 16 + Drizzle ORM + RLS, Redis (Upstash REST / `ioredis`), Zero-Knowledge E2EE (WebCrypto) và WebRTC P2P (`DTLS-SRTP`).
- Đối chiếu bắt buộc với `docs/phase1/`, `docs/phase2/` và mã nguồn thực tế **M0–M13**. Cấm bịa tên file, hàm hay bảng không tồn tại.

## 2. Quy Trình Plan-First & An Toàn Git

- **Plan-First**: Luôn đọc mã nguồn thực tế và trình bày kế hoạch (schema/migration, hợp đồng API, UI/UX, kịch bản test) để người dùng duyệt trước khi viết code cho cột mốc hoặc thay đổi kiến trúc mới.
- **Không tự ý thao tác Git**: Tuyệt đối không chạy `git commit`, `git push`, `git tag` hay sửa lịch sử Git khi chưa có lệnh trực tiếp từ người dùng. Không bao giờ đưa `.env.local`, khóa bí mật hoặc PII thật vào Git.

## 3. Modular Monolith & Ngân Sách 0đ (Port & Adapter)

- **Phân tầng**: Route Handlers (`src/app/api/v1/**`) chỉ kiểm tra HTTP/CSRF/Rate Limit, validate Zod, gọi `src/modules/{auth,profile,social,notifications,presence,chat,calls}/` và trả DTO. Cấm dùng Next.js Server Actions cho nghiệp vụ lõi (sẵn sàng cho Mobile App).
- **Ngân sách 0đ trọn đời**: Hạ tầng Production chỉ dùng gói miễn phí không thẻ tín dụng, không trial (Vercel Hobby `sin1`, Neon PG, Upstash Redis, Ably, Vercel Blob, Metered TURN, Cloudflare Turnstile, Gmail SMTP/Brevo, Sentry).
- **Port & Adapter**: Mọi dịch vụ ngoài (`EmailProvider`, `CaptchaProvider`, `RedisClient`, `MediaStorageProvider`, `RealtimeProvider`, `TurnCredentialProvider` trong `src/core/**`) phải có adapter local/in-memory để `npm run dev`, `npm test`, `npm run build` chạy 100% offline không cần `.env.local`.

## 4. Bảo Toàn Giai Đoạn 1 & Luật Mật Khẩu Không Dấu Tiếng Việt

- Giữ nguyên xoay vòng Refresh Token theo `family_id` (`pg_advisory_xact_lock`), đổi mật khẩu 2 bước (`__Host-tomato_pwd_ticket`), CSRF 3 lớp (`src/core/security/csrf.ts`), Pino `REDACT_PATHS` (`src/core/logger/index.ts`), Sentry scrub (`src/core/monitoring/sentry-scrub.ts`) và toàn bộ migration đã commit trong `src/core/db/migrations/`.
- **Luật mật khẩu bất biến** (`strongPasswordSchema`, `hasVietnameseDiacritics` tại `src/modules/auth/auth.schemas.ts`): chuẩn hóa `NFKC`, **không `.trim()`**, dài `12–128` ký tự, **cấm dấu tiếng Việt và `đ`/`Đ`**, cấm trùng/chứa email, họ tên, `@username` hoặc `common-passwords.ts`.

## 5. Bất Biến Bảo Mật & Giao Diện Toàn Cục

- **Không lộ `UUIDv7`**: Khóa chính `id` từ `generateUuidV7()` (`src/core/crypto/id.ts`) chỉ dùng nội bộ Server/DB; mọi URL, API, JWT, Realtime chỉ nhận/trả `public_id` (`generatePublicId()`) hoặc `@handle`.
- **Deny-by-default & `404` đồng nhất**: Lấy `actor` từ Access Token đã xác minh; thiếu quyền hoặc vướng Block 2 chiều luôn trả `404 NOT_FOUND`.
- **Zod v4 CSP-safe**: Mọi file import `{ z } from 'zod'` trong `src/` phải đặt `import '@/core/validation/zod-config';` ở dòng phía trên (`config({ jitless: true })`).
- **Giao diện sạch 100%**: Cấm hiển thị thuật ngữ kỹ thuật (_E2EE, AES-256-GCM, ECDH, WebRTC, BOLA, RLS, Cột mốc M0–M13..._) hay nút dev lên UI người dùng.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
