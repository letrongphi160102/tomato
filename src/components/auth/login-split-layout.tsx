import Image from 'next/image';
import type { ReactNode } from 'react';

import { TomatoLogo } from '@/components/brand/tomato-logo';

const HOMELAND_WIDTH = 700;
const HOMELAND_HEIGHT = 525;

export interface LoginSplitLayoutProps {
  readonly children: ReactNode;
}

export function LoginSplitLayout({ children }: LoginSplitLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section
          aria-label="Giới thiệu Tomato"
          className="hidden flex-col justify-between border-r border-border/70 bg-background px-10 py-10 lg:flex xl:px-16"
        >
          <div>
            <TomatoLogo size="md" priority />
          </div>

          <div className="my-auto flex flex-col items-center gap-8 py-6">
            <div className="w-full max-w-xl">
              <Image
                src="/images/brand/homeland.png"
                alt="Kết nối và khám phá cùng nhau trên Tomato"
                width={HOMELAND_WIDTH}
                height={HOMELAND_HEIGHT}
                priority
                unoptimized
                draggable={false}
                className="mx-auto h-auto w-full max-w-[520px] select-none object-contain"
              />
            </div>

            <div className="max-w-xl text-center">
              <h1 className="text-3xl font-bold tracking-tight text-foreground xl:text-4xl">
                Kết nối và <span className="text-primary">khám phá cùng nhau.</span>
              </h1>
            </div>
          </div>

          <div aria-hidden="true" className="h-4" />
        </section>

        <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8 lg:px-12">
          <div className="mb-6 flex flex-col items-center gap-2 text-center lg:hidden">
            <TomatoLogo size="md" priority />
            <p className="text-sm text-muted-foreground">Kết nối và khám phá cùng nhau</p>
          </div>

          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  );
}
