import type { Metadata } from 'next';

import { ChangePasswordCard } from '@/components/settings/change-password-card';
import { SecuritySessionsPanel } from '@/components/settings/security-sessions-panel';

export const metadata: Metadata = {
  title: 'Mật khẩu & Bảo mật — Tomato',
  description: 'Cập nhật mật khẩu và quản lý các thiết bị đã đăng nhập tài khoản Tomato của bạn.',
};

export const dynamic = 'force-dynamic';

export default function SecuritySettingsPage() {
  return (
    <div className="space-y-8">
      <ChangePasswordCard />

      <section id="devices" aria-label="Thiết bị đăng nhập">
        <SecuritySessionsPanel />
      </section>
    </div>
  );
}
