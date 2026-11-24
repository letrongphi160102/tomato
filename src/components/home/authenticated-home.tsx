import Image from 'next/image';

import tomatoIcon from '@/assets/images/brand/tomato-icon.png';
import type { PublicUserProfile } from '@/modules/auth/session.service';
import type { UserProfileDto } from '@/modules/profile';

export interface AuthenticatedHomeProps {
  readonly user?: PublicUserProfile;
  readonly profile?: UserProfileDto;
}

export function AuthenticatedHome(props: AuthenticatedHomeProps) {
  void props;
  return (
    <div className="flex min-h-[calc(100vh-12rem)] flex-col items-center justify-center px-4 text-center">
      <Image
        src={tomatoIcon}
        alt="Tomato"
        width={56}
        height={56}
        unoptimized
        draggable={false}
        className="size-14 select-none object-contain opacity-95"
      />
      <p className="mt-3.5 text-sm font-medium text-muted-foreground">Tính năng này sắp có!</p>
    </div>
  );
}
