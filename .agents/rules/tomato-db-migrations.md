---
trigger: glob
globs: 'src/core/db/**'
description: 'Quy chuẩn Drizzle ORM, PostgreSQL 16 Schema, chuỗi Migration 0000–0011 bất biến và Row-Level Security (RLS)'
---

# Quy Chuẩn Cơ Sở Dữ Liệu, Drizzle Schema, Migrations & RLS

## 1. Kết Nối Pool & Quy Ước Schema (`src/core/db/`)

- Truy cập DB qua singleton `getDb()` / `getDatabasePool()` (`src/core/db/index.ts`) dùng `normalizePostgresConnectionString` (`src/core/db/connection-string.ts`) và `statement_timeout: 5_000` an toàn cho Serverless (Neon Pooled ở runtime, Direct Connection khi chạy DDL migration).
- **Quy ước cột chuẩn** trong `src/core/db/schema/*.ts` (luôn re-export tại `src/core/db/schema/index.ts`):
  - Khóa chính nội bộ `id: uuid('id').primaryKey()` sinh ở ứng dụng bằng `generateUuidV7()` (`src/core/crypto/id.ts`).
  - Định danh công khai `publicId: varchar('public_id', { length: 36 }).notNull().unique()` sinh bằng `generatePublicId()` (UUIDv4 CSPRNG) cho các bảng tiếp xúc API.
  - Mọi cột thời gian dùng `timestamp(..., { withTimezone: true })` (`TIMESTAMPTZ`).
- **Ràng buộc & Index**: Khai báo `CHECK` constraints cho bất biến dữ liệu (bộ đếm `>= 0`, chống tự tham chiếu `follower_id <> followee_id`, `blocker_id <> blocked_id`, `caller_id <> callee_id`, `pending_messages_sent <= 3`, `edit_count <= 5`, giới hạn `ciphertext_size_bytes`); dùng khóa ngoại kép `(conversation_id, message_id)` cho bảng con gắn với tin nhắn (`message_pins`, `message_reactions`); giữ index sát truy vấn (`varchar_pattern_ops`, `gin_trgm_ops`, `(conversation_id, seq DESC)`).
- Bắt lỗi tranh chấp đồng thời bằng `isPostgresUniqueViolation` và `extractPostgresConstraintName` (`src/core/db/errors.ts`) để xử lý idempotent hoặc trả `409`, không để văng `500`.

## 2. Tính Bất Biến Của Chuỗi Migration (`0000`–`0011`)

- **TUYỆT ĐỐI KHÔNG sửa, xóa, đổi tên hoặc gộp** bất kỳ file SQL đã commit nào trong `src/core/db/migrations/` (`0000_init_auth_schema.sql` → `0011_add_m13_chat_interactions_rls.sql`) hay snapshot/`_journal.json` trong `src/core/db/migrations/meta/`.
- Bản đồ tham chiếu nhanh:
  - `0000`–`0002`: Auth gốc (`users`, `auth_identities`, `sessions`, `verification_tokens`, `audit_logs`), `full_name`/`username`/`gender`, `password_change_ticket`.
  - `0003`–`0005`: `pg_trgm`, `user_handle_history`, `@handle` + cờ riêng tư, `follows`, `blocks`, `notifications` (`dedupe_key`).
  - `0006`–`0009`: E2EE & Direct Chat + RLS (`user_e2ee_devices` + `is_sync_key`, `user_e2ee_key_backups`, `conversations` + `direct_pair_key`, `conversation_participants`, `messages`, `message_user_deletions`, `message_attachments`).
  - `0010`–`0011`: Cuộc gọi 1-1 & Tương tác Chat + RLS (`call_sessions`, `call_event_meta`, `reply_to_message_id`, `is_forwarded`, `pinned_at`/`muted_at`, `message_pins`, `message_reactions`).

## 3. Quy Trình Sinh & Chạy Migration Mới (`0012+`)

1. Cập nhật `src/core/db/schema/*` (export tại `schema/index.ts`) rồi chạy `npm run db:generate` (`drizzle.config.ts` bật `strict: true`) để sinh file mới `0012_...sql`.
2. Bổ sung câu lệnh `ENABLE ROW LEVEL SECURITY`, `CREATE POLICY`, SQL helper functions hoặc partial index nếu Drizzle chưa tự sinh; viết bước backfill an toàn cho dữ liệu cũ trước khi đặt `NOT NULL`.
3. Kiểm tra bằng `npm run db:check` và chạy áp dụng qua `npm run db:migrate`. **Cấm dùng `drizzle-kit push`** trên nhánh chung hoặc Production.

## 4. PostgreSQL Row-Level Security (RLS) & Khóa Giao Dịch (`src/core/db/rls.ts`)

- Toàn bộ bảng E2EE, Nhắn tin & Cuộc gọi (`user_e2ee_devices`, `user_e2ee_key_backups`, `conversations`, `conversation_participants`, `messages`, `message_user_deletions`, `message_attachments`, `call_sessions`, `message_reactions`, `message_pins` và bảng mở rộng liên quan) bắt buộc bật `ENABLE ROW LEVEL SECURITY` kèm policy riêng cho `SELECT`, `INSERT`, `UPDATE`, `DELETE`.
- Tái sử dụng các hàm SQL chuẩn: `public.app_current_user_id()`, `public.app_is_conversation_member(conv_id)`, `public.app_user_has_active_call(target_user_id)`, `public.app_sweep_stale_calls_for_user(target_user_id)`. Mọi hàm `SECURITY DEFINER` mới (chỉ dùng để tránh đệ quy RLS) bắt buộc gắn `SET search_path = public`.
- Mọi truy vấn vào bảng có RLS **bắt buộc bọc trong `withRlsContext(actorUserId, async (tx) => ...)`** (hoặc `applyRlsSessionContext(tx, actorUserId)`) dùng `set_config('app.current_user_id', ..., true)` cục bộ theo transaction để chống rò rỉ định danh trong Pool.
- Giữ khóa đồng bộ nguyên tử: `FOR UPDATE` trên `conversations` khi cấp `seq` cho `messages`, và `pg_advisory_xact_lock` khi xoay vòng chuỗi phiên `family_id`.
