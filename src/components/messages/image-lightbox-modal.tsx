'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { buildSafePhotoDownloadFileName } from '@/lib/e2ee/media-cipher';

export interface ImageLightboxTarget {
  readonly src: string;
  readonly mimeType?: string;
  readonly alt?: string;
}

export interface ImageLightboxModalProps {
  readonly target: ImageLightboxTarget | null;
  readonly onClose: () => void;
}

/**
 * Hộp thoại xem ảnh HD toàn màn hình an toàn CSP (Portal `document.body`, tầng `z-50`).
 * Đặt độc lập ngoài container `z-30` của `FloatingMessagesWidget` để không bị cắt bởi `overflow-hidden`.
 */
export function ImageLightboxModal({ target, onClose }: ImageLightboxModalProps) {
  React.useEffect(() => {
    if (!target) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [target, onClose]);

  if (!target || typeof document === 'undefined') {
    return null;
  }

  function handleDownload() {
    if (!target) {
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = target.src;
    anchor.download = buildSafePhotoDownloadFileName(target.mimeType);
    anchor.rel = 'noopener noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Xem ảnh kích thước đầy đủ"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-4 backdrop-blur-xs"
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleDownload}
          className="h-9 gap-1.5 rounded-full bg-white/15 px-3.5 text-xs font-medium text-white hover:bg-white/25"
        >
          <Download className="size-4" aria-hidden="true" />
          <span>Tải ảnh xuống</span>
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Đóng xem ảnh"
          onClick={onClose}
          className="size-9 rounded-full bg-white/15 text-white hover:bg-white/25 hover:text-white"
        >
          <X className="size-5" aria-hidden="true" />
        </Button>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={target.src}
        alt={target.alt ?? 'Ảnh trong cuộc trò chuyện'}
        className="max-h-[85vh] max-w-[92vw] rounded-xl object-contain shadow-2xl select-none"
      />
    </div>,
    document.body,
  );
}
