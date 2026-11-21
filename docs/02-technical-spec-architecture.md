# ĐẶC TẢ KỸ THUẬT — PHẦN 1: KIẾN TRÚC, CÔNG NGHỆ & CẤU TRÚC DỰ ÁN

- **Dự án:** TOMATO — Mạng xã hội
- **Giai đoạn:** 1 — Hệ thống Xác thực & Quản lý Phiên
- **Ràng buộc hạ tầng:** Ngân sách 0đ trọn đời (Free Tier, không dùng thẻ tín dụng/trial/email `.edu`)
- **Phiên bản:** 1.0
- **Tài liệu liên quan:** Xem tiếp Phần 2 tại `docs/03-design-security-roadmap.md` (Mục 4 đến Mục 9).

---

## 1. Kiến trúc tổng thể & Chiến lược mở rộng (Scalability)

### 1.1. Kiến trúc Modular Monolith (Web-First, Mobile-Ready)
Ở quy mô khởi điểm 1.000 người dùng, hệ thống áp dụng mô hình **Modular Monolith** trong một repository duy nhất để tối ưu tốc độ phát triển và vận hành với chi phí 0đ, nhưng tuân thủ 4 nguyên tắc thiết kế để mở rộng lên hàng triệu người dùng và tích hợp Mobile App sau này:

1. **Tách biệt Tầng nghiệp vụ (Domain/Service) khỏi Tầng giao tiếp (HTTP/Next.js):** Toàn bộ logic Auth nằm trong `src/modules/auth/`. Route Handlers chỉ làm nhiệm vụ đọc HTTP Request, validate bằng Zod, gọi Service và trả HTTP Response.
2. **REST API chuẩn hóa (`/api/v1/auth/*`):** Không phụ thuộc vào Next.js Server Actions cho các luồng Auth lõi. Mọi endpoint đều hỗ trợ chuẩn REST JSON. Web Client dùng `HttpOnly Cookie`; sau này khi build Mobile App (Flutter/React Native), chỉ cần mở thêm chế độ nhận/trả token qua Header (`Authorization: Bearer`) và Request Body mà không phải viết lại nghiệp vụ.
3. **Stateless Application Server:** Không lưu phiên hay bộ đếm trong RAM của máy chủ ứng dụng. Toàn bộ dữ liệu bền vững lưu tại PostgreSQL; trạng thái tạm/bộ đếm lưu tại Redis. Nhờ đó dễ dàng nhân bản ngang (horizontal scaling) lên hàng trăm instance.
4. **Trừu tượng hóa dịch vụ ngoài (Port & Adapter):** Gửi email (`EmailProvider`), kiểm tra CAPTCHA (`CaptchaProvider`), lưu khóa Pepper (`SecretProvider`) được định nghĩa qua interface. Khi dự án lớn lên, có thể thay Gmail SMTP bằng AWS SES + SQS Queue hoặc thay Env Var bằng AWS KMS mà không sửa logic Auth.

---

## 2. Công nghệ & Hạ tầng triển khai (0đ trọn đời)

| Lớp | Công nghệ | Gói miễn phí & Lưu ý kỹ thuật |
| :--- | :--- | :--- |
| **Runtime & Framework** | Next.js 15+ (App Router), React 19, TypeScript (`strict: true`) | Deploy trên **Vercel Hobby** (Region `sin1` — Singapore). Các route xử lý mật khẩu **bắt buộc dùng Node.js Runtime** (`export const runtime = 'nodejs'`), không dùng Edge Runtime. |
| **Styling & UI** | Tailwind CSS, shadcn/ui (Radix Primitives), Lucide Icons | Tối ưu Core Web Vitals, tránh JS dư thừa. |
| **Validation** | Zod | Kiểm tra 100% đầu vào API, Form và biến môi trường lúc khởi động (Fail-fast). |
| **Database & ORM** | PostgreSQL (**Neon Free**) + **Drizzle ORM** + `drizzle-kit` | Dùng connection pooling của Neon. Luôn dùng truy vấn tham số hóa. |
| **Cache & Rate Limit** | Redis (**Upstash Free**) + `@upstash/redis` + `@upstash/ratelimit` | Giao tiếp qua REST HTTP, không bị cạn kết nối TCP trên Serverless. **Redis chỉ là bộ đếm/cache; PostgreSQL luôn là nguồn dữ liệu gốc (Source of Truth).** |
| **Mật mã học** | `@node-rs/argon2`, `jose` (JWT), Node `crypto` | Bắt buộc khai báo `serverExternalPackages: ['@node-rs/argon2']` trong `next.config.ts` để bundler không đóng gói nhầm file nhị phân native. |
| **Email** | Local: **Mailpit** (Docker) <br> Prod: **Gmail SMTP (App Password)** via `nodemailer` hoặc **Brevo REST API** | Gửi miễn phí tới mọi email người test mà không cần mua tên miền riêng. Sẵn sàng đổi sang Resend/SES khi có domain (SPF/DKIM/DMARC). |
| **Chống Bot** | **Cloudflare Turnstile** | Verify token phía server tại `https://challenges.cloudflare.com/turnstile/v0/siteverify`. |
| **Logging & Monitoring** | **Pino** (Structured JSON log) + **Sentry Free** | Bật `redact` trong Pino cho mọi trường `password`, `token`, `otp`, `cookie`, `authorization`. |
| **Testing & CI** | **Vitest** (Unit + Integration), **GitHub Actions**, **Docker Compose** | Chạy tự động: `lint`, `typecheck`, `test`, `npm audit`, quét secret (`gitleaks`). |

---

## 3. Cấu trúc thư mục dự án (Modular Monolith)

```text
tomato/
├── docs/
│   ├── 01-functional-spec.md
│   ├── 02-technical-spec-architecture.md
│   └── 03-design-security-roadmap.md
├── docker-compose.yml            # PostgreSQL 16, Redis 7, Mailpit (chạy local)
├── .env.example                  # Mẫu biến môi trường (tuyệt đối không chứa secret thật)
├── src/
│   ├── app/
│   │   ├── (auth)/               # Giao diện Login, Register, Verify, Forgot, Reset
│   │   ├── (dashboard)/settings/security/  # Trang quản lý thiết bị & đổi mật khẩu
│   │   └── api/
│   │       ├── health/route.ts   # Endpoint kiểm tra sức khỏe hệ thống
│   │       └── v1/auth/...       # REST API endpoints cho Auth
│   ├── core/
│   │   ├── config/env.ts         # Validate biến môi trường bằng Zod (fail-fast)
│   │   ├── db/                   # Kết nối Neon/PG, Drizzle schema & migrations
│   │   ├── redis/                # Kết nối Upstash / Local Redis & Rate Limiter
│   │   ├── crypto/               # Argon2id+Pepper, HMAC, SHA-256, JWT (jose)
│   │   ├── security/             # CSRF guard, Policy/Authorization layer, Headers
│   │   ├── email/                # EmailProvider interface + SMTP/Brevo adapters + Templates
│   │   └── logger/               # Pino logger với cấu hình redact dữ liệu nhạy cảm
│   └── modules/
│       └── auth/                 # Nghiệp vụ Auth tách biệt hoàn toàn khỏi Next.js
│           ├── auth.schemas.ts   # Zod DTOs
│           ├── auth.repository.ts
│           ├── auth.service.ts
│           ├── session.service.ts
│           └── auth.policy.ts    # Kiểm tra quyền sở hữu tài nguyên (chống IDOR)
└── tests/
    ├── unit/                     # Test crypto, validation, chuẩn hóa email, rate limit
    ├── integration/              # Test luồng API đầy đủ với DB & Redis thật (Docker)
    └── security/                 # Test chống dò email, reuse token, IDOR, CSRF, race condition
```