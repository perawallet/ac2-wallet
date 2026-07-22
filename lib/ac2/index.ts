/**
 * AC2 controller surface. Entry points for the wallet-side of the AC2
 * protocol (transport pairing + SDK client wiring).
 */

export { createAc2Client } from './client';
export type { Ac2ClientSetup, CreateAc2ClientOptions } from './client';
export { describeSelectedCandidatePair, summarizeSelectedCandidatePair } from './connectionStats';
export type { SelectedCandidatePairSummary, StatsReportLike } from './connectionStats';
export {
  DEFAULT_THID,
  generateThid,
  sendConversationClose,
  sendConversationOpen,
} from './conversations';
export type { ConversationControllerOptions } from './conversations';
export { attachHeartbeatChannel } from './heartbeat';
export type { HeartbeatChannelOptions } from './heartbeat';
export { createHeartbeatMonitor } from './heartbeatMonitor';
export type { HeartbeatMonitor, HeartbeatMonitorOptions } from './heartbeatMonitor';
export { monitorPeerConnection } from './peerConnectionMonitor';
export type {
  MonitoredPeerConnection,
  MonitorPeerConnectionOptions,
  PeerConnectionFailureReason,
} from './peerConnectionMonitor';
export {
  hasPeerPresence,
  isPeerOffline,
  isPeerUnreachableError,
  normalizePresence,
  PRESENCE_EVENT,
  queryPresence,
  subscribeToPresence,
} from './presence';
export type { PresenceResult, PresenceSocket } from './presence';
export {
  isRegistrationBlockingNotice,
  normalizeNoticeFrame,
  parseStreamControlFrame,
  REGISTRATION_BLOCKING_NOTICE_CODES,
  selectConnectionNoticeForRequest,
  STX,
} from './stream';
export type {
  AgentPresence,
  ConnectionNotice,
  NoticeLevel,
  ScopedConnectionNotice,
  StreamControlFrame,
} from './stream';
export { createAc2Transport, waitForSignalSocketConnected } from './transport';
export type { Ac2TransportSetup, CreateAc2TransportOptions } from './transport';

export type { AC2BaseMessage as Ac2Message } from '@algorandfoundation/ac2-sdk/schema';
