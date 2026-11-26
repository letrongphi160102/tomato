---
trigger: glob
globs: 'src/app/(auth)/**, src/app/(dashboard)/**, src/components/**, src/lib/e2ee/**, src/lib/webrtc/**'
description: 'Quy chuẩn UI/UX thương mại 0% thuật ngữ kỹ thuật, AppShell/ChatStore/FloatingMessagesWidget, Client E2EE WebCrypto và WebRTC P2P'
---

# Quy Chuẩn Giao Diện Thương Mại, Client E2EE & WebRTC (TOMATO)

## 1. Luật Bất Biến Giao Diện Thương Mại (0% Thuật Ngữ Kỹ Thuật)

- Bố cục tinh gọn, khoảng trắng thoáng, phản hồi tức thì (Optimistic UI) lấy cảm hứng từ Instagram & Messenger.
- **TUYỆT ĐỐI KHÔNG hiển thị thuật ngữ kỹ thuật, mật mã hay nhãn nội bộ** lên giao diện (_E2EE, AES-256-GCM, ECDH, ECDSA, PBKDF2, ciphertext, WebRTC, DTLS-SRTP, STUN/TURN, BOLA, IDOR, RLS, Drizzle, Redis TTL, Giai đoạn 1/2, Cột mốc M0–M13..._). Chỉ dùng tiếng Việt phổ thông tự nhiên (_"Tin nhắn được bảo vệ riêng tư"_, _"Mã PIN đồng bộ tin nhắn"_, _"Mã an toàn"_).
- Không đặt nút dev trên Production; không thêm banner cookie/GDPR hay trang pháp lý ngoài phạm vi.

## 2. Kiến Trúc `AppShell`, `ChatStoreProvider` & Phiên Client

- `src/app/(dashboard)/layout.tsx` kiểm tra phiên SSR qua `resolveServerAuthState()` (`src/modules/auth/server-session.ts`), dùng `SilentSessionGate` khi `needs_refresh` và bọc trang trong `AppShell` (`src/components/layout/app-shell.tsx`).
- Giữ đúng thứ tự Provider trong `AppShell`: `RealtimePresenceProvider` → `ChatStoreProvider` (`src/components/messages/chat-store-provider.tsx`) → `CallProvider` (`src/components/calls/call-provider.tsx`), kèm `AppTopBar`, `AppLeftSidebar` (giữ cột đệm `w-[72px]` trên desktop chống Layout Shift) và `FloatingMessagesWidget` (`src/components/messages/floating-messages-widget.tsx` — kiểm tra qua `shouldRenderFloatingMessagesWidget(pathname)`).
- Trang `/messages` và `FloatingMessagesWidget` dùng chung `useChatStore()` (LRU RAM cache). Khi đăng xuất/đổi tài khoản, bắt buộc gọi `clearChatRamMemorySingleton()` và `clearE2eeClientBootstrapState()`.
- Mọi lời gọi API cần phiên hoặc thay đổi dữ liệu phải qua `authFetch` (`src/lib/auth-client.ts`) để tự đính `X-CSRF-Token` và chạy single-flight proactive refresh. **Cấm lưu token/PII vào `localStorage` hay `sessionStorage`** (chỉ lưu mốc `tomato_auth_at_freshness_v1`).

## 3. Biểu Mẫu, A11y, Chống XSS & Quản Lý Bộ Nhớ

- Biểu mẫu có đủ 4 trạng thái (`Idle`, `Loading` khóa nút chống bấm đúp, `Success`, `Error` kèm đếm ngược khi `429`), gắn `<label>`, hỗ trợ bàn phím (`Tab`/`Enter`), lỗi dùng `role="alert"` / `aria-live="polite"`; `PasswordInput` cho phép paste và đúng `autocomplete`.
- **Cấm `dangerouslySetInnerHTML`** và inline script vi phạm CSP Nonce. Lọc ký tự điều khiển & BiDi override qua `sanitizeChatPlaintext`, `sanitizeReplyTextExcerpt`, và kiểm tra emoji bằng `normalizeAndValidateSingleEmoji` (`Intl.Segmenter` tại `src/lib/chat/emoji.ts`).
- Thu hồi ngay `blob:` URL (`URL.revokeObjectURL`, `revokeMediaObjectUrlByMessageId`, `revokeMediaObjectUrlsByConversationId`) khi đóng `ImageLightboxModal`, thu hồi tin hoặc rời hội thoại để chống rò RAM.

## 4. Mã Hóa Đầu Cuối E2EE Phía Trình Duyệt (`src/lib/e2ee/`)

- Chỉ dùng **Web Crypto API gốc** (`window.crypto.subtle`), lưu khóa riêng `ECDH P-256` & `ECDSA P-256` trong IndexedDB (`src/lib/e2ee/keystore.ts`) với `extractable: false`.
- Tin nhắn (`src/lib/e2ee/cipher.ts`): dùng `encryptDirectMessage`, `decryptDirectMessage`, `reEncryptEditedDirectMessage` (`AES-256-GCM`) kèm AAD bắt buộc từ `buildMessageAadString` (`conversationPublicId|senderPublicId|clientMsgId`) và chữ ký `buildMessageSignatureTranscript`; bọc khóa cho mọi thiết bị hoạt động cùng Khóa Đồng bộ (`is_sync_key`).
- Mã PIN 6 số (`src/lib/e2ee/pin-backup.ts`): `createPinProtectedKeyBackup` dùng `PBKDF2-SHA256` (`MIN_PIN_PBKDF2_ITERATIONS = 600_000`) + `AES-256-GCM`, xóa JWK khóa riêng tạm trong RAM ngay sau khi import lại `extractable: false`.
- Ảnh HD & Voice (`src/lib/e2ee/media-cipher.ts`): dùng `prepareHdImageForEncryption`, `validateVoiceBinaryInput`, `encryptMediaBinary` / `decryptMediaBinary` (kiểm tra `SHA-256` bản mã trước khi giải mã), upload thẳng bằng client upload token (`@vercel/blob/client` hoặc route local).

## 5. Gọi Thoại & Video 1-1 WebRTC (`src/lib/webrtc/`, `src/components/calls/`)

- Điều phối P2P `DTLS-SRTP` qua `PeerCallEngine` (`src/lib/webrtc/call-engine.ts`), `IncomingCallDialog`, `ActiveCallScreen`, `GlobalCallOverlay`: lấy `iceServers` từ `POST /api/v1/calls/ice-servers`, đệm ICE candidate trước khi có `remoteDescription`, gửi heartbeat mỗi 30s và kết thúc `keepalive` khi `pagehide`.
- Dừng mọi track bằng `stopAllMediaStreamTracks` khi kết thúc/hủy cuộc gọi và chuyển lỗi quyền thiết bị sang tiếng Việt thân thiện bằng `mapMediaDeviceErrorToFriendlyVi`.
