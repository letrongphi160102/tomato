import type { Metadata } from 'next';

import { SecuritySessionsPanel } from '@/components/settings/security-sessions-panel';

export const metadata: Metadata = {
  title: 'Bảo mật & Thiết bị — TOMATO',
  description: 'Quản lý các thiết bị và phiên đang đăng nhập vào tài khoản TOMATO của bạn.',
};

export const dynamic = 'force-dynamic';

export default function SecuritySettingsPage() {
  return <SecuritySessionsPanel />;
}
