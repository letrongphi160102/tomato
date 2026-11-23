import type { ReactNode } from 'react';

import { SettingsSidebarNav } from '@/components/settings/settings-sidebar-nav';

export default function SettingsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Cài đặt &amp; Quyền riêng tư
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quản lý thông tin tài khoản, mật khẩu và các thiết bị đã đăng nhập vào Tomato.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[248px_minmax(0,1fr)] lg:items-start">
        <aside className="lg:sticky lg:top-20">
          <SettingsSidebarNav />
        </aside>
        <section className="min-w-0">{children}</section>
      </div>
    </div>
  );
}
