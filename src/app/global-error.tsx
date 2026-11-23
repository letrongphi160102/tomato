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
    <html lang="vi">
      <body className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 font-sans text-neutral-900">
        <main className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-neutral-900">Đã xảy ra lỗi không mong muốn</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Hệ thống đã ghi nhận sự cố kỹ thuật để khắc phục. Vui lòng thử tải lại trang.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-5 inline-flex h-10 items-center justify-center rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700"
          >
            Thử lại
          </button>
        </main>
      </body>
    </html>
  );
}
