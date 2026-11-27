export interface CoverTransform {
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly drawX: number;
  readonly drawY: number;
  readonly drawWidth: number;
  readonly drawHeight: number;
  readonly scale: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * Giới hạn giãn tỷ lệ ngang tối đa trên màn hình Laptop/Desktop rộng (khi đã trừ TopBar 56px + thanh địa chỉ trình duyệt)
 * để hiển thị trọn vẹn 100% chiều cao & chiều rộng căn phòng từ trần tới lò sưởi mà không bị phóng to cắt xén.
 */
const MAX_LANDSCAPE_ASPECT_RATIO = 2.35;
const MIN_LANDSCAPE_FIT_ASPECT_RATIO = 1.25;

export function resolveAdaptiveCabinAnchor(
  stageWidth: number,
  stageHeight: number,
): { readonly anchorX: number; readonly anchorY: number } {
  const safeH = Math.max(1, stageHeight);
  const aspect = stageWidth / safeH;

  // Trên màn hình dọc di động, căn tâm vào khoảng giữa lò sưởi (0.29) và cây thông (0.55) để thấy trọn cả hai.
  let anchorX = 0.5;
  if (aspect <= 0.75) {
    anchorX = 0.44;
  } else if (aspect < 1.25) {
    const t = (1.25 - aspect) / (1.25 - 0.75);
    anchorX = 0.5 - t * 0.06;
  }

  return {
    anchorX,
    anchorY: 0.52,
  };
}

/**
 * Phép chiếu khung cảnh dùng chung tuyệt đối cho cả thẻ `<img>` lẫn `<canvas>`:
 * - Ở màn hình ngang Laptop/Desktop (`1.25 <= aspect <= 2.35`): vừa khít 100% khung nội dung (`drawWidth = stageWidth`, `drawHeight = stageHeight`)
 *   để thấy trọn đèn tường trái, vòng nguyệt quế, lò sưởi, cây thông và cửa sổ tuyết mà không bị phóng to quá khổ.
 * - Ở màn hình siêu rộng (`> 2.35`): kẹp tỷ lệ ngang tối đa `2.35` để không méo chi tiết.
 * - Ở màn hình dọc Mobile (`< 1.25`): giữ nguyên chiều cao `stageHeight` (thấy đủ từ đỉnh sao tới ngọn lửa) và căn tâm vào lò sưởi + cây thông.
 */
export function computeCoverTransform(params: {
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly anchorX?: number;
  readonly anchorY?: number;
}): CoverTransform {
  const stageWidth = Math.max(1, params.stageWidth);
  const stageHeight = Math.max(1, params.stageHeight);
  const imageWidth = Math.max(1, params.imageWidth);
  const imageHeight = Math.max(1, params.imageHeight);

  const adaptive = resolveAdaptiveCabinAnchor(stageWidth, stageHeight);
  const anchorX = clamp01(params.anchorX ?? adaptive.anchorX);
  const anchorY = clamp01(params.anchorY ?? adaptive.anchorY);
  const stageAspect = stageWidth / stageHeight;

  if (stageAspect >= MIN_LANDSCAPE_FIT_ASPECT_RATIO && stageAspect <= MAX_LANDSCAPE_ASPECT_RATIO) {
    return {
      stageWidth,
      stageHeight,
      drawX: 0,
      drawY: 0,
      drawWidth: stageWidth,
      drawHeight: stageHeight,
      scale: stageHeight / imageHeight,
      anchorX,
      anchorY,
    };
  }

  if (stageAspect > MAX_LANDSCAPE_ASPECT_RATIO) {
    const drawWidth = stageWidth;
    const drawHeight = stageWidth / MAX_LANDSCAPE_ASPECT_RATIO;
    const drawX = 0;
    const drawY = (stageHeight - drawHeight) * anchorY;
    return {
      stageWidth,
      stageHeight,
      drawX,
      drawY,
      drawWidth,
      drawHeight,
      scale: drawHeight / imageHeight,
      anchorX,
      anchorY,
    };
  }

  const scale = Math.max(stageWidth / imageWidth, stageHeight / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const drawX = (stageWidth - drawWidth) * anchorX;
  const drawY = (stageHeight - drawHeight) * anchorY;

  return {
    stageWidth,
    stageHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
    scale,
    anchorX,
    anchorY,
  };
}

export function uvToCanvas(transform: CoverTransform, u: number, v: number): CanvasPoint {
  return {
    x: transform.drawX + u * transform.drawWidth,
    y: transform.drawY + v * transform.drawHeight,
  };
}
