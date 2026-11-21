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
] as const;

export type VerificationTokenPurpose = (typeof VERIFICATION_TOKEN_PURPOSES)[number];

export const verificationTokenPurposeEnum = pgEnum(
  'verification_token_purpose',
  VERIFICATION_TOKEN_PURPOSES,
);
