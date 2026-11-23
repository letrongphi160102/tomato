import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Tomato - Kết nối và khám phá cùng nhau',
  description: 'Tomato - Kết nối và khám phá cùng nhau.',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Đọc header `x-nonce` từ Next.js Proxy giúp kích hoạt dynamic rendering
  // để Next.js tự động gắn per-request CSP nonce vào toàn bộ script framework ở production.
  const requestHeaders = await headers();
  const nonce = requestHeaders.get('x-nonce') ?? undefined;

  return (
    <html lang="vi" data-csp-nonce={nonce ? 'enabled' : undefined}>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
