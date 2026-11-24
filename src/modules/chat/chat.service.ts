import 'server-only';

import { createHash } from 'node:crypto';

import {
  generateOtpCode,
  hashScopedOtpCode,
  maskEmailAddress,
  verifyScopedOtpCode,
} from '@/core/crypto/otp';
import type {
  AttachmentMediaKind,
  ConversationInboxState,
  ConversationParticipantRow,
  E2eeBackupKdfParamsRecord,
  E2eePublicJwkRecord,
  MessageAttachmentRow,
  MessageCallEventMetaRecord,
  MessageCryptoHeaderRecord,
  MessageRow,
  MessageType,
  UserE2eeDeviceRow,
  UserE2eeKeyBackupRow,
} from '@/core/db/schema';
import { buildE2eePinResetOtpEmail, getEmailProvider, type EmailProvider } from '@/core/email';
import { logger } from '@/core/logger';
import { getRealtimeProvider, type RealtimeProvider } from '@/core/realtime';
import {
  CHAT_RATE_LIMITS,
  PIN_RESET_OTP_COOLDOWN_SECONDS,
  PIN_RESET_OTP_MAX_ATTEMPTS,
  PIN_RESET_OTP_TTL_MINUTES,
  PIN_RESET_OTP_TTL_SECONDS,
  getPinResetOtpStore,
  getRateLimiter,
  type PinResetOtpStore,
  type RateLimiter,
} from '@/core/redis';
import {
  getAuditLogService,
  type AuditAction,
  type AuditLogService,
} from '@/core/security/audit-log.service';
import type { RequestClientContext } from '@/core/security/client-context';
import { formatZodErrorDetails } from '@/core/security/http-response';
import {
  generateChatMediaStorageKey,
  getMediaStorageProvider,
  type MediaStorageProvider,
} from '@/core/storage';
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
  ATTACHMENT_LAZY_GC_BATCH_LIMIT,
  ATTACHMENT_ORPHAN_EXPIRY_MS,
  ATTACHMENT_UPLOAD_TOKEN_TTL_MS,
  MAX_ACTIVE_E2EE_DEVICES_PER_USER,
  MAX_IMAGE_CIPHERTEXT_BYTES,
  MAX_MESSAGE_EDIT_COUNT,
  MAX_PENDING_MESSAGES_BEFORE_ACCEPT,
  MAX_PINNED_CONVERSATIONS_PER_USER,
  MAX_PINNED_MESSAGES_PER_CONVERSATION,
  MAX_VOICE_CIPHERTEXT_BYTES,
  MESSAGE_EDIT_WINDOW_MS,
  MESSAGE_RECALL_WINDOW_MS,
  attachmentDownloadQuerySchema,
  chatPublicIdParamSchema,
  confirmPinResetInputSchema,
  createAttachmentUploadTokenInputSchema,
  createDirectConversationInputSchema,
  editMessageInputSchema,
  emptyStrictObjectSchema,
  listConversationsQuerySchema,
  listForwardTargetsQuerySchema,
  listMessagesQuerySchema,
  markConversationReadInputSchema,
  pinMessageInputSchema,
  registerE2eeDeviceInputSchema,
  sendMessageInputSchema,
  updateConversationPreferencesInputSchema,
  upsertE2eeBackupInputSchema,
  upsertReactionInputSchema,
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
  readonly isSyncKey: boolean;
  readonly identityPublicKeyJwk: E2eePublicJwkRecord;
  readonly signingPublicKeyJwk: E2eePublicJwkRecord;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

export interface E2eeHistoricalSigningKeyDto {
  readonly keyFingerprint: string;
  readonly identityPublicKeyJwk: E2eePublicJwkRecord;
  readonly signingPublicKeyJwk: E2eePublicJwkRecord;
}

export interface UserE2eeKeyBundleDto {
  readonly userPublicId: string;
  readonly devices: readonly E2eeDeviceKeyDto[];
  readonly historicalSigningKeys?: readonly E2eeHistoricalSigningKeyDto[];
  readonly hasKeyBackup: boolean;
  readonly backupKeyFingerprint: string | null;
  readonly backupVersion?: number | null;
}

export interface RequestPinResetOtpResult {
  readonly maskedEmail: string;
  readonly resendAfterSeconds: number;
  readonly expiresInMinutes: number;
  readonly message: string;
}

export interface ConfirmPinResetResult {
  readonly backup: E2eeKeyBackupDto;
  readonly device: E2eeDeviceKeyDto;
  readonly message: string;
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

export interface MessageReactionDto {
  readonly userPublicId: string;
  readonly emoji: string;
  readonly updatedAt: string;
}

export interface MessageReplyMetaDto {
  readonly messagePublicId: string;
  readonly senderPublicId: string;
  readonly seq: number;
  readonly messageType: MessageType;
  readonly recalledAt: string | null;
  readonly deletedForViewer: boolean;
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
  readonly callEventMeta?: MessageCallEventMetaRecord | null;
  readonly reactions?: readonly MessageReactionDto[];
  readonly replyToMeta?: MessageReplyMetaDto | null;
  readonly isForwarded?: boolean;
  readonly isPinned?: boolean;
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
  readonly clearedBeforeSeq?: number;
  readonly pinnedAt?: string | null;
  readonly mutedAt?: string | null;
  readonly isPinned?: boolean;
  readonly isMuted?: boolean;
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

export interface DeleteMessageForMeResult {
  readonly conversationPublicId: string;
  readonly messagePublicId: string;
  readonly nextLastMessage: ChatMessageDto | null;
  readonly unreadConversationsCount: number;
  readonly message: string;
}

export interface DeleteConversationForMeResult {
  readonly conversationPublicId: string;
  readonly clearedBeforeSeq: number;
  readonly unreadConversationsCount: number;
  readonly pendingCount: number;
  readonly message: string;
}

export interface CreateAttachmentUploadTokenResult {
  readonly attachmentPublicId: string;
  readonly mediaKind: AttachmentMediaKind;
  readonly uploadMode: 'vercel_blob' | 'direct';
  readonly pathname: string;
  readonly clientToken?: string;
  readonly uploadUrl?: string;
  readonly maxBytes: number;
  readonly expiresAt: string;
}

export interface MessageAttachmentDownloadGrantDto {
  readonly attachmentPublicId: string;
  readonly mediaKind: AttachmentMediaKind;
  readonly downloadUrl: string;
  readonly ciphertextSha256: string;
  readonly ciphertextSizeBytes: number;
}

export type GetMessageAttachmentResult =
  | {
      readonly kind: 'grant';
      readonly attachment: MessageAttachmentDownloadGrantDto;
    }
  | {
      readonly kind: 'binary';
      readonly body: Buffer;
      readonly contentType: string;
      readonly ciphertextSha256: string;
      readonly ciphertextSizeBytes: number;
    };

export interface MessageReactionMutationResult {
  readonly conversationPublicId: string;
  readonly messagePublicId: string;
  readonly emoji: string | null;
  readonly reactions: readonly MessageReactionDto[];
  readonly message: string;
}

export interface PinnedMessageItemDto {
  readonly message: ChatMessageDto;
  readonly pinnedAt: string;
  readonly pinnedByPublicId: string;
}

export interface PinnedMessagesListResult {
  readonly conversationPublicId: string;
  readonly items: readonly PinnedMessageItemDto[];
  readonly totalPinnedCount: number;
  readonly hiddenPinnedCount: number;
  readonly maxPinnedMessages: number;
}

export interface MessagePinMutationResult {
  readonly conversationPublicId: string;
  readonly messagePublicId: string;
  readonly isPinned: boolean;
  readonly totalPinnedCount: number;
  readonly unpinnedHiddenMessagePublicId?: string | null;
  readonly message: string;
}

export interface ConversationPreferencesResult {
  readonly conversationPublicId: string;
  readonly pinnedAt: string | null;
  readonly mutedAt: string | null;
  readonly isPinned: boolean;
  readonly isMuted: boolean;
  readonly unreadConversationsCount: number;
  readonly message: string;
}

export interface ForwardTargetDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly conversationPublicId: string | null;
  readonly lastMessageAt: string | null;
}

export interface ForwardTargetsListResult {
  readonly items: readonly ForwardTargetDto[];
}

function toDeviceDto(row: UserE2eeDeviceRow): E2eeDeviceKeyDto {
  return {
    devicePublicId: row.publicId,
    deviceLabel: row.deviceLabel,
    keyFingerprint: row.keyFingerprint,
    isSyncKey: Boolean(row.isSyncKey),
    identityPublicKeyJwk: row.identityPublicKeyJwk,
    signingPublicKeyJwk: row.signingPublicKeyJwk,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function toHistoricalSigningKeyDto(row: UserE2eeDeviceRow): E2eeHistoricalSigningKeyDto {
  return {
    keyFingerprint: row.keyFingerprint,
    identityPublicKeyJwk: row.identityPublicKeyJwk,
    signingPublicKeyJwk: row.signingPublicKeyJwk,
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
  extras?: {
    readonly reactions?: readonly MessageReactionDto[];
    readonly replyToMeta?: MessageReplyMetaDto | null;
    readonly isPinned?: boolean;
  },
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
    ...(row.messageType === 'call_event'
      ? { callEventMeta: row.recalledAt ? null : (row.callEventMeta ?? null) }
      : {}),
    ...(extras?.reactions !== undefined ? { reactions: extras.reactions } : {}),
    ...(extras?.replyToMeta !== undefined ? { replyToMeta: extras.replyToMeta } : {}),
    ...(row.isForwarded ? { isForwarded: true } : {}),
    ...(extras?.isPinned !== undefined ? { isPinned: extras.isPinned } : {}),
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
      clearedBeforeSeq: Number(record.actorParticipant.clearedBeforeSeq),
      pinnedAt: record.actorParticipant.pinnedAt
        ? record.actorParticipant.pinnedAt.toISOString()
        : null,
      mutedAt: record.actorParticipant.mutedAt
        ? record.actorParticipant.mutedAt.toISOString()
        : null,
      isPinned: Boolean(record.actorParticipant.pinnedAt),
      isMuted: Boolean(record.actorParticipant.mutedAt),
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
  readonly pinResetOtpStore?: PinResetOtpStore;
  readonly emailProvider?: EmailProvider;
  readonly auditLogService?: AuditLogService | null;
  readonly mediaStorageProvider?: MediaStorageProvider;
  readonly now?: () => Date;
  /** Móc nối dọn tệp đính kèm trên Storage khi thu hồi tin nhắn (ưu tiên nếu được truyền trong test). */
  readonly onAttachmentRecalled?: (storageKey: string) => Promise<void>;
}

const DEFAULT_CLIENT_CONTEXT: RequestClientContext = Object.freeze({
  ipAddress: null,
  rateLimitIpKey: 'unknown',
  userAgent: null,
});

export class ChatService {
  private readonly repository: ChatRepository;
  private readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  private readonly realtimeProvider: RealtimeProvider;
  private readonly notificationService: NotificationService | null;
  private readonly pinResetOtpStoreOverride?: PinResetOtpStore;
  private readonly emailProviderOverride?: EmailProvider;
  private readonly auditLogServiceOverride?: AuditLogService | null;
  private readonly mediaStorageProviderOverride?: MediaStorageProvider;
  private readonly hasCustomRepository: boolean;
  private readonly now: () => Date;
  private readonly hasCustomNow: boolean;
  private readonly onAttachmentRecalled: ((storageKey: string) => Promise<void>) | null;

  constructor(deps: ChatServiceDependencies = {}) {
    this.repository = deps.repository ?? new ChatRepository();
    this.hasCustomRepository = deps.repository !== undefined;
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.realtimeProvider = deps.realtimeProvider ?? getRealtimeProvider();
    this.notificationService =
      deps.notificationService !== undefined
        ? deps.notificationService
        : deps.repository === undefined
          ? getNotificationService()
          : null;
    this.pinResetOtpStoreOverride = deps.pinResetOtpStore;
    this.emailProviderOverride = deps.emailProvider;
    this.auditLogServiceOverride = deps.auditLogService;
    this.mediaStorageProviderOverride = deps.mediaStorageProvider;
    this.now = deps.now ?? (() => new Date());
    this.hasCustomNow = deps.now !== undefined;
    this.onAttachmentRecalled = deps.onAttachmentRecalled ?? null;
  }

  private resolveMediaStorageProvider(): MediaStorageProvider {
    return this.mediaStorageProviderOverride ?? getMediaStorageProvider();
  }

  private resolvePinResetOtpStore(): PinResetOtpStore {
    return this.pinResetOtpStoreOverride ?? getPinResetOtpStore();
  }

  private resolveEmailProvider(): EmailProvider {
    return this.emailProviderOverride ?? getEmailProvider();
  }

  private resolveAuditLogService(): AuditLogService | null {
    if (this.auditLogServiceOverride !== undefined) {
      return this.auditLogServiceOverride;
    }
    return this.hasCustomRepository ? null : getAuditLogService();
  }

  private async recordAuditInTx(
    params: {
      readonly userId: string;
      readonly action: AuditAction;
      readonly context?: RequestClientContext;
      readonly metadata?: Record<string, unknown>;
    },
    tx?: Parameters<Parameters<ChatRepository['runInRlsTx']>[1]>[0],
  ): Promise<void> {
    const audit = this.resolveAuditLogService();
    if (!audit) {
      return;
    }
    const ctx = params.context ?? DEFAULT_CLIENT_CONTEXT;
    await audit.record(
      {
        userId: params.userId,
        action: params.action,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: params.metadata,
      },
      tx,
    );
  }

  private async resolveAuthoritativeServerNow(
    tx: Parameters<Parameters<ChatRepository['runInRlsTx']>[1]>[0],
  ): Promise<Date> {
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

      const [ownBackup, historicalRevoked] = await Promise.all([
        targetUser!.id === actor.user.id
          ? this.repository.findKeyBackupByUserId(actor.user.id, tx)
          : Promise.resolve(null),
        typeof this.repository.listHistoricalRevokedDevicesForUser === 'function'
          ? this.repository.listHistoricalRevokedDevicesForUser(targetUser!.id, 50, tx)
          : Promise.resolve([]),
      ]);

      // Bảo đảm Khóa Đồng bộ (nếu có) luôn đứng vị trí đầu tiên và không bao giờ bị cắt mất ở giới hạn 10 thiết bị.
      const ownBackupFp = ownBackup?.keyFingerprint?.toLowerCase() ?? null;
      const prioritizedDevices = [...devices].sort((a, b) => {
        const aIsSync =
          Boolean(a.isSyncKey) ||
          (ownBackupFp !== null && a.keyFingerprint.toLowerCase() === ownBackupFp);
        const bIsSync =
          Boolean(b.isSyncKey) ||
          (ownBackupFp !== null && b.keyFingerprint.toLowerCase() === ownBackupFp);
        if (aIsSync !== bIsSync) {
          return aIsSync ? -1 : 1;
        }
        return 0;
      });

      const selectedActiveDevices = prioritizedDevices.slice(0, MAX_ACTIVE_E2EE_DEVICES_PER_USER);
      const selectedActiveFps = new Set(selectedActiveDevices.map((d) => d.keyFingerprint));
      const overflowActiveForVerify = prioritizedDevices
        .slice(MAX_ACTIVE_E2EE_DEVICES_PER_USER)
        .filter((d) => !selectedActiveFps.has(d.keyFingerprint));

      const historicalSigningKeys = [...overflowActiveForVerify, ...historicalRevoked]
        .filter((d) => !selectedActiveFps.has(d.keyFingerprint))
        .slice(0, 50)
        .map(toHistoricalSigningKeyDto);

      return {
        userPublicId: targetUser!.publicId,
        devices: selectedActiveDevices.map((row) => ({
          ...toDeviceDto(row),
          isSyncKey:
            Boolean(row.isSyncKey) ||
            (ownBackupFp !== null && row.keyFingerprint.toLowerCase() === ownBackupFp),
        })),
        historicalSigningKeys,
        hasKeyBackup: ownBackup !== null,
        backupKeyFingerprint: ownBackup?.keyFingerprint ?? null,
        backupVersion: ownBackup?.version ?? null,
      };
    });
  }

  async upsertKeyBackup(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
    context?: RequestClientContext,
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

    if (parsed.data.identityPublicKeyJwk && parsed.data.signingPublicKeyJwk) {
      const computedFingerprint = await computeDeviceKeyFingerprint(
        parsed.data.identityPublicKeyJwk,
        parsed.data.signingPublicKeyJwk,
      );
      if (computedFingerprint !== parsed.data.keyFingerprint) {
        throw new ChatDomainError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: CHAT_MESSAGES.validationFailed,
          details: [
            {
              field: 'keyFingerprint',
              message: 'Key fingerprint không khớp với cặp khóa công khai đồng bộ P-256.',
            },
          ],
        });
      }
    }

    const currentTime = this.now();
    const { saved, wasUpdate } = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const existing =
        typeof this.repository.findKeyBackupByUserId === 'function'
          ? await this.repository.findKeyBackupByUserId(actor.user.id, tx)
          : null;

      // Bất biến bảo mật: Đổi mã PIN chỉ được phép giữ nguyên `keyFingerprint` gốc.
      // Mọi thay đổi sang cặp khóa đồng bộ mới BẮT BUỘC phải xác thực email qua luồng Quên mã PIN.
      if (
        existing &&
        existing.keyFingerprint.toLowerCase() !== parsed.data.keyFingerprint.toLowerCase()
      ) {
        throw new ChatDomainError({
          status: 409,
          code: 'CONFLICT',
          message: CHAT_MESSAGES.backupKeyChangeRequiresReset,
        });
      }

      const nextVersion = existing ? existing.version + 1 : 1;
      const savedRow = await this.repository.upsertKeyBackup(
        {
          userId: actor.user.id,
          encryptedKeyBlob: parsed.data.encryptedKeyBlob,
          kdfSalt: parsed.data.kdfSalt,
          kdfParams: parsed.data.kdfParams,
          iv: parsed.data.iv,
          keyFingerprint: parsed.data.keyFingerprint,
          version: nextVersion,
          now: currentTime,
        },
        tx,
      );

      if (parsed.data.identityPublicKeyJwk && parsed.data.signingPublicKeyJwk) {
        await this.repository.upsertUserE2eeDevice(
          {
            userId: actor.user.id,
            sessionFamilyId: null,
            deviceLabel: parsed.data.deviceLabel ?? 'Khóa đồng bộ tin nhắn',
            identityPublicKeyJwk: parsed.data.identityPublicKeyJwk,
            signingPublicKeyJwk: parsed.data.signingPublicKeyJwk,
            keyFingerprint: parsed.data.keyFingerprint,
            isSyncKey: true,
            maxActiveDevices: MAX_ACTIVE_E2EE_DEVICES_PER_USER,
            now: currentTime,
          },
          tx,
        );
      } else if (typeof this.repository.markDeviceAsSyncKeyByFingerprint === 'function') {
        await this.repository.markDeviceAsSyncKeyByFingerprint(
          {
            userId: actor.user.id,
            keyFingerprint: parsed.data.keyFingerprint,
            now: currentTime,
          },
          tx,
        );
      }

      await this.recordAuditInTx(
        {
          userId: actor.user.id,
          action: existing ? 'E2EE_PIN_CHANGED' : 'E2EE_PIN_BACKUP_CREATED',
          context,
          metadata: {
            backupVersion: nextVersion,
            keyFingerprintPrefix: parsed.data.keyFingerprint.slice(0, 12),
          },
        },
        tx,
      );

      return { saved: savedRow, wasUpdate: existing !== null };
    });

    return {
      backup: toBackupDto(saved),
      message: wasUpdate ? CHAT_MESSAGES.backupPinChanged : CHAT_MESSAGES.backupSaved,
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

  /**
   * Bước 1 Quên mã PIN tin nhắn:
   * - Chỉ cho phép khi tài khoản đã thiết lập mã PIN (`existing !== null`).
   * - Tự truy vấn email đã xác minh của chính `actor.user.id` từ DB (tuyệt đối không nhận từ body).
   * - Sinh OTP 6 chữ số, chỉ lưu bản băm HMAC-SHA256 vào Redis (TTL 10 phút), gửi email và trả email đã che.
   */
  async requestPinResetOtp(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
    context: RequestClientContext = DEFAULT_CLIENT_CONTEXT,
  ): Promise<RequestPinResetOtpResult> {
    assertChatAuthorized(actor, 'e2ee:backup:reset');

    await this.consumeRateLimitOrThrow(
      `chat:e2ee:pin-reset:request:ip:${context.rateLimitIpKey}`,
      CHAT_RATE_LIMITS.pinResetRequestByIp,
    );
    await this.consumeRateLimitOrThrow(
      `chat:e2ee:pin-reset:request:user-hourly:${actor.user.id}`,
      CHAT_RATE_LIMITS.pinResetRequestByUserHourly,
    );

    const parsed = emptyStrictObjectSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const { verifiedEmail } = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const existing = await this.repository.findKeyBackupByUserId(actor.user.id, tx);
      if (!existing) {
        throw new ChatDomainError({
          status: 409,
          code: 'CONFLICT',
          message: CHAT_MESSAGES.backupNotFoundForReset,
        });
      }

      const email = await this.repository.findVerifiedEmailForUser(actor.user.id, tx);
      if (!email) {
        throw new ChatDomainError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: CHAT_MESSAGES.pinResetEmailUnavailable,
        });
      }

      return { verifiedEmail: email };
    });

    // Áp dụng cooldown 60s giữa các lần gửi lại SAU khi xác nhận tài khoản đủ điều kiện đặt lại.
    await this.consumeRateLimitOrThrow(
      `chat:e2ee:pin-reset:request:cooldown:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.pinResetRequestCooldown,
    );

    const otpCode = generateOtpCode();
    const otpHashHex = hashScopedOtpCode(otpCode, {
      userId: actor.user.id,
      scope: 'e2ee_pin_reset',
    });
    const otpStore = this.resolvePinResetOtpStore();
    await otpStore.issueOtp(actor.user.id, otpHashHex, PIN_RESET_OTP_TTL_SECONDS);

    const maskedEmail = maskEmailAddress(verifiedEmail);
    const renderedEmail = buildE2eePinResetOtpEmail({
      displayName: actor.user.fullName,
      otpCode,
      expiresInMinutes: PIN_RESET_OTP_TTL_MINUTES,
    });

    try {
      await this.resolveEmailProvider().send({
        to: verifiedEmail,
        subject: renderedEmail.subject,
        html: renderedEmail.html,
        text: renderedEmail.text,
      });
    } catch (error) {
      await otpStore.clearOtp(actor.user.id).catch(() => undefined);
      logger.error(
        {
          component: 'chat-service',
          stage: 'pin_reset_email_send',
          errorName: error instanceof Error ? error.name : 'Error',
        },
        'Không thể gửi email mã xác nhận đặt lại mã PIN',
      );
      throw new ChatDomainError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Không thể gửi mã xác nhận qua email lúc này. Vui lòng thử lại sau.',
      });
    }

    await this.recordAuditInTx({
      userId: actor.user.id,
      action: 'E2EE_PIN_RESET_REQUESTED',
      context,
      metadata: {
        maskedEmail,
      },
    }).catch(() => undefined);

    return {
      maskedEmail,
      resendAfterSeconds: PIN_RESET_OTP_COOLDOWN_SECONDS,
      expiresInMinutes: PIN_RESET_OTP_TTL_MINUTES,
      message: CHAT_MESSAGES.pinResetOtpSent,
    };
  }

  /**
   * Bước 2 Quên mã PIN tin nhắn:
   * - Xác minh OTP 6 chữ số qua `timingSafeEqual` (sai 5 lần tự hủy OTP trong Redis).
   * - Xóa OTP nguyên tử bằng CAS + DEL (chống dùng lại OTP lần 2 / race condition).
   * - Trong 1 DB transaction nguyên tử: cập nhật `user_e2ee_key_backups` với khóa đồng bộ mới (tăng `version`),
   *   thu hồi cờ sync cũ & đăng ký khóa công khai đồng bộ mới vào `user_e2ee_devices`, ghi `audit_logs`.
   */
  async confirmPinReset(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
    context: RequestClientContext = DEFAULT_CLIENT_CONTEXT,
  ): Promise<ConfirmPinResetResult> {
    assertChatAuthorized(actor, 'e2ee:backup:reset');

    await this.consumeRateLimitOrThrow(
      `chat:e2ee:pin-reset:confirm:ip:${context.rateLimitIpKey}`,
      CHAT_RATE_LIMITS.pinResetConfirmByIp,
    );
    await this.consumeRateLimitOrThrow(
      `chat:e2ee:pin-reset:confirm:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.pinResetConfirmByUser,
    );

    const parsed = confirmPinResetInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    // Server tự tính lại SHA-256 fingerprint từ cặp khóa công khai P-256 mới để chống giả mạo.
    const computedFingerprint = await computeDeviceKeyFingerprint(
      parsed.data.identityPublicKeyJwk,
      parsed.data.signingPublicKeyJwk,
    );
    if (computedFingerprint !== parsed.data.keyFingerprint) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: [
          {
            field: 'keyFingerprint',
            message: 'Key fingerprint không khớp với cặp khóa công khai đồng bộ P-256.',
          },
        ],
      });
    }

    const existingBeforeOtp = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      return this.repository.findKeyBackupByUserId(actor.user.id, tx);
    });
    if (!existingBeforeOtp) {
      throw new ChatDomainError({
        status: 409,
        code: 'CONFLICT',
        message: CHAT_MESSAGES.backupNotFoundForReset,
      });
    }

    const otpStore = this.resolvePinResetOtpStore();
    const otpRecord = await otpStore.getOtpRecord(actor.user.id);
    if (!otpRecord) {
      throw new ChatDomainError({
        status: 400,
        code: 'TOKEN_INVALID',
        message: CHAT_MESSAGES.pinResetOtpInvalidOrExpired,
        details: [{ field: 'otpCode', message: CHAT_MESSAGES.pinResetOtpInvalidOrExpired }],
      });
    }

    if (otpRecord.attempts >= PIN_RESET_OTP_MAX_ATTEMPTS) {
      await otpStore.clearOtp(actor.user.id);
      throw new ChatDomainError({
        status: 400,
        code: 'TOKEN_INVALID',
        message: CHAT_MESSAGES.pinResetOtpRevokedMaxAttempts,
        details: [{ field: 'otpCode', message: CHAT_MESSAGES.pinResetOtpRevokedMaxAttempts }],
      });
    }

    const isOtpValid = verifyScopedOtpCode(parsed.data.otpCode, otpRecord.otpHashHex, {
      userId: actor.user.id,
      scope: 'e2ee_pin_reset',
    });

    if (!isOtpValid) {
      const attemptOutcome = await otpStore.recordFailedAttempt(
        actor.user.id,
        otpRecord.otpHashHex,
        PIN_RESET_OTP_MAX_ATTEMPTS,
      );
      const errorMessage = attemptOutcome.exhausted
        ? CHAT_MESSAGES.pinResetOtpRevokedMaxAttempts
        : CHAT_MESSAGES.pinResetOtpIncorrectWithRemaining(attemptOutcome.remainingAttempts);
      throw new ChatDomainError({
        status: 400,
        code: 'TOKEN_INVALID',
        message: errorMessage,
        details: [{ field: 'otpCode', message: errorMessage }],
      });
    }

    // Xóa OTP nguyên tử bằng CAS + DEL trước khi ghi DB để chống dùng lại OTP song song (replay race).
    const consumed = await otpStore.consumeOtpIfMatches(actor.user.id, otpRecord.otpHashHex);
    if (!consumed) {
      throw new ChatDomainError({
        status: 400,
        code: 'TOKEN_INVALID',
        message: CHAT_MESSAGES.pinResetOtpInvalidOrExpired,
        details: [{ field: 'otpCode', message: CHAT_MESSAGES.pinResetOtpInvalidOrExpired }],
      });
    }

    const currentTime = this.now();
    const { savedBackup, savedDevice } = await this.repository.runInRlsTx(
      actor.user.id,
      async (tx) => {
        const existingInTx = await this.repository.findKeyBackupByUserId(actor.user.id, tx);
        if (!existingInTx) {
          throw new ChatDomainError({
            status: 409,
            code: 'CONFLICT',
            message: CHAT_MESSAGES.backupNotFoundForReset,
          });
        }

        const nextVersion = existingInTx.version + 1;
        const backupRow = await this.repository.upsertKeyBackup(
          {
            userId: actor.user.id,
            encryptedKeyBlob: parsed.data.encryptedKeyBlob,
            kdfSalt: parsed.data.kdfSalt,
            kdfParams: parsed.data.kdfParams,
            iv: parsed.data.iv,
            keyFingerprint: computedFingerprint,
            version: nextVersion,
            now: currentTime,
          },
          tx,
        );

        const deviceOutcome = await this.repository.upsertUserE2eeDevice(
          {
            userId: actor.user.id,
            sessionFamilyId: null,
            deviceLabel: parsed.data.deviceLabel ?? 'Khóa đồng bộ tin nhắn',
            identityPublicKeyJwk: parsed.data.identityPublicKeyJwk,
            signingPublicKeyJwk: parsed.data.signingPublicKeyJwk,
            keyFingerprint: computedFingerprint,
            isSyncKey: true,
            maxActiveDevices: MAX_ACTIVE_E2EE_DEVICES_PER_USER,
            now: currentTime,
          },
          tx,
        );

        await this.recordAuditInTx(
          {
            userId: actor.user.id,
            action: 'E2EE_PIN_RESET_COMPLETED',
            context,
            metadata: {
              backupVersion: nextVersion,
              previousKeyFingerprintPrefix: existingInTx.keyFingerprint.slice(0, 12),
              newKeyFingerprintPrefix: computedFingerprint.slice(0, 12),
            },
          },
          tx,
        );

        return {
          savedBackup: backupRow,
          savedDevice: deviceOutcome.device,
        };
      },
    );

    return {
      backup: toBackupDto(savedBackup),
      device: toDeviceDto(savedDevice),
      message: CHAT_MESSAGES.pinResetCompleted,
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
                  r.actorParticipant.hiddenAt === null &&
                  !r.actorParticipant.mutedAt &&
                  Number(r.conversation.lastSeq) >
                    Math.max(
                      Number(r.actorParticipant.lastReadSeq),
                      Number(r.actorParticipant.clearedBeforeSeq),
                    ) &&
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

      // Cưỡng chế cứng điều kiện Chuyển tiếp (M13): chỉ cho phép Mutual Follow ∪ Đã từng trò chuyện (primary 2 phía & last_seq > 0).
      if (parsed.data.purpose === 'forward') {
        const isMutualFollow =
          relationship.actorFollowStatus === 'following' &&
          relationship.targetFollowStatus === 'following';
        const hasPriorPrimary =
          typeof this.repository.hasPriorPrimaryConversationBetweenUsers === 'function'
            ? await this.repository.hasPriorPrimaryConversationBetweenUsers(
                lockedActor.id,
                lockedTarget.id,
                tx,
              )
            : false;
        if (!isMutualFollow && !hasPriorPrimary) {
          throw new ChatDomainError({
            status: 403,
            code: 'CHAT_FORWARD_TARGET_NOT_ELIGIBLE',
            message: CHAT_MESSAGES.forwardTargetNotEligible,
          });
        }
      }

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

      // Chỉ nạp `lastMessage` khi có tin nhắn mới hơn mốc `cleared_before_seq` của `actor`.
      // Khi mở lại hội thoại từng bị xóa (`last_seq === cleared_before_seq`), trả về `lastMessage: null` sạch sẽ, không lộ preview tin cũ.
      const visibleLastMessage =
        Number(conversation.lastSeq) > Number(actorParticipant.clearedBeforeSeq) &&
        typeof this.repository.findLatestVisibleMessageForConversation === 'function'
          ? await this.repository.findLatestVisibleMessageForConversation(
              {
                conversationId: conversation.id,
                viewerUserId: lockedActor.id,
                clearedBeforeSeq: Number(actorParticipant.clearedBeforeSeq),
              },
              tx,
            )
          : null;

      const summary = toConversationSummaryDto(
        {
          conversation,
          actorParticipant,
          peerParticipant,
          peerUser: lockedTarget,
          lastMessage: visibleLastMessage,
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

      const visibleLastMessage =
        Number(conversation.lastSeq) > Number(actorParticipant!.clearedBeforeSeq) &&
        typeof this.repository.findLatestVisibleMessageForConversation === 'function'
          ? await this.repository.findLatestVisibleMessageForConversation(
              {
                conversationId: conversation.id,
                viewerUserId: actor.user.id,
                clearedBeforeSeq: Number(actorParticipant!.clearedBeforeSeq),
              },
              tx,
            )
          : null;

      return toConversationSummaryDto(
        {
          conversation,
          actorParticipant: actorParticipant!,
          peerParticipant: peerParticipant!,
          peerUser: peerUser!,
          lastMessage: visibleLastMessage,
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

    const rows = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
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
      const isForwardDelta =
        parsedQuery.data.afterSeq !== undefined && effectiveBeforeSeq === undefined;

      const msgRows = await this.repository.listMessagesForConversation(
        {
          conversationId: conversation.id,
          viewerUserId: actor.user.id,
          clearedBeforeSeq: Number(actorParticipant!.clearedBeforeSeq),
          limit: parsedQuery.data.limit,
          cursorSeq: effectiveBeforeSeq,
          afterSeq: parsedQuery.data.afterSeq,
        },
        tx,
      );

      const hasMore = msgRows.length > parsedQuery.data.limit;
      const pageRows = hasMore ? msgRows.slice(0, parsedQuery.data.limit) : msgRows;
      const orderedRows = isForwardDelta ? pageRows : [...pageRows].reverse();
      const oldestInBatch = orderedRows[0];

      const enrichedItems = await this.enrichMessagesForViewer(
        {
          conversationId: conversation.id,
          conversationPublicId,
          viewerUserId: actor.user.id,
          viewerPublicId: actor.user.publicId,
          clearedBeforeSeq: Number(actorParticipant!.clearedBeforeSeq),
          items: orderedRows,
        },
        tx,
      );

      return {
        items: enrichedItems,
        nextCursor:
          !isForwardDelta && hasMore && oldestInBatch ? Number(oldestInBatch.row.seq) : null,
      };
    });

    return {
      conversationPublicId,
      items: rows.items,
      nextCursor: rows.nextCursor,
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

    // Nếu là tin nhắn Ảnh HD hoặc Voice: xác minh sơ bộ attachment & kiểm tra tồn tại trên Storage
    // NGOÀI transaction DB để không bao giờ giữ row lock PostgreSQL xuyên qua HTTP I/O.
    let preVerifiedAttachment: {
      readonly id: string;
      readonly storageKey: string;
      readonly storageUrl: string;
    } | null = null;

    if (
      (parsed.data.messageType === 'image' || parsed.data.messageType === 'voice') &&
      parsed.data.attachmentPublicId
    ) {
      const preCheck = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
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

        const participants = await this.repository.listConversationParticipants(
          conversation.id,
          tx,
        );
        const actorParticipant = participants.find((p) => p.userId === actor.user.id) ?? null;
        const peerParticipant = participants.find((p) => p.userId !== actor.user.id) ?? null;
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

        // Kiểm tra idempotency trước để tránh từ chối lặp khi retry mạng.
        const existingMsg = await this.repository.findMessageByClientMsgId(
          conversation.id,
          actor.user.id,
          parsed.data.clientMsgId,
          tx,
        );
        if (existingMsg) {
          return { skipVerifyDueToIdempotency: true as const };
        }

        const effectivePeerInbox =
          peerParticipant!.inboxState === 'pending' &&
          relationship!.targetFollowStatus === 'following'
            ? 'primary'
            : peerParticipant!.inboxState;
        if (actorParticipant!.inboxState !== 'primary' || effectivePeerInbox !== 'primary') {
          throw new ChatDomainError({
            status: 403,
            code: 'CHAT_PENDING_TEXT_ONLY',
            message: CHAT_MESSAGES.pendingTextOnly,
          });
        }

        const attachment = await this.repository.findAttachmentByPublicId(
          parsed.data.attachmentPublicId!,
          tx,
        );
        if (
          !attachment ||
          attachment.conversationId !== conversation.id ||
          attachment.uploaderId !== actor.user.id ||
          attachment.deletedAt !== null
        ) {
          throw new ChatDomainError({
            status: 404,
            code: 'NOT_FOUND',
            message: CHAT_MESSAGES.notFound,
          });
        }

        if (attachment.messageId !== null) {
          throw new ChatDomainError({
            status: 409,
            code: 'CONFLICT',
            message: CHAT_MESSAGES.attachmentAlreadyBound,
          });
        }

        if (attachment.mediaKind !== parsed.data.messageType) {
          throw new ChatDomainError({
            status: 400,
            code: 'VALIDATION_ERROR',
            message: CHAT_MESSAGES.attachmentTypeMismatch,
          });
        }

        return {
          skipVerifyDueToIdempotency: false as const,
          attachment,
        };
      });

      if (!preCheck.skipVerifyDueToIdempotency) {
        const storage = this.resolveMediaStorageProvider();
        if (typeof storage.verifyUploadedObject !== 'function') {
          throw new ChatDomainError({
            status: 500,
            code: 'INTERNAL_ERROR',
            message: CHAT_MESSAGES.attachmentUploadNotReady,
          });
        }
        const verified = await storage.verifyUploadedObject(preCheck.attachment.storageKey, {
          expectedSizeBytes: preCheck.attachment.ciphertextSizeBytes,
        });
        if (!verified || !verified.exists) {
          throw new ChatDomainError({
            status: 400,
            code: 'VALIDATION_ERROR',
            message: CHAT_MESSAGES.attachmentUploadNotReady,
          });
        }

        preVerifiedAttachment = {
          id: preCheck.attachment.id,
          storageKey: preCheck.attachment.storageKey,
          storageUrl: verified.url,
        };
      }
    }

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

      // 4a. Cưỡng chế điều kiện Chuyển tiếp (M13): cấm chuyển tiếp cho người lạ / pending / declined / 1-way follow chưa từng nhắn.
      if (parsed.data.isForwarded === true) {
        const isMutualFollow =
          relationship!.actorFollowStatus === 'following' &&
          relationship!.targetFollowStatus === 'following';
        const isPrimaryBothSides =
          actorParticipant!.inboxState === 'primary' && peerParticipant!.inboxState === 'primary';
        const hasChattedBefore = isPrimaryBothSides && Number(conversation.lastSeq) > 0;

        if (!isPrimaryBothSides || (!isMutualFollow && !hasChattedBefore)) {
          throw new ChatDomainError({
            status: 403,
            code: 'CHAT_FORWARD_TARGET_NOT_ELIGIBLE',
            message: CHAT_MESSAGES.forwardTargetNotEligible,
          });
        }
      }

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

      // 4a-bis. Xác minh tin nhắn gốc khi Trả lời (M13): BẮT BUỘC thuộc đúng `conversation.id` hiện tại (chống cross-conv IDOR).
      let verifiedReplyTarget: {
        readonly id: string;
        readonly meta: MessageReplyMetaDto;
      } | null = null;

      if (parsed.data.replyToMessagePublicId) {
        const replyFound = await this.repository.findMessageByPublicId(
          parsed.data.replyToMessagePublicId,
          tx,
        );
        if (
          !replyFound ||
          replyFound.row.conversationId !== conversation.id ||
          Number(replyFound.row.seq) <= Number(actorParticipant!.clearedBeforeSeq)
        ) {
          throw new ChatDomainError({
            status: 404,
            code: 'NOT_FOUND',
            message: CHAT_MESSAGES.notFound,
          });
        }

        const isReplyDeletedForActor = await this.repository.isMessageDeletedForUser(
          replyFound.row.id,
          actor.user.id,
          tx,
        );
        if (isReplyDeletedForActor) {
          throw new ChatDomainError({
            status: 404,
            code: 'NOT_FOUND',
            message: CHAT_MESSAGES.notFound,
          });
        }

        if (replyFound.row.recalledAt !== null) {
          throw new ChatDomainError({
            status: 409,
            code: 'CHAT_MESSAGE_ALREADY_RECALLED',
            message: CHAT_MESSAGES.alreadyRecalled,
          });
        }

        if (replyFound.row.messageType === 'call_event') {
          throw new ChatDomainError({
            status: 409,
            code: 'CHAT_MESSAGE_ACTION_UNSUPPORTED_TYPE',
            message: CHAT_MESSAGES.replyUnsupportedType,
          });
        }

        verifiedReplyTarget = {
          id: replyFound.row.id,
          meta: {
            messagePublicId: replyFound.row.publicId,
            senderPublicId: replyFound.senderPublicId,
            seq: Number(replyFound.row.seq),
            messageType: replyFound.row.messageType,
            recalledAt: null,
            deletedForViewer: false,
          },
        };
      }

      // 4b. Đối với tin nhắn ảnh/thoại ở hội thoại `primary`, bắt buộc phải có `attachmentPublicId` đã xác minh.
      if (
        (parsed.data.messageType === 'image' || parsed.data.messageType === 'voice') &&
        !parsed.data.attachmentPublicId
      ) {
        throw new ChatDomainError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: CHAT_MESSAGES.validationFailed,
          details: [
            {
              field: 'attachmentPublicId',
              message: 'Thiếu mã định danh tệp đính kèm cho tin nhắn phương tiện.',
            },
          ],
        });
      }

      let lockedPendingAttachment: MessageAttachmentRow | null = null;
      if (preVerifiedAttachment && parsed.data.attachmentPublicId) {
        const lockedAttachment = await this.repository.lockAttachmentByPublicId(
          parsed.data.attachmentPublicId,
          tx,
        );
        if (
          !lockedAttachment ||
          lockedAttachment.id !== preVerifiedAttachment.id ||
          lockedAttachment.conversationId !== conversation.id ||
          lockedAttachment.uploaderId !== actor.user.id ||
          lockedAttachment.deletedAt !== null
        ) {
          throw new ChatDomainError({
            status: 404,
            code: 'NOT_FOUND',
            message: CHAT_MESSAGES.notFound,
          });
        }
        if (lockedAttachment.messageId !== null) {
          throw new ChatDomainError({
            status: 409,
            code: 'CONFLICT',
            message: CHAT_MESSAGES.attachmentAlreadyBound,
          });
        }
        if (lockedAttachment.mediaKind !== parsed.data.messageType) {
          throw new ChatDomainError({
            status: 400,
            code: 'VALIDATION_ERROR',
            message: CHAT_MESSAGES.attachmentTypeMismatch,
          });
        }
        lockedPendingAttachment = lockedAttachment;
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
          attachmentStorageKey: lockedPendingAttachment?.storageKey ?? null,
          replyToMessageId: verifiedReplyTarget?.id ?? null,
          isForwarded: parsed.data.isForwarded === true,
          now: currentTime,
        },
        tx,
      );

      if (lockedPendingAttachment && preVerifiedAttachment) {
        const bound = await this.repository.bindAttachmentToMessageAtomically(
          {
            attachmentId: lockedPendingAttachment.id,
            conversationId: conversation.id,
            uploaderId: actor.user.id,
            messageId: insertedMsg.id,
            storageUrl: preVerifiedAttachment.storageUrl,
          },
          tx,
        );
        if (!bound) {
          throw new ChatDomainError({
            status: 409,
            code: 'CONFLICT',
            message: CHAT_MESSAGES.attachmentAlreadyBound,
          });
        }
      }

      // Người gửi tin nhắn mới hiển nhiên đã đọc hội thoại tới `nextSeq`,
      // đồng thời luôn gỡ `hidden_at = NULL` nếu chính `actor` từng xóa/ẩn đoạn chat trước đó.
      if (Number(actorParticipant!.lastReadSeq) < nextSeq || actorParticipant!.hiddenAt !== null) {
        const nextActorReadSeq = Math.max(Number(actorParticipant!.lastReadSeq), nextSeq);
        actorParticipant = (await this.repository.updateParticipantState(
          conversation.id,
          actor.user.id,
          {
            lastReadSeq: nextActorReadSeq,
            hiddenAt: null,
          },
          tx,
        )) ?? {
          ...actorParticipant!,
          lastReadSeq: nextActorReadSeq,
          hiddenAt: null,
        };
      }

      // Nếu đối phương đang ở trạng thái `primary` nhưng từng xóa đoạn chat (`hidden_at IS NOT NULL`),
      // tự động gỡ ẩn (`hidden_at = NULL`) để hội thoại hiện lại sạch sẽ và chỉ hiện tin `seq > cleared_before_seq`.
      // Lưu ý: nếu đối phương đang ở `declined`, giữ nguyên luật im lặng tuyệt đối từ M9 (không gỡ ẩn, không thông báo).
      if (peerParticipant!.inboxState === 'primary' && peerParticipant!.hiddenAt !== null) {
        peerParticipant = (await this.repository.updateParticipantState(
          conversation.id,
          peerUser!.id,
          {
            hiddenAt: null,
          },
          tx,
        )) ?? {
          ...peerParticipant!,
          hiddenAt: null,
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
        {
          reactions: [],
          replyToMeta: verifiedReplyTarget?.meta ?? null,
          isPinned: false,
        },
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
        peerInboxState: (peerParticipant!.inboxState === 'pending' ? 'pending' : 'primary') as
          'primary' | 'pending',
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    if (!txOutcome.deduplicated) {
      // Sự kiện Realtime `chat.message.created` CHỈ gửi metadata tối giản,
      // TUYỆT ĐỐI KHÔNG đẩy `ciphertext` hay `cryptoHeader` qua bên thứ ba (Ably).
      const baseEventPayload = {
        conversationPublicId: txOutcome.conversation.public_id,
        messagePublicId: txOutcome.message.public_id,
        seq: txOutcome.message.seq,
        senderPublicId: actor.user.publicId,
        createdAt: txOutcome.message.createdAt,
      };

      const publishTasks: Promise<void>[] = [
        this.publishChatEventBestEffort(actor.user.publicId, 'chat.message.created', {
          ...baseEventPayload,
          recipientInboxState: 'primary',
        }),
      ];

      if (txOutcome.shouldNotifyPeerRealtime) {
        publishTasks.push(
          this.publishChatEventBestEffort(txOutcome.peerPublicId, 'chat.message.created', {
            ...baseEventPayload,
            recipientInboxState: txOutcome.peerInboxState,
          }),
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

  // =========================================================================
  // 5. Cột mốc M10 — Đọc đơn lẻ, Sửa/Thu hồi trong 5 phút, Xóa 1 phía & Xóa hội thoại
  // =========================================================================

  async getMessageByPublicId(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
  ): Promise<{ readonly message: ChatMessageDto }> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:read:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.getMessageByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);

    const dto = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const found = await this.repository.findMessageByPublicId(messagePublicId, tx);
      if (!found) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation = await this.repository.findConversationById(found.row.conversationId, tx);
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

      assertChatAuthorized(actor, 'chat:message:read', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (Number(found.row.seq) <= Number(actorParticipant!.clearedBeforeSeq)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const isDeletedForActor = await this.repository.isMessageDeletedForUser(
        found.row.id,
        actor.user.id,
        tx,
      );
      if (isDeletedForActor) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const [enriched] = await this.enrichMessagesForViewer(
        {
          conversationId: conversation.id,
          conversationPublicId: conversation.publicId,
          viewerUserId: actor.user.id,
          viewerPublicId: actor.user.publicId,
          clearedBeforeSeq: Number(actorParticipant!.clearedBeforeSeq),
          items: [found],
        },
        tx,
      );
      return enriched!;
    });

    return { message: dto };
  }

  async editMessage(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
    rawInput: unknown,
  ): Promise<{ readonly message: ChatMessageDto }> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:edit:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.editMessageByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);
    const parsed = editMessageInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const editWindowSeconds = Math.floor(MESSAGE_EDIT_WINDOW_MS / 1000);

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const lockedMessage = await this.repository.lockMessageByPublicId(messagePublicId, tx);
      if (!lockedMessage) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation = await this.repository.findConversationById(
        lockedMessage.conversationId,
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

      // Lớp 1 BOLA: Không phải thành viên hoặc bị chặn 2 chiều -> 404 đồng nhất.
      assertChatAuthorized(actor, 'chat:message:edit', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      // Thành viên hội thoại nhưng không phải chủ sở hữu tin nhắn -> 403 FORBIDDEN.
      if (lockedMessage.senderId !== actor.user.id) {
        throw new ChatDomainError({
          status: 403,
          code: 'FORBIDDEN',
          message: CHAT_MESSAGES.editForbiddenNotOwner,
        });
      }

      // Không cho sửa tin nhắn đã bị xóa ở phía chính mình hoặc đã bị xóa theo đoạn hội thoại.
      if (Number(lockedMessage.seq) <= Number(actorParticipant!.clearedBeforeSeq)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }
      const isDeletedForActor = await this.repository.isMessageDeletedForUser(
        lockedMessage.id,
        actor.user.id,
        tx,
      );
      if (isDeletedForActor) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      if (lockedMessage.recalledAt !== null) {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_ALREADY_RECALLED',
          message: CHAT_MESSAGES.alreadyRecalled,
        });
      }

      if (lockedMessage.messageType !== 'text') {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_EDIT_UNSUPPORTED_TYPE',
          message: CHAT_MESSAGES.editUnsupportedType,
        });
      }

      // Cưỡng chế thời hạn 5 phút (300 giây) theo đồng hồ PostgreSQL/Server.
      const serverNow = await this.resolveAuthoritativeServerNow(tx);
      const elapsedMs = serverNow.getTime() - lockedMessage.createdAt.getTime();
      if (elapsedMs > MESSAGE_EDIT_WINDOW_MS) {
        throw new ChatDomainError({
          status: 403,
          code: 'CHAT_MESSAGE_EDIT_WINDOW_EXPIRED',
          message: CHAT_MESSAGES.editWindowExpired,
        });
      }

      if (lockedMessage.editCount >= MAX_MESSAGE_EDIT_COUNT) {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_EDIT_LIMIT_REACHED',
          message: CHAT_MESSAGES.editLimitReached,
        });
      }

      // Phòng thủ chống tái sử dụng IV AES-GCM ngay tại tầng Server.
      if (
        lockedMessage.cryptoHeader &&
        lockedMessage.cryptoHeader.iv === parsed.data.cryptoHeader.iv
      ) {
        throw new ChatDomainError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: CHAT_MESSAGES.editIvReused,
          details: [
            {
              field: 'cryptoHeader.iv',
              message: CHAT_MESSAGES.editIvReused,
            },
          ],
        });
      }

      const updatedRow = await this.repository.updateEditedMessageAtomically(
        {
          messageId: lockedMessage.id,
          senderId: actor.user.id,
          ciphertext: parsed.data.ciphertext,
          cryptoHeader: parsed.data.cryptoHeader,
          maxEditCount: MAX_MESSAGE_EDIT_COUNT,
          editWindowSeconds,
        },
        tx,
      );

      if (!updatedRow) {
        throw new ChatDomainError({
          status: 403,
          code: 'CHAT_MESSAGE_EDIT_WINDOW_EXPIRED',
          message: CHAT_MESSAGES.editWindowExpired,
        });
      }

      const dto = toMessageDto(
        updatedRow,
        conversation.publicId,
        actor.user.publicId,
        actor.user.publicId,
      );

      return {
        message: dto,
        peerPublicId: peerUser!.publicId,
        shouldNotifyPeerRealtime: peerParticipant!.inboxState !== 'declined',
      };
    });

    // Chỉ đẩy metadata siêu nhẹ (0% ciphertext / cryptoHeader) và luôn `await` trước khi trả HTTP response.
    const eventPayload = {
      conversationPublicId: outcome.message.conversationPublicId,
      messagePublicId: outcome.message.public_id,
      seq: outcome.message.seq,
      editCount: outcome.message.editCount,
      editedAt: outcome.message.editedAt,
    };

    const publishTasks: Promise<void>[] = [
      this.publishChatEventBestEffort(actor.user.publicId, 'chat.message.updated', eventPayload),
    ];
    if (outcome.shouldNotifyPeerRealtime) {
      publishTasks.push(
        this.publishChatEventBestEffort(outcome.peerPublicId, 'chat.message.updated', eventPayload),
      );
    }
    await Promise.all(publishTasks);

    return { message: outcome.message };
  }

  async recallMessage(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
    rawInput: unknown = {},
  ): Promise<{ readonly message: ChatMessageDto }> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:recall:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.recallMessageByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);
    const parsedBody = emptyStrictObjectSchema.safeParse(rawInput ?? {});
    if (!parsedBody.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsedBody.error),
      });
    }

    const recallWindowSeconds = Math.floor(MESSAGE_RECALL_WINDOW_MS / 1000);

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const lockedMessage = await this.repository.lockMessageByPublicId(messagePublicId, tx);
      if (!lockedMessage) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation = await this.repository.findConversationById(
        lockedMessage.conversationId,
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

      assertChatAuthorized(actor, 'chat:message:recall', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (lockedMessage.senderId !== actor.user.id) {
        throw new ChatDomainError({
          status: 403,
          code: 'FORBIDDEN',
          message: CHAT_MESSAGES.recallForbiddenNotOwner,
        });
      }

      if (Number(lockedMessage.seq) <= Number(actorParticipant!.clearedBeforeSeq)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }
      const isDeletedForActor = await this.repository.isMessageDeletedForUser(
        lockedMessage.id,
        actor.user.id,
        tx,
      );
      if (isDeletedForActor) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      if (lockedMessage.recalledAt !== null) {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_ALREADY_RECALLED',
          message: CHAT_MESSAGES.alreadyRecalled,
        });
      }

      if (lockedMessage.messageType === 'call_event') {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_RECALL_UNSUPPORTED_TYPE',
          message: CHAT_MESSAGES.recallUnsupportedType,
        });
      }

      const serverNow = await this.resolveAuthoritativeServerNow(tx);
      const elapsedMs = serverNow.getTime() - lockedMessage.createdAt.getTime();
      if (elapsedMs > MESSAGE_RECALL_WINDOW_MS) {
        throw new ChatDomainError({
          status: 403,
          code: 'CHAT_MESSAGE_RECALL_WINDOW_EXPIRED',
          message: CHAT_MESSAGES.recallWindowExpired,
        });
      }

      const previousAttachmentStorageKey = lockedMessage.attachmentStorageKey;
      const recalledRow = await this.repository.recallMessageAtomically(
        {
          messageId: lockedMessage.id,
          senderId: actor.user.id,
          recallWindowSeconds,
        },
        tx,
      );

      if (!recalledRow) {
        throw new ChatDomainError({
          status: 403,
          code: 'CHAT_MESSAGE_RECALL_WINDOW_EXPIRED',
          message: CHAT_MESSAGES.recallWindowExpired,
        });
      }

      const deletedAttachmentRows =
        typeof this.repository.softDeleteAttachmentsByMessageId === 'function'
          ? await this.repository.softDeleteAttachmentsByMessageId(
              {
                messageId: lockedMessage.id,
                uploaderId: actor.user.id,
              },
              tx,
            )
          : [];

      // Dọn sạch toàn bộ cảm xúc & gỡ ghim (nếu có) ngay khi tin nhắn bị thu hồi.
      if (typeof this.repository.deleteAllReactionsForMessage === 'function') {
        await this.repository.deleteAllReactionsForMessage(lockedMessage.id, tx);
      }
      const unpinnedIds =
        typeof this.repository.deleteMessagePinsByIds === 'function'
          ? await this.repository.deleteMessagePinsByIds(conversation.id, [lockedMessage.id], tx)
          : [];

      const storageTargets: Array<{
        readonly storageKey: string;
        readonly storageUrl: string | null;
      }> = [];
      const seenKeys = new Set<string>();
      for (const att of deletedAttachmentRows) {
        if (att.storageKey && !seenKeys.has(att.storageKey)) {
          seenKeys.add(att.storageKey);
          storageTargets.push({ storageKey: att.storageKey, storageUrl: att.storageUrl });
        }
      }
      if (previousAttachmentStorageKey && !seenKeys.has(previousAttachmentStorageKey)) {
        storageTargets.push({ storageKey: previousAttachmentStorageKey, storageUrl: null });
      }

      const dto = toMessageDto(
        recalledRow,
        conversation.publicId,
        actor.user.publicId,
        actor.user.publicId,
        {
          reactions: [],
          isPinned: false,
        },
      );

      return {
        message: dto,
        wasPinned: unpinnedIds.length > 0,
        attachmentStorageTargets: storageTargets,
        peerPublicId: peerUser!.publicId,
        shouldNotifyPeerRealtime: peerParticipant!.inboxState !== 'declined',
      };
    });

    // Dọn vĩnh viễn tệp bản mã trên Storage (best-effort sau khi DB đã tombstone nguyên tử; lỗi mạng chỉ log cảnh báo, tuyệt đối không trả 500).
    if (outcome.attachmentStorageTargets.length > 0) {
      const storage = this.resolveMediaStorageProvider();
      for (const item of outcome.attachmentStorageTargets) {
        const storageTarget =
          storage.provider === 'vercel_blob'
            ? item.storageUrl?.trim() || item.storageKey
            : item.storageKey;
        try {
          if (this.onAttachmentRecalled) {
            await this.onAttachmentRecalled(storageTarget);
          } else {
            await storage.deleteObject(storageTarget);
          }
        } catch (error) {
          logger.warn(
            {
              component: 'chat-service',
              event: 'chat_recall_attachment_cleanup_failed',
              errorName: error instanceof Error ? error.name : 'UnknownError',
            },
            'Không thể dọn tệp đính kèm sau khi thu hồi tin nhắn',
          );
        }
      }
    }

    const eventPayload = {
      conversationPublicId: outcome.message.conversationPublicId,
      messagePublicId: outcome.message.public_id,
      seq: outcome.message.seq,
      recalledAt: outcome.message.recalledAt,
    };

    const publishTasks: Promise<void>[] = [
      this.publishChatEventBestEffort(actor.user.publicId, 'chat.message.recalled', eventPayload),
    ];
    if (outcome.shouldNotifyPeerRealtime) {
      publishTasks.push(
        this.publishChatEventBestEffort(
          outcome.peerPublicId,
          'chat.message.recalled',
          eventPayload,
        ),
      );
    }
    if (outcome.wasPinned) {
      const unpinPayload = {
        conversationPublicId: outcome.message.conversationPublicId,
        messagePublicId: outcome.message.public_id,
        pinned: false,
        actorPublicId: actor.user.publicId,
        updatedAt: outcome.message.recalledAt ?? this.now().toISOString(),
      };
      publishTasks.push(
        this.publishChatEventBestEffort(
          actor.user.publicId,
          'chat.message.pin.updated',
          unpinPayload,
        ),
      );
      if (outcome.shouldNotifyPeerRealtime) {
        publishTasks.push(
          this.publishChatEventBestEffort(
            outcome.peerPublicId,
            'chat.message.pin.updated',
            unpinPayload,
          ),
        );
      }
    }
    await Promise.all(publishTasks);

    return { message: outcome.message };
  }

  async deleteMessageForMe(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
  ): Promise<DeleteMessageForMeResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:delete_for_me:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.deleteMessageForMeByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);
    const currentTime = this.now();

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const found = await this.repository.findMessageByPublicId(messagePublicId, tx);
      if (!found) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation = await this.repository.findConversationById(found.row.conversationId, tx);
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

      assertChatAuthorized(actor, 'chat:message:delete_for_me', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      await this.repository.insertMessageUserDeletion(
        {
          messageId: found.row.id,
          userId: actor.user.id,
          now: currentTime,
        },
        tx,
      );

      // Tự động dọn các bản ghi ghim nếu CẢ HAI thành viên đều đã xóa / ẩn tin nhắn đó.
      await this.purgeBothHiddenPinsInTx(conversation.id, participants, tx);

      const nextVisibleLastMsg = await this.repository.findLatestVisibleMessageForConversation(
        {
          conversationId: conversation.id,
          viewerUserId: actor.user.id,
          clearedBeforeSeq: Number(actorParticipant!.clearedBeforeSeq),
        },
        tx,
      );

      const unreadConversationsCount =
        typeof this.repository.countUnreadPrimaryConversationsForUser === 'function'
          ? await this.repository.countUnreadPrimaryConversationsForUser(actor.user.id, tx)
          : 0;

      return {
        conversationPublicId: conversation.publicId,
        messagePublicId: found.row.publicId,
        seq: Number(found.row.seq),
        nextLastMessage: nextVisibleLastMsg
          ? toMessageDto(
              nextVisibleLastMsg.row,
              conversation.publicId,
              nextVisibleLastMsg.senderPublicId,
              actor.user.publicId,
            )
          : null,
        unreadConversationsCount,
        deletedAt: currentTime.toISOString(),
      };
    });

    // CHỈ đồng bộ tới kênh cá nhân của chính `actor` (các tab khác của `actor`); TUYỆT ĐỐI KHÔNG gửi sang đối phương.
    await this.publishChatEventBestEffort(actor.user.publicId, 'chat.message.deleted_for_me', {
      conversationPublicId: outcome.conversationPublicId,
      messagePublicId: outcome.messagePublicId,
      seq: outcome.seq,
      unreadConversationsCount: outcome.unreadConversationsCount,
      deletedAt: outcome.deletedAt,
    });

    return {
      conversationPublicId: outcome.conversationPublicId,
      messagePublicId: outcome.messagePublicId,
      nextLastMessage: outcome.nextLastMessage,
      unreadConversationsCount: outcome.unreadConversationsCount,
      message: CHAT_MESSAGES.messageDeletedForMe,
    };
  }

  async deleteConversationForMe(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
  ): Promise<DeleteConversationForMeResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:delete:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.deleteConversationByUser,
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

      assertChatAuthorized(actor, 'chat:conversation:delete', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      const conversationLastSeq = Number(conversation.lastSeq);
      // Chỉ cập nhật `cleared_before_seq` và `hidden_at`; TUYỆT ĐỐI KHÔNG tăng `last_read_seq`
      // để tránh làm đối phương nhìn thấy trạng thái "Đã xem" giả cho các tin chưa đọc.
      const updatedActorParticipant = await this.repository.clearAndHideConversationForUser(
        {
          conversationId: conversation.id,
          userId: actor.user.id,
          conversationLastSeq,
          now: currentTime,
        },
        tx,
      );

      const effectiveParticipants = participants.map((p) =>
        p.userId === actor.user.id && updatedActorParticipant ? updatedActorParticipant : p,
      );
      await this.purgeBothHiddenPinsInTx(conversation.id, effectiveParticipants, tx);

      if (actorParticipant!.inboxState === 'pending' && this.notificationService && peerUser) {
        pendingDispatches.push(
          await this.notificationService.removeMessageRequestNotificationsInTx(tx, {
            recipientId: actor.user.id,
            recipientPublicId: actor.user.publicId,
            actorIds: [peerUser.id],
          }),
        );
      }

      const [unreadConversationsCount, pendingCount] = await Promise.all([
        typeof this.repository.countUnreadPrimaryConversationsForUser === 'function'
          ? this.repository.countUnreadPrimaryConversationsForUser(actor.user.id, tx)
          : Promise.resolve(0),
        typeof this.repository.countPendingConversationsForUser === 'function'
          ? this.repository.countPendingConversationsForUser(actor.user.id, tx)
          : Promise.resolve(0),
      ]);

      return {
        conversationPublicId: conversation.publicId,
        clearedBeforeSeq: Number(
          updatedActorParticipant?.clearedBeforeSeq ??
            Math.max(Number(actorParticipant!.clearedBeforeSeq), conversationLastSeq),
        ),
        unreadConversationsCount,
        pendingCount,
        deletedAt: currentTime.toISOString(),
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    // CHỈ đồng bộ tới kênh cá nhân của chính `actor` (không bắn `deleted` hay `read` sang đối phương).
    await this.publishChatEventBestEffort(actor.user.publicId, 'chat.conversation.deleted', {
      conversationPublicId: outcome.conversationPublicId,
      clearedBeforeSeq: outcome.clearedBeforeSeq,
      unreadConversationsCount: outcome.unreadConversationsCount,
      pendingCount: outcome.pendingCount,
      deletedAt: outcome.deletedAt,
    });

    return {
      conversationPublicId: outcome.conversationPublicId,
      clearedBeforeSeq: outcome.clearedBeforeSeq,
      unreadConversationsCount: outcome.unreadConversationsCount,
      pendingCount: outcome.pendingCount,
      message: CHAT_MESSAGES.conversationDeletedForMe,
    };
  }

  // =========================================================================
  // 6. Cột mốc M11 — Đính kèm Ảnh HD & Tin nhắn thoại (Voice) E2EE Chống BOLA
  // =========================================================================

  async createAttachmentUploadToken(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
    rawInput: unknown,
    context: RequestClientContext = DEFAULT_CLIENT_CONTEXT,
  ): Promise<CreateAttachmentUploadTokenResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await Promise.all([
      this.consumeRateLimitOrThrow(
        `chat:attachments:upload:user:${actor.user.id}`,
        CHAT_RATE_LIMITS.uploadAttachmentByUser,
      ),
      this.consumeRateLimitOrThrow(
        `chat:attachments:upload:ip:${context.rateLimitIpKey}`,
        CHAT_RATE_LIMITS.uploadAttachmentByIp,
      ),
    ]);

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);
    const parsed = createAttachmentUploadTokenInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const maxAllowedBytes =
      parsed.data.mediaKind === 'image' ? MAX_IMAGE_CIPHERTEXT_BYTES : MAX_VOICE_CIPHERTEXT_BYTES;
    if (parsed.data.ciphertextSizeBytes > maxAllowedBytes) {
      throw new ChatDomainError({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message:
          parsed.data.mediaKind === 'image'
            ? CHAT_MESSAGES.attachmentTooLargeImage
            : CHAT_MESSAGES.attachmentTooLargeVoice,
      });
    }

    const currentTime = this.now();
    const expiresAt = new Date(currentTime.getTime() + ATTACHMENT_UPLOAD_TOKEN_TTL_MS);
    const orphanCutoff = new Date(currentTime.getTime() - ATTACHMENT_ORPHAN_EXPIRY_MS);
    const storageKey = generateChatMediaStorageKey();

    const txOutcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
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

      assertChatAuthorized(actor, 'chat:attachment:upload', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      // Cưỡng chế cứng luật Tin nhắn đang chờ ở Server: cấm tuyệt đối cấp quyền upload media khi chưa primary cả 2 phía.
      if (actorParticipant!.inboxState !== 'primary' || peerParticipant!.inboxState !== 'primary') {
        throw new ChatDomainError({
          status: 403,
          code: 'CHAT_PENDING_TEXT_ONLY',
          message: CHAT_MESSAGES.pendingTextOnly,
        });
      }

      const pendingRow = await this.repository.insertPendingAttachment(
        {
          conversationId: conversation.id,
          uploaderId: actor.user.id,
          mediaKind: parsed.data.mediaKind,
          storageKey,
          ciphertextSizeBytes: parsed.data.ciphertextSizeBytes,
          ciphertextSha256: parsed.data.ciphertextSha256,
          now: currentTime,
        },
        tx,
      );

      // Lazy cleanup: đánh dấu tối đa 5 bản ghi pending quá 60 phút của chính người dùng này để dọn trên Storage.
      const expiredOrphans =
        typeof this.repository.claimExpiredPendingAttachmentsForUser === 'function'
          ? await this.repository.claimExpiredPendingAttachmentsForUser(
              {
                uploaderId: actor.user.id,
                cutoffDate: orphanCutoff,
                limit: ATTACHMENT_LAZY_GC_BATCH_LIMIT,
              },
              tx,
            )
          : [];

      return { pendingRow, expiredOrphans };
    });

    const storage = this.resolveMediaStorageProvider();

    // Best-effort dọn tệp rác quá hạn (await gọn với Promise.allSettled để tương thích Vercel Serverless, tuyệt đối không làm hỏng luồng chính).
    if (txOutcome.expiredOrphans.length > 0) {
      await Promise.allSettled(
        txOutcome.expiredOrphans.map(async (orphan) => {
          const target =
            storage.provider === 'vercel_blob'
              ? orphan.storageUrl?.trim() || orphan.storageKey
              : orphan.storageKey;
          try {
            await storage.deleteObject(target);
          } catch (error) {
            logger.warn(
              {
                component: 'chat-service',
                event: 'chat_orphan_attachment_cleanup_failed',
                errorName: error instanceof Error ? error.name : 'UnknownError',
              },
              'Không thể dọn tệp đính kèm quá hạn',
            );
          }
        }),
      );
    }

    if (typeof storage.createEncryptedUploadGrant !== 'function') {
      throw new ChatDomainError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: CHAT_MESSAGES.attachmentUploadNotReady,
      });
    }

    const grant = await storage.createEncryptedUploadGrant({
      attachmentPublicId: txOutcome.pendingRow.publicId,
      storageKey: txOutcome.pendingRow.storageKey,
      exactSizeBytes: txOutcome.pendingRow.ciphertextSizeBytes,
      expiresAt,
    });

    return {
      attachmentPublicId: txOutcome.pendingRow.publicId,
      mediaKind: txOutcome.pendingRow.mediaKind,
      uploadMode: grant.uploadMode,
      pathname: grant.pathname,
      ...(grant.clientToken ? { clientToken: grant.clientToken } : {}),
      ...(grant.uploadUrl ? { uploadUrl: grant.uploadUrl } : {}),
      maxBytes: txOutcome.pendingRow.ciphertextSizeBytes,
      expiresAt: grant.expiresAt,
    };
  }

  async uploadLocalEncryptedAttachment(
    actor: AuthenticatedPrincipal,
    rawAttachmentPublicId: string,
    rawBody: Buffer,
    rawContentType: string | null,
    context: RequestClientContext = DEFAULT_CLIENT_CONTEXT,
  ): Promise<{
    readonly attachmentPublicId: string;
    readonly uploaded: true;
    readonly sizeBytes: number;
  }> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    const storage = this.resolveMediaStorageProvider();
    if (storage.provider === 'vercel_blob') {
      throw new ChatDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: CHAT_MESSAGES.notFound,
      });
    }

    await Promise.all([
      this.consumeRateLimitOrThrow(
        `chat:attachments:upload:user:${actor.user.id}`,
        CHAT_RATE_LIMITS.uploadAttachmentByUser,
      ),
      this.consumeRateLimitOrThrow(
        `chat:attachments:upload:ip:${context.rateLimitIpKey}`,
        CHAT_RATE_LIMITS.uploadAttachmentByIp,
      ),
    ]);

    const normalizedContentType = (rawContentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (normalizedContentType !== 'application/octet-stream') {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.attachmentInvalidContentType,
      });
    }

    const attachmentPublicId = parsePublicIdOrThrowNotFound(rawAttachmentPublicId);

    const attachment = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const found = await this.repository.findAttachmentByPublicId(attachmentPublicId, tx);
      if (
        !found ||
        found.uploaderId !== actor.user.id ||
        found.messageId !== null ||
        found.deletedAt !== null
      ) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation = await this.repository.findConversationById(found.conversationId, tx);
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

      assertChatAuthorized(actor, 'chat:attachment:upload', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (actorParticipant!.inboxState !== 'primary' || peerParticipant!.inboxState !== 'primary') {
        throw new ChatDomainError({
          status: 403,
          code: 'CHAT_PENDING_TEXT_ONLY',
          message: CHAT_MESSAGES.pendingTextOnly,
        });
      }

      return found;
    });

    if (rawBody.byteLength !== attachment.ciphertextSizeBytes) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.attachmentIntegrityMismatch,
      });
    }

    const actualSha256 = createHash('sha256').update(rawBody).digest('hex');
    if (actualSha256 !== attachment.ciphertextSha256.toLowerCase()) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.attachmentIntegrityMismatch,
      });
    }

    const stored = await storage.putObject({
      storageKey: attachment.storageKey,
      body: rawBody,
      contentType: 'application/octet-stream',
    });

    await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      await this.repository.markAttachmentStorageUrlUploaded(
        {
          attachmentId: attachment.id,
          uploaderId: actor.user.id,
          storageUrl: stored.url,
        },
        tx,
      );
    });

    return {
      attachmentPublicId: attachment.publicId,
      uploaded: true,
      sizeBytes: stored.byteLength,
    };
  }

  async getMessageAttachment(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
    rawQuery: Record<string, unknown> = {},
  ): Promise<GetMessageAttachmentResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:attachments:download:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.downloadAttachmentByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);
    const parsedQuery = attachmentDownloadQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsedQuery.error),
      });
    }

    const attachment = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const found = await this.repository.findMessageByPublicId(messagePublicId, tx);
      if (!found || found.row.recalledAt !== null) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation = await this.repository.findConversationById(found.row.conversationId, tx);
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

      assertChatAuthorized(actor, 'chat:attachment:read', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (Number(found.row.seq) <= Number(actorParticipant!.clearedBeforeSeq)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const isDeletedForActor = await this.repository.isMessageDeletedForUser(
        found.row.id,
        actor.user.id,
        tx,
      );
      if (isDeletedForActor) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const foundAttachment = await this.repository.findActiveAttachmentByMessageId(
        found.row.id,
        tx,
      );
      if (!foundAttachment || foundAttachment.deletedAt !== null) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      return foundAttachment;
    });

    const storage = this.resolveMediaStorageProvider();
    if (parsedQuery.data.download === '1') {
      if (storage.provider === 'vercel_blob' || typeof storage.readObject !== 'function') {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }
      const readResult = await storage.readObject(attachment.storageKey);
      if (!readResult) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }
      return {
        kind: 'binary',
        body: readResult.body,
        contentType: 'application/octet-stream',
        ciphertextSha256: attachment.ciphertextSha256.toLowerCase(),
        ciphertextSizeBytes: attachment.ciphertextSizeBytes,
      };
    }

    const downloadUrl =
      storage.provider === 'vercel_blob'
        ? (attachment.storageUrl?.trim() ?? '')
        : `/api/v1/messages/${encodeURIComponent(messagePublicId)}/attachment?download=1`;

    if (!downloadUrl) {
      throw new ChatDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: CHAT_MESSAGES.notFound,
      });
    }

    return {
      kind: 'grant',
      attachment: {
        attachmentPublicId: attachment.publicId,
        mediaKind: attachment.mediaKind,
        downloadUrl,
        ciphertextSha256: attachment.ciphertextSha256.toLowerCase(),
        ciphertextSizeBytes: attachment.ciphertextSizeBytes,
      },
    };
  }

  // =========================================================================
  // 7. Cột mốc M13 — Thả cảm xúc, Trả lời, Chuyển tiếp, Ghim tin nhắn, Ghim/Tắt thông báo đoạn chat
  // =========================================================================

  private async enrichMessagesForViewer(
    params: {
      readonly conversationId: string;
      readonly conversationPublicId: string;
      readonly viewerUserId: string;
      readonly viewerPublicId: string;
      readonly clearedBeforeSeq: number;
      readonly items: ReadonlyArray<{ readonly row: MessageRow; readonly senderPublicId: string }>;
    },
    tx: Parameters<Parameters<ChatRepository['runInRlsTx']>[1]>[0],
  ): Promise<ChatMessageDto[]> {
    if (params.items.length === 0) {
      return [];
    }

    const messageIds = params.items.map((item) => item.row.id);
    const nonRecalledIds = params.items
      .filter((item) => item.row.recalledAt === null)
      .map((item) => item.row.id);
    const replyTargetIds = params.items
      .map((item) => item.row.replyToMessageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const [reactionRows, replyMetaMap, pinnedIdSet] = await Promise.all([
      nonRecalledIds.length > 0 && typeof this.repository.listReactionsForMessageIds === 'function'
        ? this.repository.listReactionsForMessageIds(params.conversationId, nonRecalledIds, tx)
        : Promise.resolve([]),
      replyTargetIds.length > 0 &&
      typeof this.repository.findReplyTargetsMetadataByIds === 'function'
        ? this.repository.findReplyTargetsMetadataByIds(
            {
              conversationId: params.conversationId,
              messageIds: replyTargetIds,
              viewerUserId: params.viewerUserId,
              clearedBeforeSeq: params.clearedBeforeSeq,
            },
            tx,
          )
        : Promise.resolve(new Map()),
      typeof this.repository.listPinnedMessageIdsInSet === 'function'
        ? this.repository.listPinnedMessageIdsInSet(params.conversationId, messageIds, tx)
        : Promise.resolve(new Set<string>()),
    ]);

    const reactionsByMessageId = new Map<string, MessageReactionDto[]>();
    for (const r of reactionRows) {
      const list = reactionsByMessageId.get(r.messageId) ?? [];
      list.push({
        userPublicId: r.userPublicId,
        emoji: r.emoji,
        updatedAt: r.updatedAt.toISOString(),
      });
      reactionsByMessageId.set(r.messageId, list);
    }

    return params.items.map((item) => {
      const replyTarget =
        item.row.replyToMessageId !== null
          ? (replyMetaMap.get(item.row.replyToMessageId) ?? null)
          : null;

      return toMessageDto(
        item.row,
        params.conversationPublicId,
        item.senderPublicId,
        params.viewerPublicId,
        {
          reactions: item.row.recalledAt ? [] : (reactionsByMessageId.get(item.row.id) ?? []),
          replyToMeta: replyTarget
            ? {
                messagePublicId: replyTarget.messagePublicId,
                senderPublicId: replyTarget.senderPublicId,
                seq: replyTarget.seq,
                messageType: replyTarget.messageType,
                recalledAt: replyTarget.recalledAt ? replyTarget.recalledAt.toISOString() : null,
                deletedForViewer: replyTarget.deletedForViewer,
              }
            : null,
          isPinned: pinnedIdSet.has(item.row.id),
        },
      );
    });
  }

  /**
   * Tự động dọn các bản ghi `message_pins` khi tin nhắn đã bị thu hồi HOẶC cả hai thành viên
   * đều đã xóa 1 phía / xóa đoạn chat qua tin nhắn đó (chống deadlock giới hạn 5 tin ghim).
   */
  private async purgeBothHiddenPinsInTx(
    conversationId: string,
    participants: readonly ConversationParticipantRow[],
    tx: Parameters<Parameters<ChatRepository['runInRlsTx']>[1]>[0],
  ): Promise<{
    readonly activePins: Awaited<
      ReturnType<ChatRepository['listPinnedMessagesRawForConversation']>
    >;
    readonly deletionsByUserId: Map<string, Set<string>>;
  }> {
    if (
      typeof this.repository.listPinnedMessagesRawForConversation !== 'function' ||
      typeof this.repository.listMessageDeletionsForMessagesAndUsers !== 'function' ||
      typeof this.repository.deleteMessagePinsByIds !== 'function'
    ) {
      return {
        activePins: [],
        deletionsByUserId: new Map(),
      };
    }

    const rawPins = await this.repository.listPinnedMessagesRawForConversation(conversationId, tx);
    if (rawPins.length === 0) {
      return {
        activePins: [],
        deletionsByUserId: new Map(),
      };
    }

    const pinMessageIds = rawPins.map((p) => p.message.id);
    const participantIds = participants.map((p) => p.userId);
    const deletions = await this.repository.listMessageDeletionsForMessagesAndUsers(
      pinMessageIds,
      participantIds,
      tx,
    );

    const deletionsByUserId = new Map<string, Set<string>>();
    for (const d of deletions) {
      const set = deletionsByUserId.get(d.userId) ?? new Set<string>();
      set.add(d.messageId);
      deletionsByUserId.set(d.userId, set);
    }

    const isHiddenForParticipant = (
      pinMsg: MessageRow,
      participant: ConversationParticipantRow,
    ): boolean => {
      if (pinMsg.recalledAt !== null) {
        return true;
      }
      if (Number(pinMsg.seq) <= Number(participant.clearedBeforeSeq)) {
        return true;
      }
      return deletionsByUserId.get(participant.userId)?.has(pinMsg.id) === true;
    };

    const deadMessageIds: string[] = [];
    const activePins: typeof rawPins = [];

    for (const entry of rawPins) {
      const isRecalled = entry.message.recalledAt !== null;
      const hiddenForAll =
        participants.length >= 2 &&
        participants.every((p) => isHiddenForParticipant(entry.message, p));

      if (isRecalled || hiddenForAll) {
        deadMessageIds.push(entry.message.id);
      } else {
        activePins.push(entry);
      }
    }

    if (deadMessageIds.length > 0) {
      await this.repository.deleteMessagePinsByIds(conversationId, deadMessageIds, tx);
    }

    return {
      activePins,
      deletionsByUserId,
    };
  }

  /**
   * Thả / cập nhật biểu tượng cảm xúc (PUT idempotent thuần túy — KHÔNG tự toggle xóa).
   */
  async upsertMessageReaction(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
    rawInput: unknown,
  ): Promise<MessageReactionMutationResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:react:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.reactMessageByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);
    const parsed = upsertReactionInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const currentTime = this.now();

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const found = await this.repository.findMessageByPublicId(messagePublicId, tx);
      if (!found) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation = await this.repository.findConversationById(found.row.conversationId, tx);
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

      assertChatAuthorized(actor, 'chat:message:react', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (actorParticipant!.inboxState !== 'primary' || peerParticipant!.inboxState !== 'primary') {
        throw new ChatDomainError({
          status: 403,
          code: 'FORBIDDEN',
          message: CHAT_MESSAGES.pendingInteractionForbidden,
        });
      }

      if (Number(found.row.seq) <= Number(actorParticipant!.clearedBeforeSeq)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }
      const isDeletedForActor = await this.repository.isMessageDeletedForUser(
        found.row.id,
        actor.user.id,
        tx,
      );
      if (isDeletedForActor) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      if (found.row.recalledAt !== null) {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_ALREADY_RECALLED',
          message: CHAT_MESSAGES.alreadyRecalled,
        });
      }

      if (found.row.messageType === 'call_event') {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_ACTION_UNSUPPORTED_TYPE',
          message: CHAT_MESSAGES.reactionUnsupportedType,
        });
      }

      await this.repository.upsertMessageReaction(
        {
          conversationId: conversation.id,
          messageId: found.row.id,
          userId: actor.user.id,
          emoji: parsed.data.emoji,
          now: currentTime,
        },
        tx,
      );

      const latestReactions = await this.repository.listReactionsForMessageIds(
        conversation.id,
        [found.row.id],
        tx,
      );

      return {
        conversationPublicId: conversation.publicId,
        messagePublicId: found.row.publicId,
        seq: Number(found.row.seq),
        emoji: parsed.data.emoji,
        reactions: latestReactions.map((r) => ({
          userPublicId: r.userPublicId,
          emoji: r.emoji,
          updatedAt: r.updatedAt.toISOString(),
        })),
        peerPublicId: peerUser!.publicId,
        updatedAt: currentTime.toISOString(),
      };
    });

    const eventPayload = {
      conversationPublicId: outcome.conversationPublicId,
      messagePublicId: outcome.messagePublicId,
      seq: outcome.seq,
      actorPublicId: actor.user.publicId,
      emoji: outcome.emoji,
      updatedAt: outcome.updatedAt,
    };

    await Promise.all([
      this.publishChatEventBestEffort(
        actor.user.publicId,
        'chat.message.reaction.updated',
        eventPayload,
      ),
      this.publishChatEventBestEffort(
        outcome.peerPublicId,
        'chat.message.reaction.updated',
        eventPayload,
      ),
    ]);

    return {
      conversationPublicId: outcome.conversationPublicId,
      messagePublicId: outcome.messagePublicId,
      emoji: outcome.emoji,
      reactions: outcome.reactions,
      message: CHAT_MESSAGES.reactionUpdated,
    };
  }

  /**
   * Gỡ biểu tượng cảm xúc của chính mình trên 1 tin nhắn (DELETE RESTful rõ nghĩa).
   */
  async removeMessageReaction(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
  ): Promise<MessageReactionMutationResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:react:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.reactMessageByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);
    const currentTime = this.now();

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const found = await this.repository.findMessageByPublicId(messagePublicId, tx);
      if (!found) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation = await this.repository.findConversationById(found.row.conversationId, tx);
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

      assertChatAuthorized(actor, 'chat:message:react', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (actorParticipant!.inboxState !== 'primary' || peerParticipant!.inboxState !== 'primary') {
        throw new ChatDomainError({
          status: 403,
          code: 'FORBIDDEN',
          message: CHAT_MESSAGES.pendingInteractionForbidden,
        });
      }

      if (Number(found.row.seq) <= Number(actorParticipant!.clearedBeforeSeq)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }
      const isDeletedForActor = await this.repository.isMessageDeletedForUser(
        found.row.id,
        actor.user.id,
        tx,
      );
      if (isDeletedForActor) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      await this.repository.deleteMessageReaction(found.row.id, actor.user.id, tx);
      const latestReactions = await this.repository.listReactionsForMessageIds(
        conversation.id,
        [found.row.id],
        tx,
      );

      return {
        conversationPublicId: conversation.publicId,
        messagePublicId: found.row.publicId,
        seq: Number(found.row.seq),
        reactions: latestReactions.map((r) => ({
          userPublicId: r.userPublicId,
          emoji: r.emoji,
          updatedAt: r.updatedAt.toISOString(),
        })),
        peerPublicId: peerUser!.publicId,
        updatedAt: currentTime.toISOString(),
      };
    });

    const eventPayload = {
      conversationPublicId: outcome.conversationPublicId,
      messagePublicId: outcome.messagePublicId,
      seq: outcome.seq,
      actorPublicId: actor.user.publicId,
      emoji: null,
      updatedAt: outcome.updatedAt,
    };

    await Promise.all([
      this.publishChatEventBestEffort(
        actor.user.publicId,
        'chat.message.reaction.updated',
        eventPayload,
      ),
      this.publishChatEventBestEffort(
        outcome.peerPublicId,
        'chat.message.reaction.updated',
        eventPayload,
      ),
    ]);

    return {
      conversationPublicId: outcome.conversationPublicId,
      messagePublicId: outcome.messagePublicId,
      emoji: null,
      reactions: outcome.reactions,
      message: CHAT_MESSAGES.reactionRemoved,
    };
  }

  /**
   * Liệt kê danh sách Tin nhắn đã ghim trong hội thoại (tối đa 5 tin).
   * Tự động dọn tin ghim đã bị cả 2 phía xóa/ẩn và trả kèm `totalPinnedCount` & `hiddenPinnedCount`.
   */
  async listPinnedMessages(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
  ): Promise<PinnedMessagesListResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:pins:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.listPinsByUser,
    );

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);

    return this.repository.runInRlsTx(actor.user.id, async (tx) => {
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

      assertChatAuthorized(actor, 'chat:conversation:pins:list', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      const { activePins, deletionsByUserId } = await this.purgeBothHiddenPinsInTx(
        conversation.id,
        participants,
        tx,
      );

      const actorDeletedSet = deletionsByUserId.get(actor.user.id) ?? new Set<string>();
      const actorClearedBeforeSeq = Number(actorParticipant!.clearedBeforeSeq);

      const visibleEntries = activePins.filter(
        (entry) =>
          Number(entry.message.seq) > actorClearedBeforeSeq &&
          !actorDeletedSet.has(entry.message.id),
      );
      const hiddenPinnedCount = Math.max(0, activePins.length - visibleEntries.length);

      const enrichedDtos = await this.enrichMessagesForViewer(
        {
          conversationId: conversation.id,
          conversationPublicId: conversation.publicId,
          viewerUserId: actor.user.id,
          viewerPublicId: actor.user.publicId,
          clearedBeforeSeq: actorClearedBeforeSeq,
          items: visibleEntries.map((entry) => ({
            row: entry.message,
            senderPublicId: entry.senderPublicId,
          })),
        },
        tx,
      );

      const items: PinnedMessageItemDto[] = visibleEntries.map((entry, idx) => ({
        message: {
          ...enrichedDtos[idx]!,
          isPinned: true,
        },
        pinnedAt: entry.pin.pinnedAt.toISOString(),
        pinnedByPublicId: entry.pinnedByPublicId,
      }));

      return {
        conversationPublicId: conversation.publicId,
        items,
        totalPinnedCount: activePins.length,
        hiddenPinnedCount,
        maxPinnedMessages: MAX_PINNED_MESSAGES_PER_CONVERSATION,
      };
    });
  }

  /**
   * Ghim 1 tin nhắn (tối đa 5 tin/hội thoại, chống deadlock khi có tin ghim cũ đã ẩn ở phía mình).
   */
  async pinMessage(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
    rawInput: unknown = {},
  ): Promise<MessagePinMutationResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:pin:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.pinMessageByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);
    const parsedBody = pinMessageInputSchema.safeParse(rawInput ?? {});
    if (!parsedBody.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsedBody.error),
      });
    }

    const currentTime = this.now();

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const found = await this.repository.findMessageByPublicId(messagePublicId, tx);
      if (!found) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      // Khóa dòng `conversations` FOR UPDATE để tuần tự hóa giới hạn nguyên tử tối đa 5 tin nhắn ghim.
      const conversation =
        typeof this.repository.lockConversationById === 'function'
          ? await this.repository.lockConversationById(found.row.conversationId, tx)
          : await this.repository.findConversationById(found.row.conversationId, tx);
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

      assertChatAuthorized(actor, 'chat:message:pin', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (actorParticipant!.inboxState !== 'primary' || peerParticipant!.inboxState !== 'primary') {
        throw new ChatDomainError({
          status: 403,
          code: 'FORBIDDEN',
          message: CHAT_MESSAGES.pendingInteractionForbidden,
        });
      }

      if (Number(found.row.seq) <= Number(actorParticipant!.clearedBeforeSeq)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }
      const isDeletedForActor = await this.repository.isMessageDeletedForUser(
        found.row.id,
        actor.user.id,
        tx,
      );
      if (isDeletedForActor) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      if (found.row.recalledAt !== null) {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_ALREADY_RECALLED',
          message: CHAT_MESSAGES.alreadyRecalled,
        });
      }

      if (found.row.messageType === 'call_event') {
        throw new ChatDomainError({
          status: 409,
          code: 'CHAT_MESSAGE_ACTION_UNSUPPORTED_TYPE',
          message: CHAT_MESSAGES.pinUnsupportedType,
        });
      }

      const { activePins, deletionsByUserId } = await this.purgeBothHiddenPinsInTx(
        conversation.id,
        participants,
        tx,
      );

      const alreadyPinned = activePins.some((p) => p.message.id === found.row.id);
      if (alreadyPinned) {
        return {
          conversationPublicId: conversation.publicId,
          messagePublicId: found.row.publicId,
          totalPinnedCount: activePins.length,
          unpinnedHiddenMessagePublicId: null as string | null,
          changed: false,
          peerPublicId: peerUser!.publicId,
          updatedAt: currentTime.toISOString(),
        };
      }

      let effectiveCount = activePins.length;
      let unpinnedHiddenMessagePublicId: string | null = null;

      if (effectiveCount >= MAX_PINNED_MESSAGES_PER_CONVERSATION) {
        const actorDeletedSet = deletionsByUserId.get(actor.user.id) ?? new Set<string>();
        const actorClearedBeforeSeq = Number(actorParticipant!.clearedBeforeSeq);
        const hiddenForActor = activePins.filter(
          (entry) =>
            Number(entry.message.seq) <= actorClearedBeforeSeq ||
            actorDeletedSet.has(entry.message.id),
        );

        if (parsedBody.data.unpinOldestHiddenIfFull === true && hiddenForActor.length > 0) {
          // `activePins` đã sắp xếp `pinned_at DESC` -> phần tử cuối là tin ghim ẩn cũ nhất.
          const oldestHidden = hiddenForActor[hiddenForActor.length - 1]!;
          await this.repository.deleteMessagePinsByIds(
            conversation.id,
            [oldestHidden.message.id],
            tx,
          );
          unpinnedHiddenMessagePublicId = oldestHidden.message.publicId;
          effectiveCount -= 1;
        } else {
          throw new ChatDomainError({
            status: 409,
            code: 'CHAT_PINNED_MESSAGES_LIMIT_REACHED',
            message:
              hiddenForActor.length > 0
                ? CHAT_MESSAGES.pinnedMessagesLimitReachedWithHidden
                : CHAT_MESSAGES.pinnedMessagesLimitReached,
            details: [
              {
                field: 'hiddenPinnedCount',
                message: String(hiddenForActor.length),
              },
            ],
          });
        }
      }

      await this.repository.insertMessagePin(
        {
          conversationId: conversation.id,
          messageId: found.row.id,
          pinnedByUserId: actor.user.id,
          now: currentTime,
        },
        tx,
      );

      return {
        conversationPublicId: conversation.publicId,
        messagePublicId: found.row.publicId,
        totalPinnedCount: effectiveCount + 1,
        unpinnedHiddenMessagePublicId,
        changed: true,
        peerPublicId: peerUser!.publicId,
        updatedAt: currentTime.toISOString(),
      };
    });

    if (outcome.changed) {
      const publishTasks: Promise<void>[] = [];
      if (outcome.unpinnedHiddenMessagePublicId) {
        const unpinHiddenPayload = {
          conversationPublicId: outcome.conversationPublicId,
          messagePublicId: outcome.unpinnedHiddenMessagePublicId,
          pinned: false,
          actorPublicId: actor.user.publicId,
          updatedAt: outcome.updatedAt,
        };
        publishTasks.push(
          this.publishChatEventBestEffort(
            actor.user.publicId,
            'chat.message.pin.updated',
            unpinHiddenPayload,
          ),
          this.publishChatEventBestEffort(
            outcome.peerPublicId,
            'chat.message.pin.updated',
            unpinHiddenPayload,
          ),
        );
      }

      const pinPayload = {
        conversationPublicId: outcome.conversationPublicId,
        messagePublicId: outcome.messagePublicId,
        pinned: true,
        actorPublicId: actor.user.publicId,
        updatedAt: outcome.updatedAt,
      };
      publishTasks.push(
        this.publishChatEventBestEffort(
          actor.user.publicId,
          'chat.message.pin.updated',
          pinPayload,
        ),
        this.publishChatEventBestEffort(
          outcome.peerPublicId,
          'chat.message.pin.updated',
          pinPayload,
        ),
      );
      await Promise.all(publishTasks);
    }

    return {
      conversationPublicId: outcome.conversationPublicId,
      messagePublicId: outcome.messagePublicId,
      isPinned: true,
      totalPinnedCount: outcome.totalPinnedCount,
      unpinnedHiddenMessagePublicId: outcome.unpinnedHiddenMessagePublicId,
      message: CHAT_MESSAGES.messagePinned,
    };
  }

  /**
   * Gỡ ghim 1 tin nhắn trong hội thoại.
   */
  async unpinMessage(
    actor: AuthenticatedPrincipal,
    rawMessagePublicId: string,
  ): Promise<MessagePinMutationResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:messages:pin:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.pinMessageByUser,
    );

    const messagePublicId = parsePublicIdOrThrowNotFound(rawMessagePublicId);
    const currentTime = this.now();

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const found = await this.repository.findMessageByPublicId(messagePublicId, tx);
      if (!found) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const conversation =
        typeof this.repository.lockConversationById === 'function'
          ? await this.repository.lockConversationById(found.row.conversationId, tx)
          : await this.repository.findConversationById(found.row.conversationId, tx);
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

      assertChatAuthorized(actor, 'chat:message:pin', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (actorParticipant!.inboxState !== 'primary' || peerParticipant!.inboxState !== 'primary') {
        throw new ChatDomainError({
          status: 403,
          code: 'FORBIDDEN',
          message: CHAT_MESSAGES.pendingInteractionForbidden,
        });
      }

      if (Number(found.row.seq) <= Number(actorParticipant!.clearedBeforeSeq)) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }
      const isDeletedForActor = await this.repository.isMessageDeletedForUser(
        found.row.id,
        actor.user.id,
        tx,
      );
      if (isDeletedForActor) {
        throw new ChatDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: CHAT_MESSAGES.notFound,
        });
      }

      const deleted = await this.repository.deleteMessagePinsByIds(
        conversation.id,
        [found.row.id],
        tx,
      );
      const { activePins } = await this.purgeBothHiddenPinsInTx(conversation.id, participants, tx);

      return {
        conversationPublicId: conversation.publicId,
        messagePublicId: found.row.publicId,
        totalPinnedCount: activePins.length,
        changed: deleted.length > 0,
        peerPublicId: peerUser!.publicId,
        updatedAt: currentTime.toISOString(),
      };
    });

    if (outcome.changed) {
      const eventPayload = {
        conversationPublicId: outcome.conversationPublicId,
        messagePublicId: outcome.messagePublicId,
        pinned: false,
        actorPublicId: actor.user.publicId,
        updatedAt: outcome.updatedAt,
      };
      await Promise.all([
        this.publishChatEventBestEffort(
          actor.user.publicId,
          'chat.message.pin.updated',
          eventPayload,
        ),
        this.publishChatEventBestEffort(
          outcome.peerPublicId,
          'chat.message.pin.updated',
          eventPayload,
        ),
      ]);
    }

    return {
      conversationPublicId: outcome.conversationPublicId,
      messagePublicId: outcome.messagePublicId,
      isPinned: false,
      totalPinnedCount: outcome.totalPinnedCount,
      message: CHAT_MESSAGES.messageUnpinned,
    };
  }

  /**
   * Cập nhật tùy chọn cá nhân cho 1 đoạn chat (Ghim đoạn chat tối đa 3 & Tắt/Bật thông báo).
   * Tùy chọn này 100% RIÊNG TƯ — sự kiện Realtime CHỈ phát tới kênh `user:{actor.publicId}`.
   */
  async updateConversationPreferences(
    actor: AuthenticatedPrincipal,
    rawConversationPublicId: string,
    rawInput: unknown,
  ): Promise<ConversationPreferencesResult> {
    assertChatAuthorized(actor, 'chat:conversation:list');
    await this.consumeRateLimitOrThrow(
      `chat:conversations:preferences:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.updateConversationPreferencesByUser,
    );

    const conversationPublicId = parsePublicIdOrThrowNotFound(rawConversationPublicId);
    const parsed = updateConversationPreferencesInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const currentTime = this.now();

    const outcome = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      // Khóa dòng `users` của chính actor khi bật ghim để tuần tự hóa hạn mức tối đa 3 đoạn chat ghim.
      if (
        parsed.data.pinned === true &&
        typeof this.repository.lockUsersInCanonicalOrder === 'function'
      ) {
        await this.repository.lockUsersInCanonicalOrder([actor.user.id], tx);
      }

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

      assertChatAuthorized(actor, 'chat:conversation:preferences:update', {
        conversation,
        actorParticipant,
        peerUser,
        relationship,
      });

      if (parsed.data.pinned === true) {
        if (actorParticipant!.inboxState !== 'primary' || actorParticipant!.hiddenAt !== null) {
          throw new ChatDomainError({
            status: 403,
            code: 'FORBIDDEN',
            message: CHAT_MESSAGES.pendingPinConversationForbidden,
          });
        }

        if (!actorParticipant!.pinnedAt) {
          const currentPinnedCount = await this.repository.countPinnedPrimaryConversationsForUser(
            actor.user.id,
            tx,
          );
          if (currentPinnedCount >= MAX_PINNED_CONVERSATIONS_PER_USER) {
            throw new ChatDomainError({
              status: 409,
              code: 'CHAT_PINNED_CONVERSATIONS_LIMIT_REACHED',
              message: CHAT_MESSAGES.pinnedConversationsLimitReached,
            });
          }
        }
      }

      const nextPinnedAt =
        parsed.data.pinned !== undefined
          ? parsed.data.pinned
            ? (actorParticipant!.pinnedAt ?? currentTime)
            : null
          : actorParticipant!.pinnedAt;

      const nextMutedAt =
        parsed.data.muted !== undefined
          ? parsed.data.muted
            ? (actorParticipant!.mutedAt ?? currentTime)
            : null
          : actorParticipant!.mutedAt;

      const updated = (await this.repository.updateParticipantState(
        conversation.id,
        actor.user.id,
        {
          pinnedAt: nextPinnedAt,
          mutedAt: nextMutedAt,
        },
        tx,
      )) ?? {
        ...actorParticipant!,
        pinnedAt: nextPinnedAt,
        mutedAt: nextMutedAt,
      };

      const unreadConversationsCount =
        typeof this.repository.countUnreadPrimaryConversationsForUser === 'function'
          ? await this.repository.countUnreadPrimaryConversationsForUser(actor.user.id, tx)
          : 0;

      return {
        conversationPublicId: conversation.publicId,
        pinnedAt: updated.pinnedAt ? updated.pinnedAt.toISOString() : null,
        mutedAt: updated.mutedAt ? updated.mutedAt.toISOString() : null,
        isPinned: Boolean(updated.pinnedAt),
        isMuted: Boolean(updated.mutedAt),
        unreadConversationsCount,
        updatedAt: currentTime.toISOString(),
      };
    });

    // CHỈ phát cho các tab của chính `actor`, tuyệt đối không lộ cho đối phương!
    await this.publishChatEventBestEffort(
      actor.user.publicId,
      'chat.conversation.preferences.updated',
      {
        conversationPublicId: outcome.conversationPublicId,
        pinnedAt: outcome.pinnedAt,
        mutedAt: outcome.mutedAt,
        isPinned: outcome.isPinned,
        isMuted: outcome.isMuted,
        unreadConversationsCount: outcome.unreadConversationsCount,
        updatedAt: outcome.updatedAt,
      },
    );

    return {
      conversationPublicId: outcome.conversationPublicId,
      pinnedAt: outcome.pinnedAt,
      mutedAt: outcome.mutedAt,
      isPinned: outcome.isPinned,
      isMuted: outcome.isMuted,
      unreadConversationsCount: outcome.unreadConversationsCount,
      message: CHAT_MESSAGES.conversationPreferencesUpdated,
    };
  }

  /**
   * Liệt kê danh sách người nhận đủ điều kiện Chuyển tiếp (Mutual Follow ∪ Đã từng trò chuyện).
   */
  async listForwardTargets(
    actor: AuthenticatedPrincipal,
    rawQuery: Record<string, unknown>,
  ): Promise<ForwardTargetsListResult> {
    assertChatAuthorized(actor, 'chat:forward:targets:list');
    await this.consumeRateLimitOrThrow(
      `chat:forward:targets:user:${actor.user.id}`,
      CHAT_RATE_LIMITS.listForwardTargetsByUser,
    );

    const parsed = listForwardTargetsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: CHAT_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const rows = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      return this.repository.listEligibleForwardTargets(
        {
          actorUserId: actor.user.id,
          query: parsed.data.q,
          limit: parsed.data.limit,
        },
        tx,
      );
    });

    return {
      items: rows.map((row) => ({
        public_id: row.publicId,
        handle: row.handle,
        fullName: row.fullName,
        avatarUrl: row.avatarUrl,
        isPrivate: row.isPrivate,
        conversationPublicId: row.conversationPublicId,
        lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
      })),
    };
  }

  private async publishChatEventBestEffort(
    recipientPublicId: string,
    eventName:
      | 'chat.message.created'
      | 'chat.message.updated'
      | 'chat.message.recalled'
      | 'chat.message.deleted_for_me'
      | 'chat.message.reaction.updated'
      | 'chat.message.pin.updated'
      | 'chat.conversation.read'
      | 'chat.conversation.updated'
      | 'chat.conversation.preferences.updated'
      | 'chat.conversation.deleted',
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.realtimeProvider.publishToUser(recipientPublicId, eventName, payload);
    } catch (error) {
      // Best-effort: dữ liệu đã được lưu bền vững trong PostgreSQL, chỉ ghi nhận cảnh báo kỹ thuật qua structured logger.
      logger.warn(
        {
          component: 'chat-service',
          event: 'chat_realtime_publish_failed',
          eventName,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'Không thể đẩy sự kiện Realtime cho cuộc trò chuyện',
      );
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
