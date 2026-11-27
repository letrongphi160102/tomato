export type NormalizedPoint = readonly [number, number];
export type NormalizedPolygon = readonly NormalizedPoint[];

export interface NormalizedRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export interface WarmLightNodeSpec {
  readonly u: number;
  readonly v: number;
  /** Bán kính quầng sáng chuẩn hóa theo chiều cao ảnh gốc (1520px). */
  readonly radiusRatio: number;
  /** Chu kỳ thở sáng riêng (giây — ưu tiên các số nguyên tố/lẻ nguyên tố cùng nhau). */
  readonly cycleSeconds: number;
  /** Cường độ cực đại (giữ dịu tự nhiên để không làm cháy chi tiết ảnh nền). */
  readonly maxAlpha: number;
  readonly tint: 'warm-gold' | 'soft-amber' | 'candle' | 'star';
}

export interface ChristmasCabinSceneConfig {
  readonly backgroundSrc: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /**
   * 4 đa giác ô kính của khung cửa sổ đôi bên phải (đã đo khớp phối cảnh 3D trên `cabin-bg.webp` 2702x1520,
   * chừa thanh đố gỗ ngang/dọc, tay nắm cửa sổ và lượn sát phía sau lưng ghế bành màu kem).
   */
  readonly windowPanePolygons: readonly NormalizedPolygon[];
  /** Vùng bao chung của 4 ô kính cửa sổ để sinh và tuần hoàn hạt tuyết ngoài trời. */
  readonly windowSnowBounds: NormalizedRect;
  /** Vòm gạch buồng đốt lò sưởi đá để cắt mặt nạ lửa, than hồng và tàn lửa. */
  readonly firebox: {
    readonly polygon: NormalizedPolygon;
    readonly flameCenterU: number;
    readonly flameSpreadHalfU: number;
    readonly flameBaseV: number;
    readonly archTopV: number;
  };
  /** Tâm quầng ánh lửa ấm hắt ra bệ đá lò sưởi, thảm dệt, hộp quà và mép ghế bành. */
  readonly roomLightCast: {
    readonly centerU: number;
    readonly centerV: number;
    readonly radiusRatio: number;
  };
  readonly lightNodes: readonly WarmLightNodeSpec[];
}

const PRIME_CYCLES = [4.7, 5.9, 7.3, 8.9, 10.7, 13.1, 16.3, 19.7, 23.3] as const;

function pickPrimeCycle(index: number): number {
  return PRIME_CYCLES[index % PRIME_CYCLES.length]!;
}

const RAW_GARLAND_WINDOW_AND_TREE_BULBS: ReadonlyArray<readonly [number, number, number]> = [
  // Hai nhịp dây đèn vàng vắt ngang diềm trên cửa sổ đôi
  [0.6335, 0.1233, 0.021],
  [0.6487, 0.1476, 0.021],
  [0.6719, 0.1592, 0.021],
  [0.701, 0.1607, 0.021],
  [0.7333, 0.1519, 0.021],
  [0.7656, 0.1287, 0.022],
  [0.7938, 0.0884, 0.022],
  [0.8116, 0.1111, 0.021],
  [0.843, 0.1206, 0.021],
  [0.8794, 0.1179, 0.021],
  [0.9149, 0.1071, 0.021],
  [0.9494, 0.0833, 0.022],
  [0.9858, 0.0615, 0.023],

  // Chuỗi đèn thả dọc cạnh trái khung cửa sổ
  [0.6297, 0.1902, 0.021],
  [0.6305, 0.2529, 0.022],
  [0.6299, 0.3206, 0.021],
  [0.6302, 0.391, 0.021],
  [0.6299, 0.466, 0.021],
  [0.6305, 0.547, 0.022],

  // Dây thông & chuỗi bóng rủ trước thanh gỗ bệ lò sưởi
  [0.0721, 0.424, 0.017],
  [0.0922, 0.423, 0.018],
  [0.1723, 0.4176, 0.02],
  [0.2174, 0.4285, 0.022],
  [0.2413, 0.4634, 0.023],
  [0.2826, 0.474, 0.023],
  [0.3074, 0.4105, 0.018],
  [0.32, 0.4526, 0.023],
  [0.3366, 0.4258, 0.019],
  [0.3602, 0.4647, 0.023],
  [0.394, 0.4713, 0.023],
  [0.42, 0.4436, 0.022],
  [0.4271, 0.428, 0.02],

  // Đèn nhỏ trên vòng nguyệt quế tường sau
  [0.4225, 0.3545, 0.013],
  [0.433, 0.3288, 0.013],
  [0.4455, 0.3695, 0.013],
  [0.4675, 0.3465, 0.013],
  [0.4715, 0.3175, 0.013],

  // Chuỗi đèn vàng ấm xoắn từ ngọn xuống chân cây thông Giáng sinh
  [0.5391, 0.3172, 0.02],
  [0.5484, 0.3274, 0.02],
  [0.5717, 0.3487, 0.02],
  [0.5752, 0.3634, 0.02],
  [0.5173, 0.4123, 0.02],
  [0.5258, 0.4235, 0.019],
  [0.5906, 0.419, 0.02],
  [0.5396, 0.4348, 0.019],
  [0.5804, 0.4368, 0.021],
  [0.5621, 0.4463, 0.02],
  [0.5025, 0.482, 0.02],
  [0.5103, 0.4857, 0.02],
  [0.6119, 0.5586, 0.021],
  [0.5787, 0.5601, 0.02],
  [0.6047, 0.5696, 0.02],
  [0.4896, 0.5776, 0.02],
  [0.5917, 0.5776, 0.02],
  [0.4941, 0.5906, 0.022],
  [0.555, 0.592, 0.02],
  [0.5322, 0.6014, 0.02],
  [0.5108, 0.6076, 0.02],
  [0.6183, 0.6274, 0.02],
  [0.625, 0.6409, 0.021],
  [0.6478, 0.6691, 0.021],
  [0.4769, 0.6976, 0.02],
  [0.4714, 0.7087, 0.02],
  [0.4974, 0.7233, 0.021],
  [0.6024, 0.7227, 0.02],
  [0.5206, 0.7335, 0.021],
  [0.5447, 0.7409, 0.02],
  [0.5946, 0.743, 0.021],
  [0.568, 0.7503, 0.021],
];

export const CHRISTMAS_CABIN_SCENE_CONFIG: ChristmasCabinSceneConfig = Object.freeze({
  backgroundSrc: '/themes/christmas/cabin-bg.webp',
  imageWidth: 2702,
  imageHeight: 1520,
  windowPanePolygons: Object.freeze([
    // 1. Ô kính trên bên trái (vát nhẹ theo phối cảnh khung cửa sổ gỗ)
    Object.freeze([
      [0.684, 0.212],
      [0.789, 0.195],
      [0.789, 0.362],
      [0.684, 0.368],
    ] as const),
    // 2. Ô kính trên bên phải
    Object.freeze([
      [0.824, 0.189],
      [0.952, 0.167],
      [0.952, 0.349],
      [0.824, 0.358],
    ] as const),
    // 3. Ô kính dưới bên trái (lượn sát phía trên vai trái của ghế bành kem)
    Object.freeze([
      [0.684, 0.386],
      [0.789, 0.381],
      [0.789, 0.542],
      [0.755, 0.544],
      [0.726, 0.548],
      [0.715, 0.57],
      [0.684, 0.568],
    ] as const),
    // 4. Ô kính dưới bên phải (lượn sát phía trên lưng và vai phải của ghế bành kem)
    Object.freeze([
      [0.824, 0.377],
      [0.951, 0.369],
      [0.951, 0.583],
      [0.912, 0.583],
      [0.905, 0.556],
      [0.886, 0.546],
      [0.852, 0.544],
      [0.824, 0.542],
    ] as const),
  ]),
  windowSnowBounds: Object.freeze({
    u0: 0.678,
    v0: 0.162,
    u1: 0.956,
    v1: 0.588,
  }),
  firebox: Object.freeze({
    // Đa giác vòm gạch buồng đốt bao quanh củi cháy (u: 0.222..0.373, v: 0.582..0.865)
    polygon: Object.freeze([
      [0.222, 0.862],
      [0.222, 0.7],
      [0.236, 0.658],
      [0.256, 0.616],
      [0.282, 0.586],
      [0.305, 0.581],
      [0.332, 0.594],
      [0.356, 0.624],
      [0.371, 0.675],
      [0.373, 0.856],
    ] as const),
    flameCenterU: 0.278,
    flameSpreadHalfU: 0.046,
    flameBaseV: 0.825,
    archTopV: 0.585,
  }),
  roomLightCast: Object.freeze({
    centerU: 0.305,
    centerV: 0.82,
    radiusRatio: 0.62,
  }),
  lightNodes: Object.freeze([
    // Đèn bão treo tường gỗ bên trái
    Object.freeze({
      u: 0.048,
      v: 0.249,
      radiusRatio: 0.082,
      cycleSeconds: 17.3,
      maxAlpha: 0.17,
      tint: 'soft-amber',
    }),
    // Ngọn nến trụ trên bệ lò sưởi
    Object.freeze({
      u: 0.204,
      v: 0.37,
      radiusRatio: 0.048,
      cycleSeconds: 5.3,
      maxAlpha: 0.19,
      tint: 'candle',
    }),
    // Ngôi sao vàng trên đỉnh cây thông
    Object.freeze({
      u: 0.551,
      v: 0.235,
      radiusRatio: 0.078,
      cycleSeconds: 13.7,
      maxAlpha: 0.19,
      tint: 'star',
    }),
    ...RAW_GARLAND_WINDOW_AND_TREE_BULBS.map(([u, v, radiusRatio], idx) =>
      Object.freeze({
        u,
        v,
        radiusRatio,
        cycleSeconds: pickPrimeCycle(idx),
        maxAlpha: 0.15,
        tint: idx % 3 === 0 ? ('soft-amber' as const) : ('warm-gold' as const),
      }),
    ),
  ]),
});
