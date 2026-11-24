import 'server-only';

export { CallDomainError, type CallDomainErrorOptions } from '@/modules/calls/call.errors';
export { CALL_MESSAGES } from '@/modules/calls/call.messages';
export {
  assertCallAuthorized,
  authorizeCallAction,
  type CallAction,
  type CallPolicyResource,
  type CallPolicyUser,
} from '@/modules/calls/call.policy';
export {
  CallRepository,
  type CallUserRecord,
  type SweptStaleCallRecord,
  type TerminatedBlockCallRecord,
} from '@/modules/calls/call.repository';
export {
  CALL_CALLEE_TIMEOUT_MIN_ELAPSED_MS,
  CALL_DECLINE_COOLDOWN_SECONDS,
  CALL_HEARTBEAT_STALE_MS,
  CALL_RING_TIMEOUT_MS,
  MAX_CALL_ICE_CANDIDATE_LENGTH,
  MAX_CALL_SDP_LENGTH,
  callActionInputSchema,
  callAnswerSignalSchema,
  callIceCandidateSignalSchema,
  callOfferSignalSchema,
  callPublicIdParamSchema,
  callSignalInputSchema,
  createCallInputSchema,
  iceServersInputSchema,
  type CallActionInput,
  type CallSignalInput,
  type CreateCallInput,
} from '@/modules/calls/call.schemas';
export {
  CallSignalingService,
  InMemoryCallDeclineCooldownStore,
  createCallSignalingService,
  getCallSignalingService,
  resetCallSignalingServiceForTesting,
  setCallSignalingServiceForTesting,
  type CallDeclineCooldownStore,
  type CallPeerDto,
  type CallSessionDto,
  type CallSignalingServiceDependencies,
  type PendingCallRealtimeDispatch,
} from '@/modules/calls/call-signaling.service';
