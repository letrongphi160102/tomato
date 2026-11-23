'use client';

/* eslint-disable @next/next/no-img-element -- Xem trước ảnh đã cắt cục bộ từ object URL */

import * as React from 'react';
import Cropper, { type Area, type Point } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import { Loader2, X, ZoomIn, ZoomOut } from 'lucide-react';

import { Button } from '@/components/ui/button';

export interface AvatarCropModalProps {
  readonly open: boolean;
  readonly imageSrc: string | null;
  readonly saving: boolean;
  readonly errorMessage: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (croppedBlob: Blob) => Promise<void> | void;
}

const CROP_OUTPUT_PX = 1024;
const PREVIEW_OUTPUT_PX = 160;

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Không thể đọc ảnh đã chọn.'));
    img.src = src;
  });
}

async function renderCroppedBlob(
  imageSrc: string,
  pixelCrop: Area,
  outputSize: number,
): Promise<Blob> {
  const image = await loadImageElement(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Trình duyệt không hỗ trợ xử lý ảnh.');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    outputSize,
    outputSize,
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Không thể tạo ảnh sau khi cắt.'));
          return;
        }
        resolve(blob);
      },
      'image/jpeg',
      0.92,
    );
  });
}

interface AvatarCropDialogBodyProps {
  readonly imageSrc: string;
  readonly saving: boolean;
  readonly errorMessage: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (croppedBlob: Blob) => Promise<void> | void;
}

function AvatarCropDialogBody({
  imageSrc,
  saving,
  errorMessage,
  onClose,
  onConfirm,
}: AvatarCropDialogBodyProps) {
  const [crop, setCrop] = React.useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = React.useState<number>(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = React.useState<Area | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [saving, onClose]);

  React.useEffect(() => {
    if (!croppedAreaPixels) {
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    void renderCroppedBlob(imageSrc, croppedAreaPixels, PREVIEW_OUTPUT_PX)
      .then((blob) => {
        if (cancelled) {
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        setPreviewUrl(createdUrl);
      })
      .catch(() => {
        // Bỏ qua lỗi cập nhật ảnh xem trước tạm thời.
      });

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [imageSrc, croppedAreaPixels]);

  async function handleSave() {
    if (!croppedAreaPixels || saving) {
      return;
    }
    setLocalError(null);
    try {
      const croppedBlob = await renderCroppedBlob(imageSrc, croppedAreaPixels, CROP_OUTPUT_PX);
      await onConfirm(croppedBlob);
    } catch {
      setLocalError('Không thể xử lý ảnh này. Vui lòng thử chọn một ảnh khác.');
    }
  }

  const displayedError = errorMessage ?? localError;
  const activePreviewUrl = croppedAreaPixels ? previewUrl : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="avatar-crop-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 id="avatar-crop-title" className="text-base font-semibold text-foreground">
              Căn chỉnh ảnh đại diện
            </h2>
            <p className="text-xs text-muted-foreground">
              Kéo ảnh để căn giữa và dùng thanh trượt để phóng to hoặc thu nhỏ.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Đóng hộp thoại"
            disabled={saving}
            onClick={onClose}
            className="size-8 rounded-full"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="relative h-80 w-full bg-neutral-950 sm:h-96">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            minZoom={1}
            maxZoom={3}
            // Đã import CSS tĩnh `react-easy-crop/react-easy-crop.css` ('self'); tắt tiêm thẻ `<style>` động để tuân thủ chặt CSP `style-src-elem`.
            disableAutomaticStylesInjection
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={(_croppedArea, pixels) => setCroppedAreaPixels(pixels)}
          />
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-1 items-center gap-3">
              <ZoomOut className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="range"
                aria-label="Mức thu phóng ảnh đại diện"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                disabled={saving}
                onChange={(event) => setZoom(Number(event.target.value))}
                className="h-1.5 w-full cursor-pointer accent-primary"
              />
              <ZoomIn className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </div>

            {activePreviewUrl ? (
              <div className="flex shrink-0 items-center gap-2 border-l pl-4">
                <span className="text-xs text-muted-foreground">Xem trước</span>
                <img
                  src={activePreviewUrl}
                  alt="Xem trước ảnh đại diện"
                  className="size-11 rounded-full object-cover ring-2 ring-border"
                />
              </div>
            ) : null}
          </div>

          {displayedError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {displayedError}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              Hủy
            </Button>
            <Button
              type="button"
              disabled={saving || !croppedAreaPixels}
              onClick={() => void handleSave()}
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span>Đang lưu ảnh...</span>
                </>
              ) : (
                <span>Lưu ảnh</span>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AvatarCropModal({
  open,
  imageSrc,
  saving,
  errorMessage,
  onClose,
  onConfirm,
}: AvatarCropModalProps) {
  if (!open || !imageSrc) {
    return null;
  }

  return (
    <AvatarCropDialogBody
      key={imageSrc}
      imageSrc={imageSrc}
      saving={saving}
      errorMessage={errorMessage}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
