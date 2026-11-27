import '@/core/validation/zod-config';
import { z } from 'zod';

import { SUDOKU_DIFFICULTIES } from '@/lib/sudoku/engine';

const PUBLIC_ID_UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const sudokuGamePublicIdParamSchema = z
  .string()
  .trim()
  .regex(PUBLIC_ID_UUID_V4_REGEX, 'Định danh ván chơi không hợp lệ.')
  .transform((val) => val.toLowerCase());

export const startSudokuGameInputSchema = z
  .object({
    difficulty: z.enum(SUDOKU_DIFFICULTIES),
  })
  .strict();

export const completeSudokuGameInputSchema = z
  .object({
    finalBoard: z
      .string()
      .regex(/^[1-9]{81}$/, 'Bảng hoàn thành phải gồm đúng 81 chữ số từ 1 đến 9.'),
    mistakesCount: z.number().int().min(0).max(3),
    elapsedSeconds: z.number().int().min(1).max(86_400),
  })
  .strict();

export const sudokuLeaderboardQuerySchema = z
  .object({
    difficulty: z.enum(SUDOKU_DIFFICULTIES).default('easy'),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
