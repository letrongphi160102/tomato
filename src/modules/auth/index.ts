export { AuthDomainError, type AuthDomainErrorOptions } from '@/modules/auth/auth.errors';
export { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
export {
  AuthRepository,
  type CreatePendingUserParams,
  type IdentityWithUser,
  type OverwriteExpiredPendingUserParams,
  type ReissueEmailVerifyTokenParams,
} from '@/modules/auth/auth.repository';
export {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  EMAIL_MAX_LENGTH,
  MAX_REGISTRATION_AGE_YEARS,
  MIN_REGISTRATION_AGE_YEARS,
  OTP_CODE_REGEX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  calculateAgeYears,
  createRegisterInputSchema,
  parseStrictIsoDate,
  registerInputSchema,
  resendVerificationInputSchema,
  verifyEmailInputSchema,
  type ParsedCalendarDate,
  type RegisterInput,
  type ResendVerificationInput,
  type VerifyEmailInput,
} from '@/modules/auth/auth.schemas';
export {
  AuthService,
  EMAIL_VERIFY_OTP_MAX_ATTEMPTS,
  EMAIL_VERIFY_OTP_TTL_MINUTES,
  EMAIL_VERIFY_OTP_TTL_MS,
  PENDING_VERIFICATION_EXPIRY_MS,
  RESEND_COOLDOWN_SECONDS,
  createAuthService,
  getAuthService,
  resetAuthServiceForTesting,
  setAuthServiceForTesting,
  type AuthServiceDependencies,
  type RegisterResult,
  type ResendVerificationResult,
  type VerifyEmailResult,
} from '@/modules/auth/auth.service';
export { COMMON_PASSWORDS, isCommonOrWeakPassword } from '@/modules/auth/common-passwords';
