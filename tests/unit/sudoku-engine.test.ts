import { describe, expect, it } from 'vitest';

import {
  SUDOKU_CELL_COUNT,
  SUDOKU_DIFFICULTIES,
  SUDOKU_DIFFICULTY_META,
  areSudokuPeerCells,
  clearPeerCandidateNotes,
  countRemainingDigits,
  countSudokuSolutions,
  formatSudokuDurationClock,
  generateUniqueSudoku,
  gradeSudokuLogicComplexity,
  hasCandidateNote,
  isValidPuzzleFormat,
  isValidSolvedSudokuGrid,
  parseSudokuBoard,
  solveUniqueSudoku,
  toggleCandidateNote,
  type RandomFn,
} from '@/lib/sudoku/engine';

function createMulberry32(seed: number): RandomFn {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('Sudoku Engine — Sinh bảng nghiệm duy nhất 6 độ khó & tiện ích bàn chơi', () => {
  it('sinh bảng hợp lệ và đảm bảo đúng 1 nghiệm duy nhất trên cả 6 cấp độ (Dễ -> Cực khó)', () => {
    const rng = createMulberry32(20261127);
    const givensByDiff: Record<string, number> = {};

    for (const diff of SUDOKU_DIFFICULTIES) {
      const generated = generateUniqueSudoku(diff, rng);
      const meta = SUDOKU_DIFFICULTY_META[diff];

      expect(generated.difficulty).toBe(diff);
      expect(isValidPuzzleFormat(generated.puzzle)).toBe(true);
      expect(isValidSolvedSudokuGrid(generated.solution)).toBe(true);

      // Mọi chữ số gợi ý trong đề bài phải khớp tuyệt đối với bảng lời giải.
      const puzzleCells = parseSudokuBoard(generated.puzzle);
      const solutionCells = parseSudokuBoard(generated.solution);
      let actualGivens = 0;
      for (let i = 0; i < SUDOKU_CELL_COUNT; i += 1) {
        const clue = puzzleCells[i]!;
        if (clue !== 0) {
          actualGivens += 1;
          expect(clue).toBe(solutionCells[i]);
        }
      }

      expect(actualGivens).toBe(generated.givensCount);
      // Bắt buộc có ĐÚNG 1 nghiệm duy nhất và giải ngược ra trùng khớp lời giải gốc.
      expect(countSudokuSolutions(generated.puzzle, 2)).toBe(1);
      expect(solveUniqueSudoku(generated.puzzle)).toBe(generated.solution);

      // Ràng buộc số ô cho trước nằm trong ngưỡng thiết kế (cho phép tối đa +2 ở Cực khó nếu gặp ngưỡng nghiệm duy nhất tối tiểu).
      expect(actualGivens).toBeGreaterThanOrEqual(meta.minGivens);
      expect(actualGivens).toBeLessThanOrEqual(meta.maxGivens + 2);

      const grade = gradeSudokuLogicComplexity(puzzleCells);
      expect(grade.complexityScore).toBeGreaterThan(0);
      givensByDiff[diff] = actualGivens;
    }

    expect(givensByDiff.easy!).toBeGreaterThan(givensByDiff.hard!);
    expect(givensByDiff.hard!).toBeGreaterThan(givensByDiff.extreme!);
  });

  it('từ chối giải các bảng đa nghiệm hoặc vi phạm luật trùng chữ số trên cùng hàng/cột/khối 3x3', () => {
    const emptyBoard = '0'.repeat(81);
    expect(countSudokuSolutions(emptyBoard, 2)).toBe(2);
    expect(solveUniqueSudoku(emptyBoard)).toBeNull();

    // Hai số 5 nằm cùng hàng đầu tiên -> vô nghiệm (0).
    const invalidBoard = `55${'0'.repeat(79)}`;
    expect(countSudokuSolutions(invalidBoard, 2)).toBe(0);
    expect(solveUniqueSudoku(invalidBoard)).toBeNull();
    expect(isValidSolvedSudokuGrid('1'.repeat(81))).toBe(false);
  });

  it('bật/tắt Ghi chú ứng viên và tự động xóa số ứng viên trùng ở hàng, cột, khối 3x3 khi điền đúng', () => {
    let mask = 0;
    mask = toggleCandidateNote(mask, 4);
    mask = toggleCandidateNote(mask, 9);
    expect(hasCandidateNote(mask, 4)).toBe(true);
    expect(hasCandidateNote(mask, 9)).toBe(true);
    expect(hasCandidateNote(mask, 1)).toBe(false);

    // Bấm lại số 4 sẽ tắt ghi chú số 4, giữ nguyên số 9.
    mask = toggleCandidateNote(mask, 4);
    expect(hasCandidateNote(mask, 4)).toBe(false);
    expect(hasCandidateNote(mask, 9)).toBe(true);

    // Giả lập lưới ghi chú: đặt ghi chú {5, 7} vào toàn bộ 81 ô, sau đó điền đúng số 5 vào ô (row=4, col=4 -> idx=40, khối trung tâm).
    const initialNotes = new Array<number>(SUDOKU_CELL_COUNT).fill((1 << 5) | (1 << 7));
    const afterPlace = clearPeerCandidateNotes(initialNotes, 40, 5);

    // Chính ô 40 phải sạch hoàn toàn mọi ghi chú.
    expect(afterPlace[40]).toBe(0);

    for (let idx = 0; idx < SUDOKU_CELL_COUNT; idx += 1) {
      if (idx === 40) {
        continue;
      }
      if (areSudokuPeerCells(40, idx)) {
        // Ô cùng hàng 4, cột 4 hoặc khối trung tâm bị xóa ứng viên 5 nhưng vẫn giữ ứng viên 7.
        expect(hasCandidateNote(afterPlace[idx]!, 5)).toBe(false);
        expect(hasCandidateNote(afterPlace[idx]!, 7)).toBe(true);
      } else {
        // Ô ngoài vùng liên đới giữ nguyên cả 5 và 7.
        expect(hasCandidateNote(afterPlace[idx]!, 5)).toBe(true);
        expect(hasCandidateNote(afterPlace[idx]!, 7)).toBe(true);
      }
    }
  });

  it('tính chính xác số lượng chữ số còn thiếu trên bàn phím 1–9 và định dạng đồng hồ thời gian', () => {
    const rng = createMulberry32(99);
    const sample = generateUniqueSudoku('easy', rng);
    const puzzleCells = parseSudokuBoard(sample.puzzle);
    const solutionCells = parseSudokuBoard(sample.solution);

    const initialRemaining = countRemainingDigits(puzzleCells, solutionCells);
    const totalMissing = Object.values(initialRemaining).reduce((acc, v) => acc + v, 0);
    expect(totalMissing).toBe(SUDOKU_CELL_COUNT - sample.givensCount);

    // Khi toàn bộ 81 ô đã giải đúng -> cả 9 chữ số đều còn 0.
    const solvedRemaining = countRemainingDigits(solutionCells, solutionCells);
    for (let d = 1; d <= 9; d += 1) {
      expect(solvedRemaining[d]).toBe(0);
    }

    expect(formatSudokuDurationClock(0)).toBe('00:00');
    expect(formatSudokuDurationClock(65)).toBe('01:05');
    expect(formatSudokuDurationClock(3661)).toBe('1:01:01');
  });
});
