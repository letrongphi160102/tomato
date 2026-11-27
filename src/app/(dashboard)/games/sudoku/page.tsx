import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SudokuGameView } from '@/components/games/sudoku-game-view';
import { resolveServerAuthState } from '@/modules/auth/server-session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sudoku · Tomato',
  description: 'Thử thách trí tuệ với 6 cấp độ Sudoku và bảng xếp hạng kỉ lục trên Tomato.',
};

export default async function SudokuGamePage() {
  const authState = await resolveServerAuthState();
  if (authState.status !== 'authenticated') {
    redirect('/login?next=%2Fgames%2Fsudoku');
  }

  return <SudokuGameView />;
}
