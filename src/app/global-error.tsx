'use client';

import * as React from 'react';
import * as Sentry from '@sentry/nextjs';

interface GlobalErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  React.useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="vi" data-theme="system" suppressHydrationWarning>
      <body className="flex min-h-screen items-center justify-center bg-background px-4 font-sans text-foreground">
        <main className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center text-card-foreground shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">Đã xảy ra lỗi không mong muốn</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Hệ thống đã ghi nhận sự cố kỹ thuật để khắc phục. Vui lòng thử tải lại trang.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-5 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Thử lại
          </button>
        </main>
      </body>
    </html>
  );
}
