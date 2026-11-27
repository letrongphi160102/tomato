const TAU = Math.PI * 2;
const IRRATIONAL_1 = Math.SQRT2 * 0.5;
const IRRATIONAL_2 = Math.sqrt(5) * 0.27;
const IRRATIONAL_3 = Math.PI * 0.13;
const IRRATIONAL_4 = Math.sqrt(13) * 0.071;

/**
 * Tổng hợp sóng hài có tỷ số tần số vô tỷ (incommensurable frequencies) trả về giá trị trong `[-1, 1]`.
 * Vì các thành phần tần số không có bội chung hữu tỷ, đường cong biến thiên mượt mà suốt nhiều giờ mà không lặp chu kỳ ngắn.
 */
export function sampleIrrationalWave(timeSeconds: number, seedPhase = 0): number {
  const s1 = Math.sin(timeSeconds * IRRATIONAL_1 + seedPhase);
  const s2 = Math.sin(timeSeconds * IRRATIONAL_2 + seedPhase * 1.6180339);
  const s3 = Math.sin(timeSeconds * IRRATIONAL_3 + seedPhase * 2.4142135);
  const s4 = Math.sin(timeSeconds * IRRATIONAL_4 + seedPhase * 3.3027756);
  return s1 * 0.42 + s2 * 0.28 + s3 * 0.19 + s4 * 0.11;
}

export interface WindFieldSample {
  /** Vận tốc gió ngang chuẩn hóa (`-1..1`), âm là tạt nhẹ sang trái, dương là tạt sang phải. */
  readonly gustVelocity: number;
  /** Độ xoáy cục bộ (`0..1`) tăng khi có cơn gió mùa đông thổi qua tán thông. */
  readonly turbulence: number;
}

/**
 * Mô phỏng gió tuyết ngoài cửa sổ với chu kỳ nền cực dài (47s – 263s):
 * xen kẽ tự nhiên giữa những khoảng tuyết rơi êm thẳng đứng và các đợt gió lùa xiên nhẹ.
 */
export function sampleExteriorWindField(timeSeconds: number): WindFieldSample {
  const macroArc = Math.sin((TAU * timeSeconds) / 193.0 + 0.7);
  const midArc = Math.sin(((TAU * timeSeconds) / 79.0) * Math.SQRT2 + 2.1);
  const microGust = sampleIrrationalWave(timeSeconds * 0.42, 4.3);

  const envelope = Math.max(0, macroArc * 0.55 + midArc * 0.45);
  const gustVelocity = macroArc * 0.38 + midArc * 0.34 + microGust * 0.28 * (0.4 + envelope);
  const turbulence = Math.min(
    1,
    Math.max(0.08, 0.22 + envelope * 0.58 + Math.abs(microGust) * 0.2),
  );

  return {
    gustVelocity,
    turbulence,
  };
}

/**
 * Cường độ ngọn lửa tổng thể (`0..1`) dao động tự nhiên không tuần hoàn,
 * dùng để điều khiển đồng bộ cả dải lửa trong lò lẫn ánh lửa ấm hắt ra phòng.
 */
export function sampleHearthFireIntensity(timeSeconds: number): number {
  const slowBreath = Math.sin((TAU * timeSeconds) / 17.3 + 1.1) * 0.28;
  const mediumDraft = sampleIrrationalWave(timeSeconds * 1.85, 2.7) * 0.44;
  const livelyLick = sampleIrrationalWave(timeSeconds * 4.9, 9.4) * 0.28;
  const raw = 0.52 + (slowBreath + mediumDraft + livelyLick) * 0.46;
  return Math.min(1, Math.max(0.12, raw));
}

/**
 * Độ sáng êm dịu (`0..1`) của từng bóng đèn trang trí theo chu kỳ nguyên tố riêng (`cycleSeconds`).
 */
export function sampleAsyncBulbGlow(
  timeSeconds: number,
  cycleSeconds: number,
  phaseOffset: number,
): number {
  const primary = Math.sin((TAU * timeSeconds) / cycleSeconds + phaseOffset);
  const secondary = Math.sin(
    (TAU * timeSeconds) / (cycleSeconds * Math.SQRT2) + phaseOffset * 1.6180339,
  );
  const normalized = 0.5 + (primary * 0.68 + secondary * 0.32) * 0.5;
  // Nén nhẹ vùng tối để bóng đèn ấm áp thở sáng tự nhiên chứ không bao giờ tắt hẳn đen kịt.
  return 0.38 + normalized * 0.62;
}
