import 'server-only';

import type {
  ConversationInboxState,
  E2eeBackupKdfParamsRecord,
  E2eePublicJwkRecord,
  MessageCryptoHeaderRecord,
  MessageRow,
  MessageType,
  UserE2eeDeviceRow,
  UserE2eeKeyBackupRow,
} from '@/core/db/schema';
import { getRealtimeProvider, type RealtimeProvider } from '@/core/realtime';
import { CHAT_RATE_LIMITS, getRateLimiter, type RateLimiter } from '@/core/redis';
import { formatZodErrorDetails } from '@/core/security/http-response';
import { computeDeviceKeyFingerprint } from '@/lib/e2ee/utils';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { ChatDomainError } from '@/modules/chat/chat.errors';
import { CHAT_MESSAGES } from '@/modules/chat/chat.messages';
import { assertChatAuthorized, canExposeSymmetricReadReceipt } from '@/modules/chat/chat.policy';
import {
  ChatRepository,
  buildDirectPairKey,
  type ConversationListRowRecord,
} from '@/modules/chat/chat.repository';
import {
  deriveUserBootstrapKeyPairBundle,
  type UserBootstrapKeyPairBundle,
} from '@/modules/chat/e2ee-bootstrap';
import {
  MAX_ACTIVE_E2EE_DEVICES_PER_USER,
  MAX_PENDING_MESSAGES_BEFORE_ACCEPT,
  chatPublicIdParamSchema,
  createDirectConversationInputSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  markConversationReadInputSchema,
  registerE2eeDeviceInputSchema,
  sendMessageInputSchema,
  upsertE2eeBackupInputSchema,
} from '@/modules/chat/chat.schemas';
import {
  getNotificationService,
  type NotificationService,
  type PendingRealtimeDispatch,
} from '@/modules/notifications';
import {
  EMPTY_SOCIAL_RELATIONSHIP,
  isActiveSocialTarget,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';

// ============================================================================
// DTO Allowlists (Tuyệt đối không lộ khóa chính UUIDv7 `id`)
// ============================================================================

export interface E2eeDeviceKeyDto {
  readonly devicePublicId: string;
  readonly deviceLabel: string;
  readonly keyFingerprint: string;
  readonly identityPublicKeyJwk: E2eePublicJwkRecord;
  readonly signingPublicKeyJwk: E2eePublicJwkRecord;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

export interface UserE2eeKeyBundleDto {
  readonly userPublicId: string;
  readonly devices: readonly E2eeDeviceKeyDto[];
  readonly hasKeyBackup: boolean;
  readonly backupKeyFingerprint: string | null;
}

export interface E2eeKeyBackupDto {
  readonly encryptedKeyBlob: string;
  readonly kdfSalt: string;
  readonly kdfParams: E2eeBackupKdfParamsRecord;
  readonly iv: string;
  readonly keyFingerprint: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface ChatPeerUserDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
}

export interface ChatMessageDto {
  readonly public_id: string;
  readonly conversationPublicId: string;
  readonly senderPublicId: string;
  readonly isOwnMessage: boolean;
  readonly seq: number;
  readonly clientMsgId: string;
  readonly messageType: MessageType;
  readonly ciphertext: string | null;
  readonly cryptoHeader: MessageCryptoHeaderRecord | null;
  readonly editCount: number;
  readonly editedAt: string | null;
  readonly recalledAt: string | null;
  readonly createdAt: string;
}

export interface ConversationParticipantStateDto {
  readonly inboxState: ConversationInboxState;
  readonly pendingMessagesSent: number;
  readonly pendingMessagesRemaining: number;
  readonly lastReadSeq: number;
}

export interface ConversationSummaryDto {
  readonly public_id: string;
  readonly type: 'direct';
  readonly lastSeq: number;
  readonly lastMessageAt: string | null;
  readonly createdAt: string;
  readonly peer: ChatPeerUserDto;
  readonly myState: ConversationParticipantStateDto;
  /**
   * Cho phép người gửi biết cuộc trò chuyện vẫn đang chờ chấp nhận để UI khóa nút gửi ảnh/voice
   * và hiển thị số tin nhắn chờ còn lại; nhưng TUYỆT ĐỐI KHÔNG tiết lộ trạng thái `'declined'`
   * (nếu đối phương đã từ chối thì luôn hiển thị như `'pending'` đối với người gửi).
   */
  readonly isAwaitingPeerAcceptance: boolean;
  readonly canSendMedia: boolean;
  readonly canSendMoreMessages: boolean;
  /**
   * Cưỡng chế đối xứng tại Server: chỉ trả số `seq` đối phương đã đọc khi CẢ HAI người dùng
   * đều bật `show_read_receipts = true` và hội thoại ở trạng thái `primary` ở cả 2 phía.
   * Ngược lại luôn trả `null`.
   */
  readonly peerLastReadSeq: number | null;
  readonly lastMessage: ChatMessageDto | null;
}

export interface ConversationListResult {
  readonly tab: 'primary' | 'pending';
  readonly items: readonly ConversationSummaryDto[];
  readonly pendingCount: number;
  readonly unreadConversationsCount: number;
  readonly nextCursor: string | null;
}

export interface MarkConversationReadResult {
  readonly conversationPublicId: string;
  readonly lastReadSeq: number;
  readonly peerLastReadSeq: number | null;
  readonly unreadConversationsCount: number;
}

export interface MessageListResult {
  readonly conversationPublicId: string;
  readonly items: readonly ChatMessageDto[];
  readonly nextCursor: number | null;
}

export interface SendMessageResult {
  readonly message: ChatMessageDto;
  readonly conversation: ConversationSummaryDto;
  readonly deduplicated: boolean;
}

export interface ConversationDecisionResult {
  readonly conversationPublicId: string;
  readonly inboxState: ConversationInboxState;
  readonly message: string;
}

function toDeviceDto(row: UserE2eeDeviceRow): E2eeDeviceKeyDto {
  return {
    devicePublicId: row.publicId,
    deviceLabel: row.deviceLabel,
    keyFingerprint: row.keyFingerprint,
    identityPublicKeyJwk: row.identityPublicKeyJwk,
    signingPublicKeyJwk: row.signingPublicKeyJwk,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function toBackupDto(row: UserE2eeKeyBackupRow): E2eeKeyBackupDto {
  return {
    encryptedKeyBlob: row.encryptedKeyBlob,
    kdfSalt: row.kdfSalt,
    kdfParams: row.kdfParams,
    iv: row.iv,
    keyFingerprint: row.keyFingerprint,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessageDto(
  row: MessageRow,
  conversationPublicId: string,
  senderPublicId: string,
  viewerPublicId: string,
): ChatMessageDto {
  return {
    public_id: row.publicId,
    conversationPublicId,
    senderPublicId,
    isOwnMessage: senderPublicId === viewerPublicId,
    seq: Number(row.seq),
    clientMsgId: row.clientMsgId,
    messageType: row.messageType,
    ciphertext: row.recalledAt ? null : row.ciphertext,
    cryptoHeader: row.recalledAt ? null : row.cryptoHeader,
    editCount: row.editCount,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    recalledAt: row.recalledAt ? row.recalledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toConversationSummaryDto(
  record: ConversationListRowRecord,
  viewerPublicId: string,
  options?: {
    readonly viewerShowReadReceipts?: boolean;
    readonly relationship?: SocialRelationshipSnapshot | null;
  },
): ConversationSummaryDto {
  const isPeerNotAcceptedYet = record.peerParticipant.inboxState !== 'primary';
  const isMyInboxPending = record.actorParticipant.inboxState !== 'primary';
  const isAwaitingPeerAcceptance = !isMyInboxPending && isPeerNotAcceptedYet;
  const sentCount = record.actorParticipant.pendingMessagesSent;
  const remaining = isAwaitingPeerAcceptance
    ? Math.max(0, MAX_PENDING_MESSAGES_BEFORE_ACCEPT - sentCount)
    : MAX_PENDING_MESSAGES_BEFORE_ACCEPT;

  const lastMessageDto = record.lastMessage
    ? toMessageDto(
        record.lastMessage.row,
        record.conversation.publicId,
        record.lastMessage.senderPublicId,
        viewerPublicId,
      )
    : null;

  // Nếu tin nhắn cuối cùng trong hội thoại là do chính mình gửi (kể cả dữ liệu cũ từ M9 có last_read_seq = 0),
  // mốc đã đọc hiệu lực của bản thân luôn đạt ít nhất bằng seq của tin nhắn đó để tránh chấm đỏ chưa đọc ảo.
  const rawMyLastReadSeq = Number(record.actorParticipant.lastReadSeq);
  const effectiveMyLastReadSeq =
    lastMessageDto && lastMessageDto.isOwnMessage
      ? Math.max(rawMyLastReadSeq, lastMessageDto.seq)
      : rawMyLastReadSeq;

  const canShowPeerRead = canExposeSymmetricReadReceipt({
    actorShowReadReceipts: options?.viewerShowReadReceipts ?? true,
    peerShowReadReceipts: Boolean(record.peerUser.showReadReceipts ?? true),
    actorInboxState: record.actorParticipant.inboxState,
    peerInboxState: record.peerParticipant.inboxState,
    relationship: options?.relationship ?? EMPTY_SOCIAL_RELATIONSHIP,
  });

  return {
    public_id: record.conversation.publicId,
    type: 'direct',
    lastSeq: Number(record.conversation.lastSeq),
    lastMessageAt: record.conversation.lastMessageAt
      ? record.conversation.lastMessageAt.toISOString()
      : null,
    createdAt: record.conversation.createdAt.toISOString(),
    peer: {
      public_id: record.peerUser.publicId,
      handle: record.peerUser.handle,
      fullName: record.peerUser.fullName,
      avatarUrl: record.peerUser.avatarUrl,
      isPrivate: record.peerUser.isPrivate,
    },
    myState: {
      inboxState: record.actorParticipant.inboxState,
      pendingMessagesSent: sentCount,
      pendingMessagesRemaining: remaining,
      lastReadSeq: effectiveMyLastReadSeq,
    },
    isAwaitingPeerAcceptance,
    canSendMedia: !isAwaitingPeerAcceptance && !isMyInboxPending,
    canSendMoreMessages: !isAwaitingPeerAcceptance || remaining > 0,
    peerLastReadSeq: canShowPeerRead ? Number(record.peerParticipant.lastReadSeq) : null,
    lastMessage: lastMessageDto,
  };
}

function parsePublicIdOrThrowNotFound(raw: string): string {
  const parsed = chatPublicIdParamSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ChatDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: CHAT_MESSAGES.notFound,
    });
  }
  return parsed.data;
}

export interface ChatServiceDependencies {
  readonly repository?: ChatRepository;
  readonly rateLimiter?: Pick<RateLimiter, 'consume'>;
  readonly realtimeProvider?: RealtimeProvider;
  readonly notificationService?: NotificationService | null;
  readonly now?: () => Date;
}

export class ChatService {
  private readonly repository: ChatRepository;
  private readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  private readonly realtimeProvider: RealtimeProvider;
  private readonly notificationService: NotificationService | null;
  private readonly now: () => Date;

  constructor(deps: ChatServiceDependencies = {}) {
    this.repository = deps.repository ?? new ChatRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.realtimeProvider = deps.realtimeProvider ?? getRealtimeProvider();
    this.notificationService =
      deps.notificationService !== undefined
        ? deps.notificationService
        : deps.repository === undefined
          ? getNotificationService()
          : null;
    this.now = deps.now ?? (() => new Date());
  }

  private async consumeRateLimitOrThrow(
    key: string,
    rule: (typeof CHAT_RATE_LIMITS)[keyof typeof CHAT_RATE_LIMITS],
    customMessage?: (retryAfterSeconds: number) => string,
  ): Promise<void> {
    const result = await this.rateLimiter.consume(key, rule);
    if (!result.allowed) {
      throw new ChatDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: customMessage
          ? customMessage(result.retryAfterSeconds)
          : CHAT_MESSAGES.rateLimited(result.retryAfterSeconds),
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  // =========================================================================
  // 1. Quản lý Khóa Thiết bị E2EE & Sao lưu Mã PIN 6 số
  // =========================================================================

  async registerDeviceKeys(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
  ): Promise<{
    readonly device: E2eeDeviceKeyDto;
    readonly revokedDevicePublicIds: readonly string[];
    readonly bootstrapKeyPair: UserBootstrapKeyPairBundle;
    readonly message: string;
  }> {
    assertChatAuthorized(actor, 'e2ee:device:register');
    await this.consumeRateLimitOrThrow(
      `chat:e2ee:register:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.registerDeviceByUser,
    );

    const parsed = registerE2eeDeviceInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    // Server tự tính lại SHA-256 fingerprint từ JWK để chống client gửi fingerprint giả mạo.
    const computedFingerprint = await computeDeviceKeyFingerprint(
      parsed.data.identityPublicKeyJwk,
      parsed.data.signingPublicKeyJwk,
    );

    if (
      parsed.data.keyFingerprint !== undefined &&
      parsed.data.keyFingerprint !== computedFingerprint
    ) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: [
          {
            field: 'keyFingerprint',
            message: 'Key fingerprint không khớp với cặp khóa công khai P-256.',
          },
        ],
      });
    }

    const currentTime = this.now();
    const bootstrapKeyPair = await deriveUserBootstrapKeyPairBundle(actor.user.id);

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      return this.repository.upsertUserE2eeDevice(
        {
          userId: actor.user.id,
          sessionFamilyId: actor.session.familyId ?? null,
          deviceLabel: parsed.data.deviceLabel ?? 'Trình duyệt web',
          identityPublicKeyJwk: parsed.data.identityPublicKeyJwk,
          signingPublicKeyJwk: parsed.data.signingPublicKeyJwk,
          keyFingerprint: computedFingerprint,
          maxActiveDevices: MAX_ACTIVE_E2EE_DEVICES_PER_USER,
          now: currentTime,
        },
        tx,
      );
    });

    return {
      device: toDeviceDto(outcome.device),
      revokedDevicePublicIds: outcome.revokedDevicePublicIds,
      bootstrapKeyPair,
      message: CHAT_MESSAGES.deviceRegistered,
    };
  }

  async getUserPublicKeyBundle(
    actor: AuthenticatedPrincipal,
    rawTargetUserPublicId: string,
  ): Promise<UserE2eeKeyBundleDto> {
    assertChatAuthorized(actor, 'e2ee:device:register');
    await this.consumeRateLimitOrThrow(
      `chat:e2ee:keys:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.readKeysByUser,
    );

    const targetPublicId = parsePublicIdOrThrowNotFound(rawTargetUserPublicId);
    const currentTime = this.now();

    return this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const targetUser = await this.repository.findUserByPublicId(targetPublicId, tx);
      const relationship = targetUser
        ? await this.repository.getRelationshipSnapshot(actor.user.id, targetUser.id, tx)
        : null;

      assertChatAuthorized(actor, 'e2ee:keys:read', {
        targetUser,
        relationship,
      });

      let devices = await this.repository.listActiveDevicesForUser(targetUser!.id, tx);

      // Nếu tài khoản đích chưa kịp đăng nhập sau khi hệ thống cập nhật (0 thiết bị),
      // tự động khởi tạo khóa công khai P-256 mặc định để người gửi vẫn nhắn tin được ngay lập tức.
      if (devices.length === 0) {
        const bootstrap = await deriveUserBootstrapKeyPairBundle(targetUser!.id);
        const provisioned = await this.repository.upsertUserE2eeDevice(
          {
            userId: targetUser!.id,
            sessionFamilyId: null,
            deviceLabel: 'Hộp thư mặc định',
            identityPublicKeyJwk: bootstrap.identityPublicKeyJwk,
            signingPublicKeyJwk: bootstrap.signingPublicKeyJwk,
            keyFingerprint: bootstrap.keyFingerprint,
            maxActiveDevices: MAX_ACTIVE_E2EE_DEVICES_PER_USER,
            now: currentTime,
          },
          tx,
        );
        devices = [provisioned.device];
      }

      const ownBackup =
        targetUser!.id === actor.user.id
          ? await this.repository.findKeyBackupByUserId(actor.user.id, tx)
          : null;

      return {
        userPublicId: targetUser!.publicId,
        devices: devices.slice(0, MAX_ACTIVE_E2EE_DEVICES_PER_USER).map(toDeviceDto),
        hasKeyBackup: ownBackup !== null,
        backupKeyFingerprint: ownBackup?.keyFingerprint ?? null,
      };
    });
  }

  async upsertKeyBackup(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
  ): Promise<{ readonly backup: E2eeKeyBackupDto; readonly message: string }> {
    assertChatAuthorized(actor, 'e2ee:backup:write');
    await this.consumeRateLimitOrThrow(
      `chat:e2ee:backup:write:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.writeKeyBackupByUser,
    );

    const parsed = upsertE2eeBackupInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const currentTime = this.now();
    const saved = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      return this.repository.upsertKeyBackup(
        {
          userId: actor.user.id,
          encryptedKeyBlob: parsed.data.encryptedKeyBlob,
          kdfSalt: parsed.data.kdfSalt,
          kdfParams: parsed.data.kdfParams,
          iv: parsed.data.iv,
          keyFingerprint: parsed.data.keyFingerprint,
          version: parsed.data.version ?? 1,
          now: currentTime,
        },
        tx,
      );
    });

    return {
      backup: toBackupDto(saved),
      message: CHAT_MESSAGES.backupSaved,
    };
  }

  async getKeyBackup(
    actor: AuthenticatedPrincipal,
  ): Promise<{ readonly backup: E2eeKeyBackupDto | null }> {
    assertChatAuthorized(actor, 'e2ee:backup:read');
    await this.consumeRateLimitOrThrow(
      `chat:e2ee:backup:read:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.readKeyBackupByUser,
    );

    const row = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      return this.repository.findKeyBackupByUserId(actor.user.id, tx);
    });

    return {
      backup: row ? toBackupDto(row) : null,
    };
  }

  // =========================================================================
  // 2. Danh sách & Khởi tạo Hội thoại 1-1 (`primary` vs `pending`)
  // =========================================================================

  async listConversations(
    actor: AuthenticatedPrincipal,
    rawQuery: Record<string, unknown>,
  ): Promise<ConversationListResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:list:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.listConversationsByUser,
    );

    const parsed = listConversationsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const { rows, pendingCount, unreadConversationsCount } = await this.repository.runInRlsTx(
      actor.user.id,
      async (tx) => {
        const [listRows, countPending, countUnread] = await Promise.all([
          this.repository.listConversationsForUser(
            {
              userId: actor.user.id,
              tab: parsed.data.tab,
              limit: parsed.data.limit,
            },
            tx,
          ),
          this.repository.countPendingConversationsForUser(actor.user.id, tx),
          typeof this.repository.countUnreadPrimaryConversationsForUser === 'function'
            ? this.repository.countUnreadPrimaryConversationsForUser(actor.user.id, tx)
            : Promise.resolve(null),
        ]);

        const fallbackUnreadCount =
          countUnread !== null
            ? countUnread
            : listRows.filter(
                (r) =>
                  r.actorParticipant.inboxState === 'primary' &&
                  Number(r.conversation.lastSeq) > Number(r.actorParticipant.lastReadSeq) &&
                  r.lastMessage !== null &&
                  r.lastMessage.senderPublicId !== actor.user.publicId,
              ).length;

        return {
          rows: listRows,
          pendingCount: countPending,
          unreadConversationsCount: fallbackUnreadCount,
        };
      },
    );

    const hasMore = rows.length > parsed.data.limit;
    const pageRows = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      tab: parsed.data.tab,
      items: pageRows.map((r) =>
        toConversationSummaryDto(r, actor.user.publicId, {
          viewerShowReadReceipts: actor.user.showReadReceipts,
        }),
      ),
      pendingCount,
      unreadConversationsCount,
      nextCursor: hasMore && lastRow ? lastRow.conversation.publicId : null,
    };
  }

  async createOrGetDirectConversation(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
  ): Promise<{ readonly conversation: ConversationSummaryDto; readonly created: boolean }> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:create:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.createConversationByUser,
    );

    const parsed = createDirectConversationInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    if (parsed.data.recipientPublicId === actor.user.publicId.toLowerCase()) {
      throw new ChatDomainError({
        status: 400,
        code: 'CHAT_SELF_CONVERSATION_FORBIDDEN',
        message: CHAT_MESSAGES.cannotMessageSelf,
      });
    }

    const targetCandidate = await this.repository.findUserByPublicId(parsed.data.recipientPublicId);
    if (!targetCandidate) {
      throw new ChatDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: CHAT_MESSAGES.notFound,
      });
    }

    if (targetCandidate.id === actor.user.id) {
      throw new ChatDomainError({
        status: 400,
        code: 'CHAT_SELF_CONVERSATION_FORBIDDEN',
        message: CHAT_MESSAGES.cannotMessageSelf,
      });
    }

    const currentTime = this.now();
    const pairKey = buildDirectPairKey(actor.user.id, targetCandidate.id);

    return this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, targetCandidate.id],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id);
      const lockedTarget = lockedUsers.get(targetCandidate.id);

      if (!isActiveSocialTarget(lockedActor) || !isActiveSocialTarget(lockedTarget)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const relationship = await this.repository.getRelationshipSnapshot(
        lockedActor.id,
        lockedTarget.id,
        tx,
      );
      assertChatAuthorized(actor, 'chat:conversation:create_or_get', {
        targetUser: lockedTarget,
        relationship,
      });

      // Luật quyết định `inbox_state` của người nhận B:
      // Vào thẳng 'primary' nếu B đang theo dõi A (`targetFollowStatus === 'following'`).
      const targetFollowsActor = relationship.targetFollowStatus === 'following';
      const initialRecipientInboxState: ConversationInboxState = targetFollowsActor
        ? 'primary'
        : 'pending';

      const { conversation, isNewlyCreated } = await this.repository.insertOrLockDirectConversation(
        pairKey,
        currentTime,
        tx,
      );

      const existingParticipants = await this.repository.lockConversationParticipants(
        conversation.id,
        tx,
      );

      let actorParticipant = existingParticipants.find((p) => p.userId === lockedActor.id) ?? null;
      let peerParticipant = existingParticipants.find((p) => p.userId === lockedTarget.id) ?? null;

      if (!actorParticipant || !peerParticipant) {
        // Nếu tạo mới một hội thoại ở trạng thái `pending` với người lạ: kiểm tra quota tối đa 5 người lạ mới/ngày.
        if (initialRecipientInboxState === 'pending') {
          await this.consumeRateLimitOrThrow(
            `chat:pending_new_daily:user:${lockedActor.id}`,
            CHAT_RATE_LIMITS.newPendingConversationDailyByUser,
            CHAT_MESSAGES.newPendingDailyQuotaExceeded,
          );
        }

        const inserted = await this.repository.insertConversationParticipants(
          [
            {
              conversationId: conversation.id,
              userId: lockedActor.id,
              inboxState: 'primary',
              pendingMessagesSent: 0,
              joinedAt: currentTime,
            },
            {
              conversationId: conversation.id,
              userId: lockedTarget.id,
              inboxState: initialRecipientInboxState,
              pendingMessagesSent: 0,
              joinedAt: currentTime,
            },
          ],
          tx,
        );
        actorParticipant = inserted.find((p) => p.userId === lockedActor.id)!;
        peerParticipant = inserted.find((p) => p.userId === lockedTarget.id)!;
      } else {
        // Nếu chính `actor` chủ động mở cuộc trò chuyện từ trang cá nhân / tìm kiếm thì hiển thị ở `primary` của `actor`.
        if (actorParticipant.inboxState !== 'primary' || actorParticipant.hiddenAt !== null) {
          actorParticipant =
            (await this.repository.updateParticipantState(
              conversation.id,
              lockedActor.id,
              {
                inboxState: 'primary',
                hiddenAt: null,
              },
              tx,
            )) ?? actorParticipant;
          // Nếu actor trước đó là người nhận tin nhắn chờ và chủ động mở chat -> coi như đã kết nối 2 chiều.
          if (peerParticipant.pendingMessagesSent > 0) {
            peerParticipant =
              (await this.repository.updateParticipantState(
                conversation.id,
                lockedTarget.id,
                { pendingMessagesSent: 0 },
                tx,
              )) ?? peerParticipant;
          }
        }

        // Nếu B đã follow A sau khi hội thoại `pending` được tạo (và B chưa từng `declined`), tự nâng cấp B lên `primary`.
        if (targetFollowsActor && peerParticipant.inboxState === 'pending') {
          peerParticipant =
            (await this.repository.updateParticipantState(
              conversation.id,
              lockedTarget.id,
              { inboxState: 'primary' },
              tx,
            )) ?? peerParticipant;
          if (actorParticipant.pendingMessagesSent > 0) {
            actorParticipant =
              (await this.repository.updateParticipantState(
                conversation.id,
                lockedActor.id,
                { pendingMessagesSent: 0 },
                tx,
              )) ?? actorParticipant;
          }
        }
      }

      const summary = toConversationSummaryDto(
        {
          conversation,
          actorParticipant,
          peerParticipant,
          peerUser: lockedTarget,
          lastMessage: null,
        },
        actor.user.publicId,
        {
          viewerShowReadReceipts: lockedActor.showReadReceipts,
          relationship,
        },
      );

      return {
        conversation: summary,
        created: isNewlyCreated,
      };
    });
  }

  async getConversationByPublicId(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
  ): Promise<{ readonly conversation: ConversationSummaryDto }> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:list:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.listConversationsByUser,
    );

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);

    const summary = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const conversation = await this.repository.findConversationByPublicId(
        conversationPublicId,
        tx,
      );
      if (!conversation) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
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

      assertChatAuthorized(actor, 'chat:conversation:view', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      return toConversationSummaryDto(
        {
          conversation,
          actorParticipant: actorParticipant!,
          peerParticipant: peerParticipant!,
          peerUser: peerUser!,
          lastMessage: null,
        },
        actor.user.publicId,
        {
          viewerShowReadReceipts: actor.user.showReadReceipts,
          relationship,
        },
      );
    });

    return { conversation: summary };
  }

  async markConversationAsRead(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
    rawInput: unknown = {},
  ): Promise<MarkConversationReadResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:read:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.markReadByUser,
    );

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);
    const parsedInput = markConversationReadInputSchema.safeParse(rawInput ?? {});
    if (!parsedInput.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsedInput.error),
      });
    }

    const currentTime = this.now();

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const conversation = await this.repository.findConversationByPublicId(
        conversationPublicId,
        tx,
      );
      if (!conversation) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const participants = await this.repository.lockConversationParticipants(conversation.id, tx);
      const actorParticipant = participants.find((p) => p.userId === actor.user.id) ?? null;
      const peerParticipant = participants.find((p) => p.userId !== actor.user.id) ?? null;
      const peerUser = peerParticipant
        ? await this.repository.findUserById(peerParticipant.userId, tx)
        : null;
      const relationship = peerUser
        ? await this.repository.getRelationshipSnapshot(actor.user.id, peerUser.id, tx)
        : null;

      assertChatAuthorized(actor, 'chat:conversation:read', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      const conversationLastSeq = Number(conversation.lastSeq);
      const previousLastReadSeq = Number(actorParticipant!.lastReadSeq);
      const requestedSeq =
        parsedInput.data.lastReadSeq !== undefined
          ? parsedInput.data.lastReadSeq
          : conversationLastSeq;
      const targetSeq = Math.max(previousLastReadSeq, Math.min(requestedSeq, conversationLastSeq));

      let updatedParticipant = actorParticipant!;
      if (targetSeq > previousLastReadSeq) {
        if (typeof this.repository.advanceParticipantLastReadSeq === 'function') {
          updatedParticipant = (await this.repository.advanceParticipantLastReadSeq(
            {
              conversationId: conversation.id,
              userId: actor.user.id,
              targetSeq: requestedSeq,
              conversationLastSeq,
            },
            tx,
          )) ?? {
            ...actorParticipant!,
            lastReadSeq: targetSeq,
          };
        } else {
          updatedParticipant = (await this.repository.updateParticipantState(
            conversation.id,
            actor.user.id,
            { lastReadSeq: targetSeq },
            tx,
          )) ?? {
            ...actorParticipant!,
            lastReadSeq: targetSeq,
          };
        }
      }

      const nextLastReadSeq = Number(updatedParticipant.lastReadSeq);

      const unreadConversationsCount =
        typeof this.repository.countUnreadPrimaryConversationsForUser === 'function'
          ? await this.repository.countUnreadPrimaryConversationsForUser(actor.user.id, tx)
          : 0;

      const canExposeReadReceipt = canExposeSymmetricReadReceipt({
        actorShowReadReceipts: actor.user.showReadReceipts,
        peerShowReadReceipts: peerUser!.showReadReceipts,
        actorInboxState: updatedParticipant.inboxState,
        peerInboxState: peerParticipant!.inboxState,
        relationship,
      });

      return {
        conversationPublicId: conversation.publicId,
        previousLastReadSeq,
        lastReadSeq: nextLastReadSeq,
        peerLastReadSeq: canExposeReadReceipt ? Number(peerParticipant!.lastReadSeq) : null,
        unreadConversationsCount,
        canExposeReadReceipt,
        peerPublicId: peerUser!.publicId,
        readAt: currentTime.toISOString(),
      };
    });

    const publishTasks: Promise<void>[] = [
      this.publishChatEventBestEffort(actor.user.publicId, 'chat.conversation.read', {
        conversationPublicId: outcome.conversationPublicId,
        readerPublicId: actor.user.publicId,
        lastReadSeq: outcome.lastReadSeq,
        unreadConversationsCount: outcome.unreadConversationsCount,
        readAt: outcome.readAt,
      }),
    ];

    // Cưỡng chế đối xứng tại Server: chỉ bắn sự kiện đã xem cho đối phương khi CẢ HAI người đều bật
    // `show_read_receipts = true`, hội thoại ở trạng thái `primary` ở cả 2 phía và `lastReadSeq` thực sự tăng.
    if (outcome.canExposeReadReceipt && outcome.lastReadSeq > outcome.previousLastReadSeq) {
      publishTasks.push(
        this.publishChatEventBestEffort(outcome.peerPublicId, 'chat.conversation.read', {
          conversationPublicId: outcome.conversationPublicId,
          readerPublicId: actor.user.publicId,
          lastReadSeq: outcome.lastReadSeq,
          readAt: outcome.readAt,
        }),
      );
    }

    await Promise.all(publishTasks);

    return {
      conversationPublicId: outcome.conversationPublicId,
      lastReadSeq: outcome.lastReadSeq,
      peerLastReadSeq: outcome.peerLastReadSeq,
      unreadConversationsCount: outcome.unreadConversationsCount,
    };
  }

  // =========================================================================
  // 3. Chấp nhận (`accept`) & Từ chối (`decline`) Tin nhắn đang chờ
  // =========================================================================

  async acceptMessageRequest(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
  ): Promise<ConversationDecisionResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:action:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.conversationActionByUser,
    );

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);
    const pendingDispatches: (PendingRealtimeDispatch | null)[] = [];

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const conversation = await this.repository.lockConversationByPublicId(
        conversationPublicId,
        tx,
      );
      if (!conversation) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const participants = await this.repository.lockConversationParticipants(conversation.id, tx);
      const actorParticipant = participants.find((p) => p.userId === actor.user.id) ?? null;
      const peerParticipant = participants.find((p) => p.userId !== actor.user.id) ?? null;
      const peerUser = peerParticipant
        ? await this.repository.findUserById(peerParticipant.userId, tx)
        : null;
      const relationship = peerUser
        ? await this.repository.getRelationshipSnapshot(actor.user.id, peerUser.id, tx)
        : null;

      assertChatAuthorized(actor, 'chat:conversation:accept', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      await this.repository.updateParticipantState(
        conversation.id,
        actor.user.id,
        {
          inboxState: 'primary',
          hiddenAt: null,
        },
        tx,
      );
      await this.repository.resetAllParticipantsPendingCount(conversation.id, tx);

      if (this.notificationService && peerUser) {
        pendingDispatches.push(
          await this.notificationService.removeMessageRequestNotificationsInTx(tx, {
            recipientId: actor.user.id,
            recipientPublicId: actor.user.publicId,
            actorIds: [peerUser.id],
          }),
        );
      }

      return {
        conversationPublicId: conversation.publicId,
        peerPublicId: peerUser!.publicId,
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    // Thông báo cập nhật trạng thái hội thoại cho cả 2 phía để mở khóa gửi ảnh/voice/presence ngay lập tức.
    await Promise.all([
      this.publishChatEventBestEffort(actor.user.publicId, 'chat.conversation.updated', {
        conversationPublicId: outcome.conversationPublicId,
        inboxState: 'primary',
      }),
      this.publishChatEventBestEffort(outcome.peerPublicId, 'chat.conversation.updated', {
        conversationPublicId: outcome.conversationPublicId,
        peerAccepted: true,
      }),
    ]);

    return {
      conversationPublicId: outcome.conversationPublicId,
      inboxState: 'primary',
      message: CHAT_MESSAGES.conversationAccepted,
    };
  }

  async declineMessageRequest(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
  ): Promise<ConversationDecisionResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:action:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.conversationActionByUser,
    );

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);
    const currentTime = this.now();
    const pendingDispatches: (PendingRealtimeDispatch | null)[] = [];

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const conversation = await this.repository.lockConversationByPublicId(
        conversationPublicId,
        tx,
      );
      if (!conversation) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const participants = await this.repository.lockConversationParticipants(conversation.id, tx);
      const actorParticipant = participants.find((p) => p.userId === actor.user.id) ?? null;
      const peerParticipant = participants.find((p) => p.userId !== actor.user.id) ?? null;
      const peerUser = peerParticipant
        ? await this.repository.findUserById(peerParticipant.userId, tx)
        : null;
      const relationship = peerUser
        ? await this.repository.getRelationshipSnapshot(actor.user.id, peerUser.id, tx)
        : null;

      assertChatAuthorized(actor, 'chat:conversation:decline', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      await this.repository.updateParticipantState(
        conversation.id,
        actor.user.id,
        {
          inboxState: 'declined',
          clearedBeforeSeq: Number(conversation.lastSeq),
          hiddenAt: currentTime,
        },
        tx,
      );

      if (this.notificationService && peerUser) {
        pendingDispatches.push(
          await this.notificationService.removeMessageRequestNotificationsInTx(tx, {
            recipientId: actor.user.id,
            recipientPublicId: actor.user.publicId,
            actorIds: [peerUser.id],
          }),
        );
      }

      return {
        conversationPublicId: conversation.publicId,
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    // Chỉ đồng bộ ẩn hội thoại trên các tab của chính người từ chối; IM LẶNG TUYỆT ĐỐI với người gửi.
    await this.publishChatEventBestEffort(actor.user.publicId, 'chat.conversation.updated', {
      conversationPublicId: outcome.conversationPublicId,
      inboxState: 'declined',
    });

    return {
      conversationPublicId: outcome.conversationPublicId,
      inboxState: 'declined',
      message: CHAT_MESSAGES.conversationDeclined,
    };
  }

  // =========================================================================
  // 4. Đọc & Gửi Tin nhắn E2EE (Monotonic `seq`, Idempotent `client_msg_id`, Delta-Sync `afterSeq`)
  // =========================================================================

  async listMessages(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<MessageListResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:list:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.listMessagesByUser,
    );

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);
    const parsedQuery = listMessagesQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsedQuery.error),
      });
    }

    const { rows, isForwardDelta } = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const conversation = await this.repository.findConversationByPublicId(
        conversationPublicId,
        tx,
      );
      if (!conversation) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
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

      assertChatAuthorized(actor, 'chat:message:list', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      const effectiveBeforeSeq = parsedQuery.data.beforeSeq ?? parsedQuery.data.cursor;

      const msgRows = await this.repository.listMessagesForConversation(
        {
          conversationId: conversation.id,
          clearedBeforeSeq: Number(actorParticipant!.clearedBeforeSeq),
          limit: parsedQuery.data.limit,
          cursorSeq: effectiveBeforeSeq,
          afterSeq: parsedQuery.data.afterSeq,
        },
        tx,
      );

      return {
        rows: msgRows,
        isForwardDelta: parsedQuery.data.afterSeq !== undefined && effectiveBeforeSeq === undefined,
      };
    });

    const hasMore = rows.length > parsedQuery.data.limit;
    const pageRows = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const orderedRows = isForwardDelta ? pageRows : [...pageRows].reverse();
    const oldestInBatch = orderedRows[0];

    return {
      conversationPublicId,
      items: orderedRows.map((item) =>
        toMessageDto(item.row, conversationPublicId, item.senderPublicId, actor.user.publicId),
      ),
      nextCursor:
        !isForwardDelta && hasMore && oldestInBatch ? Number(oldestInBatch.row.seq) : null,
    };
  }

  async sendMessage(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
    rawInput: unknown,
  ): Promise<SendMessageResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:send:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.sendMessageByUser,
    );

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);
    const parsed = sendMessageInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const currentTime = this.now();
    const pendingDispatches: (PendingRealtimeDispatch | null)[] = [];

    const txOutcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const conversation = await this.repository.lockConversationByPublicId(
        conversationPublicId,
        tx,
      );
      if (!conversation) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const participants = await this.repository.lockConversationParticipants(conversation.id, tx);
      let actorParticipant = participants.find((p) => p.userId === actor.user.id) ?? null;
      let peerParticipant = participants.find((p) => p.userId !== actor.user.id) ?? null;
      const peerUser = peerParticipant
        ? await this.repository.findUserById(peerParticipant.userId, tx)
        : null;
      const relationship = peerUser
        ? await this.repository.getRelationshipSnapshot(actor.user.id, peerUser.id, tx)
        : null;

      assertChatAuthorized(actor, 'chat:message:send', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      // 1. Kiểm tra Idempotency theo (conversation_id, sender_id, client_msg_id).
      const existingMsg = await this.repository.findMessageByClientMsgId(
        conversation.id,
        actor.user.id,
        parsed.data.clientMsgId,
        tx,
      );
      if (existingMsg) {
        const msgDto = toMessageDto(
          existingMsg,
          conversation.publicId,
          actor.user.publicId,
          actor.user.publicId,
        );
        const convDto = toConversationSummaryDto(
          {
            conversation,
            actorParticipant: actorParticipant!,
            peerParticipant: peerParticipant!,
            peerUser: peerUser!,
            lastMessage: {
              row: existingMsg,
              senderPublicId: actor.user.publicId,
            },
          },
          actor.user.publicId,
          {
            viewerShowReadReceipts: actor.user.showReadReceipts,
            relationship,
          },
        );
        return {
          message: msgDto,
          conversation: convDto,
          deduplicated: true,
          shouldNotifyPeerRealtime: false,
          peerPublicId: peerUser!.publicId,
        };
      }

      // 2. Nếu chính người nhận tin nhắn chờ trả lời -> tự động chấp nhận hội thoại sang `primary`.
      if (actorParticipant!.inboxState !== 'primary') {
        actorParticipant =
          (await this.repository.updateParticipantState(
            conversation.id,
            actor.user.id,
            {
              inboxState: 'primary',
              hiddenAt: null,
            },
            tx,
          )) ?? actorParticipant!;
        peerParticipant =
          (await this.repository.updateParticipantState(
            conversation.id,
            peerUser!.id,
            {
              pendingMessagesSent: 0,
            },
            tx,
          )) ?? peerParticipant!;

        if (this.notificationService) {
          pendingDispatches.push(
            await this.notificationService.removeMessageRequestNotificationsInTx(tx, {
              recipientId: actor.user.id,
              recipientPublicId: actor.user.publicId,
              actorIds: [peerUser!.id],
            }),
          );
        }
      }

      // 3. Nếu đối phương B đã follow A mà trước đó B đang ở `'pending'` (chưa từng `'declined'`), nâng B lên `'primary'`.
      if (
        peerParticipant!.inboxState === 'pending' &&
        relationship!.targetFollowStatus === 'following'
      ) {
        peerParticipant =
          (await this.repository.updateParticipantState(
            conversation.id,
            peerUser!.id,
            {
              inboxState: 'primary',
              hiddenAt: null,
            },
            tx,
          )) ?? peerParticipant!;
        if (actorParticipant!.pendingMessagesSent > 0) {
          actorParticipant =
            (await this.repository.updateParticipantState(
              conversation.id,
              actor.user.id,
              { pendingMessagesSent: 0 },
              tx,
            )) ?? actorParticipant!;
        }
      }

      // 4. Cưỡng chế luật Tin nhắn đang chờ khi đối phương chưa ở trạng thái `primary` (`'pending'` hoặc `'declined'`).
      const isPeerInPendingOrDeclined = peerParticipant!.inboxState !== 'primary';
      const isPeerDeclined = peerParticipant!.inboxState === 'declined';

      if (isPeerInPendingOrDeclined) {
        if (parsed.data.messageType !== 'text') {
          throw new ChatDomainError({
            status: 403,
            code: 'CHAT_PENDING_TEXT_ONLY',
            message: CHAT_MESSAGES.pendingTextOnly,
          });
        }

        if (actorParticipant!.pendingMessagesSent >= MAX_PENDING_MESSAGES_BEFORE_ACCEPT) {
          throw new ChatDomainError({
            status: 403,
            code: 'CHAT_PENDING_LIMIT_REACHED',
            message: CHAT_MESSAGES.pendingLimitReached,
          });
        }

        actorParticipant =
          (await this.repository.updateParticipantState(
            conversation.id,
            actor.user.id,
            {
              pendingMessagesSent: actorParticipant!.pendingMessagesSent + 1,
              hiddenAt: null,
            },
            tx,
          )) ?? actorParticipant!;
      }

      const nextSeq = Number(conversation.lastSeq) + 1;
      const insertedMsg = await this.repository.insertMessageAndIncrementSeq(
        {
          conversationId: conversation.id,
          nextSeq,
          senderId: actor.user.id,
          clientMsgId: parsed.data.clientMsgId,
          messageType: parsed.data.messageType,
          ciphertext: parsed.data.ciphertext,
          cryptoHeader: parsed.data.cryptoHeader,
          now: currentTime,
        },
        tx,
      );

      // Người gửi tin nhắn mới hiển nhiên đã đọc hội thoại tới `nextSeq`.
      if (Number(actorParticipant!.lastReadSeq) < nextSeq) {
        actorParticipant = (await this.repository.updateParticipantState(
          conversation.id,
          actor.user.id,
          {
            lastReadSeq: nextSeq,
            hiddenAt: null,
          },
          tx,
        )) ?? {
          ...actorParticipant!,
          lastReadSeq: nextSeq,
        };
      }

      // 5. Luật im lặng tuyệt đối sau khi `declined`:
      // Chỉ phát thông báo `message_request` khi đối phương đang ở trạng thái `'pending'` (KHÔNG phát khi đã `'declined'`).
      if (peerParticipant!.inboxState === 'pending' && this.notificationService) {
        pendingDispatches.push(
          await this.notificationService.recordNotificationInTx(tx, {
            recipient: peerUser!,
            actor: actor.user,
            type: 'message_request',
            entityPublicId: conversation.publicId,
            now: currentTime,
          }),
        );
      }

      const updatedConversation = {
        ...conversation,
        lastSeq: nextSeq,
        lastMessageAt: currentTime,
      };

      const msgDto = toMessageDto(
        insertedMsg,
        conversation.publicId,
        actor.user.publicId,
        actor.user.publicId,
      );
      const convDto = toConversationSummaryDto(
        {
          conversation: updatedConversation,
          actorParticipant: actorParticipant!,
          peerParticipant: peerParticipant!,
          peerUser: peerUser!,
          lastMessage: {
            row: insertedMsg,
            senderPublicId: actor.user.publicId,
          },
        },
        actor.user.publicId,
        {
          viewerShowReadReceipts: actor.user.showReadReceipts,
          relationship,
        },
      );

      return {
        message: msgDto,
        conversation: convDto,
        deduplicated: false,
        // Tuyệt đối không bắn sự kiện Realtime cho người nhận nếu họ đã `decline`.
        shouldNotifyPeerRealtime: !isPeerDeclined,
        peerPublicId: peerUser!.publicId,
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    if (!txOutcome.deduplicated) {
      // Sự kiện Realtime `chat.message.created` CHỈ gửi metadata tối giản,
      // TUYỆT ĐỐI KHÔNG đẩy `ciphertext` hay `cryptoHeader` qua bên thứ ba (Ably).
      const minimalEventPayload = {
        conversationPublicId: txOutcome.conversation.public_id,
        messagePublicId: txOutcome.message.public_id,
        seq: txOutcome.message.seq,
        senderPublicId: actor.user.publicId,
        createdAt: txOutcome.message.createdAt,
      };

      const publishTasks: Promise<void>[] = [
        this.publishChatEventBestEffort(
          actor.user.publicId,
          'chat.message.created',
          minimalEventPayload,
        ),
      ];

      if (txOutcome.shouldNotifyPeerRealtime) {
        publishTasks.push(
          this.publishChatEventBestEffort(
            txOutcome.peerPublicId,
            'chat.message.created',
            minimalEventPayload,
          ),
        );
      }

      await Promise.all(publishTasks);
    }

    return {
      message: txOutcome.message,
      conversation: txOutcome.conversation,
      deduplicated: txOutcome.deduplicated,
    };
  }

  private async publishChatEventBestEffort(
    recipientPublicId: string,
    eventName: 'chat.message.created' | 'chat.conversation.read' | 'chat.conversation.updated',
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.realtimeProvider.publishToUser(recipientPublicId, eventName, payload);
    } catch {
      // Best-effort: dữ liệu đã được lưu bền vững trong PostgreSQL.
    }
  }
}

export function createChatService(deps: ChatServiceDependencies = {}): ChatService {
  return new ChatService(deps);
}

const globalForChat = globalThis as typeof globalThis & {
  __tomatoChatService?: ChatService;
};

export function getChatService(): ChatService {
  if (!globalForChat.__tomatoChatService) {
    globalForChat.__tomatoChatService = createChatService();
  }
  return globalForChat.__tomatoChatService;
}

export function setChatServiceForTesting(service: ChatService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setChatServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForChat.__tomatoChatService = service;
}

export function resetChatServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetChatServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForChat.__tomatoChatService = undefined;
}
