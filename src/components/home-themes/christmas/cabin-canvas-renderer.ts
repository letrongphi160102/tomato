import { uvToCanvas, type CoverTransform } from '@/components/home-themes/cover-geometry';
import {
  sampleAsyncBulbGlow,
  sampleExteriorWindField,
  sampleHearthFireIntensity,
  sampleIrrationalWave,
} from '@/components/home-themes/christmas/noise';
import type {
  ChristmasCabinSceneConfig,
  WarmLightNodeSpec,
} from '@/components/home-themes/christmas/scene-config';

interface SnowParticle {
  u: number;
  v: number;
  readonly layer: 0 | 1 | 2;
  readonly radiusRatio: number;
  readonly fallSpeedV: number;
  readonly windCoupling: number;
  readonly flutterFreq: number;
  readonly flutterPhase: number;
  readonly baseAlpha: number;
}

interface EmberParticle {
  active: boolean;
  u: number;
  v: number;
  vu: number;
  vv: number;
  age: number;
  maxAge: number;
  radiusRatio: number;
  seed: number;
}

const SNOW_PARTICLE_COUNT = 128;
const MAX_EMBERS = 16;
const FLAME_TONGUE_NORMS = [-0.95, -0.62, -0.3, 0.0, 0.31, 0.63, 0.94] as const;

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function resolveTintRgb(tint: WarmLightNodeSpec['tint']): string {
  switch (tint) {
    case 'star':
      return '255, 232, 168';
    case 'candle':
      return '255, 194, 102';
    case 'soft-amber':
      return '255, 184, 96';
    case 'warm-gold':
    default:
      return '255, 214, 136';
  }
}

export class ChristmasCabinCanvasRenderer {
  private readonly config: ChristmasCabinSceneConfig;
  private readonly snowParticles: SnowParticle[];
  private readonly embers: EmberParticle[];
  private smoothedFireIntensity = 0.55;
  private emberSpawnAccumulator = 0;
  private readonly runtimeRng: () => number;

  constructor(config: ChristmasCabinSceneConfig) {
    this.config = config;
    const initRng = createDeterministicRng(20261225);
    this.runtimeRng = createDeterministicRng(987654321);

    const bounds = config.windowSnowBounds;
    const spanU = bounds.u1 - bounds.u0;
    const spanV = bounds.v1 - bounds.v0;

    this.snowParticles = Array.from({ length: SNOW_PARTICLE_COUNT }, (_, idx) => {
      // 3 tầng chiều sâu ngoài khung cửa sổ đôi: sương tuyết rừng thông xa (0), tuyết trung cảnh (1), bông tuyết bokeh gần kính (2)
      const layer: 0 | 1 | 2 = idx < 64 ? 0 : idx < 108 ? 1 : 2;
      const radiusRatio =
        layer === 0
          ? 0.0012 + initRng() * 0.0009
          : layer === 1
            ? 0.0021 + initRng() * 0.0014
            : 0.004 + initRng() * 0.0025;

      const fallSpeedV =
        layer === 0
          ? 0.022 + initRng() * 0.015
          : layer === 1
            ? 0.042 + initRng() * 0.024
            : 0.068 + initRng() * 0.032;

      return {
        u: bounds.u0 + initRng() * spanU,
        v: bounds.v0 + initRng() * spanV,
        layer,
        radiusRatio,
        fallSpeedV,
        windCoupling: layer === 0 ? 0.36 : layer === 1 ? 0.78 : 1.18,
        flutterFreq: 0.85 + initRng() * 1.85,
        flutterPhase: initRng() * Math.PI * 2,
        baseAlpha:
          layer === 0
            ? 0.36 + initRng() * 0.22
            : layer === 1
              ? 0.62 + initRng() * 0.26
              : 0.34 + initRng() * 0.22,
      };
    });

    this.embers = Array.from({ length: MAX_EMBERS }, (_, idx) => ({
      active: false,
      u: config.firebox.flameCenterU,
      v: config.firebox.flameBaseV,
      vu: 0,
      vv: 0,
      age: 0,
      maxAge: 2,
      radiusRatio: 0.0014,
      seed: idx * 1.732,
    }));
  }

  private spawnEmber(): void {
    const slot = this.embers.find((e) => !e.active);
    if (!slot) {
      return;
    }
    const { firebox } = this.config;
    slot.active = true;
    slot.u = firebox.flameCenterU + (this.runtimeRng() * 2 - 1) * firebox.flameSpreadHalfU * 0.85;
    slot.v = firebox.flameBaseV - this.runtimeRng() * 0.035;
    slot.vu = (this.runtimeRng() * 2 - 1) * 0.01;
    slot.vv = -(0.052 + this.runtimeRng() * 0.05);
    slot.age = 0;
    slot.maxAge = 1.5 + this.runtimeRng() * 1.8;
    slot.radiusRatio = 0.0011 + this.runtimeRng() * 0.0013;
    slot.seed = this.runtimeRng() * 20;
  }

  private stepSimulation(dtSeconds: number, timeSeconds: number): void {
    const dt = Math.min(0.05, Math.max(0, dtSeconds));
    const wind = sampleExteriorWindField(timeSeconds);
    const bounds = this.config.windowSnowBounds;
    const spanU = bounds.u1 - bounds.u0;
    const spanV = bounds.v1 - bounds.v0;

    for (const flake of this.snowParticles) {
      const flutterU =
        Math.sin(timeSeconds * flake.flutterFreq + flake.flutterPhase) * 0.0065 * wind.turbulence;
      const windDriftU = wind.gustVelocity * 0.028 * flake.windCoupling;

      flake.u += (windDriftU + flutterU) * dt;
      flake.v += flake.fallSpeedV * (1 + wind.turbulence * 0.24) * dt;

      if (flake.v > bounds.v1) {
        flake.v = bounds.v0 + ((flake.v - bounds.v1) % spanV);
        flake.u = bounds.u0 + this.runtimeRng() * spanU;
      }
      if (flake.u > bounds.u1) {
        flake.u = bounds.u0 + ((flake.u - bounds.u1) % spanU);
      } else if (flake.u < bounds.u0) {
        flake.u = bounds.u1 - ((bounds.u0 - flake.u) % spanU);
      }
    }

    const rawFire = sampleHearthFireIntensity(timeSeconds);
    this.smoothedFireIntensity += (rawFire - this.smoothedFireIntensity) * Math.min(1, dt * 7.5);

    this.emberSpawnAccumulator += dt * (1.35 + this.smoothedFireIntensity * 2.1);
    while (this.emberSpawnAccumulator >= 1) {
      this.emberSpawnAccumulator -= 1;
      this.spawnEmber();
    }

    for (const ember of this.embers) {
      if (!ember.active) {
        continue;
      }
      ember.age += dt;
      if (ember.age >= ember.maxAge || ember.v <= this.config.firebox.archTopV + 0.01) {
        ember.active = false;
        continue;
      }
      const curl = sampleIrrationalWave(timeSeconds * 3.1, ember.seed) * 0.015;
      ember.u += (ember.vu + curl) * dt;
      ember.v += ember.vv * dt;
    }
  }

  private drawWindowSnow(
    ctx: CanvasRenderingContext2D,
    transform: CoverTransform,
    timeSeconds: number,
  ): void {
    ctx.save();
    ctx.beginPath();
    for (const poly of this.config.windowPanePolygons) {
      if (poly.length < 3) {
        continue;
      }
      const first = uvToCanvas(transform, poly[0]![0], poly[0]![1]);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < poly.length; i += 1) {
        const pt = uvToCanvas(transform, poly[i]![0], poly[i]![1]);
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
    }
    ctx.clip();

    const wind = sampleExteriorWindField(timeSeconds);

    // Sương gió lạnh phớt nhẹ qua rừng thông ngoài cửa sổ khi có đợt gió mùa đông
    if (wind.turbulence > 0.4) {
      const bounds = this.config.windowSnowBounds;
      const pTop = uvToCanvas(transform, bounds.u0, bounds.v0);
      const pBot = uvToCanvas(transform, bounds.u1, bounds.v1);
      const mistAlpha = Math.min(0.1, (wind.turbulence - 0.4) * 0.16);
      const mistGrad = ctx.createLinearGradient(pTop.x, pTop.y, pBot.x, pBot.y);
      mistGrad.addColorStop(0, `rgba(224, 238, 255, ${mistAlpha.toFixed(4)})`);
      mistGrad.addColorStop(0.55, `rgba(235, 245, 255, ${(mistAlpha * 0.65).toFixed(4)})`);
      mistGrad.addColorStop(1, 'rgba(224, 238, 255, 0)');
      ctx.fillStyle = mistGrad;
      ctx.fillRect(pTop.x, pTop.y, pBot.x - pTop.x, pBot.y - pTop.y);
    }

    for (const flake of this.snowParticles) {
      const pt = uvToCanvas(transform, flake.u, flake.v);
      const radiusPx = Math.max(0.85, flake.radiusRatio * transform.drawHeight);

      if (flake.layer === 2) {
        const bokehGrad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radiusPx);
        bokehGrad.addColorStop(0, `rgba(250, 253, 255, ${flake.baseAlpha.toFixed(3)})`);
        bokehGrad.addColorStop(0.55, `rgba(234, 245, 255, ${(flake.baseAlpha * 0.48).toFixed(3)})`);
        bokehGrad.addColorStop(1, 'rgba(234, 245, 255, 0)');
        ctx.fillStyle = bokehGrad;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radiusPx, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(247, 251, 255, ${flake.baseAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radiusPx, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private drawFireplaceAndEmbers(
    ctx: CanvasRenderingContext2D,
    transform: CoverTransform,
    timeSeconds: number,
  ): void {
    const { firebox } = this.config;
    if (firebox.polygon.length < 3) {
      return;
    }

    ctx.save();
    ctx.beginPath();
    const p0 = uvToCanvas(transform, firebox.polygon[0]![0], firebox.polygon[0]![1]);
    ctx.moveTo(p0.x, p0.y);
    let minX = p0.x;
    let maxX = p0.x;
    let minY = p0.y;
    let maxY = p0.y;
    for (let i = 1; i < firebox.polygon.length; i += 1) {
      const pt = uvToCanvas(transform, firebox.polygon[i]![0], firebox.polygon[i]![1]);
      ctx.lineTo(pt.x, pt.y);
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    ctx.closePath();
    ctx.clip();

    const intensity = this.smoothedFireIntensity;

    // 1. Chiều sâu bóng gạch vòm lò sưởi co giãn tự nhiên khi ngọn lửa hạ nhẹ
    const shadowPulse = (1 - intensity) * 0.19;
    if (shadowPulse > 0.01) {
      const archShadow = ctx.createLinearGradient(0, minY, 0, maxY);
      archShadow.addColorStop(0, `rgba(24, 8, 2, ${shadowPulse.toFixed(3)})`);
      archShadow.addColorStop(0.6, 'rgba(24, 8, 2, 0)');
      ctx.fillStyle = archShadow;
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    }

    // 2. Than hồng dưới khe củi & dải ngọn lửa mềm chế độ `screen` (giữ ấm áp, không cháy trắng lõi lửa gốc)
    ctx.globalCompositeOperation = 'screen';

    const coalCenter = uvToCanvas(transform, firebox.flameCenterU, firebox.flameBaseV + 0.012);
    const coalRadius = Math.max(12, firebox.flameSpreadHalfU * 1.45 * transform.drawWidth);
    const coalAlpha = 0.08 + intensity * 0.11;
    const coalGrad = ctx.createRadialGradient(
      coalCenter.x,
      coalCenter.y,
      coalRadius * 0.05,
      coalCenter.x,
      coalCenter.y,
      coalRadius,
    );
    coalGrad.addColorStop(0, `rgba(255, 142, 42, ${coalAlpha.toFixed(4)})`);
    coalGrad.addColorStop(0.6, `rgba(218, 68, 14, ${(coalAlpha * 0.5).toFixed(4)})`);
    coalGrad.addColorStop(1, 'rgba(180, 38, 8, 0)');
    ctx.fillStyle = coalGrad;
    ctx.beginPath();
    ctx.arc(coalCenter.x, coalCenter.y, coalRadius, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < FLAME_TONGUE_NORMS.length; i += 1) {
      const normOffset = FLAME_TONGUE_NORMS[i]!;
      const seed = i * 2.17 + 0.6;
      const swayU = sampleIrrationalWave(timeSeconds * 3.5, seed) * 0.012;
      const heightWave = 0.5 + sampleIrrationalWave(timeSeconds * 4.7, seed + 5.1) * 0.5;

      const baseU = firebox.flameCenterU + normOffset * firebox.flameSpreadHalfU;
      const centerFlameFactor = 1 - Math.abs(normOffset) * 0.38;
      const tipV =
        firebox.flameBaseV -
        (0.075 + heightWave * 0.115 * (0.65 + intensity * 0.45)) * centerFlameFactor;

      const basePt = uvToCanvas(transform, baseU + swayU * 0.3, firebox.flameBaseV);
      const tipPt = uvToCanvas(transform, baseU + swayU, tipV);
      const flameRadius = Math.max(8, (0.026 + heightWave * 0.015) * transform.drawWidth);

      const alphaCore = (0.065 + heightWave * 0.085) * (0.65 + intensity * 0.4);
      const midX = (basePt.x + tipPt.x) * 0.5;
      const midY = (basePt.y + tipPt.y) * 0.52;
      const flameGrad = ctx.createRadialGradient(
        midX,
        midY,
        flameRadius * 0.08,
        tipPt.x,
        (basePt.y + tipPt.y) * 0.5,
        flameRadius,
      );
      flameGrad.addColorStop(0, `rgba(255, 186, 78, ${alphaCore.toFixed(4)})`);
      flameGrad.addColorStop(0.52, `rgba(232, 96, 24, ${(alphaCore * 0.62).toFixed(4)})`);
      flameGrad.addColorStop(1, 'rgba(180, 42, 8, 0)');

      ctx.fillStyle = flameGrad;
      ctx.beginPath();
      ctx.arc(midX, midY, flameRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. Tàn lửa vàng cam bay xoáy nhẹ lên trên rồi tàn dần trước vòm đá
    for (const ember of this.embers) {
      if (!ember.active) {
        continue;
      }
      const lifeProgress = ember.age / ember.maxAge;
      const fadeIn = Math.min(1, lifeProgress * 4.5);
      const fadeOut = Math.max(0, 1 - Math.pow(lifeProgress, 1.5));
      const emberAlpha = fadeIn * fadeOut * 0.74;
      if (emberAlpha <= 0.01) {
        continue;
      }

      const pt = uvToCanvas(transform, ember.u, ember.v);
      const rPx = Math.max(1, ember.radiusRatio * transform.drawHeight);
      const glowGrad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, rPx * 2.6);
      glowGrad.addColorStop(0, `rgba(255, 226, 138, ${emberAlpha.toFixed(3)})`);
      glowGrad.addColorStop(0.45, `rgba(255, 126, 36, ${(emberAlpha * 0.55).toFixed(3)})`);
      glowGrad.addColorStop(1, 'rgba(220, 60, 12, 0)');

      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rPx * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawRoomLightCastAndBulbs(
    ctx: CanvasRenderingContext2D,
    transform: CoverTransform,
    timeSeconds: number,
  ): void {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // 1. Ánh lửa ấm hắt nhẹ ra bệ đá, thảm dệt, hộp quà và mép ghế bành đồng bộ với ngọn lửa
    const cast = this.config.roomLightCast;
    const castCenter = uvToCanvas(transform, cast.centerU, cast.centerV);
    const castRadius = Math.max(48, cast.radiusRatio * transform.drawHeight);
    const castAlpha = 0.026 + this.smoothedFireIntensity * 0.048;

    const roomGrad = ctx.createRadialGradient(
      castCenter.x,
      castCenter.y,
      castRadius * 0.06,
      castCenter.x,
      castCenter.y,
      castRadius,
    );
    roomGrad.addColorStop(0, `rgba(255, 152, 58, ${castAlpha.toFixed(4)})`);
    roomGrad.addColorStop(0.48, `rgba(238, 112, 34, ${(castAlpha * 0.45).toFixed(4)})`);
    roomGrad.addColorStop(1, 'rgba(210, 82, 20, 0)');

    ctx.fillStyle = roomGrad;
    ctx.beginPath();
    ctx.arc(castCenter.x, castCenter.y, castRadius, 0, Math.PI * 2);
    ctx.fill();

    // 2. Các bóng đèn vàng ấm trên khung cửa sổ, bệ lò, cây thông, ngôi sao, nến & đèn tường
    const nodes = this.config.lightNodes;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      const phaseOffset = i * 2.3999632;
      const pulse = sampleAsyncBulbGlow(timeSeconds, node.cycleSeconds, phaseOffset);
      const alpha = node.maxAlpha * pulse;
      if (alpha <= 0.005) {
        continue;
      }

      const pt = uvToCanvas(transform, node.u, node.v);
      const radiusPx = Math.max(4, node.radiusRatio * transform.drawHeight * (0.88 + pulse * 0.18));
      const rgb = resolveTintRgb(node.tint);

      const halo = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radiusPx);
      halo.addColorStop(0, `rgba(${rgb}, ${alpha.toFixed(4)})`);
      halo.addColorStop(0.42, `rgba(${rgb}, ${(alpha * 0.42).toFixed(4)})`);
      halo.addColorStop(1, `rgba(${rgb}, 0)`);

      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, radiusPx, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  renderFrame(params: {
    readonly ctx: CanvasRenderingContext2D;
    readonly transform: CoverTransform;
    readonly timeSeconds: number;
    readonly dtSeconds: number;
    readonly reducedMotion: boolean;
  }): void {
    const { ctx, transform, timeSeconds, dtSeconds, reducedMotion } = params;
    ctx.clearRect(0, 0, transform.stageWidth, transform.stageHeight);

    if (reducedMotion) {
      this.smoothedFireIntensity = 0.5;
      this.drawRoomLightCastAndBulbs(ctx, transform, 0);
      return;
    }

    this.stepSimulation(dtSeconds, timeSeconds);
    this.drawWindowSnow(ctx, transform, timeSeconds);
    this.drawFireplaceAndEmbers(ctx, transform, timeSeconds);
    this.drawRoomLightCastAndBulbs(ctx, transform, timeSeconds);
  }
}
