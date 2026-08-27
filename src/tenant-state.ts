import { DurableObject } from "cloudflare:workers";
import { classifyAccountFailure } from "./account-routing";
import { decryptJSON, encryptJSON, passwordRecord, randomToken, sha256, verifyPassword } from "./crypto";
import { refreshToken } from "./oauth";
import type { MigratedAccountInput } from "./migration";
import type {
  AccountEgress,
  DiagnosticInput,
  DiagnosticRecord,
  Env,
  GatewayStats,
  OAuthTokenSet,
  PublicAccount,
  RequestMetricInput,
  RequestMetricRecord,
  RequestSemanticStatus,
} from "./types";

interface AccountRow {
  [key: string]: SqlStorageValue;
  id: string;
  email: string;
  display_name: string;
  expires_at: number;
  updated_at: number;
  token_cipher: string;
  credential_revision: number;
  credential_kv_key: string;
  sequence_no: number;
  egress_type: string;
  health_state: string;
  cooldown_until: number;
  failure_kind: string;
  request_count: number;
  error_count: number;
  token_in: number;
  token_out: number;
  last_request_at: number;
}

interface CredentialMirrorRow {
  [key: string]: SqlStorageValue;
  account_id: string;
  kv_key: string;
  revision: number;
  token_cipher: string;
  attempt_count: number;
  next_attempt_at: number;
}

interface CredentialDeletionRow {
  [key: string]: SqlStorageValue;
  account_id: string;
  kv_key: string;
  attempt_count: number;
  next_attempt_at: number;
}

interface GatewayStatsRow {
  [key: string]: SqlStorageValue;
  request_count: number;
  error_count: number;
  token_in: number;
  token_out: number;
  last_request_at: number;
}

interface DiagnosticRow {
  [key: string]: SqlStorageValue;
  request_id: string;
  at: number;
  level: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  code: string;
}

interface RequestMetricRow {
  [key: string]: SqlStorageValue;
  recorded_at: number;
  account_ref: string;
  http_status: number;
  semantic_status: string;
  duration_ms: number;
  token_in: number;
  token_out: number;
}

interface APIKeyRow {
  [key: string]: SqlStorageValue;
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  revoked: number;
}

export const MAX_API_KEY_NAME_CHARACTERS = 100;
export const MAX_API_KEY_VALIDITY_DAYS = 3_650;
const API_KEY_LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface UpstreamLease {
  ok: boolean;
  leaseId: string;
  retryAfterMs: number;
}

export type AccountFailureKind = "rate_limit" | "transient" | "auth" | "permanent";

export interface AccountSelection {
  accountId: string;
  sequence: number;
  egress: AccountEgress;
  /** Persisted routing generation. Useful to reject stale failure reports. */
  routeEpoch: number;
  token: OAuthTokenSet;
}

interface ActiveAccountRoute {
  accountId: string;
  epoch: number;
}

export interface AccountMigrationResult {
  migrationId: string;
  importedCount: number;
  activeSequence: number;
  replayed: boolean;
}

export interface AccountAvailability {
  available: boolean;
  retryAfterMs: number;
  isolated: boolean;
}

export interface AccountPoolStatus {
  total: number;
  available: number;
  cooling: number;
  isolated: number;
  retryAfterMs: number;
}

const UPSTREAM_LEASE_MS = 11 * 60_000;
const UPSTREAM_MIN_INTERVAL_MS = 1_000;
const MAX_DIAGNOSTIC_RECORDS = 200;
const MAX_RECORDED_REQUEST_IDS = 4_096;
const MAX_METRIC_TOKENS = 1_000_000_000;
const MAX_DIAGNOSTIC_DURATION_MS = 60 * 60_000;
const CREDENTIAL_MIRROR_BATCH_SIZE = 32;
const CREDENTIAL_MIRROR_RETRY_MIN_MS = 1_000;
const CREDENTIAL_MIRROR_RETRY_MAX_MS = 10 * 60_000;
/** Refresh early enough that normal request latency never depends on an already-expired access token. */
export const ACTIVE_TOKEN_REFRESH_ADVANCE_MS = 5 * 60_000;
const TOKEN_REFRESH_RETRY_MIN_MS = 30_000;
const TOKEN_REFRESH_RETRY_MAX_MS = 10 * 60_000;

function boundedInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(maximum, Math.trunc(value)));
}

function safeSemanticStatus(value: unknown, httpStatus: number): RequestSemanticStatus {
  if (value === "complete" || value === "error" || value === "cancel") return value;
  return httpStatus >= 400 ? "error" : "complete";
}

function safeDiagnosticMethod(value: string): string {
  const method = value.trim().toUpperCase();
  return /^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/u.test(method) ? method : "OTHER";
}

function safeDiagnosticPath(value: string): string {
  const pathname = value.split(/[?#]/u, 1)[0].slice(0, 160);
  if (!pathname.startsWith("/") || !/^\/[A-Za-z0-9_./:{}-]*$/u.test(pathname)) return "/redacted";
  return pathname || "/";
}

function safeDiagnosticIdentifier(value: string, maximum: number, fallback = "redacted"): string {
  const identifier = value.trim().slice(0, maximum);
  return identifier && /^[A-Za-z0-9_.:-]+$/u.test(identifier) ? identifier : fallback;
}

export class TenantState extends DurableObject<Env> {
  private readonly refreshInFlight = new Map<string, Promise<OAuthTokenSet>>();
  private readonly credentialMirrorInFlight = new Map<string, Promise<void>>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private async migrate(): Promise<void> {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_failures (
        address TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        verifier_cipher TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        token_cipher TEXT NOT NULL,
        credential_revision INTEGER NOT NULL DEFAULT 0,
        credential_kv_key TEXT NOT NULL DEFAULT '',
        sequence_no INTEGER NOT NULL DEFAULT 0,
        egress_type TEXT NOT NULL DEFAULT 'direct'
      );
      CREATE TABLE IF NOT EXISTS credential_mirror_queue (
        account_id TEXT PRIMARY KEY,
        kv_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_mirror_deletions (
        account_id TEXT PRIMARY KEY,
        kv_key TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_migration_nonces (
        nonce_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_migration_receipts (
        migration_id TEXT PRIMARY KEY,
        body_hash TEXT NOT NULL,
        imported_count INTEGER NOT NULL,
        active_sequence INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS upstream_gates (
        account_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        next_allowed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS upstream_gate_waiters (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        waiter_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(account_id,waiter_id)
      );
      CREATE TABLE IF NOT EXISTS account_health (
        account_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'healthy',
        failure_kind TEXT NOT NULL DEFAULT '',
        failure_count INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        last_failure_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_totals (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count>=0),
        error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count>=0),
        token_in INTEGER NOT NULL DEFAULT 0 CHECK(token_in>=0),
        token_out INTEGER NOT NULL DEFAULT 0 CHECK(token_out>=0),
        last_request_at INTEGER NOT NULL DEFAULT 0 CHECK(last_request_at>=0)
      );
      CREATE TABLE IF NOT EXISTS account_request_stats (
        account_id TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count>=0),
        error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count>=0),
        token_in INTEGER NOT NULL DEFAULT 0 CHECK(token_in>=0),
        token_out INTEGER NOT NULL DEFAULT 0 CHECK(token_out>=0),
        last_request_at INTEGER NOT NULL DEFAULT 0 CHECK(last_request_at>=0)
      );
      CREATE TABLE IF NOT EXISTS recorded_request_metrics (
        request_hash TEXT PRIMARY KEY,
        recorded_at INTEGER NOT NULL,
        account_ref TEXT NOT NULL DEFAULT '',
        http_status INTEGER NOT NULL DEFAULT 0,
        semantic_status TEXT NOT NULL DEFAULT 'complete',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        token_in INTEGER NOT NULL DEFAULT 0,
        token_out INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS diagnostic_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        level TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        code TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_states_created ON oauth_states(created_at);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_account_health_cooldown ON account_health(state,cooldown_until);
      CREATE INDEX IF NOT EXISTS idx_upstream_gate_waiters_fifo ON upstream_gate_waiters(account_id,sequence);
      CREATE INDEX IF NOT EXISTS idx_upstream_gate_waiters_expiry ON upstream_gate_waiters(expires_at);
      CREATE INDEX IF NOT EXISTS idx_diagnostic_events_at ON diagnostic_events(at DESC);
      CREATE INDEX IF NOT EXISTS idx_recorded_request_metrics_at ON recorded_request_metrics(recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_credential_mirror_retry ON credential_mirror_queue(next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_credential_delete_retry ON credential_mirror_deletions(next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_account_migration_nonces_expiry ON account_migration_nonces(expires_at);
    `);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO request_totals(singleton) VALUES(1)");
    const accountColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(accounts)").toArray().map((column) => column.name));
    if (!accountColumns.has("sequence_no")) this.ctx.storage.sql.exec("ALTER TABLE accounts ADD COLUMN sequence_no INTEGER NOT NULL DEFAULT 0");
    if (!accountColumns.has("credential_revision")) this.ctx.storage.sql.exec("ALTER TABLE accounts ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0");
    if (!accountColumns.has("credential_kv_key")) this.ctx.storage.sql.exec("ALTER TABLE accounts ADD COLUMN credential_kv_key TEXT NOT NULL DEFAULT ''");
    if (!accountColumns.has("egress_type")) this.ctx.storage.sql.exec("ALTER TABLE accounts ADD COLUMN egress_type TEXT NOT NULL DEFAULT 'direct'");
    const metricColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(recorded_request_metrics)").toArray().map((column) => column.name));
    if (!metricColumns.has("account_ref")) this.ctx.storage.sql.exec("ALTER TABLE recorded_request_metrics ADD COLUMN account_ref TEXT NOT NULL DEFAULT ''");
    if (!metricColumns.has("http_status")) this.ctx.storage.sql.exec("ALTER TABLE recorded_request_metrics ADD COLUMN http_status INTEGER NOT NULL DEFAULT 0");
    if (!metricColumns.has("semantic_status")) this.ctx.storage.sql.exec("ALTER TABLE recorded_request_metrics ADD COLUMN semantic_status TEXT NOT NULL DEFAULT 'complete'");
    if (!metricColumns.has("duration_ms")) this.ctx.storage.sql.exec("ALTER TABLE recorded_request_metrics ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0");
    if (!metricColumns.has("token_in")) this.ctx.storage.sql.exec("ALTER TABLE recorded_request_metrics ADD COLUMN token_in INTEGER NOT NULL DEFAULT 0");
    if (!metricColumns.has("token_out")) this.ctx.storage.sql.exec("ALTER TABLE recorded_request_metrics ADD COLUMN token_out INTEGER NOT NULL DEFAULT 0");
    const apiKeyColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(api_keys)").toArray().map((column) => column.name));
    if (!apiKeyColumns.has("last_used_at")) this.ctx.storage.sql.exec("ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_accounts_sequence ON accounts(sequence_no)");
    let nextSequence = Number.parseInt(this.meta("account_sequence_counter") ?? "0", 10) || 0;
    const maxSequence = this.ctx.storage.sql.exec<{ value: number }>("SELECT COALESCE(MAX(sequence_no),0) AS value FROM accounts").one().value;
    nextSequence = Math.max(nextSequence, maxSequence);
    for (const row of this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM accounts WHERE sequence_no=0 ORDER BY rowid,id").toArray()) {
      nextSequence += 1;
      this.ctx.storage.sql.exec("UPDATE accounts SET sequence_no=? WHERE id=?", nextSequence, row.id);
    }
    this.setMeta("account_sequence_counter", String(nextSequence));
    this.ensureActiveAccountRoute();
    const pendingMirrors = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT (SELECT COUNT(*) FROM credential_mirror_queue)+(SELECT COUNT(*) FROM credential_mirror_deletions) AS count",
    ).one().count;
    if (pendingMirrors > 0) await this.armCredentialMirrorRetry();
    await this.scheduleNextAlarm();
  }

  private meta(key: string): string | undefined {
    return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }

  private activeAccountRoute(): ActiveAccountRoute {
    return {
      accountId: this.meta("active_account_id")?.trim() ?? "",
      epoch: Math.max(0, Number.parseInt(this.meta("active_account_epoch") ?? "0", 10) || 0),
    };
  }

  private orderedAvailableAccounts(afterSequence = Number.NEGATIVE_INFINITY): Array<{ id: string; sequence_no: number }> {
    const rows = this.ctx.storage.sql.exec<{ id: string; sequence_no: number }>(
      "SELECT id,sequence_no FROM accounts ORDER BY sequence_no,id",
    ).toArray().filter((row) => this.accountAvailabilityRow(row.id).available);
    if (rows.length === 0) return [];
    const after = rows.filter((row) => row.sequence_no > afterSequence);
    const wrapped = rows.filter((row) => row.sequence_no <= afterSequence);
    return [...after, ...wrapped];
  }

  /**
   * Recover routing state entirely from persisted SQL/meta state. The active
   * account is never held only in memory, so a Durable Object eviction cannot
   * reset ordering or expose a sleeping credential.
   */
  private ensureActiveAccountRoute(): ActiveAccountRoute {
    const current = this.activeAccountRoute();
    const currentExists = current.accountId && this.ctx.storage.sql.exec<{ found: number }>(
      "SELECT 1 AS found FROM accounts WHERE id=?",
      current.accountId,
    ).toArray()[0];
    if (currentExists && this.accountAvailabilityRow(current.accountId).available) return current;
    const selected = this.orderedAvailableAccounts()[0];
    const next: ActiveAccountRoute = {
      accountId: selected?.id ?? "",
      epoch: current.epoch + (selected?.id === current.accountId ? 0 : 1),
    };
    this.setMeta("active_account_id", next.accountId);
    this.setMeta("active_account_epoch", String(next.epoch));
    return next;
  }

  /**
   * Compare-and-swap the global active account. A late failure for an account
   * that is no longer active is deliberately a no-op, preventing a burst of
   * identical failures from skipping several accounts.
   */
  private advanceActiveAccount(expectedAccountId: string, expectedEpoch?: number): ActiveAccountRoute {
    const current = this.activeAccountRoute();
    if (current.accountId !== expectedAccountId || (expectedEpoch !== undefined && current.epoch !== expectedEpoch)) {
      return current;
    }
    const sequence = this.ctx.storage.sql.exec<{ sequence_no: number }>(
      "SELECT sequence_no FROM accounts WHERE id=?",
      expectedAccountId,
    ).toArray()[0]?.sequence_no ?? Number.NEGATIVE_INFINITY;
    const replacement = this.orderedAvailableAccounts(sequence).find((row) => row.id !== expectedAccountId);
    const next = { accountId: replacement?.id ?? "", epoch: current.epoch + 1 };
    this.setMeta("active_account_id", next.accountId);
    this.setMeta("active_account_epoch", String(next.epoch));
    return next;
  }

  private async readLegacyAccountCredential(key: string): Promise<string | null> {
    // Only legacy `kv:` rows need a KV read. New and migrated accounts always
    // read their ciphertext from the strongly-consistent Durable Object.
    for (const delay of [0, 50, 150, 400]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const encrypted = await this.env.SENSITIVE_KV.get(key);
      if (encrypted) return encrypted;
    }
    return null;
  }

  private async decryptAccountCredential(payload: string, row: Pick<AccountRow, "id" | "email">): Promise<OAuthTokenSet> {
    try {
      const token = await decryptJSON<OAuthTokenSet>(payload, this.env.DATA_ENCRYPTION_KEY);
      const hasShape = token
        && typeof token.accessToken === "string"
        && token.accessToken.length > 0
        && typeof token.refreshToken === "string"
        && typeof token.expiresAt === "number"
        && Number.isFinite(token.expiresAt)
        && token.expiresAt > 0
        && typeof token.email === "string"
        && typeof token.displayName === "string"
        && typeof token.oid === "string"
        && typeof token.tid === "string"
        && token.tid.length > 0;
      const identityMatches = token
        && ((token.oid.length > 0 && token.oid === row.id)
          || (token.email.length > 0 && token.email.toLowerCase() === row.email.toLowerCase()));
      if (!hasShape || !identityMatches) throw new Error("INVALID_ACCOUNT_CREDENTIAL_SHAPE");
      return token;
    } catch {
      // Do not expose AES/WebCrypto errors or decrypted identity details.
      throw new Error("ACCOUNT_CREDENTIAL_CORRUPT");
    }
  }

  private credentialMirrorDelay(attemptCount: number): number {
    return Math.min(
      CREDENTIAL_MIRROR_RETRY_MAX_MS,
      CREDENTIAL_MIRROR_RETRY_MIN_MS * 2 ** Math.min(9, Math.max(0, attemptCount - 1)),
    );
  }

  private activeTokenRefreshSchedule(now = Date.now()): { accountId: string; at: number; retryScheduled: boolean } | null {
    const route = this.ensureActiveAccountRoute();
    if (!route.accountId) return null;
    const row = this.ctx.storage.sql.exec<{ expires_at: number }>(
      "SELECT expires_at FROM accounts WHERE id=?",
      route.accountId,
    ).toArray()[0];
    if (!row) return null;
    const retryAccountId = this.meta("token_refresh_retry_account_id")?.trim() ?? "";
    const retryAt = Math.max(0, Number.parseInt(this.meta("token_refresh_retry_at") ?? "0", 10) || 0);
    const retryScheduled = retryAccountId === route.accountId && retryAt > now;
    const desired = retryScheduled ? retryAt : row.expires_at - ACTIVE_TOKEN_REFRESH_ADVANCE_MS;
    return { accountId: route.accountId, at: Math.max(now + CREDENTIAL_MIRROR_RETRY_MIN_MS, desired), retryScheduled };
  }

  private clearTokenRefreshRetry(accountId: string): void {
    if ((this.meta("token_refresh_retry_account_id")?.trim() ?? "") !== accountId) return;
    this.setMeta("token_refresh_retry_account_id", "");
    this.setMeta("token_refresh_retry_at", "0");
    this.setMeta("token_refresh_retry_count", "0");
  }

  private async deferTokenRefresh(accountId: string): Promise<void> {
    if (this.activeAccountRoute().accountId !== accountId) return;
    const previousAccountId = this.meta("token_refresh_retry_account_id")?.trim() ?? "";
    const previousCount = previousAccountId === accountId
      ? Math.max(0, Number.parseInt(this.meta("token_refresh_retry_count") ?? "0", 10) || 0)
      : 0;
    const count = Math.min(1_000_000, previousCount + 1);
    const delay = Math.min(TOKEN_REFRESH_RETRY_MAX_MS, TOKEN_REFRESH_RETRY_MIN_MS * 2 ** Math.min(8, count - 1));
    this.setMeta("token_refresh_retry_account_id", accountId);
    this.setMeta("token_refresh_retry_at", String(Date.now() + delay));
    this.setMeta("token_refresh_retry_count", String(count));
    console.warn(JSON.stringify({ event: "active_token_refresh_deferred", retryInMs: delay }));
    await this.scheduleNextAlarm();
  }

  /** One Durable Object alarm owns both credential-mirror retries and proactive active-token renewal. */
  private async scheduleNextAlarm(): Promise<void> {
    try {
      const row = this.ctx.storage.sql.exec<{ next_attempt_at: number | null }>(
        `SELECT MIN(next_attempt_at) AS next_attempt_at FROM (
           SELECT next_attempt_at FROM credential_mirror_queue
           UNION ALL
           SELECT next_attempt_at FROM credential_mirror_deletions
         )`,
      ).one();
      const now = Date.now();
      const mirrorAt = row.next_attempt_at === null
        ? null
        : Math.max(now + CREDENTIAL_MIRROR_RETRY_MIN_MS, row.next_attempt_at);
      const tokenAt = this.activeTokenRefreshSchedule(now)?.at ?? null;
      const desired = mirrorAt === null ? tokenAt : tokenAt === null ? mirrorAt : Math.min(mirrorAt, tokenAt);
      if (desired === null) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const current = await this.ctx.storage.getAlarm();
      if (current === null || Math.abs(current - desired) > 500) await this.ctx.storage.setAlarm(desired);
    } catch {
      console.warn(JSON.stringify({ event: "tenant_maintenance_alarm_deferred" }));
    }
  }

  private async armCredentialMirrorRetry(): Promise<void> {
    try {
      await this.ctx.storage.setAlarm(Date.now() + CREDENTIAL_MIRROR_RETRY_MIN_MS);
    } catch {
      // The queue is durable and migrate() re-arms it after object eviction.
      // Keep the already-committed credential usable even if alarm setup has
      // a transient platform failure.
      console.warn(JSON.stringify({ event: "credential_mirror_alarm_deferred" }));
    }
  }

  private async deferCredentialMirror(
    table: "credential_mirror_queue" | "credential_mirror_deletions",
    accountId: string,
    expectedRevision?: number,
  ): Promise<void> {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ attempt_count: number }>(
      `SELECT attempt_count FROM ${table} WHERE account_id=?`,
      accountId,
    ).toArray()[0];
    if (!row) return;
    const attempts = Math.min(1_000_000, row.attempt_count + 1);
    const condition = expectedRevision === undefined ? "" : " AND revision=?";
    const values: (string | number)[] = [attempts, now + this.credentialMirrorDelay(attempts), now, accountId];
    if (expectedRevision !== undefined) values.push(expectedRevision);
    this.ctx.storage.sql.exec(
      `UPDATE ${table} SET attempt_count=?,next_attempt_at=?,updated_at=? WHERE account_id=?${condition}`,
      ...values,
    );
    console.warn(JSON.stringify({ event: "credential_mirror_deferred", operation: table === "credential_mirror_queue" ? "put" : "delete" }));
    await this.scheduleNextAlarm();
  }

  private async flushCredentialMirror(accountId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<CredentialMirrorRow>(
      `SELECT q.account_id,q.kv_key,q.revision,q.attempt_count,q.next_attempt_at,a.token_cipher
       FROM credential_mirror_queue q JOIN accounts a ON a.id=q.account_id
       WHERE q.account_id=? AND a.credential_revision=q.revision`,
      accountId,
    ).toArray()[0];
    if (!row) {
      this.ctx.storage.sql.exec(
        `DELETE FROM credential_mirror_queue WHERE account_id=?
         AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=? AND credential_revision=credential_mirror_queue.revision)`,
        accountId,
        accountId,
      );
      return;
    }
    try {
      await this.env.SENSITIVE_KV.put(row.kv_key, row.token_cipher, {
        metadata: { schema: 2, kind: "m365_oauth_token", revision: row.revision },
      });
      this.ctx.storage.sql.exec(
        "DELETE FROM credential_mirror_queue WHERE account_id=? AND revision=?",
        row.account_id,
        row.revision,
      );
    } catch {
      await this.deferCredentialMirror("credential_mirror_queue", row.account_id, row.revision);
    }
  }

  private async flushCredentialDeletion(accountId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<CredentialDeletionRow>(
      "SELECT account_id,kv_key,attempt_count,next_attempt_at FROM credential_mirror_deletions WHERE account_id=?",
      accountId,
    ).toArray()[0];
    if (!row) return;
    if (this.ctx.storage.sql.exec<{ found: number }>("SELECT 1 AS found FROM accounts WHERE id=?", accountId).toArray()[0]) {
      // The account was re-authorized before an old mirror delete completed.
      // Its newer mirror must win; never let delayed cleanup remove a live key.
      this.ctx.storage.sql.exec("DELETE FROM credential_mirror_deletions WHERE account_id=?", accountId);
      return;
    }
    try {
      await this.env.SENSITIVE_KV.delete(row.kv_key);
      this.ctx.storage.sql.exec("DELETE FROM credential_mirror_deletions WHERE account_id=?", accountId);
    } catch {
      await this.deferCredentialMirror("credential_mirror_deletions", row.account_id);
    }
  }

  private async enqueueCredentialMirrorOperation(accountId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.credentialMirrorInFlight.get(accountId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.credentialMirrorInFlight.set(accountId, current);
    try {
      await current;
    } catch {
      // The authoritative ciphertext has already committed. Never turn a KV
      // mirror fault into an ambiguous OAuth failure after that commit.
      console.warn(JSON.stringify({ event: "credential_mirror_internal_error" }));
      try {
        await this.scheduleNextAlarm();
      } catch {
        // A future object activation also schedules any persisted queue rows.
      }
    } finally {
      if (this.credentialMirrorInFlight.get(accountId) === current) this.credentialMirrorInFlight.delete(accountId);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const mirrors = this.ctx.storage.sql.exec<{ account_id: string }>(
      "SELECT account_id FROM credential_mirror_queue WHERE next_attempt_at<=? ORDER BY next_attempt_at,account_id LIMIT ?",
      now,
      CREDENTIAL_MIRROR_BATCH_SIZE,
    ).toArray();
    const deletions = this.ctx.storage.sql.exec<{ account_id: string }>(
      "SELECT account_id FROM credential_mirror_deletions WHERE next_attempt_at<=? ORDER BY next_attempt_at,account_id LIMIT ?",
      now,
      CREDENTIAL_MIRROR_BATCH_SIZE,
    ).toArray();
    for (const row of deletions) {
      await this.enqueueCredentialMirrorOperation(row.account_id, () => this.flushCredentialDeletion(row.account_id));
    }
    for (const row of mirrors) {
      await this.enqueueCredentialMirrorOperation(row.account_id, () => this.flushCredentialMirror(row.account_id));
    }
    const refresh = this.activeTokenRefreshSchedule(now);
    if (refresh && !refresh.retryScheduled && refresh.at <= now + CREDENTIAL_MIRROR_RETRY_MIN_MS) {
      try {
        await this.ensureValidAccount(refresh.accountId);
      } catch (cause) {
        // The refresh path persists an exponential retry. Alarms must complete
        // successfully so Cloudflare does not apply a second, opaque retry loop.
        const disposition = classifyAccountFailure(cause);
        if (disposition?.kind === "auth" || disposition?.kind === "permanent") {
          await this.reportAccountFailure(refresh.accountId, disposition.kind);
        }
        console.warn(JSON.stringify({
          event: "active_token_refresh_alarm_failed",
          code: cause instanceof Error ? cause.message : "TOKEN_REFRESH_FAILED",
        }));
      }
    }
    await this.scheduleNextAlarm();
  }

  private async ensureAdmin(): Promise<void> {
    if (this.meta("admin_password")) return;
    const bootstrapPassword = this.env.BOOTSTRAP_ADMIN_PASSWORD?.trim() ?? "";
    if (bootstrapPassword.length < 12) throw new Error("BOOTSTRAP_ADMIN_PASSWORD_REQUIRED");
    this.setMeta("admin_password", await passwordRecord(bootstrapPassword));
    this.setMeta("must_change_password", "true");
  }

  private nextAccountSequence(): number {
    const current = Number.parseInt(this.meta("account_sequence_counter") ?? "0", 10) || 0;
    const next = current + 1;
    this.setMeta("account_sequence_counter", String(next));
    return next;
  }

  private accountAvailabilityRow(accountId: string): AccountAvailability {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ state: string; cooldown_until: number }>(
      "SELECT state,cooldown_until FROM account_health WHERE account_id=?",
      accountId,
    ).toArray()[0];
    if (row?.state === "isolated") return { available: false, retryAfterMs: 0, isolated: true };
    if ((row?.cooldown_until ?? 0) > now) {
      return { available: false, retryAfterMs: row.cooldown_until - now, isolated: false };
    }
    return { available: true, retryAfterMs: 0, isolated: false };
  }

  async accountAvailability(accountId: string): Promise<AccountAvailability> {
    const found = this.ctx.storage.sql.exec<{ found: number }>(
      "SELECT 1 AS found FROM accounts WHERE id=?",
      accountId,
    ).toArray()[0];
    if (!found) return { available: false, retryAfterMs: 0, isolated: true };
    return this.accountAvailabilityRow(accountId);
  }

  async accountPoolStatus(): Promise<AccountPoolStatus> {
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec<{ state: string; cooldown_until: number }>(
      `SELECT COALESCE(h.state,'healthy') AS state,COALESCE(h.cooldown_until,0) AS cooldown_until
       FROM accounts a LEFT JOIN account_health h ON h.account_id=a.id`,
    ).toArray();
    let available = 0;
    let cooling = 0;
    let isolated = 0;
    let earliestRetry = 0;
    for (const row of rows) {
      if (row.state === "isolated") {
        isolated += 1;
      } else if (row.cooldown_until > now) {
        cooling += 1;
        earliestRetry = earliestRetry ? Math.min(earliestRetry, row.cooldown_until) : row.cooldown_until;
      } else {
        available += 1;
      }
    }
    return {
      total: rows.length,
      available,
      cooling,
      isolated,
      retryAfterMs: earliestRetry ? Math.max(0, earliestRetry - now) : 0,
    };
  }

  async selectAccount(preferredAccountId = "", excludedAccountIds: string[] = []): Promise<AccountSelection | null> {
    const preferred = preferredAccountId.trim();
    const excluded = new Set(excludedAccountIds.slice(0, 128).map((id) => id.trim()).filter(Boolean));
    // One logical request may use the current active account and, after one
    // confirmed pre-submit account failure, its immediate successor. Never
    // expose a third account to the same request.
    if (!preferred && excluded.size >= 2) return null;
    const route = this.ensureActiveAccountRoute();
    if (!route.accountId || (preferred && preferred !== route.accountId) || excluded.has(route.accountId)) return null;
    const selected = this.ctx.storage.sql.exec<AccountRow>(
      "SELECT id,email,display_name,expires_at,updated_at,token_cipher,sequence_no,egress_type FROM accounts WHERE id=?",
      route.accountId,
    ).toArray()[0];
    if (!selected || !this.accountAvailabilityRow(selected.id).available) return null;
    try {
      const token = await this.ensureValidAccount(selected.id);
      if (!token) {
        await this.reportAccountFailure(selected.id, "permanent", route.epoch);
        return preferred ? null : this.selectAccount("", [...excluded, selected.id]);
      }
      // Credential decryption/refresh contains awaits. Re-check the persisted
      // generation so a concurrent failure cannot return a now-sleeping token.
      const current = this.activeAccountRoute();
      if (current.accountId !== selected.id || current.epoch !== route.epoch) return null;
      return {
        accountId: selected.id,
        sequence: selected.sequence_no,
        egress: this.safeEgress(selected.egress_type),
        routeEpoch: route.epoch,
        token,
      };
    } catch (cause) {
      const disposition = classifyAccountFailure(cause);
      if (!disposition) throw cause;
      await this.reportAccountFailure(selected.id, disposition.kind, route.epoch);
      if (preferred || !disposition.mayFailOverBeforeVisibleOutput) throw cause;
      return this.selectAccount("", [...excluded, selected.id]);
    }
  }

  async reportAccountFailure(accountId: string, kind: AccountFailureKind, expectedRouteEpoch?: number): Promise<AccountAvailability> {
    const id = accountId.trim();
    if (!id) throw new Error("ACCOUNT_ID_REQUIRED");
    const exists = this.ctx.storage.sql.exec<{ found: number }>("SELECT 1 AS found FROM accounts WHERE id=?", id).toArray()[0];
    if (!exists) return { available: false, retryAfterMs: 0, isolated: true };
    let routeChanged = false;
    const result = this.ctx.storage.transactionSync(() => {
      const route = this.ensureActiveAccountRoute();
      // Health and routing are one generation-scoped transaction. Mutating
      // health for a stale generation would make a later read advance even
      // though the CAS itself correctly rejected that failure.
      if (route.accountId !== id || (expectedRouteEpoch !== undefined && route.epoch !== expectedRouteEpoch)) {
        return this.accountAvailabilityRow(id);
      }
      const now = Date.now();
      const previous = this.ctx.storage.sql.exec<{ failure_kind: string; failure_count: number; last_failure_at: number }>(
        "SELECT failure_kind,failure_count,last_failure_at FROM account_health WHERE account_id=?",
        id,
      ).toArray()[0];
      const consecutive = previous?.failure_kind === kind && now - previous.last_failure_at < 24 * 60 * 60_000
        ? previous.failure_count + 1
        : 1;
      const isolated = kind === "auth" || kind === "permanent";
      const baseCooldown = kind === "rate_limit" ? 5 * 60_000 : 15_000;
      const maximumCooldown = kind === "rate_limit" ? 60 * 60_000 : 5 * 60_000;
      const cooldownUntil = isolated ? 0 : now + Math.min(maximumCooldown, baseCooldown * 2 ** Math.min(6, consecutive - 1));
      this.ctx.storage.sql.exec(
        `INSERT INTO account_health(account_id,state,failure_kind,failure_count,cooldown_until,last_failure_at,updated_at)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
         state=excluded.state,failure_kind=excluded.failure_kind,failure_count=excluded.failure_count,
         cooldown_until=excluded.cooldown_until,last_failure_at=excluded.last_failure_at,updated_at=excluded.updated_at`,
        id,
        isolated ? "isolated" : "cooldown",
        kind,
        consecutive,
        cooldownUntil,
        now,
        now,
      );
      const next = this.advanceActiveAccount(id, expectedRouteEpoch);
      routeChanged = next.accountId !== route.accountId || next.epoch !== route.epoch;
      return { available: false, retryAfterMs: isolated ? 0 : cooldownUntil - now, isolated };
    });
    if (routeChanged) await this.scheduleNextAlarm();
    return result;
  }

  async reportAccountSuccess(accountId: string, allowInactive = false): Promise<void> {
    const id = accountId.trim();
    if (!id) throw new Error("ACCOUNT_ID_REQUIRED");
    // A response from a retired account may arrive after a sibling request has
    // already switched the route. It must not erase the confirmed failure that
    // caused that switch. Re-authorization explicitly opts in below.
    if (!allowInactive && this.ensureActiveAccountRoute().accountId !== id) return;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO account_health(account_id,state,failure_kind,failure_count,cooldown_until,last_failure_at,updated_at)
       VALUES(?,'healthy','',0,0,0,?) ON CONFLICT(account_id) DO UPDATE SET
       state='healthy',failure_kind='',failure_count=0,cooldown_until=0,last_failure_at=0,updated_at=excluded.updated_at`,
      id,
      now,
    );
  }

  async acquireUpstream(accountId: string, waiterId = ""): Promise<UpstreamLease> {
    const id = accountId.trim();
    if (!id) throw new Error("ACCOUNT_ID_REQUIRED");
    const now = Date.now();
    const waiter = waiterId.trim();
    if (waiter && (waiter.length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(waiter))) throw new Error("INVALID_UPSTREAM_WAITER_ID");
    const stored = this.ctx.storage.sql.exec<{ found: number }>("SELECT 1 AS found FROM accounts WHERE id=?", id).toArray()[0];
    if (stored && this.ensureActiveAccountRoute().accountId !== id) throw new Error("ACCOUNT_NOT_ACTIVE");
    await this.expireUpstreamWaiters(now);
    if (waiter) {
      // A caller keeps the same waiter ID across polls. The globally serialized
      // TenantState object assigns insertion order exactly once, making this a
      // real FIFO queue instead of a timing race between polling requests.
      this.ctx.storage.sql.exec(
        `INSERT INTO upstream_gate_waiters(account_id,waiter_id,expires_at,created_at)
         VALUES(?,?,?,?) ON CONFLICT(account_id,waiter_id) DO UPDATE SET expires_at=excluded.expires_at`,
        id,
        waiter,
        now + 150_000,
        now,
      );
      const head = this.ctx.storage.sql.exec<{ waiter_id: string }>(
        "SELECT waiter_id FROM upstream_gate_waiters WHERE account_id=? ORDER BY sequence LIMIT 1",
        id,
      ).toArray()[0];
      if (head?.waiter_id !== waiter) return { ok: false, leaseId: "", retryAfterMs: 100 };
    } else {
      // Legacy/internal one-shot probes may observe the gate but must never
      // jump ahead of an already queued production request.
      const queued = this.ctx.storage.sql.exec<{ found: number }>(
        "SELECT 1 AS found FROM upstream_gate_waiters WHERE account_id=? LIMIT 1",
        id,
      ).toArray()[0];
      if (queued) return { ok: false, leaseId: "", retryAfterMs: 100 };
    }
    const row = this.ctx.storage.sql.exec<{ lease_id: string; lease_until: number; next_allowed_at: number }>(
      "SELECT lease_id,lease_until,next_allowed_at FROM upstream_gates WHERE account_id=?",
      id,
    ).toArray()[0];
    const blockedUntil = Math.max(row?.lease_until ?? 0, row?.next_allowed_at ?? 0);
    if ((Boolean(row?.lease_id) && (row?.lease_until ?? 0) > now) || blockedUntil > now) {
      return { ok: false, leaseId: "", retryAfterMs: Math.max(50, Math.min(1_000, blockedUntil - now)) };
    }
    const leaseId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO upstream_gates(account_id,lease_id,lease_until,next_allowed_at,updated_at)
       VALUES(?,?,?,0,?) ON CONFLICT(account_id) DO UPDATE SET
       lease_id=excluded.lease_id,lease_until=excluded.lease_until,updated_at=excluded.updated_at`,
      id,
      leaseId,
      now + UPSTREAM_LEASE_MS,
      now,
    );
    if (waiter) this.ctx.storage.sql.exec("DELETE FROM upstream_gate_waiters WHERE account_id=? AND waiter_id=?", id, waiter);
    return { ok: true, leaseId, retryAfterMs: 0 };
  }

  async cancelUpstreamWaiter(accountId: string, waiterId: string): Promise<void> {
    const id = accountId.trim();
    const waiter = waiterId.trim();
    if (!id || !waiter) return;
    this.ctx.storage.sql.exec("DELETE FROM upstream_gate_waiters WHERE account_id=? AND waiter_id=?", id, waiter);
  }

  async expireUpstreamWaiters(now = Date.now()): Promise<number> {
    const boundedNow = Number.isFinite(now) ? Math.max(0, Math.trunc(now)) : Date.now();
    return this.ctx.storage.sql.exec("DELETE FROM upstream_gate_waiters WHERE expires_at<=?", boundedNow).rowsWritten;
  }

  async releaseUpstream(accountId: string, leaseId: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE upstream_gates SET lease_id='',lease_until=0,next_allowed_at=?,updated_at=? WHERE account_id=? AND lease_id=?",
      now + UPSTREAM_MIN_INTERVAL_MS,
      now,
      accountId,
      leaseId,
    );
  }

  async recordRequest(input: RequestMetricInput): Promise<GatewayStats> {
    const rawRequestId = input.requestId.trim();
    if (!rawRequestId || rawRequestId.length > 128) throw new Error("REQUEST_ID_INVALID");
    const requestHash = await sha256(rawRequestId);
    const requestedAccountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
    // Only a current account row may become the final account attribution.
    // This prevents callers from persisting an email or arbitrary identifier
    // in the terminal metric table. Requests rejected before routing are still
    // counted globally with an empty account attribution.
    const found = requestedAccountId
      ? this.ctx.storage.sql.exec<{ found: number }>("SELECT 1 AS found FROM accounts WHERE id=?", requestedAccountId).toArray()[0]
      : undefined;
    const accountId = found ? requestedAccountId : "";
    const accountRef = accountId ? await sha256(`metric-account:${accountId}`) : "";

    const now = Date.now();
    const status = boundedInteger(input.status, 999);
    const semanticStatus = safeSemanticStatus(input.semanticStatus, status);
    const errorCount = status >= 400 || semanticStatus !== "complete" ? 1 : 0;
    const durationMs = boundedInteger(input.durationMs, MAX_DIAGNOSTIC_DURATION_MS);
    const tokenIn = boundedInteger(input.tokenIn, MAX_METRIC_TOKENS);
    const tokenOut = boundedInteger(input.tokenOut, MAX_METRIC_TOKENS);
    this.ctx.storage.transactionSync(() => {
      const accepted = this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO recorded_request_metrics(
          request_hash,recorded_at,account_ref,http_status,semantic_status,duration_ms,token_in,token_out
        ) VALUES(?,?,?,?,?,?,?,?)`,
        requestHash,
        now,
        accountRef,
        status,
        semanticStatus,
        durationMs,
        tokenIn,
        tokenOut,
      ).rowsWritten > 0;
      if (!accepted) return;
      this.ctx.storage.sql.exec(
        `UPDATE request_totals SET request_count=request_count+1,error_count=error_count+?,
         token_in=token_in+?,token_out=token_out+?,last_request_at=? WHERE singleton=1`,
        errorCount,
        tokenIn,
        tokenOut,
        now,
      );
      if (accountId) {
        this.ctx.storage.sql.exec(
          `INSERT INTO account_request_stats(account_id,request_count,error_count,token_in,token_out,last_request_at)
           VALUES(?,1,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
           request_count=request_count+1,error_count=error_count+excluded.error_count,
           token_in=token_in+excluded.token_in,token_out=token_out+excluded.token_out,
           last_request_at=excluded.last_request_at`,
          accountId,
          errorCount,
          tokenIn,
          tokenOut,
          now,
        );
      }
      this.ctx.storage.sql.exec(
        `DELETE FROM recorded_request_metrics WHERE request_hash NOT IN
         (SELECT request_hash FROM recorded_request_metrics ORDER BY recorded_at DESC LIMIT ?)`,
        MAX_RECORDED_REQUEST_IDS,
      );
    });
    return this.statsSnapshot();
  }

  async listRequestMetrics(limit = 100): Promise<RequestMetricRecord[]> {
    const boundedLimit = Math.max(1, Math.min(MAX_DIAGNOSTIC_RECORDS, Math.trunc(limit) || 100));
    return this.ctx.storage.sql.exec<RequestMetricRow>(
      `SELECT recorded_at,account_ref,http_status,semantic_status,duration_ms,token_in,token_out
       FROM recorded_request_metrics ORDER BY recorded_at DESC,rowid DESC LIMIT ?`,
      boundedLimit,
    ).toArray().map((row) => ({
      recordedAt: new Date(row.recorded_at).toISOString(),
      accountRef: row.account_ref || null,
      httpStatus: row.http_status,
      semanticStatus: safeSemanticStatus(row.semantic_status, row.http_status),
      durationMs: row.duration_ms,
      tokenIn: row.token_in,
      tokenOut: row.token_out,
    }));
  }

  async statsSnapshot(): Promise<GatewayStats> {
    const row = this.ctx.storage.sql.exec<GatewayStatsRow>(
      `SELECT request_count,error_count,token_in,token_out,last_request_at
       FROM request_totals WHERE singleton=1`,
    ).one();
    return {
      totalRequestCount: row.request_count,
      totalErrorCount: row.error_count,
      totalTokenIn: row.token_in,
      totalTokenOut: row.token_out,
      lastRequestAt: row.last_request_at > 0 ? new Date(row.last_request_at).toISOString() : null,
    };
  }

  async resetRequestStats(): Promise<GatewayStats> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE request_totals SET request_count=0,error_count=0,token_in=0,token_out=0,last_request_at=0 WHERE singleton=1",
      );
      this.ctx.storage.sql.exec("DELETE FROM account_request_stats");
      this.ctx.storage.sql.exec("DELETE FROM recorded_request_metrics");
    });
    return this.statsSnapshot();
  }

  async recordDiagnostic(input: DiagnosticInput): Promise<void> {
    const status = boundedInteger(input.status, 999);
    const diagnosticCode = safeDiagnosticIdentifier(input.code ?? "", 64, "");
    const level = status >= 500 || diagnosticCode.startsWith("terminal_error")
      ? "error"
      : status >= 400 || diagnosticCode.startsWith("terminal_cancel") ? "warn" : "info";
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO diagnostic_events(request_id,at,level,method,path,status,duration_ms,code)
         VALUES(?,?,?,?,?,?,?,?)`,
        safeDiagnosticIdentifier(input.requestId, 64),
        Date.now(),
        level,
        safeDiagnosticMethod(input.method),
        safeDiagnosticPath(input.path),
        status,
        boundedInteger(input.durationMs, MAX_DIAGNOSTIC_DURATION_MS),
        diagnosticCode,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM diagnostic_events WHERE sequence NOT IN
         (SELECT sequence FROM diagnostic_events ORDER BY sequence DESC LIMIT ?)`,
        MAX_DIAGNOSTIC_RECORDS,
      );
    });
  }

  async listDiagnostics(limit = 100): Promise<DiagnosticRecord[]> {
    const boundedLimit = Math.max(1, Math.min(MAX_DIAGNOSTIC_RECORDS, Math.trunc(limit) || 100));
    return this.ctx.storage.sql.exec<DiagnosticRow>(
      `SELECT request_id,at,level,method,path,status,duration_ms,code
       FROM diagnostic_events ORDER BY sequence DESC LIMIT ?`,
      boundedLimit,
    ).toArray().map((row) => ({
      id: row.request_id,
      at: new Date(row.at).toISOString(),
      level: row.level === "error" ? "error" : row.level === "warn" ? "warn" : "info",
      method: row.method,
      path: row.path,
      status: row.status,
      durationMs: row.duration_ms,
      code: row.code,
    }));
  }

  async login(password: string, address: string): Promise<
    | { ok: true; token: string; mustChangePassword: boolean }
    | { ok: false; error: "LOGIN_RATE_LIMITED" | "INVALID_ADMIN_PASSWORD" }
  > {
    await this.ensureAdmin();
    const now = Date.now();
    const failure = this.ctx.storage.sql.exec<{ failures: number; blocked_until: number }>(
      "SELECT failures,blocked_until FROM login_failures WHERE address = ?",
      address,
    ).toArray()[0];
    // Never lock the legitimate administrator out after they have changed the
    // password.  The old implementation rejected every attempt while the IP
    // was blocked *before* checking the credential, so a correct password was
    // indistinguishable from a brute-force attempt for up to 15 minutes.
    // Verify once, then apply the lockout only to invalid credentials.
    const validPassword = await verifyPassword(this.meta("admin_password") ?? "", password);
    if (!validPassword) {
      if (failure && failure.blocked_until > now) return { ok: false, error: "LOGIN_RATE_LIMITED" };
      const failures = (failure?.failures ?? 0) + 1;
      const blockedUntil = failures >= 5 ? now + Math.min(15 * 60_000, 30_000 * 2 ** (failures - 5)) : 0;
      this.ctx.storage.sql.exec(
        "INSERT INTO login_failures(address,failures,blocked_until) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until",
        address,
        failures,
        blockedUntil,
      );
      return { ok: false, error: "INVALID_ADMIN_PASSWORD" };
    }

    this.ctx.storage.sql.exec("DELETE FROM login_failures WHERE address = ?", address);
    const token = randomToken();
    this.ctx.storage.sql.exec(
      "INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)",
      await sha256(token),
      now + 24 * 60 * 60_000,
    );
    return { ok: true, token, mustChangePassword: this.meta("must_change_password") === "true" };
  }

  async session(rawToken: string): Promise<{ authenticated: boolean; mustChangePassword: boolean }> {
    await this.ensureAdmin();
    if (!rawToken) return { authenticated: false, mustChangePassword: this.meta("must_change_password") === "true" };
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE expires_at <= ?", now);
    const found = this.ctx.storage.sql.exec<{ found: number }>(
      "SELECT 1 AS found FROM admin_sessions WHERE token_hash = ? AND expires_at > ?",
      await sha256(rawToken),
      now,
    ).toArray()[0];
    return { authenticated: found?.found === 1, mustChangePassword: this.meta("must_change_password") === "true" };
  }

  async logout(rawToken: string): Promise<void> {
    if (rawToken) this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE token_hash = ?", await sha256(rawToken));
  }

  async changePassword(rawToken: string, currentPassword: string, newPassword: string): Promise<void> {
    await this.ensureAdmin();
    // The bootstrap password proves identity only at login. First-run state is
    // not an authorization bypass: every password mutation must present a
    // live HttpOnly session issued by `login()`.
    const session = await this.session(rawToken);
    if (!session.authenticated) throw new Error("ADMIN_SESSION_REQUIRED");
    if (newPassword.length < 12) throw new Error("PASSWORD_TOO_SHORT");
    if (!(await verifyPassword(this.meta("admin_password") ?? "", currentPassword))) throw new Error("INVALID_ADMIN_PASSWORD");
    this.setMeta("admin_password", await passwordRecord(newPassword));
    this.setMeta("must_change_password", "false");
    this.ctx.storage.sql.exec("DELETE FROM admin_sessions");
  }

  async createOAuthState(): Promise<{ state: string; verifier: string; challenge: string }> {
    const state = randomToken();
    const verifier = randomToken(48);
    const challenge = await sha256(verifier);
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE created_at < ?", now - 10 * 60_000);
    this.ctx.storage.sql.exec(
      "INSERT INTO oauth_states(state_hash,verifier_cipher,created_at) VALUES(?,?,?)",
      await sha256(state),
      await encryptJSON({ verifier }, this.env.DATA_ENCRYPTION_KEY),
      now,
    );
    return { state, verifier, challenge };
  }

  async consumeOAuthState(state: string): Promise<string> {
    const hash = await sha256(state);
    const row = this.ctx.storage.sql.exec<{ verifier_cipher: string; created_at: number }>(
      "DELETE FROM oauth_states WHERE state_hash = ? RETURNING verifier_cipher,created_at",
      hash,
    ).toArray()[0];
    if (!row || Date.now() - row.created_at > 10 * 60_000) throw new Error("OAUTH_STATE_INVALID");
    return (await decryptJSON<{ verifier: string }>(row.verifier_cipher, this.env.DATA_ENCRYPTION_KEY)).verifier;
  }

  async upsertAccount(token: OAuthTokenSet, resetHealth = true): Promise<PublicAccount> {
    if (!token.oid && !token.email) throw new Error("MICROSOFT_TOKEN_IDENTITY_MISSING");
    const credentialCipher = await encryptJSON(token, this.env.DATA_ENCRYPTION_KEY);
    const keyIdentity = token.oid || token.email;
    const now = Date.now();
    const stored = this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<{
        id: string;
        sequence_no: number;
        credential_revision: number;
        credential_kv_key: string;
        token_cipher: string;
        egress_type: string;
      }>(
        `SELECT id,sequence_no,credential_revision,credential_kv_key,token_cipher,egress_type FROM accounts
         WHERE id=? OR email=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`,
        token.oid,
        token.email,
        token.oid,
      ).toArray()[0];
      const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM accounts").one().count;
      const maxAccounts = Math.max(1, Number.parseInt(this.env.MAX_ACCOUNTS || "1", 10) || 1);
      if (!existing && count >= maxAccounts) throw new Error("ACCOUNT_LIMIT_REACHED");
      const id = existing?.id || keyIdentity;
      const pendingDeletion = this.ctx.storage.sql.exec<{ kv_key: string }>(
        "SELECT kv_key FROM credential_mirror_deletions WHERE account_id=?",
        id,
      ).toArray()[0];
      const sequence = existing?.sequence_no || this.nextAccountSequence();
      const revision = (existing?.credential_revision ?? 0) + 1;
      const kvKey = existing?.credential_kv_key
        || (existing?.token_cipher.startsWith("kv:") ? existing.token_cipher.slice(3) : "")
        || pendingDeletion?.kv_key
        || `account-credential:${randomToken(24)}`;
      // The AES-GCM ciphertext and its pending mirror job commit atomically.
      // No request can observe metadata that points only at eventually-
      // consistent KV storage.
      this.ctx.storage.sql.exec(
        `INSERT INTO accounts(id,email,display_name,expires_at,updated_at,token_cipher,credential_revision,credential_kv_key,sequence_no)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,
         expires_at=excluded.expires_at,updated_at=excluded.updated_at,token_cipher=excluded.token_cipher,
         credential_revision=excluded.credential_revision,credential_kv_key=excluded.credential_kv_key`,
        id,
        token.email,
        token.displayName,
        token.expiresAt,
        now,
        credentialCipher,
        revision,
        kvKey,
        sequence,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO credential_mirror_queue(account_id,kv_key,revision,attempt_count,next_attempt_at,updated_at)
         VALUES(?,?,?,0,0,?) ON CONFLICT(account_id) DO UPDATE SET
         kv_key=excluded.kv_key,revision=excluded.revision,attempt_count=0,next_attempt_at=0,updated_at=excluded.updated_at`,
        id,
        kvKey,
        revision,
        now,
      );
      this.ctx.storage.sql.exec("DELETE FROM credential_mirror_deletions WHERE account_id=?", id);
      // Commit initial routing ownership with the account metadata, before
      // any eventually-consistent mirror I/O yields this Durable Object turn.
      this.ensureActiveAccountRoute();
      return { id, sequence, revision, egress: this.safeEgress(existing?.egress_type) };
    });
    await this.armCredentialMirrorRetry();
    await this.enqueueCredentialMirrorOperation(stored.id, () => this.flushCredentialMirror(stored.id));
    await this.scheduleNextAlarm();
    const id = stored.id;
    const sequence = stored.sequence;
    if (resetHealth) await this.reportAccountSuccess(id, true);
    this.ensureActiveAccountRoute();
    return this.publicAccount({
      id,
      email: token.email,
      display_name: token.displayName,
      expires_at: token.expiresAt,
      updated_at: now,
      token_cipher: "",
      credential_revision: stored.revision,
      credential_kv_key: "",
      sequence_no: sequence,
      egress_type: stored.egress,
      health_state: "healthy",
      cooldown_until: 0,
      failure_kind: "",
      request_count: 0,
      error_count: 0,
      token_in: 0,
      token_out: 0,
      last_request_at: 0,
    });
  }

  /**
   * Atomically install a signed migration batch. Plaintext tokens exist only
   * in this RPC turn; SQLite and KV receive the same AES-GCM ciphertext used
   * by normal OAuth authorization. Imported accounts are ordered exactly as
   * supplied and only activeSequence owns the global route.
   */
  async importAccountMigration(
    migrationId: string,
    bodyHash: string,
    nonceHash: string,
    activeSequence: number,
    accounts: MigratedAccountInput[],
  ): Promise<AccountMigrationResult> {
    const now = Date.now();
    // Claim the nonce in its own committed transaction before encryption or
    // mutation. Even a later validation/storage failure cannot make the same
    // signed request usable again; a safe retry needs a fresh nonce and is
    // deduplicated independently by migrationId + bodyHash.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM account_migration_nonces WHERE expires_at<=?", now);
      if (this.ctx.storage.sql.exec<{ found: number }>(
        "SELECT 1 AS found FROM account_migration_nonces WHERE nonce_hash=?",
        nonceHash,
      ).toArray()[0]) throw new Error("MIGRATION_REPLAY");
      this.ctx.storage.sql.exec(
        "INSERT INTO account_migration_nonces(nonce_hash,expires_at) VALUES(?,?)",
        nonceHash,
        now + 10 * 60_000,
      );
    });
    const priorReceipt = this.ctx.storage.sql.exec<{
      body_hash: string;
      imported_count: number;
      active_sequence: number;
    }>(
      "SELECT body_hash,imported_count,active_sequence FROM account_migration_receipts WHERE migration_id=?",
      migrationId,
    ).toArray()[0];
    if (priorReceipt) {
      if (priorReceipt.body_hash !== bodyHash) throw new Error("MIGRATION_ID_CONFLICT");
      return {
        migrationId,
        importedCount: priorReceipt.imported_count,
        activeSequence: priorReceipt.active_sequence,
        replayed: true,
      };
    }
    const prepared = await Promise.all(accounts.map(async (account) => ({
      ...account,
      cipher: await encryptJSON(account.token, this.env.DATA_ENCRYPTION_KEY),
    })));
    const stored = this.ctx.storage.transactionSync(() => {
      const receipt = this.ctx.storage.sql.exec<{
        body_hash: string;
        imported_count: number;
        active_sequence: number;
      }>(
        "SELECT body_hash,imported_count,active_sequence FROM account_migration_receipts WHERE migration_id=?",
        migrationId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.body_hash !== bodyHash) throw new Error("MIGRATION_ID_CONFLICT");
        return {
          result: {
            migrationId,
            importedCount: receipt.imported_count,
            activeSequence: receipt.active_sequence,
            replayed: true,
          },
          mirrorIds: [] as string[],
        };
      }

      const maximum = Math.max(1, Number.parseInt(this.env.MAX_ACCOUNTS || "1", 10) || 1);
      const resolved: Array<{ id: string; existing: AccountRow | undefined }> = [];
      const claimed = new Set<string>();
      let newAccounts = 0;
      for (const account of prepared) {
        const existing = this.ctx.storage.sql.exec<AccountRow>(
          "SELECT * FROM accounts WHERE id=? OR lower(email)=lower(?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
          account.token.oid,
          account.token.email,
          account.token.oid,
        ).toArray()[0];
        const id = existing?.id || account.token.oid;
        if (claimed.has(id)) throw new Error("DUPLICATE_MIGRATION_ACCOUNT");
        claimed.add(id);
        if (!existing) newAccounts += 1;
        resolved.push({ id, existing });
      }
      const currentCount = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM accounts").one().count;
      if (currentCount + newAccounts > maximum) throw new Error("ACCOUNT_LIMIT_REACHED");

      // Put this complete batch first while preserving the relative order of
      // any pre-existing candidate-only accounts after it.
      this.ctx.storage.sql.exec("UPDATE accounts SET sequence_no=sequence_no+?", prepared.length);
      const mirrorIds: string[] = [];
      for (let index = 0; index < prepared.length; index += 1) {
        const account = prepared[index];
        const { id, existing } = resolved[index];
        const pendingDeletion = this.ctx.storage.sql.exec<{ kv_key: string }>(
          "SELECT kv_key FROM credential_mirror_deletions WHERE account_id=?",
          id,
        ).toArray()[0];
        const revision = (existing?.credential_revision ?? 0) + 1;
        const kvKey = existing?.credential_kv_key
          || (existing?.token_cipher.startsWith("kv:") ? existing.token_cipher.slice(3) : "")
          || pendingDeletion?.kv_key
          || `account-credential:${randomToken(24)}`;
        this.ctx.storage.sql.exec(
          `INSERT INTO accounts(id,email,display_name,expires_at,updated_at,token_cipher,credential_revision,credential_kv_key,sequence_no,egress_type)
           VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           email=excluded.email,display_name=excluded.display_name,expires_at=excluded.expires_at,
           updated_at=excluded.updated_at,token_cipher=excluded.token_cipher,
           credential_revision=excluded.credential_revision,credential_kv_key=excluded.credential_kv_key,
           sequence_no=excluded.sequence_no,egress_type=excluded.egress_type`,
          id,
          account.token.email,
          account.token.displayName,
          account.token.expiresAt,
          now,
          account.cipher,
          revision,
          kvKey,
          index + 1,
          account.egress,
        );
        this.ctx.storage.sql.exec("DELETE FROM account_health WHERE account_id=?", id);
        this.ctx.storage.sql.exec("DELETE FROM upstream_gates WHERE account_id=?", id);
        this.ctx.storage.sql.exec("DELETE FROM upstream_gate_waiters WHERE account_id=?", id);
        this.ctx.storage.sql.exec(
          `INSERT INTO credential_mirror_queue(account_id,kv_key,revision,attempt_count,next_attempt_at,updated_at)
           VALUES(?,?,?,0,0,?) ON CONFLICT(account_id) DO UPDATE SET
           kv_key=excluded.kv_key,revision=excluded.revision,attempt_count=0,next_attempt_at=0,updated_at=excluded.updated_at`,
          id,
          kvKey,
          revision,
          now,
        );
        this.ctx.storage.sql.exec("DELETE FROM credential_mirror_deletions WHERE account_id=?", id);
        mirrorIds.push(id);
      }
      const activeId = resolved[activeSequence - 1]?.id ?? "";
      const route = this.activeAccountRoute();
      this.setMeta("active_account_id", activeId);
      this.setMeta("active_account_epoch", String(route.epoch + (route.accountId === activeId ? 0 : 1)));
      const maximumSequence = this.ctx.storage.sql.exec<{ value: number }>(
        "SELECT COALESCE(MAX(sequence_no),0) AS value FROM accounts",
      ).one().value;
      this.setMeta("account_sequence_counter", String(maximumSequence));
      this.ctx.storage.sql.exec(
        `INSERT INTO account_migration_receipts(migration_id,body_hash,imported_count,active_sequence,completed_at)
         VALUES(?,?,?,?,?)`,
        migrationId,
        bodyHash,
        prepared.length,
        activeSequence,
        now,
      );
      return {
        result: { migrationId, importedCount: prepared.length, activeSequence, replayed: false },
        mirrorIds,
      };
    });

    if (stored.mirrorIds.length > 0) {
      await this.armCredentialMirrorRetry();
      for (const id of stored.mirrorIds) {
        await this.enqueueCredentialMirrorOperation(id, () => this.flushCredentialMirror(id));
      }
    }
    await this.scheduleNextAlarm();
    return stored.result;
  }

  async listAccounts(): Promise<PublicAccount[]> {
    this.ensureActiveAccountRoute();
    return this.ctx.storage.sql.exec<AccountRow>(
      `SELECT a.id,a.email,a.display_name,a.expires_at,a.updated_at,'' AS token_cipher,
       0 AS credential_revision,'' AS credential_kv_key,a.sequence_no,a.egress_type,
       COALESCE(h.state,'healthy') AS health_state,COALESCE(h.cooldown_until,0) AS cooldown_until,
       COALESCE(h.failure_kind,'') AS failure_kind,
       COALESCE(s.request_count,0) AS request_count,COALESCE(s.error_count,0) AS error_count,
       COALESCE(s.token_in,0) AS token_in,COALESCE(s.token_out,0) AS token_out,
       COALESCE(s.last_request_at,0) AS last_request_at
       FROM accounts a LEFT JOIN account_health h ON h.account_id=a.id
       LEFT JOIN account_request_stats s ON s.account_id=a.id ORDER BY a.sequence_no,a.id`,
    ).toArray().map((row) => this.publicAccount(row));
  }

  async deleteAccount(id: string): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<{ token_cipher: string; credential_kv_key: string; sequence_no: number }>(
      "SELECT token_cipher,credential_kv_key,sequence_no FROM accounts WHERE id = ?",
      id,
    ).toArray()[0];
    if (!row) return false;
    const key = row.credential_kv_key || (row.token_cipher.startsWith("kv:")
      ? row.token_cipher.slice(3)
      : `account-credential:${randomToken(24)}`);
    const deleted = this.ctx.storage.transactionSync(() => {
      const result = this.ctx.storage.sql.exec("DELETE FROM accounts WHERE id = ?", id);
      if (result.rowsWritten === 0) return false;
      this.ctx.storage.sql.exec("DELETE FROM account_health WHERE account_id=?", id);
      this.ctx.storage.sql.exec("DELETE FROM upstream_gates WHERE account_id=?", id);
      this.ctx.storage.sql.exec("DELETE FROM upstream_gate_waiters WHERE account_id=?", id);
      this.ctx.storage.sql.exec("DELETE FROM account_request_stats WHERE account_id=?", id);
      this.ctx.storage.sql.exec("DELETE FROM credential_mirror_queue WHERE account_id=?", id);
      const active = this.activeAccountRoute();
      if (active.accountId === id) {
        const replacement = this.orderedAvailableAccounts(row.sequence_no)[0];
        this.setMeta("active_account_id", replacement?.id ?? "");
        this.setMeta("active_account_epoch", String(active.epoch + 1));
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO credential_mirror_deletions(account_id,kv_key,attempt_count,next_attempt_at,updated_at)
         VALUES(?,?,0,0,?) ON CONFLICT(account_id) DO UPDATE SET
         kv_key=excluded.kv_key,attempt_count=0,next_attempt_at=0,updated_at=excluded.updated_at`,
        id,
        key,
        Date.now(),
      );
      return true;
    });
    if (!deleted) return false;
    await this.armCredentialMirrorRetry();
    await this.enqueueCredentialMirrorOperation(id, () => this.flushCredentialDeletion(id));
    await this.scheduleNextAlarm();
    return true;
  }

  private async readAccountToken(id: string): Promise<OAuthTokenSet | null> {
    const row = this.ctx.storage.sql.exec<AccountRow>("SELECT * FROM accounts WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    if (row.token_cipher.startsWith("kv:")) {
      const legacyReference = row.token_cipher;
      const legacyKey = legacyReference.slice(3);
      const encrypted = await this.readLegacyAccountCredential(legacyKey);
      if (!encrypted) throw new Error("ACCOUNT_CREDENTIAL_MIRROR_UNAVAILABLE");
      const token = await this.decryptAccountCredential(encrypted, row);
      const migrated = this.ctx.storage.transactionSync(() => {
        const current = this.ctx.storage.sql.exec<{ token_cipher: string; credential_revision: number }>(
          "SELECT token_cipher,credential_revision FROM accounts WHERE id=?",
          row.id,
        ).toArray()[0];
        if (!current || current.token_cipher !== legacyReference) return false;
        this.ctx.storage.sql.exec(
          `UPDATE accounts SET token_cipher=?,credential_revision=?,credential_kv_key=?
           WHERE id=? AND token_cipher=?`,
          encrypted,
          Math.max(1, current.credential_revision),
          legacyKey,
          row.id,
          legacyReference,
        );
        this.ctx.storage.sql.exec("DELETE FROM credential_mirror_deletions WHERE account_id=?", row.id);
        return true;
      });
      return migrated ? token : this.readAccountToken(row.id);
    }

    const token = await this.decryptAccountCredential(row.token_cipher, row);
    if ((row.credential_revision ?? 0) <= 0 || !row.credential_kv_key) {
      // Credentials from releases predating the mirror queue already contain
      // an authoritative AES-GCM ciphertext. Preserve it and add an encrypted
      // KV backup without ever replacing it with a KV-only pointer.
      const kvKey = row.credential_kv_key || `account-credential:${randomToken(24)}`;
      const migrated = this.ctx.storage.transactionSync(() => {
        const current = this.ctx.storage.sql.exec<{ token_cipher: string; credential_revision: number }>(
          "SELECT token_cipher,credential_revision FROM accounts WHERE id=?",
          row.id,
        ).toArray()[0];
        if (!current || current.token_cipher !== row.token_cipher) return false;
        const revision = Math.max(1, current.credential_revision);
        this.ctx.storage.sql.exec(
          "UPDATE accounts SET credential_revision=?,credential_kv_key=? WHERE id=? AND token_cipher=?",
          revision,
          kvKey,
          row.id,
          row.token_cipher,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO credential_mirror_queue(account_id,kv_key,revision,attempt_count,next_attempt_at,updated_at)
           VALUES(?,?,?,0,0,?) ON CONFLICT(account_id) DO UPDATE SET
           kv_key=excluded.kv_key,revision=excluded.revision,attempt_count=0,next_attempt_at=0,updated_at=excluded.updated_at`,
          row.id,
          kvKey,
          revision,
          Date.now(),
        );
        return true;
      });
      if (!migrated) return this.readAccountToken(row.id);
      await this.armCredentialMirrorRetry();
      await this.enqueueCredentialMirrorOperation(row.id, () => this.flushCredentialMirror(row.id));
      await this.scheduleNextAlarm();
    }
    return token;
  }

  async getAccountToken(id = ""): Promise<OAuthTokenSet | null> {
    const route = this.ensureActiveAccountRoute();
    const accountId = id.trim() || route.accountId;
    if (!accountId) return null;
    const found = this.ctx.storage.sql.exec<{ found: number }>("SELECT 1 AS found FROM accounts WHERE id=?", accountId).toArray()[0];
    if (!found) return null;
    if (accountId !== route.accountId) throw new Error("ACCOUNT_NOT_ACTIVE");
    const token = await this.readAccountToken(accountId);
    if (this.activeAccountRoute().accountId !== accountId) throw new Error("ACCOUNT_NOT_ACTIVE");
    return token;
  }

  async ensureValidAccount(id = "", forceRefresh = false): Promise<OAuthTokenSet | null> {
    const route = this.ensureActiveAccountRoute();
    const accountId = id.trim() || route.accountId;
    if (!accountId) return null;
    if (accountId !== route.accountId) throw new Error("ACCOUNT_NOT_ACTIVE");
    const current = await this.readAccountToken(accountId);
    if (this.activeAccountRoute().accountId !== accountId) throw new Error("ACCOUNT_NOT_ACTIVE");
    if (!current || (!forceRefresh && current.expiresAt > Date.now() + ACTIVE_TOKEN_REFRESH_ADVANCE_MS)) return current;
    let refresh = this.refreshInFlight.get(accountId);
    if (!refresh) {
      refresh = (async () => {
        // Re-read after winning the single-flight slot in case a preceding
        // request refreshed while this RPC was queued.
        if (this.activeAccountRoute().accountId !== accountId) throw new Error("ACCOUNT_NOT_ACTIVE");
        const latest = await this.readAccountToken(accountId);
        if (!latest) throw new Error("NO_ACCOUNT");
        if (!forceRefresh && latest.expiresAt > Date.now() + ACTIVE_TOKEN_REFRESH_ADVANCE_MS) {
          this.clearTokenRefreshRetry(accountId);
          await this.scheduleNextAlarm();
          return latest;
        }
        let fresh: OAuthTokenSet;
        try {
          fresh = await refreshToken(this.env, latest);
        } catch (cause) {
          const disposition = classifyAccountFailure(cause);
          if (!disposition || disposition.kind === "transient" || disposition.kind === "rate_limit") {
            await this.deferTokenRefresh(accountId);
          }
          throw cause;
        }
        // A failure on another in-flight request may have switched the route
        // while Microsoft was refreshing. Never persist or return credentials
        // for an account that has since gone to sleep.
        if (this.activeAccountRoute().accountId !== accountId) throw new Error("ACCOUNT_NOT_ACTIVE");
        await this.upsertAccount(fresh, false);
        this.clearTokenRefreshRetry(accountId);
        await this.scheduleNextAlarm();
        return fresh;
      })().finally(() => { this.refreshInFlight.delete(accountId); });
      this.refreshInFlight.set(accountId, refresh);
    }
    return refresh;
  }

  async refreshActiveAccount(id = ""): Promise<PublicAccount | null> {
    const route = this.ensureActiveAccountRoute();
    const accountId = id.trim() || route.accountId;
    if (!accountId) return null;
    if (accountId !== route.accountId) throw new Error("ACCOUNT_NOT_ACTIVE");
    const token = await this.ensureValidAccount(accountId, true);
    if (!token) return null;
    return (await this.listAccounts()).find((account) => account.id === accountId) ?? null;
  }

  private publicAccount(row: AccountRow): PublicAccount {
    const now = Date.now();
    const active = this.activeAccountRoute().accountId === row.id;
    const health = row.health_state === "isolated"
      ? "isolated"
      : (row.cooldown_until ?? 0) > now
        ? "cooldown"
        : "healthy";
    const failureKind = ["rate_limit", "transient", "auth", "permanent"].includes(row.failure_kind ?? "")
      ? row.failure_kind as PublicAccount["failureKind"]
      : "";
    const refresh = active ? this.activeTokenRefreshSchedule(now) : null;
    const tokenState: PublicAccount["tokenState"] = health === "isolated"
      ? failureKind === "auth" ? "auth_failed" : "isolated"
      : !active
      ? "standby"
      : refresh?.retryScheduled
        ? "retry_scheduled"
        : row.expires_at <= now + ACTIVE_TOKEN_REFRESH_ADVANCE_MS
          ? "refresh_due"
          : "valid";
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      sequence: row.sequence_no,
      egress: this.safeEgress(row.egress_type),
      active,
      isolated: !active,
      status: health === "isolated" ? "isolated" : health === "cooldown" ? "cooldown" : row.expires_at > now ? "online" : "expired",
      tokenState,
      refreshScheduledAt: refresh ? new Date(refresh.at).toISOString() : null,
      health,
      cooldownUntil: health === "cooldown" ? new Date(row.cooldown_until ?? 0).toISOString() : null,
      failureKind,
      requestCount: row.request_count ?? 0,
      errorCount: row.error_count ?? 0,
      tokenIn: row.token_in ?? 0,
      tokenOut: row.token_out ?? 0,
      lastRequestAt: (row.last_request_at ?? 0) > 0 ? new Date(row.last_request_at).toISOString() : null,
      expiresAt: new Date(row.expires_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private safeEgress(value: string | undefined): AccountEgress {
    return value === "relay5" || value === "relay7" ? value : "direct";
  }

  async createAPIKey(name: string, days: number): Promise<{ key: string; record: APIKeyRow }> {
    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (!normalizedName || normalizedName.length > MAX_API_KEY_NAME_CHARACTERS) throw new Error("INVALID_API_KEY_NAME");
    if (!Number.isInteger(days) || days < 0 || days > MAX_API_KEY_VALIDITY_DAYS) throw new Error("INVALID_API_KEY_DAYS");
    const raw = `m365_${randomToken(32)}`;
    const now = Date.now();
    const record: APIKeyRow = {
      id: crypto.randomUUID(),
      name: normalizedName,
      prefix: raw.slice(0, 14),
      created_at: now,
      last_used_at: 0,
      expires_at: days > 0 ? now + days * 86_400_000 : 0,
      revoked: 0,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO api_keys(id,name,prefix,key_hash,created_at,expires_at,revoked) VALUES(?,?,?,?,?,?,0)",
      record.id,
      record.name,
      record.prefix,
      await sha256(raw),
      record.created_at,
      record.expires_at,
    );
    return { key: raw, record };
  }

  async listAPIKeys(): Promise<APIKeyRow[]> {
    return this.ctx.storage.sql.exec<APIKeyRow>(
      "SELECT id,name,prefix,created_at,last_used_at,expires_at,revoked FROM api_keys ORDER BY created_at DESC",
    ).toArray();
  }

  async revokeAPIKey(id: string): Promise<boolean> {
    return this.ctx.storage.sql.exec("UPDATE api_keys SET revoked=1 WHERE id=?", id).rowsWritten > 0;
  }

  async revokeInternalTestAPIKeys(): Promise<number> {
    return this.ctx.storage.sql.exec(
      "UPDATE api_keys SET revoked=1 WHERE revoked=0 AND name IN ('cloudflare-e2e-rotated','cloudflare-final-soak')",
    ).rowsWritten;
  }

  async updateAPIKeyExpiry(id: string, days: number): Promise<boolean> {
    if (!Number.isInteger(days) || days < 0 || days > MAX_API_KEY_VALIDITY_DAYS) throw new Error("INVALID_API_KEY_DAYS");
    const expires = days > 0 ? Date.now() + days * 86_400_000 : 0;
    return this.ctx.storage.sql.exec("UPDATE api_keys SET expires_at=? WHERE id=?", expires, id).rowsWritten > 0;
  }

  async validAPIKey(raw: string): Promise<boolean> {
    if (!raw) return false;
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ id: string; last_used_at: number }>(
      "SELECT id,last_used_at FROM api_keys WHERE key_hash=? AND revoked=0 AND (expires_at=0 OR expires_at>?)",
      await sha256(raw),
      now,
    ).toArray()[0];
    if (!row) return false;
    // Persist real last-use data without turning every model request into a
    // SQLite write. The conditional update remains race-safe across requests.
    if (row.last_used_at <= now - API_KEY_LAST_USED_WRITE_INTERVAL_MS) {
      this.ctx.storage.sql.exec(
        "UPDATE api_keys SET last_used_at=? WHERE id=? AND last_used_at<=?",
        now,
        row.id,
        now - API_KEY_LAST_USED_WRITE_INTERVAL_MS,
      );
    }
    return true;
  }
}
