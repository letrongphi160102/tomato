---
trigger: glob
globs: 'tests/**, .github/**, package.json'
description: 'Quy chuẩn kiểm thử Vitest (Unit, Security BOLA 5 nhân vật, Integration RLS NOBYPASSRLS), Zod jitless guard và GitHub Actions CI/Gitleaks'
---

# Quy Chuẩn Kiểm Thử Tự Động, Ma Trận BOLA & CI/CD (TOMATO)

## 1. Kiến Trúc 3 Tầng Kiểm Thử Vitest (`vitest.config.mts`, `package.json`)

- **Unit & Security Tests (`npm test` → `tests/unit` + `tests/security`)**:
  - Bắt buộc chạy xanh **100% độc lập, không cần Docker, không gọi mạng ngoài và không phụ thuộc `.env.local`**.
  - Luôn thay thế dịch vụ ngoài bằng các adapter bộ nhớ (`InMemoryRealtimeAdapter`, `InMemoryMediaStorageAdapter`, `StunFallbackTurnProvider`, `InMemoryCallDeclineCooldownStore`) thông qua các helper `set*ForTesting` và khôi phục sạch trong `afterEach` bằng `reset*ForTesting` kèm `clearMemoryKeystoreForTesting()`.
- **Integration Tests (`npm run test:integration` → `tests/integration`)**:
  - Kiểm thử vòng đời đầu-cuối trên PostgreSQL 16 + Redis 7 + Mailpit thật (Docker local hoặc service containers trên CI).
  - Nạp `.env.local` an toàn không ghi đè biến môi trường sẵn có qua `tests/setup/load-local-env.ts`, ánh xạ `server-only` qua `tests/setup/server-only-stub.ts`, và luôn đóng kết nối trong `afterAll` bằng `closeDatabasePool()` / `closeRedisClient()`.

## 2. Ma Trận Bảo Mật BOLA 5 Nhân Vật, RLS `NOBYPASSRLS` & Guard CSP

- Mọi endpoint REST, luồng Realtime, tải Media hoặc thao tác Chat/Call mới bắt buộc có bài kiểm thử bảo mật trong `tests/security/` (và mở rộng `tests/security/phase2-bola-matrix.test.ts`) đối chiếu đủ **5 nhân vật chuẩn**:
  1. `User A`: Chủ sở hữu / Người gửi / Người gọi.
  2. `User B`: Người nhận / Người theo dõi đã được duyệt / Thành viên hợp lệ của hội thoại.
  3. `User C`: Tài khoản đã chặn `A` hoặc bị `A` chặn — mọi truy cập Profile/Search/Follow/Chat/Media/Call/Presence phải nhận **`404 NOT_FOUND`** và ẩn 2 chiều.
  4. `User D`: Người lạ chưa duyệt với tài khoản Private hoặc người ngoài hội thoại/cuộc gọi — bắt buộc nhận **`404 NOT_FOUND`**.
  5. `Anon`: Chưa đăng nhập — bị từ chối `401` hoặc `403` (khi thiếu/sai CSRF).
- Duy trì đầy đủ các bài gác bất biến bảo mật:
  - Chống CSRF 3 lớp (`CSRF_HEADER_NAME` + `Origin`), chống dò email/timing, phát hiện reuse Refresh Token thu hồi toàn bộ `family_id`.
  - Cưỡng chế giới hạn Server-side: từ chối sửa/thu hồi ở giây thứ `301`, chặn tin thứ `4` và chặn gửi media/call trong hội thoại `pending`, cưỡng chế đối xứng Active Status & Read Receipts.
  - Bài gác `tests/security/zod-jitless-csp-guard.test.ts`: mọi file dùng `z` trong `src/` phải nạp `import '@/core/validation/zod-config';` trước `import { z } from 'zod';`.
- **Kiểm chứng PostgreSQL RLS thực chiến**: Mọi bảng bật RLS phải có integration test thực thi dưới role PostgreSQL không có quyền `BYPASSRLS` (`NOBYPASSRLS`, theo mẫu `tests/integration/chat-rls.integration.test.ts` và `tests/integration/phase2-m10..m13-*-rls.integration.test.ts`) chứng minh chính PostgreSQL chặn đọc/ghi chéo user.

## 3. An Toàn Gitleaks, Phụ Thuộc & GitHub Actions CI (`.github/workflows/ci.yml`)

- **Chống báo động giả & rò rỉ trên Gitleaks**: Tuyệt đối không đặt chuỗi literal có hình dạng giống JWT (`eyJ...`), khóa riêng PEM, mật khẩu thật hay API key có tiền tố nhà cung cấp (`xkeysib-...`, `sk_live_...`, DSN thật) trong `tests/**` hoặc file cấu hình. Chỉ dùng giá trị giả tường minh (`ci-only-synthetic-...`) hoặc hàm sinh động lúc chạy test.
- **Quản lý `package.json`**: Tuân thủ Node.js `24.x`; giữ gọn phụ thuộc phục vụ hạ tầng 0đ; khi thêm thư viện native/server-only mới cần đối chiếu `serverExternalPackages` trong `next.config.ts` và kiểm tra lỗ hổng bằng `npm audit --audit-level=high`.
- **Bảo mật Chuỗi cung ứng CI (OWASP A03:2025)**:
  - Trong `.github/workflows/ci.yml`, ghim **100% GitHub Actions bên thứ ba theo commit SHA 40 ký tự đầy đủ**, giới hạn `permissions: contents: read` và luôn cài đặt bằng `npm ci`.
  - Giữ nguyên đủ 2 job bắt buộc: `quality-and-tests` (`lint` → `format:check` → `typecheck` → `test` → `db:migrate` → `test:integration` → `build` ở `NODE_ENV=production`) và `security-audit` (`npm audit --audit-level=high` + xác minh SHA-256 binary `gitleaks` quét toàn bộ lịch sử `fetch-depth: 0`).

## 4. Cổng Kiểm Chứng Bắt Buộc Trước Khi Hoàn Tất

- Trước khi kết thúc bất kỳ thay đổi mã nguồn nào, phải chạy xác nhận xanh chuỗi lệnh: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test` và `npm run build` (kèm `npm run db:migrate && npm run test:integration` khi có Docker PostgreSQL/Redis).
