import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Play } from 'lucide-react';

import sudokuCoverImg from '@/assets/images/sodoku.png';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Trò chơi · Tomato',
  description: 'Thư giãn một chút, thử thách trí tuệ trên Tomato.',
};

export default async function GamesHubPage() {
  const authState = await resolveServerAuthState();
  if (authState.status !== 'authenticated') {
    redirect('/login?next=%2Fgames');
  }

  return (
    <section aria-labelledby="games-hub-heading" className="space-y-6">
      <header className="space-y-1">
        <h1
          id="games-hub-heading"
          className="text-2xl font-bold tracking-tight text-foreground sm:text-[26px]"
        >
          Trò chơi
        </h1>
        <p className="text-sm text-muted-foreground">Thư giãn một chút, thử thách trí tuệ.</p>
      </header>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <article className="group flex flex-col rounded-2xl border border-border/70 bg-card p-5 shadow-xs transition-shadow hover:shadow-md">
          <Link
            href="/games/sudoku"
            aria-label="Mở trò chơi Sudoku"
            className="flex h-52 items-center justify-center rounded-xl bg-muted/20 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Image
              src={sudokuCoverImg}
              alt="Minh họa trò chơi Sudoku"
              priority
              className="h-44 w-auto object-contain transition-transform duration-200 group-hover:scale-[1.03]"
            />
          </Link>

          <div className="mt-4 flex flex-1 flex-col">
            <h2 className="text-lg font-bold text-foreground">Sudoku</h2>
            <p className="mt-1 text-sm text-muted-foreground">Rèn luyện tư duy với những ô số.</p>

            <div className="mt-5 pt-1">
              <Link
                href="/games/sudoku"
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Play className="size-4 fill-current" aria-hidden="true" />
                <span>Chơi</span>
              </Link>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
