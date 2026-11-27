---
trigger: glob
globs: 'src/app/(auth)/**, src/app/(dashboard)/**, src/components/**, src/lib/e2ee/**, src/lib/webrtc/**'
description: 'Quy chuẩn UI/UX thương mại 0% thuật ngữ kỹ thuật, AppShell/ChatStore/FloatingMessagesWidget, Client E2EE WebCrypto và WebRTC P2P'
---

# Quy Chuẩn Giao Diện Thương Mại, Client E2EE & WebRTC (TOMATO)

## 1. Luật Bất Biến Giao Diện Thương Mại (0% Thuật Ngữ Kỹ Thuật)

- Bố cục tinh gọn, thoáng, phản hồi tức thì (Optimistic UI) chuẩn Instagram & Messenger; không đặt nút dev hay banner GDPR.
- **CẤM hiển thị thuật ngữ kỹ thuật, mật mã, tên nhà cung cấp hạ tầng hay nhãn nội bộ** trên UI và `aria-label` (_E2EE, AES-256-GCM, ECDH, ECDSA, PBKDF2, ciphertext, WebRTC, DTLS-SRTP, STUN/TURN, Cloudflare Turnstile, chống bot, Ably, Upstash, Vercel Blob, BOLA, IDOR, RLS, Drizzle, Giai đoạn 1/2, M0–M13..._). Dùng tiếng Việt tự nhiên (_"Xác nhận bảo mật"_, _"Tin nhắn được bảo vệ riêng tư"_, _"Mã PIN đồng bộ tin nhắn"_, _"Mã an toàn"_).

## 2. `AppShell`, Khung Nhìn `100dvh`, Cuộn Chat & `ChatStoreProvider`

- Mọi trang sau đăng nhập (gồm Trang chủ `src/app/(dashboard)/page.tsx`, không tạo lại `src/app/page.tsx`) đặt chung dưới `src/app/(dashboard)/layout.tsx` (`resolveServerAuthState()` bọc `React.cache`, `SilentSessionGate`, `/` chưa đăng nhập chuyển thẳng `/login` không kèm `?next=%2F`) để chuyển trang không làm ngắt Realtime hay rớt cuộc gọi.
- Thứ tự Provider trong `AppShell` (`flex min-h-dvh flex-col` + thân `flex-1`): `RealtimePresenceProvider` → `ChatStoreProvider` → `CallProvider`, kèm `AppTopBar`, `AppLeftSidebar` (đệm `w-[72px]` desktop) và `FloatingMessagesLauncher` (tách `next/dynamic` cho `FloatingMessagesWidget`).
- **Khung `100dvh`, Thang `z-index` & Cuộn tự động**:
  - Khung toàn trang `/messages` (`MessagesView`) dùng `min-h-0` + `100dvh` trừ đúng chiều cao `AppTopBar` (kể cả `border-b`) và padding `<main>` ở từng breakpoint — **cấm ép cứng `min-h-[540px]`** gây thanh cuộn dọc ngoài trên màn hình Laptop scale `125%–150%`.
  - Thang `z-index` 5 tầng: `z-30` (sidebar/floating widget) → `z-40` (`AppTopBar`) → `z-50` (modal chuẩn) → `z-[60]` (dropdown/tooltip/confirm/lightbox/`EmojiPickerPopover` qua `createPortal` kèm kẹp biên `360px`) → `z-[70]` (overlay cuộc gọi). Tách `next/dynamic(..., { ssr: false })` cho modal/editor nặng; giữ state gõ phím cục bộ trong `ChatComposerWithMedia`.
  - Cuộn khung tin nhắn bắt buộc qua `evaluateConversationAutoScroll` (`src/components/messages/scroll-position.ts`): reset khi `convId = null` và so sánh **cả `convId` lẫn DOM `container`** để bấm Quay lại (`<-`) rồi mở lại cùng đoạn chat luôn về đáy; khóa `loadOlderMessages` trước khi cuộn đáy lần đầu hoàn tất.
- Dùng chung `useChatStore()` (`ChatUnreadContext` riêng cho badge chưa đọc) và `authFetch` (`src/lib/auth-client.ts`, cấm lưu token/PII vào `localStorage`/`sessionStorage` ngoài mốc `tomato_auth_at_freshness_v1`). Kiểm tra `getChatRamCacheEpoch()` sau mọi `await` nạp dữ liệu/media; khi đăng xuất hoặc thu hồi phiên hiện tại (`SecuritySessionsPanel`), gọi đủ `call.cleanupOnLogout()`, `chatStore.clearAllChatCache()`, `realtime.disconnectAll()`, `clearE2eeClientBootstrapState()`.

## 3. Biểu Mẫu, A11y, Chống XSS & Giải Phóng Bộ Nhớ

- Biểu mẫu đủ 4 trạng thái (`Idle`, `Loading` khóa nút, `Success`, `Error` đếm ngược `429`), gắn `<label>`, hỗ trợ `Tab`/`Enter`/`Escape`, `role="alert"`; `PasswordInput` cho phép paste.
- **Cấm `dangerouslySetInnerHTML`** và inline script. Lọc BiDi/control qua `sanitizeChatPlaintext`, `sanitizeReplyTextExcerpt`; kiểm emoji qua `normalizeAndValidateSingleEmoji` (`src/lib/chat/emoji.ts`).
- Thu hồi cả `mediaObjectUrlsByMsgId` lẫn `localPreviewUrl` (`URL.revokeObjectURL`, `revokeThreadLocalPreviewUrls`, `revokeMediaObjectUrlsByConversationId`) khi đuổi LRU (`putLruConversationThreadCache`), gửi lỗi, xóa tin, từ chối hoặc chặn; gắn `AbortController` khi đổi chat/tìm kiếm và giải phóng `<canvas>` / `AudioContext`.

## 4. Mã Hóa Đầu Cuối E2EE (`src/lib/e2ee/`)

- Dùng **Web Crypto API gốc**, lưu khóa riêng `ECDH`/`ECDSA P-256` với `extractable: false` trong `src/lib/e2ee/keystore.ts` (tái sử dụng 1 `IDBDatabase` + read-through `memoryKeystore` và LRU khóa ECDSA, xóa qua `clearInMemoryKeystore()` / `clearCachedE2eeCryptoHelpers()` khi đăng xuất).
- Tin nhắn (`cipher.ts`): `encryptDirectMessage`, `decryptDirectMessage`, `reEncryptEditedDirectMessage` (`AES-256-GCM`) kèm AAD `buildMessageAadString` + chữ ký `buildMessageSignatureTranscript`, bọc đủ thiết bị và `is_sync_key`.
- Mã PIN (`pin-backup.ts`): `createPinProtectedKeyBackup` (`PBKDF2-SHA256` `MIN_PIN_PBKDF2_ITERATIONS = 600_000`), xóa JWK tạm trong RAM sau import. Media (`media-cipher.ts`): `prepareHdImageForEncryption`, `validateVoiceBinaryInput`, `encryptMediaBinary`/`decryptMediaBinary` (kiểm `SHA-256`).

## 5. Gọi Thoại & Video 1-1 WebRTC (`src/lib/webrtc/`, `src/components/calls/`)

- Điều phối `DTLS-SRTP` qua `PeerCallEngine` (`call-engine.ts`), `IncomingCallDialog`, `ActiveCallScreen`, `GlobalCallOverlay`: lấy `iceServers`, đệm ICE trước `remoteDescription`, heartbeat 30s, `keepalive` khi `pagehide`, dịch lỗi qua `mapMediaDeviceErrorToFriendlyVi`.
- Khi tắt cam (`setCameraEnabled(false)`), gọi `sender.replaceTrack(null)` + `track.stop()` chỉ trên video track (giữ nguyên audio) kèm `recvonly` để tắt đèn LED phần cứng và chuyển đối phương về avatar. Sau mọi `await` trong `CallProvider`, kiểm `mountedRef` + `callAttemptSeqRef` để `stopAllMediaStreamTracks` nếu cuộc gọi đã hủy; đặt bộ đếm giây cục bộ trong `ActiveCallScreen` (dừng khi ẩn tab).
