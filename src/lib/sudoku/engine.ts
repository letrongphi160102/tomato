export const SUDOKU_DIFFICULTIES = [
  'easy',
  'medium',
  'hard',
  'expert',
  'master',
  'extreme',
] as const;

export type SudokuDifficulty = (typeof SUDOKU_DIFFICULTIES)[number];

export interface SudokuDifficultyMeta {
  readonly key: SudokuDifficulty;
  readonly labelVi: string;
  readonly minGivens: number;
  readonly maxGivens: number;
  readonly minHumanSolveSeconds: number;
}

export const SUDOKU_DIFFICULTY_META: Readonly<Record<SudokuDifficulty, SudokuDifficultyMeta>> =
  Object.freeze({
    easy: Object.freeze({
      key: 'easy',
      labelVi: 'Dễ',
      minGivens: 39,
      maxGivens: 42,
      minHumanSolveSeconds: 10,
    }),
    medium: Object.freeze({
      key: 'medium',
      labelVi: 'Trung bình',
      minGivens: 34,
      maxGivens: 37,
      minHumanSolveSeconds: 14,
    }),
    hard: Object.freeze({
      key: 'hard',
      labelVi: 'Khó',
      minGivens: 30,
      maxGivens: 32,
      minHumanSolveSeconds: 18,
    }),
    expert: Object.freeze({
      key: 'expert',
      labelVi: 'Chuyên gia',
      minGivens: 27,
      maxGivens: 29,
      minHumanSolveSeconds: 22,
    }),
    master: Object.freeze({
      key: 'master',
      labelVi: 'Bậc thầy',
      minGivens: 24,
      maxGivens: 26,
      minHumanSolveSeconds: 26,
    }),
    extreme: Object.freeze({
      key: 'extreme',
      labelVi: 'Cực khó',
      minGivens: 22,
      maxGivens: 23,
      minHumanSolveSeconds: 30,
    }),
  });

export const MAX_SUDOKU_MISTAKES = 3;
export const SUDOKU_CELL_COUNT = 81;
const ALL_DIGITS_MASK = 0x3fe; // bits 1..9 set (0b11_1111_1110)

export type RandomFn = () => number;

function boxIndexFor(row: number, col: number): number {
  return Math.floor(row / 3) * 3 + Math.floor(col / 3);
}

function popcount9(mask: number): number {
  let count = 0;
  let m = mask;
  while (m !== 0) {
    m &= m - 1;
    count += 1;
  }
  return count;
}

function lowestDigitFromMask(mask: number): number {
  for (let d = 1; d <= 9; d += 1) {
    if ((mask & (1 << d)) !== 0) {
      return d;
    }
  }
  return 0;
}

function shuffleInPlace<T>(items: T[], rng: RandomFn): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

export function isValidPuzzleFormat(board81: string): boolean {
  return /^[0-9]{81}$/.test(board81);
}

export function isValidSolutionFormat(board81: string): boolean {
  return /^[1-9]{81}$/.test(board81);
}

export function parseSudokuBoard(board81: string): number[] {
  if (!isValidPuzzleFormat(board81)) {
    throw new Error('Bảng Sudoku phải gồm đúng 81 chữ số từ 0 đến 9.');
  }
  const cells = new Array<number>(SUDOKU_CELL_COUNT);
  for (let i = 0; i < SUDOKU_CELL_COUNT; i += 1) {
    cells[i] = board81.charCodeAt(i) - 48;
  }
  return cells;
}

export function serializeSudokuBoard(cells: readonly number[]): string {
  if (cells.length !== SUDOKU_CELL_COUNT) {
    throw new Error('Mảng bảng Sudoku phải gồm đúng 81 phần tử.');
  }
  let out = '';
  for (let i = 0; i < SUDOKU_CELL_COUNT; i += 1) {
    const val = cells[i] ?? 0;
    if (!Number.isInteger(val) || val < 0 || val > 9) {
      throw new Error('Giá trị ô Sudoku không hợp lệ.');
    }
    out += String(val);
  }
  return out;
}

/**
 * Kiểm tra một bảng 9x9 hoàn chỉnh (`1..9`) tuân thủ đúng luật Sudoku (mỗi hàng, cột, khối 3x3 đủ 1..9 không trùng).
 */
export function isValidSolvedSudokuGrid(cellsOrString: readonly number[] | string): boolean {
  const cells =
    typeof cellsOrString === 'string'
      ? isValidSolutionFormat(cellsOrString)
        ? parseSudokuBoard(cellsOrString)
        : null
      : cellsOrString;
  if (!cells || cells.length !== SUDOKU_CELL_COUNT) {
    return false;
  }

  const rowMasks = new Int32Array(9);
  const colMasks = new Int32Array(9);
  const boxMasks = new Int32Array(9);

  for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
    const digit = cells[idx] ?? 0;
    if (digit < 1 || digit > 9) {
      return false;
    }
    const r = Math.floor(idx / 9);
    const c = idx % 9;
    const b = boxIndexFor(r, c);
    const bit = 1 << digit;
    if ((rowMasks[r]! & bit) !== 0 || (colMasks[c]! & bit) !== 0 || (boxMasks[b]! & bit) !== 0) {
      return false;
    }
    rowMasks[r]! |= bit;
    colMasks[c]! |= bit;
    boxMasks[b]! |= bit;
  }

  return true;
}

function initBitmasks(cells: readonly number[]): {
  readonly rowMasks: Int32Array;
  readonly colMasks: Int32Array;
  readonly boxMasks: Int32Array;
} | null {
  const rowMasks = new Int32Array(9);
  const colMasks = new Int32Array(9);
  const boxMasks = new Int32Array(9);

  for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
    const d = cells[idx] ?? 0;
    if (d === 0) {
      continue;
    }
    if (d < 1 || d > 9) {
      return null;
    }
    const r = Math.floor(idx / 9);
    const c = idx % 9;
    const b = boxIndexFor(r, c);
    const bit = 1 << d;
    if ((rowMasks[r]! & bit) !== 0 || (colMasks[c]! & bit) !== 0 || (boxMasks[b]! & bit) !== 0) {
      return null;
    }
    rowMasks[r]! |= bit;
    colMasks[c]! |= bit;
    boxMasks[b]! |= bit;
  }

  return { rowMasks, colMasks, boxMasks };
}

/**
 * Đếm số lượng nghiệm hợp lệ của bảng Sudoku (dừng sớm ngay khi đạt `maxSolutions`, mặc định = 2).
 * Dùng chiến lược MRV (Minimum Remaining Values) + bitmask đạt tốc độ ~0.05ms/bảng.
 */
export function countSudokuSolutions(
  puzzleOrCells: string | readonly number[],
  maxSolutions = 2,
): number {
  const work =
    typeof puzzleOrCells === 'string' ? parseSudokuBoard(puzzleOrCells) : [...puzzleOrCells];
  const masks = initBitmasks(work);
  if (!masks) {
    return 0;
  }
  const { rowMasks, colMasks, boxMasks } = masks;
  let found = 0;

  function dfs(): void {
    if (found >= maxSolutions) {
      return;
    }

    let bestIdx = -1;
    let bestMask = 0;
    let bestCount = 10;

    for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
      if (work[idx] !== 0) {
        continue;
      }
      const r = Math.floor(idx / 9);
      const c = idx % 9;
      const b = boxIndexFor(r, c);
      const allowed = ~(rowMasks[r]! | colMasks[c]! | boxMasks[b]!) & ALL_DIGITS_MASK;
      if (allowed === 0) {
        return;
      }
      const cnt = popcount9(allowed);
      if (cnt < bestCount) {
        bestCount = cnt;
        bestIdx = idx;
        bestMask = allowed;
        if (cnt === 1) {
          break;
        }
      }
    }

    if (bestIdx === -1) {
      found += 1;
      return;
    }

    const r = Math.floor(bestIdx / 9);
    const c = bestIdx % 9;
    const b = boxIndexFor(r, c);

    for (let d = 1; d <= 9; d += 1) {
      const bit = 1 << d;
      if ((bestMask & bit) === 0) {
        continue;
      }
      work[bestIdx] = d;
      rowMasks[r]! |= bit;
      colMasks[c]! |= bit;
      boxMasks[b]! |= bit;

      dfs();

      work[bestIdx] = 0;
      rowMasks[r]! &= ~bit;
      colMasks[c]! &= ~bit;
      boxMasks[b]! &= ~bit;

      if (found >= maxSolutions) {
        return;
      }
    }
  }

  dfs();
  return found;
}

/**
 * Giải bảng Sudoku có nghiệm duy nhất và trả về chuỗi 81 ký tự `'1'..'9'` (hoặc `null` nếu vô nghiệm / đa nghiệm).
 */
export function solveUniqueSudoku(puzzle81: string): string | null {
  if (!isValidPuzzleFormat(puzzle81)) {
    return null;
  }
  const work = parseSudokuBoard(puzzle81);
  const masks = initBitmasks(work);
  if (!masks) {
    return null;
  }
  const { rowMasks, colMasks, boxMasks } = masks;
  let solutionSnapshot: number[] | null = null;
  let solutionCount = 0;

  function dfs(): void {
    if (solutionCount >= 2) {
      return;
    }

    let bestIdx = -1;
    let bestMask = 0;
    let bestCount = 10;

    for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
      if (work[idx] !== 0) {
        continue;
      }
      const r = Math.floor(idx / 9);
      const c = idx % 9;
      const b = boxIndexFor(r, c);
      const allowed = ~(rowMasks[r]! | colMasks[c]! | boxMasks[b]!) & ALL_DIGITS_MASK;
      if (allowed === 0) {
        return;
      }
      const cnt = popcount9(allowed);
      if (cnt < bestCount) {
        bestCount = cnt;
        bestIdx = idx;
        bestMask = allowed;
        if (cnt === 1) {
          break;
        }
      }
    }

    if (bestIdx === -1) {
      solutionCount += 1;
      if (solutionCount === 1) {
        solutionSnapshot = [...work];
      }
      return;
    }

    const r = Math.floor(bestIdx / 9);
    const c = bestIdx % 9;
    const b = boxIndexFor(r, c);

    for (let d = 1; d <= 9; d += 1) {
      const bit = 1 << d;
      if ((bestMask & bit) === 0) {
        continue;
      }
      work[bestIdx] = d;
      rowMasks[r]! |= bit;
      colMasks[c]! |= bit;
      boxMasks[b]! |= bit;

      dfs();

      work[bestIdx] = 0;
      rowMasks[r]! &= ~bit;
      colMasks[c]! &= ~bit;
      boxMasks[b]! &= ~bit;

      if (solutionCount >= 2) {
        return;
      }
    }
  }

  dfs();
  return solutionCount === 1 && solutionSnapshot ? serializeSudokuBoard(solutionSnapshot) : null;
}

function generateCompleteSolvedGrid(rng: RandomFn): number[] {
  const grid = new Array<number>(SUDOKU_CELL_COUNT).fill(0);
  const rowMasks = new Int32Array(9);
  const colMasks = new Int32Array(9);
  const boxMasks = new Int32Array(9);

  // Điền trước 3 khối chéo độc lập (0, 4, 8) bằng hoán vị ngẫu nhiên để tăng tốc Backtracking.
  for (const diagBox of [0, 4, 8]) {
    const digits = shuffleInPlace([1, 2, 3, 4, 5, 6, 7, 8, 9], rng);
    const baseRow = Math.floor(diagBox / 3) * 3;
    const baseCol = (diagBox % 3) * 3;
    let k = 0;
    for (let dr = 0; dr < 3; dr += 1) {
      for (let dc = 0; dc < 3; dc += 1) {
        const r = baseRow + dr;
        const c = baseCol + dc;
        const d = digits[k++]!;
        const bit = 1 << d;
        grid[r * 9 + c] = d;
        rowMasks[r]! |= bit;
        colMasks[c]! |= bit;
        boxMasks[diagBox]! |= bit;
      }
    }
  }

  function fillRemaining(): boolean {
    let bestIdx = -1;
    let bestMask = 0;
    let bestCount = 10;

    for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
      if (grid[idx] !== 0) {
        continue;
      }
      const r = Math.floor(idx / 9);
      const c = idx % 9;
      const b = boxIndexFor(r, c);
      const allowed = ~(rowMasks[r]! | colMasks[c]! | boxMasks[b]!) & ALL_DIGITS_MASK;
      if (allowed === 0) {
        return false;
      }
      const cnt = popcount9(allowed);
      if (cnt < bestCount) {
        bestCount = cnt;
        bestIdx = idx;
        bestMask = allowed;
        if (cnt === 1) {
          break;
        }
      }
    }

    if (bestIdx === -1) {
      return true;
    }

    const candidates: number[] = [];
    for (let d = 1; d <= 9; d += 1) {
      if ((bestMask & (1 << d)) !== 0) {
        candidates.push(d);
      }
    }
    shuffleInPlace(candidates, rng);

    const r = Math.floor(bestIdx / 9);
    const c = bestIdx % 9;
    const b = boxIndexFor(r, c);

    for (const d of candidates) {
      const bit = 1 << d;
      grid[bestIdx] = d;
      rowMasks[r]! |= bit;
      colMasks[c]! |= bit;
      boxMasks[b]! |= bit;

      if (fillRemaining()) {
        return true;
      }

      grid[bestIdx] = 0;
      rowMasks[r]! &= ~bit;
      colMasks[c]! &= ~bit;
      boxMasks[b]! &= ~bit;
    }

    return false;
  }

  fillRemaining();
  return grid;
}

export interface SudokuLogicGrade {
  readonly solvedBySinglesOnly: boolean;
  readonly openingNakedSingles: number;
  readonly hiddenSinglePlacements: number;
  readonly nakedPairEliminations: number;
  readonly stalledCellsAfterPairs: number;
  readonly complexityScore: number;
}

/**
 * Phân tích độ khó suy luận theo kỹ thuật giải của con người:
 * 1. Naked Singles (ô chỉ còn 1 ứng viên duy nhất)
 * 2. Hidden Singles (chữ số chỉ xuất hiện ở 1 ô duy nhất trong hàng/cột/khối 3x3)
 * 3. Naked Pairs (cặp ô cùng đơn vị chia sẻ đúng 2 ứng viên giúp loại trừ các ô còn lại)
 * 4. Số ô bế tắc sau các kỹ thuật cơ bản (đòi hỏi Pointing/Triples/X-Wing/chuỗi loại trừ sâu).
 */
export function gradeSudokuLogicComplexity(cells: readonly number[]): SudokuLogicGrade {
  const board = [...cells];
  const masks = initBitmasks(board);
  if (!masks) {
    return {
      solvedBySinglesOnly: false,
      openingNakedSingles: 0,
      hiddenSinglePlacements: 0,
      nakedPairEliminations: 0,
      stalledCellsAfterPairs: SUDOKU_CELL_COUNT,
      complexityScore: 0,
    };
  }
  const { rowMasks, colMasks, boxMasks } = masks;
  const cands = new Int32Array(SUDOKU_CELL_COUNT);

  for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
    if (board[idx] === 0) {
      const r = Math.floor(idx / 9);
      const c = idx % 9;
      const b = boxIndexFor(r, c);
      cands[idx] = ~(rowMasks[r]! | colMasks[c]! | boxMasks[b]!) & ALL_DIGITS_MASK;
    }
  }

  let openingNakedSingles = 0;
  for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
    if (board[idx] === 0 && popcount9(cands[idx]!) === 1) {
      openingNakedSingles += 1;
    }
  }

  const placeCell = (idx: number, digit: number): void => {
    board[idx] = digit;
    cands[idx] = 0;
    const bit = 1 << digit;
    const r = Math.floor(idx / 9);
    const c = idx % 9;
    const br = Math.floor(r / 3) * 3;
    const bc = Math.floor(c / 3) * 3;
    for (let i = 0; i < 9; i += 1) {
      cands[r * 9 + i]! &= ~bit;
      cands[i * 9 + c]! &= ~bit;
    }
    for (let dr = 0; dr < 3; dr += 1) {
      for (let dc = 0; dc < 3; dc += 1) {
        cands[(br + dr) * 9 + (bc + dc)]! &= ~bit;
      }
    }
  };

  const units: number[][] = [];
  for (let i = 0; i < 9; i += 1) {
    const rowUnit: number[] = [];
    const colUnit: number[] = [];
    const boxUnit: number[] = [];
    const br = Math.floor(i / 3) * 3;
    const bc = (i % 3) * 3;
    for (let j = 0; j < 9; j += 1) {
      rowUnit.push(i * 9 + j);
      colUnit.push(j * 9 + i);
      boxUnit.push((br + Math.floor(j / 3)) * 9 + (bc + (j % 3)));
    }
    units.push(rowUnit, colUnit, boxUnit);
  }

  let hiddenSinglePlacements = 0;
  let nakedPairEliminations = 0;
  let usedPairs = false;

  while (true) {
    let progressed = false;

    // Bước 1: Điền Naked Singles.
    for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
      if (board[idx] === 0 && popcount9(cands[idx]!) === 1) {
        placeCell(idx, lowestDigitFromMask(cands[idx]!));
        progressed = true;
      }
    }
    if (progressed) {
      continue;
    }

    // Bước 2: Tìm Hidden Singles trong từng hàng / cột / khối 3x3.
    for (const unit of units) {
      for (let d = 1; d <= 9; d += 1) {
        const bit = 1 << d;
        let spot = -1;
        let count = 0;
        for (const idx of unit) {
          if (board[idx] === d) {
            count = 0;
            break;
          }
          if (board[idx] === 0 && (cands[idx]! & bit) !== 0) {
            spot = idx;
            count += 1;
            if (count > 1) {
              break;
            }
          }
        }
        if (count === 1 && spot !== -1) {
          placeCell(spot, d);
          hiddenSinglePlacements += 1;
          progressed = true;
          break;
        }
      }
      if (progressed) {
        break;
      }
    }
    if (progressed) {
      continue;
    }

    // Bước 3: Naked Pairs trong từng đơn vị.
    for (const unit of units) {
      for (let a = 0; a < 9; a += 1) {
        const idxA = unit[a]!;
        const maskA = cands[idxA]!;
        if (board[idxA] !== 0 || popcount9(maskA) !== 2) {
          continue;
        }
        for (let b = a + 1; b < 9; b += 1) {
          const idxB = unit[b]!;
          if (board[idxB] === 0 && cands[idxB] === maskA) {
            for (const idxOther of unit) {
              if (idxOther !== idxA && idxOther !== idxB && board[idxOther] === 0) {
                const before = cands[idxOther]!;
                const after = before & ~maskA;
                if (after !== before) {
                  cands[idxOther] = after;
                  nakedPairEliminations += 1;
                  usedPairs = true;
                  progressed = true;
                }
              }
            }
          }
        }
      }
    }

    if (!progressed) {
      break;
    }
  }

  let stalledCellsAfterPairs = 0;
  for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
    if (board[idx] === 0) {
      stalledCellsAfterPairs += 1;
    }
  }

  const solvedBySinglesOnly = stalledCellsAfterPairs === 0 && !usedPairs;
  const emptyCount = cells.filter((v) => v === 0).length;
  const complexityScore =
    emptyCount * 4 +
    Math.max(0, 12 - openingNakedSingles) * 6 +
    hiddenSinglePlacements * 3 +
    nakedPairEliminations * 8 +
    stalledCellsAfterPairs * 12;

  return {
    solvedBySinglesOnly,
    openingNakedSingles,
    hiddenSinglePlacements,
    nakedPairEliminations,
    stalledCellsAfterPairs,
    complexityScore,
  };
}

function carveUniquePuzzleToTargetGivens(
  solutionGrid: readonly number[],
  targetGivens: number,
  useSymmetricPairs: boolean,
  rng: RandomFn,
): { readonly puzzle: number[]; readonly givens: number } {
  const puzzle = [...solutionGrid];
  let givens = SUDOKU_CELL_COUNT;

  if (useSymmetricPairs) {
    // Khử theo cặp đối xứng tâm (idx và 80 - idx) để tạo hình thái bảng cân đối kiểu cổ điển trước,
    // sau đó tinh chỉnh từng ô đơn lẻ cho khớp chính xác số gợi ý mục tiêu.
    const halfIndices = shuffleInPlace(
      Array.from({ length: 41 }, (_, i) => i),
      rng,
    );
    for (const idx of halfIndices) {
      if (givens <= targetGivens) {
        break;
      }
      const mirror = 80 - idx;
      const removeCount = idx === mirror ? 1 : 2;
      if (givens - removeCount < targetGivens) {
        continue;
      }
      const savedA = puzzle[idx]!;
      const savedB = puzzle[mirror]!;
      puzzle[idx] = 0;
      puzzle[mirror] = 0;
      if (countSudokuSolutions(puzzle, 2) === 1) {
        givens -= removeCount;
      } else {
        puzzle[idx] = savedA;
        puzzle[mirror] = savedB;
      }
    }
  }

  if (givens > targetGivens) {
    const singleOrder = shuffleInPlace(
      Array.from({ length: SUDOKU_CELL_COUNT }, (_, i) => i).filter((i) => puzzle[i] !== 0),
      rng,
    );
    for (const idx of singleOrder) {
      if (givens <= targetGivens) {
        break;
      }
      const saved = puzzle[idx]!;
      puzzle[idx] = 0;
      if (countSudokuSolutions(puzzle, 2) === 1) {
        givens -= 1;
      } else {
        puzzle[idx] = saved;
      }
    }
  }

  return { puzzle, givens };
}

export interface GeneratedSudokuPuzzle {
  readonly difficulty: SudokuDifficulty;
  readonly puzzle: string;
  readonly solution: string;
  readonly givensCount: number;
  readonly logicGrade: SudokuLogicGrade;
}

/**
 * Sinh bảng Sudoku chuẩn có nghiệm duy nhất theo đúng 1 trong 6 độ khó:
 * `easy` (Dễ), `medium` (Trung bình), `hard` (Khó), `expert` (Chuyên gia), `master` (Bậc thầy), `extreme` (Cực khó).
 */
export function generateUniqueSudoku(
  difficulty: SudokuDifficulty,
  rng: RandomFn = Math.random,
): GeneratedSudokuPuzzle {
  const meta = SUDOKU_DIFFICULTY_META[difficulty];
  const attempts =
    difficulty === 'extreme' || difficulty === 'master'
      ? 6
      : difficulty === 'expert' || difficulty === 'hard'
        ? 4
        : 2;

  let bestCandidate: {
    readonly puzzleCells: number[];
    readonly solutionCells: number[];
    readonly givens: number;
    readonly grade: SudokuLogicGrade;
    readonly rankScore: number;
  } | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const solutionCells = generateCompleteSolvedGrid(rng);
    const span = meta.maxGivens - meta.minGivens + 1;
    const targetGivens = meta.minGivens + Math.floor(rng() * span);
    const useSymmetric = difficulty === 'easy' || difficulty === 'medium';

    const carved = carveUniquePuzzleToTargetGivens(solutionCells, targetGivens, useSymmetric, rng);

    // Nếu lần đục lỗ cực khó (22-23 gợi ý) dừng ở 24 gợi ý do ràng buộc nghiệm duy nhất,
    // ưu tiên bản đạt đúng dải [minGivens, maxGivens].
    const grade = gradeSudokuLogicComplexity(carved.puzzle);
    const inTargetBand = carved.givens >= meta.minGivens && carved.givens <= meta.maxGivens;

    let rankScore = inTargetBand ? 1_000 : -Math.abs(carved.givens - meta.maxGivens) * 100;
    if (difficulty === 'easy') {
      rankScore += (grade.solvedBySinglesOnly ? 500 : 0) + grade.openingNakedSingles * 15;
    } else if (difficulty === 'medium') {
      rankScore +=
        (grade.solvedBySinglesOnly ? 300 : 0) - Math.abs(grade.openingNakedSingles - 4) * 10;
    } else {
      rankScore += grade.complexityScore;
    }

    if (!bestCandidate || rankScore > bestCandidate.rankScore) {
      bestCandidate = {
        puzzleCells: carved.puzzle,
        solutionCells,
        givens: carved.givens,
        grade,
        rankScore,
      };
    }

    // Với Dễ & Trung bình, dừng ngay khi tìm được bảng đạt chuẩn trong dải gợi ý để tiết kiệm CPU.
    if (
      inTargetBand &&
      ((difficulty === 'easy' && grade.solvedBySinglesOnly && grade.openingNakedSingles >= 4) ||
        (difficulty === 'medium' && grade.solvedBySinglesOnly))
    ) {
      break;
    }
  }

  const chosen = bestCandidate!;
  return {
    difficulty,
    puzzle: serializeSudokuBoard(chosen.puzzleCells),
    solution: serializeSudokuBoard(chosen.solutionCells),
    givensCount: chosen.givens,
    logicGrade: chosen.grade,
  };
}

// ============================================================================
// Tiện ích tương tác Bàn chơi Sudoku (Ghi chú ứng viên, Tẩy, Tô sáng ô liên quan)
// ============================================================================

export function hasCandidateNote(noteMask: number, digit: number): boolean {
  if (digit < 1 || digit > 9) {
    return false;
  }
  return (noteMask & (1 << digit)) !== 0;
}

export function toggleCandidateNote(noteMask: number, digit: number): number {
  if (digit < 1 || digit > 9) {
    return noteMask;
  }
  return noteMask ^ (1 << digit);
}

/**
 * Khi người chơi điền ĐÚNG chữ số `digit` vào ô `(row, col)`:
 * xóa toàn bộ ghi chú của chính ô đó VÀ tự động gỡ chữ số `digit` khỏi ghi chú của các ô cùng hàng, cùng cột và cùng khối 3x3.
 */
export function clearPeerCandidateNotes(
  noteMasks: readonly number[],
  cellIndex: number,
  digit: number,
): number[] {
  const next = [...noteMasks];
  if (cellIndex < 0 || cellIndex >= SUDOKU_CELL_COUNT || digit < 1 || digit > 9) {
    return next;
  }

  next[cellIndex] = 0;
  const clearBit = ~(1 << digit);
  const r = Math.floor(cellIndex / 9);
  const c = cellIndex % 9;
  const br = Math.floor(r / 3) * 3;
  const bc = Math.floor(c / 3) * 3;

  for (let i = 0; i < 9; i += 1) {
    next[r * 9 + i] = (next[r * 9 + i] ?? 0) & clearBit;
    next[i * 9 + c] = (next[i * 9 + c] ?? 0) & clearBit;
  }
  for (let dr = 0; dr < 3; dr += 1) {
    for (let dc = 0; dc < 3; dc += 1) {
      const peerIdx = (br + dr) * 9 + (bc + dc);
      next[peerIdx] = (next[peerIdx] ?? 0) & clearBit;
    }
  }

  return next;
}

export function areSudokuPeerCells(indexA: number, indexB: number): boolean {
  if (indexA < 0 || indexB < 0 || indexA === indexB) {
    return false;
  }
  const rA = Math.floor(indexA / 9);
  const cA = indexA % 9;
  const rB = Math.floor(indexB / 9);
  const cB = indexB % 9;
  return rA === rB || cA === cB || boxIndexFor(rA, cA) === boxIndexFor(rB, cB);
}

export function countRemainingDigits(
  currentCells: readonly number[],
  solutionCells: readonly number[],
): Readonly<Record<number, number>> {
  const counts: Record<number, number> = {
    1: 9,
    2: 9,
    3: 9,
    4: 9,
    5: 9,
    6: 9,
    7: 9,
    8: 9,
    9: 9,
  };
  for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
    const val = currentCells[idx] ?? 0;
    if (val >= 1 && val <= 9 && val === solutionCells[idx]) {
      counts[val] = Math.max(0, (counts[val] ?? 0) - 1);
    }
  }
  return counts;
}

export function formatSudokuDurationClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
