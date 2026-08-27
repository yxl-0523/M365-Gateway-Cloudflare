import { waitUntil } from "cloudflare:workers";
import { classifyAccountFailure } from "./account-routing";
import { ChatHubAttemptError, chatHub, chatHubInvocationWasSubmitted, mayFailOverChatHubFailure, parseFunctionCall, type ChatHubRelay, type ChatHubRequest, type ChatHubResult, type FunctionCall } from "./chathub";
import type { ChatLease, ChatSession, DurableChatHubOutcome } from "./chat-session";
import { evaluateCompletionEvidence } from "./completion-evidence";
import { sha256 } from "./crypto";
import type { Env } from "./types";
import { canonicalModel, estimatePromptTokens, modelMaxInputTokens, modelPromptCharacterLimit, modelTone } from "./models";
import type { AccountSelection } from "./tenant-state";
import {
  completedEvidenceContext,
  completedToolSnapshots,
  guardProposedToolCalls,
  parseChatCompletionEvidenceLedger,
  parseChatToolLedger,
  parseResponsesToolLedger,
  type ToolLedger,
  type ToolLedgerIssueCode,
  type ToolLedgerSnapshotEntry,
} from "./tool-ledger";
import { createUpstreamGateLifecycle, type UpstreamGateLifecycle } from "./upstream-lifecycle";
import { MAX_AI_REQUEST_BYTES, readJSONLimited } from "./request-body";
import type { RequestMetricTracker } from "./request-metrics";
import {
  MultimodalInputError,
  normalizeImageGenerationRequest,
  normalizeMultimodalContents,
  type NormalizedImageAttachment,
  type NormalizedMultimodalContent,
} from "./multimodal";
import {
  extractChatTaskAnchors,
  extractResponsesTaskAnchors,
  reserveTaskAnchorContext,
  type TaskAnchor,
} from "./task-anchors";

const encoder = new TextEncoder();
const STREAM_HEARTBEAT_MS = 5_000;
const STREAM_PREFLIGHT_GRACE_MS = 250;
const LOGICAL_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_REQUEST_TOKEN_BUDGET = 96_000;
const PROMPT_PROTOCOL_RESERVE_TOKENS = 2_048;
const MIN_USABLE_PROMPT_TOKENS = 8_192;
const CLIENT_TOOL_UNAVAILABLE_SENTINEL = "CLIENT_TOOL_UNAVAILABLE";

/** Count semantic request fields without serializing or retaining the body. */
function observeMetricValues(metrics: RequestMetricTracker | undefined, ...values: unknown[]): void {
  if (!metrics) return;
  const pending = [...values];
  let visited = 0;
  // Metrics are diagnostic only. Never spend a meaningful fraction of the
  // request CPU budget walking arbitrarily deep tool schemas or large bodies.
  const maxVisited = 20_000;
  while (pending.length > 0 && visited < maxVisited) {
    const value = pending.pop();
    visited += 1;
    if (typeof value === "string") {
      metrics.observeInputText(value);
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      // A base64 image or signed image URL is binary transport, not prompt
      // text. Counting it as text grossly inflates usage and needlessly walks
      // multi-megabyte secrets. Record only a constant semantic placeholder.
      if (["image", "image_url", "input_image"].includes(String(record.type ?? ""))) {
        metrics.observeInputText("[image attachment]");
        continue;
      }
      if (["audio", "input_audio"].includes(String(record.type ?? ""))) {
        metrics.observeInputText("[audio attachment]");
        continue;
      }
      for (const [key, item] of Object.entries(record)) {
        // Tool JSON schemas are already accounted for by request-size and
        // context validation. Walking every property recursively is expensive
        // and has no value for terminal usage metrics.
        if (["parameters", "properties", "$defs", "definitions", "schema", "items"].includes(key)) continue;
        pending.push(item);
      }
    }
  }
}

/** Count model output without retaining text in the metrics lifecycle. */
function observeMetricResult(metrics: RequestMetricTracker | undefined, result: ChatHubResult): void {
  if (!metrics) return;
  if (result.text) metrics.observeOutputText(result.text);
  else if (result.functionCall) metrics.observeOutputText(`${result.functionCall.name} ${result.functionCall.arguments}`);
  if (result.images?.length) metrics.observeOutputText(`[${result.images.length} image output(s)]`);
}

export function logicalRequestDeadlineAt(now = Date.now()): number {
  return now + LOGICAL_REQUEST_TIMEOUT_MS;
}

/**
 * A model may describe a completed side effect only when the structured tool
 * ledger contains matching successful evidence. Keep this as an ordinary
 * terminal assistant response: compatibility clients must not retry the same
 * failed tool merely because the gateway rejected the prose at transport
 * level. Tool proposals themselves are handled by the separate call guard.
 */
export function guardAssistantCompletion(
  result: ChatHubResult,
  call: FunctionCall | null,
  ledger: Pick<ToolLedger, "calls" | "completed" | "pending">,
  tools: unknown[] | undefined,
): ChatHubResult {
  if (call) return result;
  const hasToolContext = Boolean(tools?.length || ledger.calls.length || ledger.completed.length || ledger.pending.length);
  if (!hasToolContext) return result;
  const decision = evaluateCompletionEvidence(result.text, ledger);
  if (decision.allowed || !decision.replacementText) return result;
  return { ...result, text: decision.replacementText };
}

export function adoptAccountSelection(active: AccountSelection, replacement: AccountSelection): void {
  active.accountId = replacement.accountId;
  active.sequence = replacement.sequence;
  active.egress = replacement.egress;
  active.routeEpoch = replacement.routeEpoch;
  active.token = replacement.token;
}

export function accountChatHubRelay(env: Env, egress: AccountSelection["egress"]): ChatHubRelay | undefined {
  if (!egress || egress === "direct") return undefined;
  const baseURL = egress === "relay5" ? env.RELAY5_URL : env.RELAY7_URL;
  const hmacSecret = egress === "relay5" ? env.RELAY5_HMAC_SECRET : env.RELAY7_HMAC_SECRET;
  const origin = env.RELAY_ORIGIN;
  if (!baseURL || !hmacSecret || !origin) throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  return { baseURL, hmacSecret, origin };
}

const CHAT_HUB_RUNNER_PREFIX = "__m365_internal_chathub_runner_v1__:";

async function durableChatHub(
  env: Env,
  accountId: string,
  account: AccountSelection["token"],
  request: ChatHubRequest,
  relay?: ChatHubRelay,
): Promise<ChatHubResult> {
  if (request.signal?.aborted) throw new ChatHubAttemptError(new Error("REQUEST_ABORTED"), false);
  const { signal, ...durableRequest } = request;
  const runner = env.CHATS.getByName(`${CHAT_HUB_RUNNER_PREFIX}${accountId}`);
  // Lightweight unit-test stubs created before the runner RPC existed expose
  // only lease methods. Real Cloudflare stubs always expose the class RPC.
  if (typeof (runner as unknown as { runChatHub?: unknown }).runChatHub !== "function") {
    return chatHub(account, request, undefined, relay);
  }
  const outcome = await runner.runChatHub(account, durableRequest, relay) as DurableChatHubOutcome;
  if (outcome.ok === false) {
    throw new ChatHubAttemptError(
      new Error(outcome.failure.message),
      outcome.failure.invocationSubmitted,
      outcome.failure.terminalEmptyQuota,
    );
  }
  // The DO cannot receive an AbortSignal over RPC. Preserve cancellation
  // semantics after the bounded upstream exchange completes, without freeing
  // the per-account gate while Microsoft may still be processing the turn.
  if (signal?.aborted) throw new ChatHubAttemptError(new Error("REQUEST_ABORTED"), true);
  return outcome.result;
}

interface ChatBody {
  model?: string;
  messages?: Array<Record<string, unknown>>;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  session_key?: string;
  conversation_id?: string;
  reasoning_effort?: string;
  parallel_tool_calls?: boolean;
}

interface ResponsesBody {
  model?: string;
  input?: unknown;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  previous_response_id?: string;
  prompt_cache_key?: string;
  client_metadata?: Record<string, unknown>;
  conversation?: unknown;
  new_conversation?: boolean;
  session_key?: string;
  reasoning?: { effort?: string };
  parallel_tool_calls?: boolean;
}

function validateTools(tools: unknown[] | undefined): void {
  if (!tools) return;
  if (!Array.isArray(tools) || tools.length > 128) throw new Error("INVALID_TOOLS");
  if (JSON.stringify(tools).length > 1_000_000) throw new Error("TOOLS_TOO_LARGE");
  const names = new Set<string>();
  for (const raw of tools) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_TOOLS");
    const tool = raw as { type?: unknown; name?: unknown; function?: unknown };
    // Codex sends function tools alongside custom apply_patch, deferred
    // namespaces, and hosted web_search declarations.  Those non-function
    // tools are valid Responses API input even though this gateway can only
    // round-trip caller-executed function calls today.  Validate their type
    // envelope here, then exclude them from the ChatHub client-plugin list.
    if (tool.type !== undefined && tool.type !== "function") {
      if (typeof tool.type !== "string" || !tool.type.trim()) throw new Error("INVALID_TOOLS");
      continue;
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
      ? tool.function as { name?: unknown }
      : tool;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name || name.length > 128 || names.has(name)) throw new Error("INVALID_TOOLS");
    names.add(name);
  }
}

function routableFunctionTools(tools: unknown[] | undefined): unknown[] | undefined {
  const filtered = tools?.filter((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const type = (raw as { type?: unknown }).type;
    return type === undefined || type === "function";
  });
  return filtered?.length ? filtered : undefined;
}

function explicitClientExecRequest(input: unknown, tools: unknown[] | undefined, choice: unknown): boolean {
  if (String(choice ?? "auto").toLowerCase() !== "auto") return false;
  if (!toolNames(tools).includes("exec_command") || functionOutputs(input).length > 0) return false;
  let lastUserText = typeof input === "string" ? input : "";
  if (Array.isArray(input)) {
    for (const raw of input) {
      const item = raw as Record<string, unknown>;
      if (String(item?.role ?? "").toLowerCase() === "user") lastUserText = contentText(item.content);
    }
  }
  return /(?:\b(?:call|use|run|execute)\b[^\n]{0,120}\bexec_command\b|\bexec_command\b[^\n]{0,120}\b(?:call|use|run|execute)\b|(?:登录|修复|部署|检查|读取|修改|写入|执行)[^\n]{0,160}(?:服务器|目录|文件|日志|命令|PowerShell|SSH)|(?:[A-Za-z]:\\|\\\\)[^\n]{1,240})/iu.test(lastUserText);
}

function validateParallelToolMode(value: boolean | undefined): void {
  // OpenAI defines this as permission to emit parallel calls, not a demand
  // that every response contain more than one call. The upstream bridge is
  // deliberately sequential, so both true and false are compatible: we may
  // still return one safe call at a time. Reject only malformed wire values.
  if (value !== undefined && typeof value !== "boolean") throw new Error("INVALID_PARALLEL_TOOL_MODE");
}

function validateToolChoice(choice: unknown, tools: unknown[] | undefined): void {
  if (choice === undefined || choice === null) return;
  if (typeof choice === "string") {
    if (!["auto", "none", "required"].includes(choice.toLowerCase())) throw new Error("INVALID_TOOL_CHOICE");
    if (choice.toLowerCase() === "required" && !tools?.length) throw new Error("INVALID_TOOL_CHOICE");
    return;
  }
  if (typeof choice !== "object" || Array.isArray(choice)) throw new Error("INVALID_TOOL_CHOICE");
  const record = choice as { type?: unknown; name?: unknown; function?: { name?: unknown } };
  const name = typeof record.function?.name === "string"
    ? record.function.name.trim()
    : typeof record.name === "string" ? record.name.trim() : "";
  if ((record.type !== undefined && record.type !== "function") || !name || !toolNames(tools).includes(name)) {
    throw new Error("INVALID_TOOL_CHOICE");
  }
}

export function availablePromptCharacterBudget(model: string, tools: unknown[] | undefined, evidenceCharacters: number): number {
  const toolJSON = tools?.length ? JSON.stringify(tools) : "";
  // Definitions travel both in the compatibility prompt and in ChatHub's
  // native client-plugin channel. Reserve both copies plus envelope overhead.
  const toolCost = toolJSON ? toolJSON.length * 2 + 2_048 : 0;
  const available = modelPromptCharacterLimit(model) - toolCost - Math.max(0, evidenceCharacters) - 2;
  if (available < 4_096) throw new Error("TOOL_DEFINITIONS_EXCEED_MODEL_CONTEXT");
  return available;
}

export function availablePromptTokenBudget(model: string, tools: unknown[] | undefined, evidence: string): number {
  const toolJSON = tools?.length ? JSON.stringify(tools) : "";
  const toolTokens = toolJSON ? estimatePromptTokens(toolJSON) * 2 + 512 : 0;
  const requestBudget = Math.min(modelMaxInputTokens(model), DEFAULT_REQUEST_TOKEN_BUDGET);
  const available = requestBudget - PROMPT_PROTOCOL_RESERVE_TOKENS - toolTokens - estimatePromptTokens(evidence);
  if (available < MIN_USABLE_PROMPT_TOKENS) throw new Error("TOOL_DEFINITIONS_EXCEED_MODEL_CONTEXT");
  return available;
}

function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { type: "cloudflare_native_error", code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

class ToolLedgerBlockedError extends Error {
  constructor(
    readonly publicCode: string,
    readonly publicMessage: string,
    readonly status: number,
  ) {
    super(`TOOL_LEDGER_BLOCKED:${publicCode}`);
  }
}

function toolGuardFailure(code: ToolLedgerIssueCode | "pending_tool_result"): ToolLedgerBlockedError {
  switch (code) {
    case "repeated_failure":
      return new ToolLedgerBlockedError("repeated_tool_failure", "the same tool action failed again; inspect the last result and change the action before retrying", 409);
    case "completed_call_reissued":
    case "duplicate_completed_result":
    case "duplicate_pending_call":
    case "consecutive_fingerprint_limit":
      return new ToolLedgerBlockedError("repeated_tool_call", "the same tool action was already completed or proposed; do not issue it again unchanged", 409);
    case "tool_round_limit":
      return new ToolLedgerBlockedError("tool_round_limit", "the bounded tool-call limit for this user task has been reached", 409);
    case "pending_tool_result":
      return new ToolLedgerBlockedError("pending_tool_result", "return the pending tool result before requesting another tool call", 409);
    case "call_id_already_consumed":
      return new ToolLedgerBlockedError("tool_output_already_consumed", "this call_id has already consumed a tool result", 409);
    case "unknown_call_id":
      return new ToolLedgerBlockedError("tool_output_mismatch", "the tool result references an unknown call_id", 400);
    default:
      return new ToolLedgerBlockedError("invalid_tool_history", "the structured tool-call history is invalid", 400);
  }
}

function toolLedgerPreflight(ledger: ToolLedger): Response | null {
  // Repeated failures are proposal-specific: after two identical failures the
  // model must still be allowed to inspect evidence and choose a *different*
  // action. guardProposedToolCalls blocks only the unchanged fingerprint.
  const blockingIssues = ledger.issues.filter((issue) => issue.code !== "repeated_failure");
  if (blockingIssues.length > 0) {
    const repeatedFailure = ledger.issues.find((issue) => issue.code === "repeated_failure");
    const preferred = (repeatedFailure && blockingIssues.some((issue) => issue.fingerprint === repeatedFailure.fingerprint)
      ? repeatedFailure
      : undefined)
      ?? blockingIssues.find((issue) => issue.code === "tool_round_limit")
      ?? ledger.issues.find((issue) => issue.code === "consecutive_fingerprint_limit")
      ?? blockingIssues[0];
    const failure = toolGuardFailure(preferred.code);
    return apiError(failure.status, failure.publicCode, failure.publicMessage);
  }
  if (ledger.pending.length > 0) {
    const failure = toolGuardFailure("pending_tool_result");
    return apiError(failure.status, failure.publicCode, failure.publicMessage);
  }
  return null;
}

export function recoverRepeatedPendingProposal(ledger: ToolLedger): ToolLedger {
  const repeatedFingerprints = new Set(ledger.issues
    .filter((issue) => issue.code === "repeated_failure" && issue.fingerprint)
    .map((issue) => issue.fingerprint!));
  const recoverableIds = new Set(ledger.pending
    .filter((call) => repeatedFingerprints.has(call.fingerprint)
      && ledger.issues.some((issue) => issue.callId === call.callId
        && ["completed_call_reissued", "consecutive_fingerprint_limit"].includes(issue.code)))
    .map((call) => call.callId));
  if (recoverableIds.size === 0) return ledger;
  const calls = ledger.calls.filter((call) => !recoverableIds.has(call.callId));
  const issues = ledger.issues.filter((issue) => !(
    issue.callId
    && recoverableIds.has(issue.callId)
    && ["completed_call_reissued", "consecutive_fingerprint_limit", "duplicate_pending_call"].includes(issue.code)
  ));
  return {
    ...ledger,
    calls,
    pending: ledger.pending.filter((call) => !recoverableIds.has(call.callId)),
    issues,
    roundCount: calls.length,
    blocked: issues.length > 0,
  };
}

function recoveredRepeatedPendingProposal(before: ToolLedger, after: ToolLedger): boolean {
  if (before.pending.length <= after.pending.length) return false;
  const remaining = new Set(after.pending.map((call) => call.callId));
  return before.pending.some((call) => !remaining.has(call.callId));
}

interface GuardedFunctionCallResult {
  call: FunctionCall | null;
  rejection?: ToolLedgerBlockedError;
}

function recoverableToolGuardCode(code: ToolLedgerIssueCode | "pending_tool_result"): boolean {
  return ["repeated_failure", "completed_call_reissued", "consecutive_fingerprint_limit"].includes(code);
}

function terminalToolGuardCode(code: ToolLedgerIssueCode | "pending_tool_result"): boolean {
  return code === "tool_round_limit";
}

async function guardedFunctionCall(call: FunctionCall, ledger: ToolLedger): Promise<GuardedFunctionCallResult> {
  const decision = await guardProposedToolCalls([{ name: call.name, arguments: call.arguments }], ledger);
  if (!decision.allowed) {
    const rejection = toolGuardFailure(decision.code);
    if (recoverableToolGuardCode(decision.code) || terminalToolGuardCode(decision.code)) return { call: null, rejection };
    throw rejection;
  }
  return { call: { name: decision.calls[0].name, arguments: decision.calls[0].normalizedArguments } };
}

export function toolRecoveryTermination(reason?: string): string {
  const base = "Tool execution stopped after a repeated or invalid action. Inspect the last tool result and change the tool or arguments before continuing.";
  return reason ? `${base} Reason: ${reason}.` : base;
}

export function publicFailure(cause: unknown): { code: string; message: string } {
  if (cause instanceof ToolLedgerBlockedError) return { code: cause.publicCode, message: cause.publicMessage };
  const raw = cause instanceof Error ? cause.message : "";
  // Keep gateway invariant failures diagnosable without reflecting arbitrary
  // upstream text. Only gateway-authored machine codes are allow-listed, so
  // URLs, query parameters, credentials and Microsoft response text remain
  // behind the generic fallback below.
  if (raw === "ACCOUNT_NOT_ACTIVE") return { code: "account_route_changed", message: "the active Microsoft 365 account changed before the upstream request started" };
  if (raw === "STALE_CONVERSATION_LEASE" || raw === "SESSION_ACCOUNT_MISMATCH") return { code: "conversation_lease_conflict", message: "the conversation lease changed before the turn could be committed" };
  if (raw === "TOOL_CALL_GENERATION_FAILED") return { code: "tool_routing_failed", message: "the gateway could not produce a valid client tool call" };
  if (raw === "REQUEST_ABORTED") return { code: "request_aborted", message: "the client request ended before the upstream operation completed" };
  if (raw === "MICROSOFT_REFRESH_TOKEN_MISSING" || raw === "MICROSOFT_REFRESH_TOKEN_REJECTED" || raw === "MICROSOFT_TOKEN_EXCHANGE_FAILED") return { code: "upstream_auth_error", message: "the selected Microsoft 365 account could not refresh its authorization" };
  if (raw === "MICROSOFT_TOKEN_RATE_LIMITED") return { code: "upstream_rate_limit", message: "Microsoft temporarily rate-limited token refresh; retry later" };
  if (raw === "MICROSOFT_TOKEN_SERVICE_UNAVAILABLE") return { code: "upstream_unavailable", message: "Microsoft token refresh is temporarily unavailable; retry later" };
  if (raw === "ACCOUNT_CREDENTIAL_MISSING" || raw === "ACCOUNT_CREDENTIAL_CORRUPT" || raw === "ACCOUNT_CREDENTIAL_MIRROR_UNAVAILABLE") return { code: "account_credential_error", message: "the selected Microsoft 365 account credential is unavailable" };
  if (raw === "ACCOUNT_RELAY_EGRESS_UNAVAILABLE") return { code: "account_egress_unavailable", message: "the selected Microsoft 365 account is assigned to an unavailable relay; switch it to direct Cloudflare egress or restore that relay" };
  if (raw === "ACCOUNT_QUEUE_TIMEOUT") return { code: "account_busy", message: "the Microsoft 365 account is busy; retry later" };
  if (raw === "NO_HEALTHY_ACCOUNT" || raw === "SESSION_ACCOUNT_COOLDOWN") return { code: "account_cooldown", message: "all eligible Microsoft 365 accounts are cooling down; retry later" };
  if (raw === "NO_USABLE_ACCOUNT") return { code: "account_pool_isolated", message: "all Microsoft 365 accounts require administrator attention" };
  if (raw === "CHAT_THROTTLED_QUOTA_EXHAUSTED") return { code: "upstream_throttled", message: "the selected Microsoft 365 account has exhausted its current allowance" };
  if (raw === "SESSION_ACCOUNT_ISOLATED" || raw === "SESSION_ACCOUNT_MISSING") return { code: "session_account_unavailable", message: "the account bound to this conversation is unavailable" };
  if (raw.startsWith("WS_DIAL_FAILED:") || raw === "WS_DIAL_ERROR") return { code: "upstream_connect_error", message: "failed to connect to Microsoft ChatHub" };
  if (raw.startsWith("RELAY_DIAL_FAILED:") || raw === "RELAY_DIAL_ERROR") return { code: "upstream_relay_error", message: "the configured egress relay could not connect to Microsoft ChatHub" };
  if (raw.startsWith("WS_HANDSHAKE_")) return { code: "upstream_connect_error", message: "Microsoft ChatHub rejected or returned an invalid realtime handshake" };
  if (raw.startsWith("WS_CLOSED_BEFORE_COMPLETION") || raw.startsWith("CHAT_CLOSED_BEFORE_COMPLETION") || raw === "WS_ERROR_BEFORE_COMPLETION") return { code: "upstream_disconnected", message: "Microsoft ChatHub disconnected before completion" };
  if (raw === "WS_READ_TIMEOUT" || raw === "CHAT_DEADLINE_EXCEEDED") return { code: "upstream_timeout", message: "Microsoft ChatHub timed out before completion" };
  if (["WS_FRAME_TOO_LARGE", "WS_BUFFER_TOO_LARGE", "CHAT_OUTPUT_TOO_LARGE", "CHAT_IMAGE_OUTPUT_TOO_LARGE"].includes(raw)) return { code: "upstream_payload_too_large", message: "Microsoft ChatHub exceeded the gateway's bounded frame or output limit" };
  if (raw === "INVALID_CHAT_HUB_ATTACHMENTS") return { code: "invalid_upstream_attachment", message: "the normalized image attachment could not be encoded for Microsoft ChatHub" };
  if (raw.startsWith("CHAT_COMPLETION_ERROR") || raw.startsWith("CHAT_UPSTREAM_ERROR") || raw === "CHAT_RETURNED_NO_CONTENT") return { code: "upstream_response_error", message: "Microsoft ChatHub returned an incomplete or failed response" };
  return { code: "upstream_error", message: "Microsoft ChatHub request failed" };
}

/** Constant-sized diagnostic label. Never return an upstream suffix because it
 * may contain a URL, tenant identifier or other private response material. */
export function internalFailureCode(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : "";
  const prefix = raw.split(":", 1)[0].toUpperCase();
  if (/^[A-Z][A-Z0-9_]{1,63}$/u.test(prefix)) return prefix;
  const name = cause instanceof Error ? cause.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) ? name : "UnknownError";
}

async function body<T>(request: Request): Promise<T> {
  return readJSONLimited<T>(request, MAX_AI_REQUEST_BYTES);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];
  for (const raw of content) {
    const item = raw as Record<string, unknown>;
    if (["text", "input_text", "output_text"].includes(String(item.type ?? "")) && typeof item.text === "string") pieces.push(item.text);
    else if (["image", "image_url", "input_image"].includes(String(item.type ?? ""))) throw new Error("UNNORMALIZED_IMAGE_CONTENT");
  }
  return pieces.join("\n");
}

const IMAGE_CONTEXT_PLACEHOLDER = "[IMAGE ATTACHMENTS: binary data and URLs omitted from persistent conversation context]";

export interface PreparedMultimodalInput<T> {
  value: T;
  attachments: NormalizedImageAttachment[];
}

function persistentContent(normalized: NormalizedMultimodalContent): string {
  const parts = [normalized.text.trim()];
  if (normalized.attachments.length > 0) {
    parts.push(`${IMAGE_CONTEXT_PLACEHOLDER} (${normalized.attachments.length})`);
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * Normalize only the active Chat turn. Image bytes and signed URLs are handed
 * to ChatHub separately and are never copied into prompts, task anchors or the
 * portable session tail. Only user messages may introduce image inputs.
 */
export function prepareChatMultimodal(
  messages: Array<Record<string, unknown>>,
): PreparedMultimodalInput<Array<Record<string, unknown>>> {
  const normalized = normalizeMultimodalContents(messages.map((message) => message.content ?? ""));
  const value = messages.map((message, index) => {
    const content = normalized.contents[index];
    if (content.attachments.length > 0 && String(message.role ?? "user").toLowerCase() !== "user") {
      throw new MultimodalInputError("invalid_multimodal_content");
    }
    return { ...message, content: persistentContent(content) };
  });
  return { value, attachments: normalized.attachments };
}

/** Responses equivalent, including top-level input_text/input_image parts. */
export function prepareResponsesMultimodal(input: unknown): PreparedMultimodalInput<unknown> {
  if (typeof input === "string") return { value: input, attachments: [] };
  if (!Array.isArray(input)) throw new MultimodalInputError("invalid_multimodal_content");

  const targets: Array<{ index: number; field: "content" | "output" | "part"; role: string; value: unknown }> = [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MultimodalInputError("invalid_multimodal_content");
    }
    const item = raw as Record<string, unknown>;
    const type = String(item.type ?? "");
    const role = String(item.role ?? "").toLowerCase();
    if (type === "function_call_output") {
      targets.push({ index, field: "output", role: "tool", value: item.output ?? "" });
    } else if (type === "message" || role) {
      targets.push({ index, field: "content", role: role || "user", value: item.content ?? "" });
    } else if (["image", "image_url", "input_image", "input_text", "text"].includes(type)) {
      targets.push({ index, field: "part", role: "user", value: [item] });
    }
  }

  const normalized = normalizeMultimodalContents(targets.map((target) => target.value));
  const value = input.map((raw) => ({ ...(raw as Record<string, unknown>) }));
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    const content = normalized.contents[targetIndex];
    if (content.attachments.length > 0 && target.role !== "user") {
      throw new MultimodalInputError("invalid_multimodal_content");
    }
    const safe = persistentContent(content);
    if (target.field === "part") value[target.index] = { type: "input_text", text: safe };
    else value[target.index][target.field] = safe;
  }
  return { value, attachments: normalized.attachments };
}

interface PromptUnit<T> {
  items: T[];
  instruction: boolean;
  hasUser: boolean;
}

function chatPromptUnits(messages: Array<Record<string, unknown>>): Array<PromptUnit<Record<string, unknown>>> {
  const units: Array<PromptUnit<Record<string, unknown>>> = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    const role = String(message.role ?? "user").toLowerCase();
    const unit: PromptUnit<Record<string, unknown>> = {
      items: [message],
      instruction: role === "system" || role === "developer",
      hasUser: role === "user",
    };
    index += 1;
    // A call and every immediately following result are one causal unit. Tail
    // selection must never manufacture an orphan tool result.
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      while (index < messages.length && String(messages[index].role ?? "").toLowerCase() === "tool") {
        unit.items.push(messages[index++]);
      }
    }
    units.push(unit);
  }
  return units;
}

function responsesPromptUnits(input: unknown[]): Array<PromptUnit<unknown>> {
  const units: Array<PromptUnit<unknown>> = [];
  for (let index = 0; index < input.length;) {
    const item = input[index] as Record<string, unknown>;
    const role = String(item?.role ?? "").toLowerCase();
    const isToolProtocol = ["function_call", "function_call_output", "function_call_progress"].includes(String(item?.type ?? ""));
    const unit: PromptUnit<unknown> = {
      items: [input[index]],
      instruction: role === "system" || role === "developer",
      hasUser: role === "user",
    };
    index += 1;
    // Responses may group several calls followed by several outputs. Keep the
    // complete contiguous protocol run indivisible even though this gateway
    // itself advertises parallel_tool_calls=false.
    if (isToolProtocol) {
      while (index < input.length) {
        const next = input[index] as Record<string, unknown>;
        if (!["function_call", "function_call_output", "function_call_progress"].includes(String(next?.type ?? ""))) break;
        unit.items.push(input[index++]);
      }
    }
    units.push(unit);
  }
  return units;
}

function activePromptItems<T>(units: Array<PromptUnit<T>>, continuing: boolean): T[] {
  if (!continuing) return units.flatMap((unit) => unit.items);
  let lastUserUnit = -1;
  for (let index = 0; index < units.length; index += 1) {
    if (units[index].hasUser) lastUserUnit = index;
  }
  // A Responses continuation commonly contains only function_call_output.
  // With no user item, every supplied item belongs to the current turn.
  const activeStart = lastUserUnit >= 0 ? lastUserUnit : 0;
  return units.flatMap((unit, index) => unit.instruction || index >= activeStart ? unit.items : []);
}

/** Selects only the active turn when ChatHub already persists older turns. */
export function selectActiveChatMessages(messages: Array<Record<string, unknown>>, continuing: boolean): Array<Record<string, unknown>> {
  return activePromptItems(chatPromptUnits(messages), continuing);
}

async function mergeAndReserveTaskAnchors(
  session: DurableObjectStub<ChatSession>,
  lease: ChatLease,
  freshAnchors: TaskAnchor[],
  maxCharacters: number,
  maxTokens: number,
): Promise<{ prefix: string; promptCharacters: number; promptTokens: number }> {
  const anchors = await session.mergeTaskAnchors(lease.leaseId, freshAnchors);
  lease.taskAnchors = anchors;
  const reserved = reserveTaskAnchorContext(anchors, maxCharacters, maxTokens);
  return {
    prefix: reserved.context ? `${reserved.context}\n\n` : "",
    promptCharacters: maxCharacters - reserved.reservedCharacters,
    promptTokens: maxTokens - reserved.reservedTokens,
  };
}

interface ResponsesContinuationSelection {
  previousResponse?: boolean;
  pendingCallId?: string;
}

function selectPreviousResponseToolContinuation(input: unknown[], pendingCallId: string): unknown[] {
  let matchingCallIndex = -1;
  let firstMatchingResultIndex = -1;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index] as Record<string, unknown>;
    if (String(item?.call_id ?? "") !== pendingCallId) continue;
    if (item?.type === "function_call") matchingCallIndex = index;
    else if (["function_call_output", "function_call_progress"].includes(String(item?.type ?? "")) && firstMatchingResultIndex < 0) {
      firstMatchingResultIndex = index;
    }
  }

  // The previous response already persisted its user text, assistant output,
  // and function call in ChatHub. Only the matching result belongs to this
  // continuation. A user item after that call/result boundary is genuinely
  // new input and may safely accompany the result.
  const currentBoundary = matchingCallIndex >= 0 ? matchingCallIndex : firstMatchingResultIndex;
  return input.filter((raw, index) => {
    const item = raw as Record<string, unknown>;
    const role = String(item?.role ?? "").toLowerCase();
    if (role === "system" || role === "developer") return true;
    const type = String(item?.type ?? "");
    if (["function_call_output", "function_call_progress"].includes(type)
      && String(item?.call_id ?? "") === pendingCallId) return true;
    return role === "user" && currentBoundary >= 0 && index > currentBoundary;
  });
}

/** Responses equivalent; preserves call/output runs and output-only continuations. */
export function selectActiveResponsesInput(
  input: unknown,
  continuing: boolean,
  continuation: ResponsesContinuationSelection = {},
): unknown {
  if (!Array.isArray(input)) return input;
  if (continuing && continuation.previousResponse && continuation.pendingCallId) {
    return selectPreviousResponseToolContinuation(input, continuation.pendingCallId);
  }
  return activePromptItems(responsesPromptUnits(input), continuing);
}

function prefixWithinLimits(value: string, maxCharacters: number, maxTokens: number): string {
  if (value.length <= maxCharacters && estimatePromptTokens(value) <= maxTokens) return value;
  let end = 0;
  let asciiWordCharacters = 0;
  let asciiSyntaxCharacters = 0;
  let nonAsciiCharacters = 0;
  let emojiCharacters = 0;
  for (const character of value) {
    const nextEnd = end + character.length;
    if (nextEnd > maxCharacters) break;
    if (!/\s/u.test(character)) {
      if ((character.codePointAt(0) ?? 0) <= 0x7f) {
        if (/[A-Za-z0-9_]/u.test(character)) asciiWordCharacters += 1;
        else asciiSyntaxCharacters += 1;
      }
      else if (/\p{Extended_Pictographic}/u.test(character)) emojiCharacters += 1;
      else nonAsciiCharacters += 1;
    }
    const estimatedTokens = Math.ceil(asciiWordCharacters / 4)
      + Math.ceil(asciiSyntaxCharacters / 2)
      + nonAsciiCharacters
      + emojiCharacters * 2;
    if (estimatedTokens > maxTokens) break;
    end = nextEnd;
  }
  return value.slice(0, end);
}

function boundPrompt(
  segments: Array<{ role: string; value: string }>,
  maxCharacters: number,
  maxTokens = Number.POSITIVE_INFINITY,
): string {
  const instructionIndexes = new Set<number>();
  const instructions: string[] = [];
  const instructionBudget = Math.floor(maxCharacters / 3);
  const instructionTokenBudget = Math.floor(maxTokens / 3);
  let instructionLength = 0;
  let instructionTokens = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (["SYSTEM", "DEVELOPER"].includes(segments[index].role)) instructionIndexes.add(index);
  }
  // Preserve the most recent instruction layers. Older duplicated system
  // prompts from compatibility clients are the first context to trim.
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (!instructionIndexes.has(index)) continue;
    const separator = instructions.length > 0 ? 2 : 0;
    const availableCharacters = instructionBudget - instructionLength - separator;
    const availableTokens = instructionTokenBudget - instructionTokens;
    if (availableCharacters <= 0 || availableTokens <= 0) break;
    const value = segments[index].value;
    const marker = "\n[INSTRUCTION TRUNCATED]";
    const fits = value.length <= availableCharacters && estimatePromptTokens(value) <= availableTokens;
    const bounded = fits
      ? value
      : `${prefixWithinLimits(
          value,
          Math.max(0, availableCharacters - marker.length),
          Math.max(0, availableTokens - estimatePromptTokens(marker)),
        )}${marker}`.slice(0, availableCharacters);
    instructions.unshift(bounded);
    instructionLength += bounded.length + separator;
    instructionTokens += estimatePromptTokens(bounded);
  }

  const instruction = instructions.join("\n\n");
  const newest: string[] = [];
  const historyBudget = maxCharacters - instruction.length - (instruction ? 2 : 0);
  const historyTokenBudget = maxTokens - estimatePromptTokens(instruction);
  let historyLength = 0;
  let historyTokens = 0;
  let overflowIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (instructionIndexes.has(index)) continue;
    const value = segments[index].value;
    const separator = newest.length > 0 ? 2 : 0;
    const valueTokens = estimatePromptTokens(value);
    if (value.length + separator <= historyBudget - historyLength && valueTokens <= historyTokenBudget - historyTokens) {
      newest.unshift(value);
      historyLength += value.length + separator;
      historyTokens += valueTokens;
      continue;
    }
    overflowIndex = index;
    break;
  }

  const marker = "[CONTEXT TRUNCATED: oldest non-instruction turns omitted]";
  if (overflowIndex >= 0) {
    const markerCharacters = marker.length + (newest.length > 0 ? 2 : 0);
    const markerTokens = estimatePromptTokens(marker);
    if (historyLength + markerCharacters <= historyBudget && historyTokens + markerTokens <= historyTokenBudget) newest.unshift(marker);
  }
  const parts = instruction ? [instruction] : [];
  parts.push(...newest);
  const result = parts.join("\n\n");
  if (result.length > maxCharacters || estimatePromptTokens(result) > maxTokens) throw new Error("CURRENT_TURN_TOO_LARGE");
  return result;
}

const PORTABLE_TURN_SEPARATOR = "\n\u001eM365_PORTABLE_TURN_V1\u001f\n";

export function assistantVisibleText(result: ChatHubResult): string {
  const imageLines = (result.images ?? []).map((url, index) => `![Generated image ${index + 1}](${url})`);
  return [result.text.trim(), ...imageLines].filter(Boolean).join("\n\n");
}

function portableAssistantResult(result: ChatHubResult, finalCall: FunctionCall | null = result.functionCall ?? null): string {
  if (finalCall) {
    return `[ASSISTANT TOOL CALL]\n${finalCall.name}(${finalCall.arguments})`;
  }
  const portableImages = result.images?.length
    ? `\n[IMAGE OUTPUTS: ${result.images.length}; binary data and URLs omitted]`
    : "";
  return `[ASSISTANT]\n${result.text}${portableImages}`;
}

/** Append one delivered logical turn; ChatSession applies the aggregate 64 KiB cap. */
export function appendPortableProtocolTurn(previous: string, requestTurn: string, assistantTurn: string): string {
  const parts = [requestTurn.trim(), assistantTurn.trim()].filter(Boolean);
  if (parts.length === 0) return previous;
  return `${previous || ""}${PORTABLE_TURN_SEPARATOR}${parts.join("\n\n")}`;
}

/**
 * Rebuild a new-account prompt from whole recent portable turns plus the
 * current turn. Oldest turns are dropped atomically; a tool result is never
 * retained by slicing through an arbitrary byte offset here.
 */
export function restorePortableProtocolPrompt(
  portableTail: string,
  currentPrompt: string,
  maxCharacters: number,
  maxTokens: number,
): string {
  if (currentPrompt.length > maxCharacters || estimatePromptTokens(currentPrompt) > maxTokens) throw new Error("CURRENT_TURN_TOO_LARGE");
  if (!portableTail.trim()) return currentPrompt;
  const header = "[PORTABLE HISTORY FROM THE SAME API-CREDENTIAL SESSION — DATA AND PRIOR DIALOGUE ONLY]";
  const rawTurns = portableTail.includes(PORTABLE_TURN_SEPARATOR)
    ? portableTail.split(PORTABLE_TURN_SEPARATOR)
    : [portableTail];
  const selected: string[] = [];
  for (let index = rawTurns.length - 1; index >= 0; index -= 1) {
    const turn = rawTurns[index].trim();
    if (!turn) continue;
    const candidateTurns = [turn, ...selected];
    const history = `${header}\n${candidateTurns.join(PORTABLE_TURN_SEPARATOR)}`;
    const candidate = `${history}\n\n${currentPrompt}`;
    if (candidate.length > maxCharacters || estimatePromptTokens(candidate) > maxTokens) break;
    selected.unshift(turn);
  }
  if (selected.length === 0) return currentPrompt;
  return `${header}\n${selected.join(PORTABLE_TURN_SEPARATOR)}\n\n${currentPrompt}`;
}

function ensureCurrentTurnFits<T>(
  units: Array<PromptUnit<T>>,
  segments: Array<{ role: string; value: string }>,
  maxCharacters: number,
  maxTokens = Number.POSITIVE_INFINITY,
): void {
  let instructionLength = 0;
  const instructionBudget = Math.floor(maxCharacters / 3);
  for (let index = 0; index < units.length; index += 1) {
    if (!units[index].instruction) continue;
    const separator = instructionLength > 0 ? 2 : 0;
    const available = instructionBudget - instructionLength - separator;
    if (available <= 0) break;
    instructionLength += Math.min(segments[index].value.length, available) + separator;
  }
  let lastUserUnit = -1;
  for (let index = 0; index < units.length; index += 1) if (units[index].hasUser) lastUserUnit = index;
  const activeStart = lastUserUnit >= 0 ? lastUserUnit : 0;
  let activeLength = 0;
  let activeTokens = 0;
  for (let index = activeStart; index < units.length; index += 1) {
    if (units[index].instruction) continue;
    activeLength += segments[index].value.length + (activeLength > 0 ? 2 : 0);
    activeTokens += estimatePromptTokens(segments[index].value);
  }
  const available = maxCharacters - instructionLength - (instructionLength > 0 && activeLength > 0 ? 2 : 0);
  if (activeLength > available) throw new Error("CURRENT_TURN_TOO_LARGE");
  const instructionText = segments.filter((_, index) => units[index]?.instruction).map((segment) => segment.value).join("\n\n");
  const reservedInstructionTokens = Math.min(Math.floor(maxTokens / 3), estimatePromptTokens(instructionText));
  if (activeTokens > maxTokens - reservedInstructionTokens) throw new Error("CURRENT_TURN_TOO_LARGE");
}

export function chatPrompt(
  messages: Array<Record<string, unknown>> = [],
  maxCharacters = 3_000_000,
  maxTokens = Number.POSITIVE_INFINITY,
): string {
  if (messages.length === 0) throw new Error("EMPTY_PROMPT");
  const units = chatPromptUnits(messages);
  const segments = units.map((unit) => {
    const rendered = unit.items.map((message) => {
      const role = String(message.role ?? "user").toUpperCase();
      let text = contentText(message.content);
      if (message.tool_calls) text += `\nTool calls: ${JSON.stringify(message.tool_calls)}`;
      if (message.tool_call_id) text = `Tool result for ${String(message.tool_call_id)}:\n${text}`;
      return `[${role}]\n${text}`;
    }).join("\n\n");
    const role = unit.instruction ? String(unit.items[0].role ?? "system").toUpperCase() : "TURN";
    return { role, value: rendered };
  });
  ensureCurrentTurnFits(units, segments, maxCharacters, maxTokens);
  const result = boundPrompt(segments, maxCharacters, maxTokens);
  if (!result.trim()) throw new Error("EMPTY_PROMPT");
  return result;
}

export function responsesPrompt(input: unknown, maxCharacters = 3_000_000, maxTokens = Number.POSITIVE_INFINITY): string {
  if (typeof input === "string") {
    if (!input.trim()) throw new Error("EMPTY_PROMPT");
    // A string is one indivisible active user turn. Silently deleting its
    // beginning changes the task, unlike trimming older persisted history.
    if (input.length > maxCharacters || estimatePromptTokens(input) > maxTokens) throw new Error("CURRENT_TURN_TOO_LARGE");
    return input;
  }
  if (!Array.isArray(input)) throw new Error("EMPTY_PROMPT");
  const units = responsesPromptUnits(input);
  const segments = units.map((unit) => {
    const rendered: string[] = [];
    for (const raw of unit.items) {
      const item = raw as Record<string, unknown>;
      if (item.type === "function_call") {
        rendered.push(`[ASSISTANT TOOL CALL ${String(item.call_id ?? "unknown")}]\n${String(item.name ?? "unknown")}(${typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})})`);
      } else if (item.type === "function_call_output") {
        rendered.push(`[TOOL RESULT ${String(item.call_id ?? "unknown")}]\n${contentText(item.output) || String(item.output ?? "")}`);
      } else if (item.type === "message" || item.role) {
        const role = String(item.role ?? "user").toUpperCase();
        rendered.push(`[${role}]\n${contentText(item.content)}`);
      } else if (typeof item.text === "string") rendered.push(item.text);
    }
    const role = unit.instruction ? String((unit.items[0] as Record<string, unknown>)?.role ?? "system").toUpperCase() : "TURN";
    return { role, value: rendered.join("\n\n") };
  }).filter((segment) => segment.value.length > 0);
  // Filtering empty unknown items would desynchronize indices; those items do
  // not belong to the prompt protocol, so rebuild matching non-empty units.
  const renderedUnits = units.filter((unit) => unit.items.some((raw) => {
    const item = raw as Record<string, unknown>;
    return item?.type === "function_call" || item?.type === "function_call_output" || item?.type === "message" || Boolean(item?.role) || typeof item?.text === "string";
  }));
  ensureCurrentTurnFits(renderedUnits, segments, maxCharacters, maxTokens);
  const result = boundPrompt(segments, maxCharacters, maxTokens);
  if (!result.trim()) throw new Error("EMPTY_PROMPT");
  return result;
}

export async function accountForLease(
  env: Env,
  session: DurableObjectStub<ChatSession>,
  lease: ChatLease,
): Promise<{ account: AccountSelection; rebound: boolean }> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const selection = await state.selectAccount(lease.accountId);
  if (selection) {
    if (!lease.accountId) Object.assign(lease, await session.bindAccount(lease.leaseId, selection.accountId));
    return { account: selection, rebound: false };
  }

  if (lease.accountId && lease.started && lease.accountLocked) {
    // A Microsoft conversation belongs to the account that created it, but a
    // client conversation belongs to the API credential. When the global
    // single-active route advances, move only the portable client state and
    // generate fresh upstream coordinates. Never wake the sleeping account.
    const active = await state.selectAccount();
    if (active && active.accountId !== lease.accountId) {
      Object.assign(lease, await session.rebindCommittedAccount(lease.leaseId, lease.accountId, active.accountId));
      return { account: active, rebound: true };
    }
  }

  if (lease.accountId) {
    const availability = await state.accountAvailability(lease.accountId);
    if (availability.isolated) throw new Error("SESSION_ACCOUNT_ISOLATED");
    if (availability.retryAfterMs > 0) throw new Error("SESSION_ACCOUNT_COOLDOWN");
    throw new Error("SESSION_ACCOUNT_MISSING");
  }
  {
    const pool = await state.accountPoolStatus();
    if (pool.total === 0) throw new Error("NO_ACCOUNT");
    if (pool.cooling > 0) throw new Error("NO_HEALTHY_ACCOUNT");
    throw new Error("NO_USABLE_ACCOUNT");
  }
}

async function acquireConversationLease(
  session: DurableObjectStub<ChatSession>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<ChatLease> {
  for (;;) {
    if (signal?.aborted) throw new Error("REQUEST_ABORTED");
    try {
      return await session.acquire();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      if (code !== "CONVERSATION_BUSY") throw cause;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("CONVERSATION_BUSY");
      await abortableDelay(Math.min(250, remaining), signal);
    }
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("REQUEST_ABORTED"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("REQUEST_ABORTED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireUpstreamGate(env: Env, accountId: string, signal: AbortSignal | undefined, deadlineAt: number): Promise<{ accountId: string; leaseId: string }> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const deadline = Math.min(Date.now() + 120_000, deadlineAt);
  const waiterId = `waiter-${crypto.randomUUID()}`;
  let acquired = false;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("REQUEST_ABORTED");
      const lease = await state.acquireUpstream(accountId, waiterId);
      if (lease.ok) {
        acquired = true;
        return { accountId, leaseId: lease.leaseId };
      }
      await abortableDelay(Math.max(1, Math.min(1_000, lease.retryAfterMs, deadline - Date.now())), signal);
    }
    if (Date.now() >= deadlineAt) throw new Error("CHAT_DEADLINE_EXCEEDED");
    throw new Error("ACCOUNT_QUEUE_TIMEOUT");
  } finally {
    // Cancelled and timed-out requests must not remain at the head of the
    // strongly ordered queue. Successful acquisition removes the waiter in the
    // same TenantState transaction/turn that grants the lease.
    if (!acquired) await state.cancelUpstreamWaiter(accountId, waiterId);
  }
}

function chatSession(env: Env, key: string): DurableObjectStub<ChatSession> {
  return env.CHATS.getByName(key);
}

function stableSessionCandidate(request: Request, bodyValue: { session_key?: string; conversation_id?: string }): string {
  const candidate = bodyValue.session_key?.trim()
    || bodyValue.conversation_id?.trim()
    || request.headers.get("X-Session-Key")?.trim()
    || "";
  if (candidate.length > 1_024) throw new Error("INVALID_SESSION_KEY");
  return candidate;
}

function apiCredential(request: Request): string {
  const apiKey = request.headers.get("X-API-Key")?.trim();
  if (apiKey) return apiKey;
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : authorization;
}

async function scopedOpaqueKey(request: Request, namespace: string, candidate: string): Promise<string> {
  const stable = await sha256(`${namespace}\u0000${candidate.trim()}`);
  const scoped = await sha256(`m365-session-scope\u0000${apiCredential(request)}\u0000${stable}`);
  return `responses_${scoped.slice(0, 32)}`;
}

/**
 * Stable Chat identifiers are private to the presented API credential. Two
 * callers choosing the same friendly session key must never share Microsoft
 * conversation coordinates or tool evidence.
 */
export async function chatSessionKey(
  request: Request,
  bodyValue: { session_key?: string; conversation_id?: string },
): Promise<string> {
  const candidate = stableSessionCandidate(request, bodyValue);
  return candidate
    ? scopedOpaqueKey(request, "m365-chat-session", candidate)
    : `chat:${crypto.randomUUID()}`;
}

export async function responsesSessionKey(request: Request, bodyValue: ResponsesBody): Promise<string> {
  if (bodyValue.new_conversation) return `responses:${crypto.randomUUID()}`;
  const previous = bodyValue.previous_response_id?.trim();
  if (previous) return scopedOpaqueKey(request, "m365-response-id", previous);
  const explicit = stableSessionCandidate(request, bodyValue);
  const candidates: unknown[] = [explicit, bodyValue.prompt_cache_key];
  for (const key of ["thread_id", "session_id", "root_turn_id"]) candidates.push(bodyValue.client_metadata?.[key]);
  if (typeof bodyValue.conversation === "string") candidates.push(bodyValue.conversation);
  else if (bodyValue.conversation && typeof bodyValue.conversation === "object") {
    candidates.push((bodyValue.conversation as { id?: unknown }).id);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return scopedOpaqueKey(request, "m365-responses-session", candidate);
    }
  }
  return `responses:${crypto.randomUUID()}`;
}

async function exchange(
  env: Env,
  session: DurableObjectStub<ChatSession>,
  lease: ChatLease,
  account: AccountSelection,
  prompt: string,
  tone: string,
  tools: unknown[] | undefined,
  toolChoice: unknown,
  attachments: ReadonlyArray<NormalizedImageAttachment> | undefined,
  emit?: (delta: string) => void,
  signal?: AbortSignal,
  gateLifecycle?: UpstreamGateLifecycle,
  deadlineAt?: number,
  metrics?: RequestMetricTracker,
): Promise<ChatHubResult> {
  const logicalDeadline = deadlineAt ?? logicalRequestDeadlineAt();
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  let token = account.token;
  const attemptedAccounts = new Set<string>([lease.accountId]);
  metrics?.setAccountId(account.accountId);
  for (;;) {
    let gate: { accountId: string; leaseId: string } | undefined;
    let lifecycleStarted = false;
    let visible = lease.accountLocked;
    let accountLock: Promise<void> | undefined;
    const pendingDeltas: string[] = [];
    const guardedEmit = emit
      ? (delta: string): void => {
          if (!delta) return;
          if (visible) {
            emit(delta);
            return;
          }
          pendingDeltas.push(delta);
          if (!accountLock) {
            // Persist account stickiness before exposing the first semantic
            // delta. Heartbeats do not lock the account; real output does.
            accountLock = session.markAccountLocked(lease.leaseId, lease.accountId).then(() => {
              visible = true;
              lease.accountLocked = true;
              for (const buffered of pendingDeltas.splice(0)) emit(buffered);
            });
          }
        }
      : undefined;
    try {
      if (gateLifecycle) {
        lifecycleStarted = gateLifecycle.begin();
        if (!lifecycleStarted) throw new Error("REQUEST_ABORTED");
      }
      gate = await acquireUpstreamGate(env, lease.accountId, signal, logicalDeadline);
      if (gateLifecycle && !gateLifecycle.attach(gate)) throw new Error("REQUEST_ABORTED");
      const result = await durableChatHub(env, lease.accountId, token, {
        text: prompt,
        conversationId: lease.conversationId,
        sessionId: lease.sessionId,
        started: !lease.started,
        tone,
        attachments,
        tools,
        toolChoice,
        signal,
        deadlineAt: logicalDeadline,
      }, accountChatHubRelay(env, account.egress));
      if (guardedEmit && result.text) guardedEmit(result.text);
      if (accountLock) await accountLock;
      // Keep the conversation lease until tool routing and completion-evidence
      // guards have produced the exact downstream-visible output. Releasing it
      // here creates a race where the next turn can observe a half-completed
      // context or omit the just-finished turn entirely.
      // ChatHub already turns an empty terminal result with exhausted quota
      // into CHAT_THROTTLED_QUOTA_EXHAUSTED. A usable terminal result can also
      // carry CostQuota=0 and must remain a success; cooling that account here
      // changes the active route after a successful turn and can duplicate the
      // next tool step on another account.
      await state.reportAccountSuccess(lease.accountId);
      return result;
    } catch (originalCause) {
      let cause = originalCause;
      if (accountLock) {
        try {
          await accountLock;
        } catch (lockCause) {
          cause = lockCause;
        }
      }
      const disposition = classifyAccountFailure(cause);
      if (disposition) {
        try {
          await state.reportAccountFailure(lease.accountId, disposition.kind, account.routeEpoch);
        } catch (healthCause) {
          console.error(JSON.stringify({
            event: "account_health_update_failed",
            kind: disposition.kind,
            code: healthCause instanceof Error ? healthCause.message : "unknown",
          }));
        }
      }
      const invocationSubmitted = chatHubInvocationWasSubmitted(cause);
      const mayFailOver = mayFailOverExchange(
        disposition?.mayFailOverBeforeVisibleOutput,
        lease.started,
        lease.accountLocked,
        visible,
        !mayFailOverChatHubFailure(cause),
        logicalDeadline,
      // A single logical request may use only the current active account and
      // its immediate successor. Scanning the whole pool after a run of
      // transient failures contacts dormant accounts and creates the exact
      // burst/fingerprint pattern that production account isolation is meant
      // to prevent.
      ) && attemptedAccounts.size < 2;
      if (mayFailOver) {
        let next: AccountSelection | null;
        try {
          next = await state.selectAccount("", [...attemptedAccounts]);
        } catch (selectionCause) {
          await session.release(lease.leaseId);
          throw selectionCause;
        }
        if (next) {
          const replacement = await session.switchUncommittedAccount(lease.leaseId, lease.accountId, next.accountId);
          Object.assign(lease, replacement);
          attemptedAccounts.add(next.accountId);
          token = next.token;
          adoptAccountSelection(account, next);
          metrics?.setAccountId(next.accountId);
          continue;
        }
      }
      // Once chatPayload reached Microsoft, the old conversation may contain
      // a half-turn that the client never received. Tombstone those
      // coordinates while retaining account stickiness; a normal release
      // would silently continue from polluted upstream state next round.
      if (invocationSubmitted) await session.abandonFailedUpstream(lease.leaseId);
      else await session.release(lease.leaseId);
      throw cause;
    } finally {
      try {
        if (gate) {
          if (gateLifecycle) await gateLifecycle.release(gate);
          else await state.releaseUpstream(gate.accountId, gate.leaseId);
        }
      } finally {
        if (lifecycleStarted) gateLifecycle?.end();
      }
    }
  }
}

async function completeFinalTurn(
  session: DurableObjectStub<ChatSession>,
  lease: ChatLease,
  result: ChatHubResult,
  protocolTail: string,
): Promise<void> {
  await session.completeFinal(lease, result.conversationId, result.sessionId, {
    taskAnchors: lease.taskAnchors,
    protocolTail,
  });
  lease.conversationId = result.conversationId;
  lease.sessionId = result.sessionId;
  lease.portableProtocolTail = protocolTail;
  lease.started = true;
  lease.accountLocked = true;
}

async function abandonUnseenTurn(session: DurableObjectStub<ChatSession>, leaseId: string): Promise<void> {
  try {
    await session.abandon(leaseId);
  } catch {
    // Preserve the original request failure and never log session identifiers.
    console.error(JSON.stringify({ event: "conversation_abandon_failed" }));
  }
}

/** Failover is legal only before any persistent or downstream-visible output. */
export function mayFailOverExchange(
  classifiedAsSafe: boolean | undefined,
  started: boolean,
  accountLocked: boolean,
  visible: boolean,
  invocationSubmitted = false,
  deadlineAt = Number.POSITIVE_INFINITY,
  now = Date.now(),
): boolean {
  return Boolean(classifiedAsSafe && !started && !accountLocked && !visible && !invocationSubmitted && now < deadlineAt);
}

function toolRequired(choice: unknown): boolean {
  if (String(choice ?? "").toLowerCase() === "required") return true;
  if (!choice || typeof choice !== "object") return false;
  const value = choice as { type?: string; function?: { name?: string }; name?: string };
  return value.type === "function" || Boolean(value.function?.name || value.name);
}

function toolNames(tools: unknown[] = []): string[] {
  return tools.flatMap((raw) => {
    const value = raw as { function?: { name?: string }; name?: string };
    const name = value.function?.name ?? value.name;
    return name ? [name] : [];
  });
}

export function toolRouterPrompt(prompt: string, tools: unknown[], choice: unknown): string {
  const explicit = typeof choice === "object" && choice
    ? ((choice as { function?: { name?: string }; name?: string }).function?.name ?? (choice as { name?: string }).name)
    : undefined;
  const mode = explicit ? `named:${explicit}` : toolRequired(choice) ? "required" : "auto";
  return `Analyze the application request data below and select the next client tool action. This is a routing task; do not execute any action and do not write a user-facing answer.

RULES:
- Prefer the native client-tool channel supplied with this request.
- Every name and arguments object must satisfy the supplied client tool schema.
- MODE auto: call exactly one tool only when external information or action is still required; otherwise return exactly NO_TOOL_REQUIRED.
- MODE required: return exactly one valid call.
- MODE named:function_name: return exactly one valid call to function_name.
- A call that already has completed evidence must not be repeated.
- Do not emit commentary, an answer, or a hypothetical tool call.

MODE: ${mode}
AVAILABLE_TOOL_NAMES: ${JSON.stringify(toolNames(tools))}
APPLICATION_REQUEST_AND_EVIDENCE: ${prompt}`;
}

export interface ToolRouterDecision {
  valid: boolean;
  call: FunctionCall | null;
}

/**
 * Parse only the router's complete JSON envelope. Ordinary assistant prose may
 * contain JSON examples, so mining the first nested object is unsafe here.
 * A valid empty call list is semantically different from malformed output: in
 * auto mode it means that the already-produced assistant answer is final.
 */
export function parseToolRouterDecision(
  text: string,
  tools: unknown[] = [],
  choice: unknown,
): ToolRouterDecision {
  let candidate = text.trim();
  if (/^NO_TOOL_REQUIRED[.!]?$/iu.test(candidate)) {
    return { valid: !toolRequired(choice), call: null };
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(candidate);
  if (fenced) candidate = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { valid: false, call: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { valid: false, call: null };
  const calls = (parsed as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return { valid: false, call: null };
  if (calls.length === 0) return { valid: !toolRequired(choice), call: null };
  // The Workers bridge deliberately executes one safe call at a time. A model
  // returning several calls is not silently truncated because that would lose
  // call identities and make later tool results impossible to reconcile.
  if (calls.length !== 1) return { valid: false, call: null };
  const names = toolNames(tools);
  const explicit = typeof choice === "object" && choice
    ? ((choice as { function?: { name?: string }; name?: string }).function?.name ?? (choice as { name?: string }).name)
    : undefined;
  const call = parseFunctionCall(candidate, tools, explicit);
  if (!call || !names.includes(call.name)) {
    return { valid: false, call: null };
  }
  if (explicit && call.name !== explicit) return { valid: false, call: null };
  return { valid: true, call };
}

/** Keep a selected call causally attached to the upstream conversation that
 * actually proposed it. Otherwise the next tool result resumes an unrelated
 * assistant-answer conversation and ChatHub loses or repeats the task. */
export function adoptToolRouterResult(target: ChatHubResult, router: ChatHubResult): void {
  target.text = router.text;
  target.conversationId = router.conversationId;
  target.sessionId = router.sessionId;
  target.requestId = router.requestId;
  target.images = router.images;
  target.functionCall = router.functionCall;
  target.throttling = router.throttling;
}

function toolRouterTone(tone: string): string {
  if (tone.startsWith("Gpt_5_5_")) return "Gpt_5_5_Chat";
  if (tone.startsWith("Gpt_5_6_")) return "Gpt_5_6_Chat";
  // Claude_Sonnet is a valid answer tone but is inconsistent at emitting the
  // gateway's strict routing envelope. Use the verified deterministic GPT
  // router for this hidden formatting pass; the user-facing answer remains on
  // the requested Claude tone after tool evidence is returned.
  if (tone.startsWith("Claude_Sonnet")) return "Gpt_5_6_Chat";
  return tone.replace("_Reasoning", "_Chat");
}

export function isolatedToolRouterCoordinates(): { conversationId: string; sessionId: string } {
  return { conversationId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
}

async function routerExchange(
  env: Env,
  account: AccountSelection,
  prompt: string,
  tone: string,
  signal: AbortSignal | undefined,
  gateLifecycle: UpstreamGateLifecycle | undefined,
  deadlineAt: number,
  tools: unknown[] | undefined,
  toolChoice: unknown,
): Promise<ChatHubResult> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  let gate: { accountId: string; leaseId: string } | undefined;
  let lifecycleStarted = false;
  try {
    if (gateLifecycle) {
      lifecycleStarted = gateLifecycle.begin();
      if (!lifecycleStarted) throw new Error("REQUEST_ABORTED");
    }
    gate = await acquireUpstreamGate(env, account.accountId, signal, deadlineAt);
    if (gateLifecycle && !gateLifecycle.attach(gate)) throw new Error("REQUEST_ABORTED");
    const coordinates = isolatedToolRouterCoordinates();
    const result = await durableChatHub(env, account.accountId, account.token, {
      text: prompt,
      ...coordinates,
      started: true,
      tone,
      tools,
      toolChoice,
      signal,
      deadlineAt,
    }, accountChatHubRelay(env, account.egress));
    // As in the normal exchange, only ChatHub's structured empty-quota error
    // is a rate-limit failure. A complete router envelope with CostQuota=0 is
    // still a successful invocation and must not advance the active account.
    await state.reportAccountSuccess(account.accountId);
    return result;
  } catch (cause) {
    const disposition = classifyAccountFailure(cause);
    if (disposition) {
      try {
        await state.reportAccountFailure(account.accountId, disposition.kind, account.routeEpoch);
      } catch {
        console.error(JSON.stringify({ event: "tool_router_account_health_update_failed", kind: disposition.kind }));
      }
    }
    throw cause;
  } finally {
    try {
      if (gate) {
        if (gateLifecycle) await gateLifecycle.release(gate);
        else await state.releaseUpstream(gate.accountId, gate.leaseId);
      }
    } finally {
      if (lifecycleStarted) gateLifecycle?.end();
    }
  }
}

async function resolveFunctionCall(
  env: Env,
  account: AccountSelection,
  initialResult: ChatHubResult,
  originalPrompt: string,
  tone: string,
  tools: unknown[] | undefined,
  toolChoice: unknown,
  ledger: ToolLedger,
  signal?: AbortSignal,
  gateLifecycle?: UpstreamGateLifecycle,
  deadlineAt?: number,
  metrics?: RequestMetricTracker,
): Promise<FunctionCall | null> {
  const logicalDeadline = deadlineAt ?? logicalRequestDeadlineAt();
  if (ledger.roundCount >= ledger.maxToolRounds) {
    const rejection = toolGuardFailure("tool_round_limit");
    initialResult.text = toolRecoveryTermination(rejection.publicMessage);
    return null;
  }
  const names = toolNames(tools);
  const explicit = typeof toolChoice === "object" && toolChoice
    ? ((toolChoice as { function?: { name?: string }; name?: string }).function?.name ?? (toolChoice as { name?: string }).name)
    : undefined;
  const required = toolRequired(toolChoice);
  const inferred = explicit || (required && names.length === 1 ? names[0] : undefined);
  const allowed = explicit ? [explicit] : names;
  let call = initialResult.functionCall && allowed.includes(initialResult.functionCall.name)
    ? initialResult.functionCall
    : parseFunctionCall(initialResult.text, tools, inferred);
  let recoveryReason = "";
  if (call) {
    const guarded = await guardedFunctionCall(call, ledger);
    if (guarded.call) return guarded.call;
    if (guarded.rejection?.publicCode === "tool_round_limit") {
      initialResult.text = toolRecoveryTermination(guarded.rejection.publicMessage);
      return null;
    }
    recoveryReason = guarded.rejection?.publicMessage ?? "the proposed tool action is not safe to repeat unchanged";
  }
  if (names.length === 0) throw new Error("TOOL_CALL_GENERATION_FAILED");

  // The native tool-enabled answer is already the first model decision. Permit
  // one isolated repair only; more attempts increase latency and can detach the
  // selected action from the caller's evidence.
  for (let attempt = 0; attempt < 1; attempt += 1) {
    if (Date.now() >= logicalDeadline) throw new Error("CHAT_DEADLINE_EXCEEDED");
    const recoveryConstraint = recoveryReason
      ? `RECOVERY CONSTRAINT: ${recoveryReason}. Select a different tool or materially different arguments. Never repeat the blocked action.\n`
      : "";
    const routePrompt = `${attempt ? "The previous routing response was invalid or still blocked. Re-evaluate from the source data.\n" : ""}${recoveryConstraint}${toolRouterPrompt(originalPrompt, tools ?? [], toolChoice)}`;
    metrics?.observeInputText(routePrompt);
    // Router repair is an independent upstream conversation. Writing hidden
    // formatting prompts into the user's ChatHub conversation causes the next
    // real turn to inherit invalid-repair text and eventually forget its task.
    const repair = await routerExchange(
      env,
      account,
      routePrompt,
      toolRouterTone(tone),
      signal,
      gateLifecycle,
      logicalDeadline,
      tools,
      toolChoice,
    );
    observeMetricResult(metrics, repair);
    const decision = parseToolRouterDecision(repair.text, tools, toolChoice);
    call = repair.functionCall ?? decision.call ?? parseFunctionCall(repair.text, tools, inferred);
    if (call && allowed.includes(call.name)) {
      const guarded = await guardedFunctionCall(call, ledger);
      if (guarded.call) {
        adoptToolRouterResult(initialResult, repair);
        return guarded.call;
      }
      if (guarded.rejection?.publicCode === "tool_round_limit") {
        initialResult.text = toolRecoveryTermination(guarded.rejection.publicMessage);
        return null;
      }
      recoveryReason = guarded.rejection?.publicMessage ?? recoveryReason;
      continue;
    }
    if (decision.valid && !call) return null;
    // `auto` is permission, not an obligation. Once the native tool channel
    // has returned no valid call, continue to the ordinary answer pass. The
    // answer exchange deliberately receives no tools, so this cannot execute
    // a hidden remote substitute or recurse into routing again.
    if (!required) return null;
  }
  if (!recoveryReason) recoveryReason = "the tool router did not produce a valid decision after two attempts";
  // Returning an ordinary completed assistant turn is intentional. OpenCode
  // and Codex automatically replay some non-2xx tool errors, turning a guard
  // into an infinite request loop. A bounded, explicit stop is terminal and
  // leaves the next user turn free to choose a changed action.
  initialResult.text = toolRecoveryTermination(recoveryReason);
  return null;
}

function toolRoutingEnabled(tools: unknown[] | undefined, toolChoice: unknown): boolean {
  return Boolean(tools?.length) && String(toolChoice ?? "auto").toLowerCase() !== "none";
}

function isHostedExecutionSubstitution(text: string, tools: unknown[] | undefined, ledger: ToolLedger): boolean {
  if (ledger.completed.length > 0 || !toolNames(tools).includes("exec_command")) return false;
  return /(?:\/bin\/(?:ba)?sh|powershell\s*:\s*command not found|powershell[^\n]{0,80}(?:not installed|not found)|未安装\s*PowerShell|Linux\s*(?:container|容器|工具环境)|hosted\s+(?:shell|container))/iu.test(text);
}

type AssistantTurnResolution =
  | { kind: "upstream"; call: FunctionCall | null; result: ChatHubResult }
  | { kind: "terminal"; text: string };

/** Ask ChatHub once with the caller's native client tools. That single
 * conversation may yield either a validated ToolCall or an ordinary answer.
 * Splitting these outcomes across a hidden router and a second tool-less answer
 * loses causal context, doubles upstream work, and lets the answer pass invent
 * facts about a caller environment it cannot inspect. */
async function resolveAssistantTurn(
  env: Env,
  session: DurableObjectStub<ChatSession>,
  lease: ChatLease,
  account: AccountSelection,
  prompt: string,
  tone: string,
  tools: unknown[] | undefined,
  toolChoice: unknown,
  attachments: ReadonlyArray<NormalizedImageAttachment>,
  ledger: ToolLedger,
  completionLedger: ToolLedger,
  emit: ((delta: string) => void) | undefined,
  signal: AbortSignal | undefined,
  gateLifecycle: UpstreamGateLifecycle | undefined,
  deadlineAt: number,
  metrics?: RequestMetricTracker,
): Promise<AssistantTurnResolution> {
  const routingEnabled = toolRoutingEnabled(tools, toolChoice);
  const result = await exchange(
    env,
    session,
    lease,
    account,
    prompt,
    tone,
    routingEnabled ? tools : undefined,
    routingEnabled ? toolChoice : "none",
    attachments,
    emit,
    signal,
    gateLifecycle,
    deadlineAt,
    metrics,
  );
  observeMetricResult(metrics, result);

  // The ChatHub prompt is deliberately fail-closed when the caller's local
  // tool channel disappears during a long continuation. Do not expose the
  // sentinel as an ordinary answer: returning a terminal, retryable message
  // prevents a model variant from silently substituting a hosted Linux/shell
  // environment for the caller's Windows tools.
  if (routingEnabled && result.text.trim() === CLIENT_TOOL_UNAVAILABLE_SENTINEL) {
    return {
      kind: "terminal",
      text: toolRecoveryTermination("client tool runtime unavailable; resend the request with the local Windows tool channel"),
    };
  }

  if (routingEnabled) {
    const names = toolNames(tools);
    const explicit = typeof toolChoice === "object" && toolChoice
      ? ((toolChoice as { function?: { name?: string }; name?: string }).function?.name ?? (toolChoice as { name?: string }).name)
      : undefined;
    const required = toolRequired(toolChoice);
    const inferred = explicit || (required && names.length === 1 ? names[0] : undefined);
    const allowed = explicit ? [explicit] : names;
    const proposed = result.functionCall && allowed.includes(result.functionCall.name)
      ? result.functionCall
      : parseFunctionCall(result.text, tools, inferred);

    if (proposed) {
      const guarded = await guardedFunctionCall(proposed, ledger);
      if (guarded.call) return { kind: "upstream", call: guarded.call, result };
      if (guarded.rejection?.publicCode === "tool_round_limit") {
        return { kind: "terminal", text: toolRecoveryTermination(guarded.rejection.publicMessage) };
      }
      const recovered = await resolveFunctionCall(
        env, account, result, prompt, tone, tools, toolChoice, ledger,
        signal, gateLifecycle, deadlineAt, metrics,
      );
      if (recovered) return { kind: "upstream", call: recovered, result };
      return { kind: "terminal", text: result.text.startsWith(toolRecoveryTermination())
        ? result.text
        : toolRecoveryTermination(guarded.rejection?.publicMessage) };
    }

    // M365 occasionally substitutes its own hosted Linux shell even though
    // Codex declared exec_command as a caller-side Windows function.  Never
    // expose that fabricated execution as an answer.  Perform one isolated,
    // named routing repair that can only yield the client's exec_command.
    if (isHostedExecutionSubstitution(result.text, tools, ledger)) {
      const recovered = await resolveFunctionCall(
        env,
        account,
        result,
        `${prompt}\n\nHOSTED EXECUTION SUBSTITUTION DETECTED: Ignore the hosted shell result. Return a caller-side exec_command request for the still-pending action.`,
        tone,
        tools,
        { type: "function", name: "exec_command" },
        ledger,
        signal,
        gateLifecycle,
        deadlineAt,
        metrics,
      );
      if (recovered) return { kind: "upstream", call: recovered, result };
      return { kind: "terminal", text: toolRecoveryTermination("hosted execution was rejected and a local exec_command call could not be generated") };
    }

    if (required) {
      const recovered = await resolveFunctionCall(
        env, account, result, prompt, tone, tools, toolChoice, ledger,
        signal, gateLifecycle, deadlineAt, metrics,
      );
      if (recovered) return { kind: "upstream", call: recovered, result };
      return { kind: "terminal", text: result.text.startsWith(toolRecoveryTermination())
        ? result.text
        : toolRecoveryTermination("the model did not produce the required client tool call after one bounded repair") };
    }
  }

  const completionDecision = evaluateCompletionEvidence(result.text, completionLedger);
  if (!completionDecision.allowed
    && ["missing_evidence", "unknown_evidence"].includes(completionDecision.reason)
    && toolRoutingEnabled(tools, toolChoice)) {
    const recoveryPrompt = `${prompt}\n\nCOMPLETION EVIDENCE RECOVERY: The ordinary answer asserted completion without matching successful client-tool evidence (${completionDecision.unsupportedActions.join(", ")}). Do not repeat that answer. Select the next materially useful client tool action needed to continue or verify the user's current task. Do not repeat a completed inspection unchanged, and do not perform a mutation outside the user's request.`;
    const recoveryCall = await resolveFunctionCall(
      env,
      account,
      result,
      recoveryPrompt,
      tone,
      tools,
      toolChoice,
      ledger,
      signal,
      gateLifecycle,
      deadlineAt,
      metrics,
    );
    if (recoveryCall) return { kind: "upstream", call: recoveryCall, result };
  }
  return { kind: "upstream", call: null, result: guardAssistantCompletion(result, null, completionLedger, tools) };
}

export function createStreamCancellation(
  state: { releaseUpstream(accountId: string, leaseId: string): Promise<void> },
  session: DurableObjectStub<ChatSession>,
  lease: ChatLease,
  downstreamSignal?: AbortSignal,
): {
  signal: AbortSignal;
  gates: UpstreamGateLifecycle;
  abortAndRelease: () => Promise<void>;
  scheduleAbortAndRelease: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const gates = createUpstreamGateLifecycle(state);
  let releasePromise: Promise<void> | undefined;
  const abortAndRelease = (): Promise<void> => {
    if (!controller.signal.aborted) controller.abort();
    if (!releasePromise) {
      releasePromise = Promise.allSettled([
        session.abandon(lease.leaseId),
        gates.cancel(),
      ]).then((results) => {
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) throw rejected.reason;
      });
    }
    return releasePromise;
  };
  const scheduleAbortAndRelease = (): void => {
    // Event listeners and enqueue failures cannot await. Register the complete
    // cleanup operation so neither the chat lease nor the account gate becomes
    // floating work when downstream disconnects.
    waitUntil(abortAndRelease().catch(() => {
      console.error(JSON.stringify({ event: "stream_cancellation_cleanup_failed" }));
    }));
  };
  const onAbort = (): void => scheduleAbortAndRelease();
  if (downstreamSignal?.aborted) scheduleAbortAndRelease();
  else downstreamSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    gates,
    abortAndRelease,
    scheduleAbortAndRelease,
    dispose: () => downstreamSignal?.removeEventListener("abort", onAbort),
  };
}

function chatCompletion(model: string, result: ChatHubResult, call: FunctionCall | null): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000);
  const message = call
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_${crypto.randomUUID().replaceAll("-", "")}`, type: "function", function: call }] }
    : { role: "assistant", content: assistantVisibleText(result) };
  return {
    id: `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function localChatTerminal(model: string, text: string, stream: boolean): Response {
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: estimatePromptTokens(text), total_tokens: estimatePromptTokens(text) },
    }, { headers: { "Cache-Control": "no-store" } });
  }
  const events = [
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: streamHeaders() });
}

function streamHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    // Explicitly identify the execution boundary so clients can pin local
    // Windows tool execution and reject hosted/container fallbacks.
    "X-M365-Execution-Environment": "cloudflare-worker-relay",
  };
}

function chatStream(
  env: Env,
  session: DurableObjectStub<ChatSession>,
  lease: ChatLease,
  account: AccountSelection,
  prompt: string,
  portableTurnPrompt: string,
  model: string,
  tone: string,
  tools: unknown[] | undefined,
  toolChoice: unknown,
  attachments: ReadonlyArray<NormalizedImageAttachment>,
  ledger: ToolLedger,
  completionLedger: ToolLedger,
  deadlineAt: number,
  downstreamSignal?: AbortSignal,
  metrics?: RequestMetricTracker,
): Response {
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const cancellation = createStreamCancellation(state, session, lease, downstreamSignal);
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        } catch {
          closed = true;
          void metrics?.cancel(200);
          cancellation.scheduleAbortAndRelease();
        }
      };
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      heartbeat = setInterval(() => send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: null }] }), STREAM_HEARTBEAT_MS);
      const pump = (async () => {
        try {
          // Commit semantic output only after ChatHub's terminal type-3 frame.
          // Heartbeats keep long turns alive; partial snapshots cannot be
          // retracted if Microsoft later rewrites or aborts the answer.
          const bufferTools = true;
          let downstreamText = "";
          const turn = await resolveAssistantTurn(env, session, lease, account, prompt, tone, tools, toolChoice, attachments, ledger, completionLedger, bufferTools ? undefined : (delta) => {
            downstreamText += delta;
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
          }, cancellation.signal, cancellation.gates, deadlineAt, metrics);
          if (turn.kind === "terminal") {
            await session.release(lease.leaseId);
            metrics?.observeOutputText(turn.text);
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] });
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            return;
          }
          const { call, result } = turn;
          const visibleText = assistantVisibleText(result);
          const finalTail = appendPortableProtocolTurn(
            lease.portableProtocolTail,
            portableTurnPrompt,
            portableAssistantResult(result, call),
          );
          await completeFinalTurn(session, lease, result, finalTail);
          if (call) {
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID().replaceAll("-", "")}`, type: "function", function: call }] }, finish_reason: null }] });
          } else if (bufferTools) {
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: visibleText }, finish_reason: null }] });
          } else if (visibleText.startsWith(downstreamText) && visibleText.length > downstreamText.length) {
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: visibleText.slice(downstreamText.length) }, finish_reason: null }] });
          } else if (!downstreamText) {
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: visibleText }, finish_reason: null }] });
          }
          send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] });
        } catch (cause) {
          await abandonUnseenTurn(session, lease.leaseId);
          void (downstreamSignal?.aborted || cancellation.signal.aborted ? metrics?.cancel(200) : metrics?.error(200));
          const failure = publicFailure(cause);
          send({ error: { type: cause instanceof ToolLedgerBlockedError ? "invalid_request_error" : "upstream_error", ...failure } });
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          cancellation.dispose();
          if (!closed) {
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch { /* downstream already disconnected */ }
            closed = true;
          }
        }
      })();
      waitUntil(pump);
    },
    async cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      void metrics?.cancel(200);
      await cancellation.abortAndRelease();
    },
  });
  return new Response(stream, { headers: streamHeaders() });
}

async function chatCompletions(request: Request, env: Env, metrics?: RequestMetricTracker): Promise<Response> {
  const deadlineAt = logicalRequestDeadlineAt();
  const parsed = await body<ChatBody>(request);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) throw new Error("INVALID_REQUEST");
  observeMetricValues(metrics, parsed.messages, parsed.tools, parsed.tool_choice);
  validateTools(parsed.tools);
  validateParallelToolMode(parsed.parallel_tool_calls);
  validateToolChoice(parsed.tool_choice, parsed.tools);
  parsed.tools = routableFunctionTools(parsed.tools);
  const model = canonicalModel(parsed.model);
  const tone = modelTone(model, parsed.reasoning_effort ?? "");
  const session = chatSession(env, await chatSessionKey(request, parsed));
  const lease = await acquireConversationLease(session, deadlineAt, request.signal);
  let ledger: ToolLedger;
  let completionLedger: ToolLedger;
  let prompt: string;
  let currentTurnPrompt: string;
  let attachments: NormalizedImageAttachment[] = [];
  let promptLimit = 0;
  let promptTokenLimit = 0;
  try {
    const activeMessages = selectActiveChatMessages(parsed.messages, lease.started);
    const prepared = prepareChatMultimodal(activeMessages);
    attachments = prepared.attachments;
    const parsedLedger = await parseChatToolLedger(prepared.value);
    ledger = recoverRepeatedPendingProposal(parsedLedger);
    completionLedger = await parseChatCompletionEvidenceLedger(parsed.messages);
    if (recoveredRepeatedPendingProposal(parsedLedger, ledger)) {
      const reason = toolGuardFailure("completed_call_reissued").publicMessage;
      await session.release(lease.leaseId);
      metrics?.observeOutputText(toolRecoveryTermination(reason));
      return localChatTerminal(model, toolRecoveryTermination(reason), Boolean(parsed.stream));
    }
    const ledgerFailure = toolLedgerPreflight(ledger);
    if (ledgerFailure) {
      await session.release(lease.leaseId);
      return ledgerFailure;
    }
    const evidence = completedEvidenceContext(ledger);
    promptLimit = availablePromptCharacterBudget(model, parsed.tools, evidence.length);
    promptTokenLimit = availablePromptTokenBudget(model, parsed.tools, evidence);
    const anchorBudget = await mergeAndReserveTaskAnchors(
      session,
      lease,
      extractChatTaskAnchors(parsed.messages),
      promptLimit,
      promptTokenLimit,
    );
    currentTurnPrompt = `${anchorBudget.prefix}${chatPrompt(prepared.value, anchorBudget.promptCharacters, anchorBudget.promptTokens)}${evidence ? `\n\n${evidence}` : ""}`;
    prompt = currentTurnPrompt;
  } catch (cause) {
    await session.release(lease.leaseId);
    throw cause;
  }
  let account: AccountSelection;
  try {
    const resolution = await accountForLease(env, session, lease);
    account = resolution.account;
    metrics?.setAccountId(account.accountId);
    if (resolution.rebound) {
      prompt = restorePortableProtocolPrompt(lease.portableProtocolTail, currentTurnPrompt, promptLimit, promptTokenLimit);
    }
  } catch (cause) {
    await session.release(lease.leaseId);
    throw cause;
  }
  if (parsed.stream) return chatStream(env, session, lease, account, prompt, currentTurnPrompt, model, tone, parsed.tools, parsed.tool_choice, attachments, ledger, completionLedger, deadlineAt, request.signal, metrics);
  try {
    const turn = await resolveAssistantTurn(env, session, lease, account, prompt, tone, parsed.tools, parsed.tool_choice, attachments, ledger, completionLedger, undefined, request.signal, undefined, deadlineAt, metrics);
    if (turn.kind === "terminal") {
      await session.release(lease.leaseId);
      metrics?.observeOutputText(turn.text);
      return localChatTerminal(model, turn.text, false);
    }
    const { call, result } = turn;
    if (request.signal.aborted) throw new Error("REQUEST_ABORTED");
    const finalTail = appendPortableProtocolTurn(
      lease.portableProtocolTail,
      currentTurnPrompt,
      portableAssistantResult(result, call),
    );
    await completeFinalTurn(session, lease, result, finalTail);
    return Response.json(chatCompletion(model, result, call), { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    await abandonUnseenTurn(session, lease.leaseId);
    throw cause;
  }
}

function responseOutput(responseId: string, result: ChatHubResult, call: FunctionCall | null): unknown[] {
  if (call) return [{ type: "function_call", id: `fc_${crypto.randomUUID().replaceAll("-", "")}`, call_id: `call_${crypto.randomUUID().replaceAll("-", "")}`, name: call.name, arguments: call.arguments, status: "completed" }];
  return [{ id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: assistantVisibleText(result), annotations: [] }] }];
}

function responseObject(responseId: string, model: string, output: unknown[], status = "completed"): Record<string, unknown> {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    parallel_tool_calls: false,
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function localResponsesTerminal(responseId: string, model: string, text: string, stream: boolean): Response {
  const item = {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const output = [item];
  if (!stream) return Response.json(responseObject(responseId, model, output), { headers: { "Cache-Control": "no-store" } });
  let sequence = 0;
  const event = (value: Record<string, unknown>): string => `event: ${String(value.type)}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`;
  const body = [
    event({ type: "response.created", response: responseObject(responseId, model, [], "in_progress") }),
    event({ type: "response.in_progress", response: responseObject(responseId, model, [], "in_progress") }),
    event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
    event({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    event({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text }),
    event({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text }),
    event({ type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] }),
    event({ type: "response.output_item.done", output_index: 0, item }),
    event({ type: "response.completed", response: responseObject(responseId, model, output) }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: streamHeaders() });
}

async function seedAlias(
  env: Env,
  responseSessionKey: string,
  result: ChatHubResult,
  accountId: string,
  output: unknown[],
  ledger: ToolLedger,
  taskAnchors: TaskAnchor[],
  portableProtocolTail: string,
): Promise<void> {
  const item = output[0] as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
  await chatSession(env, responseSessionKey).seed(
    result.conversationId,
    result.sessionId,
    accountId,
    item?.type === "function_call" ? item.call_id ?? "" : "",
    item?.type === "function_call" ? item.name ?? "" : "",
    item?.type === "function_call" ? item.arguments ?? "" : "",
    JSON.stringify(completedToolSnapshots(ledger)),
    taskAnchors,
    portableProtocolTail,
  );
}

function storedToolSnapshots(encoded: string): ToolLedgerSnapshotEntry[] {
  if (!encoded || encoded.length > 65_536) return [];
  try {
    const parsed = JSON.parse(encoded) as unknown;
    return Array.isArray(parsed) ? parsed as ToolLedgerSnapshotEntry[] : [];
  } catch {
    return [];
  }
}

interface FunctionOutputItem {
  callId: string;
  output: string;
  index: number;
}

function functionOutputs(input: unknown): FunctionOutputItem[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((raw, index) => {
    const item = raw as Record<string, unknown>;
    if (item.type !== "function_call_output") return [];
    return [{ callId: String(item.call_id ?? ""), output: contentText(item.output) || String(item.output ?? ""), index }];
  });
}

export function responsesContinuationOutputIssue(
  input: unknown,
  pendingCallId: string,
): "tool_output_mismatch" | "tool_output_already_consumed" | null {
  if (!Array.isArray(input)) return pendingCallId ? "tool_output_mismatch" : null;
  const outputs = functionOutputs(input);
  const callIndexes = new Map<string, number>();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index] as Record<string, unknown>;
    if (item?.type === "function_call" && typeof item.call_id === "string" && !callIndexes.has(item.call_id)) {
      callIndexes.set(item.call_id, index);
    }
  }

  if (pendingCallId) {
    const matching = outputs.filter((output) => output.callId === pendingCallId);
    if (matching.length !== 1) return "tool_output_mismatch";
    // Compatibility clients may replay older complete call/result pairs. They
    // are safe to ignore only when causally paired before the current pending
    // result; unknown or later outputs remain a protocol error.
    for (const output of outputs) {
      if (output === matching[0]) continue;
      const callIndex = callIndexes.get(output.callId);
      if (callIndex === undefined || callIndex >= output.index || output.index >= matching[0].index) return "tool_output_mismatch";
    }
    return null;
  }

  // A stateless Responses continuation is self-contained: Codex replays each
  // function_call directly before its function_call_output and may omit both
  // previous_response_id and a stable session key.  Accept that causal pair;
  // the tool ledger below still rejects orphaned, duplicated, or mismatched
  // evidence and prevents the completed action from being reissued.
  for (const output of outputs) {
    const callIndex = callIndexes.get(output.callId);
    if (callIndex === undefined || callIndex >= output.index) return "tool_output_mismatch";
  }
  return null;
}

export function responseFunctionCallEvents(item: Record<string, unknown>, call: FunctionCall): Array<Record<string, unknown>> {
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: call.arguments },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      call_id: item.call_id,
      name: call.name,
      arguments: call.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
  ];
}

function responsesStream(
  env: Env,
  session: DurableObjectStub<ChatSession>,
  lease: ChatLease,
  account: AccountSelection,
  prompt: string,
  portableTurnPrompt: string,
  portableBaseTail: string,
  model: string,
  tone: string,
  responseId: string,
  responseSessionKey: string,
  tools: unknown[] | undefined,
  toolChoice: unknown,
  attachments: ReadonlyArray<NormalizedImageAttachment>,
  ledger: ToolLedger,
  deadlineAt: number,
  downstreamSignal?: AbortSignal,
  metrics?: RequestMetricTracker,
): Response {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const cancellation = createStreamCancellation(state, session, lease, downstreamSignal);
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sequence = 0;
      const send = (event: Record<string, unknown>): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`));
        } catch {
          closed = true;
          void metrics?.cancel(200);
          cancellation.scheduleAbortAndRelease();
        }
      };
      send({ type: "response.created", response: responseObject(responseId, model, [], "in_progress") });
      send({ type: "response.in_progress", response: responseObject(responseId, model, [], "in_progress") });
      heartbeat = setInterval(() => send({ type: "response.in_progress", response: responseObject(responseId, model, [], "in_progress") }), STREAM_HEARTBEAT_MS);
      const pump = (async () => {
        try {
          // Responses follows the same terminal-commit contract as Chat. No
          // output_text delta is exposed before a valid upstream completion.
          const bufferTools = true;
          const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
          let streamedText = "";
          if (!bufferTools) {
            send({ type: "response.output_item.added", output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } });
            send({ type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          }
          const turn = await resolveAssistantTurn(env, session, lease, account, prompt, tone, tools, toolChoice, attachments, ledger, ledger, bufferTools ? undefined : (delta) => {
            streamedText += delta;
            send({ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta });
          }, cancellation.signal, cancellation.gates, deadlineAt, metrics);
          if (turn.kind === "terminal") {
            await session.release(lease.leaseId);
            metrics?.observeOutputText(turn.text);
            const item = {
              id: messageId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: turn.text, annotations: [] }],
            };
            const output = [item];
            send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
            send({ type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
            send({ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: turn.text });
            send({ type: "response.output_text.done", item_id: messageId, output_index: 0, content_index: 0, text: turn.text });
            send({ type: "response.content_part.done", item_id: messageId, output_index: 0, content_index: 0, part: item.content[0] });
            send({ type: "response.output_item.done", output_index: 0, item });
            send({ type: "response.completed", response: responseObject(responseId, model, output) });
            return;
          }
          const { call, result } = turn;
          const output = call
            ? responseOutput(responseId, result, call)
            : [{ id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: result.text, annotations: [] }] }];
          const item = output[0] as Record<string, unknown>;
          const functionEvents = call ? responseFunctionCallEvents(item, call) : [];
          const finalTail = appendPortableProtocolTurn(portableBaseTail, portableTurnPrompt, portableAssistantResult(result, call));
          await completeFinalTurn(session, lease, result, finalTail);
          await seedAlias(
            env,
            responseSessionKey,
            result,
            lease.accountId,
            output,
            ledger,
            lease.taskAnchors,
            finalTail,
          );
          if (call) {
            for (const event of functionEvents.slice(0, -1)) send(event);
          } else {
            const content = (item.content as unknown[])[0] as Record<string, unknown>;
            if (bufferTools) {
              send({ type: "response.output_item.added", output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } });
              send({ type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
            }
            const visibleText = String(content.text ?? "");
            if (visibleText.startsWith(streamedText) && visibleText.length > streamedText.length) {
              send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: visibleText.slice(streamedText.length) });
            } else if (!streamedText) {
              send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: visibleText });
            }
            send({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: content.text });
            send({ type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: content });
          }
          if (call) send(functionEvents.at(-1)!);
          else send({ type: "response.output_item.done", output_index: 0, item });
          send({ type: "response.completed", response: responseObject(responseId, model, output) });
        } catch (cause) {
          await abandonUnseenTurn(session, lease.leaseId);
          void (downstreamSignal?.aborted || cancellation.signal.aborted ? metrics?.cancel(200) : metrics?.error(200));
          const failure = publicFailure(cause);
          send({ type: "response.failed", response: { ...responseObject(responseId, model, [], "failed"), error: failure } });
          send({ type: "error", code: failure.code, message: failure.message });
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          cancellation.dispose();
          if (!closed) {
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch { /* downstream already disconnected */ }
            closed = true;
          }
        }
      })();
      waitUntil(pump);
    },
    async cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      void metrics?.cancel(200);
      await cancellation.abortAndRelease();
    },
  });
  return new Response(stream, { headers: streamHeaders() });
}

async function responsesCore(request: Request, env: Env, metrics?: RequestMetricTracker): Promise<Response> {
  const deadlineAt = logicalRequestDeadlineAt();
  const parsed = await body<ResponsesBody>(request);
  if (!parsed || typeof parsed !== "object") throw new Error("INVALID_REQUEST");
  observeMetricValues(metrics, parsed.input, parsed.tools, parsed.tool_choice);
  validateTools(parsed.tools);
  validateParallelToolMode(parsed.parallel_tool_calls);
  validateToolChoice(parsed.tool_choice, parsed.tools);
  parsed.tools = routableFunctionTools(parsed.tools);
  if (explicitClientExecRequest(parsed.input, parsed.tools, parsed.tool_choice)) {
    parsed.tool_choice = { type: "function", name: "exec_command" };
  }
  const model = canonicalModel(parsed.model);
  const tone = modelTone(model, parsed.reasoning?.effort ?? "");
  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  if (parsed.previous_response_id && parsed.conversation != null) throw new Error("INVALID_REQUEST");
  if (parsed.previous_response_id && parsed.new_conversation) throw new Error("INVALID_REQUEST");
  const key = await responsesSessionKey(request, parsed);
  const responseSessionKey = await scopedOpaqueKey(request, "m365-response-id", responseId);
  const session = chatSession(env, key);
  const lease = await acquireConversationLease(session, deadlineAt, request.signal);
  const portableBaseTail = lease.portableProtocolTail;
  if (parsed.previous_response_id && !lease.started) {
    await session.release(lease.leaseId);
    return apiError(404, "previous_response_not_found", "previous_response_id is unknown or expired");
  }
  const outputs = functionOutputs(parsed.input);
  // Codex CLI 0.150 uses the stateless Responses form: it replays the emitted
  // function_call beside its function_call_output and keeps the logical
  // session via prompt_cache_key, without sending previous_response_id.  Both
  // stateful and stateless continuations must pass the same pending call-id
  // validation before the result is accepted.
  if (outputs.length > 0) {
    const issue = responsesContinuationOutputIssue(parsed.input, lease.pendingCallId);
    if (issue === "tool_output_mismatch") {
      await session.release(lease.leaseId);
      return apiError(400, issue, "function_call_output does not match the pending call_id");
    }
    if (issue === "tool_output_already_consumed") {
      await session.release(lease.leaseId);
      return apiError(409, issue, "this response is not waiting for a tool output");
    }
  }
  const statelessToolContinuation = outputs.length > 0 && Boolean(lease.pendingCallId);
  let ledger: ToolLedger;
  let prompt: string;
  let currentTurnPrompt: string;
  let attachments: NormalizedImageAttachment[] = [];
  let promptLimit = 0;
  let promptTokenLimit = 0;
  try {
    const activeInput = selectActiveResponsesInput(parsed.input, lease.started, {
      previousResponse: Boolean(parsed.previous_response_id) || statelessToolContinuation,
      pendingCallId: lease.pendingCallId,
    });
    const prepared = prepareResponsesMultimodal(activeInput);
    attachments = prepared.attachments;
    const parsedLedger = await parseResponsesToolLedger(prepared.value, {
      completedSnapshots: storedToolSnapshots(lease.toolLedgerSnapshot),
      seed: lease.pendingCallId ? [{
        callId: lease.pendingCallId,
        name: lease.pendingToolName,
        arguments: lease.pendingToolArguments || "{}",
      }] : [],
    });
    ledger = recoverRepeatedPendingProposal(parsedLedger);
    if (recoveredRepeatedPendingProposal(parsedLedger, ledger)) {
      const reason = toolGuardFailure("completed_call_reissued").publicMessage;
      await session.release(lease.leaseId);
      metrics?.observeOutputText(toolRecoveryTermination(reason));
      return localResponsesTerminal(responseId, model, toolRecoveryTermination(reason), Boolean(parsed.stream));
    }
    const ledgerFailure = toolLedgerPreflight(ledger);
    if (ledgerFailure) {
      await session.release(lease.leaseId);
      return ledgerFailure;
    }
    const evidence = completedEvidenceContext(ledger);
    promptLimit = availablePromptCharacterBudget(model, parsed.tools, evidence.length);
    promptTokenLimit = availablePromptTokenBudget(model, parsed.tools, evidence);
    const anchorBudget = await mergeAndReserveTaskAnchors(
      session,
      lease,
      extractResponsesTaskAnchors(parsed.input),
      promptLimit,
      promptTokenLimit,
    );
    currentTurnPrompt = `${anchorBudget.prefix}${responsesPrompt(prepared.value, anchorBudget.promptCharacters, anchorBudget.promptTokens)}${evidence ? `\n\n${evidence}` : ""}`;
    prompt = currentTurnPrompt;
  } catch (cause) {
    await session.release(lease.leaseId);
    throw cause;
  }
  let account: AccountSelection;
  try {
    const resolution = await accountForLease(env, session, lease);
    account = resolution.account;
    metrics?.setAccountId(account.accountId);
    if (resolution.rebound) {
      prompt = restorePortableProtocolPrompt(lease.portableProtocolTail, currentTurnPrompt, promptLimit, promptTokenLimit);
    }
  } catch (cause) {
    await session.release(lease.leaseId);
    throw cause;
  }
  if (parsed.stream) return responsesStream(env, session, lease, account, prompt, currentTurnPrompt, portableBaseTail, model, tone, responseId, responseSessionKey, parsed.tools, parsed.tool_choice, attachments, ledger, deadlineAt, request.signal, metrics);
  try {
    const turn = await resolveAssistantTurn(env, session, lease, account, prompt, tone, parsed.tools, parsed.tool_choice, attachments, ledger, ledger, undefined, request.signal, undefined, deadlineAt, metrics);
    if (turn.kind === "terminal") {
      await session.release(lease.leaseId);
      metrics?.observeOutputText(turn.text);
      return localResponsesTerminal(responseId, model, turn.text, false);
    }
    const { call, result } = turn;
    const output = responseOutput(responseId, result, call);
    if (request.signal.aborted) throw new Error("REQUEST_ABORTED");
    const finalTail = appendPortableProtocolTurn(portableBaseTail, currentTurnPrompt, portableAssistantResult(result, call));
    await completeFinalTurn(session, lease, result, finalTail);
    await seedAlias(
      env,
      responseSessionKey,
      result,
      lease.accountId,
      output,
      ledger,
      lease.taskAnchors,
      finalTail,
    );
    return Response.json(responseObject(responseId, model, output), { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    await abandonUnseenTurn(session, lease.leaseId);
    throw cause;
  }
}

async function delayedResponseFailure(response: Response): Promise<{ code: string; message: string }> {
  try {
    const value = await response.clone().json() as { error?: { code?: unknown; message?: unknown } };
    const code = typeof value?.error?.code === "string" && value.error.code ? value.error.code : "upstream_error";
    const message = typeof value?.error?.message === "string" && value.error.message
      ? value.error.message
      : `request failed with HTTP ${response.status}`;
    return { code, message };
  } catch {
    return { code: "upstream_error", message: `request failed with HTTP ${response.status}` };
  }
}

/**
 * A Responses request can spend time in Durable Object session acquisition,
 * portable-state restoration, and account routing before responsesStream()
 * exists. During that interval there were no response headers or bytes for the
 * client to observe, so Codex's normal SSE idle timer could expire even though
 * the Worker was still progressing. Open an SSE bridge after a short grace
 * period and emit transport-only comments until the real stream is ready.
 */
function bridgePendingResponsesStream(pending: Promise<Response>): Response {
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string | Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        } catch {
          closed = true;
        }
      };
      send(": responses-preflight\n\n");
      heartbeat = setInterval(() => send(": keep-alive\n\n"), STREAM_HEARTBEAT_MS);
      const pump = (async () => {
        try {
          const response = await pending;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
          if (!response.ok || !response.body || !contentType.startsWith("text/event-stream")) {
            const failure = await delayedResponseFailure(response);
            send(`event: error\ndata: ${JSON.stringify({ type: "error", code: failure.code, message: failure.message })}\n\n`);
            send("data: [DONE]\n\n");
            return;
          }
          reader = response.body.getReader();
          while (!closed) {
            const next = await reader.read();
            if (next.done) break;
            send(next.value);
          }
        } catch (cause) {
          const failure = publicFailure(cause);
          send(`event: error\ndata: ${JSON.stringify({ type: "error", code: failure.code, message: failure.message })}\n\n`);
          send("data: [DONE]\n\n");
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          if (!closed) {
            try { controller.close(); } catch { /* downstream already disconnected */ }
            closed = true;
          }
        }
      })();
      waitUntil(pump);
    },
    async cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      try { await reader?.cancel(); } catch { /* upstream already closed */ }
    },
  });
  return new Response(stream, { headers: streamHeaders() });
}

async function responses(request: Request, env: Env, metrics?: RequestMetricTracker): Promise<Response> {
  let streaming = false;
  try {
    const value = await request.clone().json() as { stream?: unknown };
    streaming = value?.stream === true;
  } catch {
    // Let responsesCore preserve the normal invalid-body error contract.
  }
  if (!streaming) return await responsesCore(request, env, metrics);

  const pending = responsesCore(request, env, metrics);
  const marker = Symbol("responses-preflight-pending");
  const quick = await Promise.race<Response | symbol>([
    pending,
    new Promise<symbol>((resolve) => setTimeout(() => resolve(marker), STREAM_PREFLIGHT_GRACE_MS)),
  ]);
  return quick === marker ? bridgePendingResponsesStream(pending) : quick as Response;
}

export function imageGenerationData(
  images: readonly string[],
  format: "url" | "b64_json",
  limit: number,
): Array<{ url: string } | { b64_json: string }> {
  return images.slice(0, limit).map((image) => {
    if (format === "url") return { url: image };
    if (!image.startsWith("data:image/")) throw new Error("IMAGE_RESPONSE_FORMAT_UNAVAILABLE");
    const separator = image.indexOf(",");
    if (separator < 0 || separator === image.length - 1) throw new Error("IMAGE_RESPONSE_FORMAT_UNAVAILABLE");
    return { b64_json: image.slice(separator + 1) };
  });
}

async function imageGenerations(request: Request, env: Env, metrics?: RequestMetricTracker): Promise<Response> {
  const deadlineAt = logicalRequestDeadlineAt();
  const raw = await body<unknown>(request);
  const normalized = normalizeImageGenerationRequest(raw);
  const modelValue = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).model
    : undefined;
  const model = canonicalModel(typeof modelValue === "string" && modelValue.trim() ? modelValue : undefined);
  metrics?.observeInputText(normalized.prompt);

  const session = chatSession(env, `image-generation:${crypto.randomUUID()}`);
  const lease = await acquireConversationLease(session, deadlineAt, request.signal);
  let account: AccountSelection;
  try {
    const resolution = await accountForLease(env, session, lease);
    account = resolution.account;
    metrics?.setAccountId(account.accountId);
  } catch (cause) {
    await session.release(lease.leaseId);
    throw cause;
  }

  try {
    const sizeInstruction = normalized.size === "auto" ? "" : ` Target canvas: ${normalized.size}.`;
    const countInstruction = normalized.n > 1 ? ` Return up to ${normalized.n} distinct images.` : "";
    const result = await exchange(
      env,
      session,
      lease,
      account,
      `Generate an image: ${normalized.prompt}.${sizeInstruction}${countInstruction}`,
      "magic",
      undefined,
      "none",
      undefined,
      undefined,
      request.signal,
      undefined,
      deadlineAt,
      metrics,
    );
    observeMetricResult(metrics, result);
    if (request.signal.aborted) throw new Error("REQUEST_ABORTED");
    if (!result.images?.length) throw new Error("UPSTREAM_RETURNED_NO_IMAGE");
    const data = imageGenerationData(result.images, normalized.responseFormat, normalized.n);
    await session.release(lease.leaseId);
    return Response.json({
      created: Math.floor(Date.now() / 1_000),
      data,
      model,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    await abandonUnseenTurn(session, lease.leaseId);
    throw cause;
  }
}

export async function openAIRequest(
  request: Request,
  env: Env,
  url: URL,
  metrics?: RequestMetricTracker,
): Promise<Response> {
  try {
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") return await chatCompletions(request, env, metrics);
    if (url.pathname === "/v1/responses" && request.method === "POST") return await responses(request, env, metrics);
    if (url.pathname === "/v1/images/generations" && request.method === "POST") return await imageGenerations(request, env, metrics);
    return apiError(404, "not_found", "OpenAI-compatible endpoint not found");
  } catch (cause) {
    if (cause instanceof ToolLedgerBlockedError) {
      return apiError(cause.status, cause.publicCode, cause.publicMessage);
    }
    if (cause instanceof MultimodalInputError) {
      const errors: Record<string, { status: number; message: string }> = {
        audio_not_supported: { status: 400, message: "audio input is not supported by this endpoint" },
        image_too_large: { status: 413, message: "image input exceeds the per-image or aggregate request limit" },
        invalid_image: { status: 400, message: "image input must be a safe HTTPS URL or a supported raster data URI" },
        invalid_multimodal_content: { status: 400, message: "multimodal content is malformed or uses an image outside a user message" },
        too_many_images: { status: 400, message: "a request may contain at most 8 images" },
        unsupported_content_part: { status: 400, message: "the request contains an unsupported content part" },
      };
      const error = errors[cause.code];
      return apiError(error.status, cause.code, error.message);
    }
    const code = cause instanceof Error ? cause.message : "REQUEST_FAILED";
    if (code === "EMPTY_PROMPT") return apiError(400, "invalid_request_error", "a non-empty prompt is required");
    if (code === "INVALID_JSON") return apiError(400, "invalid_json", "request body must be valid JSON");
    if (code === "INVALID_REQUEST") return apiError(400, "invalid_request_error", "request body does not match the selected endpoint");
    if (code === "INVALID_TOOLS") return apiError(400, "invalid_tools", "tools must be an array containing at most 128 definitions");
    if (code === "TOOLS_TOO_LARGE") return apiError(413, "tools_too_large", "tool definitions exceed the 1,000,000 character limit");
    if (code === "INVALID_PARALLEL_TOOL_MODE") return apiError(400, "invalid_parallel_tool_calls", "parallel_tool_calls must be a boolean");
    if (code === "INVALID_TOOL_CHOICE") return apiError(400, "invalid_tool_choice", "tool_choice must select a declared function or a supported sequential mode");
    if (code === "INVALID_SESSION_KEY") return apiError(400, "invalid_session_key", "session identifiers must not exceed 1,024 characters");
    if (code === "REQUEST_TOO_LARGE") return apiError(413, "request_too_large", "request body exceeds the 8 MiB limit");
    if (code === "CURRENT_TURN_TOO_LARGE") return apiError(400, "context_length_exceeded", "the current user/tool turn exceeds this model's input limit and cannot be truncated safely");
    if (code === "TOOL_DEFINITIONS_EXCEED_MODEL_CONTEXT") return apiError(413, "tools_exceed_context", "tool definitions leave too little usable context for this model");
    if (code === "UNNORMALIZED_IMAGE_CONTENT") return apiError(400, "invalid_multimodal_content", "image input could not be normalized safely");
    if (code === "UPSTREAM_RETURNED_NO_IMAGE") return apiError(502, "upstream_returned_no_image", "Microsoft 365 completed the request without an image resource");
    if (code === "IMAGE_RESPONSE_FORMAT_UNAVAILABLE") return apiError(502, "unsupported_response_format", "Microsoft 365 returned an image URL instead of inline base64 data");
    if (code === "NO_ACCOUNT") return apiError(503, "no_account", "no Microsoft 365 account is configured");
    if (code === "NO_HEALTHY_ACCOUNT" || code === "SESSION_ACCOUNT_COOLDOWN") return apiError(429, "account_cooldown", "all eligible Microsoft 365 accounts are cooling down; retry later");
    if (code === "NO_USABLE_ACCOUNT") return apiError(503, "account_pool_isolated", "all Microsoft 365 accounts require administrator attention");
    if (code === "SESSION_ACCOUNT_ISOLATED" || code === "SESSION_ACCOUNT_MISSING") return apiError(503, "session_account_unavailable", "the account bound to this conversation is unavailable");
    if (code === "CONVERSATION_BUSY") return apiError(409, "conversation_busy", "this conversation already has an active request");
    if (code === "ACCOUNT_QUEUE_TIMEOUT") return apiError(429, "account_busy", "the Microsoft 365 account is busy; retry later");
    if (code === "CHAT_THROTTLED_QUOTA_EXHAUSTED") return apiError(429, "upstream_throttled", "the selected Microsoft 365 account has exhausted its current allowance");
    if (code === "UNSUPPORTED_MODEL") return apiError(400, "unsupported_model", "the requested model is not supported by this gateway");
    if (code === "TOOL_CALL_GENERATION_FAILED") return apiError(502, "tool_call_generation_failed", "the model did not produce a valid required function call after bounded repair");
    const failure = publicFailure(cause);
    console.error(JSON.stringify({ event: "openai_request_failed", code: failure.code, internal_code: internalFailureCode(cause) }));
    return apiError(502, failure.code, failure.message);
  }
}
