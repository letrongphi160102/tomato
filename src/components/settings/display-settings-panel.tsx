'use client';

import * as React from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';

import { useDisplayPreferences } from '@/components/settings/display-preferences-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { UiThemeMode } from '@/lib/ui-preferences';
import { cn } from '@/lib/utils';

interface ThemeOptionCardSpec {
  readonly mode: UiThemeMode;
  readonly label: string;
  readonly description: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
}

const THEME_OPTIONS: readonly ThemeOptionCardSpec[] = [
  {
    mode: 'light',
    label: 'Sáng',
    description: 'Nền sáng rõ nét, phù hợp khi dùng ban ngày.',
    icon: Sun,
  },
  {
    mode: 'dark',
    label: 'Tối',
    description: 'Nền tối dịu mắt, giảm chói trong không gian thiếu sáng.',
    icon: Moon,
  },
  {
    mode: 'system',
    label: 'Tự động',
    description: 'Tự chuyển Sáng hoặc Tối theo cài đặt thiết bị.',
    icon: Monitor,
  },
] as const;

function ThemeMiniPreview({ mode }: { readonly mode: UiThemeMode }) {
  if (mode === 'system') {
    return (
      <div
        aria-hidden="true"
        className="grid h-20 w-full grid-cols-2 overflow-hidden rounded-lg border border-border/80 shadow-2xs"
      >
        <div className="flex flex-col justify-between bg-[#ffffff] p-2">
          <div className="h-2 w-8 rounded-full bg-[#e5e7eb]" />
          <div className="space-y-1">
            <div className="h-2.5 w-11 rounded-md bg-[#f3f4f6]" />
            <div className="ml-auto h-2.5 w-9 rounded-md bg-[#dc2626]" />
          </div>
        </div>
        <div className="flex flex-col justify-between border-l border-white/10 bg-[#181a20] p-2">
          <div className="h-2 w-8 rounded-full bg-[#2b2f3a]" />
          <div className="space-y-1">
            <div className="h-2.5 w-11 rounded-md bg-[#262a34]" />
            <div className="ml-auto h-2.5 w-9 rounded-md bg-[#e0483d]" />
          </div>
        </div>
      </div>
    );
  }

  const isDark = mode === 'dark';
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex h-20 w-full flex-col justify-between overflow-hidden rounded-lg border p-2.5 shadow-2xs',
        isDark ? 'border-white/15 bg-[#181a20]' : 'border-black/10 bg-[#ffffff]',
      )}
    >
      <div className="flex items-center justify-between">
        <div className={cn('h-2 w-12 rounded-full', isDark ? 'bg-[#2e3340]' : 'bg-[#e5e7eb]')} />
        <div className={cn('size-3 rounded-full', isDark ? 'bg-[#e0483d]' : 'bg-[#dc2626]')} />
      </div>
      <div className="space-y-1.5">
        <div className={cn('h-2.5 w-3/5 rounded-md', isDark ? 'bg-[#262a34]' : 'bg-[#f3f4f6]')} />
        <div
          className={cn('ml-auto h-2.5 w-2/5 rounded-md', isDark ? 'bg-[#e0483d]' : 'bg-[#dc2626]')}
        />
      </div>
    </div>
  );
}

export function DisplaySettingsPanel() {
  const { preferences, resolvedTheme, setThemeMode } = useDisplayPreferences();

  const handleThemeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp'
    ) {
      return;
    }
    event.preventDefault();
    const currentIndex = THEME_OPTIONS.findIndex((opt) => opt.mode === preferences.theme);
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (currentIndex + delta + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    const nextOption = THEME_OPTIONS[nextIndex];
    if (nextOption) {
      setThemeMode(nextOption.mode);
    }
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="border-b pb-4">
        <CardTitle className="text-lg">Giao diện</CardTitle>
        <CardDescription>
          Chọn chế độ màu hiển thị cho toàn bộ Tomato trên trình duyệt này.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 pt-6">
        <div
          role="radiogroup"
          aria-label="Chế độ màu giao diện"
          onKeyDown={handleThemeKeyDown}
          className="grid grid-cols-1 gap-3.5 sm:grid-cols-3"
        >
          {THEME_OPTIONS.map((option) => {
            const isSelected = preferences.theme === option.mode;
            const Icon = option.icon;
            return (
              <button
                key={option.mode}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setThemeMode(option.mode)}
                className={cn(
                  'group relative flex flex-col rounded-2xl border p-3.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border/80 bg-card hover:border-border hover:bg-muted/40',
                )}
              >
                <ThemeMiniPreview mode={option.mode} />

                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <Icon
                      className={cn(
                        'size-4',
                        isSelected ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    <span>{option.label}</span>
                  </span>

                  <span
                    aria-hidden="true"
                    className={cn(
                      'inline-flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/35 bg-background',
                    )}
                  >
                    {isSelected ? <Check className="size-3" /> : null}
                  </span>
                </div>

                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {option.description}
                </p>
              </button>
            );
          })}
        </div>

        {preferences.theme === 'system' ? (
          <p className="text-xs text-muted-foreground">
            Đang áp dụng giao diện{' '}
            <strong className="font-semibold text-foreground">
              {resolvedTheme === 'dark' ? 'Tối' : 'Sáng'}
            </strong>{' '}
            theo cài đặt hiện tại của thiết bị.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
