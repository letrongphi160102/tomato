import { handleSudokuRouteError } from '@/app/api/v1/games/sudoku/_utils';
import { extractSearchParamsObject } from '@/app/api/v1/social/_utils';
import { createAuthJsonResponse, getAuthCookiesFromRequest } from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getSudokuService } from '@/modules/games';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const query = extractSearchParamsObject(request);

    const result = await getSudokuService().getLeaderboard(principal, query);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSudokuRouteError(error, 'GET /api/v1/games/sudoku/leaderboard');
  }
}
