import { handleSudokuRouteError, parseSudokuJsonBody } from '@/app/api/v1/games/sudoku/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getSudokuService } from '@/modules/games';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const body = await parseSudokuJsonBody(request);

    const result = await getSudokuService().startNewGame(principal, body);
    return createAuthJsonResponse(result, { status: 201 });
  } catch (error) {
    return handleSudokuRouteError(error, 'POST /api/v1/games/sudoku/games');
  }
}
