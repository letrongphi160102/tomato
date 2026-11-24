import 'server-only';

import type { DatabaseTransaction } from '@/core/db';
import { applyRlsSessionContext } from '@/core/db/rls';
import type { CallSessionRow, CallStatus, CallType } from '@/core/db/schema';
import { logger } from '@/core/logger';
import {
  getRealtimeProvider,
  type RealtimeEventName,
  type RealtimeProvider,
} from '@/core/realtime';
import {
  CALL_RATE_LIMITS,
  getRateLimiter,
  getRedisClient,
  type RateLimiter,
  type RedisClient,
} from '@/core/redis';
import type { RequestClientContext } from '@/core/security/client-context';
import { formatZodErrorDetails } from '@/core/security/http-response';
import {
  getTurnCredentialProvider,
  type IceServersResponseDto,
  type TurnCredentialProvider,
} from '@/core/webrtc';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { CallDomainError } from '@/modules/calls/call.errors';
import { CALL_MESSAGES } from '@/modules/calls/call.messages';
import { assertCallAuthorized } from '@/modules/calls/call.policy';
import { CallRepository, type CallUserRecord } from '@/modules/calls/call.repository';
import {
  CALL_CALLEE_TIMEOUT_MIN_ELAPSED_MS,
  CALL_DECLINE_COOLDOWN_SECONDS,
  CALL_HEARTBEAT_STALE_MS,
  CALL_RING_TIMEOUT_MS,
  callActionInputSchema,
  callPublicIdParamSchema,
  callSignalInputSchema,
  createCallInputSchema,
  iceServersInputSchema,
} from '@/modules/calls/call.schemas';

// ============================================================================
// DTO Allowlists (Tuyệt đối không lộ khóa chính UUIDv7 `id`, `apiKey` hay `secretKey`)
// ============================================================================

export interface CallPeerDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
}

export interface CallSessionDto {
  readonly public_id: string;
  readonly conversationPublicId: string;
  readonly callerPublicId: string;
  readonly calleePublicId: string;
  readonly callType: CallType;
  readonly status: CallStatus;
  readonly startedAt: string;
  readonly connectedAt: string | null;
  readonly lastHeartbeatAt: string;
  readonly endedAt: string | null;
  readonly expiresAt: string;
  readonly durationSeconds: number | null;
  readonly peer: CallPeerDto;
}

export interface PendingCallRealtimeDispatch {
  readonly recipientPublicId: string;
  readonly event: RealtimeEventName;
  readonly payload: Record<string, unknown>;
}

export interface CallDeclineCooldownStore {
  setDeclinedCooldown(callerId: string, calleeId: string, ttlSeconds: number): Promise<void>;
  getDeclinedCooldownRemainingSeconds(callerId: string, calleeId: string): Promise<number>;
}

const DECLINE_COOLDOWN_PREFIX = 'tomato:call:declined_cooldown';

class RedisCallDeclineCooldownStore implements CallDeclineCooldownStore {
  private readonly getRedis: () => RedisClient;

  constructor(getRedis: () => RedisClient = () => getRedisClient()) {
    this.getRedis = getRedis;
  }

  private buildKey(callerId: string, calleeId: string): string {
    return `${DECLINE_COOLDOWN_PREFIX}:${callerId}:${calleeId}`;
  }

  async setDeclinedCooldown(callerId: string, calleeId: string, ttlSeconds: number): Promise<void> {
    await this.getRedis().set(this.buildKey(callerId, calleeId), '1', {
      ex: Math.max(1, Math.floor(ttlSeconds)),
    });
  }

  async getDeclinedCooldownRemainingSeconds(callerId: string, calleeId: string): Promise<number> {
    const pttl = await this.getRedis().pttl(this.buildKey(callerId, calleeId));
    if (pttl <= 0) {
      return 0;
    }
    return Math.max(1, Math.ceil(pttl / 1000));
  }
}

export class InMemoryCallDeclineCooldownStore implements CallDeclineCooldownStore {
  private readonly entries = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async setDeclinedCooldown(callerId: string, calleeId: string, ttlSeconds: number): Promise<void> {
    this.entries.set(`${callerId}:${calleeId}`, this.now() + ttlSeconds * 1000);
  }

  async getDeclinedCooldownRemainingSeconds(callerId: string, calleeId: string): Promise<number> {
    const expiresAt = this.entries.get(`${callerId}:${calleeId}`);
    if (!expiresAt) {
      return 0;
    }
    const remainingMs = expiresAt - this.now();
    if (remainingMs <= 0) {
      this.entries.delete(`${callerId}:${calleeId}`);
      return 0;
    }
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }

  clear(): void {
    this.entries.clear();
  }
}

function toPeerDto(user: CallUserRecord): CallPeerDto {
  return {
    public_id: user.publicId,
    handle: user.handle,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
  };
}

function computeCallDurationSeconds(row: CallSessionRow): number | null {
  if (!row.connectedAt || !row.endedAt) {
    return null;
  }
  const diffMs = row.endedAt.getTime() - row.connectedAt.getTime();
  return Math.max(1, Math.floor(diffMs / 1000));
}

function toCallSessionDto(
  row: CallSessionRow,
  conversationPublicId: string,
  callerPublicId: string,
  calleePublicId: string,
  peer: CallUserRecord,
): CallSessionDto {
  return {
    public_id: row.publicId,
    conversationPublicId,
    callerPublicId,
    calleePublicId,
    callType: row.callType,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    expiresAt: new Date(row.startedAt.getTime() + CALL_RING_TIMEOUT_MS).toISOString(),
    durationSeconds: computeCallDurationSeconds(row),
    peer: toPeerDto(peer),
  };
}

function parseCallPublicIdOrThrowNotFound(raw: string): string {
  const parsed = callPublicIdParamSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CallDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: CALL_MESSAGES.notFound,
    });
  }
  return parsed.data;
}

export interface CallSignalingServiceDependencies {
  readonly repository?: CallRepository;
  readonly rateLimiter?: Pick<RateLimiter, 'consume'>;
  readonly realtimeProvider?: RealtimeProvider;
  readonly turnCredentialProvider?: TurnCredentialProvider;
  readonly declineCooldownStore?: CallDeclineCooldownStore;
  readonly now?: () => Date;
}

export class CallSignalingService {
  private readonly repository: CallRepository;
  private readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  private readonly realtimeProvider: RealtimeProvider;
  private readonly turnCredentialProviderOverride?: TurnCredentialProvider;
  private readonly declineCooldownStore: CallDeclineCooldownStore;
  private readonly now: () => Date;
  private readonly hasCustomNow: boolean;

  constructor(deps: CallSignalingServiceDependencies = {}) {
    this.repository = deps.repository ?? new CallRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.realtimeProvider = deps.realtimeProvider ?? getRealtimeProvider();
    this.turnCredentialProviderOverride = deps.turnCredentialProvider;
    this.declineCooldownStore =
      deps.declineCooldownStore ??
      (deps.repository
        ? new InMemoryCallDeclineCooldownStore()
        : new RedisCallDeclineCooldownStore());
    this.now = deps.now ?? (() => new Date());
    this.hasCustomNow = deps.now !== undefined;
  }

  private resolveTurnProvider(): TurnCredentialProvider {
    return this.turnCredentialProviderOverride ?? getTurnCredentialProvider();
  }

  private async resolveAuthoritativeNow(tx: DatabaseTransaction): Promise<Date> {
    if (this.hasCustomNow) {
      return this.now();
    }
    if (typeof this.repository.getDatabaseNow === 'function') {
      return this.repository.getDatabaseNow(tx);
    }
    return this.now();
  }

  private async consumeRateLimitOrThrow(
    key: string,
    rule: (typeof CALL_RATE_LIMITS)[keyof typeof CALL_RATE_LIMITS],
  ): Promise<void> {
    const result = await this.rateLimiter.consume(key, rule);
    if (!result.allowed) {
      throw new CallDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: CALL_MESSAGES.rateLimited(result.retryAfterSeconds),
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  private async publishEventBestEffort(
    recipientPublicId: string,
    event: RealtimeEventName,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.realtimeProvider.publishToUser(recipientPublicId, event, payload);
    } catch (error) {
      logger.warn(
        {
          component: 'call-signaling-service',
          eventName: event,
          errorName: error instanceof Error ? error.name : 'RealtimePublishError',
        },
        'Không thể đẩy sự kiện cuộc gọi thời gian thực',
      );
    }
  }

  async dispatchPendingRealtimeEvents(
    dispatches: readonly (PendingCallRealtimeDispatch | null)[],
  ): Promise<void> {
    const valid = dispatches.filter((d): d is PendingCallRealtimeDispatch => d !== null);
    if (valid.length === 0) {
      return;
    }
    await Promise.all(
      valid.map((item) =>
        this.publishEventBestEffort(item.recipientPublicId, item.event, item.payload),
      ),
    );
  }

  // =========================================================================
  // 1. Cấp phát ICE / TURN Credentials ngắn hạn (`POST /api/v1/calls/ice-servers`)
  // =========================================================================

  async getIceServers(
    actor: AuthenticatedPrincipal,
    clientContext: RequestClientContext,
    rawInput: unknown = {},
  ): Promise<IceServersResponseDto> {
    assertCallAuthorized(actor, 'call:ice_servers');

    await this.consumeRateLimitOrThrow(
      `calls:ice:ip:${clientContext.rateLimitIpKey}`,
      CALL_RATE_LIMITS.iceServersByIp,
    );
    await this.consumeRateLimitOrThrow(
      `calls:ice:user:${actor.user.id}`,
      CALL_RATE_LIMITS.iceServersByUser,
    );

    const parsed = iceServersInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new CallDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CALL_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const result = await this.resolveTurnProvider().getIceServers();

    // DTO allowlist tuyệt đối: chỉ trả `iceServers` (urls/username/credential) và `ttlSeconds`.
    return {
      iceServers: result.iceServers.map((server) => ({
        urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(server.credential ? { credential: server.credential } : {}),
      })),
      ttlSeconds: result.ttlSeconds,
    };
  }

  // =========================================================================
  // 2. Khởi tạo Cuộc gọi 1-1 (`POST /api/v1/calls`)
  // =========================================================================

  async createCall(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
  ): Promise<{ readonly call: CallSessionDto; readonly message: string }> {
    assertCallAuthorized(actor, 'call:ice_servers');

    await this.consumeRateLimitOrThrow(
      `calls:create:user:${actor.user.id}`,
      CALL_RATE_LIMITS.createCallByUser,
    );

    const parsed = createCallInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new CallDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CALL_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    // Bước 1: Pre-check không giữ khóa DB để xác thực ReBAC (`404`), trạng thái `primary` (`403`)
    // và lấy `peerId` cho bước kiểm tra cooldown Redis (không giữ row lock xuyên qua Redis I/O).
    const preCheck = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const conversation = await this.repository.findConversationByPublicId(
        parsed.data.conversationPublicId,
        tx,
      );
      if (!conversation) {
        throw new CallDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CALL_MESSAGES.notFound,
        });
      }

      const participants = await this.repository.listConversationParticipants(conversation.id, tx);
      const actorParticipant = participants.find((p) => p.userId === actor.user.id) ?? null;
      const peerParticipant = participants.find((p) => p.userId !== actor.user.id) ?? null;
      const peerUser = peerParticipant
        ? await this.repository.findUserById(peerParticipant.userId, tx)
        : null;
      const relationship = peerUser
        ? await this.repository.getRelationshipSnapshot(actor.user.id, peerUser.id, tx)
        : null;

      assertCallAuthorized(actor, 'call:create', {
        conversation,
        actorParticipant,
        peerParticipant,
        peerUser,
        relationship,
      });

      if (actorParticipant!.inboxState !== 'primary' || peerParticipant!.inboxState !== 'primary') {
        throw new CallDomainError({
          status: 403,
          code: 'CHAT_PENDING_TEXT_ONLY',
          message: CALL_MESSAGES.pendingCallForbidden,
        });
      }

      return {
        conversationId: conversation.id,
        peerUserId: peerUser!.id,
      };
    });

    // Bước 2: Chống spam gọi lại ngay sau khi bị từ chối (30 giây).
    const declineCooldownRemaining =
      await this.declineCooldownStore.getDeclinedCooldownRemainingSeconds(
        actor.user.id,
        preCheck.peerUserId,
      );
    if (declineCooldownRemaining > 0) {
      throw new CallDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: CALL_MESSAGES.declinedCooldown(declineCooldownRemaining),
        retryAfterSeconds: declineCooldownRemaining,
      });
    }

    // Bước 3: Transaction chính (khóa cặp user theo thứ tự chuẩn `id ASC FOR UPDATE`,
    // auto-sweep phiên quá hạn 45s/120s, kiểm tra busy, tạo `call_sessions`).
    const pendingDispatches: PendingCallRealtimeDispatch[] = [];

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const serverNow = await this.resolveAuthoritativeNow(tx);
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, preCheck.peerUserId],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id) ?? null;
      const lockedPeer = lockedUsers.get(preCheck.peerUserId) ?? null;

      const conversation = await this.repository.findConversationById(preCheck.conversationId, tx);
      if (!conversation || !lockedActor || !lockedPeer) {
        throw new CallDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CALL_MESSAGES.notFound,
        });
      }

      const participants = await this.repository.listConversationParticipants(conversation.id, tx);
      const actorParticipant = participants.find((p) => p.userId === actor.user.id) ?? null;
      const peerParticipant = participants.find((p) => p.userId === lockedPeer.id) ?? null;
      const relationship = await this.repository.getRelationshipSnapshot(
        actor.user.id,
        lockedPeer.id,
        tx,
      );

      assertCallAuthorized(actor, 'call:create', {
        conversation,
        actorParticipant,
        peerParticipant,
        peerUser: lockedPeer,
        relationship,
      });

      if (actorParticipant!.inboxState !== 'primary' || peerParticipant!.inboxState !== 'primary') {
        throw new CallDomainError({
          status: 403,
          code: 'CHAT_PENDING_TEXT_ONLY',
          message: CALL_MESSAGES.pendingCallForbidden,
        });
      }

      // Auto-sweep phiên cũ hết hạn (ringing > 45s -> missed, connected mất heartbeat > 2p -> ended)
      // để tuyệt đối không bao giờ khóa cứng người dùng vào `409 CALL_BUSY`.
      const sweptOwnCalls = await this.repository.sweepStaleCallsVisibleToActor(
        actor.user.id,
        serverNow,
        tx,
      );
      for (const swept of sweptOwnCalls) {
        const durationSeconds = computeCallDurationSeconds(swept.session);
        const insertedEvent = await this.repository.insertCallEventMessageInTx(
          {
            conversationId: swept.session.conversationId,
            actorUserId: actor.user.id,
            callerUserId: swept.session.callerId,
            calleeUserId: swept.session.calleeId,
            callEventMeta: {
              callPublicId: swept.session.publicId,
              callType: swept.session.callType,
              status: swept.nextStatus,
              callerPublicId: swept.callerPublicId,
              durationSeconds,
            },
            now: serverNow,
          },
          tx,
        );

        const endedPayload = {
          callPublicId: swept.session.publicId,
          conversationPublicId: swept.conversationPublicId,
          callType: swept.session.callType,
          status: swept.nextStatus,
          durationSeconds,
          endedAt: serverNow.toISOString(),
        };
        pendingDispatches.push(
          { recipientPublicId: swept.callerPublicId, event: 'call.ended', payload: endedPayload },
          { recipientPublicId: swept.calleePublicId, event: 'call.ended', payload: endedPayload },
        );

        if (insertedEvent?.created) {
          const msgPayload = {
            conversationPublicId: swept.conversationPublicId,
            messagePublicId: insertedEvent.message.publicId,
            seq: Number(insertedEvent.message.seq),
            senderPublicId: actor.user.publicId,
            createdAt: insertedEvent.message.createdAt.toISOString(),
            recipientInboxState: 'primary',
          };
          pendingDispatches.push(
            {
              recipientPublicId: swept.callerPublicId,
              event: 'chat.message.created',
              payload: msgPayload,
            },
            {
              recipientPublicId: swept.calleePublicId,
              event: 'chat.message.created',
              payload: msgPayload,
            },
          );
        }
      }

      // Dọn các phiên hết hạn phía người nhận (kể cả cuộc gọi với người thứ 3) mà không lộ dữ liệu qua RLS.
      await this.repository.sweepStaleCallsForTargetViaDbFunction(lockedPeer.id, tx);

      const [callerBusy, calleeBusy] = await Promise.all([
        this.repository.hasActiveCallViaDbFunction(actor.user.id, tx),
        this.repository.hasActiveCallViaDbFunction(lockedPeer.id, tx),
      ]);

      if (callerBusy || calleeBusy) {
        const busySession = await this.repository.insertCallSession(
          {
            conversationId: conversation.id,
            callerId: actor.user.id,
            calleeId: lockedPeer.id,
            callType: parsed.data.callType,
            status: 'busy',
            startedAt: serverNow,
            connectedAt: null,
            lastHeartbeatAt: serverNow,
            endedAt: serverNow,
          },
          tx,
        );

        const insertedBusyEvent = await this.repository.insertCallEventMessageInTx(
          {
            conversationId: conversation.id,
            actorUserId: actor.user.id,
            callerUserId: actor.user.id,
            calleeUserId: lockedPeer.id,
            callEventMeta: {
              callPublicId: busySession.publicId,
              callType: busySession.callType,
              status: 'busy',
              callerPublicId: lockedActor.publicId,
              durationSeconds: null,
            },
            now: serverNow,
          },
          tx,
        );

        if (insertedBusyEvent?.created) {
          const msgPayload = {
            conversationPublicId: conversation.publicId,
            messagePublicId: insertedBusyEvent.message.publicId,
            seq: Number(insertedBusyEvent.message.seq),
            senderPublicId: lockedActor.publicId,
            createdAt: insertedBusyEvent.message.createdAt.toISOString(),
            recipientInboxState: 'primary',
          };
          pendingDispatches.push(
            {
              recipientPublicId: lockedActor.publicId,
              event: 'chat.message.created',
              payload: msgPayload,
            },
            {
              recipientPublicId: lockedPeer.publicId,
              event: 'chat.message.created',
              payload: msgPayload,
            },
          );
        }

        return {
          busy: true as const,
          isCallerBusy: callerBusy,
        };
      }

      const createdSession = await this.repository.insertCallSession(
        {
          conversationId: conversation.id,
          callerId: actor.user.id,
          calleeId: lockedPeer.id,
          callType: parsed.data.callType,
          status: 'ringing',
          startedAt: serverNow,
          connectedAt: null,
          lastHeartbeatAt: serverNow,
          endedAt: null,
        },
        tx,
      );

      const dto = toCallSessionDto(
        createdSession,
        conversation.publicId,
        lockedActor.publicId,
        lockedPeer.publicId,
        lockedPeer,
      );

      pendingDispatches.push({
        recipientPublicId: lockedPeer.publicId,
        event: 'call.incoming',
        payload: {
          callPublicId: createdSession.publicId,
          conversationPublicId: conversation.publicId,
          callType: createdSession.callType,
          startedAt: createdSession.startedAt.toISOString(),
          expiresAt: dto.expiresAt,
          caller: toPeerDto(lockedActor),
        },
      });

      return {
        busy: false as const,
        call: dto,
      };
    });

    await this.dispatchPendingRealtimeEvents(pendingDispatches);

    if (outcome.busy) {
      throw new CallDomainError({
        status: 409,
        code: 'CALL_BUSY',
        message: outcome.isCallerBusy ? CALL_MESSAGES.callerBusy : CALL_MESSAGES.calleeBusy,
      });
    }

    return {
      call: outcome.call,
      message: CALL_MESSAGES.callStarted,
    };
  }

  // =========================================================================
  // 3. Chuyển tiếp Tín hiệu WebRTC (`POST /api/v1/calls/:callPublicId/signal`)
  //    Hỗ trợ đầy đủ offer/answer/ice-candidate trong cả `ringing` & `connected` (renegotiation)
  // =========================================================================

  async relaySignal(
    actor: AuthenticatedPrincipal,
    rawCallPublicId: string,
    rawInput: unknown,
  ): Promise<{ readonly relayed: true }> {
    assertCallAuthorized(actor, 'call:ice_servers');
    await this.consumeRateLimitOrThrow(
      `calls:signal:user:${actor.user.id}`,
      CALL_RATE_LIMITS.signalByUser,
    );

    const callPublicId = parseCallPublicIdOrThrowNotFound(rawCallPublicId);
    const parsed = callSignalInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new CallDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CALL_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const pendingDispatches: PendingCallRealtimeDispatch[] = [];

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const serverNow = await this.resolveAuthoritativeNow(tx);
      const session = await this.repository.lockCallSessionByPublicId(callPublicId, tx);
      if (!session) {
        throw new CallDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CALL_MESSAGES.notFound,
        });
      }

      const peerUserId = session.callerId === actor.user.id ? session.calleeId : session.callerId;
      const [peerUser, relationship, conversation, callerUser] = await Promise.all([
        this.repository.findUserById(peerUserId, tx),
        this.repository.getRelationshipSnapshot(actor.user.id, peerUserId, tx),
        this.repository.findConversationById(session.conversationId, tx),
        session.callerId === actor.user.id
          ? Promise.resolve(null)
          : this.repository.findUserById(session.callerId, tx),
      ]);

      assertCallAuthorized(actor, 'call:signal', {
        callSession: session,
        peerUser,
        relationship,
      });

      if (!conversation) {
        throw new CallDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CALL_MESSAGES.notFound,
        });
      }

      const callerPublicId =
        session.callerId === actor.user.id
          ? actor.user.publicId
          : (callerUser?.publicId ?? peerUser!.publicId);
      const calleePublicId =
        session.calleeId === actor.user.id ? actor.user.publicId : peerUser!.publicId;

      // Kiểm tra phiên đã hết hạn (ringing > 45s hoặc connected mất heartbeat > 2p).
      const isRingingExpired =
        session.status === 'ringing' &&
        serverNow.getTime() - session.startedAt.getTime() > CALL_RING_TIMEOUT_MS;
      const isConnectedStale =
        session.status === 'connected' &&
        serverNow.getTime() -
          (session.lastHeartbeatAt ?? session.connectedAt ?? session.startedAt).getTime() >
          CALL_HEARTBEAT_STALE_MS;

      if (isRingingExpired || isConnectedStale) {
        const nextStatus = isRingingExpired ? 'missed' : 'ended';
        const updated = await this.repository.updateCallSession(
          session.id,
          { status: nextStatus, endedAt: serverNow },
          tx,
        );
        const durationSeconds = updated ? computeCallDurationSeconds(updated) : null;

        const insertedEvent = await this.repository.insertCallEventMessageInTx(
          {
            conversationId: conversation.id,
            actorUserId: actor.user.id,
            callerUserId: session.callerId,
            calleeUserId: session.calleeId,
            callEventMeta: {
              callPublicId: session.publicId,
              callType: session.callType,
              status: nextStatus,
              callerPublicId,
              durationSeconds,
            },
            now: serverNow,
          },
          tx,
        );

        const endedPayload = {
          callPublicId: session.publicId,
          conversationPublicId: conversation.publicId,
          callType: session.callType,
          status: nextStatus,
          durationSeconds,
          endedAt: serverNow.toISOString(),
        };
        pendingDispatches.push(
          { recipientPublicId: callerPublicId, event: 'call.ended', payload: endedPayload },
          { recipientPublicId: calleePublicId, event: 'call.ended', payload: endedPayload },
        );

        if (insertedEvent?.created) {
          const msgPayload = {
            conversationPublicId: conversation.publicId,
            messagePublicId: insertedEvent.message.publicId,
            seq: Number(insertedEvent.message.seq),
            senderPublicId: actor.user.publicId,
            createdAt: insertedEvent.message.createdAt.toISOString(),
            recipientInboxState: 'primary',
          };
          pendingDispatches.push(
            {
              recipientPublicId: callerPublicId,
              event: 'chat.message.created',
              payload: msgPayload,
            },
            {
              recipientPublicId: calleePublicId,
              event: 'chat.message.created',
              payload: msgPayload,
            },
          );
        }

        return { expired: true as const };
      }

      if (session.status !== 'ringing' && session.status !== 'connected') {
        throw new CallDomainError({
          status: 409,
          code: 'CALL_ALREADY_ENDED',
          message: CALL_MESSAGES.alreadyEnded,
        });
      }

      // Làm mới nhịp giữ kết nối khi nhận tín hiệu renegotiation/ICE hợp lệ trong lúc `connected`.
      if (session.status === 'connected') {
        await this.repository.updateCallSession(session.id, { lastHeartbeatAt: serverNow }, tx);
      }

      const signalPayload: Record<string, unknown> =
        parsed.data.type === 'ice-candidate'
          ? {
              callPublicId: session.publicId,
              conversationPublicId: conversation.publicId,
              fromPublicId: actor.user.publicId,
              type: 'ice-candidate',
              candidate: parsed.data.candidate,
              ...(parsed.data.sdpMid !== undefined ? { sdpMid: parsed.data.sdpMid } : {}),
              ...(parsed.data.sdpMLineIndex !== undefined
                ? { sdpMLineIndex: parsed.data.sdpMLineIndex }
                : {}),
              ...(parsed.data.usernameFragment !== undefined
                ? { usernameFragment: parsed.data.usernameFragment }
                : {}),
            }
          : {
              callPublicId: session.publicId,
              conversationPublicId: conversation.publicId,
              fromPublicId: actor.user.publicId,
              type: parsed.data.type,
              sdp: parsed.data.sdp,
            };

      pendingDispatches.push({
        recipientPublicId: peerUser!.publicId,
        event: 'call.signal',
        payload: signalPayload,
      });

      return { expired: false as const };
    });

    await this.dispatchPendingRealtimeEvents(pendingDispatches);

    if (outcome.expired) {
      throw new CallDomainError({
        status: 409,
        code: 'CALL_ALREADY_ENDED',
        message: CALL_MESSAGES.alreadyEnded,
      });
    }

    return { relayed: true };
  }

  // =========================================================================
  // 4. Hành động Cuộc gọi (`POST /api/v1/calls/:callPublicId/action`)
  //    `accept` | `decline` | `end` | `timeout` | `heartbeat`
  // =========================================================================

  async performCallAction(
    actor: AuthenticatedPrincipal,
    rawCallPublicId: string,
    rawInput: unknown,
  ): Promise<{ readonly call: CallSessionDto; readonly message: string }> {
    assertCallAuthorized(actor, 'call:ice_servers');
    await this.consumeRateLimitOrThrow(
      `calls:action:user:${actor.user.id}`,
      CALL_RATE_LIMITS.actionByUser,
    );

    const callPublicId = parseCallPublicIdOrThrowNotFound(rawCallPublicId);
    const parsed = callActionInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new CallDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CALL_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const pendingDispatches: PendingCallRealtimeDispatch[] = [];
    let declineCooldownPair: { readonly callerId: string; readonly calleeId: string } | null = null;

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const serverNow = await this.resolveAuthoritativeNow(tx);
      const session = await this.repository.lockCallSessionByPublicId(callPublicId, tx);
      if (!session) {
        throw new CallDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CALL_MESSAGES.notFound,
        });
      }

      const isCaller = session.callerId === actor.user.id;
      const isCallee = session.calleeId === actor.user.id;
      const peerUserId = isCaller ? session.calleeId : session.callerId;

      const [peerUser, relationship, conversation] = await Promise.all([
        this.repository.findUserById(peerUserId, tx),
        this.repository.getRelationshipSnapshot(actor.user.id, peerUserId, tx),
        this.repository.findConversationById(session.conversationId, tx),
      ]);

      assertCallAuthorized(actor, 'call:action', {
        callSession: session,
        peerUser,
        relationship,
      });

      if (!conversation) {
        throw new CallDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CALL_MESSAGES.notFound,
        });
      }

      const callerPublicId = isCaller ? actor.user.publicId : peerUser!.publicId;
      const calleePublicId = isCallee ? actor.user.publicId : peerUser!.publicId;

      const recordTerminalAndDispatch = async (
        nextStatus: 'ended' | 'missed' | 'declined',
        eventName: 'call.ended' | 'call.declined',
      ): Promise<CallSessionRow> => {
        const updated = (await this.repository.updateCallSession(
          session.id,
          {
            status: nextStatus,
            endedAt: serverNow,
          },
          tx,
        )) ?? {
          ...session,
          status: nextStatus,
          endedAt: serverNow,
        };

        const durationSeconds = computeCallDurationSeconds(updated);
        const insertedEvent = await this.repository.insertCallEventMessageInTx(
          {
            conversationId: conversation.id,
            actorUserId: actor.user.id,
            callerUserId: session.callerId,
            calleeUserId: session.calleeId,
            callEventMeta: {
              callPublicId: updated.publicId,
              callType: updated.callType,
              status: nextStatus,
              callerPublicId,
              durationSeconds,
            },
            now: serverNow,
          },
          tx,
        );

        const terminalPayload = {
          callPublicId: updated.publicId,
          conversationPublicId: conversation.publicId,
          callType: updated.callType,
          status: nextStatus,
          durationSeconds,
          endedAt: serverNow.toISOString(),
        };
        pendingDispatches.push(
          { recipientPublicId: callerPublicId, event: eventName, payload: terminalPayload },
          { recipientPublicId: calleePublicId, event: eventName, payload: terminalPayload },
        );

        if (insertedEvent?.created) {
          const msgPayload = {
            conversationPublicId: conversation.publicId,
            messagePublicId: insertedEvent.message.publicId,
            seq: Number(insertedEvent.message.seq),
            senderPublicId: actor.user.publicId,
            createdAt: insertedEvent.message.createdAt.toISOString(),
            recipientInboxState: 'primary',
          };
          pendingDispatches.push(
            {
              recipientPublicId: callerPublicId,
              event: 'chat.message.created',
              payload: msgPayload,
            },
            {
              recipientPublicId: calleePublicId,
              event: 'chat.message.created',
              payload: msgPayload,
            },
          );
        }

        return updated;
      };

      const action = parsed.data.action;

      if (action === 'heartbeat') {
        if (session.status !== 'connected') {
          throw new CallDomainError({
            status: 409,
            code: 'CALL_ALREADY_ENDED',
            message: CALL_MESSAGES.alreadyEnded,
          });
        }

        const lastBeat = session.lastHeartbeatAt ?? session.connectedAt ?? session.startedAt;
        if (serverNow.getTime() - lastBeat.getTime() > CALL_HEARTBEAT_STALE_MS) {
          await recordTerminalAndDispatch('ended', 'call.ended');
          return { expiredError: true as const };
        }

        const updated = (await this.repository.updateCallSession(
          session.id,
          { lastHeartbeatAt: serverNow },
          tx,
        )) ?? {
          ...session,
          lastHeartbeatAt: serverNow,
        };

        return {
          expiredError: false as const,
          call: toCallSessionDto(
            updated,
            conversation.publicId,
            callerPublicId,
            calleePublicId,
            peerUser!,
          ),
          message: CALL_MESSAGES.callHeartbeatOk,
        };
      }

      if (action === 'accept') {
        if (!isCallee) {
          throw new CallDomainError({
            status: 403,
            code: 'FORBIDDEN',
            message: CALL_MESSAGES.invalidActionForRole,
          });
        }

        if (session.status === 'connected') {
          return {
            expiredError: false as const,
            call: toCallSessionDto(
              session,
              conversation.publicId,
              callerPublicId,
              calleePublicId,
              peerUser!,
            ),
            message: CALL_MESSAGES.callAccepted,
          };
        }

        if (session.status !== 'ringing') {
          throw new CallDomainError({
            status: 409,
            code: 'CALL_ALREADY_ENDED',
            message: CALL_MESSAGES.alreadyEnded,
          });
        }

        if (serverNow.getTime() - session.startedAt.getTime() > CALL_RING_TIMEOUT_MS) {
          await recordTerminalAndDispatch('missed', 'call.ended');
          return { expiredError: true as const };
        }

        const updated = (await this.repository.updateCallSession(
          session.id,
          {
            status: 'connected',
            connectedAt: serverNow,
            lastHeartbeatAt: serverNow,
          },
          tx,
        )) ?? {
          ...session,
          status: 'connected' as const,
          connectedAt: serverNow,
          lastHeartbeatAt: serverNow,
        };

        const acceptedPayload = {
          callPublicId: updated.publicId,
          conversationPublicId: conversation.publicId,
          callType: updated.callType,
          connectedAt: serverNow.toISOString(),
          acceptedByPublicId: calleePublicId,
        };
        pendingDispatches.push(
          { recipientPublicId: callerPublicId, event: 'call.accepted', payload: acceptedPayload },
          { recipientPublicId: calleePublicId, event: 'call.accepted', payload: acceptedPayload },
        );

        return {
          expiredError: false as const,
          call: toCallSessionDto(
            updated,
            conversation.publicId,
            callerPublicId,
            calleePublicId,
            peerUser!,
          ),
          message: CALL_MESSAGES.callAccepted,
        };
      }

      if (action === 'decline') {
        if (!isCallee) {
          throw new CallDomainError({
            status: 403,
            code: 'FORBIDDEN',
            message: CALL_MESSAGES.invalidActionForRole,
          });
        }

        if (
          session.status === 'declined' ||
          session.status === 'ended' ||
          session.status === 'missed' ||
          session.status === 'busy'
        ) {
          return {
            expiredError: false as const,
            call: toCallSessionDto(
              session,
              conversation.publicId,
              callerPublicId,
              calleePublicId,
              peerUser!,
            ),
            message: CALL_MESSAGES.callDeclined,
          };
        }

        if (session.status !== 'ringing') {
          throw new CallDomainError({
            status: 409,
            code: 'CALL_INVALID_STATE',
            message: CALL_MESSAGES.invalidStateTransition,
          });
        }

        const updated = await recordTerminalAndDispatch('declined', 'call.declined');
        declineCooldownPair = { callerId: session.callerId, calleeId: session.calleeId };

        return {
          expiredError: false as const,
          call: toCallSessionDto(
            updated,
            conversation.publicId,
            callerPublicId,
            calleePublicId,
            peerUser!,
          ),
          message: CALL_MESSAGES.callDeclined,
        };
      }

      if (action === 'timeout') {
        if (
          session.status === 'missed' ||
          session.status === 'ended' ||
          session.status === 'declined' ||
          session.status === 'busy'
        ) {
          return {
            expiredError: false as const,
            call: toCallSessionDto(
              session,
              conversation.publicId,
              callerPublicId,
              calleePublicId,
              peerUser!,
            ),
            message: CALL_MESSAGES.callMissed,
          };
        }

        if (session.status !== 'ringing') {
          throw new CallDomainError({
            status: 409,
            code: 'CALL_INVALID_STATE',
            message: CALL_MESSAGES.invalidStateTransition,
          });
        }

        const elapsedMs = serverNow.getTime() - session.startedAt.getTime();
        if (isCallee && elapsedMs < CALL_CALLEE_TIMEOUT_MIN_ELAPSED_MS) {
          throw new CallDomainError({
            status: 409,
            code: 'CALL_INVALID_STATE',
            message: CALL_MESSAGES.timeoutTooEarly,
          });
        }

        const updated = await recordTerminalAndDispatch('missed', 'call.ended');
        return {
          expiredError: false as const,
          call: toCallSessionDto(
            updated,
            conversation.publicId,
            callerPublicId,
            calleePublicId,
            peerUser!,
          ),
          message: CALL_MESSAGES.callMissed,
        };
      }

      // `action === 'end'`
      if (
        session.status === 'ended' ||
        session.status === 'missed' ||
        session.status === 'declined' ||
        session.status === 'busy'
      ) {
        return {
          expiredError: false as const,
          call: toCallSessionDto(
            session,
            conversation.publicId,
            callerPublicId,
            calleePublicId,
            peerUser!,
          ),
          message: CALL_MESSAGES.callEnded,
        };
      }

      const terminalStatus = session.status === 'ringing' ? 'missed' : 'ended';
      const updated = await recordTerminalAndDispatch(terminalStatus, 'call.ended');

      return {
        expiredError: false as const,
        call: toCallSessionDto(
          updated,
          conversation.publicId,
          callerPublicId,
          calleePublicId,
          peerUser!,
        ),
        message: terminalStatus === 'missed' ? CALL_MESSAGES.callMissed : CALL_MESSAGES.callEnded,
      };
    });

    if (declineCooldownPair) {
      const pair: { readonly callerId: string; readonly calleeId: string } = declineCooldownPair;
      try {
        await this.declineCooldownStore.setDeclinedCooldown(
          pair.callerId,
          pair.calleeId,
          CALL_DECLINE_COOLDOWN_SECONDS,
        );
      } catch (error) {
        logger.warn(
          {
            component: 'call-signaling-service',
            errorName: error instanceof Error ? error.name : 'RedisError',
          },
          'Không thể ghi cooldown chống gọi lại sau khi từ chối',
        );
      }
    }

    await this.dispatchPendingRealtimeEvents(pendingDispatches);

    if (outcome.expiredError) {
      throw new CallDomainError({
        status: 409,
        code: 'CALL_ALREADY_ENDED',
        message: CALL_MESSAGES.alreadyEnded,
      });
    }

    return {
      call: outcome.call,
      message: outcome.message,
    };
  }

  // =========================================================================
  // 5. Móc nối Cưỡng chế Ngắt Cuộc gọi tức thì khi Block (`SocialService.blockUser`)
  // =========================================================================

  async terminateActiveCallsOnBlockInTx(
    tx: DatabaseTransaction,
    params: {
      readonly blockerId: string;
      readonly blockerPublicId: string;
      readonly blockedId: string;
      readonly blockedPublicId: string;
      readonly now: Date;
    },
  ): Promise<PendingCallRealtimeDispatch[]> {
    await applyRlsSessionContext(tx, params.blockerId);
    const terminated = await this.repository.terminateActiveCallsBetweenUsersInTx(
      params.blockerId,
      params.blockedId,
      params.now,
      tx,
    );

    const dispatches: PendingCallRealtimeDispatch[] = [];
    for (const item of terminated) {
      // Lý do hoàn toàn trung tính (`status: 'ended'`), TUYỆT ĐỐI không tiết lộ việc bị chặn.
      const neutralPayload = {
        callPublicId: item.callPublicId,
        conversationPublicId: item.conversationPublicId,
        status: 'ended',
        endedAt: item.endedAt.toISOString(),
      };
      dispatches.push(
        {
          recipientPublicId: params.blockerPublicId,
          event: 'call.ended',
          payload: neutralPayload,
        },
        {
          recipientPublicId: params.blockedPublicId,
          event: 'call.ended',
          payload: neutralPayload,
        },
      );
    }

    return dispatches;
  }
}

export function createCallSignalingService(
  deps: CallSignalingServiceDependencies = {},
): CallSignalingService {
  return new CallSignalingService(deps);
}

const globalForCalls = globalThis as typeof globalThis & {
  __tomatoCallSignalingService?: CallSignalingService;
};

export function getCallSignalingService(): CallSignalingService {
  if (!globalForCalls.__tomatoCallSignalingService) {
    globalForCalls.__tomatoCallSignalingService = createCallSignalingService();
  }
  return globalForCalls.__tomatoCallSignalingService;
}

export function setCallSignalingServiceForTesting(service: CallSignalingService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setCallSignalingServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForCalls.__tomatoCallSignalingService = service;
}

export function resetCallSignalingServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetCallSignalingServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForCalls.__tomatoCallSignalingService = undefined;
}
