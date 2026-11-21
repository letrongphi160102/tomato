'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type PasswordInputProps = Omit<React.ComponentProps<'input'>, 'type'>;

/**
 * Ô nhập mật khẩu chuẩn UX/a11y theo Mục 4.1 & Mục 5:
 * - Luôn cho phép dán (paste) để hỗ trợ trình quản lý mật khẩu (Password Manager).
 * - Có nút hiện/ẩn mật khẩu tiếp cận được bằng bàn phím (`aria-label`, `aria-pressed`).
 * - KHÔNG gắn `maxLength` để tránh trình duyệt tự ý cắt ngắn mật khẩu vượt quá 128 ký tự.
 */
export function PasswordInput({
  className,
  autoComplete = 'new-password',
  disabled,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        disabled={disabled}
        className={cn('pr-11', className)}
      />
      <button
        type="button"
        onClick={() => setVisible((prev) => !prev)}
        disabled={disabled}
        aria-label={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
