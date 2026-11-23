import Image from 'next/image';

import { cn } from '@/lib/utils';

const LOGO_WIDTH = 736;
const LOGO_HEIGHT = 258;

export interface TomatoLogoProps {
  /** Chiều cao hiển thị: `sm` (TopBar), `md` (Auth header), `lg` (Landing Hero). */
  readonly size?: 'sm' | 'md' | 'lg';
  readonly priority?: boolean;
  readonly className?: string;
}

const SIZE_CLASSES: Record<NonNullable<TomatoLogoProps['size']>, string> = {
  sm: 'h-8 w-auto',
  md: 'h-12 w-auto',
  lg: 'h-20 w-auto sm:h-24',
};

export function TomatoLogo({ size = 'sm', priority = false, className }: TomatoLogoProps) {
  return (
    <Image
      src="/images/brand/tomato-logo.png"
      alt="Tomato"
      width={LOGO_WIDTH}
      height={LOGO_HEIGHT}
      priority={priority}
      unoptimized
      draggable={false}
      className={cn('select-none object-contain', SIZE_CLASSES[size], className)}
    />
  );
}
