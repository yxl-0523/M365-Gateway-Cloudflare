import { classifyCompletionActions, type OperationalAction } from "./completion-evidence";

const textEncoder = new TextEncoder();

export const DEFAULT_MAX_TOOL_ROUNDS = 32;
export const HARD_MAX_TOOL_ROUNDS = 512;
export const DEFAULT_MAX_CONSECUTIVE_FINGERPRINTS = 2;
export const HARD_MAX_CONSECUTIVE_FINGERPRINTS = 8;
export const MAX_COMPLETED_FINGERPRINT_OCCURRENCES = 8;

const DEFAULT_EVIDENCE_ITEMS = 12;
const HARD_MAX_EVIDENCE_ITEMS = 64;
const DEFAULT_EVIDENCE_CHARACTERS = 8_000;
const HARD_MAX_EVIDENCE_CHARACTERS = 32_000;

const failureSignal = /(?:exit\s*(?:code|status)?\s*[:=]?\s*[1-9]\d*|\berror\b|\bfailed\b|\bfailure\b|exception|traceback|timed?\s*out|permission denied|not found|refused|\u9519\u8bef|\u5931\u8d25|\u8d85\u65f6|\u62d2\u7edd|\u65e0\u6743\u9650|\u627e\u4e0d\u5230|\u4e0d\u5b58\u5728)/iu;
const processExitSignal = /(?:^|\n)Process exited with code\s+(-?\d+)(?:\s|$)/iu;

export type ToolProtocol = "chat" | "responses" | "seed";

export type ToolLedgerIssueCode =
  | "missing_call_id"
  | "missing_tool_name"
  | "duplicate_call_id"
  | "unknown_call_id"
  | "call_id_already_consumed"
  | "duplicate_pending_call"
  | "completed_call_reissued"
  | "duplicate_completed_result"
  | "repeated_failure"
  | "tool_round_limit"
  | "consecutive_fingerprint_limit";

export interface ToolLedgerIssue {
  code: ToolLedgerIssueCode;
  message: string;
  callId?: string;
  fingerprint?: string;
}

export interface ToolCallRecord {
  callId: string;
  name: string;
  arguments: unknown;
  normalizedArguments: string;
  fingerprint: string;
  protocol: ToolProtocol;
  /** Sanitized operation labels; never contains raw arguments or output. */
  operationHints?: OperationalAction[];
}

export interface CompletedToolEvidence extends ToolCallRecord {
  result: string;
  normalizedResult: string;
  resultFingerprint: string;
  failed: boolean;
  /** Non-reversible identity used to carry repeated-failure state across Responses aliases. */
  failureFingerprint?: string;
}

export interface ToolLedger {
  calls: ToolCallRecord[];
  completed: CompletedToolEvidence[];
  pending: ToolCallRecord[];
  consumedCallIds: string[];
  issues: ToolLedgerIssue[];
  roundCount: number;
  maxToolRounds: number;
  maxConsecutiveFingerprints: number;
  blocked: boolean;
}

export interface ToolSeedCall {
  callId: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  failed?: boolean;
}

export interface ToolLedgerOptions {
  maxToolRounds?: number;
  maxConsecutiveFingerprints?: number;
  activeChatTurnOnly?: boolean;
  seed?: ToolSeedCall[];
  completedSnapshots?: ToolLedgerSnapshotEntry[];
}

const CHAT_COMPLETION_EVIDENCE_MESSAGE_LIMIT = 96;
const continuationOnly = /^(?:继续(?:执行|处理|完成|下去|吧)?|接着(?:执行|处理|做|吧)?|往下(?:做|继续)?|重试(?:一下)?|再试(?:一次)?|continue|go\s+on|proceed|keep\s+going|carry\s+on|retry|try\s+again)[\s.!！。?？,，]*$/iu;

/** Minimal, non-reversible state persisted between Responses aliases. */
export interface ToolLedgerSnapshotEntry {
  name: string;
  fingerprint: string;
  failed: boolean;
  /** Number of completed executions represented by this opaque fingerprint. */
  completedCount?: number;
  /** SHA-256 identities only; raw tool errors are never persisted. */
  failureFingerprints?: string[];
  /** The same action produced the same failure at least twice. */
  repeatedFailure?: boolean;
  /** Non-sensitive action categories retained for long-task completion evidence. */
  actions?: OperationalAction[];
}

export interface ProposedToolCall {
  name: string;
  arguments: unknown;
}

export interface GuardedToolCall extends ProposedToolCall {
  normalizedArguments: string;
  fingerprint: string;
}

export type ToolGuardDecision =
  | { allowed: true; calls: GuardedToolCall[] }
  | { allowed: false; code: ToolLedgerIssueCode | "pending_tool_result"; message: string; fingerprint?: string };

export interface EvidenceContextOptions {
  maxItems?: number;
  maxCharacters?: number;
}

interface ResolvedLimits {
  maxToolRounds: number;
  maxConsecutiveFingerprints: number;
}

interface MutableLedgerState {
  callsById: Map<string, ToolCallRecord>;
  completedFingerprints: Set<string>;
  completedFingerprintCounts: Map<string, number>;
  failureSignatures: Set<string>;
  calls: ToolCallRecord[];
  completed: CompletedToolEvidence[];
  pendingIds: Set<string>;
  consumedCallIds: Set<string>;
  issues: ToolLedgerIssue[];
  limits: ResolvedLimits;
  lastFingerprint: string;
  consecutiveFingerprintCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || !value || value < 1) return fallback;
  return Math.min(maximum, Math.floor(value));
}

function resolveLimits(options: ToolLedgerOptions): ResolvedLimits {
  return {
    maxToolRounds: boundedInteger(options.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS, HARD_MAX_TOOL_ROUNDS),
    maxConsecutiveFingerprints: boundedInteger(
      options.maxConsecutiveFingerprints,
      DEFAULT_MAX_CONSECUTIVE_FINGERPRINTS,
      HARD_MAX_CONSECUTIVE_FINGERPRINTS,
    ),
  };
}

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : "null";
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
    case "function":
    case "symbol":
      return "null";
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) throw new Error("TOOL_ARGUMENTS_CIRCULAR");
  ancestors.add(object);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item, ancestors)).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}

function canonicalJSONNumber(raw: string): string {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(raw);
  if (!match) throw new Error("INVALID_JSON_NUMBER");
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/u, "");
  if (!digits) return "0";
  let exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent += 1n;
  }
  const sign = negative ? "-" : "";
  // Prefer ordinary JSON notation for realistic tool arguments while keeping
  // huge exponents bounded and mathematically canonical.
  if (exponent >= 0n && exponent <= 10_000n) return `${sign}${digits}${"0".repeat(Number(exponent))}`;
  const decimalPosition = BigInt(digits.length) + exponent;
  if (decimalPosition > 0n && decimalPosition < BigInt(digits.length)) {
    const point = Number(decimalPosition);
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  if (decimalPosition <= 0n && decimalPosition >= -10_000n) {
    return `${sign}0.${"0".repeat(Number(-decimalPosition))}${digits}`;
  }
  const coefficient = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
  return `${sign}${coefficient}e${String(exponent + BigInt(digits.length - 1))}`;
}

/** Parses and canonicalizes JSON without converting number tokens to IEEE-754. */
function canonicalJSONText(text: string): string {
  let offset = 0;
  const whitespace = /\s/u;
  const skipWhitespace = (): void => {
    while (offset < text.length && whitespace.test(text[offset])) offset += 1;
  };
  const stringValue = (): { decoded: string; encoded: string } => {
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset++];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        const encoded = text.slice(start, offset);
        const decoded = JSON.parse(encoded) as string;
        return { decoded, encoded: JSON.stringify(decoded) };
      }
    }
    throw new Error("UNTERMINATED_JSON_STRING");
  };
  const parseValue = (depth: number): string => {
    if (depth > 128) throw new Error("TOOL_ARGUMENTS_TOO_DEEP");
    skipWhitespace();
    const character = text[offset];
    if (character === '"') return stringValue().encoded;
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      const values: string[] = [];
      if (text[offset] === "]") {
        offset += 1;
        return "[]";
      }
      for (;;) {
        values.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return `[${values.join(",")}]`;
        }
        if (text[offset] !== ",") throw new Error("INVALID_JSON_ARRAY");
        offset += 1;
      }
    }
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const values = new Map<string, string>();
      if (text[offset] === "}") {
        offset += 1;
        return "{}";
      }
      for (;;) {
        skipWhitespace();
        if (text[offset] !== '"') throw new Error("INVALID_JSON_OBJECT_KEY");
        const key = stringValue();
        skipWhitespace();
        if (text[offset] !== ":") throw new Error("INVALID_JSON_OBJECT");
        offset += 1;
        values.set(key.decoded, parseValue(depth + 1));
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return `{${[...values.entries()]
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([name, value]) => `${JSON.stringify(name)}:${value}`)
            .join(",")}}`;
        }
        if (text[offset] !== ",") throw new Error("INVALID_JSON_OBJECT");
        offset += 1;
      }
    }
    for (const literal of ["true", "false", "null"] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return literal;
      }
    }
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
    number.lastIndex = offset;
    const numeric = number.exec(text);
    if (!numeric) throw new Error("INVALID_JSON_VALUE");
    offset = number.lastIndex;
    return canonicalJSONNumber(numeric[0]);
  };
  const result = parseValue(0);
  skipWhitespace();
  if (offset !== text.length) throw new Error("TRAILING_JSON_DATA");
  return result;
}

/** Canonicalizes JSON arguments so key ordering and insignificant whitespace do not change identity. */
export function normalizeToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === "string") {
    const trimmed = argumentsValue.trim();
    if (!trimmed) return "{}";
    try {
      return canonicalJSONText(trimmed);
    } catch {
      return canonicalValue(trimmed, new Set());
    }
  }
  return canonicalValue(argumentsValue ?? {}, new Set());
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable identity for a tool action. Tool names remain case-sensitive. */
export async function toolCallFingerprint(name: string, argumentsValue: unknown): Promise<string> {
  const normalizedName = name.trim();
  return `sha256:${await sha256(`${normalizedName}\u0000${normalizeToolArguments(argumentsValue)}`)}`;
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const text = value.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      if (["text", "input_text", "output_text"].includes(String(raw.type ?? "")) && typeof raw.text === "string") return [raw.text];
      return [];
    });
    if (text.length > 0) return text.join("\n").trim();
  }
  return canonicalValue(value ?? null, new Set());
}

function normalizeResult(value: string): string {
  return value.trim().replace(/\r\n?/gu, "\n").replace(/[\t ]+/gu, " ");
}

function normalizeFailure(value: string): string {
  return normalizeResult(value).toLowerCase().replace(/\d+/gu, "#").slice(0, 1_000);
}

function resultFailed(value: string): boolean {
  // exec_command places its authoritative process result in the tool envelope,
  // before command stdout. A successful test may legitimately print words such
  // as ERROR, refused, or failed while exercising fallback/error paths; those
  // strings must not override an explicit outer exit code of zero.
  const processExit = processExitSignal.exec(value.slice(0, 1_024));
  if (processExit) return Number(processExit[1]) !== 0;
  return failureSignal.test(value);
}

function addIssue(state: MutableLedgerState, issue: ToolLedgerIssue): void {
  if (state.issues.some((current) => current.code === issue.code && current.callId === issue.callId && current.fingerprint === issue.fingerprint)) return;
  state.issues.push(issue);
}

function emptyState(options: ToolLedgerOptions): MutableLedgerState {
  return {
    callsById: new Map(),
    completedFingerprints: new Set(),
    completedFingerprintCounts: new Map(),
    failureSignatures: new Set(),
    calls: [],
    completed: [],
    pendingIds: new Set(),
    consumedCallIds: new Set(),
    issues: [],
    limits: resolveLimits(options),
    lastFingerprint: "",
    consecutiveFingerprintCount: 0,
  };
}

async function registerCall(
  state: MutableLedgerState,
  rawCallId: unknown,
  rawName: unknown,
  argumentsValue: unknown,
  protocol: ToolProtocol,
): Promise<ToolCallRecord | null> {
  const callId = typeof rawCallId === "string" ? rawCallId.trim() : "";
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!callId) {
    addIssue(state, { code: "missing_call_id", message: "every structured tool call requires a non-empty call_id" });
    return null;
  }
  if (!name) {
    addIssue(state, { code: "missing_tool_name", callId, message: `tool call ${callId} requires a non-empty function name` });
    return null;
  }
  if (state.callsById.has(callId) || state.consumedCallIds.has(callId)) {
    addIssue(state, { code: "duplicate_call_id", callId, message: `call_id ${callId} was declared more than once` });
    return null;
  }

  const normalizedArguments = normalizeToolArguments(argumentsValue);
  const fingerprint = await toolCallFingerprint(name, argumentsValue);
  const call: ToolCallRecord = { callId, name, arguments: argumentsValue, normalizedArguments, fingerprint, protocol };

  if ((state.completedFingerprintCounts.get(fingerprint) ?? 0) >= MAX_COMPLETED_FINGERPRINT_OCCURRENCES) {
    addIssue(state, {
      code: "completed_call_reissued",
      callId,
      fingerprint,
      message: `tool call ${name} repeats an action that already has completed evidence`,
    });
  } else if ([...state.pendingIds].some((id) => state.callsById.get(id)?.fingerprint === fingerprint)) {
    addIssue(state, {
      code: "duplicate_pending_call",
      callId,
      fingerprint,
      message: `tool call ${name} duplicates an action that is still waiting for a result`,
    });
  }

  state.callsById.set(callId, call);
  state.calls.push(call);
  state.pendingIds.add(callId);

  if (state.lastFingerprint === fingerprint) state.consecutiveFingerprintCount += 1;
  else {
    state.lastFingerprint = fingerprint;
    state.consecutiveFingerprintCount = 1;
  }
  if (state.consecutiveFingerprintCount > state.limits.maxConsecutiveFingerprints) {
    addIssue(state, {
      code: "consecutive_fingerprint_limit",
      callId,
      fingerprint,
      message: `tool fingerprint repeated more than ${state.limits.maxConsecutiveFingerprints} consecutive times`,
    });
  }
  if (state.calls.length > state.limits.maxToolRounds) {
    addIssue(state, {
      code: "tool_round_limit",
      callId,
      fingerprint,
      message: `tool round limit exceeded (${state.limits.maxToolRounds})`,
    });
  }
  return call;
}

async function consumeResult(
  state: MutableLedgerState,
  rawCallId: unknown,
  value: unknown,
  failedOverride?: boolean,
): Promise<void> {
  const callId = typeof rawCallId === "string" ? rawCallId.trim() : "";
  if (!callId) {
    addIssue(state, { code: "missing_call_id", message: "every structured tool result requires a non-empty call_id" });
    return;
  }
  if (state.consumedCallIds.has(callId)) {
    addIssue(state, { code: "call_id_already_consumed", callId, message: `call_id ${callId} already consumed one result` });
    return;
  }
  const call = state.callsById.get(callId);
  if (!call || !state.pendingIds.has(callId)) {
    addIssue(state, { code: "unknown_call_id", callId, message: `tool result references unknown call_id ${callId}` });
    return;
  }

  const result = resultText(value);
  const normalizedResult = normalizeResult(result);
  const resultFingerprint = `sha256:${await sha256(normalizedResult)}`;
  const failed = failedOverride ?? resultFailed(normalizedResult);
  const evidence: CompletedToolEvidence = { ...call, result, normalizedResult, resultFingerprint, failed };
  let failureFingerprint: string | undefined;
  if (failed) {
    failureFingerprint = `sha256:${await sha256(normalizeFailure(normalizedResult))}`;
    const failureSignature = `${call.fingerprint}\u0000${failureFingerprint}`;
    if (state.failureSignatures.has(failureSignature)) {
      addIssue(state, {
        code: "repeated_failure",
        callId,
        fingerprint: call.fingerprint,
        message: `tool call ${call.name} repeated the same failure and must not be retried unchanged`,
      });
    }
    state.failureSignatures.add(failureSignature);
  }

  state.pendingIds.delete(callId);
  state.consumedCallIds.add(callId);
  state.completedFingerprints.add(call.fingerprint);
  state.completedFingerprintCounts.set(call.fingerprint, (state.completedFingerprintCounts.get(call.fingerprint) ?? 0) + 1);
  state.completed.push({ ...evidence, ...(failureFingerprint ? { failureFingerprint } : {}) });
}

async function addSeeds(state: MutableLedgerState, seed: ToolSeedCall[] = []): Promise<void> {
  for (const item of seed) {
    const call = await registerCall(state, item.callId, item.name, item.arguments, "seed");
    if (call && Object.prototype.hasOwnProperty.call(item, "result")) await consumeResult(state, call.callId, item.result, item.failed);
  }
}

function addCompletedSnapshots(state: MutableLedgerState, snapshots: ToolLedgerSnapshotEntry[] = []): void {
  for (const [index, snapshot] of snapshots.slice(-HARD_MAX_TOOL_ROUNDS).entries()) {
    const name = typeof snapshot?.name === "string" ? snapshot.name.trim() : "";
    const fingerprint = typeof snapshot?.fingerprint === "string" ? snapshot.fingerprint : "";
    if (!name || !/^sha256:[a-f0-9]{64}$/u.test(fingerprint) || state.completedFingerprints.has(fingerprint)) continue;
    const completedCount = Math.min(HARD_MAX_TOOL_ROUNDS, Math.max(1, Math.floor(Number(snapshot.completedCount) || 1)));
    const failureFingerprints = Array.isArray(snapshot.failureFingerprints)
      ? [...new Set(snapshot.failureFingerprints.filter((value): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)))]
      : [];
    const operationHints = classifyCompletionActions({ operationHints: snapshot.actions });
    for (const failureFingerprint of failureFingerprints) state.failureSignatures.add(`${fingerprint}\u0000${failureFingerprint}`);
    if (snapshot.repeatedFailure === true) {
      addIssue(state, {
        code: "repeated_failure",
        fingerprint,
        message: `tool call ${name} repeated the same failure and must not be retried unchanged`,
      });
    }
    for (let occurrence = 0; occurrence < completedCount; occurrence += 1) {
      const callId = `persisted_${index}_${occurrence}_${fingerprint.slice(7, 19)}`;
      const call: ToolCallRecord = {
        callId,
        name,
        arguments: {},
        normalizedArguments: "{}",
        fingerprint,
        protocol: "seed",
        ...(operationHints.length > 0 ? { operationHints } : {}),
      };
      // Persisted snapshots are historical evidence, not fresh calls in this
      // continuation. Keeping them out of `calls` preserves duplicate/failure
      // protection without permanently exhausting the per-request round
      // budget and trapping automatic long-task continuations in a 409 loop.
      state.completed.push({
        ...call,
        result: "completed in a prior Responses turn",
        normalizedResult: "completed in a prior Responses turn",
        resultFingerprint: "",
        failed: Boolean(snapshot.failed),
        ...(failureFingerprints[occurrence] ? { failureFingerprint: failureFingerprints[occurrence] } : {}),
      });
    }
    state.completedFingerprints.add(fingerprint);
    state.completedFingerprintCounts.set(fingerprint, completedCount);
  }
}

function finish(state: MutableLedgerState): ToolLedger {
  const pending = state.calls.filter((call) => state.pendingIds.has(call.callId));
  return {
    calls: state.calls,
    completed: state.completed,
    pending,
    consumedCallIds: [...state.consumedCallIds],
    issues: state.issues,
    roundCount: state.calls.length,
    maxToolRounds: state.limits.maxToolRounds,
    maxConsecutiveFingerprints: state.limits.maxConsecutiveFingerprints,
    blocked: state.issues.length > 0,
  };
}

function activeChatMessages(messages: unknown[], activeTurnOnly: boolean): unknown[] {
  if (!activeTurnOnly) return messages;
  let lastUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") lastUser = index;
  }
  return lastUser > 0 ? messages.slice(lastUser) : messages;
}

function chatMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(isRecord)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("\n")
    .trim();
}

/**
 * Selects a bounded task-local history for completion evidence. A short
 * "continue" message is not a new task boundary, so successful tools from the
 * immediately preceding work remain available to the prose completion guard.
 * Execution-loop limits continue to use the ordinary active-turn ledger.
 */
export function selectChatCompletionEvidenceMessages(messages: unknown): unknown[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return messages.slice(-CHAT_COMPLETION_EVIDENCE_MESSAGE_LIMIT);

  let start = lastUser;
  const latest = messages[lastUser];
  if (isRecord(latest) && continuationOnly.test(chatMessageText(latest))) {
    for (let index = lastUser - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!isRecord(message) || message.role !== "user") continue;
      start = index;
      if (!continuationOnly.test(chatMessageText(message))) break;
    }
  }
  start = Math.max(start, messages.length - CHAT_COMPLETION_EVIDENCE_MESSAGE_LIMIT);
  return messages.slice(start);
}

/** Builds a completion-only ledger without expanding active execution limits. */
export async function parseChatCompletionEvidenceLedger(messages: unknown): Promise<ToolLedger> {
  return parseChatToolLedger(selectChatCompletionEvidenceMessages(messages), {
    activeChatTurnOnly: false,
    maxToolRounds: CHAT_COMPLETION_EVIDENCE_MESSAGE_LIMIT,
  });
}

/** Builds a ledger only from structured Chat Completions fields. Message text is never parsed as a tool event. */
export async function parseChatToolLedger(messages: unknown, options: ToolLedgerOptions = {}): Promise<ToolLedger> {
  const state = emptyState(options);
  addCompletedSnapshots(state, options.completedSnapshots);
  await addSeeds(state, options.seed);
  if (!Array.isArray(messages)) return finish(state);
  for (const raw of activeChatMessages(messages, options.activeChatTurnOnly !== false)) {
    if (!isRecord(raw)) continue;
    if (raw.role === "assistant" && Array.isArray(raw.tool_calls)) {
      for (const rawCall of raw.tool_calls) {
        if (!isRecord(rawCall)) continue;
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined;
        if (rawCall.type !== undefined && rawCall.type !== "function") continue;
        await registerCall(state, rawCall.id, fn?.name, fn?.arguments, "chat");
      }
    } else if (raw.role === "tool") {
      await consumeResult(state, raw.tool_call_id, raw.content);
    }
  }
  return finish(state);
}

/** Builds a ledger only from top-level Responses function_call/function_call_output items. */
export async function parseResponsesToolLedger(input: unknown, options: ToolLedgerOptions = {}): Promise<ToolLedger> {
  const state = emptyState(options);
  addCompletedSnapshots(state, options.completedSnapshots);
  await addSeeds(state, options.seed);
  if (!Array.isArray(input)) return finish(state);
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    if (raw.type === "function_call") await registerCall(state, raw.call_id, raw.name, raw.arguments, "responses");
    else if (raw.type === "function_call_output") await consumeResult(state, raw.call_id, raw.output);
  }
  return finish(state);
}

/** Export only non-reversible identities; raw tool arguments/results stay out of Durable Object snapshots. */
export function completedToolSnapshots(ledger: ToolLedger, maximum = 32): ToolLedgerSnapshotEntry[] {
  const limit = boundedInteger(maximum, 32, HARD_MAX_TOOL_ROUNDS);
  const unique = new Map<string, ToolLedgerSnapshotEntry>();
  const repeatedFailures = new Set(ledger.issues
    .filter((issue) => issue.code === "repeated_failure" && issue.fingerprint)
    .map((issue) => issue.fingerprint!));
  for (const item of ledger.completed) {
    const previous = unique.get(item.fingerprint);
    const priorFailureFingerprints = previous?.failureFingerprints ?? [];
    const actions = [...new Set([...(previous?.actions ?? []), ...classifyCompletionActions(item)])];
    const failureFingerprints = [...new Set([
      ...priorFailureFingerprints,
      ...(item.failureFingerprint ? [item.failureFingerprint] : []),
    ])].slice(-2);
    const repeatedFailure = Boolean(
      previous?.repeatedFailure
      || repeatedFailures.has(item.fingerprint)
      || (item.failureFingerprint && priorFailureFingerprints.includes(item.failureFingerprint)),
    );
    unique.delete(item.fingerprint);
    unique.set(item.fingerprint, {
      name: item.name,
      fingerprint: item.fingerprint,
      // The latest execution is authoritative. Historical failure signatures
      // remain separately retained for loop prevention, but must not poison a
      // later successful repair and verification.
      failed: item.failed,
      completedCount: Math.min(HARD_MAX_TOOL_ROUNDS, (previous?.completedCount ?? 0) + 1),
      ...(failureFingerprints.length > 0 ? { failureFingerprints } : {}),
      ...(repeatedFailure ? { repeatedFailure: true } : {}),
      ...(actions.length > 0 ? { actions } : {}),
    });
  }
  return [...unique.values()].slice(-limit);
}

/**
 * Checks model-proposed calls before they are returned to a client. This function
 * only authorizes a proposal; it never executes a tool and never fabricates a result.
 */
export async function guardProposedToolCalls(calls: ProposedToolCall[], ledger: ToolLedger): Promise<ToolGuardDecision> {
  const globallyBlockingIssue = ledger.issues.find((issue) => !["repeated_failure", "consecutive_fingerprint_limit"].includes(issue.code));
  if (globallyBlockingIssue) {
    const issue = globallyBlockingIssue;
    return { allowed: false, code: issue.code, message: issue.message, fingerprint: issue.fingerprint };
  }
  if (ledger.pending.length > 0) {
    return { allowed: false, code: "pending_tool_result", message: "pending tool results must be returned before another tool call" };
  }
  if (ledger.roundCount + calls.length > ledger.maxToolRounds) {
    return { allowed: false, code: "tool_round_limit", message: `tool round limit reached (${ledger.maxToolRounds})` };
  }

  const completed = new Map<string, number>();
  for (const item of ledger.completed) completed.set(item.fingerprint, (completed.get(item.fingerprint) ?? 0) + 1);
  const pending = new Set(ledger.pending.map((item) => item.fingerprint));
  const proposed = new Set<string>();
  const guarded: GuardedToolCall[] = [];
  let last = ledger.calls.at(-1)?.fingerprint ?? "";
  let consecutive = 0;
  for (let index = ledger.calls.length - 1; index >= 0 && ledger.calls[index].fingerprint === last; index -= 1) consecutive += 1;

  for (const call of calls) {
    const name = call.name.trim();
    if (!name) return { allowed: false, code: "missing_tool_name", message: "proposed tool call requires a non-empty function name" };
    const normalizedArguments = normalizeToolArguments(call.arguments);
    const fingerprint = await toolCallFingerprint(name, call.arguments);
    const repeatedFailure = ledger.issues.find((issue) => issue.code === "repeated_failure" && issue.fingerprint === fingerprint);
    if (repeatedFailure) {
      return { allowed: false, code: "repeated_failure", message: repeatedFailure.message, fingerprint };
    }
    if ((completed.get(fingerprint) ?? 0) >= MAX_COMPLETED_FINGERPRINT_OCCURRENCES) {
      return { allowed: false, code: "completed_call_reissued", message: `tool call ${name} already has completed evidence`, fingerprint };
    }
    if (pending.has(fingerprint) || proposed.has(fingerprint)) {
      return { allowed: false, code: "duplicate_pending_call", message: `tool call ${name} duplicates a pending or parallel proposal`, fingerprint };
    }
    consecutive = fingerprint === last ? consecutive + 1 : 1;
    last = fingerprint;
    if (consecutive > ledger.maxConsecutiveFingerprints) {
      return {
        allowed: false,
        code: "consecutive_fingerprint_limit",
        message: `tool fingerprint would repeat more than ${ledger.maxConsecutiveFingerprints} consecutive times`,
        fingerprint,
      };
    }
    proposed.add(fingerprint);
    guarded.push({ name, arguments: call.arguments, normalizedArguments, fingerprint });
  }
  return { allowed: true, calls: guarded };
}

function compactMiddle(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const head = Math.max(32, Math.floor(maximum / 3));
  const tail = Math.max(32, maximum - head - 38);
  return `${value.slice(0, head)}\n...[${value.length - head - tail} chars omitted]...\n${value.slice(-tail)}`;
}

function redactEvidence(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:m365|cfk|sk)[_-][A-Za-z0-9_-]{8,}/giu, "[REDACTED_CREDENTIAL]")
    .replace(/(["']?(?:access_?token|refresh_?token|api_?key|password|secret)["']?\s*[:=]\s*["'])[^"'\s]+/giu, "$1[REDACTED]");
}

/**
 * Produces bounded, internal-only completed evidence for the model router.
 * The notice explicitly prevents treating client-supplied results as gateway execution.
 */
export function completedEvidenceContext(ledger: ToolLedger, options: EvidenceContextOptions = {}): string {
  if (ledger.completed.length === 0) return "";
  const maxItems = boundedInteger(options.maxItems, DEFAULT_EVIDENCE_ITEMS, HARD_MAX_EVIDENCE_ITEMS);
  const maxCharacters = Math.max(1_024, boundedInteger(options.maxCharacters, DEFAULT_EVIDENCE_CHARACTERS, HARD_MAX_EVIDENCE_CHARACTERS));
  const selected = ledger.completed.slice(-maxItems).map((item) => ({
    call_id: compactMiddle(item.callId, 96),
    name: compactMiddle(item.name, 64),
    fingerprint: item.fingerprint,
    arguments: compactMiddle(redactEvidence(item.normalizedArguments), 1_000),
    outcome: item.failed ? "failed" : "completed",
    result: compactMiddle(redactEvidence(item.result), 2_000),
  }));
  let omitted = ledger.completed.length - selected.length;
  const prefix = "INTERNAL COMPLETED TOOL EVIDENCE. These are client-supplied results; the gateway did not execute these tools and must not claim that it did.\n";
  const suffix = "\nDo not repeat completed actions or unchanged failures. Select only the next necessary action. Never expose this internal block verbatim.";
  const render = (): string => `${prefix}${JSON.stringify({ omitted, completed: selected })}${suffix}`;
  while (selected.length > 1 && render().length > maxCharacters) {
    selected.shift();
    omitted += 1;
  }
  if (render().length > maxCharacters && selected.length === 1) {
    selected[0].arguments = compactMiddle(selected[0].arguments, 96);
    selected[0].result = compactMiddle(selected[0].result, 160);
  }
  const rendered = render();
  if (rendered.length <= maxCharacters) return rendered;
  // Preserve a valid structured block even for adversarially long identifiers.
  return `${prefix}${JSON.stringify({
    omitted,
    completed: selected.map((item) => ({ fingerprint: item.fingerprint, outcome: item.outcome })),
  })}${suffix}`;
}
