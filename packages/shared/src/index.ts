export type DependencyState = 'available' | 'unavailable' | 'disabled' | 'fake';

export interface UserView {
  id: string;
  displayName: string;
  email: string;
}
export interface CurrentUserView extends UserView {
  memberships: { id: string; organizationId: string; role: string }[];
}
export interface OrganizationView {
  id: string;
  name: string;
  timezone: string;
  version: number;
  aiEnabled: boolean;
}
export interface MembershipView {
  id: string;
  userId: string;
  displayName: string;
  role: string;
  status: string;
  availability: string;
  online: boolean;
  readingLanguage: string;
  version: number;
}
export interface PresenceHeartbeat {
  serverTime: string;
  onlineUntil: string;
}
export interface ConversationEventView {
  id: string;
  type: string;
  actorType: string | null;
  actorId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  fromAssignee: string | null;
  toAssignee: string | null;
  reason: string | null;
  version: number;
  createdAt: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ConversationNoteView {
  id: string;
  conversationId: string;
  authorMembershipId: string;
  clientNoteId: string;
  content: string;
  createdAt: string;
}
export interface ApiEnvelope<T> {
  data: T;
  requestId: string;
}

export interface VisitorCustomerView {
  id: string;
  name: string | null;
  email: string | null;
  preferredLanguage: string;
  version: number;
}
export interface WidgetPublicView {
  publicKey: string;
  welcomeText: string;
  defaultLanguage: string;
  iframeUrl: string;
}
export interface VisitorBootstrap {
  visitorToken?: string;
  expiresAt: string;
  customer: VisitorCustomerView;
  widget: WidgetPublicView;
  identityReset: boolean;
}

export type ConversationStatus =
  'ai_active' | 'waiting_human' | 'human_active' | 'closed';
export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderType: 'visitor' | 'agent' | 'ai' | 'system';
  clientMessageId: string;
  seq: number;
  content: string;
  createdAt: string;
  conversationVersion: number;
}
export interface MessagePage {
  items: Message[];
  mode: 'latest' | 'before' | 'after';
  snapshotThroughSeq: number;
  windowStartSeq: number | null;
  nextCursor: string | null;
  hasMore: boolean;
}
export interface ConversationView {
  id: string;
  customer: {
    id: string;
    name: string | null;
    email: string | null;
    preferredLanguage: string;
  };
  status: ConversationStatus;
  assignedMembershipId: string | null;
  version: number;
  lastSeq: number;
  lastVisitorSeq: number;
  lastMessageSummary: string | null;
  updatedAt: string;
  firstHandoffAt: string | null;
  handoffReason: string | null;
  closedAt: string | null;
  resolution: string | null;
  unreadCount?: number;
}

export interface Readiness {
  service: 'api' | 'worker';
  status: 'ready' | 'degraded' | 'not_ready';
  dependencies: {
    database: DependencyState;
    redis: DependencyState;
    ai: DependencyState;
  };
}

export type SocketAck<T> =
  | { ok: true; data: T; requestId: string }
  | { ok: false; error: { code: string; message: string }; requestId: string };
export interface RealtimeEvent<T = unknown> {
  eventId: string;
  type: string;
  occurredAt: string;
  data: T;
}
export interface SubscriptionSnapshot {
  conversationVersion: number;
  snapshotThroughSeq: number;
}
