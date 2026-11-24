/**
 * Tính kích thước hiển thị ảnh trong bong bóng tin nhắn (thuần, dễ kiểm thử).
 * - Chế độ gọn (cửa sổ nhắn tin nhỏ): tối đa 188px chiều ngang để luôn vừa với hàng tin nhắn
 *   gồm ảnh đại diện + ảnh + cụm 3 nút thao tác (Cảm xúc · Trả lời · ⋮).
 * - Chế độ đầy đủ (/messages): tối đa 290px.
 * Kích thước chỉ là mức mong muốn; giao diện còn dùng `max-width: 100%` + `aspect-ratio`
 * để ảnh tự co lại khi hàng thiếu chỗ mà không bị méo hay cắt.
 */

export const COMPACT_IMAGE_MAX_WIDTH_PX = 188;
export const FULL_IMAGE_MAX_WIDTH_PX = 290;
export const COMPACT_IMAGE_MAX_HEIGHT_PX = 260;
export const FULL_IMAGE_MAX_HEIGHT_PX = 340;

const MIN_ASPECT_RATIO = 0.55;
const MAX_ASPECT_RATIO = 2.1;

export interface ImageDisplaySize {
  readonly widthPx: number;
  readonly heightPx: number;
}

export function computeImageDisplaySize(
  width: number | null | undefined,
  height: number | null | undefined,
  isCompact: boolean,
): ImageDisplaySize {
  const rawWidth = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 4;
  const rawHeight =
    typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : 3;

  const ratio = Math.max(MIN_ASPECT_RATIO, Math.min(MAX_ASPECT_RATIO, rawWidth / rawHeight));
  const maxWidthPx = isCompact ? COMPACT_IMAGE_MAX_WIDTH_PX : FULL_IMAGE_MAX_WIDTH_PX;
  const maxHeightPx = isCompact ? COMPACT_IMAGE_MAX_HEIGHT_PX : FULL_IMAGE_MAX_HEIGHT_PX;

  const heightPx = Math.min(maxHeightPx, Math.round(maxWidthPx / ratio));
  const widthPx = Math.min(maxWidthPx, Math.round(heightPx * ratio));

  return { widthPx, heightPx };
}
