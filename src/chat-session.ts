import { DurableObject } from "cloudflare:workers";
import {
  chatHub,
  chatHubInvocationWasSubmitted,
  isTerminalEmptyQuotaFailure,
  type ChatHubRelay,
  type ChatHubRequest,
  type ChatHubResult,
} from "./chathub";
import { decodeTaskAnchors, encodeTaskAnchors, mergeTaskAnchors, type TaskAnchor } from "./task-anchors";
import type { Env, OAuthTokenSet } from "./types";

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/**
 * A response id is a branch point, not a durable user thread. Keep a useful
 * continuation window without allowing an agent loop to create objects for a
 * month. The effective retention window is the newest 64 aliases in one
 * upstream conversation, for at most seven days.
 */
export const RESPONSE_ALIAS_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_RESPONSE_ALIASES_PER_UPSTREAM = 64;
export const MAX_RESPONSE_ALIASES_TOTAL = 512;
export const MAX_CHAT_SESSION_STATE_BYTES = 192 * 1_024;
export const MAX_RESPONSE_ALIAS_STATE_BYTES_TOTAL = MAX_RESPONSE_ALIASES_TOTAL * MAX_CHAT_SESSION_STATE_BYTES;
export const MAX_PORTABLE_SESSION_BYTES = 64 * 1_024;
const MAX_TOOL_LEDGER_SNAPSHOT_BYTES = 64 * 1_024;
const MAX_PENDING_TOOL_ARGUMENT_BYTES = 96 * 1_024;
const MAX_UPSTREAM_ID_BYTES = 4 * 1_024;
const MAX_ACCOUNT_ID_BYTES = 1 * 1_024;
const MAX_TOOL_ID_BYTES = 4 * 1_024;
const MAX_TOOL_NAME_BYTES = 1 * 1_024;
// Lease ids, row-kind markers, integer columns and serialization framing are
// covered by this reserve so the 192 KiB cap is not merely the sum of user
// supplied text columns.
const PERSISTED_STATE_METADATA_RESERVE_BYTES = 1 * 1_024;
export const RESPONSE_ALIAS_REGISTRY_NAME = "__m365_internal_response_alias_registry_v1__";
// The lease starts before an account gate can queue for up to two minutes and
// before a ChatHub exchange can run for up to ten minutes. Keep a safety margin
// so a legitimate long first turn can never be stolen by a second request.
const CHAT_LEASE_MS = 15 * 60_000;

export function validateToolLedgerSnapshot(toolLedgerSnapshot: string): string {
  if (utf8Bytes(toolLedgerSnapshot) > MAX_TOOL_LEDGER_SNAPSHOT_BYTES) throw new Error("TOOL_LEDGER_SNAPSHOT_TOO_LARGE");
  try {
    if (!Array.isArray(JSON.parse(toolLedgerSnapshot))) throw new Error("invalid snapshot");
  } catch {
    throw new Error("INVALID_TOOL_LEDGER_SNAPSHOT");
  }
  return toolLedgerSnapshot;
}

export interface PortableSessionState {
  taskAnchors: TaskAnchor[];
  /**
   * Opaque, client-protocol context retained from the most recent turns. It is
   * deliberately a UTF-8 suffix: when the budget is exhausted, the newest
   * call/result/user items survive and stale history falls off the front.
   */
  protocolTail: string;
}

export interface PortableSessionUpdate {
  taskAnchors?: TaskAnchor[];
  protocolTail?: string;
}

export interface FinalPortableSessionUpdate {
  taskAnchors?: TaskAnchor[];
  protocolTail: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function boundedField(value: string, maximumBytes: number, code: string): string {
  if (utf8Bytes(value) > maximumBytes) throw new Error(code);
  return value;
}

interface PersistedSessionFields {
  conversationId: string;
  sessionId: string;
  accountId: string;
  pendingCallId: string;
  pendingToolName: string;
  pendingToolArguments: string;
  toolLedgerSnapshot: string;
  aliasGeneration?: string;
  aliasGroupId?: string;
}

function validatePersistedFields(fields: PersistedSessionFields): PersistedSessionFields {
  boundedField(fields.conversationId, MAX_UPSTREAM_ID_BYTES, "CONVERSATION_ID_TOO_LARGE");
  boundedField(fields.sessionId, MAX_UPSTREAM_ID_BYTES, "SESSION_ID_TOO_LARGE");
  boundedField(fields.accountId, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
  boundedField(fields.pendingCallId, MAX_TOOL_ID_BYTES, "PENDING_CALL_ID_TOO_LARGE");
  boundedField(fields.pendingToolName, MAX_TOOL_NAME_BYTES, "PENDING_TOOL_NAME_TOO_LARGE");
  boundedField(fields.pendingToolArguments, MAX_PENDING_TOOL_ARGUMENT_BYTES, "PENDING_TOOL_ARGUMENTS_TOO_LARGE");
  validateToolLedgerSnapshot(fields.toolLedgerSnapshot);
  if (fields.aliasGeneration) boundedField(fields.aliasGeneration, 128, "ALIAS_GENERATION_TOO_LARGE");
  if (fields.aliasGroupId) boundedField(fields.aliasGroupId, 128, "ALIAS_GROUP_TOO_LARGE");
  return fields;
}

function persistedFieldBytes(fields: PersistedSessionFields): number {
  return utf8Bytes(fields.conversationId)
    + utf8Bytes(fields.sessionId)
    + utf8Bytes(fields.accountId)
    + utf8Bytes(fields.pendingCallId)
    + utf8Bytes(fields.pendingToolName)
    + utf8Bytes(fields.pendingToolArguments)
    + utf8Bytes(fields.toolLedgerSnapshot)
    + utf8Bytes(fields.aliasGeneration ?? "")
    + utf8Bytes(fields.aliasGroupId ?? "");
}

/** Apply both the portable-state cap and the aggregate persisted-row cap. */
function boundPortableForPersistedFields(
  fields: PersistedSessionFields,
  taskAnchors: ReadonlyArray<TaskAnchor> | undefined,
  protocolTail: string | null | undefined,
): PortableSessionState {
  validatePersistedFields(fields);
  const anchors = decodeTaskAnchors(encodeTaskAnchors(taskAnchors));
  const encodedAnchors = encodeTaskAnchors(anchors);
  const anchorBytes = utf8Bytes(encodedAnchors);
  const nonPortableBytes = persistedFieldBytes(fields);
  const portableBudget = Math.min(
    MAX_PORTABLE_SESSION_BYTES,
    MAX_CHAT_SESSION_STATE_BYTES - PERSISTED_STATE_METADATA_RESERVE_BYTES - nonPortableBytes,
  );
  if (portableBudget < anchorBytes) throw new Error("CHAT_SESSION_STATE_TOO_LARGE");
  return {
    taskAnchors: anchors,
    protocolTail: boundedUtf8Suffix(
      typeof protocolTail === "string" ? protocolTail : "",
      portableBudget - anchorBytes,
    ),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8Encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function responseAliasGroup(accountId: string, conversationId: string): Promise<string> {
  return `upstream_${await sha256(`${accountId}\u0000${conversationId}`)}`;
}

interface ResponseAliasRegistration {
  aliasId: string;
  generation: string;
  groupId: string;
  expiresAt: number;
}

interface RegisteredAliasRow {
  [key: string]: SqlStorageValue;
  alias_id: string;
  generation: string;
  group_id: string;
  sequence: number;
  expires_at: number;
}

/** Keep the newest UTF-8 suffix without ever beginning inside a code point. */
export function boundedUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";
  const encoded = utf8Encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1;
  return start < encoded.byteLength ? utf8Decoder.decode(encoded.subarray(start)) : "";
}

/**
 * Task anchors have their own strict count/value bounds. They are budgeted
 * first, then the remaining bytes retain the newest protocol history. The
 * persisted representation therefore never exceeds 64 KiB in aggregate.
 */
export function boundPortableSessionState(
  taskAnchors: ReadonlyArray<TaskAnchor> | undefined,
  protocolTail: string | null | undefined,
): PortableSessionState {
  const anchors = decodeTaskAnchors(encodeTaskAnchors(taskAnchors));
  const encodedAnchors = encodeTaskAnchors(anchors);
  const anchorBytes = utf8Bytes(encodedAnchors);
  if (anchorBytes > MAX_PORTABLE_SESSION_BYTES) throw new Error("PORTABLE_TASK_ANCHORS_TOO_LARGE");
  return {
    taskAnchors: anchors,
    protocolTail: boundedUtf8Suffix(
      typeof protocolTail === "string" ? protocolTail : "",
      MAX_PORTABLE_SESSION_BYTES - anchorBytes,
    ),
  };
}

export function portableSessionByteLength(state: PortableSessionState): number {
  return utf8Bytes(encodeTaskAnchors(state.taskAnchors)) + utf8Bytes(state.protocolTail);
}

export interface ChatLease {
  leaseId: string;
  conversationId: string;
  sessionId: string;
  accountId: string;
  accountLocked: boolean;
  started: boolean;
  pendingCallId: string;
  pendingToolName: string;
  pendingToolArguments: string;
  toolLedgerSnapshot: string;
  taskAnchors: TaskAnchor[];
  portableProtocolTail: string;
}

export type DurableChatHubRequest = Omit<ChatHubRequest, "signal"> & { runId: string };

export type DurableChatHubOutcome =
  | { ok: true; result: ChatHubResult }
  | {
      ok: false;
      failure: {
        message: string;
        invocationSubmitted: boolean;
        terminalEmptyQuota: boolean;
      };
    };

export class ChatSession extends DurableObject<Env> {
  private readonly activeChatRuns = new Map<string, AbortController>();
  private readonly cancelledChatRuns = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.initializeStateSchema());
  }

  private initializeStateSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(state)").toArray().map((column) => column.name));
    if (!columns.has("pending_call_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN pending_call_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("pending_tool_name")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN pending_tool_name TEXT NOT NULL DEFAULT ''");
    if (!columns.has("pending_tool_arguments")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN pending_tool_arguments TEXT NOT NULL DEFAULT ''");
    if (!columns.has("tool_ledger_snapshot")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN tool_ledger_snapshot TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("committed")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN committed INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("completed_lease_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN completed_lease_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("account_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN account_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("account_locked")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN account_locked INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("task_anchors")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN task_anchors TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("portable_protocol_tail")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN portable_protocol_tail TEXT NOT NULL DEFAULT ''");
    if (!columns.has("record_kind")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'stable'");
    if (!columns.has("alias_generation")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN alias_generation TEXT NOT NULL DEFAULT ''");
    if (!columns.has("alias_group_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN alias_group_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("alias_expires_at")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN alias_expires_at INTEGER NOT NULL DEFAULT 0");
    // Only the well-known registry object inserts the singleton meta row or
    // alias rows. Creating the empty schema everywhere keeps migrations simple
    // while stable sessions remain completely absent from alias eviction.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS alias_registry_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        next_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alias_registry (
        alias_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL,
        group_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alias_registry_group_sequence
      ON alias_registry(group_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS alias_registry_expiry
      ON alias_registry(expires_at);
    `);
  }

  /**
   * Run the CPU-heavy Microsoft WebSocket protocol inside a Durable Object.
   * The public Worker remains a thin compatibility/SSE adapter and therefore
   * no longer accumulates ChatHub frame parsing against the Free-plan Worker
   * request CPU allowance. Callers use one named runner per account so the
   * existing account gate and the DO execution order agree.
   */
  async runChatHub(
    account: OAuthTokenSet,
    request: DurableChatHubRequest,
    relay?: ChatHubRelay,
  ): Promise<DurableChatHubOutcome> {
    const { runId, ...chatRequest } = request;
    if (!/^[0-9a-f-]{36}$/iu.test(runId)) {
      return { ok: false, failure: { message: "INVALID_CHAT_RUN_ID", invocationSubmitted: false, terminalEmptyQuota: false } };
    }
    if (this.cancelledChatRuns.delete(runId)) {
      return { ok: false, failure: { message: "REQUEST_ABORTED", invocationSubmitted: false, terminalEmptyQuota: false } };
    }
    if (this.activeChatRuns.has(runId)) {
      return { ok: false, failure: { message: "CHAT_RUN_ALREADY_ACTIVE", invocationSubmitted: false, terminalEmptyQuota: false } };
    }
    const controller = new AbortController();
    this.activeChatRuns.set(runId, controller);
    try {
      return { ok: true, result: await chatHub(account, { ...chatRequest, signal: controller.signal }, undefined, relay) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "UNKNOWN_CHAT_ERROR";
      return {
        ok: false,
        failure: {
          message: message.slice(0, 2_048),
          invocationSubmitted: chatHubInvocationWasSubmitted(cause),
          terminalEmptyQuota: isTerminalEmptyQuotaFailure(cause),
        },
      };
    } finally {
      this.activeChatRuns.delete(runId);
    }
  }

  /** Cancel an outbound ChatHub WebSocket without waiting for its hard deadline. */
  async cancelChatHub(runId: string): Promise<"cancelled" | "queued" | "invalid"> {
    if (!/^[0-9a-f-]{36}$/iu.test(runId)) return "invalid";
    const active = this.activeChatRuns.get(runId);
    if (active) {
      active.abort();
      return "cancelled";
    }
    // RPCs sent through the same stub are ordered, but retain a small bounded
    // pre-cancel fence for runtimes that deliver cancellation before startup.
    this.cancelledChatRuns.add(runId);
    while (this.cancelledChatRuns.size > 128) {
      const oldest = this.cancelledChatRuns.values().next().value as string | undefined;
      if (!oldest) break;
      this.cancelledChatRuns.delete(oldest);
    }
    return "queued";
  }

  private responseAliasRegistry(): DurableObjectStub<ChatSession> {
    return this.env.CHATS.getByName(RESPONSE_ALIAS_REGISTRY_NAME);
  }

  private async armRegistryAlarm(now: number): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ expires_at: number }>(
      "SELECT MIN(expires_at) AS expires_at FROM alias_registry",
    ).toArray()[0]?.expires_at;
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(now + 60_000, next));
    else await this.ctx.storage.deleteAlarm();
  }

  private unregisterRegistryRow(aliasId: string, generation: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM alias_registry WHERE alias_id=? AND generation=?",
      aliasId,
      generation,
    );
  }

  /**
   * Strongly ordered alias admission. All response-alias objects rendezvous at
   * one internal ChatSession instance, so concurrent Workers cannot race a KV
   * read/modify/write and admit more than the configured bounds.
  */
  async registerResponseAlias(registration: ResponseAliasRegistration): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.registerResponseAliasLocked(registration));
  }

  private async registerResponseAliasLocked(registration: ResponseAliasRegistration): Promise<void> {
    const now = Date.now();
    boundedField(registration.aliasId, 256, "ALIAS_ID_TOO_LARGE");
    boundedField(registration.generation, 128, "ALIAS_GENERATION_TOO_LARGE");
    boundedField(registration.groupId, 128, "ALIAS_GROUP_TOO_LARGE");
    if (!registration.aliasId || !registration.generation || !registration.groupId || registration.expiresAt <= now) {
      throw new Error("INVALID_ALIAS_REGISTRATION");
    }

    const meta = this.ctx.storage.sql.exec<{ next_sequence: number }>(
      "SELECT next_sequence FROM alias_registry_meta WHERE singleton=1",
    ).toArray()[0];
    const sequence = (meta?.next_sequence ?? 0) + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO alias_registry_meta(singleton,next_sequence) VALUES(1,?)
       ON CONFLICT(singleton) DO UPDATE SET next_sequence=excluded.next_sequence`,
      sequence,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO alias_registry(alias_id,generation,group_id,sequence,expires_at)
       VALUES(?,?,?,?,?) ON CONFLICT(alias_id) DO UPDATE SET
       generation=excluded.generation,group_id=excluded.group_id,
       sequence=excluded.sequence,expires_at=excluded.expires_at`,
      registration.aliasId,
      registration.generation,
      registration.groupId,
      sequence,
      registration.expiresAt,
    );

    const victims = new Map<string, RegisteredAliasRow>();
    const addVictims = (rows: RegisteredAliasRow[]): void => {
      for (const row of rows) victims.set(`${row.alias_id}\u0000${row.generation}`, row);
    };
    addVictims(this.ctx.storage.sql.exec<RegisteredAliasRow>(
      "SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry WHERE expires_at<=?",
      now,
    ).toArray());
    addVictims(this.ctx.storage.sql.exec<RegisteredAliasRow>(
      `SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry
       WHERE group_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?`,
      registration.groupId,
      MAX_RESPONSE_ALIASES_PER_UPSTREAM,
    ).toArray());
    addVictims(this.ctx.storage.sql.exec<RegisteredAliasRow>(
      `SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry
       ORDER BY sequence DESC LIMIT -1 OFFSET ?`,
      MAX_RESPONSE_ALIASES_TOTAL,
    ).toArray());

    try {
      for (const victim of victims.values()) {
        if (victim.alias_id === registration.aliasId && victim.generation === registration.generation) {
          throw new Error("ALIAS_REGISTRY_CAPACITY_EXCEEDED");
        }
        const target = this.env.CHATS.get(this.env.CHATS.idFromString(victim.alias_id));
        const result = await target.evictResponseAlias(victim.generation);
        if (result === "busy") throw new Error("ALIAS_REGISTRY_VICTIM_BUSY");
        this.unregisterRegistryRow(victim.alias_id, victim.generation);
      }
      await this.armRegistryAlarm(now);
    } catch (cause) {
      // Admission is fail-closed. If an active old alias cannot be evicted, the
      // just-created alias is removed by seed() and is not returned to clients.
      this.unregisterRegistryRow(registration.aliasId, registration.generation);
      await this.armRegistryAlarm(now);
      throw cause;
    }
  }

  async unregisterResponseAlias(aliasId: string, generation: string): Promise<void> {
    this.unregisterRegistryRow(aliasId, generation);
    await this.armRegistryAlarm(Date.now());
  }

  async responseAliasRegistryStats(): Promise<{
    aliases: number;
    groups: number;
    maximumAliases: number;
    maximumAliasesPerUpstream: number;
    maximumPayloadBytes: number;
  }> {
    const row = this.ctx.storage.sql.exec<{ aliases: number; groups: number }>(
      "SELECT COUNT(*) AS aliases,COUNT(DISTINCT group_id) AS groups FROM alias_registry",
    ).toArray()[0] ?? { aliases: 0, groups: 0 };
    return {
      aliases: row.aliases,
      groups: row.groups,
      maximumAliases: MAX_RESPONSE_ALIASES_TOTAL,
      maximumAliasesPerUpstream: MAX_RESPONSE_ALIASES_PER_UPSTREAM,
      maximumPayloadBytes: MAX_RESPONSE_ALIAS_STATE_BYTES_TOTAL,
    };
  }

  async responseAliasGroupCount(accountId: string, conversationId: string): Promise<number> {
    boundedField(accountId, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    boundedField(conversationId, MAX_UPSTREAM_ID_BYTES, "CONVERSATION_ID_TOO_LARGE");
    const groupId = await responseAliasGroup(accountId, conversationId);
    return this.ctx.storage.sql.exec<{ aliases: number }>(
      "SELECT COUNT(*) AS aliases FROM alias_registry WHERE group_id=?",
      groupId,
    ).toArray()[0]?.aliases ?? 0;
  }

  /** Registry-only, generation-fenced eviction. */
  async evictResponseAlias(generation: string): Promise<"evicted" | "absent" | "generation_mismatch" | "busy"> {
    const row = this.ctx.storage.sql.exec<{ record_kind: string; alias_generation: string; lease_until: number }>(
      "SELECT record_kind,alias_generation,lease_until FROM state WHERE singleton=1",
    ).toArray()[0];
    if (!row) return "absent";
    if (row.record_kind !== "alias" || row.alias_generation !== generation) return "generation_mismatch";
    if (row.lease_until > Date.now()) return "busy";
    this.ctx.storage.sql.exec(
      "DELETE FROM state WHERE singleton=1 AND record_kind='alias' AND alias_generation=?",
      generation,
    );
    await this.ctx.storage.deleteAll();
    this.initializeStateSchema();
    return "evicted";
  }

  private stateExpiry(row: { record_kind?: string; alias_expires_at?: number; updated_at: number }): number {
    return row.record_kind === "alias" && Number(row.alias_expires_at) > 0
      ? Number(row.alias_expires_at)
      : row.updated_at + SESSION_TTL_MS;
  }

  private async deleteCurrentState(row: { record_kind?: string; alias_generation?: string }): Promise<void> {
    const aliasId = this.ctx.id.toString();
    const generation = row.record_kind === "alias" ? row.alias_generation ?? "" : "";
    this.ctx.storage.sql.exec("DELETE FROM state WHERE singleton=1");
    await this.ctx.storage.deleteAll();
    this.initializeStateSchema();
    if (generation) {
      try {
        await this.responseAliasRegistry().unregisterResponseAlias(aliasId, generation);
      } catch {
        // The registry's own expiry sweep is authoritative and will remove a
        // stale row even if this best-effort reverse notification is lost.
      }
    }
  }

  async acquire(): Promise<ChatLease> {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{
      conversation_id: string;
      session_id: string;
      lease_id: string;
      lease_until: number;
      pending_call_id: string;
      pending_tool_name: string;
      pending_tool_arguments: string;
      tool_ledger_snapshot: string;
      committed: number;
      account_id: string;
      account_locked: number;
      task_anchors: string;
      portable_protocol_tail: string;
      record_kind: string;
      alias_generation: string;
      alias_group_id: string;
      alias_expires_at: number;
      updated_at: number;
    }>("SELECT conversation_id,session_id,lease_id,lease_until,pending_call_id,pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,committed,account_id,account_locked,task_anchors,portable_protocol_tail,record_kind,alias_generation,alias_group_id,alias_expires_at,updated_at FROM state WHERE singleton=1").toArray()[0];
    if (row && this.stateExpiry(row) <= now) {
      await this.deleteCurrentState(row);
      return this.acquire();
    }
    if (row && row.lease_until > now) {
      throw new Error("CONVERSATION_BUSY");
    }
    const continueCommitted = Boolean(row?.committed);
    const portable = boundPortableForPersistedFields({
      conversationId: row?.conversation_id ?? "",
      sessionId: row?.session_id ?? "",
      accountId: row?.account_id ?? "",
      pendingCallId: row?.pending_call_id ?? "",
      pendingToolName: row?.pending_tool_name ?? "",
      pendingToolArguments: row?.pending_tool_arguments ?? "",
      toolLedgerSnapshot: row?.tool_ledger_snapshot ?? "[]",
      aliasGeneration: row?.alias_generation ?? "",
      aliasGroupId: row?.alias_group_id ?? "",
    },
      decodeTaskAnchors(row?.task_anchors),
      row?.portable_protocol_tail,
    );
    // Repair an oversized or pre-normalization row in place. New writes are
    // already bounded; this prevents legacy/corrupt state from escaping the
    // same memory budget merely because it was read rather than overwritten.
    if (row && (
      row.task_anchors !== encodeTaskAnchors(portable.taskAnchors)
      || row.portable_protocol_tail !== portable.protocolTail
    )) {
      this.ctx.storage.sql.exec(
        "UPDATE state SET task_anchors=?,portable_protocol_tail=? WHERE singleton=1",
        encodeTaskAnchors(portable.taskAnchors),
        portable.protocolTail,
      );
    }
    const lease: ChatLease = {
      leaseId: crypto.randomUUID(),
      conversationId: continueCommitted ? row.conversation_id : crypto.randomUUID(),
      sessionId: continueCommitted ? row.session_id : crypto.randomUUID(),
      accountId: continueCommitted || Boolean(row?.account_locked) ? row.account_id : "",
      accountLocked: Boolean(row?.account_locked),
      started: continueCommitted,
      // An account rebind intentionally makes the upstream coordinates
      // uncommitted while retaining a pending call and its replay ledger. An
      // ordinary abandonment clears those fields explicitly below.
      pendingCallId: row?.pending_call_id ?? "",
      pendingToolName: row?.pending_tool_name ?? "",
      pendingToolArguments: row?.pending_tool_arguments ?? "",
      toolLedgerSnapshot: row?.tool_ledger_snapshot ?? "[]",
      // Task references are safe, bounded user identifiers rather than
      // upstream conversation state. Preserve them across an abandoned turn
      // so a retry can still remember the original project target.
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO state(singleton,conversation_id,session_id,account_id,account_locked,lease_id,lease_until,updated_at)
       VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
       conversation_id=excluded.conversation_id,session_id=excluded.session_id,
       account_id=excluded.account_id,account_locked=excluded.account_locked,
       lease_id=excluded.lease_id,lease_until=excluded.lease_until,
       completed_lease_id='',updated_at=excluded.updated_at`,
      lease.conversationId,
      lease.sessionId,
      lease.accountId,
      lease.accountLocked ? 1 : 0,
      lease.leaseId,
      now + CHAT_LEASE_MS,
      now,
    );
    await this.ctx.storage.setAlarm(row?.record_kind === "alias" ? row.alias_expires_at : now + SESSION_TTL_MS);
    return lease;
  }

  async bindAccount(leaseId: string, accountId: string): Promise<ChatLease> {
    const id = accountId.trim();
    if (!id) throw new Error("ACCOUNT_ID_REQUIRED");
    boundedField(id, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    const row = this.ctx.storage.sql.exec<{
      conversation_id: string;
      session_id: string;
      account_id: string;
      account_locked: number;
      committed: number;
      pending_call_id: string;
      pending_tool_name: string;
      pending_tool_arguments: string;
      tool_ledger_snapshot: string;
      task_anchors: string;
      portable_protocol_tail: string;
      alias_generation: string;
      alias_group_id: string;
    }>(
      "SELECT conversation_id,session_id,account_id,account_locked,committed,pending_call_id,pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,alias_generation,alias_group_id FROM state WHERE singleton=1 AND lease_id=?",
      leaseId,
    ).toArray()[0];
    if (!row) throw new Error("STALE_CONVERSATION_LEASE");
    if (row.account_id && row.account_id !== id) throw new Error("SESSION_ACCOUNT_MISMATCH");
    const portable = boundPortableForPersistedFields({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: id,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    this.ctx.storage.sql.exec(
      "UPDATE state SET account_id=?,task_anchors=?,portable_protocol_tail=?,updated_at=? WHERE singleton=1 AND lease_id=?",
      id,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      Date.now(),
      leaseId,
    );
    return {
      leaseId,
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: id,
      accountLocked: Boolean(row.account_locked),
      started: Boolean(row.committed),
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
    };
  }

  async switchUncommittedAccount(leaseId: string, expectedAccountId: string, nextAccountId: string): Promise<ChatLease> {
    const next = nextAccountId.trim();
    if (!next) throw new Error("ACCOUNT_ID_REQUIRED");
    boundedField(next, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    const row = this.ctx.storage.sql.exec<{ pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string; tool_ledger_snapshot: string; task_anchors: string; portable_protocol_tail: string; alias_generation: string; alias_group_id: string }>(
      "SELECT pending_call_id,pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,alias_generation,alias_group_id FROM state WHERE singleton=1 AND lease_id=? AND account_id=? AND committed=0 AND account_locked=0",
      leaseId,
      expectedAccountId,
    ).toArray()[0];
    if (!row) throw new Error("SESSION_ACCOUNT_LOCKED");
    const conversationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const portable = boundPortableForPersistedFields({
      conversationId,
      sessionId,
      accountId: next,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    this.ctx.storage.sql.exec(
      "UPDATE state SET conversation_id=?,session_id=?,account_id=?,task_anchors=?,portable_protocol_tail=?,updated_at=? WHERE singleton=1 AND lease_id=? AND account_id=? AND committed=0 AND account_locked=0",
      conversationId,
      sessionId,
      next,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      Date.now(),
      leaseId,
      expectedAccountId,
    );
    return {
      leaseId,
      conversationId,
      sessionId,
      accountId: next,
      accountLocked: false,
      started: false,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
    };
  }

  /**
   * Atomically detach a committed logical session from an inactive account.
   * Microsoft conversation/session coordinates are account-specific and are
   * therefore always regenerated. Credential-scoped portable context,
   * pending-call state and the non-replay ledger survive. The conditional
   * update is also the stale-epoch fence: after it succeeds, a lease still
   * carrying expectedOldAccountId cannot commit or bind that account again.
   */
  async rebindCommittedAccount(
    leaseId: string,
    expectedOldAccountId: string,
    newActiveAccountId: string,
  ): Promise<ChatLease> {
    const expectedOld = expectedOldAccountId.trim();
    const next = newActiveAccountId.trim();
    if (!expectedOld || !next) throw new Error("ACCOUNT_ID_REQUIRED");
    if (expectedOld === next) throw new Error("ACCOUNT_REBIND_TARGET_UNCHANGED");
    boundedField(expectedOld, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    boundedField(next, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    const row = this.ctx.storage.sql.exec<{
      pending_call_id: string;
      pending_tool_name: string;
      pending_tool_arguments: string;
      tool_ledger_snapshot: string;
      task_anchors: string;
      portable_protocol_tail: string;
      alias_generation: string;
      alias_group_id: string;
    }>(
      `SELECT pending_call_id,pending_tool_name,pending_tool_arguments,
       tool_ledger_snapshot,task_anchors,portable_protocol_tail,alias_generation,alias_group_id
       FROM state WHERE singleton=1 AND lease_id=? AND account_id=?
       AND committed=1 AND account_locked=1`,
      leaseId,
      expectedOld,
    ).toArray()[0];
    if (!row) throw new Error("SESSION_ACCOUNT_REBIND_MISMATCH");

    const conversationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const portable = boundPortableForPersistedFields({
      conversationId,
      sessionId,
      accountId: next,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET conversation_id=?,session_id=?,account_id=?,
       committed=0,account_locked=0,completed_lease_id='',task_anchors=?,portable_protocol_tail=?,updated_at=?
       WHERE singleton=1 AND lease_id=? AND account_id=?
       AND committed=1 AND account_locked=1`,
      conversationId,
      sessionId,
      next,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      Date.now(),
      leaseId,
      expectedOld,
    );
    if (result.rowsWritten !== 1) throw new Error("SESSION_ACCOUNT_REBIND_MISMATCH");
    return {
      leaseId,
      conversationId,
      sessionId,
      accountId: next,
      accountLocked: false,
      started: false,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
    };
  }

  async mergeTaskAnchors(leaseId: string, anchors: TaskAnchor[]): Promise<TaskAnchor[]> {
    const row = this.ctx.storage.sql.exec<{
      conversation_id: string; session_id: string; account_id: string;
      pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string;
      tool_ledger_snapshot: string; task_anchors: string; portable_protocol_tail: string;
      alias_generation: string; alias_group_id: string;
    }>(
      `SELECT conversation_id,session_id,account_id,pending_call_id,pending_tool_name,
       pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,
       alias_generation,alias_group_id FROM state WHERE singleton=1 AND lease_id=?`,
      leaseId,
    ).toArray()[0];
    if (!row) throw new Error("STALE_CONVERSATION_LEASE");
    const merged = mergeTaskAnchors(decodeTaskAnchors(row.task_anchors), anchors);
    const portable = boundPortableForPersistedFields({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: row.account_id,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, merged, row.portable_protocol_tail);
    this.ctx.storage.sql.exec(
      "UPDATE state SET task_anchors=?,portable_protocol_tail=?,updated_at=? WHERE singleton=1 AND lease_id=?",
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      Date.now(),
      leaseId,
    );
    return portable.taskAnchors;
  }

  async markAccountLocked(leaseId: string, accountId: string): Promise<void> {
    const result = this.ctx.storage.sql.exec(
      "UPDATE state SET account_locked=1,updated_at=? WHERE singleton=1 AND lease_id=? AND account_id=?",
      Date.now(),
      leaseId,
      accountId,
    );
    if (result.rowsWritten !== 1) throw new Error("STALE_CONVERSATION_LEASE");
  }

  async complete(
    lease: ChatLease,
    conversationId: string,
    sessionId: string,
    portableUpdate?: PortableSessionUpdate,
  ): Promise<void> {
    await this.commitCompleted(lease, conversationId, sessionId, portableUpdate, false);
  }

  /**
   * Atomically commit upstream coordinates and the exact post-guard protocol
   * tail, then release the lease. Callers doing terminal-commit buffering must
   * use this method only after tool parsing/evidence validation succeeds; until
   * this single conditional UPDATE runs, acquire() continues to return busy.
   */
  async completeFinal(
    lease: ChatLease,
    conversationId: string,
    sessionId: string,
    portableUpdate: FinalPortableSessionUpdate,
  ): Promise<void> {
    await this.commitCompleted(lease, conversationId, sessionId, portableUpdate, true);
  }

  private async commitCompleted(
    lease: ChatLease,
    conversationId: string,
    sessionId: string,
    portableUpdate: PortableSessionUpdate | undefined,
    persistFinalTail: boolean,
  ): Promise<void> {
    const current = this.ctx.storage.sql.exec<{
      lease_id: string; account_id: string; pending_call_id: string; pending_tool_name: string;
      pending_tool_arguments: string; tool_ledger_snapshot: string; task_anchors: string;
      portable_protocol_tail: string; record_kind: string; alias_generation: string;
      alias_group_id: string; alias_expires_at: number;
    }>(
      `SELECT lease_id,account_id,pending_call_id,pending_tool_name,pending_tool_arguments,
       tool_ledger_snapshot,task_anchors,portable_protocol_tail,record_kind,
       alias_generation,alias_group_id,alias_expires_at FROM state WHERE singleton=1`,
    ).toArray()[0];
    if (!current || current.lease_id !== lease.leaseId) throw new Error("STALE_CONVERSATION_LEASE");
    if (!lease.accountId || current.account_id !== lease.accountId) throw new Error("SESSION_ACCOUNT_MISMATCH");
    boundedField(conversationId, MAX_UPSTREAM_ID_BYTES, "CONVERSATION_ID_TOO_LARGE");
    boundedField(sessionId, MAX_UPSTREAM_ID_BYTES, "SESSION_ID_TOO_LARGE");
    const anchors = portableUpdate?.taskAnchors === undefined
      ? decodeTaskAnchors(current.task_anchors)
      : mergeTaskAnchors(decodeTaskAnchors(current.task_anchors), portableUpdate.taskAnchors);
    if (persistFinalTail && typeof portableUpdate?.protocolTail !== "string") {
      throw new Error("FINAL_PROTOCOL_TAIL_REQUIRED");
    }
    const portable = boundPortableForPersistedFields({
      conversationId,
      sessionId,
      accountId: current.account_id,
      pendingCallId: "",
      pendingToolName: "",
      pendingToolArguments: "",
      toolLedgerSnapshot: current.tool_ledger_snapshot,
      aliasGeneration: current.alias_generation,
      aliasGroupId: current.alias_group_id,
    },
      anchors,
      persistFinalTail
        ? portableUpdate!.protocolTail
        // Legacy split-phase callers complete before function-call parsing and
        // completion-evidence guards know the downstream output. Never persist
        // their provisional text; the CAS method can promote a guarded tail.
        : current.portable_protocol_tail,
    );
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET conversation_id=?,session_id=?,lease_id='',lease_until=0,
       completed_lease_id=?,pending_call_id='',pending_tool_name='',pending_tool_arguments='',
       task_anchors=?,portable_protocol_tail=?,committed=1,account_locked=1,updated_at=?
       WHERE singleton=1 AND lease_id=? AND account_id=?`,
      conversationId,
      sessionId,
      lease.leaseId,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      now,
      lease.leaseId,
      lease.accountId,
    );
    if (result.rowsWritten !== 1) throw new Error("STALE_CONVERSATION_LEASE");
    await this.ctx.storage.setAlarm(current.record_kind === "alias" ? current.alias_expires_at : now + SESSION_TTL_MS);
  }

  /**
   * Promote the exact downstream-visible, post-tool-guard output for legacy
   * split-phase callers. complete() deliberately retained the previous safe
   * tail. All four expected values form a CAS fence: a later acquire clears
   * completed_lease_id, while account rotation or a different upstream
   * completion changes the other coordinates and cannot be overwritten by a
   * late resolver. New terminal-commit callers should prefer completeFinal().
   */
  async replaceCompletedPortableProtocolTail(
    completedLeaseId: string,
    expectedAccountId: string,
    expectedConversationId: string,
    expectedSessionId: string,
    portableProtocolTail: string,
  ): Promise<void> {
    const row = this.ctx.storage.sql.exec<{
      account_id: string; conversation_id: string; session_id: string;
      pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string;
      tool_ledger_snapshot: string; task_anchors: string; record_kind: string;
      alias_generation: string; alias_group_id: string; alias_expires_at: number;
    }>(
      `SELECT account_id,conversation_id,session_id,pending_call_id,pending_tool_name,
       pending_tool_arguments,tool_ledger_snapshot,task_anchors,record_kind,
       alias_generation,alias_group_id,alias_expires_at FROM state
       WHERE singleton=1 AND completed_lease_id=? AND account_id=?
       AND conversation_id=? AND session_id=? AND committed=1 AND lease_id=''`,
      completedLeaseId,
      expectedAccountId,
      expectedConversationId,
      expectedSessionId,
    ).toArray()[0];
    if (!row) throw new Error("STALE_COMPLETED_CONVERSATION");
    const portable = boundPortableForPersistedFields({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: row.account_id,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), portableProtocolTail);
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET portable_protocol_tail=?,updated_at=?
       WHERE singleton=1 AND completed_lease_id=? AND account_id=?
       AND conversation_id=? AND session_id=? AND committed=1 AND lease_id=''`,
      portable.protocolTail,
      now,
      completedLeaseId,
      expectedAccountId,
      expectedConversationId,
      expectedSessionId,
    );
    if (result.rowsWritten !== 1) throw new Error("STALE_COMPLETED_CONVERSATION");
    await this.ctx.storage.setAlarm(row.record_kind === "alias" ? row.alias_expires_at : now + SESSION_TTL_MS);
  }

  async release(leaseId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ record_kind: string; alias_expires_at: number }>(
      "SELECT record_kind,alias_expires_at FROM state WHERE singleton=1 AND lease_id=?",
      leaseId,
    ).toArray()[0];
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE state SET lease_id='',lease_until=0,updated_at=? WHERE singleton=1 AND lease_id=?",
      now,
      leaseId,
    );
    if (row) await this.ctx.storage.setAlarm(row.record_kind === "alias" ? row.alias_expires_at : now + SESSION_TTL_MS);
  }

  /**
   * Tombstone a turn whose terminal result was not safely delivered.
   *
   * There are two materially different races:
   *
   * 1. While lease_id still matches, completeFinal() has not run. The stored
   *    protocol tail is therefore the previous, downstream-visible safe tail;
   *    preserve it while discarding this turn's upstream coordinates.
   * 2. Once completeFinal() clears lease_id and records completed_lease_id, the
   *    stored tail contains the just-produced result. A downstream cancellation
   *    may mean that result was not observed, so fail closed and discard it.
   *
   * Downstream cancellation is not evidence that the account is unhealthy, so
   * abandon() retains an already-visible account binding. A classified
   * post-submit upstream failure must instead use abandonFailedUpstream(),
   * which clears that binding so the next request can select the ordered
   * successor account. Sanitized task anchors remain because they identify the
   * user's target rather than an upstream side effect.
   */
  async abandon(leaseId: string): Promise<void> {
    await this.abandonTurn(leaseId, false);
  }

  /**
   * Abandon a turn after an account-scoped upstream failure. Unlike a client
   * cancellation, this deliberately removes account stickiness; otherwise a
   * committed session becomes committed=0/account_locked=1 and can neither be
   * rebound nor use switchUncommittedAccount on its next attempt.
   */
  async abandonFailedUpstream(leaseId: string): Promise<void> {
    await this.abandonTurn(leaseId, true);
  }

  private async abandonTurn(leaseId: string, detachAccount: boolean): Promise<void> {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{
      lease_id: string;
      completed_lease_id: string;
      record_kind: string;
      alias_expires_at: number;
    }>(
      `SELECT lease_id,completed_lease_id,record_kind,alias_expires_at FROM state
       WHERE singleton=1 AND (lease_id=? OR (lease_id='' AND completed_lease_id=?))`,
      leaseId,
      leaseId,
    ).toArray()[0];
    if (!row) return;

    const activeLease = row.lease_id === leaseId;
    const accountReset = detachAccount ? "account_id='',account_locked=0," : "";
    const result = activeLease
      ? this.ctx.storage.sql.exec(
          `UPDATE state SET lease_id='',lease_until=0,completed_lease_id='',
           ${accountReset}committed=0,
           pending_call_id='',pending_tool_name='',pending_tool_arguments='',
           tool_ledger_snapshot='[]',updated_at=?
           WHERE singleton=1 AND lease_id=?`,
          now,
          leaseId,
        )
      : this.ctx.storage.sql.exec(
          `UPDATE state SET lease_id='',lease_until=0,completed_lease_id='',
           ${accountReset}committed=0,
           pending_call_id='',pending_tool_name='',pending_tool_arguments='',
           tool_ledger_snapshot='[]',portable_protocol_tail='',updated_at=?
           WHERE singleton=1 AND lease_id='' AND completed_lease_id=?`,
          now,
          leaseId,
        );
    if (result.rowsWritten !== 1) return;
    await this.ctx.storage.setAlarm(row.record_kind === "alias" ? row.alias_expires_at : now + SESSION_TTL_MS);
  }

  async seed(conversationId: string, sessionId: string, accountId: string, pendingCallId = "", pendingToolName = "", pendingToolArguments = "", toolLedgerSnapshot = "[]", taskAnchors: TaskAnchor[] = [], portableProtocolTail = ""): Promise<void> {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId) throw new Error("ACCOUNT_ID_REQUIRED");
    const generation = crypto.randomUUID();
    const groupId = await responseAliasGroup(normalizedAccountId, conversationId);
    const fields: PersistedSessionFields = {
      conversationId,
      sessionId,
      accountId: normalizedAccountId,
      pendingCallId,
      pendingToolName,
      pendingToolArguments,
      toolLedgerSnapshot,
      aliasGeneration: generation,
      aliasGroupId: groupId,
    };
    const portable = boundPortableForPersistedFields(fields, taskAnchors, portableProtocolTail);
    const encodedAnchors = encodeTaskAnchors(portable.taskAnchors);
    const now = Date.now();
    const expiresAt = now + RESPONSE_ALIAS_TTL_MS;

    let existing: {
      conversation_id: string; session_id: string; account_id: string; lease_until: number;
      pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string;
      tool_ledger_snapshot: string; task_anchors: string; portable_protocol_tail: string;
      record_kind: string; alias_generation: string; alias_group_id: string;
      alias_expires_at: number; updated_at: number;
    } | undefined = this.ctx.storage.sql.exec<{
      conversation_id: string; session_id: string; account_id: string; lease_until: number;
      pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string;
      tool_ledger_snapshot: string; task_anchors: string; portable_protocol_tail: string;
      record_kind: string; alias_generation: string; alias_group_id: string;
      alias_expires_at: number; updated_at: number;
    }>(
      `SELECT conversation_id,session_id,account_id,lease_until,pending_call_id,
       pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,task_anchors,
       portable_protocol_tail,record_kind,alias_generation,alias_group_id,
       alias_expires_at,updated_at FROM state WHERE singleton=1`,
    ).toArray()[0];
    if (existing && this.stateExpiry(existing) <= now) {
      await this.deleteCurrentState(existing);
      existing = undefined;
    }
    if (existing) {
      if (existing.record_kind !== "alias") throw new Error("RESPONSE_ALIAS_KEY_COLLISION");
      if (existing.lease_until > now) throw new Error("RESPONSE_ALIAS_BUSY");
      const idempotent = existing.conversation_id === conversationId
        && existing.session_id === sessionId
        && existing.account_id === normalizedAccountId
        && existing.pending_call_id === pendingCallId
        && existing.pending_tool_name === pendingToolName
        && existing.pending_tool_arguments === pendingToolArguments
        && existing.tool_ledger_snapshot === toolLedgerSnapshot
        && existing.task_anchors === encodedAnchors
        && existing.portable_protocol_tail === portable.protocolTail;
      if (!idempotent) throw new Error("RESPONSE_ALIAS_IMMUTABLE");
      await this.responseAliasRegistry().registerResponseAlias({
        aliasId: this.ctx.id.toString(),
        generation: existing.alias_generation,
        groupId: existing.alias_group_id,
        expiresAt: existing.alias_expires_at,
      });
      await this.ctx.storage.setAlarm(existing.alias_expires_at);
      return;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO state(singleton,conversation_id,session_id,account_id,account_locked,
       lease_id,lease_until,updated_at,pending_call_id,pending_tool_name,
       pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,
       committed,record_kind,alias_generation,alias_group_id,alias_expires_at)
       VALUES(1,?,?,?,1,'',0,?,?,?,?,?,?,?,1,'alias',?,?,?)`,
      conversationId,
      sessionId,
      normalizedAccountId,
      now,
      pendingCallId,
      pendingToolName,
      pendingToolArguments,
      toolLedgerSnapshot,
      encodedAnchors,
      portable.protocolTail,
      generation,
      groupId,
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
    try {
      await this.responseAliasRegistry().registerResponseAlias({
        aliasId: this.ctx.id.toString(),
        generation,
        groupId,
        expiresAt,
      });
    } catch (cause) {
      await this.evictResponseAlias(generation);
      throw cause;
    }
  }

  async alarm(): Promise<void> {
    const registry = this.ctx.storage.sql.exec<{ singleton: number }>(
      "SELECT singleton FROM alias_registry_meta WHERE singleton=1",
    ).toArray()[0];
    if (registry) {
      await this.ctx.blockConcurrencyWhile(() => this.expireRegisteredAliases(Date.now()));
      return;
    }
    await this.expireIfIdle(Date.now());
  }

  private async expireRegisteredAliases(now: number): Promise<void> {
    const expired = this.ctx.storage.sql.exec<RegisteredAliasRow>(
      "SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry WHERE expires_at<=? ORDER BY sequence",
      now,
    ).toArray();
    for (const row of expired) {
      try {
        const target = this.env.CHATS.get(this.env.CHATS.idFromString(row.alias_id));
        const result = await target.evictResponseAlias(row.generation);
        if (result !== "busy") this.unregisterRegistryRow(row.alias_id, row.generation);
      } catch {
        // Keep the registry row and retry. Dropping it before the target is
        // confirmed gone would make the global hard bound an accounting lie.
      }
    }
    await this.armRegistryAlarm(now);
  }

  async expireIfIdle(now = Date.now()): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<{
      updated_at: number; lease_until: number; record_kind: string;
      alias_generation: string; alias_expires_at: number;
    }>(
      "SELECT updated_at,lease_until,record_kind,alias_generation,alias_expires_at FROM state WHERE singleton=1",
    ).toArray()[0];
    if (!row) {
      await this.ctx.storage.deleteAll();
      this.initializeStateSchema();
      return true;
    }
    const expiresAt = this.stateExpiry(row);
    if (row.lease_until > now) {
      await this.ctx.storage.setAlarm(Math.max(row.lease_until, expiresAt));
      return false;
    }
    if (expiresAt > now) {
      // An older alarm can race a recently refreshed alias. Re-arm from the
      // persisted timestamp so that stale alarms never evict live context and
      // never accidentally consume the only future cleanup alarm.
      await this.ctx.storage.setAlarm(expiresAt);
      return false;
    }
    await this.deleteCurrentState(row);
    return true;
  }
}
