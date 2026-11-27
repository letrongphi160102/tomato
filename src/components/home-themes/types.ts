export const HOME_THEME_IDS = ['none', 'christmas'] as const;
export type HomeThemeId = (typeof HOME_THEME_IDS)[number];
export type ActiveHomeThemeKey = Exclude<HomeThemeId, 'none'>;

export interface HomeThemeSceneProps {
  readonly reducedMotion: boolean;
}

export interface HomeThemeDefinition {
  readonly id: ActiveHomeThemeKey;
  readonly labelVi: string;
  readonly eventBadgeVi: string;
}
