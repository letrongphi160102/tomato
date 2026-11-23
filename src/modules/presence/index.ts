export { PresenceDomainError, type PresenceDomainErrorOptions } from './presence.errors';
export { PRESENCE_MESSAGES } from './presence.messages';
export {
  assertPresenceAuthorized,
  authorizePresenceAction,
  canViewTargetPresence,
  type PresenceAction,
  type PresencePolicyUser,
  type PresenceVisibilityContext,
} from './presence.policy';
export { PresenceRepository, type PresenceUserRecord } from './presence.repository';
export {
  PRESENCE_QUERY_MAX_IDS,
  presenceHeartbeatInputSchema,
  presenceQueryInputSchema,
  type PresenceQueryInput,
} from './presence.schemas';
export {
  PRESENCE_MAX_VISIBLE_AGE_MS,
  PRESENCE_ONLINE_THRESHOLD_MS,
  PRESENCE_REDIS_TTL_SECONDS,
  PresenceService,
  buildPresenceRedisKey,
  createPresenceService,
  formatCoarsePresenceStatus,
  getPresenceService,
  resetPresenceServiceForTesting,
  setPresenceServiceForTesting,
  type PresenceCoarseBucket,
  type PresenceHeartbeatResult,
  type PresenceQueryResult,
  type PresenceServiceDependencies,
  type PresenceStatusDto,
} from './presence.service';
