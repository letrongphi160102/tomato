import { NextResponse } from 'next/server';

import { getMediaStorageProvider, isValidAvatarFileName } from '@/core/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LocalAvatarRouteContext {
  readonly params: Promise<{ readonly fileName: string }>;
}

/**
 * Phục vụ tệp ảnh đại diện cục bộ đã qua `sharp` re-encode thành WebP (chỉ hoạt động khi dùng LocalFsStorageAdapter).
 * Gắn header cứng chặn MIME sniffing và sandbox CSP; tên file chỉ cho phép đúng 32 ký tự hex + `.webp`.
 */
export async function GET(_request: Request, context: LocalAvatarRouteContext) {
  const storage = getMediaStorageProvider();
  if (storage.provider !== 'local' || typeof storage.readObject !== 'function') {
    return new NextResponse(null, { status: 404 });
  }

  const { fileName } = await context.params;
  if (!isValidAvatarFileName(fileName)) {
    return new NextResponse(null, { status: 404 });
  }

  const stored = await storage.readObject(`avatars/${fileName}`);
  if (!stored) {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(new Uint8Array(stored.body), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
