# ĐẶC TẢ KỸ THUẬT — PHẦN 2: CƠ SỞ DỮ LIỆU, API, MÃ HÓA E2EE, BẢO MẬT & LỘ TRÌNH (M6–M12)

- **Dự án:** TOMATO — Mạng xã hội (Giai đoạn 2)
- **Phiên bản:** 2.0
- **Tài liệu liên quan:** Phần 1 xem tại `docs/phase2/02-technical-spec-architecture.md`.

---

## 1. Thiết kế Cơ sở dữ liệu (PostgreSQL Schema & Indexing)

Tiếp tục tuân thủ tuyệt đối quy ước Giai đoạn 1:
- **Khóa chính nội bộ (`id`):** `UUIDv7` (không bao giờ lộ ra API/URL).
- **ID công khai (`public_id`):** Chuỗi ngẫu nhiên $\ge 128$-bit (URL-safe hoặc UUIDv4).
- **Migrations mới:** Luôn sinh file migration mới (`0002_...`, `0003_...`), không sửa các migration Giai đoạn 1 đã chạy.
- **Bật extension tìm kiếm:** `CREATE EXTENSION IF NOT EXISTS pg_trgm;` trong migration M6.

### 1.1. Mở rộng bảng `users` & Hồ sơ (`user_handle_history`)
Bổ sung các cột sau vào bảng `users` (hoặc bảng `user_profiles` 1-1 gắn với `users.id`):
- `handle`: `VARCHAR(30)` (NOT NULL — hiển thị giữ nguyên cách viết thường chuẩn hóa).
- `handle_normalized`: `VARCHAR(30)` (UNIQUE, NOT NULL — chỉ `[a-z0-9._]`).
- `bio`: `VARCHAR(160)` (DEFAULT `''`).
- `avatar_url`: `TEXT` (NULL — đường dẫn CDN kèm hash chống cache).
- `avatar_storage_key`: `TEXT` (NULL — key để xóa ảnh cũ khi thay/gỡ ảnh).
- `is_private`: `BOOLEAN` (NOT NULL, DEFAULT `false`).
- `show_active_status`: `BOOLEAN` (NOT NULL, DEFAULT `true`).
- `show_read_receipts`: `BOOLEAN` (NOT NULL, DEFAULT `true`).
- `followers_count`: `INTEGER` (NOT NULL, DEFAULT `0`).
- `following_count`: `INTEGER` (NOT NULL, DEFAULT `0`).
- `handle_changed_at`: `TIMESTAMPTZ` (NULL).
- **Indexes:**
  - `UNIQUE INDEX idx_users_handle_norm (handle_normalized)`
  - `INDEX idx_users_handle_prefix (handle_normalized varchar_pattern_ops)` (tìm prefix siêu tốc)
  - `INDEX idx_users_display_name_trgm USING GIN (display_name gin_trgm_ops)`

Bảng `user_handle_history`:
- `id` (UUIDv7 PK), `user_id` (FK), `old_handle_normalized` (`VARCHAR(30)`), `reserved_until` (`TIMESTAMPTZ` — giữ chỗ 14 ngày), `created_at`.

### 1.2. Mạng lưới Kết nối (`follows`, `blocks`, `notifications`)
- **Bảng `follows`:**
  - `id` (UUIDv7 PK), `follower_id` (FK `users.id`), `followee_id` (FK `users.id`), `status` (`ENUM('requested', 'following')`), `created_at`, `updated_at`.
  - **Ràng buộc:** `CHECK (follower_id <> followee_id)`, `UNIQUE INDEX (follower_id, followee_id)`.
  - **Indexes:** `(followee_id, status, created_at DESC)` (xem Followers & Yêu cầu follow), `(follower_id, status, created_at DESC)` (xem Following).
- **Bảng `blocks`:**
  - `id` (UUIDv7 PK), `blocker_id` (FK), `blocked_id` (FK), `created_at`.
  - **Ràng buộc:** `CHECK (blocker_id <> blocked_id)`, `UNIQUE INDEX (blocker_id, blocked_id)`, `INDEX (blocked_id, blocker_id)` (kiểm tra chặn 2 chiều trong O(log n)).
- **Bảng `notifications`:**
  - `id` (UUIDv7 PK), `public_id` (UNIQUE), `recipient_id` (FK), `actor_id` (FK), `type` (`ENUM('follow_request', 'follow_accepted', 'new_follower', 'message_request')`), `entity_public_id` (`VARCHAR(36)` NULL), `dedupe_key` (`VARCHAR(128)`), `read_at` (`TIMESTAMPTZ` NULL), `created_at`.
  - **Indexes:** `(recipient_id, created_at DESC)`, `UNIQUE INDEX (recipient_id, dedupe_key) WHERE read_at IS NULL`.

### 1.3. Hạ tầng Khóa E2EE (`user_e2ee_devices`, `user_e2ee_key_backups`)
- **Bảng `user_e2ee_devices`:**
  - `id` (UUIDv7 PK), `public_id` (UNIQUE), `user_id` (FK), `session_family_id` (UUID NULL — liên kết phiên thiết bị), `identity_public_key_jwk` (`JSONB` — khóa công khai ECDH P-256), `signing_public_key_jwk` (`JSONB` — khóa công khai ECDSA P-256), `key_fingerprint` (`CHAR(64)` — SHA-256 phục vụ Safety Number), `revoked_at` (`TIMESTAMPTZ` NULL), `created_at`.
- **Bảng `user_e2ee_key_backups`:** (Sao lưu khóa mã hóa bằng PIN/mật khẩu khôi phục do người dùng tự đặt — Server **không** giải mã được)
  - `user_id` (PK, FK), `encrypted_key_blob` (`TEXT` — ciphertext AES-256-GCM), `kdf_salt` (`VARCHAR(64)`), `kdf_params` (`JSONB`), `iv` (`VARCHAR(32)`), `version` (`SMALLINT`), `updated_at`.

### 1.4. Nhắn tin & Cuộc gọi (`conversations`, `conversation_participants`, `messages`, `message_user_deletions`, `call_sessions`)
- **Bảng `conversations`:**
  - `id` (UUIDv7 PK), `public_id` (UNIQUE), `type` (`ENUM('direct')` — sẵn sàng thêm `'group'` ở Giai đoạn 3), `direct_pair_key` (`VARCHAR(80)` UNIQUE — sinh từ `min(userA.id, userB.id) + ':' + max(...)` để đảm bảo 2 người chỉ có duy nhất 1 cuộc hội thoại 1-1 chống race condition), `last_seq` (`BIGINT` NOT NULL DEFAULT 0), `last_message_at` (`TIMESTAMPTZ` NULL), `created_at`.
- **Bảng `conversation_participants`:**
  - `conversation_id` (FK), `user_id` (FK), `inbox_state` (`ENUM('primary', 'pending', 'declined')` NOT NULL), `pending_messages_sent` (`SMALLINT` DEFAULT 0 — cưỡng chế tối đa 3 tin khi chưa được chấp nhận), `last_read_seq` (`BIGINT` DEFAULT 0), `cleared_before_seq` (`BIGINT` DEFAULT 0 — phục vụ "Xóa đoạn hội thoại ở phía mình"), `hidden_at` (`TIMESTAMPTZ` NULL), `joined_at`.
  - **PK:** `(conversation_id, user_id)`.
- **Bảng `messages`:**
  - `id` (UUIDv7 PK), `public_id` (UNIQUE), `conversation_id` (FK), `sender_id` (FK), `seq` (`BIGINT` NOT NULL — tăng đơn điệu trong từng conversation nhờ row lock trên `conversations`), `client_msg_id` (`VARCHAR(64)` NOT NULL — chống gửi trùng khi mất mạng), `message_type` (`ENUM('text', 'image', 'voice', 'call_event')`), `ciphertext` (`TEXT` NULL — payload đã mã hóa E2EE; `NULL` khi bị thu hồi), `crypto_header` (`JSONB` NULL — chứa `iv`, `senderDevicePublicId`, `ratchetStep`, `wrappedKeys` cho các thiết bị tham gia, `alg: 'ECDH-P256-HKDF-AES256GCM'`), `attachment_storage_key` (`TEXT` NULL — dùng để xóa file blob trên Storage khi thu hồi), `edit_count` (`SMALLINT` DEFAULT 0), `edited_at` (`TIMESTAMPTZ` NULL), `recalled_at` (`TIMESTAMPTZ` NULL), `created_at` (`TIMESTAMPTZ` NOT NULL).
  - **Indexes:** `UNIQUE (conversation_id, seq)`, `UNIQUE (conversation_id, sender_id, client_msg_id)`.
- **Bảng `message_user_deletions`:** (Xóa 1 dòng tin nhắn ở phía mình)
  - `message_id` (FK), `user_id` (FK), `deleted_at` (`TIMESTAMPTZ` NOT NULL). **PK:** `(message_id, user_id)`.
- **Bảng `call_sessions`:**
  - `id` (UUIDv7 PK), `public_id` (UNIQUE), `conversation_id` (FK), `caller_id` (FK), `callee_id` (FK), `call_type` (`ENUM('audio', 'video')`), `status` (`ENUM('ringing', 'connected', 'ended', 'missed', 'declined', 'busy')`), `started_at`, `connected_at`, `ended_at`.

---

## 2. Kiến trúc Mã hóa Đầu cuối (E2EE) & Mã hóa Dữ liệu

### 2.1. E2EE Tin nhắn (WebCrypto Native — Không tự chế thuật toán)
1. **Khởi tạo thiết bị:** Khi người dùng vào mục Nhắn tin lần đầu trên trình duyệt, Client dùng `window.crypto.subtle` tạo cặp khóa `ECDH (P-256)` (`extractable: false`) lưu vào IndexedDB và gửi phần **Public Key** lên `POST /api/v1/e2ee/devices`.
2. **Mã hóa tin nhắn 1-1:**
   - Khi A nhắn cho B, Client A lấy danh sách thiết bị đang hoạt động của B (và các thiết bị khác của chính A để đồng bộ đa thiết bị).
   - Client A sinh một **Message Key ngẫu nhiên 256-bit** (hoặc dẫn xuất từ symmetric chain ratchet), mã hóa nội dung JSON `{ text, replyTo?, media?: { url, fileKey, fileIv, sha256, mime, w, h, duration, blurhash } }` bằng **`AES-256-GCM`** với `IV` ngẫu nhiên 96-bit và **AAD (Additional Authenticated Data)** = `conversationPublicId | senderPublicId | clientMsgId` (chống đánh tráo bản mã giữa các cuộc trò chuyện).
   - **Message Key** được bọc (key-wrap) bằng khóa chia sẻ từ `ECDH(A_ephemeral_priv, Device_pub) -> HKDF-SHA256` cho từng thiết bị nhận.
   - Server **chỉ nhận và lưu `ciphertext` + `crypto_header`**, tuyệt đối không có khả năng đọc nội dung tin nhắn.
3. **Mã hóa Ảnh HD & Tin nhắn thoại (Voice):**
   - Trước khi tải lên, Client sinh `fileKey` (256-bit) + `fileIv` (96-bit) ngẫu nhiên riêng cho từng file → mã hóa toàn bộ byte file bằng **`AES-256-GCM`** → tính `SHA-256` của bản mã.
   - Tải khối nhị phân đã mã hóa lên Storage qua API đã xác thực. Đường dẫn + `fileKey` + `fileIv` + `sha256` được đặt **bên trong phong bì E2EE** của tin nhắn.
   - Khi người nhận xem ảnh hoặc nghe voice: tải bản mã → kiểm tra `SHA-256` → giải mã `AES-256-GCM` trong bộ nhớ trình duyệt thành `Blob URL` tạm (tự động `URL.revokeObjectURL` khi đóng).
4. **Khôi phục đa thiết bị & Xác minh an toàn:**
   - **Sao lưu bằng mã PIN 6 số (tùy chọn):** Mã hóa bản sao khóa bằng `PBKDF2-SHA256` ($\ge 600.000$ vòng lặp) + `AES-256-GCM` trên Client trước khi lưu lên `user_e2ee_key_backups` để người dùng đăng nhập máy mới vẫn đọc được tin cũ.
   - **Mã an toàn (Safety Number):** Tính `SHA-256` từ danh sách khóa công khai đã sắp xếp của 2 người dùng để kiểm tra chéo chống nghe lén MITM (hiển thị gọn trong mục *Thông tin đoạn chat*).

### 2.2. Mã hóa Cuộc gọi WebRTC 1-1
- Media âm thanh & hình ảnh giữa 2 trình duyệt được mã hóa bắt buộc bằng **DTLS-SRTP** (chuẩn của WebRTC P2P).
- Toàn bộ tín hiệu thiết lập cuộc gọi (SDP Offer/Answer, ICE Candidate) đi qua HTTPS TLS 1.3 + Ably WSS TLS 1.3 và **chỉ chuyển tiếp sau khi Server xác nhận không bị chặn & không ở trạng thái Tin nhắn đang chờ**.
- Chống lộ IP (tùy chọn nâng cao trong Cài đặt) và cấp TURN credential ngắn hạn (hạn $\le 15$ phút) từ phía Server.

---

## 3. Hợp đồng API & Phòng thủ Bảo mật (OWASP Top 10:2025)

### 3.1. Nhóm REST API mới (`/api/v1/...`)
Mọi API đều trả `Cache-Control: no-store`, validate 100% input qua Zod **strict mode (từ chối field lạ — chống Mass Assignment / BOPLA)** và lọc output qua DTO allowlist.

| Nhóm | Endpoints chính |
| :--- | :--- |
| **Hồ sơ & Tìm kiếm** | `GET /users/search?q=...`, `GET /users/:handle`, `PATCH /users/me/profile`, `PATCH /users/me/privacy`, `POST /users/me/avatar`, `DELETE /users/me/avatar` |
| **Follow & Chặn** | `POST /social/follow/:userPublicId`, `DELETE /social/follow/:userPublicId`, `GET /social/follow-requests`, `POST /social/follow-requests/:userPublicId/accept`, `POST /social/follow-requests/:userPublicId/decline`, `DELETE /social/followers/:userPublicId`, `GET /social/users/:userPublicId/followers`, `GET /social/users/:userPublicId/following`, `GET /social/blocks`, `POST /social/blocks/:userPublicId`, `DELETE /social/blocks/:userPublicId` |
| **Thông báo & Realtime** | `GET /notifications`, `POST /notifications/read`, `POST /realtime/token`, `POST /presence/heartbeat`, `POST /presence/query` |
| **E2EE & Nhắn tin** | `POST /e2ee/devices`, `GET /e2ee/users/:userPublicId/keys`, `PUT /e2ee/backup`, `GET /e2ee/backup`, `GET /conversations?tab=primary|pending`, `POST /conversations/direct`, `POST /conversations/:publicId/accept`, `POST /conversations/:publicId/decline`, `DELETE /conversations/:publicId`, `GET /conversations/:publicId/messages`, `POST /conversations/:publicId/messages`, `PATCH /messages/:publicId`, `POST /messages/:publicId/recall`, `DELETE /messages/:publicId/for-me`, `POST /conversations/:publicId/read` |
| **Media & Cuộc gọi** | `POST /media/encrypted` (upload ciphertext Ảnh HD/Voice), `GET /media/encrypted/:key` (xác thực quyền tham gia hội thoại rồi mới cấp quyền tải), `POST /calls/ice-servers`, `POST /calls`, `POST /calls/:callPublicId/signal`, `POST /calls/:callPublicId/action` (`accept`/`decline`/`end`) |

### 3.2. Kiểm soát Chống IDOR / BOLA / BFLA / BOPLA (2 Lớp Phòng thủ)
1. **Không bao giờ tin `user_id` từ Client:** Danh tính chủ thể (`actor`) luôn lấy từ Access Token đã xác minh ở Server.
2. **Lớp 1 — Policy Engine ReBAC tập trung (`social.policy.ts`, `chat.policy.ts`, `call.policy.ts`):**
   - Nguyên tắc **Deny-by-default, fail-closed** (mọi lỗi hoặc ngoại lệ đều từ chối).
   - Mọi hành động đọc/ghi đều gọi hàm `authorize(actor, action, resource)` kiểm tra đầy đủ: quan hệ Block 2 chiều, trạng thái Private/Follow, thành viên hội thoại, trạng thái Pending Request, chủ sở hữu tin nhắn và đồng hồ máy chủ (`now - created_at <= 300_000ms`).
   - Khi không có quyền hoặc bị chặn → luôn trả **`404 Not Found`** đồng nhất (không trả `403` làm lộ sự tồn tại tài nguyên).
3. **Lớp 2 — PostgreSQL Row-Level Security (RLS):**
   - Kích hoạt RLS trên các bảng nhạy cảm (`conversation_participants`, `messages`, `notifications`, `user_e2ee_key_backups`).
   - Sử dụng helper `withRlsContext(userId, async (tx) => ...)` chạy `SELECT set_config('app.current_user_id', $1, true)` trong transaction để chính PostgreSQL từ chối nếu code tầng ứng dụng lỡ quên mệnh đề `WHERE`. (User DB chạy ứng dụng không có quyền `BYPASSRLS` trên môi trường production).
4. **AuthZ cho Kênh phụ (Nơi BOLA hay lọt nhất):**
   - **Ably Realtime Token:** Endpoint `/api/v1/realtime/token` chỉ cấp quyền `subscribe` cho đúng kênh `user:${actor.publicId}` (không cấp quyền `publish`).
   - **Media Chat:** Endpoint tải blob kiểm tra `actor` là thành viên hợp lệ của hội thoại chứa media đó và tin nhắn chưa bị thu hồi.
   - **Call Signaling:** Chặn tuyệt đối gửi Offer/Answer/ICE nếu không phải `caller`/`callee` của `call_sessions`, hoặc hai bên có trạng thái Block/Pending.

### 3.3. Phòng thủ Chuyên biệt theo Tính năng & Chuỗi cung ứng (OWASP 2025)
- **Xử lý Ảnh đại diện (`sharp`):** Đọc magic bytes bằng `file-type` (chỉ cho JPEG/PNG/WebP, cấm tuyệt đối SVG), kiểm tra giới hạn pixel (`limitInputPixels: 25_000_000` chống decompression bomb), chạy `sharp(...).rotate().resize(512, 512).webp({ quality: 82 })` để tự động xóa sạch EXIF/GPS và tạo ảnh mới hoàn toàn; lưu với tên ngẫu nhiên, xóa file cũ sau khi cập nhật DB atomic.
- **Chống lạm dụng & Rate Limit theo chi phí (Upstash Redis):**
  - Tìm kiếm `@user_id`: 30 lần/phút/user.
  - Follow/Unfollow: 30 lần/giờ/user.
  - Gửi tin nhắn chờ tới người lạ mới: tối đa 5 người mới/ngày/user + tối đa 3 tin/người chờ.
  - Gọi điện: tối đa 5 cuộc gọi/phút/user; không được spam gọi lại liên tục khi bị từ chối.
  - Đổi ảnh đại diện: 5 lần/giờ/user.
- **Chống XSS & Lỗi hiển thị văn bản:** Lọc ký tự điều khiển nguy hiểm (`\u202A`–`\u202E`, `\u2066`–`\u2069`), không bao giờ dùng `dangerouslySetInnerHTML`, CSP không cho `unsafe-eval`, chỉ cho kết nối tới domain của TOMATO, Ably, Vercel Blob và Cloudflare Turnstile.
- **Bảo mật Chuỗi cung ứng (OWASP A03:2025):** Dùng `npm ci` trong GitHub Actions, ghim phiên bản Action theo commit SHA, chạy `npm audit --audit-level=high` và `gitleaks`.

---

## 4. Chiến lược Kiểm thử Bảo mật (Ma trận BOLA trong CI)

Bắt buộc xây dựng bộ **BOLA Security Matrix Test** chạy tự động trên GitHub Actions với 5 nhân vật chuẩn:
- `User A` (Chủ sở hữu / Người gửi)
- `User B` (Người nhận / Người theo dõi hợp lệ)
- `User C` (Người đã bị A chặn — hoặc đã chặn A)
- `User D` (Người lạ chưa được duyệt đối với tài khoản riêng tư / không thuộc hội thoại)
- `Anon` (Ẩn danh chưa đăng nhập)

Mọi endpoint và luồng sự kiện mới đều phải được kiểm tra chéo với ma trận 5 nhân vật trên, xác nhận:
1. `User C` (bị chặn) không thấy A trong Search, xem Profile A nhận `404`, gọi Follow/Message/Call/Presence đều bị chặn.
2. `User D` xem danh sách Followers/Following của tài khoản Private nhận `404`, không đọc/gửi/xóa/thu hồi được tin nhắn hay media của hội thoại A–B.
3. Sửa/Thu hồi tin nhắn ở giây thứ 301 bị server từ chối (`403`/`400`); Xóa 1 phía không làm mất tin nhắn ở phía B; Tin nhắn chờ bị chặn gửi Ảnh/Voice/Call và bị chặn ở tin thứ 4.
4. Tắt Active Status hoặc Read Receipts được cưỡng chế đối xứng ngay từ dữ liệu API trả về (không chỉ ẩn bằng CSS).

---

## 5. Lộ trình Cột mốc Giai đoạn 2 (M6 → M12)

Mỗi cột mốc hoàn thành trọn vẹn (Code → Migration → Unit/Integration/Security Test → CI Xanh → Test tay) mới chuyển sang cột mốc tiếp theo:

- **M6 — Hồ sơ (`@user_id`), Tìm kiếm & Ảnh đại diện (Crop + Sharp):**
  - Schema hồ sơ + `pg_trgm`, chuẩn hóa `@user_id` + chặn từ khóa hệ thống + lịch sử giữ chỗ, `MediaStorageProvider` (Local + Vercel Blob), pipeline `sharp` chống decompression bomb/xóa EXIF, API Search/Profile/Avatar, UI Trang cá nhân `/u/[handle]`, Hộp thoại cắt ảnh đại diện (`react-easy-crop`) và Thanh tìm kiếm trên Header.
- **M7 — Mạng lưới Follow, Tài khoản Riêng tư & Chặn hai chiều:**
  - Schema `follows` & `blocks`, `social.policy.ts` (ReBAC), state machine `none -> requested -> following`, gỡ follower, chặn/bỏ chặn hai chiều (tự cắt follow & trả 404), UI nút Theo dõi/Yêu cầu, Danh sách Followers/Following, Trang cài đặt Quyền riêng tư & Danh sách chặn.
- **M8 — Thanh Thông báo & Hạ tầng Realtime + Trạng thái Hoạt động:**
  - Schema `notifications` (dedupe), `RealtimeProvider` (Ably Free + Local Mock) với `/api/v1/realtime/token` chống BOLA, hệ thống Presence trên Redis (TTL + heartbeat + hiển thị thời gian thô + cưỡng chế đối xứng), UI Chuông thông báo thời gian thực trên Header và công tắc Quyền riêng tư.
- **M9 — Nhắn tin 1-1 E2EE (WebCrypto) & Tin nhắn đang chờ:**
  - Schema E2EE & Chat (`user_e2ee_devices`, `user_e2ee_key_backups`, `conversations`, `conversation_participants`, `messages`) + bật PostgreSQL RLS, bộ máy WebCrypto (`ECDH P-256 + HKDF + AES-256-GCM + AAD`), Safety Number, sao lưu PIN tùy chọn, luật Tin nhắn đang chờ (text-only, tối đa 3 tin, Accept/Decline/Block), gửi chữ + Emoji an toàn, UI `/messages` chuẩn Instagram DM.
- **M10 — Sửa/Thu hồi trong 5 phút, Xóa 1 phía, Xóa hội thoại & Trạng thái "Đã xem":**
  - Server cưỡng chế mốc 300 giây cho Sửa (tối đa 5 lần, nhãn *"Đã chỉnh sửa"*) và Thu hồi (tombstone xóa sạch ciphertext), bảng `message_user_deletions` (xóa chỉ ở phía mình), `cleared_before_seq` (xóa đoạn hội thoại phía mình), cơ chế `last_read_seq` đối xứng theo cài đặt, tối ưu Optimistic UI + Delta Sync.
- **M11 — Đa phương tiện E2EE trong Nhắn tin (Ảnh HD & Tin nhắn thoại Voice):**
  - Mã hóa AES-256-GCM phía Client cho Ảnh HD (kèm thumbnail mờ) & Voice Recorder (Opus/WebM, tối đa 2 phút), API upload/tải blob có kiểm tra quyền thành viên hội thoại, xóa blob khi thu hồi tin nhắn, khóa media trong Tin nhắn đang chờ, UI Lightbox xem ảnh HD & trình phát Voice mượt mà.
- **M12 — Gọi Thoại/Video 1-1 (WebRTC), Ma trận BOLA CI & Deploy Live (0đ):**
  - Schema `call_sessions`, Signaling API + Ably WSS (chặn khi block/pending), WebRTC P2P (DTLS-SRTP), `TurnCredentialProvider` (Metered Free ngắn hạn), UI màn hình cuộc gọi đến/đi (micro/camera/kết thúc/thẻ lịch sử trong chat), hoàn thiện Ma trận BOLA Test trên CI, tổng rà soát giao diện xóa sạch chữ kỹ thuật, cập nhật `README.md` và Deploy Production trên Vercel + Neon + Upstash + Ably + Vercel Blob.

---

## 6. Định nghĩa Hoàn thành (Definition of Done — Giai đoạn 2)
- [ ] 100% Unit, Integration và BOLA Matrix Security Tests xanh trên cả local lẫn GitHub Actions CI (không báo lỗi Gitleaks).
- [ ] Giao diện hoàn chỉnh, mượt mà, **không còn bất kỳ thuật ngữ kỹ thuật, nhãn cột mốc hay nút dev nào** trên môi trường Production.
- [ ] Hai tài khoản thật trên 2 thiết bị khác nhau có thể: tìm `@user_id` → xin follow tài khoản riêng tư → chấp nhận → nhắn tin E2EE (chữ, icon, ảnh HD, voice) → sửa/thu hồi trong 5 phút → xóa 1 phía → gọi Video 1-1 mượt mà qua HTTPS với chi phí **0đ**.