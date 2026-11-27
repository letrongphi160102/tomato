import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import { DisplayPreferencesProvider } from '@/components/settings/display-preferences-provider';
import { UI_PREFS_COOKIE_NAME, parseUiPreferencesCookie } from '@/lib/ui-preferences';

import './globals.css';

export const metadata: Metadata = {
  title: 'Tomato - Kết nối và khám phá cùng nhau',
  description: 'Tomato - Kết nối và khám phá cùng nhau.',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Đọc đồng thời `x-nonce` (gắn CSP nonce cho script framework) và cookie tùy chọn hiển thị `tomato_ui_prefs`
  // để render thẳng trạng thái Sáng / Tối / Tự động ngay từ SSR mà không cần chèn inline <script>.
  const [requestHeaders, cookieStore] = await Promise.all([headers(), cookies()]);
  const nonce = requestHeaders.get('x-nonce') ?? undefined;
  const initialPreferences = parseUiPreferencesCookie(cookieStore.get(UI_PREFS_COOKIE_NAME)?.value);

  const initialHtmlClassName =
    initialPreferences.theme === 'dark'
      ? 'dark'
      : initialPreferences.theme === 'light'
        ? 'light'
        : undefined;

  return (
    <html
      lang="vi"
      suppressHydrationWarning
      className={initialHtmlClassName}
      data-theme={initialPreferences.theme}
      data-csp-nonce={nonce ? 'enabled' : undefined}
    >
      <body className="min-h-screen font-sans">
        <DisplayPreferencesProvider initialPreferences={initialPreferences}>
          {children}
        </DisplayPreferencesProvider>
      </body>
    </html>
  );
}
