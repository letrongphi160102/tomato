# ĐẶC TẢ TÍNH NĂNG (FUNCTIONAL SPECIFICATION)

- **Dự án:** TOMATO — Mạng xã hội
- **Giai đoạn:** 1 — Tài khoản, Xác thực & Quản lý Phiên (Authentication & Session Management)
- **Phiên bản:** 1.0

---

## 1. Tổng quan & Mục tiêu
Tomato là nền tảng mạng xã hội khởi đầu trên phiên bản Website và định hướng mở rộng sang ứng dụng di động (Mobile App) trong tương lai. Mục tiêu của Giai đoạn 1 là xây dựng hệ thống quản lý danh tính người dùng an toàn, trải nghiệm mượt mà, sẵn sàng phục vụ 1.000 người dùng đầu tiên và có nền tảng mở rộng lên hàng triệu người dùng.

---

## 2. Phạm vi dự án (Scope)

### 2.1. Trong phạm vi Giai đoạn 1 (In-Scope — Ưu tiên P0)
- Đăng ký tài khoản bằng Email + Mật khẩu và xác minh Email bằng mã OTP 6 số.
- Đăng nhập, duy trì phiên đăng nhập an toàn và tự động gia hạn phiên.
- Quản lý danh sách thiết bị đang đăng nhập, đăng xuất từng thiết bị và đăng xuất mọi thiết bị.
- Quên mật khẩu & Đặt lại mật khẩu qua link xác thực một lần.
- Đổi mật khẩu khi đang đăng nhập (kèm xác thực bổ sung qua Email).
- Chống tấn công dò mật khẩu, spam đăng ký và lạm dụng tài khoản.

### 2.2. Nâng cấp giai đoạn sau (P1 — Chuẩn bị sẵn nền tảng, chưa làm ở bản 1.0)
- Đa ngôn ngữ (i18n: Tiếng Việt / Tiếng Anh) — bản 1.0 mặc định Tiếng Việt nhưng tách riêng bộ từ điển chuỗi thông báo.
- Chặn mật khẩu từng bị rò rỉ qua API Have I Been Pwned (k-anonymity).
- Chặn danh sách tên miền email rác (disposable email).
- Chấm điểm rủi ro đăng nhập nâng cao (Risk Scoring).

### 2.3. Ngoài phạm vi Giai đoạn 1 (Out-of-Scope)
- Đăng nhập mạng xã hội (Google, Facebook, Apple OAuth).
- Đăng ký bằng số điện thoại, xác thực 2 bước (MFA/TOTP), Passkeys.
- Đổi địa chỉ email tài khoản.
- Trang cá nhân công khai, bảng tin (Newsfeed), bài viết, bình luận, nhắn tin (Chat).

---

## 3. Vòng đời trạng thái tài khoản (Account Lifecycle)
Mỗi tài khoản tại một thời điểm chỉ thuộc 1 trong 5 trạng thái sau:
1. `pending_verification`: Đã tạo tài khoản nhưng chưa xác minh email. Không được truy cập vào các trang dành cho thành viên sau đăng nhập.
2. `active`: Tài khoản đã xác minh, hoạt động bình thường.
3. `locked`: Bị hệ thống tạm khóa tự động do phát hiện tấn công dò mật khẩu vượt ngưỡng an toàn. Chỉ mở khóa lại thông qua luồng đặt lại mật khẩu / xác thực qua email.
4. `suspended`: Bị quản trị viên đình chỉ do vi phạm chính sách.
5. `deleted`: Đã xóa mềm (soft delete), không thể đăng nhập.

---

## 4. Đặc tả chi tiết các tính năng

### 4.1. Đăng ký tài khoản & Xác minh Email
**Mục đích:** Cho phép người dùng mới tạo tài khoản Tomato và chứng minh quyền sở hữu email.

- **Dữ liệu đầu vào (Input):**
  - `email`: Bắt buộc, định dạng email hợp lệ, tối đa 254 ký tự. Tự động chuẩn hóa (xóa khoảng trắng đầu cuối, chuẩn hóa Unicode NFKC, chuyển chữ thường).
  - `password`: Bắt buộc, độ dài từ **12 đến 128 ký tự**. Cho phép mọi ký tự Unicode và khoảng trắng (chuẩn hóa NFKC). Không bắt buộc quy tắc cũ (chữ hoa/số/ký tự đặc biệt), nhưng **cấm** trùng với email, trùng tên hiển thị hoặc nằm trong danh sách mật khẩu cực kỳ phổ biến. Không tự ý cắt ngắn chuỗi quá 128 ký tự mà phải báo lỗi rõ ràng.
  - `displayName`: Bắt buộc, 2–50 ký tự.
  - `dateOfBirth`: Bắt buộc, định dạng ngày hợp lệ; người dùng phải đủ **từ 13 tuổi trở lên** tính đến ngày đăng ký.
  - `acceptedTerms`: Bắt buộc `true` (đồng ý Điều khoản sử dụng & Chính sách quyền riêng tư).
  - `captchaToken`: Token xác thực từ Cloudflare Turnstile.

- **Luồng chính (Happy Path):**
  1. Người dùng điền biểu mẫu, vượt qua Cloudflare Turnstile và bấm "Đăng ký".
  2. Hệ thống kiểm tra hợp lệ phía máy chủ, tạo tài khoản với trạng thái `pending_verification`.
  3. Hệ thống sinh mã OTP 6 chữ số ngẫu nhiên (hiệu lực **15 phút**), gửi tới email người dùng và chuyển người dùng tới màn hình nhập mã OTP.
  4. Người dùng nhập đúng mã OTP trong thời hạn, trạng thái tài khoản chuyển sang `active`, mã OTP bị vô hiệu hóa ngay lập tức.
  5. Hệ thống thông báo xác minh thành công và điều hướng sang trang Đăng nhập (hoặc tự động cấp phiên đăng nhập mới).

- **Các trường hợp ngoại lệ (Edge Cases):**
  - **Email đã tồn tại (đã `active`, `locked` hoặc `suspended`):** Trả về lỗi rõ ràng (`409 Conflict`) thông báo email đã được đăng ký và điều hướng người dùng sang trang Đăng nhập (tương tự trải nghiệm UX của Facebook; vẫn áp dụng Rate Limit & Cloudflare Turnstile để chống lạm dụng quét hàng loạt).
  - **Email đã tồn tại nhưng đang ở trạng thái `pending_verification`:** Cho phép gửi lại mã OTP mới và vô hiệu hóa mã OTP cũ (nếu còn trong hạn 24 giờ, không ghi đè mật khẩu).
  - **Nhập sai OTP:** Tối đa **5 lần thử** cho mỗi mã OTP. Quá 5 lần, mã OTP hiện tại bị hủy ngay lập tức, người dùng phải yêu cầu gửi mã mới.
  - **Gửi lại mã OTP (Resend):** Bắt buộc chờ tối thiểu **60 giây** giữa 2 lần yêu cầu và giới hạn tối đa 5 lần/giờ.
  - **Đăng ký trùng đồng thời (Race Condition):** Hai request cùng đăng ký 1 email trong cùng 1 mili-giây sẽ được tầng Database bắt lỗi `UNIQUE constraint` và xử lý êm đẹp, không trả lỗi 500.
  - **Tài khoản `pending_verification` quá hạn:** Không xác minh sau 24–72 giờ sẽ bị dọn dẹp (hoặc cho phép đăng ký đè sau khi hết hạn).

- **Tiêu chí hoàn thành (Acceptance Criteria):**
  - Không thể đăng ký nếu dưới 13 tuổi, mật khẩu ngắn hơn 12 ký tự hoặc thiếu tick đồng ý điều khoản.
  - Ô nhập mật khẩu cho phép dán (paste), có nút hiện/ẩn mật khẩu và gán đúng thuộc tính `autocomplete="new-password"`.

---

### 4.2. Đăng nhập & Duy trì Phiên
**Mục đích:** Xác thực người dùng và cấp quyền truy cập an toàn trên từng thiết bị.

- **Dữ liệu đầu vào:** `email`, `password`, và `captchaToken` (chỉ bắt buộc hiển thị và kiểm tra khi vượt ngưỡng lần nhập sai hoặc có dấu hiệu bất thường).
- **Luồng chính:**
  1. Hệ thống kiểm tra Rate Limit trước khi xử lý mật khẩu.
  2. Tìm danh tính theo email đã chuẩn hóa và đối chiếu mật khẩu.
  3. Nếu hợp lệ và trạng thái là `active`: tạo 1 bản ghi phiên mới gắn với thiết bị hiện tại (trình duyệt, hệ điều hành, địa chỉ IP), cấp cặp Access Token (15 phút) + Refresh Token (30 ngày) và chuyển người dùng vào trang chủ tài khoản.
- **Các trường hợp ngoại lệ:**
  - **Sai email hoặc sai mật khẩu:** Luôn trả về một thông báo duy nhất: *"Email hoặc mật khẩu không chính xác"*. Thời gian phản hồi phải tương đương nhau dù email có tồn tại hay không.
  - **Tài khoản `pending_verification`:** Thông báo cần xác minh email và cung cấp nút gửi lại mã OTP.
  - **Tài khoản `locked`:** Thông báo tài khoản đang tạm khóa để bảo vệ an toàn, hướng dẫn người dùng sử dụng tính năng "Quên mật khẩu" để mở khóa qua email.
  - **Nhập sai liên tiếp:**
    - Từ lần sai thứ 3 trở đi trên cùng cặp `(tài khoản + IP)`: áp dụng thời gian chờ tăng dần (exponential backoff).
    - Từ lần sai thứ 5 trở đi: bắt buộc xác thực Cloudflare Turnstile.
    - Đạt ngưỡng 50 lần sai liên tiếp trên một tài khoản (dù từ nhiều IP): chuyển trạng thái sang `locked`, gửi email cảnh báo kèm thời gian/IP cho chủ tài khoản.
    - **Chống DoS tài khoản:** Nếu kẻ tấn công dùng IP lạ làm sai nhiều lần (chưa chạm ngưỡng 50), chủ tài khoản đăng nhập từ thiết bị/IP quen vẫn không bị làm chậm oan.

---

### 4.3. Quản lý Phiên & Thiết bị (Session & Device Management)
**Mục đích:** Giúp người dùng kiểm soát nơi tài khoản đang đăng nhập và thu hồi quyền truy cập ngay khi nghi ngờ bị lộ.

- **Hiển thị danh sách thiết bị:** Tại trang *Cài đặt > Bảo mật & Thiết bị*, hiển thị tất cả các phiên đang hoạt động của chính người dùng gồm:
  - Tên thiết bị / Trình duyệt & Hệ điều hành (ví dụ: *Chrome trên Windows*).
  - Địa chỉ IP (và khu vực gần đúng nếu có).
  - Thời điểm đăng nhập và thời điểm hoạt động gần nhất.
  - Nhãn đánh dấu *"Thiết bị hiện tại"*.
- **Hành động:**
  1. **Đăng xuất thiết bị hiện tại:** Hủy phiên hiện tại ở phía máy chủ và xóa cookie trên trình duyệt.
  2. **Thu hồi một thiết bị cụ thể:** Hủy phiên đó phía máy chủ; thiết bị bị thu hồi sẽ không thể làm mới (refresh) phiên được nữa.
  3. **Đăng xuất khỏi tất cả thiết bị khác (hoặc tất cả thiết bị):** Hủy đồng loạt các phiên liên quan trong cơ sở dữ liệu ngay lập tức.
- **Ràng buộc bảo mật:** Người dùng A tuyệt đối không thể xem hoặc thu hồi phiên của Người dùng B. Nếu cố tình gửi ID phiên của người khác, hệ thống trả về `404 Not Found`.

---

### 4.4. Quên mật khẩu & Đặt lại mật khẩu (Forgot & Reset Password)
**Mục đích:** Khôi phục quyền truy cập an toàn khi người dùng quên mật khẩu hoặc mở khóa tài khoản bị `locked`.

- **Luồng yêu cầu (Forgot Password):**
  1. Người dùng nhập email (kèm CAPTCHA nếu phát hiện gửi nhiều lần và áp dụng Rate Limit chống quét hàng loạt).
  2. Nếu email **không tồn tại** trong hệ thống (hoặc tài khoản đã bị xóa): trả thông báo rõ ràng rằng không tìm thấy tài khoản gắn với email này (tương tự trải nghiệm UX của Facebook).
  3. Nếu email **tồn tại** (`active` hoặc `locked`): tiếp tục xử lý sinh 1 token ngẫu nhiên dùng một lần (hiệu lực **15 phút**), vô hiệu hóa mọi token đặt lại mật khẩu trước đó, gửi link đặt lại mật khẩu qua email và thông báo đã gửi liên kết khôi phục.
- **Luồng đặt lại (Reset Password):**
  1. Người dùng mở link, nhập mật khẩu mới (tuân thủ quy tắc 12–128 ký tự).
  2. Hệ thống xác thực token hợp lệ, chưa dùng và chưa hết hạn, cập nhật mật khẩu mới, mở khóa tài khoản nếu đang ở trạng thái `locked`, đánh dấu token đã sử dụng.
  3. **Bắt buộc:** Hủy **toàn bộ phiên đăng nhập cũ** trên mọi thiết bị, yêu cầu đăng nhập lại và gửi email thông báo *"Mật khẩu của bạn vừa được thay đổi"* (kèm thời gian, IP, thiết bị).
- **Ràng buộc:** Tuyệt đối không sử dụng câu hỏi bảo mật.

---

### 4.5. Đổi mật khẩu (khi đã đăng nhập)
**Mục đích:** Cho phép người dùng chủ động cập nhật mật khẩu định kỳ hoặc khi nghi ngờ lộ mật khẩu.

- **Luồng chính:**
  1. Người dùng đang đăng nhập chọn "Đổi mật khẩu", bấm gửi mã OTP xác nhận về email tài khoản (hiệu lực 10 phút).
  2. Người dùng nhập: `currentPassword` (mật khẩu hiện tại), `newPassword` (mật khẩu mới), `otpCode`.
  3. Hệ thống kiểm tra đúng mật khẩu hiện tại, đúng OTP, và `newPassword` **không được trùng** `currentPassword`.
  4. Cập nhật mật khẩu mới, hủy **tất cả các phiên ở thiết bị khác**, cấp lại phiên mới (xoay vòng phiên) cho thiết bị hiện tại (chống session fixation) và gửi email thông báo thay đổi mật khẩu.

---

## 5. Yêu cầu Giao diện (UX) & Thông báo lỗi
- Mọi màn hình Auth phải có đủ 4 trạng thái rõ ràng: **Mặc định (Idle)**, **Đang xử lý (Loading — khóa nút bấm chống double-submit)**, **Thành công (Success)** và **Lỗi (Error / Rate Limited — hiển thị thời gian cần chờ nếu bị giới hạn tốc độ)**.
- Hỗ trợ điều hướng bằng bàn phím (`Tab`, `Enter`), gắn đầy đủ `<label>` cho input, thông báo lỗi sử dụng `role="alert"` / `aria-live="polite"` để thân thiện với trình đọc màn hình.
- Cấu trúc JSON phản hồi lỗi thống nhất toàn hệ thống:

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Email hoặc mật khẩu không chính xác.",
    "details": []
  }
}
```