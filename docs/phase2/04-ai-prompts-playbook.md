# BỘ PROMPT ĐIỀU PHỐI AI CODING — DỰ ÁN TOMATO (GIAI ĐOẠN 2: M6–M12)

Tài liệu này dùng để điều khiển Antigravity (hoặc Cursor/Claude Code) xây dựng trọn bộ **Giai đoạn 2** theo đúng quy chuẩn bảo mật, kiến trúc 0đ và giao diện thương mại sạch đẹp.

---

## HƯỚNG DẪN VẬN HÀNH
1. Đặt 3 file đặc tả Giai đoạn 2 vào thư mục `docs/phase2/`:
   - `docs/phase2/01-functional-spec.md`
   - `docs/phase2/02-technical-spec-architecture.md`
   - `docs/phase2/03-design-security-roadmap.md`
2. **Quy tắc vàng:** Mỗi cột mốc (`M6` → `M12`) mở **1 luồng chat mới hoàn toàn**, đính kèm 3 file trong `docs/phase2/`, dán **Master Prompt (Phần 1) + Prompt cột mốc tương ứng (Phần 2)**.
3. **Duyệt kế hoạch trước khi code:** Chỉ gõ `"Duyệt kế hoạch — bắt đầu code"` sau khi AI trình bày xong thiết kế, migration và test case.
4. Sau khi hoàn thành mỗi cột mốc: chạy `npm run db:migrate`, chạy đủ bộ kiểm tra (`lint`, `format:check`, `typecheck`, `test`, `build`), test tay trên trình duyệt, `git commit` và `git push origin main` để chắc chắn GitHub Actions CI xanh rồi mới sang mốc tiếp theo.

---

## PHẦN 1: MASTER PROMPT GIAI ĐOẠN 2 (LUẬT CỨNG CHO AI)

> **VAI TRÒ & NGỮ CẢNH**
> Bạn là một Principal Full-Stack & Security Engineer tiếp tục đồng hành cùng tôi phát triển dự án **TOMATO — Mạng xã hội (Giai đoạn 2)** trên nền codebase Giai đoạn 1 (M0–M5 đã hoàn tất và deploy trên Vercel + Neon + Upstash).
> Nguồn sự thật bắt buộc: `docs/phase2/01-functional-spec.md`, `docs/phase2/02-technical-spec-architecture.md`, `docs/phase2/03-design-security-roadmap.md`.
>
> **NGUYÊN TẮC BẮT BUỘC (KHÔNG ĐƯỢC VI PHẠM)**
> 1. **Kế hoạch trước — Code sau:** Ở lượt đầu tiên của mỗi cột mốc, CHỈ trình bày kế hoạch triển khai, thiết kế DB/Migration mới, danh sách API, thiết kế UI và danh sách Test. KHÔNG tạo hay sửa bất kỳ file nào cho đến khi tôi duyệt.
> 2. **Giao diện chuẩn sản phẩm thương mại (Cực kỳ quan trọng):**
>    - Tối ưu giao diện sạch, hiện đại, mượt mà như Instagram/Facebook.
>    - **TUYỆT ĐỐI KHÔNG** đưa bất kỳ thông tin kỹ thuật, thuật ngữ bảo mật hay nhãn tiến độ nào lên giao diện người dùng (cấm viết chữ như *E2EE, AES-256, WebRTC, BOLA, RLS, Drizzle, Giai đoạn 2, Cột mốc M6...* trên màn hình web).
>    - Không hiển thị nút/thông tin dành cho dev trên Production (chỉ cho phép trên `NODE_ENV === 'development'` nếu thật sự cần).
>    - Không làm các phần liên quan đến pháp luật ở giai đoạn này.
> 3. **Bảo toàn Giai đoạn 1:** Giữ nguyên toàn bộ cơ chế Auth, Session, CSRF 3 lớp, Pino/Sentry redact và **giữ nguyên luật mật khẩu không cho phép dấu tiếng Việt** hiện có trong codebase. Không sửa các file migration cũ; luôn tạo file migration mới.
> 4. **Bảo mật OWASP 2025 — Deny-by-default, Fail-closed:**
>    - `user_id` luôn lấy từ Access Token đã xác minh, không bao giờ lấy từ body/query/path.
>    - Không bao giờ để lộ khóa chính nội bộ `id` (UUIDv7) ra API/URL; chỉ dùng `public_id` hoặc `@handle`.
>    - Mọi truy cập tài nguyên (REST API, Realtime token, Media, Call signaling) bắt buộc đi qua lớp Policy ReBAC tập trung (`authorize`) và trả **`404 Not Found`** đồng nhất khi bị chặn hoặc không có quyền.
>    - Mọi input validate bằng Zod `.strict()` (từ chối field lạ); mọi output lọc qua DTO allowlist.
>    - Không tự chế thuật toán mật mã; không log plaintext tin nhắn, khóa E2EE, token hay cookie.
> 5. **Ngân sách 0đ & CI Xanh:**
>    - Mọi dịch vụ ngoài (Storage, Realtime, TURN) bắt buộc bọc qua interface Port & Adapter để chạy mượt trên Local/Docker và CI không cần tài khoản trả phí hay `.env.local`.
>    - Không viết chuỗi literal có định dạng giống JWT/API Key thật trong file test để tránh Gitleaks báo nhầm.
> 6. **Báo cáo cuối cột mốc:** Liệt kê file đã tạo/sửa, lệnh migration & test cần chạy, checklist tự kiểm tra bằng tay trên trình duyệt.

---

## PHẦN 2: PROMPT TỪNG CỘT MỐC (M6 ĐẾN M12)

### CỘT MỐC M6 — Hồ sơ (`@user_id`), Tìm kiếm Người dùng & Đổi Ảnh đại diện (Crop + Sharp)

> **Nhiệm vụ: Thực hiện Cột mốc M6 (Hồ sơ, Tìm kiếm `@user_id` & Ảnh đại diện)**
> Đọc kỹ `docs/phase2/01-functional-spec.md` (Mục 1, 3.1, 3.2), `docs/phase2/02-technical-spec-architecture.md` và `docs/phase2/03-design-security-roadmap.md` (Mục 1.1, 3.3).
>
> **Phạm vi M6:**
> 1. **DB & Migration mới:**
>    - Bật extension `pg_trgm`. Bổ sung cột hồ sơ (`handle`, `handle_normalized`, `bio`, `avatar_url`, `avatar_storage_key`, `is_private`, `show_active_status`, `show_read_receipts`, `followers_count`, `following_count`, `handle_changed_at`) cho `users` và tạo bảng `user_handle_history`.
>    - Tạo đầy đủ index (`UNIQUE`, `varchar_pattern_ops`, `GIN gin_trgm_ops`). Có chiến lược backfill/khởi tạo `@handle` hợp lệ cho các user đã tồn tại từ Giai đoạn 1 mà không làm hỏng dữ liệu cũ.
> 2. **Chuẩn hóa `@user_id` & Tìm kiếm:**
>    - Validate `@user_id`: chuẩn hóa NFKC + lowercase, `[a-z0-9._]`, 3–30 ký tự, không bắt đầu/kết thúc bằng `.`, không `..`, chặn danh sách từ khóa hệ thống dành riêng. Giới hạn đổi tối đa 2 lần/14 ngày và giữ chỗ handle cũ 14 ngày.
>    - API `GET /api/v1/users/search?q=...`: tối thiểu 2 ký tự, tối đa 20 kết quả, ưu tiên prefix `@user_id`, không tìm theo email, rate limit 30 req/phút/user.
>    - API `GET /api/v1/users/:handle` & `PATCH /api/v1/users/me/profile`.
> 3. **Storage Adapter & Pipeline Xử lý Ảnh đại diện (`sharp`):**
>    - Khai báo `serverExternalPackages` có thêm `'sharp'` trong `next.config.ts`.
>    - Xây dựng `MediaStorageProvider` (`LocalFsStorageAdapter` cho local dev + `VercelBlobStorageAdapter` cho Production).
>    - API `POST /api/v1/users/me/avatar` & `DELETE /api/v1/users/me/avatar` (`runtime = 'nodejs'`): kiểm tra magic bytes (chỉ JPEG/PNG/WebP, cấm SVG), giới hạn $\le 10$ MB và tổng pixel chống decompression bomb, dùng `sharp` xoay hướng tự động, xóa sạch EXIF/GPS, nén WebP vuông 512x512, lưu tên ngẫu nhiên, cập nhật DB atomic và xóa file ảnh cũ. Rate limit 5 lần/giờ.
> 4. **Giao diện sạch đẹp (Không chữ kỹ thuật):**
>    - Thanh tìm kiếm `@user_id` (có debounce + dropdown kết quả mượt mà) tích hợp ngay trên Top Navigation Bar.
>    - Trang cá nhân `/u/[handle]` bố cục gọn gàng giống Instagram (Avatar tròn, `@user_id`, tên, bio, số liệu Followers/Following).
>    - Mục **Chỉnh sửa hồ sơ** trong `/settings/profile`: đổi `@user_id`, tên hiển thị, bio và **Modal căn chỉnh & cắt ảnh đại diện** dùng `react-easy-crop` (kéo vị trí + thanh zoom + xem trước khung tròn).
> 5. **Tests:** Unit test chuẩn hóa handle/từ khóa cấm, test `sharp` chặn SVG/file giả mạo, Integration test tìm kiếm & đổi handle giữ chỗ 14 ngày.
>
> **Bước 1:** Trình bày kế hoạch triển khai M6, file migration dự kiến và cấu trúc UI để tôi duyệt trước khi code.

---

### CỘT MỐC M7 — Follow/Unfollow, Tài khoản Riêng tư, Danh sách Theo dõi & Chặn Hai Chiều

> **Nhiệm vụ: Thực hiện Cột mốc M7 (Mạng lưới Kết nối, Tài khoản Riêng tư & Chặn)**
> Đọc kỹ `docs/phase2/01-functional-spec.md` (Mục 3.3, 3.4) và `docs/phase2/03-design-security-roadmap.md` (Mục 1.2, 3.2).
>
> **Phạm vi M7:**
> 1. **DB & Migration mới:** Tạo bảng `follows` (`UNIQUE(follower_id, followee_id)`, `CHECK(follower_id <> followee_id)`) và bảng `blocks` (`UNIQUE(blocker_id, blocked_id)` + index đảo chiều).
> 2. **Lớp phân quyền ReBAC tập trung (`src/modules/social/social.policy.ts`):**
>    - Kiểm tra chặn hai chiều (ưu tiên độ chính xác từ nguồn chính hoặc cache TTL ngắn có invalidate ngay lập tức).
>    - Kiểm tra quyền xem hồ sơ & danh sách Followers/Following đối với tài khoản Private (chỉ chính chủ hoặc follower đã được duyệt). Trả **`404 Not Found`** đồng nhất khi bị chặn hoặc không có quyền.
> 3. **Nghiệp vụ & API (`/api/v1/social/...`):**
>    - State machine `none → requested → following` (idempotent, dùng DB transaction cập nhật đồng bộ `followers_count`/`following_count`, rate limit 30 lần/giờ).
>    - Chấp nhận / Từ chối yêu cầu follow; Gỡ người theo dõi (`DELETE /social/followers/:userPublicId`).
>    - Chặn / Bỏ chặn (`POST/DELETE /social/blocks/:userPublicId`): chặn tự động xóa follow & follow request cả hai chiều và cập nhật lại bộ đếm trong cùng 1 transaction; không gửi thông báo cho người bị chặn.
>    - Cập nhật `GET /api/v1/users/search` và `GET /api/v1/users/:handle` để ẩn hai chiều khi bị chặn và chỉ trả khung tối thiểu cho tài khoản Private.
>    - Danh sách Followers & Following hỗ trợ cursor pagination (giới hạn max 30/trang).
> 4. **Giao diện sạch đẹp:**
>    - Hoàn thiện trang `/u/[handle]`: nút Theo dõi / Đã gửi yêu cầu / Đang theo dõi, menu dấu 3 chấm có nút **Chặn**, trạng thái gọn gàng *"Đây là tài khoản riêng tư"*, hộp thoại xem danh sách Người theo dõi / Đang theo dõi (có nút Gỡ trên trang của chính mình).
>    - Trang `/settings/privacy`: công tắc bật/tắt **Tài khoản riêng tư** (có xác nhận khi chuyển từ Riêng tư sang Công khai) và mục **Tài khoản đã chặn** (xem & Bỏ chặn).
> 5. **Tests:** Integration & Security tests đầy đủ cho state machine Follow, tài khoản Private, chặn 2 chiều ẩn Search/Profile/Lists và chống IDOR (User C bị chặn và User D người lạ đều nhận `404`).
>
> **Bước 1:** Trình bày kế hoạch triển khai M7, thiết kế `social.policy.ts` và xử lý transaction bộ đếm để tôi duyệt trước khi code.

---

### CỘT MỐC M8 — Thanh Thông báo, Hạ tầng Realtime (WSS) & Trạng thái Hoạt động

> **Nhiệm vụ: Thực hiện Cột mốc M8 (Thông báo Realtime & Trạng thái Hoạt động)**
> Đọc kỹ `docs/phase2/01-functional-spec.md` (Mục 3.5, 3.7) và `docs/phase2/02-technical-spec-architecture.md` (Mục 2, 3.1).
>
> **Phạm vi M8:**
> 1. **Hạ tầng Realtime (`src/core/realtime/`):**
>    - Định nghĩa interface `RealtimeProvider` với 2 adapter: `AblyRealtimeAdapter` (Production 0đ) và `InMemoryRealtimeAdapter` / SSE fallback gọn nhẹ cho môi trường local dev & CI (chạy mượt mà không bắt buộc có Ably key ở local/test).
>    - Endpoint `POST /api/v1/realtime/token`: kiểm tra Access Token, chỉ cấp Token Request ngắn hạn với quyền duy nhất `subscribe` vào kênh cá nhân `user:{actor.publicId}` (tuyệt đối không cấp quyền `publish` hay đọc kênh người khác).
> 2. **Hệ thống Thông báo (`src/modules/notifications/`):**
>    - Migration tạo bảng `notifications` (có `dedupe_key` chống trùng lặp).
>    - Tự động tạo và đẩy thông báo realtime cho: `follow_request`, `follow_accepted`, `new_follower` (sẵn sàng cho `message_request` ở M9). Khi A chặn B, tự động ẩn/xóa thông báo của nhau.
>    - API `GET /api/v1/notifications` (cursor pagination + số lượng chưa đọc) và `POST /api/v1/notifications/read`.
> 3. **Trạng thái Hoạt động Đối xứng (`src/modules/presence/`):**
>    - Lưu trạng thái hoạt động trong Redis theo key `presence:{userId}` kèm TTL 90 giây + cơ chế Heartbeat từ Client (mỗi 45–60 giây khi tab đang mở).
>    - API `POST /api/v1/presence/heartbeat` và `POST /api/v1/presence/query` (rate limit chống theo dõi):
>      - **Cưỡng chế đối xứng ở Server:** Nếu người xem tắt `show_active_status` HOẶC người được xem tắt `show_active_status` → trả `null`.
>      - Chỉ trả trạng thái cho đối tượng hợp lệ (theo dõi lẫn nhau hoặc có hội thoại chính), chặn hoàn toàn với người bị chặn.
>      - Làm tròn mốc thời gian thô (ví dụ: đang hoạt động, 5 phút trước, 1 giờ trước...) — không trả timestamp chính xác từng giây.
> 4. **Giao diện sạch đẹp:**
>    - Biểu tượng Chuông thông báo trên Header kèm chấm đỏ số chưa đọc cập nhật realtime; bảng thả xuống có nút **Chấp nhận / Xóa** trực tiếp cho yêu cầu follow.
>    - Bổ sung công tắc **Hiển thị trạng thái hoạt động** và **Hiển thị trạng thái đã xem** vào trang `/settings/privacy` (mô tả tự nhiên, ngắn gọn, không chữ kỹ thuật).
> 5. **Tests:** Test chứng minh kênh Realtime không thể subscribe nhầm user khác; test Presence đối xứng; test thông báo bị im lặng khi chặn.
>
> **Bước 1:** Trình bày kế hoạch triển khai M8, cách hoạt động của Realtime ở Local vs Production (Ably) để tôi duyệt trước khi code.

---

### CỘT MỐC M9 — Nhắn tin 1-1 Bảo mật (E2EE WebCrypto) & Tin nhắn đang chờ

> **Nhiệm vụ: Thực hiện Cột mốc M9 (Nhắn tin 1-1 E2EE & Tin nhắn đang chờ)**
> Đọc kỹ `docs/phase2/01-functional-spec.md` (Mục 3.6) và `docs/phase2/03-design-security-roadmap.md` (Mục 1.3, 1.4, 2.1, 3.2).
>
> **Phạm vi M9:**
> 1. **DB, Migration & PostgreSQL RLS:**
>    - Tạo bảng `user_e2ee_devices`, `user_e2ee_key_backups`, `conversations` (có `direct_pair_key` chống race condition), `conversation_participants`, `messages` (`seq` đơn điệu, `client_msg_id` idempotent).
>    - Thiết lập helper `withRlsContext` và chính sách **PostgreSQL RLS** cho các bảng hội thoại/tin nhắn làm lớp phòng thủ thứ hai song song với `src/modules/chat/chat.policy.ts`.
> 2. **Engine Mã hóa E2EE phía Client (`src/lib/e2ee/`):**
>    - Dùng **Web Crypto API** chuẩn (`ECDH P-256` khóa `non-extractable` lưu trong IndexedDB + `HKDF-SHA256` + `AES-256-GCM` kèm AAD `conversationPublicId|senderPublicId|clientMsgId`).
>    - Quản lý khóa thiết bị (`POST /api/v1/e2ee/devices`, `GET /api/v1/e2ee/users/:userPublicId/keys`).
>    - Tùy chọn đặt **Mã PIN khôi phục 6 số** để sao lưu bản mã hóa khóa lên server (`PUT/GET /api/v1/e2ee/backup` dùng PBKDF2-SHA256 + AES-256-GCM trên Client) giúp đăng nhập máy mới vẫn đọc được tin nhắn cũ.
>    - Tính toán **Mã an toàn (Safety Number)** hiển thị gọn trong mục *Thông tin đoạn chat*.
> 3. **Nghiệp vụ Nhắn tin & Tin nhắn đang chờ:**
>    - Server tự quyết định `inbox_state` (`primary` vs `pending`) khi tạo hội thoại dựa trên quan hệ follow/lịch sử chat.
>    - Trong trạng thái `pending`: Server cưỡng chế chỉ cho phép `message_type = 'text'`, tối đa **3 tin nhắn** cho đến khi người nhận bấm Chấp nhận, giới hạn quota tối đa 5 người lạ mới/ngày. Không phát trạng thái hoạt động hay đã xem.
>    - API Chấp nhận (`accept`), Từ chối (`decline`), Chặn ngay từ tin nhắn chờ.
>    - Gửi tin nhắn chữ + bộ chọn Emoji an toàn (lọc ký tự RTL override, cấm `dangerouslySetInnerHTML`), phát envelope realtime qua Ably, chống gửi trùng qua `client_msg_id`.
> 4. **Giao diện `/messages` chuẩn Instagram DM (Không chữ kỹ thuật):**
>    - Cột trái: Danh sách hội thoại kèm 2 tab **"Chính"** và **"Tin nhắn đang chờ"** (có số lượng), chấm xanh trạng thái hoạt động (nếu hợp lệ).
>    - Cột phải: Khung chat mượt mà, nút chọn Emoji, banner lịch sự ở đầu Tin nhắn đang chờ (*"Chấp nhận" / "Xóa" / "Chặn"*), nút mở nhanh nút nhắn tin từ trang cá nhân `/u/[handle]`.
>    - Đảm bảo **không hiển thị** các từ kỹ thuật như *ECDH, AES-GCM, ciphertext, E2EE* trên giao diện.
> 5. **Tests:** Unit test crypto WebCrypto mã hóa/giải mã & kiểm tra giả mạo AAD; Integration & Security tests cho Tin nhắn đang chờ (bị chặn ở tin thứ 4, bị chặn gửi ảnh/voice, bị chặn khi Block, chống BOLA đọc hội thoại người khác).
>
> **Bước 1:** Trình bày kế hoạch triển khai M9, thiết kế gói tin `crypto_header`, cơ chế RLS và UX đồng bộ khóa thiết bị để tôi duyệt trước khi code.

---

### CỘT MỐC M10 — Sửa/Thu hồi trong 5 phút, Xóa 1 phía, Xóa hội thoại & Trạng thái Đã xem 

> **Nhiệm vụ: Thực hiện Cột mốc M10 (Thao tác Tin nhắn Nâng cao & Trạng thái Đã xem)**
> Đọc kỹ `docs/phase2/01-functional-spec.md` (Mục 3.6.B, 3.7) và `docs/phase2/03-design-security-roadmap.md` (Mục 1.4, 3.2).
>
> **Phạm vi M10:**
> 1. **DB & Migration mới:** Tạo bảng `message_user_deletions` (PK `message_id, user_id`).
> 2. **Chỉnh sửa & Thu hồi trong 5 phút đầu (Cưỡng chế theo giờ Server):**
>    - `PATCH /api/v1/messages/:publicId`: Chỉ chủ tin nhắn, chỉ tin nhắn `text`, chưa bị thu hồi, `now - created_at <= 300_000ms` (5 phút theo đồng hồ máy chủ), tối đa 5 lần sửa. Cập nhật bản mã mới, tăng `edit_count`, lưu `edited_at` và phát sự kiện realtime cập nhật UI (hiện nhãn nhỏ *"Đã chỉnh sửa"*).
>    - `POST /api/v1/messages/:publicId/recall`: Chỉ chủ tin nhắn, `now - created_at <= 300_000ms`. Xóa vĩnh viễn `ciphertext = NULL`, `crypto_header = NULL`, đặt `recalled_at = NOW()` (sẵn sàng xóa luôn file đính kèm trên Storage ở M11), phát sự kiện realtime để cả 2 bên hiển thị *"Tin nhắn đã được thu hồi"*.
> 3. **Xóa 1 dòng tin nhắn phía mình & Xóa đoạn hội thoại:**
>    - `DELETE /api/v1/messages/:publicId/for-me`: Ghi vào `message_user_deletions` cho đúng `actor.id`. Tin nhắn biến mất hoàn toàn khi `actor` tải lại, nhưng **không ảnh hưởng gì đến phía đối phương**.
>    - `DELETE /api/v1/conversations/:publicId`: Cập nhật `cleared_before_seq = conversation.last_seq` và `hidden_at = NOW()` trên dòng `conversation_participants` của riêng `actor`. Khi có tin nhắn mới đến sau đó, tự mở lại hội thoại (`hidden_at = NULL`) và chỉ hiện các tin có `seq > cleared_before_seq`.
> 4. **Trạng thái "Đã xem" Đối xứng:** (đã làm, nếu cần thì cập nhật, không cần thì bỏ qua)
>    - `POST /api/v1/conversations/:publicId/read`: Cập nhật `last_read_seq` của `actor`.
>    - **Cưỡng chế đối xứng ở Server:** Chỉ phát sự kiện `read_receipt` và trả `otherLastReadSeq` khi hội thoại ở trạng thái `primary`, không bị chặn, VÀ **cả hai người đều đang bật `show_read_receipts = true`**.
> 5. **Tối ưu UX trên `/messages`:** Menu thao tác gọn gàng khi di chuột/chạm vào tin nhắn (Chỉnh sửa / Thu hồi chỉ hiện khi còn trong 5 phút; Xóa ở phía bạn luôn hiện), nút Xóa đoạn chat trong phần Thông tin đoạn chat, Optimistic UI và Delta Sync theo `seq`.
> 6. **Tests:** Test sửa/thu hồi ở phút thứ 4 thành công và ở phút thứ 5 + 1 giây bị từ chối; test xóa 1 phía không ảnh hưởng người kia; test xóa hội thoại rồi nhận tin mới; test trạng thái Đã xem đối xứng.
>
> **Bước 1:** Trình bày kế hoạch triển khai M10 và cách xử lý đồng bộ realtime khi sửa/thu hồi/đã xem để tôi duyệt trước khi code.

---

### CỘT MỐC M11 — Gửi Ảnh HD & Tin nhắn thoại (Voice) Mã hóa Đầu cuối

> **Nhiệm vụ: Thực hiện Cột mốc M11 (Ảnh HD & Tin nhắn thoại E2EE)**
> Đọc kỹ `docs/phase2/01-functional-spec.md` (Mục 3.6.B) và `docs/phase2/03-design-security-roadmap.md` (Mục 2.1, 3.1, 3.2).
>
> **Phạm vi M11:**
> 1. **Luồng Mã hóa Media phía Client (`src/lib/e2ee/media-crypto.ts`):**
>    - Ảnh HD (tối đa 5 ảnh/lần, mỗi ảnh $\le 15$ MB, giữ độ phân giải HD) và Voice (ghi âm `MediaRecorder` Opus/WebM, tối đa 120 giây):
>    - Client tự tạo thumbnail/blurhash nhỏ (cho ảnh), sinh `fileKey` (256-bit) + `fileIv` (96-bit) ngẫu nhiên → mã hóa toàn bộ file bằng `AES-256-GCM` → tính `SHA-256` bản mã → upload khối nhị phân lên Server.
>    - Thông tin giải mã (`storageKey`, `fileKey`, `fileIv`, `sha256`, kích thước/thời lượng, `blurhash`) được đặt bên trong phong bì E2EE của tin nhắn.
> 2. **Backend Media Có Kiểm soát Quyền (`POST /api/v1/media/encrypted` & `GET /api/v1/media/encrypted/:key`):**
>    - Kiểm tra `actor` là thành viên hợp lệ của hội thoại, hội thoại ở trạng thái `primary` (cấm tuyệt đối tải media trong `pending`), không bị chặn. Rate limit upload theo user.
>    - Lưu bản mã lên `MediaStorageProvider` (Local FS / Vercel Blob).
>    - Khi tải về: xác thực quyền thành viên hội thoại và tin nhắn chưa bị thu hồi trước khi trả dữ liệu (hoặc chuyển hướng an toàn).
>    - Nâng cấp API **Thu hồi tin nhắn** (từ M10): khi thu hồi tin nhắn Ảnh HD hoặc Voice trong 5 phút, tự động xóa luôn file bản mã tương ứng trên Storage.
> 3. **Giao diện sạch đẹp trong `/messages`:**
>    - Nút đính kèm Ảnh HD có xem trước trước khi gửi, hiển thị khung ảnh mượt mà và **Lightbox phóng to sắc nét** khi bấm xem (tự động giải phóng `ObjectURL` chống rò RAM).
>    - Nút Micro ghi âm tin nhắn thoại: hiển thị sóng âm / bộ đếm thời gian, nút hủy hoặc gửi; bong bóng tin nhắn thoại có nút phát/dừng, thanh tua và nút đổi tốc độ (`1x` / `1.5x` / `2x`).
>    - Ẩn/khóa nút gửi Ảnh và Voice khi đang ở trạng thái Tin nhắn đang chờ.
> 4. **Tests:** Unit test mã hóa/giải mã file & phát hiện sửa đổi `SHA-256`; Security test chống BOLA (User D không tải được media của hội thoại A–B; không upload được media vào Tin nhắn đang chờ; thu hồi tin nhắn xóa sạch attachment).
>
> **Bước 1:** Trình bày kế hoạch triển khai M11, giới hạn dung lượng (phù hợp giới hạn request body của Vercel Hobby 4.5MB — đề xuất dùng presigned/client upload token của Vercel Blob nếu ảnh HD > 4MB) để tôi duyệt trước khi code.

---

### CỘT MỐC M12 — Gọi Thoại/Video 1-1 (WebRTC), Ma trận BOLA CI & Deploy Live (0đ)

> **Nhiệm vụ: Thực hiện Cột mốc M12 (Gọi Thoại/Video 1-1, Kiểm toán BOLA & Deploy Production)**
> Đọc kỹ `docs/phase2/01-functional-spec.md` (Mục 3.8) và `docs/phase2/03-design-security-roadmap.md` (Mục 2.2, 4, 5, 6).
>
> **Phạm vi M12:**
> 1. **Signaling & WebRTC 1-1 (`src/modules/calls/`, `src/core/webrtc/`):**
>    - Migration tạo bảng `call_sessions`.
>    - Xây dựng `TurnCredentialProvider`: hỗ trợ lấy TURN credentials ngắn hạn từ **Metered.ca Free** (qua biến môi trường phía Server, không lộ API key ra Client) và fallback STUN công khai khi dev local.
>    - API `POST /api/v1/calls/ice-servers`, `POST /api/v1/calls`, `POST /api/v1/calls/:callPublicId/signal` (SDP offer/answer, ICE candidate), `POST /api/v1/calls/:callPublicId/action` (`accept` / `decline` / `end`).
>    - `call.policy.ts`: Cưỡng chế chỉ gọi được trong hội thoại `primary`, không bị chặn; nếu 1 trong 2 người chặn nhau giữa cuộc gọi → tự động ngắt ngay. Tự động timeout sau 45 giây nếu không nhấc máy; rate limit chống spam gọi.
>    - Tự động ghi nhận thẻ sự kiện gọn gàng trong khung chat sau khi cuộc gọi kết thúc / nhỡ.
> 2. **Giao diện Gọi Thoại & Video mượt mà:**
>    - Nút Gọi thoại & Gọi video trên thanh tiêu đề khung chat (ẩn khi là Tin nhắn đang chờ).
>    - Hộp thoại **Cuộc gọi đến** hiển thị toàn cục (dù người nhận đang ở trang chủ hay trang cá nhân) kèm nút Trả lời / Từ chối.
>    - Màn hình cuộc gọi: video toàn màn hình sắc nét, khung hình tự soi nhỏ ở góc, các nút tròn gọn gàng (Tắt/Bật mic, Tắt/Bật camera, Kết thúc cuộc gọi), thông báo thân thiện khi thiếu quyền micro/camera.
> 3. **Hoàn thiện Ma trận Kiểm thử BOLA trong CI & Tổng rà soát UI:**
>    - Tạo bộ test tổng hợp `tests/security/phase2-bola-matrix.test.ts` kiểm thử đầy đủ ma trận `{User A, User B, User C bị chặn, User D private/ngoài cuộc, Anon}` trên toàn bộ endpoint Profile, Follow, Block, Notifications, Realtime Token, Conversations, Messages, Media và Calls.
>    - Rà soát lại toàn bộ chuỗi văn bản trên UI đảm bảo **100% tự nhiên, không còn bất kỳ chữ kỹ thuật hay nhãn dev nào**.
>    - Cập nhật `README.md` (kiến trúc tổng thể Giai đoạn 1 + 2, sơ đồ E2EE & WebRTC, hướng dẫn cấu hình 0đ Ably + Vercel Blob + Metered TURN).
>    - Kiểm tra `.github/workflows/ci.yml` (ghim SHA các action, `npm ci`, `gitleaks`).
>
> **Bước 1:** Trình bày kế hoạch triển khai M12, sơ đồ luồng Signaling WebRTC và ma trận test BOLA để tôi duyệt trước khi code.

---

## PHẦN 3: PROMPT KIỂM TOÁN BẢO MẬT & UI (DÙNG SAU MỖI CỘT MỐC)

Sau khi AI báo xong bất kỳ cột mốc nào từ M6–M12, gửi prompt ngắn này để AI tự rà soát lại toàn bộ:

> Đóng vai một Principal Security Auditor & Product Designer độc lập, hãy kiểm tra lại toàn bộ mã nguồn vừa viết cho cột mốc này theo 7 tiêu chí:
> 1. **Chống BOLA/IDOR:** Có endpoint, kênh Realtime hay luồng tải Media nào tin `user_id` từ client, lộ khóa nội bộ `id` (UUIDv7), thiếu kiểm tra Block 2 chiều, hoặc trả `403` thay vì `404` khi người lạ/người bị chặn truy cập không?
> 2. **Bảo vệ dữ liệu & E2EE:** Có dòng log (Pino/Sentry/console) nào vô tình in plaintext tin nhắn, khóa riêng, file key hay cookie không? Mọi input đã dùng Zod `.strict()` chưa?
> 3. **Cưỡng chế Server:** Các quy tắc 5 phút sửa/thu hồi, giới hạn 3 tin nhắn chờ, tắt Active Status / Đã xem đối xứng có bị phụ thuộc vào đồng hồ hay logic phía Client không?
> 4. **Bảo mật File & XSS:** Upload ảnh đại diện đã kiểm magic bytes, chặn SVG, xóa EXIF bằng `sharp` chưa? Tin nhắn có chặn ký tự RTL override và không dùng `dangerouslySetInnerHTML` chưa?
> 5. **Độ sạch giao diện:** Rà soát toàn bộ component UI mới tạo — xóa ngay bất kỳ dòng chữ kỹ thuật, mô tả thuật toán, nhãn cột mốc hay thông tin thừa nào làm rối mắt người dùng phổ thông.
> 6. **Không phá vỡ Giai đoạn 1:** Luật mật khẩu không dấu tiếng Việt và các test M0–M5 vẫn nguyên vẹn.
> 7. **CI & Gitleaks:** Chạy lại `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build` đảm bảo xanh 100% không cần `.env.local`.
>
> Nếu phát hiện bất kỳ lỗi nào, sửa triệt để rồi báo cáo kết quả.