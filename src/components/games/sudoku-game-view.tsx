'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Award,
  CheckCircle2,
  Eraser,
  Flame,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trophy,
  XCircle,
} from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { ConfirmDialog } from '@/components/social/confirm-dialog';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth-client';
import {
  MAX_SUDOKU_MISTAKES,
  SUDOKU_CELL_COUNT,
  SUDOKU_DIFFICULTIES,
  SUDOKU_DIFFICULTY_META,
  areSudokuPeerCells,
  clearPeerCandidateNotes,
  countRemainingDigits,
  formatSudokuDurationClock,
  hasCandidateNote,
  parseSudokuBoard,
  serializeSudokuBoard,
  solveUniqueSudoku,
  toggleCandidateNote,
  type SudokuDifficulty,
} from '@/lib/sudoku/engine';
import { cn } from '@/lib/utils';
import type {
  CompleteSudokuGameResult,
  StartSudokuGameResult,
  SudokuLeaderboardResult,
  SudokuPersonalDifficultyRecordDto,
  SudokuPersonalRecordsResult,
} from '@/modules/games';

type BoardLifecycleStatus = 'loading' | 'playing' | 'submitting' | 'won' | 'lost' | 'error';

type PendingRestartIntent =
  | { readonly kind: 'change_difficulty'; readonly difficulty: SudokuDifficulty }
  | { readonly kind: 'new_game' };

const DIGIT_LIST = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function createEmptyRecordsMap(): Record<SudokuDifficulty, SudokuPersonalDifficultyRecordDto> {
  const initial = {} as Record<SudokuDifficulty, SudokuPersonalDifficultyRecordDto>;
  for (const diff of SUDOKU_DIFFICULTIES) {
    initial[diff] = {
      difficulty: diff,
      bestTimeSeconds: null,
      gamesWon: 0,
      achievedAt: null,
    };
  }
  return initial;
}

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      readonly error?: { readonly message?: string };
    };
    if (body?.error?.message) {
      return body.error.message;
    }
  } catch {
    // Giữ thông báo mặc định nếu phản hồi không phải JSON.
  }
  return fallback;
}

export function SudokuGameView() {
  const boardScopeRef = React.useRef<HTMLDivElement | null>(null);
  const startRequestSeqRef = React.useRef(0);
  const completeTriggeredRef = React.useRef(false);

  const [difficulty, setDifficulty] = React.useState<SudokuDifficulty>('easy');
  const [gamePublicId, setGamePublicId] = React.useState<string | null>(null);
  const [givenCells, setGivenCells] = React.useState<readonly number[]>(() =>
    new Array<number>(SUDOKU_CELL_COUNT).fill(0),
  );
  const [currentCells, setCurrentCells] = React.useState<readonly number[]>(() =>
    new Array<number>(SUDOKU_CELL_COUNT).fill(0),
  );
  const [solutionCells, setSolutionCells] = React.useState<readonly number[]>(() =>
    new Array<number>(SUDOKU_CELL_COUNT).fill(0),
  );
  const [noteMasks, setNoteMasks] = React.useState<readonly number[]>(() =>
    new Array<number>(SUDOKU_CELL_COUNT).fill(0),
  );

  const [selectedCell, setSelectedCell] = React.useState<number | null>(null);
  const [notesMode, setNotesMode] = React.useState(false);
  const [mistakes, setMistakes] = React.useState(0);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const [isPaused, setIsPaused] = React.useState(false);
  const [isTabVisible, setIsTabVisible] = React.useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );
  const [hasMadeMove, setHasMadeMove] = React.useState(false);

  const [boardStatus, setBoardStatus] = React.useState<BoardLifecycleStatus>('loading');
  const [boardErrorMessage, setBoardErrorMessage] = React.useState<string | null>(null);
  const [victorySummary, setVictorySummary] = React.useState<CompleteSudokuGameResult | null>(null);
  const [completionWarning, setCompletionWarning] = React.useState<string | null>(null);
  const [pendingRestartIntent, setPendingRestartIntent] =
    React.useState<PendingRestartIntent | null>(null);

  const [personalRecords, setPersonalRecords] = React.useState<
    Readonly<Record<SudokuDifficulty, SudokuPersonalDifficultyRecordDto>>
  >(() => createEmptyRecordsMap());
  const [loadingRecords, setLoadingRecords] = React.useState(true);

  const [leaderboardTab, setLeaderboardTab] = React.useState<SudokuDifficulty>('easy');
  const [leaderboardsByDiff, setLeaderboardsByDiff] = React.useState<
    Partial<Record<SudokuDifficulty, SudokuLeaderboardResult>>
  >({});
  const loadedLeaderboardsRef = React.useRef<
    Partial<Record<SudokuDifficulty, SudokuLeaderboardResult>>
  >({});
  const [loadingLeaderboardDiff, setLoadingLeaderboardDiff] =
    React.useState<SudokuDifficulty | null>('easy');
  const [leaderboardError, setLeaderboardError] = React.useState<string | null>(null);

  const fetchPersonalRecords = React.useCallback(async () => {
    try {
      const response = await authFetch('/api/v1/games/sudoku/records', { method: 'GET' });
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as SudokuPersonalRecordsResult;
      if (data?.records) {
        setPersonalRecords(data.records);
      }
    } catch {
      // Giữ trạng thái kỉ lục hiện tại nếu mạng chập chờn tạm thời.
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  const fetchLeaderboardForDifficulty = React.useCallback(
    async (
      targetDiff: SudokuDifficulty,
      options?: { readonly force?: boolean; readonly fromEffect?: boolean },
    ) => {
      if (!options?.force && loadedLeaderboardsRef.current[targetDiff]) {
        return;
      }
      if (!options?.fromEffect) {
        setLoadingLeaderboardDiff(targetDiff);
        setLeaderboardError(null);
      }
      try {
        const response = await authFetch(
          `/api/v1/games/sudoku/leaderboard?difficulty=${encodeURIComponent(targetDiff)}&limit=50`,
          { method: 'GET' },
        );
        if (!response.ok) {
          const msg = await readApiErrorMessage(response, 'Không thể tải bảng xếp hạng lúc này.');
          setLeaderboardError(msg);
          return;
        }
        const data = (await response.json()) as SudokuLeaderboardResult;
        loadedLeaderboardsRef.current = {
          ...loadedLeaderboardsRef.current,
          [targetDiff]: data,
        };
        setLeaderboardsByDiff((prev) => ({
          ...prev,
          [targetDiff]: data,
        }));
      } catch {
        setLeaderboardError('Không thể kết nối để tải bảng xếp hạng.');
      } finally {
        setLoadingLeaderboardDiff((current) => (current === targetDiff ? null : current));
      }
    },
    [],
  );

  const loadSudokuSessionFromApi = React.useCallback(
    async (targetDifficulty: SudokuDifficulty, seq: number) => {
      try {
        const response = await authFetch('/api/v1/games/sudoku/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ difficulty: targetDifficulty }),
        });

        if (seq !== startRequestSeqRef.current) {
          return;
        }

        if (!response.ok) {
          const msg = await readApiErrorMessage(
            response,
            'Không thể khởi tạo ván Sudoku mới. Vui lòng thử lại.',
          );
          setBoardErrorMessage(msg);
          setBoardStatus('error');
          return;
        }

        const payload = (await response.json()) as StartSudokuGameResult;
        const solved = solveUniqueSudoku(payload.puzzle);
        if (!solved) {
          setBoardErrorMessage('Không thể chuẩn bị bảng số lúc này. Vui lòng tạo ván mới.');
          setBoardStatus('error');
          return;
        }

        const parsedPuzzle = parseSudokuBoard(payload.puzzle);
        const parsedSolution = parseSudokuBoard(solved);
        const firstEmptyIdx = parsedPuzzle.findIndex((val) => val === 0);

        setGamePublicId(payload.gamePublicId);
        setGivenCells(parsedPuzzle);
        setCurrentCells(parsedPuzzle);
        setSolutionCells(parsedSolution);
        setSelectedCell(firstEmptyIdx >= 0 ? firstEmptyIdx : 0);
        setBoardStatus('playing');
      } catch {
        if (seq !== startRequestSeqRef.current) {
          return;
        }
        setBoardErrorMessage('Mất kết nối tạm thời khi tạo ván chơi. Vui lòng thử lại.');
        setBoardStatus('error');
      }
    },
    [],
  );

  const startNewSudokuSession = React.useCallback(
    async (targetDifficulty: SudokuDifficulty) => {
      const seq = ++startRequestSeqRef.current;
      completeTriggeredRef.current = false;

      setDifficulty(targetDifficulty);
      setBoardStatus('loading');
      setBoardErrorMessage(null);
      setCompletionWarning(null);
      setVictorySummary(null);
      setIsPaused(false);
      setMistakes(0);
      setElapsedSeconds(0);
      setHasMadeMove(false);
      setNoteMasks(new Array<number>(SUDOKU_CELL_COUNT).fill(0));

      await loadSudokuSessionFromApi(targetDifficulty, seq);
    },
    [loadSudokuSessionFromApi],
  );

  React.useEffect(() => {
    let cancelled = false;
    const timerId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      const seq = ++startRequestSeqRef.current;
      completeTriggeredRef.current = false;
      void loadSudokuSessionFromApi('easy', seq);
      void fetchPersonalRecords();
      void fetchLeaderboardForDifficulty('easy', { fromEffect: true });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [loadSudokuSessionFromApi, fetchPersonalRecords, fetchLeaderboardForDifficulty]);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const syncVisibility = () => {
      setIsTabVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  React.useEffect(() => {
    if (boardStatus !== 'playing' || isPaused || !isTabVisible) {
      return;
    }
    const timerId = window.setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timerId);
  }, [boardStatus, isPaused, isTabVisible]);

  const submitCompletedBoard = React.useCallback(
    async (params: {
      readonly activeGamePublicId: string;
      readonly activeDifficulty: SudokuDifficulty;
      readonly finalCells: readonly number[];
      readonly finalMistakes: number;
      readonly finalElapsedSeconds: number;
    }) => {
      if (completeTriggeredRef.current) {
        return;
      }
      completeTriggeredRef.current = true;
      setBoardStatus('submitting');
      setCompletionWarning(null);

      const safeElapsed = Math.max(1, params.finalElapsedSeconds);
      try {
        const response = await authFetch(
          `/api/v1/games/sudoku/games/${encodeURIComponent(params.activeGamePublicId)}/complete`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              finalBoard: serializeSudokuBoard(params.finalCells),
              mistakesCount: params.finalMistakes,
              elapsedSeconds: safeElapsed,
            }),
          },
        );

        if (!response.ok) {
          const msg = await readApiErrorMessage(
            response,
            'Bạn đã giải xong bảng số nhưng chưa thể lưu kỉ lục lúc này.',
          );
          setCompletionWarning(msg);
          setBoardStatus('won');
          return;
        }

        const result = (await response.json()) as CompleteSudokuGameResult;
        setVictorySummary(result);
        setElapsedSeconds(result.elapsedSeconds);
        setBoardStatus('won');
        setLeaderboardTab(params.activeDifficulty);

        await Promise.all([
          fetchPersonalRecords(),
          fetchLeaderboardForDifficulty(params.activeDifficulty, { force: true }),
        ]);
      } catch {
        setCompletionWarning(
          'Bạn đã hoàn thành bảng số nhưng kết nối mạng bị gián đoạn khi lưu kỉ lục.',
        );
        setBoardStatus('won');
      }
    },
    [fetchPersonalRecords, fetchLeaderboardForDifficulty],
  );

  const handleEraseSelectedCell = React.useCallback(() => {
    if (boardStatus !== 'playing' || isPaused || selectedCell === null) {
      return;
    }
    if ((givenCells[selectedCell] ?? 0) !== 0) {
      return;
    }

    const currentVal = currentCells[selectedCell] ?? 0;
    const currentMask = noteMasks[selectedCell] ?? 0;
    if (currentVal === 0 && currentMask === 0) {
      return;
    }

    setHasMadeMove(true);
    if (currentVal !== 0) {
      setCurrentCells((prev) => {
        const next = [...prev];
        next[selectedCell] = 0;
        return next;
      });
    } else {
      setNoteMasks((prev) => {
        const next = [...prev];
        next[selectedCell] = 0;
        return next;
      });
    }
  }, [boardStatus, isPaused, selectedCell, givenCells, currentCells, noteMasks]);

  const handleDigitInput = React.useCallback(
    (digit: number) => {
      if (
        boardStatus !== 'playing' ||
        isPaused ||
        selectedCell === null ||
        digit < 1 ||
        digit > 9 ||
        !gamePublicId
      ) {
        return;
      }

      // Ô đề bài gốc không thể ghi đè.
      if ((givenCells[selectedCell] ?? 0) !== 0) {
        return;
      }

      const currentVal = currentCells[selectedCell] ?? 0;
      const expectedDigit = solutionCells[selectedCell] ?? 0;

      // Chế độ Ghi chú: chỉ bật/tắt số ứng viên nhỏ trong ô trống (hoặc xóa số điền sai trước khi ghi chú).
      if (notesMode) {
        // Nếu ô đã điền đúng đáp án chính thức, không ghi đè thành ghi chú để tránh mất kết quả.
        if (currentVal !== 0 && currentVal === expectedDigit) {
          return;
        }
        setHasMadeMove(true);
        if (currentVal !== 0) {
          setCurrentCells((prev) => {
            const next = [...prev];
            next[selectedCell] = 0;
            return next;
          });
        }
        setNoteMasks((prev) => {
          const next = [...prev];
          next[selectedCell] = toggleCandidateNote(next[selectedCell] ?? 0, digit);
          return next;
        });
        return;
      }

      // Chế độ Điền đáp án chính thức: bỏ qua nếu người chơi bấm lại đúng chữ số đang có trong ô.
      if (currentVal === digit) {
        return;
      }

      // Nếu ô đã điền đúng chữ số đáp án từ trước, khóa an toàn để tránh bấm nhầm bị tính lỗi oan.
      if (currentVal !== 0 && currentVal === expectedDigit) {
        return;
      }

      setHasMadeMove(true);
      const nextCells = [...currentCells];
      nextCells[selectedCell] = digit;
      setCurrentCells(nextCells);

      if (digit === expectedDigit) {
        setNoteMasks((prev) => clearPeerCandidateNotes(prev, selectedCell, digit));

        const isAllSolved = nextCells.every(
          (value, idx) => value !== 0 && value === solutionCells[idx],
        );
        if (isAllSolved) {
          void submitCompletedBoard({
            activeGamePublicId: gamePublicId,
            activeDifficulty: difficulty,
            finalCells: nextCells,
            finalMistakes: mistakes,
            finalElapsedSeconds: elapsedSeconds,
          });
        }
        return;
      }

      // Điền sai đáp án: xóa ghi chú của ô đó và tăng bộ đếm lỗi (tối đa 3 lỗi).
      setNoteMasks((prev) => {
        if ((prev[selectedCell] ?? 0) === 0) {
          return prev;
        }
        const next = [...prev];
        next[selectedCell] = 0;
        return next;
      });

      const nextMistakes = mistakes + 1;
      setMistakes(nextMistakes);
      if (nextMistakes >= MAX_SUDOKU_MISTAKES) {
        setBoardStatus('lost');
      }
    },
    [
      boardStatus,
      isPaused,
      selectedCell,
      gamePublicId,
      givenCells,
      currentCells,
      solutionCells,
      notesMode,
      difficulty,
      mistakes,
      elapsedSeconds,
      submitCompletedBoard,
    ],
  );

  // Phím tắt bàn phím (1–9, Backspace/Delete, Mũi tên, N) — tự động nhường hoàn toàn khi người dùng đang gõ tin nhắn ở Cửa sổ chat nổi, ô tìm kiếm hoặc hộp thoại.
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (boardStatus !== 'playing' || isPaused) {
        return;
      }
      if (
        typeof document !== 'undefined' &&
        document.querySelector('[role="dialog"][aria-modal="true"]') !== null
      ) {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      const activeEl =
        typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      for (const el of [target, activeEl]) {
        if (!el) {
          continue;
        }
        if (
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable ||
          el.closest('[role="dialog"], [role="menu"], [role="listbox"]')
        ) {
          return;
        }
      }

      // Nếu tiêu điểm đang nằm ở thành phần ngoài khu vực trang Sudoku (ví dụ: Cửa sổ Tin nhắn nổi hoặc Thanh tìm kiếm trên đỉnh), không bắt phím.
      if (
        activeEl &&
        activeEl !== document.body &&
        boardScopeRef.current &&
        !boardScopeRef.current.contains(activeEl)
      ) {
        return;
      }

      if (event.key >= '1' && event.key <= '9') {
        event.preventDefault();
        handleDigitInput(Number(event.key));
        return;
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        handleEraseSelectedCell();
        return;
      }

      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        setNotesMode((prev) => !prev);
        return;
      }

      if (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight'
      ) {
        event.preventDefault();
        setSelectedCell((prev) => {
          const base = prev ?? 0;
          const row = Math.floor(base / 9);
          const col = base % 9;
          if (event.key === 'ArrowUp') {
            return ((row + 8) % 9) * 9 + col;
          }
          if (event.key === 'ArrowDown') {
            return ((row + 1) % 9) * 9 + col;
          }
          if (event.key === 'ArrowLeft') {
            return row * 9 + ((col + 8) % 9);
          }
          return row * 9 + ((col + 1) % 9);
        });
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [boardStatus, isPaused, handleDigitInput, handleEraseSelectedCell]);

  const requestDifficultySwitch = (nextDiff: SudokuDifficulty) => {
    if (nextDiff === difficulty && boardStatus === 'playing' && !hasMadeMove) {
      return;
    }
    if (boardStatus === 'playing' && hasMadeMove) {
      setPendingRestartIntent({ kind: 'change_difficulty', difficulty: nextDiff });
      return;
    }
    setLeaderboardTab(nextDiff);
    void fetchLeaderboardForDifficulty(nextDiff);
    void startNewSudokuSession(nextDiff);
  };

  const requestFreshGame = () => {
    if (boardStatus === 'playing' && hasMadeMove) {
      setPendingRestartIntent({ kind: 'new_game' });
      return;
    }
    void startNewSudokuSession(difficulty);
  };

  const confirmPendingRestart = () => {
    const intent = pendingRestartIntent;
    setPendingRestartIntent(null);
    if (!intent) {
      return;
    }
    if (intent.kind === 'change_difficulty') {
      setLeaderboardTab(intent.difficulty);
      void fetchLeaderboardForDifficulty(intent.difficulty);
      void startNewSudokuSession(intent.difficulty);
      return;
    }
    void startNewSudokuSession(difficulty);
  };

  const handleSelectLeaderboardTab = (nextDiff: SudokuDifficulty) => {
    setLeaderboardTab(nextDiff);
    void fetchLeaderboardForDifficulty(nextDiff);
  };

  const remainingDigits = React.useMemo(
    () => countRemainingDigits(currentCells, solutionCells),
    [currentCells, solutionCells],
  );

  const selectedCellDigit =
    selectedCell !== null && !isPaused ? (currentCells[selectedCell] ?? 0) : 0;
  const activeDifficultyMeta = SUDOKU_DIFFICULTY_META[difficulty];
  const currentDifficultyBest = personalRecords[difficulty]?.bestTimeSeconds ?? null;
  const activeLeaderboard = leaderboardsByDiff[leaderboardTab] ?? null;
  const isLeaderboardLoading = loadingLeaderboardDiff === leaderboardTab && !activeLeaderboard;

  return (
    <div ref={boardScopeRef} className="space-y-8 pb-12">
      {/* Thanh điều hướng quay lại & Tiêu đề */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Link
            href="/games"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            <span>Trò chơi</span>
          </Link>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-[26px]">
            Sudoku
          </h1>
        </div>

        {/* Thanh chọn 6 độ khó */}
        <div
          role="group"
          aria-label="Chọn độ khó Sudoku"
          className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-border/70 bg-card p-1.5 shadow-2xs"
        >
          {SUDOKU_DIFFICULTIES.map((diffKey) => {
            const meta = SUDOKU_DIFFICULTY_META[diffKey];
            const isSelected = difficulty === diffKey;
            return (
              <button
                key={diffKey}
                type="button"
                disabled={boardStatus === 'loading' || boardStatus === 'submitting'}
                onClick={() => requestDifficultySwitch(diffKey)}
                aria-pressed={isSelected}
                className={cn(
                  'rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors sm:text-sm',
                  isSelected
                    ? 'bg-primary text-primary-foreground shadow-2xs'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {meta.labelVi}
              </button>
            );
          })}
        </div>
      </div>

      {/* Khu vực Bàn chơi 9x9 + Bảng điều khiển */}
      <section
        aria-label="Bàn chơi Sudoku"
        className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs sm:p-6"
      >
        {/* Dải thông số trạng thái ván chơi */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3.5 text-sm">
          <div className="flex flex-wrap items-center gap-4 sm:gap-6">
            <div>
              <span className="text-muted-foreground">Độ khó: </span>
              <span className="font-semibold text-foreground">{activeDifficultyMeta.labelVi}</span>
            </div>

            <div>
              <span className="text-muted-foreground">Lỗi: </span>
              <span
                className={cn(
                  'font-semibold tabular-nums',
                  mistakes >= 2 ? 'text-destructive' : 'text-foreground',
                )}
              >
                {mistakes}/{MAX_SUDOKU_MISTAKES}
              </span>
            </div>

            <div className="hidden sm:block">
              <span className="text-muted-foreground">Kỉ lục: </span>
              <span className="font-semibold tabular-nums text-foreground">
                {currentDifficultyBest !== null
                  ? formatSudokuDurationClock(currentDifficultyBest)
                  : '--:--'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              aria-label={`Thời gian đã chơi ${formatSudokuDurationClock(elapsedSeconds)}`}
              className="min-w-[56px] text-right font-mono text-base font-semibold tabular-nums text-foreground"
            >
              {formatSudokuDurationClock(elapsedSeconds)}
            </span>
            <button
              type="button"
              disabled={boardStatus !== 'playing'}
              onClick={() => setIsPaused((prev) => !prev)}
              aria-label={isPaused ? 'Tiếp tục ván chơi' : 'Tạm dừng ván chơi'}
              className="inline-flex size-8 items-center justify-center rounded-full border border-border/80 bg-muted/40 text-foreground transition-colors hover:bg-muted disabled:opacity-40"
            >
              {isPaused ? (
                <Play className="size-3.5 fill-current" aria-hidden="true" />
              ) : (
                <Pause className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,468px)_minmax(0,1fr)]">
          {/* Lưới 9x9 chuẩn cổ điển (tham chiếu Ảnh 2, hỗ trợ đầy đủ cả Sáng & Tối) */}
          <div className="mx-auto w-full max-w-[468px]">
            <div className="relative aspect-square w-full select-none overflow-hidden border-2 border-[#344861] bg-white shadow-xs dark:border-slate-500 dark:bg-slate-900">
              <div
                role="grid"
                aria-label="Lưới Sudoku 9 nhân 9"
                className="grid h-full w-full grid-cols-9 grid-rows-9"
              >
                {Array.from({ length: SUDOKU_CELL_COUNT }, (_, idx) => {
                  const row = Math.floor(idx / 9);
                  const col = idx % 9;
                  const givenVal = givenCells[idx] ?? 0;
                  const isGiven = givenVal !== 0;
                  const cellVal =
                    isPaused || boardStatus === 'loading' ? 0 : (currentCells[idx] ?? 0);
                  const expectedVal = solutionCells[idx] ?? 0;
                  const isWrong = !isGiven && cellVal !== 0 && cellVal !== expectedVal;
                  const isSelected = !isPaused && boardStatus !== 'loading' && selectedCell === idx;
                  const isSameNumber =
                    !isPaused &&
                    boardStatus !== 'loading' &&
                    selectedCellDigit !== 0 &&
                    cellVal === selectedCellDigit &&
                    !isSelected;
                  const isPeer =
                    !isPaused &&
                    boardStatus !== 'loading' &&
                    selectedCell !== null &&
                    areSudokuPeerCells(selectedCell, idx);

                  const cellNoteMask =
                    isPaused || boardStatus === 'loading' ? 0 : (noteMasks[idx] ?? 0);

                  return (
                    <button
                      key={idx}
                      type="button"
                      role="gridcell"
                      aria-selected={isSelected}
                      aria-label={`Hàng ${row + 1} cột ${col + 1}${
                        cellVal !== 0 ? `, giá trị ${cellVal}` : ', ô trống'
                      }`}
                      disabled={boardStatus === 'loading' || isPaused}
                      onClick={() => setSelectedCell(idx)}
                      className={cn(
                        'relative flex h-full w-full items-center justify-center p-0 transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0072e3] dark:focus-visible:ring-sky-400',
                        col === 2 || col === 5
                          ? 'border-r-2 border-r-[#344861] dark:border-r-slate-500'
                          : col < 8
                            ? 'border-r border-r-[#cbd5e1] dark:border-r-slate-700/80'
                            : '',
                        row === 2 || row === 5
                          ? 'border-b-2 border-b-[#344861] dark:border-b-slate-500'
                          : row < 8
                            ? 'border-b border-b-[#cbd5e1] dark:border-b-slate-700/80'
                            : '',
                        isWrong
                          ? isSelected
                            ? 'bg-[#fecaca] dark:bg-red-900/75'
                            : 'bg-[#fee2e2] dark:bg-red-950/65'
                          : isSelected
                            ? 'bg-[#bbdefb] dark:bg-sky-900/75'
                            : isSameNumber
                              ? 'bg-[#c3d7ea] dark:bg-sky-950/85'
                              : isPeer
                                ? 'bg-[#e2ebf3] dark:bg-slate-800/90'
                                : 'bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/60',
                      )}
                    >
                      {cellVal !== 0 ? (
                        <span
                          className={cn(
                            'text-xl leading-none sm:text-[26px]',
                            isGiven
                              ? 'font-medium text-[#344861] dark:text-slate-100'
                              : isWrong
                                ? 'font-semibold text-[#dc2626] dark:text-red-400'
                                : 'font-medium text-[#0072e3] dark:text-sky-400',
                          )}
                        >
                          {cellVal}
                        </span>
                      ) : cellNoteMask !== 0 ? (
                        <span
                          aria-hidden="true"
                          className="grid h-full w-full grid-cols-3 grid-rows-3 p-[2px]"
                        >
                          {DIGIT_LIST.map((noteDigit) => {
                            const shown = hasCandidateNote(cellNoteMask, noteDigit);
                            const isHighlightedNote =
                              shown && selectedCellDigit !== 0 && selectedCellDigit === noteDigit;
                            return (
                              <span
                                key={noteDigit}
                                className={cn(
                                  'flex items-center justify-center text-[9px] leading-none sm:text-[10px]',
                                  isHighlightedNote
                                    ? 'font-bold text-[#0072e3] dark:text-sky-300'
                                    : 'font-medium text-[#64748b] dark:text-slate-400',
                                )}
                              >
                                {shown ? noteDigit : ''}
                              </span>
                            );
                          })}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {/* Lớp phủ Đang tải đề */}
              {boardStatus === 'loading' ? (
                <div
                  role="status"
                  className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-white/90 backdrop-blur-[1px] dark:bg-slate-950/90"
                >
                  <Loader2 className="size-7 animate-spin text-primary" aria-hidden="true" />
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    Đang tạo bảng Sudoku ({activeDifficultyMeta.labelVi})...
                  </p>
                </div>
              ) : null}

              {/* Lớp phủ Lỗi tải đề */}
              {boardStatus === 'error' ? (
                <div
                  role="alert"
                  className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 p-6 text-center dark:bg-slate-950/95"
                >
                  <XCircle className="size-9 text-destructive" aria-hidden="true" />
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    {boardErrorMessage ?? 'Không thể khởi tạo bảng Sudoku.'}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void startNewSudokuSession(difficulty)}
                  >
                    Thử lại
                  </Button>
                </div>
              ) : null}

              {/* Lớp phủ Tạm dừng (ẩn toàn bộ chữ số chống gian lận thời gian) */}
              {boardStatus === 'playing' && isPaused ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 p-6 text-center backdrop-blur-xs dark:bg-slate-950/95">
                  <Pause className="size-9 text-[#344861] dark:text-slate-300" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-base font-bold text-slate-900 dark:text-slate-100">
                      Đang tạm dừng
                    </p>
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      Bảng số tạm ẩn khi dừng đồng hồ để giữ công bằng cho kỉ lục.
                    </p>
                  </div>
                  <Button type="button" size="sm" onClick={() => setIsPaused(false)}>
                    <Play className="size-4 fill-current" aria-hidden="true" />
                    <span>Tiếp tục chơi</span>
                  </Button>
                </div>
              ) : null}

              {/* Lớp phủ Quá 3 lỗi (Game Over) */}
              {boardStatus === 'lost' ? (
                <div
                  role="alert"
                  className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 p-6 text-center backdrop-blur-xs dark:bg-slate-950/95"
                >
                  <XCircle className="size-10 text-destructive" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-lg font-bold text-slate-900 dark:text-slate-100">
                      Đã quá 3 lỗi cho phép
                    </p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      Ván chơi ở mức {activeDifficultyMeta.labelVi} đã kết thúc. Hãy thử sức lại
                      nhé!
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() => void startNewSudokuSession(difficulty)}
                    className="mt-1"
                  >
                    <RotateCcw className="size-4" aria-hidden="true" />
                    <span>Chơi ván mới</span>
                  </Button>
                </div>
              ) : null}

              {/* Lớp phủ Chiến thắng & Kỉ lục */}
              {boardStatus === 'submitting' || boardStatus === 'won' ? (
                <div
                  role="status"
                  className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/95 p-6 text-center backdrop-blur-xs dark:bg-slate-950/95"
                >
                  {boardStatus === 'submitting' ? (
                    <>
                      <Loader2 className="size-9 animate-spin text-primary" aria-hidden="true" />
                      <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Đang ghi nhận thành tích...
                      </p>
                    </>
                  ) : (
                    <>
                      <CheckCircle2
                        className="size-11 text-emerald-600 dark:text-emerald-400"
                        aria-hidden="true"
                      />
                      <div className="space-y-1">
                        <p className="text-lg font-bold text-slate-900 dark:text-slate-100">
                          Hoàn thành xuất sắc!
                        </p>
                        <p className="text-sm text-slate-600 dark:text-slate-400">
                          Độ khó{' '}
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {activeDifficultyMeta.labelVi}
                          </span>{' '}
                          · Thời gian{' '}
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {formatSudokuDurationClock(
                              victorySummary?.elapsedSeconds ?? elapsedSeconds,
                            )}
                          </span>{' '}
                          · Lỗi {mistakes}/{MAX_SUDOKU_MISTAKES}
                        </p>
                      </div>

                      {victorySummary?.isNewPersonalBest ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800 dark:bg-amber-950/70 dark:text-amber-300">
                          <Flame className="size-3.5" aria-hidden="true" />
                          <span>Kỉ lục cá nhân mới!</span>
                        </span>
                      ) : null}

                      {victorySummary?.rank ? (
                        <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                          Hạng hiện tại ở bảng {activeDifficultyMeta.labelVi}:{' '}
                          <span className="font-bold text-slate-900 dark:text-slate-100">
                            #{victorySummary.rank}
                          </span>
                        </p>
                      ) : null}

                      {completionWarning ? (
                        <p role="alert" className="max-w-xs text-xs font-medium text-destructive">
                          {completionWarning}
                        </p>
                      ) : null}

                      <Button
                        type="button"
                        onClick={() => void startNewSudokuSession(difficulty)}
                        className="mt-1"
                      >
                        <Play className="size-4 fill-current" aria-hidden="true" />
                        <span>Chơi ván mới</span>
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {/* Cột công cụ điều khiển: Tẩy/Xóa, Ghi chú (Bật/Tắt), Ván mới & Bàn phím số 1–9 */}
          <div className="mx-auto flex w-full max-w-[468px] flex-col gap-4 lg:max-w-none">
            {/* Hàng nút công cụ (Không có Hoàn tác & không có Gợi ý theo đúng yêu cầu) */}
            <div className="grid grid-cols-3 gap-2.5">
              <button
                type="button"
                disabled={boardStatus !== 'playing' || isPaused}
                onClick={handleEraseSelectedCell}
                className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-border/80 bg-muted/30 px-3 py-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-45 sm:text-sm"
              >
                <Eraser className="size-5 text-foreground/85" aria-hidden="true" />
                <span>Xóa</span>
              </button>

              <button
                type="button"
                disabled={boardStatus !== 'playing' || isPaused}
                aria-pressed={notesMode}
                onClick={() => setNotesMode((prev) => !prev)}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-1.5 rounded-2xl border px-3 py-3 text-xs font-semibold transition-colors disabled:opacity-45 sm:text-sm',
                  notesMode
                    ? 'border-[#0072e3] bg-[#0072e3]/10 text-[#0072e3]'
                    : 'border-border/80 bg-muted/30 text-foreground hover:bg-muted',
                )}
              >
                <span
                  className={cn(
                    'absolute top-1.5 right-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
                    notesMode
                      ? 'bg-[#0072e3] text-white'
                      : 'bg-muted-foreground/20 text-muted-foreground',
                  )}
                >
                  {notesMode ? 'BẬT' : 'TẮT'}
                </span>
                <Pencil className="size-5" aria-hidden="true" />
                <span>Ghi chú</span>
              </button>

              <button
                type="button"
                disabled={boardStatus === 'loading' || boardStatus === 'submitting'}
                onClick={requestFreshGame}
                className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-border/80 bg-muted/30 px-3 py-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-45 sm:text-sm"
              >
                <RotateCcw className="size-5 text-foreground/85" aria-hidden="true" />
                <span>Ván mới</span>
              </button>
            </div>

            {/* Bàn phím số 1–9 (hiển thị trên 1 hàng ở mobile nhỏ gọn hoặc lưới 3x3 lớn trên màn hình rộng) */}
            <div
              role="group"
              aria-label="Bàn phím chọn số từ 1 đến 9"
              className="grid grid-cols-9 gap-1.5 sm:grid-cols-3 sm:gap-2.5"
            >
              {DIGIT_LIST.map((digit) => {
                const remaining = remainingDigits[digit] ?? 0;
                const isExhausted = remaining === 0 && !notesMode;
                return (
                  <button
                    key={digit}
                    type="button"
                    disabled={boardStatus !== 'playing' || isPaused || isExhausted}
                    onClick={() => handleDigitInput(digit)}
                    aria-label={
                      notesMode ? `Ghi chú số ${digit}` : `Điền số ${digit} (còn ${remaining} ô)`
                    }
                    className={cn(
                      'flex flex-col items-center justify-center rounded-xl border py-2.5 transition-colors sm:rounded-2xl sm:py-3.5',
                      notesMode
                        ? 'border-[#0072e3]/40 bg-[#0072e3]/5 text-[#0072e3] hover:bg-[#0072e3]/12'
                        : 'border-border/80 bg-muted/25 text-[#0072e3] hover:bg-[#0072e3]/10',
                      'disabled:pointer-events-none disabled:opacity-35',
                    )}
                  >
                    <span className="text-xl font-semibold leading-none sm:text-2xl">{digit}</span>
                    <span className="mt-1 text-[10px] font-medium leading-none text-muted-foreground tabular-nums sm:text-xs">
                      {remaining}
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Mẹo nhanh: Dùng phím <kbd className="rounded border px-1 py-0.5 text-[11px]">1–9</kbd>{' '}
              để điền số, <kbd className="rounded border px-1 py-0.5 text-[11px]">N</kbd> để bật/tắt{' '}
              Ghi chú, phím mũi tên để di chuyển ô và{' '}
              <kbd className="rounded border px-1 py-0.5 text-[11px]">Backspace</kbd> để xóa.
            </p>
          </div>
        </div>
      </section>

      {/* Kỉ lục cá nhân của người dùng theo đủ 6 độ khó */}
      <section aria-labelledby="sudoku-personal-records-heading" className="space-y-3.5">
        <div className="flex items-center gap-2">
          <Award className="size-5 text-primary" aria-hidden="true" />
          <h2 id="sudoku-personal-records-heading" className="text-lg font-bold text-foreground">
            Kỉ lục của bạn
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {SUDOKU_DIFFICULTIES.map((diffKey) => {
            const meta = SUDOKU_DIFFICULTY_META[diffKey];
            const rec = personalRecords[diffKey];
            const hasBest = rec?.bestTimeSeconds !== null && rec?.bestTimeSeconds !== undefined;
            const isCurrentDiff = difficulty === diffKey;

            return (
              <div
                key={diffKey}
                className={cn(
                  'flex flex-col justify-between rounded-2xl border bg-card p-3.5 shadow-2xs transition-colors',
                  isCurrentDiff ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border/70',
                )}
              >
                <span className="text-xs font-semibold text-muted-foreground">{meta.labelVi}</span>
                <div className="mt-2">
                  {loadingRecords ? (
                    <span className="inline-block h-6 w-14 animate-pulse rounded bg-muted" />
                  ) : (
                    <p
                      className={cn(
                        'font-mono text-lg font-bold tabular-nums',
                        hasBest ? 'text-foreground' : 'text-muted-foreground/60',
                      )}
                    >
                      {hasBest ? formatSudokuDurationClock(rec.bestTimeSeconds!) : 'Chưa có'}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {rec?.gamesWon ?? 0} ván thắng
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Bảng xếp hạng kỉ lục tất cả người dùng theo 6 độ khó (6 bảng riêng) */}
      <section
        aria-labelledby="sudoku-global-leaderboard-heading"
        className="rounded-2xl border border-border/70 bg-card p-4 shadow-xs sm:p-6"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Trophy className="size-5 text-amber-500" aria-hidden="true" />
            <div>
              <h2
                id="sudoku-global-leaderboard-heading"
                className="text-lg font-bold text-foreground"
              >
                Bảng xếp hạng kỉ lục
              </h2>
              <p className="text-xs text-muted-foreground">
                Xếp hạng thời gian hoàn thành nhanh nhất theo từng cấp độ khó riêng biệt.
              </p>
            </div>
          </div>

          {/* 6 Tab chuyển đổi giữa 6 Bảng xếp hạng riêng */}
          <div
            role="tablist"
            aria-label="Chọn bảng xếp hạng theo độ khó"
            className="flex flex-wrap items-center gap-1 rounded-xl bg-muted/50 p-1"
          >
            {SUDOKU_DIFFICULTIES.map((diffKey) => {
              const meta = SUDOKU_DIFFICULTY_META[diffKey];
              const isTabActive = leaderboardTab === diffKey;
              return (
                <button
                  key={diffKey}
                  type="button"
                  role="tab"
                  aria-selected={isTabActive}
                  onClick={() => handleSelectLeaderboardTab(diffKey)}
                  className={cn(
                    'rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors',
                    isTabActive
                      ? 'bg-background text-foreground shadow-2xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {meta.labelVi}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tóm tắt thứ hạng cá nhân ở bảng đang xem */}
        {activeLeaderboard && activeLeaderboard.myRank !== null ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3.5 py-2.5 text-xs sm:text-sm">
            <span className="font-medium text-foreground">
              Thứ hạng của bạn ở bảng{' '}
              <strong>{SUDOKU_DIFFICULTY_META[leaderboardTab].labelVi}</strong>:{' '}
              <strong className="text-primary">#{activeLeaderboard.myRank}</strong>
            </span>
            {activeLeaderboard.myBestTimeSeconds !== null ? (
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {formatSudokuDurationClock(activeLeaderboard.myBestTimeSeconds)} ·{' '}
                {activeLeaderboard.myGamesWon} ván thắng
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4">
          {isLeaderboardLoading ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
              <span>
                Đang tải bảng xếp hạng {SUDOKU_DIFFICULTY_META[leaderboardTab].labelVi}...
              </span>
            </div>
          ) : leaderboardError && !activeLeaderboard ? (
            <div role="alert" className="py-10 text-center">
              <p className="text-sm text-destructive">{leaderboardError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fetchLeaderboardForDifficulty(leaderboardTab, { force: true })}
                className="mt-3"
              >
                Thử lại
              </Button>
            </div>
          ) : !activeLeaderboard || activeLeaderboard.items.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium text-muted-foreground">
                Chưa có người chơi nào ghi kỉ lục ở bảng{' '}
                {SUDOKU_DIFFICULTY_META[leaderboardTab].labelVi}. Hãy là người đầu tiên chinh phục!
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {activeLeaderboard.items.map((entry) => {
                const rankBadgeClass =
                  entry.rank === 1
                    ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300 dark:bg-amber-950/70 dark:text-amber-300 dark:ring-amber-500/40'
                    : entry.rank === 2
                      ? 'bg-slate-200 text-slate-800 ring-1 ring-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600'
                      : entry.rank === 3
                        ? 'bg-orange-100 text-orange-800 ring-1 ring-orange-300 dark:bg-orange-950/70 dark:text-orange-300 dark:ring-orange-500/40'
                        : 'bg-muted text-muted-foreground';

                return (
                  <div
                    key={entry.user.public_id}
                    className={cn(
                      'flex items-center justify-between gap-3 py-3 px-2 rounded-xl transition-colors',
                      entry.user.isCurrentUser ? 'bg-primary/5' : 'hover:bg-muted/40',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className={cn(
                          'inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums',
                          rankBadgeClass,
                        )}
                      >
                        #{entry.rank}
                      </span>

                      <Link
                        href={`/u/${encodeURIComponent(entry.user.handle)}`}
                        className="flex min-w-0 items-center gap-2.5 group"
                      >
                        <UserAvatar
                          fullName={entry.user.fullName}
                          avatarUrl={entry.user.avatarUrl}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-foreground group-hover:underline">
                              {entry.user.fullName}
                            </span>
                            {entry.user.isCurrentUser ? (
                              <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary">
                                Bạn
                              </span>
                            ) : null}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            @{entry.user.handle}
                          </p>
                        </div>
                      </Link>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="font-mono text-sm font-bold tabular-nums text-foreground sm:text-base">
                        {formatSudokuDurationClock(entry.bestTimeSeconds)}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {entry.gamesWon} ván thắng
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Hộp thoại xác nhận khi đổi độ khó hoặc tạo ván mới lúc đang chơi dở */}
      <ConfirmDialog
        open={pendingRestartIntent !== null}
        title="Bắt đầu ván Sudoku mới?"
        description={
          pendingRestartIntent?.kind === 'change_difficulty'
            ? `Tiến trình ván hiện tại sẽ bị hủy để chuyển sang mức ${
                SUDOKU_DIFFICULTY_META[pendingRestartIntent.difficulty].labelVi
              }.`
            : 'Tiến trình ván hiện tại sẽ bị hủy để tạo một bảng số mới.'
        }
        confirmLabel="Bắt đầu ván mới"
        cancelLabel="Tiếp tục chơi"
        onClose={() => setPendingRestartIntent(null)}
        onConfirm={confirmPendingRestart}
      />
    </div>
  );
}
