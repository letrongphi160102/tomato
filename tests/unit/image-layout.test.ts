import { describe, expect, it } from 'vitest';

import {
  COMPACT_IMAGE_MAX_HEIGHT_PX,
  COMPACT_IMAGE_MAX_WIDTH_PX,
  computeImageDisplaySize,
  FULL_IMAGE_MAX_HEIGHT_PX,
  FULL_IMAGE_MAX_WIDTH_PX,
} from '@/components/messages/image-layout';

// Hàng tin nhắn gọn: ảnh đại diện 24 + khe 6 + ảnh + khe 6 + cụm 3 nút 76 phải vừa với ~304px.
const COMPACT_ROW_BUDGET_PX = 304;
const COMPACT_ROW_FIXED_PX = 24 + 6 + 6 + 76;

describe('Unit: kích thước ảnh trong bong bóng tin nhắn', () => {
  it('chế độ gọn: ảnh rất rộng/vuông/cao không bao giờ vượt giới hạn và luôn chừa chỗ cho cụm nút', () => {
    const cases: Array<[number, number]> = [
      [4000, 1000],
      [3000, 3000],
      [1000, 4000],
      [1920, 1080],
      [1080, 1920],
    ];
    for (const [w, h] of cases) {
      const size = computeImageDisplaySize(w, h, true);
      expect(size.widthPx).toBeLessThanOrEqual(COMPACT_IMAGE_MAX_WIDTH_PX);
      expect(size.heightPx).toBeLessThanOrEqual(COMPACT_IMAGE_MAX_HEIGHT_PX);
      expect(size.widthPx + COMPACT_ROW_FIXED_PX).toBeLessThanOrEqual(COMPACT_ROW_BUDGET_PX);
    }
  });

  it('chế độ đầy đủ: giữ giới hạn 290x340 và bảo toàn tỉ lệ trong khoảng cho phép', () => {
    const wide = computeImageDisplaySize(4000, 1000, false);
    expect(wide.widthPx).toBeLessThanOrEqual(FULL_IMAGE_MAX_WIDTH_PX);
    expect(wide.heightPx).toBeLessThanOrEqual(FULL_IMAGE_MAX_HEIGHT_PX);

    const landscape = computeImageDisplaySize(1600, 800, false);
    expect(landscape.widthPx).toBe(FULL_IMAGE_MAX_WIDTH_PX);
    expect(Math.abs(landscape.widthPx / landscape.heightPx - 2)).toBeLessThan(0.05);
  });

  it('thiếu hoặc sai siêu dữ liệu: dùng tỉ lệ mặc định 4:3, không sinh NaN/0', () => {
    for (const [w, h] of [
      [undefined, undefined],
      [null, null],
      [0, 0],
      [-5, Number.NaN],
    ] as Array<[number | null | undefined, number | null | undefined]>) {
      const size = computeImageDisplaySize(w, h, true);
      expect(Number.isFinite(size.widthPx) && size.widthPx > 0).toBe(true);
      expect(Number.isFinite(size.heightPx) && size.heightPx > 0).toBe(true);
      expect(size.widthPx).toBeLessThanOrEqual(COMPACT_IMAGE_MAX_WIDTH_PX);
    }
  });
});
