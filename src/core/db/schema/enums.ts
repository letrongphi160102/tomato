import { pgEnum } from 'drizzle-orm/pg-core';

export const USER_STATUSES = [
  'pending_verification',
  'active',
  'locked',
  'suspended',
  'deleted',
] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

export const userStatusEnum = pgEnum('user_status', USER_STATUSES);

export const USER_GENDERS = ['male', 'female', 'other'] as const;

export type UserGender = (typeof USER_GENDERS)[number];

export const userGenderEnum = pgEnum('user_gender', USER_GENDERS);

export const AUTH_PROVIDERS = ['email_password'] as const;

export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const authProviderEnum = pgEnum('auth_provider', AUTH_PROVIDERS);

export const VERIFICATION_TOKEN_PURPOSES = [
  'email_verify',
  'password_reset',
  'password_change',
  'password_change_ticket',
] as const;

export type VerificationTokenPurpose = (typeof VERIFICATION_TOKEN_PURPOSES)[number];

export const verificationTokenPurposeEnum = pgEnum(
  'verification_token_purpose',
  VERIFICATION_TOKEN_PURPOSES,
);

export const FOLLOW_STATUSES = ['requested', 'following'] as const;

export type FollowStatus = (typeof FOLLOW_STATUSES)[number];

export const followStatusEnum = pgEnum('follow_status', FOLLOW_STATUSES);

export const NOTIFICATION_TYPES = [
  'follow_request',
  'follow_accepted',
  'new_follower',
  'message_request',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationTypeEnum = pgEnum('notification_type', NOTIFICATION_TYPES);

export const CONVERSATION_TYPES = ['direct'] as const;

export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const conversationTypeEnum = pgEnum('conversation_type', CONVERSATION_TYPES);

export const CONVERSATION_INBOX_STATES = ['primary', 'pending', 'declined'] as const;

export type ConversationInboxState = (typeof CONVERSATION_INBOX_STATES)[number];

export const conversationInboxStateEnum = pgEnum(
  'conversation_inbox_state',
  CONVERSATION_INBOX_STATES,
);

export const MESSAGE_TYPES = ['text', 'image', 'voice', 'call_event'] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export const messageTypeEnum = pgEnum('message_type', MESSAGE_TYPES);
