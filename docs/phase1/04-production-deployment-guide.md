# Hướng dẫn Triển khai Production 0đ Trọn Đời (TOMATO — Giai đoạn 1)

> Tài liệu này cung cấp checklist từng bước để đưa **TOMATO** chạy live trên **HTTPS** với tổng chi phí **0đ** (không dùng thẻ tín dụng, không dùng bản trial, không dùng email `.edu`), tối ưu độ trễ cho người dùng Việt Nam / Đông Nam Á (Region **Singapore**).

---

## Tổng quan Kiến trúc Hạ tầng Production (0đ)

| Dịch vụ | Gói | Khu vực khuyến nghị | Vai trò |
| :--- | :--- | :--- | :--- |
| **Neon** | Free Tier | `AWS ap-southeast-1 (Singapore)` | PostgreSQL 16 (Source of Truth) |
| **Upstash** | Free Tier | `ap-southeast-1 (Singapore)` | Redis HTTP REST (Rate Limit + Brute-Force) |
| **Cloudflare Turnstile** | Free Tier | Global Edge | Chống bot đăng ký & chống dò mật khẩu từ lần sai thứ 5 |
| **Gmail SMTP** *(hoặc Brevo)* | Free Tier | Global | Gửi OTP & Email cảnh báo bảo mật (không cần tên miền riêng) |
| **Sentry** | Developer Free | US / EU | Theo dõi lỗi 500 thực tế (đã lọc sạch cookie/token/PII) |
| **Vercel** | Hobby Free | `sin1 (Singapore)` *(ghim sẵn trong `vercel.json`)* | Hosting Next.js 16 + HTTPS tự động |

---

## Bước 1 — Tạo Cơ sở dữ liệu PostgreSQL trên Neon Free

1. Truy cập [https://console.neon.tech](https://console.neon.tech) và đăng nhập bằng tài khoản GitHub.
2. Nhấn **New Project**:
   - **Project name:** `tomato-prod`
   - **Postgres version:** `16`
   - **Region:** chọn **AWS Asia Pacific (Singapore) — `ap-southeast-1`**.
3. Sau khi project khởi tạo xong, mở mục **Connect**:
   - **Chuỗi 1 — Pooled Connection** (bật nút **Connection pooling**): sao chép lưu tạm làm `DATABASE_URL` cho Vercel Runtime (có `-pooler` trong hostname và `?sslmode=require`).
   - **Chuỗi 2 — Direct Connection** (tắt nút **Connection pooling**): sao chép lưu tạm làm `DIRECT_DATABASE_URL` chỉ dùng khi chạy Drizzle Migration ở Bước 7.

> **Lưu ý bảo mật:** Không bao giờ dán chuỗi kết nối chứa mật khẩu vào code, commit Git hay issue công khai.

---

## Bước 2 — Tạo Redis HTTP REST trên Upstash Free

1. Truy cập [https://console.upstash.com](https://console.upstash.com) và đăng nhập bằng GitHub.
2. Chọn tab **Redis** → **Create Database**:
   - **Name:** `tomato-prod-redis`
   - **Primary Region:** **Asia Pacific (Singapore) — `ap-southeast-1`**
   - **Type:** Regional (Free Tier).
3. Trong trang chi tiết database, kéo xuống mục **REST API** (mục `.env`):
   - Sao chép `UPSTASH_REDIS_REST_URL` (bắt buộc bắt đầu bằng `https://`).
   - Sao chép `UPSTASH_REDIS_REST_TOKEN`.

---

## Bước 3 — Tạo khóa Chống Bot trên Cloudflare Turnstile

1. Truy cập [https://dash.cloudflare.com](https://dash.cloudflare.com) (tạo tài khoản Cloudflare miễn phí nếu chưa có — **không cần thêm tên miền**).
2. Ở menu trái, chọn **Turnstile** → **Add widget**:
   - **Widget name:** `tomato-prod`
   - **Hostname Management:** nhấn **Add Hostnames** và thêm domain Vercel của bạn (ví dụ `tomato-app.vercel.app`; nếu chưa tạo project Vercel, có thể tạm thêm trước và cập nhật lại ngay sau Bước 6).
   - **Widget Mode:** chọn **Managed** (Khuyến nghị).
3. Nhấn **Create** và sao chép 2 khóa:
   - **Site Key** → `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
   - **Secret Key** → `TURNSTILE_SECRET_KEY`

> **Lưu ý:** `src/core/config/env.ts` sẽ tự động **chặn khởi động** nếu vô tình dùng dummy test key `1x0000...` ở `NODE_ENV=production`.

---

## Bước 4 — Cấu hình Gửi Email Production 0đ (Chọn 1 trong 2 phương án)

### Phương án A (Khuyến nghị 0đ nhanh nhất): Gmail SMTP + App Password
1. Sử dụng một tài khoản Gmail dành riêng cho dự án (ví dụ `tomato.security.demo@gmail.com`).
2. Vào [https://myaccount.google.com/security](https://myaccount.google.com/security) và **bật Xác minh 2 bước (2-Step Verification)**.
3. Truy cập trang [App Passwords](https://myaccount.google.com/apppasswords) (hoặc tìm `App passwords` trên thanh tìm kiếm của Google Account):
   - **App name:** `TOMATO Production`
   - Nhấn **Create** → Google hiển thị mật khẩu ứng dụng 16 ký tự dạng `abcd efgh ijkl mnop`.
4. Ghi lại thông tin cấu hình (xóa dấu cách trong App Password cho gọn):
   - `EMAIL_PROVIDER=gmail`
   - `EMAIL_FROM=Tomato <your-email@gmail.com>`
   - `SMTP_USER=your-email@gmail.com`
   - `SMTP_PASS=abcdefghijklmnop` *(16 ký tự App Password, KHÔNG dùng mật khẩu Gmail thật)*

### Phương án B (Thay thế): Brevo Transactional Email REST API (300 email/ngày miễn phí)
1. Đăng ký tài khoản miễn phí tại [https://app.brevo.com](https://app.brevo.com).
2. Vào **Senders, Domains & Dedicated IPs → Senders**: xác minh địa chỉ email gửi đi (có thể dùng email Gmail cá nhân nếu chưa có domain riêng).
3. Vào **SMTP & API → API Keys → Generate a new API key** (`TOMATO Production`).
4. Ghi lại thông tin cấu hình:
   - `EMAIL_PROVIDER=brevo`
   - `EMAIL_FROM=Tomato <verified-sender@gmail.com>`
   - `BREVO_API_KEY=xkeysib-...`

---

## Bước 5 — Tạo Dự án Giám sát Lỗi trên Sentry Free

1. Truy cập [https://sentry.io](https://sentry.io) và đăng nhập bằng GitHub (chọn gói **Developer Free**).
2. Nhấn **Create Project**:
   - **Platform:** chọn **Next.js**.
   - **Project name:** `tomato-web`.
3. Vào **Project Settings → Client Keys (DSN)** và sao chép **DSN** dạng `https://<key>@o<org>.ingest.<region>.sentry.io/<projectId>`:
   - Dùng cho cả `SENTRY_DSN` (Server/Edge) và `NEXT_PUBLIC_SENTRY_DSN` (Browser).
4. *(Tùy chọn — upload Source Maps lúc build)* Vào **Settings → Auth Tokens** tạo Internal Integration / Auth Token có quyền `project:releases`, lưu `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`. Nếu bỏ trống 3 biến này, build vẫn thành công sạch sẽ và không sinh source maps công khai.

> **Bảo mật đã cài sẵn:** Toàn bộ sự kiện Sentry đi qua `src/core/monitoring/sentry-scrub.ts` (`beforeSend` & `beforeBreadcrumb`) để xóa sạch cookie, header `Authorization`/`X-CSRF-Token`, URL `?token=...`, mật khẩu, OTP, email và IP. CSP `connect-src` tự động mở duy nhất đúng origin HTTPS của `NEXT_PUBLIC_SENTRY_DSN`.

---

## Bước 6 — Sinh Khóa Mật mã & Deploy lên Vercel Hobby (`sin1`)

### 6.1. Sinh 3 khóa bí mật 256-bit hoàn toàn độc lập trên máy cá nhân
Chạy lệnh sau **3 lần riêng biệt** để lấy 3 chuỗi hex 64 ký tự khác nhau (tuyệt đối không dùng chung khóa):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Gán lần lượt vào:
- `JWT_SECRET`
- `OTP_SECRET`
- `PASSWORD_PEPPER_SECRETS` theo định dạng JSON: `{"1":"<chuỗi-hex-thứ-3>"}`

### 6.2. Kết nối GitHub & cấu hình biến môi trường trên Vercel
1. Truy cập [https://vercel.com](https://vercel.com) → **Add New → Project** → Import repository GitHub của **TOMATO**.
2. Kiểm tra **Framework Preset:** `Next.js` (file `vercel.json` đã ghim sẵn `"regions": ["sin1"]`).
3. Mở mục **Environment Variables** (chọn môi trường **Production**) và nhập đầy đủ bảng sau:

```dotenv
APP_URL=https://<ten-du-an>.vercel.app
ALLOWED_ORIGINS=https://<ten-du-an>.vercel.app
LOG_LEVEL=info

DATABASE_URL=postgresql://<neon-user>:<neon-pass>@<neon-pooler-host>/neondb?sslmode=require
DB_POOL_MAX=5

REDIS_PROVIDER=upstash
UPSTASH_REDIS_REST_URL=https://<your-upstash>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-upstash-token>

JWT_SECRET=<64-hex-secret-1>
OTP_SECRET=<64-hex-secret-2>
CURRENT_PEPPER_VERSION=1
PASSWORD_PEPPER_SECRETS={"1":"<64-hex-secret-3>"}

EMAIL_PROVIDER=gmail
EMAIL_FROM=Tomato <your-email@gmail.com>
SMTP_USER=your-email@gmail.com
SMTP_PASS=<16-char-gmail-app-password>

NEXT_PUBLIC_TURNSTILE_SITE_KEY=<turnstile-site-key>
TURNSTILE_SECRET_KEY=<turnstile-secret-key>

SENTRY_DSN=https://<key>@o<org>.ingest.<region>.sentry.io/<projectId>
NEXT_PUBLIC_SENTRY_DSN=https://<key>@o<org>.ingest.<region>.sentry.io/<projectId>
```

> Nếu chọn Brevo thay cho Gmail: đặt `EMAIL_PROVIDER=brevo`, xóa `SMTP_USER`/`SMTP_PASS` và thêm `BREVO_API_KEY=<key>`.

4. Nhấn **Deploy** và chờ Vercel build xong. Ghi nhận domain thật (ví dụ `https://tomato-social.vercel.app`).
5. Nếu domain thật khác với giá trị dự đoán ban đầu:
   - Cập nhật lại `APP_URL` và `ALLOWED_ORIGINS` trên Vercel → **Redeploy**.
   - Cập nhật lại hostname thật trong **Cloudflare Turnstile → Widget Settings**.

---

## Bước 7 — Chạy Drizzle Migration lên Neon PostgreSQL

> **Nguyên tắc an toàn:** Trên Production luôn chạy `drizzle-kit migrate` (áp dụng đúng các file SQL đã được kiểm duyệt trong `src/core/db/migrations/`), **KHÔNG dùng `drizzle-kit push`**. Nên dùng chuỗi **Direct Connection** (không pooler) của Neon để tránh lỗi khóa DDL khi chạy migration.

### Cách 1: Chạy trực tiếp từ máy local (nhanh & kiểm soát tốt nhất)

Trên **PowerShell (Windows)**:
```powershell
$env:DATABASE_URL="postgresql://<neon-user>:<neon-pass>@<neon-direct-host>/neondb?sslmode=require"
npm run db:migrate
Remove-Item Env:DATABASE_URL
```

Trên **Bash / macOS / Linux**:
```bash
DATABASE_URL="postgresql://<neon-user>:<neon-pass>@<neon-direct-host>/neondb?sslmode=require" npm run db:migrate
```

### Cách 2: Tự động chạy trong bước Build trên Vercel (tùy chọn khi đã ổn định)
Nếu muốn mỗi lần Deploy tự động migrate trước khi build, đặt **Build Command** trên Vercel Settings:
```bash
npm run db:migrate && npm run build
```
*(Khi dùng Cách 2, đảm bảo `DATABASE_URL` có quyền DDL trên schema `public` của Neon.)*

### Xác minh bảng đã tạo trên Neon
Mở **Neon Console → Tables** (hoặc SQL Editor) và kiểm tra đủ 5 bảng:
`users`, `auth_identities`, `sessions`, `verification_tokens`, `audit_logs` cùng bảng lịch sử `drizzle.__drizzle_migrations`.

---

## Bước 8 — Kịch bản Smoke Test sau khi Website Live qua HTTPS

Thực hiện lần lượt 8 bước kiểm tra thực tế trên URL production (`https://<your-domain>.vercel.app`):

### 1. Kiểm tra Health Check & Security Headers
```bash
curl -i https://<your-domain>.vercel.app/api/health
```
- [ ] HTTP `200 OK`, body JSON: `{"status":"ok","checks":{"database":"up","redis":"up"},...}`.
- [ ] Không lộ connection string, tên database hay stack trace.
- [ ] Kiểm tra header trang chủ (`curl -I https://<your-domain>.vercel.app/login`):
  - Có `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - Có `Content-Security-Policy` chứa `'nonce-...'`, KHÔNG chứa `'unsafe-eval'`
  - Có `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`
  - KHÔNG có header `X-Powered-By`.

### 2. Kiểm tra Đăng ký & Nhận OTP trên Email thật
- [ ] Mở `https://<your-domain>.vercel.app/register`.
- [ ] Điền đầy đủ Họ tên, ID tài khoản, Email thật của bạn, Ngày sinh (>= 13 tuổi), Giới tính, Mật khẩu 12–128 ký tự (không dấu tiếng Việt), tick Điều khoản, hoàn thành widget **Cloudflare Turnstile** → bấm **Đăng ký**.
- [ ] Kiểm tra hộp thư thật nhận được email `[TOMATO] Mã xác minh email của bạn` trong vòng vài giây.
- [ ] Nhập mã OTP 6 số tại `/verify-email` → xác minh thành công.

### 3. Kiểm tra Đăng nhập & Cookie `__Host-` trên HTTPS
- [ ] Mở `/login` và đăng nhập bằng tài khoản vừa kích hoạt.
- [ ] Mở **DevTools → Application → Cookies**:
  - Xác nhận tồn tại đủ 3 cookie có tiền tố `__Host-`:
    - `__Host-tomato_at` (`HttpOnly ✓`, `Secure ✓`, `SameSite=Lax`, `Path=/`)
    - `__Host-tomato_rt` (`HttpOnly ✓`, `Secure ✓`, `SameSite=Lax`, `Path=/`)
    - `__Host-tomato_csrf` (`HttpOnly ✗`, `Secure ✓`, `SameSite=Lax`, `Path=/`)
  - Xác nhận `localStorage` và `sessionStorage` KHÔNG chứa bất kỳ token nào.

### 4. Kiểm tra Quản lý Thiết bị & Auto-Refresh
- [ ] Tại `/settings/security`, xác nhận hiển thị đúng thiết bị hiện tại kèm nhãn *"Thiết bị hiện tại"*, tên trình duyệt/HĐH và IP thật.
- [ ] Đăng nhập thêm trên cửa sổ Ẩn danh (Incognito) hoặc điện thoại → thấy 2 thiết bị trong danh sách → bấm thu hồi thiết bị thứ 2 → thiết bị thứ 2 bị đăng xuất lập tức khi tải lại trang.

### 5. Kiểm tra Chống Brute-Force thông minh (Backoff & Turnstile)
- [ ] Mở một trình duyệt / mạng khác (4G điện thoại) và nhập sai mật khẩu 3 lần liên tiếp trên `/login`:
  - Lần thử lại ngay lập tức sau lần sai 3 bị chặn `429` chờ `1s`, sau lần sai 4 chờ `2s`.
  - Ở lần sai thứ 5: màn hình `/login` **tự động hiện widget Cloudflare Turnstile** (kiểm tra Network tab thấy `"requireCaptcha": true`).
- [ ] Trong khi đó, từ trình duyệt/mạng chính (IP khác), đăng nhập với đúng mật khẩu → vào thẳng **không bị chậm, không bị hỏi Turnstile**.

### 6. Kiểm tra Quên mật khẩu & Đổi mật khẩu
- [ ] Bấm **Quên mật khẩu**, nhập email thật → nhận email chứa liên kết `/reset-password?token=...`.
- [ ] Mở liên kết, kiểm tra tab Network thấy response của `/reset-password` có `Referrer-Policy: no-referrer` và `Cache-Control: no-store, max-age=0`.
- [ ] Đặt lại mật khẩu mới → kiểm tra nhận email cảnh báo *"Mật khẩu của bạn vừa được đặt lại"* và mọi phiên cũ bị đăng xuất.
- [ ] Đăng nhập lại, vào `/settings/security` → thử **Đổi mật khẩu** (nhận OTP 6 số, nhập mật khẩu cũ + mật khẩu mới + OTP) → thành công, nhận email thông báo thay đổi mật khẩu.

### 7. Kiểm tra Chống CSRF trên Production
- [ ] Từ Console hoặc `curl` gọi `POST /api/v1/auth/logout` với `Origin: https://evil.example` (hoặc thiếu `X-CSRF-Token`) → xác nhận trả về `403 CSRF_VALIDATION_FAILED`.

### 8. Kiểm tra Sentry Dashboard & Log
- [ ] Mở **Vercel Logs**: xác nhận log JSON của Pino KHÔNG chứa mật khẩu, OTP, JWT, Refresh Token hay Cookie.
- [ ] Mở **Sentry Dashboard** (nếu đã cấu hình DSN): xác nhận không có lỗi phát sinh ở luồng bình thường, và bất kỳ sự kiện test nào đều không có trường `cookies`, `Authorization`, `email` hay `password`.
