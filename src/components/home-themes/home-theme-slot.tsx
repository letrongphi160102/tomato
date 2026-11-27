'use client';

import * as React from 'react';

import { getActiveHomeThemeId } from '@/components/home-themes/config';
import { getHomeThemeSceneComponent } from '@/components/home-themes/registry';

const ACTIVE_HOME_THEME_ID = getActiveHomeThemeId();
const ActiveHomeSceneComponent = getHomeThemeSceneComponent(ACTIVE_HOME_THEME_ID);

export function HomeThemeSlot() {
  const [osReducedMotion, setOsReducedMotion] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setOsReducedMotion(mql.matches);
    const timerId = window.setTimeout(sync, 0);
    mql.addEventListener('change', sync);
    return () => {
      window.clearTimeout(timerId);
      mql.removeEventListener('change', sync);
    };
  }, []);

  if (!ActiveHomeSceneComponent) {
    return null;
  }

  return <ActiveHomeSceneComponent reducedMotion={osReducedMotion} />;
}
