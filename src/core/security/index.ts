export {
  AUDIT_ACTIONS,
  AuditLogService,
  getAuditLogService,
  normalizeIpAddress,
  sanitizeAuditMetadata,
  type AuditAction,
  type AuditLogInput,
} from '@/core/security/audit-log.service';
export {
  extractRequestClientContext,
  type RequestClientContext,
} from '@/core/security/client-context';
export {
  ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS,
  CSRF_TOKEN_COOKIE_MAX_AGE_SECONDS,
  REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS,
  buildAuthCookieOptions,
  buildCsrfCookieOptions,
  clearAuthCookies,
  getAuthCookiesFromRequest,
  getCookieFromRequest,
  getCookieNames,
  isProductionCookieEnv,
  parseCookieHeader,
  setAuthCookies,
  setCsrfCookie,
  type CookieSecurityAttributes,
  type ParsedAuthCookies,
  type SetAuthCookiesInput,
  type SetAuthCookiesOptions,
  type TomatoCookieNames,
} from '@/core/security/cookies';
export {
  CSRF_HEADER_NAME,
  enforceCsrfAndOrigin,
  verifyCsrfAndOrigin,
  type CsrfFailureReason,
  type CsrfVerificationResult,
  type VerifyCsrfOptions,
} from '@/core/security/csrf';
export {
  API_CSP_VALUE,
  HSTS_HEADER_VALUE,
  PERMISSIONS_POLICY_VALUE,
  REFERRER_POLICY_VALUE,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  generateCspNonce,
  type SecurityHeadersContext,
} from '@/core/security/headers';
export {
  AUTH_CACHE_CONTROL_HEADER,
  applyNoStoreHeaders,
  createAuthJsonResponse,
  createErrorResponse,
  formatZodErrorDetails,
  type ApiErrorCode,
  type ApiErrorDetail,
  type ApiErrorPayload,
  type CreateErrorResponseInput,
} from '@/core/security/http-response';
