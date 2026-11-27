import type * as React from 'react';
import dynamic from 'next/dynamic';

import type {
  ActiveHomeThemeKey,
  HomeThemeId,
  HomeThemeSceneProps,
} from '@/components/home-themes/types';

const LazyChristmasCabinScene = dynamic<HomeThemeSceneProps>(
  () =>
    import('@/components/home-themes/christmas/christmas-cabin-scene').then(
      (mod) => mod.ChristmasCabinScene,
    ),
  { ssr: false },
);

const HOME_THEME_SCENE_COMPONENTS: Readonly<
  Record<ActiveHomeThemeKey, React.ComponentType<HomeThemeSceneProps>>
> = Object.freeze({
  christmas: LazyChristmasCabinScene,
});

export function getHomeThemeSceneComponent(
  themeId: HomeThemeId,
): React.ComponentType<HomeThemeSceneProps> | null {
  if (themeId === 'none') {
    return null;
  }
  return HOME_THEME_SCENE_COMPONENTS[themeId] ?? null;
}
