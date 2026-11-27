'use client';

/* eslint-disable @next/next/no-img-element -- Ảnh nền cảnh cabin dùng chung phép chiếu hình học pixel-locked trực tiếp với Canvas 2D bên trong cùng lớp overscan. */

import * as React from 'react';

import {
  computeCoverTransform,
  type CoverTransform,
} from '@/components/home-themes/cover-geometry';
import { ChristmasCabinCanvasRenderer } from '@/components/home-themes/christmas/cabin-canvas-renderer';
import { CHRISTMAS_CABIN_SCENE_CONFIG } from '@/components/home-themes/christmas/scene-config';
import type { HomeThemeSceneProps } from '@/components/home-themes/types';

/** Dư biên 6px cả 4 phía để dịch chuyển chuột ±4px mượt mà mà không phóng to ảnh nền hay làm lộ mép. */
const STAGE_OVERSCAN_PX = 6;
const MAX_PARALLAX_PX = 4;
const MAX_CANVAS_DPR = 1.75;

export function ChristmasCabinScene({ reducedMotion }: HomeThemeSceneProps) {
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const imgRef = React.useRef<HTMLImageElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const rendererRef = React.useRef<ChristmasCabinCanvasRenderer | null>(null);
  const transformRef = React.useRef<CoverTransform | null>(null);

  const [imageHidden, setImageHidden] = React.useState(false);

  // Đồng bộ kích thước khung chiếu trực tiếp lên DOM cho cả `<img>` và `<canvas>` để khớp 0.0px tức thì mà không gây re-render.
  React.useEffect(() => {
    const stageEl = stageRef.current;
    const canvasEl = canvasRef.current;
    if (!stageEl || !canvasEl || typeof window === 'undefined') {
      return;
    }

    if (!rendererRef.current) {
      rendererRef.current = new ChristmasCabinCanvasRenderer(CHRISTMAS_CABIN_SCENE_CONFIG);
    }

    const syncGeometry = () => {
      const rect = stageEl.getBoundingClientRect();
      const stageWidth = Math.max(1, Math.round(rect.width));
      const stageHeight = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);

      canvasEl.width = Math.round(stageWidth * dpr);
      canvasEl.height = Math.round(stageHeight * dpr);

      const nextTransform = computeCoverTransform({
        stageWidth,
        stageHeight,
        imageWidth: CHRISTMAS_CABIN_SCENE_CONFIG.imageWidth,
        imageHeight: CHRISTMAS_CABIN_SCENE_CONFIG.imageHeight,
      });
      transformRef.current = nextTransform;

      const imgEl = imgRef.current;
      if (imgEl) {
        imgEl.style.left = `${nextTransform.drawX}px`;
        imgEl.style.top = `${nextTransform.drawY}px`;
        imgEl.style.width = `${nextTransform.drawWidth}px`;
        imgEl.style.height = `${nextTransform.drawHeight}px`;
        imgEl.style.objectFit = 'fill';
      }

      const ctx = canvasEl.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (reducedMotion) {
          rendererRef.current?.renderFrame({
            ctx,
            transform: nextTransform,
            timeSeconds: 0,
            dtSeconds: 0,
            reducedMotion: true,
          });
        }
      }
    };

    syncGeometry();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncGeometry) : null;
    resizeObserver?.observe(stageEl);
    window.addEventListener('resize', syncGeometry);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', syncGeometry);
    };
  }, [reducedMotion, imageHidden]);

  // Vòng lặp diễn hoạt Canvas + nội suy chiều sâu chuột mượt mà; dừng hoàn toàn khi ẩn tab hoặc bật Giảm chuyển động.
  React.useEffect(() => {
    const stageEl = stageRef.current;
    const canvasEl = canvasRef.current;
    if (!stageEl || !canvasEl || typeof window === 'undefined') {
      return;
    }

    if (!rendererRef.current) {
      rendererRef.current = new ChristmasCabinCanvasRenderer(CHRISTMAS_CABIN_SCENE_CONFIG);
    }

    if (reducedMotion) {
      stageEl.style.transform = 'translate3d(0px, 0px, 0px)';
      const ctx = canvasEl.getContext('2d');
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);
      const transform = transformRef.current;
      if (ctx && transform) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rendererRef.current.renderFrame({
          ctx,
          transform,
          timeSeconds: 0,
          dtSeconds: 0,
          reducedMotion: true,
        });
      }
      return;
    }

    const isFinePointer =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;

    let targetParallaxX = 0;
    let targetParallaxY = 0;
    let currentParallaxX = 0;
    let currentParallaxY = 0;

    const handlePointerMove = (event: PointerEvent) => {
      if (!isFinePointer || event.pointerType === 'touch') {
        return;
      }
      const nx = (event.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
      const ny = (event.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
      targetParallaxX = -nx * MAX_PARALLAX_PX;
      targetParallaxY = -ny * (MAX_PARALLAX_PX * 0.7);
    };

    if (isFinePointer) {
      window.addEventListener('pointermove', handlePointerMove, { passive: true });
    }

    let rafId: number | null = null;
    let lastTimestampMs: number | null = null;
    let accumulatedSeconds = 0;

    const tick = (nowMs: number) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        rafId = null;
        lastTimestampMs = null;
        return;
      }

      const dtSeconds =
        lastTimestampMs === null ? 1 / 60 : Math.min(0.05, (nowMs - lastTimestampMs) / 1000);
      lastTimestampMs = nowMs;
      accumulatedSeconds += dtSeconds;

      if (isFinePointer) {
        currentParallaxX += (targetParallaxX - currentParallaxX) * 0.06;
        currentParallaxY += (targetParallaxY - currentParallaxY) * 0.06;
        stageEl.style.transform = `translate3d(${currentParallaxX.toFixed(2)}px, ${currentParallaxY.toFixed(2)}px, 0px)`;
      }

      const ctx = canvasEl.getContext('2d');
      const transform = transformRef.current;
      if (ctx && transform && rendererRef.current) {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rendererRef.current.renderFrame({
          ctx,
          transform,
          timeSeconds: accumulatedSeconds,
          dtSeconds,
          reducedMotion: false,
        });
      }

      rafId = window.requestAnimationFrame(tick);
    };

    const startLoopIfVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        lastTimestampMs = null;
        return;
      }
      if (rafId === null) {
        lastTimestampMs = null;
        rafId = window.requestAnimationFrame(tick);
      }
    };

    startLoopIfVisible();
    document.addEventListener('visibilitychange', startLoopIfVisible);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      document.removeEventListener('visibilitychange', startLoopIfVisible);
      if (isFinePointer) {
        window.removeEventListener('pointermove', handlePointerMove);
      }
    };
  }, [reducedMotion]);

  return (
    <div
      aria-hidden="true"
      data-home-theme="christmas"
      className="pointer-events-none fixed top-14 right-0 bottom-14 left-0 z-0 overflow-hidden select-none md:bottom-0 md:left-[72px]"
    >
      {/* Nền gỗ thông ấm dự phòng khi ảnh đang tải hoặc chưa đặt tệp cục bộ */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(circle at 42% 88%, #5c2410 0%, #2d120a 48%, #150906 100%)',
        }}
      />

      {/* Khung đồng bộ có biên dư overscan 12px cả 4 hướng chống hở mép khi dịch chuyển chuột */}
      <div
        ref={stageRef}
        className="absolute will-change-transform"
        style={{
          top: `${-STAGE_OVERSCAN_PX}px`,
          right: `${-STAGE_OVERSCAN_PX}px`,
          bottom: `${-STAGE_OVERSCAN_PX}px`,
          left: `${-STAGE_OVERSCAN_PX}px`,
        }}
      >
        {!imageHidden ? (
          <img
            ref={imgRef}
            src={CHRISTMAS_CABIN_SCENE_CONFIG.backgroundSrc}
            alt=""
            decoding="async"
            draggable={false}
            onError={() => setImageHidden(true)}
            style={{
              left: '0px',
              top: '0px',
              width: '100%',
              height: '100%',
              objectFit: 'fill',
            }}
            className="absolute max-w-none select-none"
          />
        ) : null}

        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      </div>

      {/* Lớp phủ tối viền rất nhẹ giữ độ sâu điện ảnh và tôn nổi thanh điều hướng cùng thẻ trung tâm */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 52%, rgba(12, 6, 4, 0.06) 0%, rgba(10, 5, 3, 0.34) 100%)',
        }}
      />
    </div>
  );
}
