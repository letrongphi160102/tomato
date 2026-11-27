import type { HomeThemeDefinition, HomeThemeId } from '@/components/home-themes/types';

/**
 * Công tắc trung tâm duy nhất cho Không gian Trang chủ theo sự kiện (`/`):
 * - Đặt `'christmas'` trong mùa lễ Giáng sinh.
 * - Sau mùa lễ, chỉ cần đổi thành `'none'` (hoặc đặt `NEXT_PUBLIC_HOME_THEME=none`) để trở về Trang chủ tối giản mặc định.
 */
export const DEFAULT_ACTIVE_HOME_THEME: HomeThemeId = 'christmas';

export const HOME_THEME_METADATA: Readonly<
  Record<Exclude<HomeThemeId, 'none'>, HomeThemeDefinition>
> = Object.freeze({
  christmas: Object.freeze({
    id: 'christmas',
    labelVi: 'Giáng sinh ấm áp',
    eventBadgeVi: 'Không gian mùa Giáng sinh',
  }),
});

export function resolveHomeThemeId(rawOverride?: string | null): HomeThemeId {
  if (typeof rawOverride === 'string') {
    const normalized = rawOverride.trim().toLowerCase();
    if (normalized === 'none' || normalized === 'christmas') {
      return normalized;
    }
  }
  return DEFAULT_ACTIVE_HOME_THEME;
}

export function getActiveHomeThemeId(): HomeThemeId {
  return resolveHomeThemeId(process.env.NEXT_PUBLIC_HOME_THEME);
}

export function getActiveHomeThemeDefinition(): HomeThemeDefinition | null {
  const activeId = getActiveHomeThemeId();
  if (activeId === 'none') {
    return null;
  }
  return HOME_THEME_METADATA[activeId] ?? null;
}
