import 'server-only';

import type { SudokuGameRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { SudokuDomainError } from '@/modules/games/sudoku.errors';
import { SUDOKU_MESSAGES } from '@/modules/games/sudoku.messages';
import { isActiveSocialActor } from '@/modules/social/social.policy';

export type SudokuAction =
  'sudoku:game:start' | 'sudoku:game:complete' | 'sudoku:records:read' | 'sudoku:leaderboard:read';

export interface SudokuPolicyResource {
  readonly game?: Pick<SudokuGameRow, 'id' | 'userId'> | null;
}

export function authorizeSudokuAction(
  actor: AuthenticatedPrincipal | null | undefined,
  action: SudokuAction,
  resource: SudokuPolicyResource = {},
): boolean {
  if (!isActiveSocialActor(actor)) {
    return false;
  }

  switch (action) {
    case 'sudoku:game:start':
    case 'sudoku:records:read':
    case 'sudoku:leaderboard:read':
      return true;

    case 'sudoku:game:complete': {
      const game = resource.game;
      if (!game) {
        return false;
      }
      return game.userId === actor.user.id;
    }

    default:
      return false;
  }
}

export function assertSudokuAuthorized(
  actor: AuthenticatedPrincipal | null | undefined,
  action: SudokuAction,
  resource: SudokuPolicyResource = {},
): void {
  if (!authorizeSudokuAction(actor, action, resource)) {
    throw new SudokuDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: SUDOKU_MESSAGES.notFound,
    });
  }
}
