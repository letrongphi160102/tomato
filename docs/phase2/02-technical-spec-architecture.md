# ĐẶC TẢ KỸ THUẬT — PHẦN 1: KIẾN TRÚC & CÔNG NGHỆ 0Đ (GIAI ĐOẠN 2)

- **Dự án:** TOMATO — Mạng xã hội
- **Giai đoạn:** 2 — Kết nối Người dùng, Nhắn tin Bảo mật E2EE & Gọi Thoại/Video 1-1
- **Ràng buộc hạ tầng:** Ngân sách **0đ trọn đời** (Không thẻ tín dụng, không email `.edu`, không dùng thử giới hạn thời gian)
- **Tài liệu liên quan:** Xem Phần 2 (Schema DB, API, E2EE, Bảo mật OWASP 2025 & Lộ trình M6–M12) tại `docs/phase2/03-design-security-roadmap.md`.

---

## 1. Đối chiếu Tài liệu Tham khảo với Thực tế Ngân sách 0đ

Tài liệu tham khảo đề xuất kiến trúc cấp tập đoàn (hàng chục triệu user). Để vừa giữ trọn **tư duy bảo mật cấp Principal/Staff (OWASP 2025, Deny-by-default, E2EE, BOLA defense-in-depth)** vừa vận hành thực tế **0đ trọn đời** trên Vercel, mọi thành phần được quy đổi qua lớp trừu tượng (Port & Adapter) để sau này mở rộng không cần viết lại nghiệp vụ:

| Thành phần trong Tài liệu tham khảo | Phương án TOMATO Giai đoạn 2 (0đ trọn đời) | Lý do & Khả năng mở rộng về sau |
| :--- | :--- | :--- |
| **PostgreSQL + ScyllaDB/Cassandra** | **Neon PostgreSQL (Free)** thiết kế bảng `messages` theo cặp `(conversation_id, seq)` | Ở quy mô 1.000–100.000 user, PostgreSQL đánh index composite `(conversation_id, seq DESC)` đạt tốc độ < 10ms và hỗ trợ ACID Transaction mạnh mẽ. Khi lên hàng triệu user, chỉ cần tách `messages` sang phân vùng (Partitioning) hoặc ScyllaDB sau lớp Repository. |
| **OpenSearch (tìm `@user_id`)** | **PostgreSQL `pg_trgm` + B-Tree `varchar_pattern_ops`** ngay trên Neon | Tìm kiếm tiền tố `@user_id` (`LIKE 'abc%'`) và tìm mờ tên hiển thị cực nhanh với chi phí 0đ, không phải đồng bộ dữ liệu sang hệ thống thứ hai. |
| **WSS Gateway + Kafka/NATS** | **Ably Free Tier** (6 triệu tin/tháng, 200 kết nối đồng thời, **không cần thẻ**) qua interface `RealtimeProvider` | Vercel Serverless không giữ kết nối WebSocket dài hạn. Ably cung cấp Edge WSS toàn cầu (TLS 1.3), không bị ngủ đông, hỗ trợ **Token Auth ngắn hạn do Server TOMATO cấp** (kiểm soát BOLA chặt chẽ trên từng kênh). Ở local/test dùng Adapter nội bộ/mock. |
| **S3 + CloudFront / R2 (Media & Avatar)** | **Vercel Blob (Hobby Free)** — có sẵn trong tài khoản Vercel hiện tại, **không cần thẻ** (kèm `LocalFsStorageAdapter` ở local) | Phục vụ file trên domain riêng `*.public.blob.vercel-storage.com` (**hoàn toàn không gửi kèm cookie auth của TOMATO**). Avatar đã qua re-encode lưu trực tiếp; Ảnh HD & Voice chat được mã hóa AES-256-GCM phía Client thành khối nhị phân trước khi tải lên. |
| **OpenFGA/SpiceDB + PostgreSQL RLS** | **Tầng Policy ReBAC tập trung** (`social.policy.ts`, `chat.policy.ts`) + **PostgreSQL Row-Level Security (RLS)** | Phòng thủ 2 lớp đúng nguyên tắc tài liệu tham khảo mà không tốn VPS chạy dịch vụ OpenFGA riêng. |
| **OpenMLS (WASM) / `libsignal`** | **E2EE chuẩn WebCrypto Native (`ECDH P-256` + `HKDF-SHA256` + `AES-256-GCM` + Symmetric Chain Ratchet)** sau interface `E2eeEngine` | Tài liệu tham khảo nêu rõ target WASM của OpenMLS chưa có test CI đầy đủ, còn `libsignal` dùng giấy phép AGPLv3. WebCrypto API là mật mã học chuẩn có sẵn trong trình duyệt (không tự chế thuật toán, khóa `non-extractable` trong IndexedDB, chạy mượt trên Next.js/Vercel). Sẵn sàng cắm OpenMLS khi triển khai Nhắn tin nhóm ở Giai đoạn 3. |
| **WebRTC + LiveKit SFU + `coturn` VPS** | **WebRTC P2P 1-1 (DTLS-SRTP sẵn có)** + Signaling qua API/Ably + STUN công khai + **Metered TURN Free** (20GB/tháng, không cần thẻ) | Cuộc gọi 1-1 dùng P2P DTLS-SRTP đã mã hóa đầu cuối trực tiếp giữa 2 trình duyệt mà không tốn máy chủ SFU. Server cấp TURN credential ngắn hạn qua `TurnCredentialProvider` (ẩn hoàn toàn API key). |
| **Image Sandbox (`libvips` + gVisor)** | **`sharp` (nhân `libvips` C++)** chạy trên Next.js Node.js Runtime (`export const runtime = 'nodejs'`) | Kiểm tra magic bytes, chặn SVG, giới hạn dung lượng & tổng số pixel (chống decompression bomb), xóa sạch EXIF/GPS, tự xoay hướng ảnh và nén lại thành WebP. |
| **Cloud KMS/HSM & mTLS** | Biến môi trường mã hóa của Vercel + TLS 1.3 (Vercel/Neon/Upstash/Ably mặc định) | Giữ nguyên thiết kế tách `SecretProvider` và phiên bản hóa khóa (`key_version`) để nâng cấp lên KMS khi dự án có doanh thu. |

---

## 2. Bộ Công nghệ Giai đoạn 2 (Chi tiết thư viện bổ sung)

Kế thừa toàn bộ stack Giai đoạn 1 (Next.js App Router, TypeScript Strict, Drizzle ORM, Neon PostgreSQL, Upstash Redis, Tailwind CSS + shadcn/ui, Zod, Vitest, Pino, Sentry, GitHub Actions):

| Nhóm tính năng | Thư viện / Dịch vụ đề xuất | Lưu ý cài đặt & Tối ưu 0đ |
| :--- | :--- | :--- |
| **Xử lý & Cắt Ảnh đại diện** | Client: `react-easy-crop` <br> Server: `sharp` + `file-type` | Khai báo `serverExternalPackages: ['@node-rs/argon2', 'sharp']` trong `next.config.ts`. Tuyệt đối không chạy `sharp` trên Edge Runtime. |
| **Lưu trữ Media** | `@vercel/blob` (Prod) + Local Disk/Static Route (Dev) | Tách hoàn toàn qua interface `MediaStorageProvider` trong `src/core/storage/`. |
| **Realtime WSS** | `ably` (Server SDK + Client SDK) | Client **không bao giờ** chứa Ably API Key; chỉ gọi `POST /api/v1/realtime/token` để nhận Token Request ngắn hạn (hạn 1 giờ, chỉ có quyền `subscribe` trên duy nhất kênh riêng `user:{publicId}`). |
| **E2EE phía Trình duyệt** | **Web Crypto API** (`window.crypto.subtle`) + `idb` (IndexedDB wrapper nhẹ) | Khóa riêng định danh (`Identity Private Key`) tạo với `extractable: false` lưu trong IndexedDB. Thực hiện giải mã bất đồng bộ, có thể tách Web Worker khi danh sách tin lớn. |
| **Emoji & Ảnh mờ (Placeholder)** | `emoji-mart` (hoặc bộ bảng emoji nhẹ chuẩn Unicode) + `thumbhash` / `blurhash` | Không dùng `dangerouslySetInnerHTML`. Lọc bỏ ký tự điều khiển nguy hiểm (như RTL override `U+202E`). |
| **Voice Recorder** | Native `MediaRecorder` API (`audio/webm;codecs=opus` fallback `audio/mp4`) | Ghi âm nhẹ (~24–32 kbps), mã hóa AES-256-GCM trước khi upload, giới hạn tối đa 120 giây. |
| **Video/Voice Call** | Native `RTCPeerConnection` (WebRTC) + Signaling qua API & Ably | Hỗ trợ lấy ICE servers (STUN + TURN ngắn hạn) từ `POST /api/v1/calls/ice-servers` (chỉ user đã đăng nhập, có rate limit). |

---

## 3. Kiến trúc Luồng Dữ liệu Chính

### 3.1. Nguyên tắc Phân tách Giao tiếp (Realtime & REST)
- **Mọi thao tác ghi dữ liệu (Gửi tin, Follow, Block, Tạo cuộc gọi, Đánh dấu đã xem)** đều đi qua **REST API (`/api/v1/*`)** của Next.js:
  1. Xác thực Access Token Cookie + kiểm tra CSRF/Origin Guard.
  2. Kiểm tra Rate Limit trên Upstash Redis.
  3. Kiểm tra phân quyền tập trung (`authorize`) + kiểm tra trạng thái Block/Private.
  4. Ghi bền vững vào Neon PostgreSQL (Transaction + Idempotency Key).
  5. Phát sự kiện nhẹ (Envelope/Notification) qua **Ably** tới kênh riêng của người nhận `user:{recipientPublicId}`.
- **Lợi ích bảo mật cực lớn:** Client **không bao giờ** có quyền tự phát sự kiện (publish) thẳng lên kênh của người khác trên Ably. Toàn bộ luật nghiệp vụ (chặn, tin nhắn chờ, giới hạn 3 tin, hạn sửa 5 phút) đều được **cưỡng chế 100% ở phía Server**, triệt để ngăn chặn BOLA trên kênh WebSocket.

### 3.2. Cấu trúc Thư mục Mở rộng (Modular Monolith)

```text
src/
├── app/
│   ├── (dashboard)/
│   │   ├── page.tsx                         # Trang chủ (App Shell kiểu Instagram/Facebook)
│   │   ├── u/[handle]/page.tsx              # Trang cá nhân người dùng (@user_id)
│   │   ├── messages/                        # Giao diện Nhắn tin + Tin nhắn đang chờ + Khung Call
│   │   └── settings/
│   │       ├── profile/page.tsx             # Đổi @user_id, Tên, Bio, Ảnh đại diện (Crop)
│   │       ├── privacy/page.tsx             # Tài khoản riêng tư, Active Status, Đã xem, Đã chặn
│   │       └── security/page.tsx            # (Từ Giai đoạn 1) Thiết bị & Đổi mật khẩu 2 bước
│   └── api/v1/
│       ├── auth/...                         # (Giai đoạn 1)
│       ├── users/...                        # Profile, @handle, Avatar upload, Search
│       ├── social/...                       # Follow, Requests, Followers/Following, Block
│       ├── notifications/...                # Danh sách, đánh dấu đã đọc
│       ├── realtime/token/route.ts          # Cấp Ably Token Request ngắn hạn (AuthZ)
│       ├── presence/...                     # Heartbeat & truy vấn trạng thái hoạt động
│       ├── e2ee/...                         # Đăng ký khóa thiết bị, lấy Key Bundle, Key Backup
│       ├── conversations/...                # Hội thoại, Tin nhắn chờ, Tin nhắn, Sửa/Thu hồi/Xóa, Đã xem
│       ├── media/...                        # Upload/tải blob mã hóa cho Ảnh HD & Voice
│       └── calls/...                        # Signaling cuộc gọi 1-1 & cấp ICE/TURN servers
├── core/
│   ├── db/
│   │   ├── rls.ts                           # Helper chạy Transaction kèm SET LOCAL app.current_user_id
│   │   └── schema/                          # Bổ sung schema Giai đoạn 2
│   ├── storage/                             # MediaStorageProvider + LocalFsAdapter + VercelBlobAdapter
│   ├── realtime/                            # RealtimeProvider + AblyAdapter + LocalMockAdapter
│   ├── media/                               # Sharp avatar pipeline + magic bytes validator
│   └── webrtc/                              # TurnCredentialProvider (Metered Free / STUN fallback)
└── modules/
    ├── auth/                                # (Giai đoạn 1)
    ├── profile/                             # @handle normalization, avatar, search
    ├── social/                              # follow.service, block.service, social.policy.ts
    ├── notifications/                       # notification.service, dedupe
    ├── presence/                            # Redis TTL presence + symmetric visibility
    ├── chat/                                # e2ee-keys, conversation, message, chat.policy.ts
    └── calls/                               # call-signaling.service, call.policy.ts
```