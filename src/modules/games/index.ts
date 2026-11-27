import 'server-only';

import { SudokuDomainError } from '@/modules/games/sudoku.errors';
import { SUDOKU_MESSAGES } from '@/modules/games/sudoku.messages';
import { assertSudokuAuthorized, authorizeSudokuAction } from '@/modules/games/sudoku.policy';
import {
  SudokuRepository,
  type SudokuLeaderboardRowRecord,
} from '@/modules/games/sudoku.repository';
import {
  SudokuService,
  type CompleteSudokuGameResult,
  type StartSudokuGameResult,
  type SudokuLeaderboardEntryDto,
  type SudokuLeaderboardResult,
  type SudokuPersonalDifficultyRecordDto,
  type SudokuPersonalRecordsResult,
  type SudokuServiceOptions,
} from '@/modules/games/sudoku.service';

export {
  SUDOKU_MESSAGES,
  SudokuDomainError,
  SudokuRepository,
  SudokuService,
  assertSudokuAuthorized,
  authorizeSudokuAction,
};
export type {
  CompleteSudokuGameResult,
  StartSudokuGameResult,
  SudokuLeaderboardEntryDto,
  SudokuLeaderboardResult,
  SudokuLeaderboardRowRecord,
  SudokuPersonalDifficultyRecordDto,
  SudokuPersonalRecordsResult,
  SudokuServiceOptions,
};

const globalForSudoku = globalThis as typeof globalThis & {
  __tomatoSudokuService?: SudokuService;
};

export function getSudokuService(): SudokuService {
  if (!globalForSudoku.__tomatoSudokuService) {
    globalForSudoku.__tomatoSudokuService = new SudokuService();
  }
  return globalForSudoku.__tomatoSudokuService;
}

export function setSudokuServiceForTesting(service: SudokuService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setSudokuServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForSudoku.__tomatoSudokuService = service;
}

export function resetSudokuServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetSudokuServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForSudoku.__tomatoSudokuService = undefined;
}
