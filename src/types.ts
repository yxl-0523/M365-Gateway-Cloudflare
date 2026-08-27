import type { ChatSession } from "./chat-session";
import type { TenantState } from "./tenant-state";

export interface Env {
  ASSETS: Fetcher;
  TENANTS: DurableObjectNamespace<TenantState>;
  CHATS: DurableObjectNamespace<ChatSession>;
  SENSITIVE_KV: KVNamespace;
  DATA_ENCRYPTION_KEY: string;
  ENVIRONMENT: string;
  TENANT_NAME: string;
  BOOTSTRAP_ADMIN_PASSWORD: string;
  MAX_ACCOUNTS: string;
  M365_CLIENT_ID: string;
  M365_AUTHORITY: string;
  M365_REDIRECT_URI: string;
  M365_SCOPE: string;
  /** Optional and fail-closed. Present only on a disposable 0% candidate. */
  MIGRATION_ENABLED?: string;
  MIGRATION_CANDIDATE_TAG?: string;
  MIGRATION_SIGNING_KEY?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** HTTPS origins for the fixed-target WebSocket relays on server 5 and 7. */
  RELAY5_URL?: string;
  RELAY7_URL?: string;
  RELAY5_HMAC_SECRET?: string;
  RELAY7_HMAC_SECRET?: string;
  RELAY_ORIGIN?: string;
}

export type AccountEgress = "direct" | "relay5" | "relay7";

export interface PublicAccount {
  id: string;
  email: string;
  displayName: string;
  sequence: number;
  /** Named egress policy only; relay credentials never enter public metadata. */
  egress: AccountEgress;
  /** True only for the one account allowed to serve new upstream work. */
  active: boolean;
  /** Routing isolation; distinct from health isolation after an auth failure. */
  isolated: boolean;
  status: "online" | "expired" | "cooldown" | "isolated";
  /** Access-token lifecycle. Standby accounts retain refresh tokens but are not decrypted until promoted. */
  tokenState: "valid" | "refresh_due" | "retry_scheduled" | "standby" | "auth_failed" | "isolated";
  /** Next proactive refresh attempt for the active account; null for standby accounts. */
  refreshScheduledAt: string | null;
  health: "healthy" | "cooldown" | "isolated";
  cooldownUntil: string | null;
  failureKind: "" | "rate_limit" | "transient" | "auth" | "permanent";
  requestCount: number;
  errorCount: number;
  tokenIn: number;
  tokenOut: number;
  lastRequestAt: string | null;
  expiresAt: string;
  updatedAt: string;
}

export interface RequestMetricInput {
  /** Internally generated opaque ID used to make accounting idempotent. */
  requestId: string;
  /** Final account selected for this request. Empty when routing never began. */
  accountId?: string | null;
  /** HTTP status visible to the client, which can still be 200 for an SSE error. */
  status: number;
  /** Protocol-level terminal state, independent of the HTTP status. */
  semanticStatus?: RequestSemanticStatus;
  /** Privacy-safe gateway error code, never an upstream message. */
  code?: string;
  /** End-to-end time through the real terminal event, not Response construction. */
  durationMs?: number;
  tokenIn?: number;
  tokenOut?: number;
}

export type RequestSemanticStatus = "complete" | "error" | "cancel";

/**
 * Bounded, privacy-safe terminal record. `accountRef` is a one-way hash and
 * never the Microsoft account email/oid supplied to the routing layer.
 */
export interface RequestMetricRecord {
  recordedAt: string;
  accountRef: string | null;
  httpStatus: number;
  semanticStatus: RequestSemanticStatus;
  durationMs: number;
  tokenIn: number;
  tokenOut: number;
}

export interface GatewayStats {
  totalRequestCount: number;
  totalErrorCount: number;
  totalTokenIn: number;
  totalTokenOut: number;
  lastRequestAt: string | null;
}

export interface DiagnosticInput {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  code?: string;
}

export interface DiagnosticRecord {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  method: string;
  path: string;
  status: number;
  durationMs: number;
  code: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
  displayName: string;
  oid: string;
  tid: string;
}
