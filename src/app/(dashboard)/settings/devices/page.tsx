import type { Metadata } from 'next';

import { SecuritySessionsPanel } from '@/components/settings/security-sessions-panel';

export const metadata: Metadata = {
  title: 'Thiết bị đăng nhập — TOMATO',
  description: 'Xem các thiết bị đang hoạt động và lịch sử đăng nhập tài khoản TOMATO của bạn.',
};

export const dynamic = 'force-dynamic';

export default function DevicesSettingsPage() {
  return <SecuritySessionsPanel />;
}
