'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { KeyRound, MonitorSmartphone, Pencil, User } from 'lucide-react';

import { cn } from '@/lib/utils';

const SETTINGS_NAV_ITEMS = [
  {
    href: '/settings/profile',
    label: 'Chỉnh sửa hồ sơ',
    description: 'Ảnh đại diện, tên, ID và tiểu sử',
    icon: Pencil,
  },
  {
    href: '/settings/account',
    label: 'Tổng quan tài khoản',
    description: 'Thông tin cá nhân cơ bản',
    icon: User,
  },
  {
    href: '/settings/security',
    label: 'Mật khẩu & Bảo mật',
    description: 'Đổi mật khẩu an toàn',
    icon: KeyRound,
  },
  {
    href: '/settings/devices',
    label: 'Thiết bị đăng nhập',
    description: 'Quản lý thiết bị và lịch sử',
    icon: MonitorSmartphone,
  },
] as const;

export function SettingsSidebarNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Danh mục cài đặt" className="w-full">
      <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {SETTINGS_NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <li key={item.href} className="shrink-0 lg:shrink">
              <Link
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition-colors',
                  isActive
                    ? 'border-primary/30 bg-primary/10 font-semibold text-primary'
                    : 'border-transparent bg-background text-foreground hover:bg-muted/70 lg:bg-transparent',
                )}
              >
                <Icon
                  className={cn(
                    'size-4 shrink-0',
                    isActive ? 'text-primary' : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="truncate leading-tight">{item.label}</p>
                  <p className="hidden truncate text-xs font-normal text-muted-foreground lg:mt-0.5 lg:block">
                    {item.description}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
