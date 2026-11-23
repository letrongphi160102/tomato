# ĐẶC TẢ TÍNH NĂNG (FUNCTIONAL SPECIFICATION) — GIAI ĐOẠN 2

- **Dự án:** TOMATO — Mạng xã hội
- **Giai đoạn:** 2 — Hồ sơ Cá nhân, Mạng lưới Kết nối, Thông báo, Nhắn tin Bảo mật & Gọi Thoại/Video 1-1
- **Phiên bản:** 2.0
- **Nền tảng kế thừa:** Hệ thống Tài khoản, Phiên & Bảo mật (Giai đoạn 1 — M0 đến M5, giữ nguyên luật mật khẩu không dấu tiếng Việt).

---

## 1. Mục tiêu & Nguyên tắc Trải nghiệm (UI/UX Chuẩn Sản phẩm)

Giai đoạn 2 biến TOMATO thành một không gian kết nối xã hội trọn vẹn lấy cảm hứng từ **Instagram** và **Messenger**, nơi người dùng có thể tìm kiếm nhau qua `@user_id`, xây dựng mạng lưới theo dõi riêng tư hoặc công khai, nhận thông báo tức thì, nhắn tin đa phương tiện và gọi thoại/video trực tiếp trên trình duyệt.

### Luật bất biến về Giao diện (Bắt buộc áp dụng trên mọi màn hình)
1. **Không hiển thị nội dung kỹ thuật cho người dùng cuối:** Tuyệt đối không đưa lên giao diện các cụm từ như *E2EE, AES-256-GCM, WebRTC, DTLS-SRTP, BOLA, IDOR, RLS, Redis TTL, Giai đoạn 2, Cột mốc M6...* hay mô tả cơ chế mã hóa dài dòng. Nếu cần báo hiệu riêng tư, chỉ dùng câu chữ phổ thông ngắn gọn (ví dụ: *"Tin nhắn được bảo vệ riêng tư"* hoặc biểu tượng ổ khóa nhỏ tinh tế).
2. **Tối giản, mượt mà, quen thuộc:** Bố cục gọn gàng, khoảng trắng hợp lý, phản hồi tức thì (Optimistic UI khi thả tin nhắn, follow, thích, đổi cài đặt), không nhồi nhét nút kiểm tra dev (trừ khi chạy `localhost:3000`).
3. **Bỏ qua yếu tố pháp lý ở phiên bản này:** Không thêm banner cookie, xuất dữ liệu GDPR hay trang chính sách dài dòng trong Giai đoạn 2.

---

## 2. Phạm vi Giai đoạn 2 (Scope)

### 2.1. Trong phạm vi (In-Scope)
- **Hồ sơ & Định danh công khai:** Thiết lập/đổi `@user_id` (handle), tiểu sử (bio), đổi ảnh đại diện kèm công cụ **căn chỉnh (kéo, phóng to/thu nhỏ) và cắt ảnh**.
- **Tìm kiếm người dùng:** Thanh tìm kiếm nhanh theo `@user_id` và tên hiển thị.
- **Mạng lưới Follow & Tài khoản riêng tư:** Follow/Unfollow, bật/tắt chế độ Tài khoản riêng tư, gửi/hủy/chấp nhận/từ chối yêu cầu follow, xem danh sách Người theo dõi (Followers) & Đang theo dõi (Following), gỡ người theo dõi.
- **Chặn người dùng (Block):** Chặn và bỏ chặn hai chiều toàn hệ thống.
- **Thanh Thông báo (Notifications):** Nhận thông báo thời gian thực cho yêu cầu follow, chấp nhận follow, người theo dõi mới, tin nhắn chờ mới.
- **Nhắn tin 1-1 thời gian thực:**
  - Gửi chữ, gửi icon/emoji.
  - Gửi ảnh chất lượng cao (HD) và tin nhắn thoại (Voice).
  - Chỉnh sửa và thu hồi tin nhắn trong **5 phút đầu**.
  - Xóa 1 dòng tin nhắn ở phía mình (bên kia vẫn thấy bình thường).
  - Xóa toàn bộ đoạn hội thoại ở phía mình.
  - Mục **Tin nhắn đang chờ (Message Requests)** khi hai người chưa từng kết nối.
- **Gọi Thoại & Gọi Video 1-1:** Gọi micro / video trực tiếp giữa hai tài khoản đã kết nối.
- **Quyền riêng tư tương tác (Đối xứng):**
  - Bật/tắt **Trạng thái hoạt động** (Active Status).
  - Bật/tắt **Trạng thái đã xem** tin nhắn (Read Receipts).

### 2.2. Ngoài phạm vi Giai đoạn 2 (Out-of-Scope — Để dành Giai đoạn 3)
- Đăng bài viết, Bảng tin (Newsfeed), Stories, Reels, Bình luận.
- Nhắn tin nhóm (Group Chat) và Gọi nhóm (Group Call / SFU).
- Tích hợp đăng nhập Google/Apple, Passkeys, 2FA.
- Xuất dữ liệu cá nhân, kiểm duyệt nội dung AI tự động, tuân thủ pháp lý.

---

## 3. Đặc tả chi tiết từng Tính năng

### 3.1. Hồ sơ Người dùng, `@user_id` & Ảnh đại diện (Crop & Align)

#### A. Quản lý `@user_id` (Handle)
- **Định dạng:** Dài từ **3 đến 30 ký tự**, chỉ gồm chữ cái thường tiếng Anh, chữ số, dấu chấm và gạch dưới (`[a-z0-9._]`). Tự động chuẩn hóa Unicode NFKC và chuyển chữ thường.
- **Quy tắc chống giả mạo:** Không cho phép bắt đầu/kết thúc bằng dấu chấm, không chứa 2 dấu chấm liên tiếp (`..`), chặn ký tự đồng dạng gây nhầm lẫn và danh sách từ khóa hệ thống dành riêng (`admin`, `support`, `tomato`, `settings`, `messages`, `api`, `login`, `register`, `explore`, `notifications`...).
- **Đổi `@user_id`:** Giới hạn tần suất đổi (ví dụ tối đa 2 lần trong 14 ngày). Giữ chỗ `@user_id` cũ trong 14 ngày để tránh người khác cướp tên ngay lập tức.
- **Người dùng cũ từ Giai đoạn 1:** Tự động cấp `@user_id` mặc định hợp lệ hoặc yêu cầu chọn `@user_id` lần đầu gọn gàng ngay sau khi đăng nhập.

#### B. Thay đổi Ảnh đại diện (Căn chỉnh & Cắt ảnh)
- **Định dạng hỗ trợ:** JPEG, PNG, WebP (tối đa **10 MB** đầu vào).
- **Trải nghiệm người dùng:**
  1. Người dùng chọn ảnh từ máy → mở hộp thoại **Căn chỉnh ảnh đại diện**.
  2. Khung cắt hình tròn (tỉ lệ 1:1) cho phép **kéo thả vị trí (pan)** và **thanh trượt phóng to/thu nhỏ (zoom)** để chọn đúng góc hiển thị mong muốn.
  3. Bấm **"Lưu ảnh"** → hiển thị trạng thái tải mượt mà → cập nhật ảnh đại diện ngay lập tức trên toàn bộ thanh điều hướng và trang cá nhân.
  4. Có tùy chọn **"Gỡ ảnh đại diện"** để quay về ảnh mặc định theo chữ cái đầu của tên.
- **Trường hợp ngoại lệ:** Tải lên file giả mạo đuôi ảnh (như SVG, script, file nén) hoặc ảnh kích thước điểm ảnh quá lớn → từ chối với thông báo thân thiện *"Ảnh không hợp lệ hoặc vượt quá kích thước cho phép"*.

---

### 3.2. Thanh Tìm kiếm Người dùng (`@user_id`)
- **Vị trí:** Luôn dễ tiếp cận trên thanh điều hướng chính.
- **Hành vi:**
  - Người dùng gõ từ khóa (có thể gõ kèm `@` hoặc không, tối thiểu **2 ký tự**), debounce 250–300ms.
  - Tìm ưu tiên theo tiền tố `@user_id` khớp chính xác trước, sau đó theo tên hiển thị. Trả về tối đa **20 kết quả**.
  - Mỗi kết quả hiển thị: Ảnh đại diện, `@user_id`, Tên hiển thị, và trạng thái ngắn gọn (nếu đang theo dõi).
- **Ràng buộc riêng tư:**
  - **Không** tìm kiếm theo địa chỉ email.
  - Tự động loại bỏ hoàn toàn các tài khoản mình đã chặn, tài khoản đã chặn mình, và tài khoản đang ở trạng thái chưa xác minh / bị khóa / đã xóa.

---

### 3.3. Follow / Unfollow, Tài khoản Riêng tư & Danh sách Theo dõi

#### A. Máy trạng thái Quan hệ (Follow State Machine)
Giữa người dùng A (người đi theo dõi) và B (người được theo dõi), quan hệ chỉ ở 1 trong 3 trạng thái:
1. `none`: Chưa theo dõi.
2. `requested`: Đã gửi yêu cầu theo dõi (khi B bật Tài khoản riêng tư).
3. `following`: Đang theo dõi.

#### B. Luồng nghiệp vụ
- **Tài khoản Công khai:** A bấm **"Theo dõi"** → chuyển ngay sang `following`, tăng bộ đếm Followers của B và Following của A, gửi thông báo cho B.
- **Tài khoản Riêng tư:**
  - Người lạ (chưa được duyệt) truy cập trang cá nhân của B chỉ thấy: Ảnh đại diện, `@user_id`, Tên hiển thị, Tiểu sử, số lượng Followers/Following và thông báo *"Đây là tài khoản riêng tư"*. Không bấm xem được danh sách Followers/Following.
  - A bấm **"Theo dõi"** → chuyển sang `requested` (nút đổi thành **"Đã gửi yêu cầu"**, bấm lại để hủy yêu cầu).
  - B nhận thông báo và thấy mục **Yêu cầu theo dõi** với 2 nút: **"Chấp nhận"** (chuyển sang `following` + thông báo cho A) hoặc **"Xóa"** (chuyển về `none`, không thông báo cho A).
- **Chuyển đổi Công khai ↔ Riêng tư (trong Cài đặt > Quyền riêng tư):**
  - Công khai → Riêng tư: Những người đang theo dõi sẵn vẫn giữ nguyên; người mới từ lúc này phải xin phép.
  - Riêng tư → Công khai: Hiển thị hộp thoại xác nhận; nếu đồng ý, toàn bộ yêu cầu `requested` đang chờ sẽ tự động được chấp nhận (hoặc cho người dùng chọn).
- **Gỡ người theo dõi (Remove Follower):** B có thể mở danh sách **Người theo dõi** của mình và bấm **"Gỡ"** đối với bất kỳ ai (không gửi thông báo cho người bị gỡ).
- **Danh sách Followers & Following:** Hỗ trợ cuộn tải thêm (cursor pagination), tìm nhanh trong danh sách, hiển thị đúng nút hành động (Theo dõi / Đang theo dõi / Đã yêu cầu).

---

### 3.4. Chặn Người dùng (Block / Unblock)
Khi A chặn B:
1. **Ẩn hoàn toàn hai chiều:** B không thể tìm thấy A, không xem được trang cá nhân A (trả về trạng thái *"Không tìm thấy trang"* giống tài khoản không tồn tại); A cũng không thấy B trong tìm kiếm hay danh sách gợi ý.
2. **Tự động cắt đứt quan hệ:** Hủy toàn bộ trạng thái `following` và `requested` ở cả hai chiều; cập nhật lại bộ đếm ngay lập tức.
3. **Khóa mọi tương tác:** Không thể nhắn tin, không thể gọi thoại/video, không thấy trạng thái hoạt động, không thấy trạng thái "Đã xem", không nhận thông báo từ nhau. Nếu đang trong cuộc gọi thì tự ngắt ngay lập tức.
4. **Im lặng tuyệt đối:** Không gửi bất kỳ thông báo nào cho B biết mình bị chặn.
5. **Quản lý danh sách chặn:** A có thể xem danh sách tài khoản đã chặn và bấm **"Bỏ chặn"** trong *Cài đặt > Quyền riêng tư > Tài khoản đã chặn*. Bỏ chặn không tự khôi phục trạng thái follow cũ.

---

### 3.5. Thanh Thông báo (Notifications)
- Biểu tượng hình chuông trên thanh điều hướng kèm chấm đỏ / số lượng chưa đọc cập nhật thời gian thực.
- **Các loại thông báo Giai đoạn 2:**
  1. `FOLLOW_REQUEST`: "[Tên] đã yêu cầu theo dõi bạn" (kèm nút **Chấp nhận** / **Xóa** ngay trong bảng thông báo).
  2. `FOLLOW_ACCEPTED`: "[Tên] đã chấp nhận yêu cầu theo dõi của bạn".
  3. `NEW_FOLLOWER`: "[Tên] đã bắt đầu theo dõi bạn".
  4. `MESSAGE_REQUEST`: "[Tên] muốn gửi tin nhắn cho bạn" (không hiển thị nội dung tin nhắn).
- **Hành vi:** Tự động gộp các thông báo trùng lặp (dedupe), đánh dấu đã đọc khi mở hoặc bấm **"Đánh dấu tất cả là đã đọc"**, tự ẩn/xóa thông báo từ người vừa bị chặn.

---

### 3.6. Nhắn tin 1-1 Thời gian thực & Tin nhắn đang chờ

#### A. Quy tắc "Tin nhắn đang chờ" (Message Requests)
Khi A mở cuộc trò chuyện và nhắn tin cho B:
- **Vào Hộp thư chính ngay** nếu: B đang theo dõi A (`B follows A`), HOẶC hai bên đã có cuộc trò chuyện được chấp nhận trước đó.
- **Vào mục "Tin nhắn đang chờ" của B** nếu: B chưa theo dõi A VÀ hai bên chưa từng nhắn tin hợp lệ với nhau (bao gồm trường hợp chưa ai follow ai, hoặc chỉ A follow B).
- **Giới hạn bắt buộc trong trạng thái Đang chờ (chống spam/quấy rối):**
  - A **chỉ được gửi tin nhắn văn bản & emoji** (khóa nút gửi ảnh HD, voice, gọi thoại/video).
  - Tối đa **3 tin nhắn** cho đến khi B bấm chấp nhận.
  - Không hiển thị trạng thái hoạt động của B và không gửi trạng thái "Đã xem" về cho A dù B đã mở đọc tin nhắn chờ.
- **Hành động của B tại mục Tin nhắn đang chờ:**
  - **Chấp nhận:** Chuyển hội thoại sang Hộp thư chính, mở khóa đầy đủ ảnh HD, voice, gọi điện và trạng thái đã xem.
  - **Xóa (Từ chối):** Xóa yêu cầu khỏi hộp thư của B; A không nhận thông báo từ chối.
  - **Chặn:** Kích hoạt cơ chế Chặn hai chiều.

#### B. Các tính năng trong Cuộc trò chuyện
1. **Nhắn tin & Icon/Emoji:** Nhắn chữ mượt mà, bộ chọn Emoji tích hợp, hỗ trợ xuống dòng (`Shift + Enter`), gửi nhanh (`Enter`). Hiển thị trạng thái *Đang gửi / Đã gửi / Đã xem*.
2. **Gửi Ảnh HD:** Chọn 1 hoặc nhiều ảnh (tối đa 5 ảnh/lần, mỗi ảnh tối đa 15 MB) giữ độ phân giải sắc nét; hiển thị xem trước mờ (placeholder) mượt mà khi đang tải và mở trình xem toàn màn hình (Lightbox) khi bấm vào.
3. **Gửi Tin nhắn thoại (Voice):** Bấm giữ hoặc bấm bật/tắt micro để ghi âm (tối đa 2 phút/đoạn), hiển thị thời lượng + nút hủy trước khi gửi; khung tin nhắn hiển thị trình phát gọn gàng kèm nút phát/tạm dừng, thanh tiến trình và tốc độ phát (`1x`, `1.5x`, `2x`).
4. **Chỉnh sửa tin nhắn (trong 5 phút đầu):**
   - Chỉ áp dụng cho tin nhắn văn bản do chính mình gửi trong vòng **5 phút** kể từ lúc gửi (tính theo đồng hồ máy chủ).
   - Quá 5 phút, tùy chọn "Chỉnh sửa" tự động ẩn đi; nếu cố gửi yêu cầu sửa qua API sẽ bị từ chối.
   - Tối đa 5 lần sửa mỗi tin; tin nhắn đã sửa hiển thị nhãn nhỏ *"Đã chỉnh sửa"*.
5. **Thu hồi tin nhắn (trong 5 phút đầu):**
   - Chỉ áp dụng cho mọi loại tin nhắn (chữ, ảnh HD, voice) do chính mình gửi trong vòng **5 phút đầu**.
   - Sau khi thu hồi: nội dung, ảnh hoặc file ghi âm bị xóa vĩnh viễn khỏi máy chủ; cả hai phía chỉ còn thấy dòng chữ mờ *"Tin nhắn đã được thu hồi"*.
6. **Xóa 1 dòng tin nhắn ở phía mình (Delete for Me):**
   - Áp dụng cho bất kỳ tin nhắn nào (kể cả của mình hay đối phương, không giới hạn thời gian).
   - Tin nhắn lập tức biến mất khỏi khung chat của người bấm xóa, **nhưng vẫn hiển thị nguyên vẹn ở phía người kia**.
7. **Xóa đoạn hội thoại (Delete Conversation):**
   - Bấm *"Xóa đoạn chat"* → hiển thị xác nhận → toàn bộ lịch sử trước thời điểm xóa bị ẩn hoàn toàn ở phía người xóa và biến mất khỏi danh sách hội thoại.
   - **Phía người kia không bị ảnh hưởng.** Nếu sau này có tin nhắn mới, hội thoại xuất hiện lại và chỉ hiển thị từ tin nhắn mới đó trở đi.

---

### 3.7. Trạng thái Hoạt động & Trạng thái "Đã xem" (Quy tắc Đối xứng)

Cả hai tùy chọn nằm trong **Cài đặt > Quyền riêng tư** và tuân thủ nguyên tắc **Đối xứng (Reciprocity)** giống Instagram:
1. **Trạng thái hoạt động (Active Status):**
   - **Mặc định:** Bật.
   - **Hiển thị:** Chỉ hiển thị cho những người có kết nối hợp lệ (đang theo dõi nhau hoặc đã từng nhắn tin trong Hộp thư chính), **không** hiển thị cho người lạ, người bị chặn hoặc người ở Tin nhắn đang chờ.
   - **Mức chi tiết an toàn:** Hiển thị chấm xanh *"Đang hoạt động"* hoặc mốc thời gian làm tròn (ví dụ: *"Hoạt động 5 phút trước"*, *"Hoạt động 2 giờ trước"*), không hiển thị chính xác từng giây.
   - **Khi tắt:** Không ai thấy trạng thái hoạt động của bạn, **đồng thời bạn cũng không nhìn thấy** trạng thái hoạt động của bất kỳ ai khác.
2. **Trạng thái "Đã xem" (Read Receipts):**
   - **Mặc định:** Bật (có thể bật/tắt toàn tài khoản trong Cài đặt).
   - **Khi tắt:** Người kia không biết bạn đã đọc tin nhắn hay chưa, **đồng thời bạn cũng không nhìn thấy** trạng thái "Đã xem" ở phía người kia.

---

### 3.8. Gọi Thoại & Gọi Video 1-1 (Micro / Video Call)
- **Điều kiện gọi:** Chỉ khả dụng trong các cuộc trò chuyện thuộc **Hộp thư chính** (đã kết nối, không bị chặn, không ở trạng thái Tin nhắn đang chờ).
- **Luồng cuộc gọi:**
  1. Người gọi bấm nút **Gọi thoại** hoặc **Gọi video** trên thanh tiêu đề khung chat → mở màn hình *"Đang gọi..."* (tự hủy sau 45 giây nếu không bắt máy).
  2. Người nhận thấy hộp thoại **Cuộc gọi đến** (tên, ảnh đại diện, loại cuộc gọi) kèm nút **Trả lời** và **Từ chối**.
  3. Khi đang gọi: Hỗ trợ tắt/bật micro, tắt/bật camera (có thể nâng cấp từ thoại lên video hoặc tắt cam khi gọi video), kéo/thu nhỏ khung hình của bản thân và nút **Kết thúc cuộc gọi**.
  4. Sau khi kết thúc: Ghi nhận một thẻ sự kiện gọn gàng trong khung chat (ví dụ: *"Cuộc gọi video · 04:12"* hoặc *"Cuộc gọi nhỡ"*).
- **Trường hợp ngoại lệ:** Từ chối quyền truy cập micro/camera trên trình duyệt → hiển thị hướng dẫn thân thiện cách bật quyền; đang bận trong một cuộc gọi khác → tự động báo *"Người dùng đang bận"*.