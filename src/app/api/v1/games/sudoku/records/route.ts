import { handleSudokuRouteError } from '@/app/api/v1/games/sudoku/_utils';
import { createAuthJsonResponse, getAuthCookiesFromRequest } from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getSudokuService } from '@/modules/games';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);

    const result = await getSudokuService().getPersonalRecords(principal);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSudokuRouteError(error, 'GET /api/v1/games/sudoku/records');
  }
}
