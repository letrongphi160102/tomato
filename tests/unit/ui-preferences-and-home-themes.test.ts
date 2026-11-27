import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { ChristmasCabinCanvasRenderer } from '@/components/home-themes/christmas/cabin-canvas-renderer';
import {
  sampleAsyncBulbGlow,
  sampleExteriorWindField,
  sampleHearthFireIntensity,
} from '@/components/home-themes/christmas/noise';
import { CHRISTMAS_CABIN_SCENE_CONFIG } from '@/components/home-themes/christmas/scene-config';
import { DEFAULT_ACTIVE_HOME_THEME, resolveHomeThemeId } from '@/components/home-themes/config';
import { computeCoverTransform, uvToCanvas } from '@/components/home-themes/cover-geometry';
import { getHomeThemeSceneComponent } from '@/components/home-themes/registry';
import { shouldRenderFloatingMessagesWidget } from '@/components/messages/chat-store-context';
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFS_COOKIE_NAME,
  buildUiPreferencesSetCookieString,
  parseUiPreferencesCookie,
  readUiPreferencesFromCookieHeader,
  serializeUiPreferencesCookie,
} from '@/lib/ui-preferences';
import { proxy } from '@/proxy';

function createMockCanvasContext() {
  const gradientStub = {
    addColorStop: vi.fn(),
  };
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(() => gradientStub),
    createRadialGradient: vi.fn(() => gradientStub),
    globalCompositeOperation: 'source-over',
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;
}

describe('UI Preferences Cookie — Mặc định Sáng, kiểm chứng chặt enum & tương thích ngược', () => {
  it('mặc định ban đầu là Sáng (light) khi chưa có cookie', () => {
    expect(DEFAULT_UI_PREFERENCES).toEqual({
      theme: 'light',
    });
    expect(parseUiPreferencesCookie(undefined)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(parseUiPreferencesCookie(null)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(parseUiPreferencesCookie('')).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('tuần tự hóa và giải mã chính xác light | dark | system (kèm tương thích ngược định dạng cũ)', () => {
    for (const mode of ['light', 'dark', 'system'] as const) {
      const prefs = { theme: mode };
      const encoded = serializeUiPreferencesCookie(prefs);
      expect(encoded).toBe(mode);
      expect(parseUiPreferencesCookie(encoded)).toEqual(prefs);

      const header = `other_cookie=1; ${UI_PREFS_COOKIE_NAME}=${encodeURIComponent(encoded)}; foo=bar`;
      expect(readUiPreferencesFromCookieHeader(header)).toEqual(prefs);
    }

    // Đọc được cả định dạng cũ `<theme>.<0|1>.<0|1>` nếu trình duyệt đã lưu trước đó.
    expect(parseUiPreferencesCookie('dark.0.1')).toEqual({ theme: 'dark' });
    expect(parseUiPreferencesCookie('system.1.0')).toEqual({ theme: 'system' });

    const setCookieHttps = buildUiPreferencesSetCookieString({ theme: 'dark' }, { isHttps: true });
    expect(setCookieHttps).toContain(`${UI_PREFS_COOKIE_NAME}=dark`);
    expect(setCookieHttps).toContain('Path=/');
    expect(setCookieHttps).toContain('SameSite=Lax');
    expect(setCookieHttps).toContain('Secure');
    expect(setCookieHttps).not.toContain('Domain=');
  });

  it('từ chối mọi chuỗi sai định dạng hoặc chứa mã độc về DEFAULT_UI_PREFERENCES', () => {
    const invalidInputs = [
      'auto',
      'midnight',
      'dark.2.1',
      '"><script>alert(1)</script>',
      '__proto__',
      'dark; evil=1',
      'x'.repeat(64),
    ];

    for (const raw of invalidInputs) {
      expect(parseUiPreferencesCookie(raw)).toEqual(DEFAULT_UI_PREFERENCES);
    }
  });
});

describe('Home Themes Plug-and-Play Registry, Hình học 4 Ô kính Cửa sổ đôi & Vòm Lò sưởi', () => {
  it('hỗ trợ tắt sạch về "none" (trả null, không lỗi) và nạp lười cảnh "christmas"', () => {
    expect(DEFAULT_ACTIVE_HOME_THEME).toBe('christmas');
    expect(resolveHomeThemeId('none')).toBe('none');
    expect(resolveHomeThemeId('  NONE  ')).toBe('none');
    expect(resolveHomeThemeId('christmas')).toBe('christmas');
    expect(resolveHomeThemeId('unknown-event')).toBe(DEFAULT_ACTIVE_HOME_THEME);

    expect(getHomeThemeSceneComponent('none')).toBeNull();
    expect(getHomeThemeSceneComponent('christmas')).toBeTruthy();
  });

  it('phép chiếu computeCoverTransform luôn phủ kín khung nhìn trên cả Laptop ngang và Mobile dọc, khớp 4 ô kính cửa sổ', () => {
    const viewports = [
      { w: 1208 + 12, h: 578 + 12 },
      { w: 1920 + 12, h: 1080 + 12 },
      { w: 2560 + 12, h: 1080 + 12 },
      { w: 390 + 12, h: 844 + 12 },
    ];

    for (const vp of viewports) {
      const tf = computeCoverTransform({
        stageWidth: vp.w,
        stageHeight: vp.h,
        imageWidth: CHRISTMAS_CABIN_SCENE_CONFIG.imageWidth,
        imageHeight: CHRISTMAS_CABIN_SCENE_CONFIG.imageHeight,
      });

      expect(tf.drawWidth).toBeGreaterThanOrEqual(vp.w - 0.001);
      expect(tf.drawHeight).toBeGreaterThanOrEqual(vp.h - 0.001);
      expect(tf.drawX).toBeLessThanOrEqual(0.001);
      expect(tf.drawY).toBeLessThanOrEqual(0.001);
      expect(tf.drawX + tf.drawWidth).toBeGreaterThanOrEqual(vp.w - 0.001);
      expect(tf.drawY + tf.drawHeight).toBeGreaterThanOrEqual(vp.h - 0.001);

      const topLeft = uvToCanvas(tf, 0, 0);
      expect(topLeft.x).toBeCloseTo(tf.drawX, 5);
      expect(topLeft.y).toBeCloseTo(tf.drawY, 5);
    }

    // Xác minh đủ 4 đa giác ô kính của cửa sổ đôi bên phải và đa giác vòm gạch lò sưởi nằm trọn trong [0..1]
    expect(CHRISTMAS_CABIN_SCENE_CONFIG.windowPanePolygons).toHaveLength(4);
    for (const poly of CHRISTMAS_CABIN_SCENE_CONFIG.windowPanePolygons) {
      expect(poly.length).toBeGreaterThanOrEqual(4);
      for (const [u, v] of poly) {
        expect(u).toBeGreaterThan(0.67);
        expect(u).toBeLessThan(0.96);
        expect(v).toBeGreaterThan(0.16);
        expect(v).toBeLessThan(0.59);
      }
    }
    expect(CHRISTMAS_CABIN_SCENE_CONFIG.firebox.polygon.length).toBeGreaterThanOrEqual(6);
  });

  it('hàm gió tuyết & lửa không lặp chu kỳ ngắn, và renderer cắt mặt nạ chính xác cho cả cửa sổ lẫn lò sưởi', () => {
    const windAt0 = sampleExteriorWindField(0);
    const windAt5 = sampleExteriorWindField(5);
    const windAt10 = sampleExteriorWindField(10);
    expect(windAt0.gustVelocity).not.toBeCloseTo(windAt5.gustVelocity, 3);
    expect(windAt5.gustVelocity).not.toBeCloseTo(windAt10.gustVelocity, 3);

    const fireAt1 = sampleHearthFireIntensity(1.2);
    const fireAt4 = sampleHearthFireIntensity(4.2);
    expect(fireAt1).toBeGreaterThanOrEqual(0.12);
    expect(fireAt1).toBeLessThanOrEqual(1);
    expect(fireAt1).not.toBeCloseTo(fireAt4, 3);

    expect(sampleAsyncBulbGlow(3.5, 7.3, 1.2)).toBeGreaterThanOrEqual(0.38);

    const renderer = new ChristmasCabinCanvasRenderer(CHRISTMAS_CABIN_SCENE_CONFIG);
    const tf = computeCoverTransform({
      stageWidth: 1920,
      stageHeight: 1080,
      imageWidth: CHRISTMAS_CABIN_SCENE_CONFIG.imageWidth,
      imageHeight: CHRISTMAS_CABIN_SCENE_CONFIG.imageHeight,
    });

    const reducedCtx = createMockCanvasContext();
    renderer.renderFrame({
      ctx: reducedCtx,
      transform: tf,
      timeSeconds: 12,
      dtSeconds: 0.016,
      reducedMotion: true,
    });
    expect(reducedCtx.clearRect).toHaveBeenCalledTimes(1);
    expect(reducedCtx.clip).not.toHaveBeenCalled();

    const activeCtx = createMockCanvasContext();
    renderer.renderFrame({
      ctx: activeCtx,
      transform: tf,
      timeSeconds: 12,
      dtSeconds: 0.016,
      reducedMotion: false,
    });
    expect(activeCtx.clip).toHaveBeenCalledTimes(2);
  });

  it('bảo vệ route /settings/display, đã gỡ bỏ hoàn toàn mục Trợ năng và hiệu ứng, và 0% thuật ngữ kỹ thuật', () => {
    expect(shouldRenderFloatingMessagesWidget('/settings/display')).toBe(false);

    const anonDisplayReq = new NextRequest('http://localhost:3000/settings/display');
    const anonDisplayRes = proxy(anonDisplayReq);
    expect(anonDisplayRes.status).toBe(307);
    expect(anonDisplayRes.headers.get('location')).toContain('/login?next=%2Fsettings%2Fdisplay');

    const globalsCss = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(globalsCss).toContain('@custom-variant dark');
    expect(globalsCss).toContain("[data-theme='system']:not(.light)");

    const displayPanelSource = readFileSync(
      join(process.cwd(), 'src/components/settings/display-settings-panel.tsx'),
      'utf8',
    );
    expect(displayPanelSource).toContain('Giao diện');
    expect(displayPanelSource).not.toContain('Trợ năng và hiệu ứng');
    expect(displayPanelSource).not.toContain('Giảm chuyển động');
    expect(displayPanelSource).not.toContain('Hiển thị không gian trang chủ theo sự kiện');

    const bannedJargon = [
      'Canvas',
      'FPS',
      'WebP',
      'CSP',
      'FOUC',
      'Dark Mode',
      'Reduced Motion',
      'Perlin',
      'Parallax',
    ];
    for (const term of bannedJargon) {
      expect(displayPanelSource).not.toContain(term);
    }
  });
});
