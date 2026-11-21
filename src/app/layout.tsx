import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'TOMATO — Mạng xã hội',
  description: 'Nền tảng mạng xã hội TOMATO — Giai đoạn 1: Tài khoản, Xác thực & Quản lý Phiên.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="vi">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
