import 'server-only';

import { sql } from 'drizzle-orm';

import { getDb, type Database, type DatabaseTransaction } from '@/core/db';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thiết lập biến phiên giao dịch cục bộ (`SET LOCAL app.current_user_id`) cho PostgreSQL RLS.
 * Tham số thứ 3 của `set_config(..., true)` đảm bảo giá trị chỉ tồn tại trong phạm vi transaction hiện tại
 * và tự động được xóa khi COMMIT/ROLLBACK, ngăn rò rỉ định danh giữa các kết nối trong Pool.
 */
export async function applyRlsSessionContext(
  tx: DatabaseTransaction,
  actorUserId: string,
): Promise<void> {
  const normalized = actorUserId.trim();
  if (!UUID_REGEX.test(normalized)) {
    throw new Error('Định danh người dùng cho ngữ cảnh RLS không hợp lệ');
  }
  await tx.execute(sql`SELECT set_config('app.current_user_id', ${normalized}, true)`);
}

/**
 * Chạy một khối lệnh bên trong PostgreSQL Transaction đã gắn ngữ cảnh RLS (`app.current_user_id`).
 * Lớp phòng thủ thứ hai song song với Policy ReBAC (`chat.policy.ts`).
 */
export async function withRlsContext<T>(
  actorUserId: string,
  callback: (tx: DatabaseTransaction) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  return db.transaction(async (tx) => {
    await applyRlsSessionContext(tx, actorUserId);
    return callback(tx);
  });
}
