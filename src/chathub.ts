import { base64url } from "./crypto";
import type { OAuthTokenSet } from "./types";
import {
  extractUpstreamImageURLs,
  normalizeMultimodalContent,
  type NormalizedImageAttachment,
} from "./multimodal";
import { validateToolArguments } from "./tool-schema";

const RS = "\u001e";
// Upgrade via fetch() uses HTTPS. Cloudflare turns the successful 101
// response into a WebSocket; passing a wss:// URL to fetch is rejected before
// any handshake is attempted.
const CHAT_HUB = "https://substrate.office.com/m365Copilot/Chathub";
const MAX_FRAME_CHARACTERS = 4_000_000;
const MAX_OUTPUT_CHARACTERS = 8_000_000;
const MAX_QUEUED_SOCKET_CHARACTERS = 8_000_000;
const MAX_UPSTREAM_IMAGE_URL_CHARACTERS = 6 * 1_024 * 1_024;
// Microsoft can leave a submitted invocation connected while producing no
// semantic frames.  The request-wide deadline remains ten minutes for long
// turns that keep reporting progress, but a completely idle invocation must
// fail much sooner so Codex can surface/retry it instead of appearing frozen.
const CHAT_PROGRESS_IDLE_TIMEOUT_MS = 90_000;
const VARIANTS = "EnableMcpServerWidgets,feature.EnableMcpServerWidgets,feature.EnableLuForChatCIQ,feature.enableChatCIQPlugin,EnableRequestPlugins,feature.EnableSensitivityLabels,EnableUnsupportedUrlDetector,feature.IsCustomEngineCopilotEnabled,feature.bizchatfluxv3,feature.enablechatpages,feature.enableCodeCanvas,feature.turnOnWorkTabRecommendation,turnOffWorkTabUpsellFromClient,feature.turnOnDARecommendation,feature.IsStreamingModeInChatRequestEnabled,IncludeSourceAttributionsConcise,SkipPublishEmptyMessage,feature.EnableDeduplicatingSourceAttributions,Enable3PActionProgressMessages,feature.enableClientWebRtc,feature.EnableMeetingRecapOfSeriesMeetingWithCiq,feature.EnableReferencesListCompleteSignal,feature.StorageMessageSplitDisabled,feature.EnableCuaTakeControlApi,feature.cwcallowedos,feature.disabledisallowedmsgs,feature.enableCitationsForSynthesisData,feature.enableGenerateGraphicArtOptionsSet,cdximagen,feature.EnableUpdatedUXForConfirmationDialog,feature.EnableClientFileURLSupportForOfficeWebPaidCopilot,feature.EnableDesignEditorImageGrounding,feature.EnableDesignerEditor,feature.OfficeWebToHelix,feature.OfficeDesktopToHelix,feature.M365TeamsHubToHelix,feature.OwaHubToHelix,feature.MonarchHubToHelix,feature.Win32OutlookHubToHelix,feature.MacOutlookHubToHelix,Agt_bizchat_enableGpt5ForHelix";

export interface ChatHubRequest {
  text: string;
  conversationId: string;
  sessionId: string;
  started: boolean;
  tone: string;
  /** Already-normalized image inputs. The ChatHub boundary validates again. */
  attachments?: ReadonlyArray<NormalizedImageAttachment>;
  tools?: unknown[];
  toolChoice?: unknown;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface ChatHubResult {
  text: string;
  conversationId: string;
  sessionId: string;
  requestId: string;
  images?: string[];
  functionCall?: FunctionCall;
  throttling?: unknown;
}

export interface FunctionCall {
  name: string;
  arguments: string;
}

function safeProtocolLabel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const label = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(label) ? label : "unknown";
}

/** Extract only an upstream machine label. Human-readable Microsoft messages
 * can contain tenant data, URLs or identifiers and must not enter errors/logs. */
function upstreamErrorLabel(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const candidate of [record.code, record.errorCode, record.error]) {
      if (candidate && typeof candidate === "object") {
        const nested = upstreamErrorLabel(candidate);
        if (nested !== "unknown") return nested;
      } else {
        const label = safeProtocolLabel(candidate);
        if (label !== "unknown") return label;
      }
    }
    if (Object.hasOwn(record, "message")) {
      const label = safeProtocolLabel(record.message);
      return label === "unknown" ? "unknown_error" : label;
    }
    if (Object.hasOwn(record, "error")) return "unknown_error";
  }
  return safeProtocolLabel(value);
}

export interface ChatHubRelay {
  baseURL: string;
  hmacSecret: string;
  origin: string;
}

const textEncoder = new TextEncoder();

function hexadecimal(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function relayBaseURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  return url;
}

function relayOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  return url.origin;
}

function relayTargetQuery(sessionId: string, conversationId: string, requestId: string): string {
  const query = new URLSearchParams();
  query.set("chatsessionid", requestId);
  query.set("clientrequestid", requestId);
  query.set("X-SessionId", sessionId);
  query.set("ConversationId", conversationId);
  query.set("variants", VARIANTS);
  query.set("source", '"officeweb"');
  query.set("product", "Office");
  query.set("agentHost", "Bizchat.FullScreen");
  query.set("licenseType", "Starter");
  query.set("agent", "web");
  query.set("scenario", "OfficeWebIncludedCopilot");
  return query.toString();
}

async function relayWebSocketRequest(
  account: OAuthTokenSet,
  sessionId: string,
  conversationId: string,
  requestId: string,
  relay: ChatHubRelay,
): Promise<{ url: string; headers: Headers }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (!uuid.test(account.oid) || !uuid.test(account.tid)
    || textEncoder.encode(relay.hmacSecret).byteLength < 32 || relay.hmacSecret.startsWith("m365_")) {
    throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  }
  const base = relayBaseURL(relay.baseURL);
  const origin = relayOrigin(relay.origin);
  const identity = `${account.oid.toLowerCase()}@${account.tid.toLowerCase()}`;
  const path = `/v1/chathub/${identity}`;
  const url = new URL(path, base);
  const targetQuery = relayTargetQuery(sessionId, conversationId, requestId);
  const tokenBytes = textEncoder.encode(account.accessToken).byteLength;
  const queryBytes = textEncoder.encode(targetQuery).byteLength;
  if (tokenBytes === 0 || tokenBytes > 32 * 1024 || queryBytes > 16 * 1024) {
    throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  }
  const digestInput = `token:${tokenBytes}:${account.accessToken}\nquery:${queryBytes}:${targetQuery}`;
  const digest = hexadecimal(await crypto.subtle.digest("SHA-256", textEncoder.encode(digestInput)));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const canonical = ["M365-RELAY-V1", timestamp, nonce, "GET", path, origin, digest].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(relay.hmacSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(canonical))));
  return {
    url: url.toString(),
    headers: new Headers({
      Upgrade: "websocket",
      Origin: origin,
      "X-M365-Access-Token": account.accessToken,
      "X-M365-Target-Query": targetQuery,
      "X-Relay-Timestamp": timestamp,
      "X-Relay-Nonce": nonce,
      "X-Relay-Content-SHA256": digest,
      "X-Relay-Signature": signature,
    }),
  };
}

/** Microsoft attaches throttling metadata to successful and failed frames. */
export function quotaExhausted(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const throttling = value as Record<string, unknown>;
  const direct = throttling.CostQuota;
  if (typeof direct === "number") return direct <= 0;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const remaining = (direct as Record<string, unknown>).remainingAllowance;
    if (typeof remaining === "number") return remaining <= 0;
  }
  const metering = throttling.metering;
  if (!metering || typeof metering !== "object" || Array.isArray(metering)) return false;
  const meteredQuota = (metering as Record<string, unknown>).CostQuota;
  if (!meteredQuota || typeof meteredQuota !== "object" || Array.isArray(meteredQuota)) return false;
  const remaining = (meteredQuota as Record<string, unknown>).remainingAllowance;
  return typeof remaining === "number" && remaining <= 0;
}

function encodedArguments(value: unknown): string | null {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value)); } catch { return null; }
  }
  if (value === undefined) return "{}";
  if (value === null || typeof value !== "object") return null;
  return JSON.stringify(value);
}

function callFromJSON(value: unknown, names: Set<string>, inferredName?: string): FunctionCall | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const call = callFromJSON(item, names, inferredName);
      if (call) return call;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.function && typeof record.function === "object") {
    const call = callFromJSON(record.function, names, inferredName);
    if (call) return call;
  }
  // Preserve the routing envelopes produced by several M365 model variants
  // and by the original server implementation.
  for (const nested of [record.calls, record.tool_calls, record.function_call]) {
    if (nested === undefined) continue;
    const call = callFromJSON(nested, names, inferredName);
    if (call) return call;
  }
  const named = [record.name, record.tool_name, typeof record.tool === "string" ? record.tool : undefined]
    .find((candidate): candidate is string => typeof candidate === "string" && names.has(candidate));
  if (named) {
    const args = encodedArguments(record.arguments ?? record.args ?? record.parameters ?? record.input);
    if (args) return { name: named, arguments: args };
  }
  for (const name of names) {
    if (!(name in record)) continue;
    const args = encodedArguments(record[name]);
    if (args) return { name, arguments: args };
  }
  if (inferredName && names.has(inferredName)) {
    const args = encodedArguments(record);
    if (args) return { name: inferredName, arguments: args };
  }
  return null;
}

function scrubNarration(text: string): string {
  return text
    .replace(/我将执行[：:][\s\S]*?\n\s*目的[：:][^\n]*\n?\s*预期[：:][^\n]*/gu, "")
    .replace(/我将执行[：:][^\n。]{0,120}。/gu, "")
    .trim();
}

function toolProtocolPrompt(text: string, tools: unknown[] = [], choice: unknown): string {
  if (tools.length === 0 || String(choice ?? "").toLowerCase() === "none") return text;
  const definitions: string[] = [];
  for (const raw of tools) {
    const tool = raw as { function?: { name?: string; description?: string; parameters?: unknown }; name?: string; description?: string; parameters?: unknown };
    const fn = tool.function ?? tool;
    if (!fn.name) continue;
    definitions.push(`${fn.name} — ${fn.description ?? ""}\n\`\`\`${fn.name}\n${JSON.stringify(fn.parameters ?? {})}\n\`\`\``);
  }
  if (definitions.length === 0) return text;
  const explicit = typeof choice === "object" && choice
    ? ((choice as { function?: { name?: string }; name?: string }).function?.name ?? (choice as { name?: string }).name)
    : undefined;
  const mode = explicit ? `named:${explicit}` : String(choice ?? "auto").toLowerCase();
  return `You are an execution agent. The tools below are real client-side tools exposed by the caller, not hypothetical M365 plugins.
The Cloudflare Worker is a server-only relay: it has no shell, Linux container, Windows filesystem, desktop, or process-launch capability. The caller's local tool runtime is the only permitted execution target.
Use the native client-tool channel as the primary mechanism. If that channel is unavailable and a tool is needed, the compatibility call is mandatory: emit ONLY one fenced block whose info string is the exact tool name and whose body is a JSON object of arguments. The fenced block requests execution by the caller; it does not execute anything. Do not wrap a call in XML or explanatory prose.
MODE auto: call one tool only when external information or action is still required; otherwise answer the user directly.
MODE required: call one valid tool. MODE named:function_name: call that exact tool.
Never substitute a Microsoft-hosted computer, search, Linux container, shell, or filesystem for a caller tool. Treat caller tool results in the request as authoritative. Do not infer that a caller path, credential, host, or command is missing or failed without a matching tool result. Native-channel absence is not a reason to answer CLIENT_TOOL_UNAVAILABLE when a fenced compatibility call can be emitted. Output exactly CLIENT_TOOL_UNAVAILABLE only if neither the native channel nor a valid fenced compatibility call can represent the required call. Never execute, simulate, or claim completion before the caller returns a matching tool result.

TOOL_MODE: ${mode}

<tools>
${definitions.join("\n\n")}
</tools>

User request:
${text}`;
}

// ChatHub has a native client-plugin channel in addition to the textual
// compatibility prompt.  The server implementation always populates it.  If
// Workers sends an empty plugin list, M365 can treat declared OpenAI tools as
// ordinary prose and the downstream adapter is forced to guess a call from
// text.  Keep both representations: native plugins are the primary signal and
// the prompt remains a bounded compatibility fallback for model variants that
// only emit fenced calls.
export function clientPlugins(tools: unknown[] = []): Array<Record<string, unknown>> {
  const plugins: Array<Record<string, unknown>> = [];
  // These tools must execute on the caller. Registering their familiar names
  // in M365's native plugin list can make ChatHub bind them to a hosted Linux
  // shell or filesystem. Keep them in toolProtocolPrompt for the fenced-call
  // compatibility path, which the gateway converts back into a Responses
  // function_call for Codex to execute locally.
  const compatibilityOnly = new Set(["exec_command", "write_stdin", "view_image"]);
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as {
      type?: string;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
    };
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    if (typeof fn.name !== "string" || !fn.name.trim()) continue;
    if (compatibilityOnly.has(fn.name.trim())) continue;
    plugins.push({
      Id: fn.name.trim(),
      Source: "Client",
      Description: typeof fn.description === "string" ? fn.description : "",
      Parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : {},
    });
  }
  return plugins;
}

export function parseFunctionCall(text: string, tools: unknown[] = [], inferredName?: string): FunctionCall | null {
  const names = new Set<string>();
  for (const raw of tools) {
    const tool = raw as { function?: { name?: string }; name?: string };
    const name = tool.function?.name ?? tool.name;
    if (name) names.add(name);
  }
  if (names.size === 0) return null;

  for (const match of text.matchAll(/```([^\s`]*)\s*\n?([\s\S]*?)```/gu)) {
    const info = match[1].trim();
    try {
      const parsed = JSON.parse(match[2].trim()) as unknown;
      if (names.has(info)) {
        const args = encodedArguments(parsed);
        if (args && validateToolArguments(info, args, tools)) return { name: info, arguments: args };
      }
      const call = callFromJSON(parsed, names, inferredName);
      if (call && validateToolArguments(call.name, call.arguments, tools)) return call;
    } catch { /* try the next declared representation */ }
  }

  // A free-form answer can legitimately contain JSON examples. Only accept a
  // tagged payload or an envelope that occupies the complete trimmed answer;
  // never mine nested JSON out of surrounding narration.
  const candidates = [
    ...Array.from(text.matchAll(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/giu), (match) => match[1]),
    text.trim(),
  ];
  for (const candidate of candidates) {
    try {
      const call = callFromJSON(JSON.parse(candidate), names, inferredName);
      if (call && validateToolArguments(call.name, call.arguments, tools)) return call;
    } catch { /* try the next candidate */ }
  }

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`^\\s*${escaped}\\s*\\(\\s*([\\s\\S]*?)\\s*\\)\\s*$`, "u").exec(text);
    if (!match) continue;
    try {
      const args = encodedArguments(JSON.parse(match[1]));
      if (args && validateToolArguments(name, args, tools)) return { name, arguments: args };
    } catch { /* not a valid function call */ }
  }
  return null;
}

// ChatHub can return client-plugin invocations inside nested SignalR update
// messages without rendering a textual fenced call. Walk only the bounded
// upstream event currently being processed and accept an invocation only when
// both its name and argument field are explicit. This deliberately does not
// infer a call from ordinary event data or from the declared plugin schema.
export function parseNativeFunctionCall(value: unknown, tools: unknown[] = []): FunctionCall | null {
  const names = new Set<string>();
  for (const raw of tools) {
    const tool = raw as { function?: { name?: string }; name?: string };
    const name = tool.function?.name ?? tool.name;
    if (name) names.add(name);
  }
  if (names.size === 0) return null;

  let visited = 0;
  const walk = (candidate: unknown, depth: number, inheritedInvocationContext = false): FunctionCall | null => {
    if (depth > 32 || visited++ > 50_000 || candidate === null || typeof candidate !== "object") return null;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const call = walk(item, depth + 1, inheritedInvocationContext);
        if (call) return call;
      }
      return null;
    }
    const record = candidate as Record<string, unknown>;
    const invocationContext = inheritedInvocationContext || [record.contentType, record.messageType, record.type, record.kind]
      .some((item) => typeof item === "string" && /(?:tool|function|plugin).*(?:call|invocation)|(?:call|invocation).*(?:tool|function|plugin)/iu.test(item));
    const candidates: Array<{ name: unknown; fields: string[] }> = [
      { name: record.functionName, fields: ["functionArguments", "arguments", "args", "input", ...(invocationContext ? ["parameters"] : [])] },
      { name: record.toolName, fields: ["arguments", "args", "input", "functionArguments", ...(invocationContext ? ["parameters"] : [])] },
      { name: record.pluginName, fields: ["arguments", "args", "input", "functionArguments", ...(invocationContext ? ["parameters"] : [])] },
      // Generic name/id plus `parameters` is the shape of a plugin definition,
      // not proof of invocation. It is accepted only inside an explicit call
      // event such as contentType=ToolCall.
      { name: record.name, fields: ["arguments", "args", "input", "functionArguments", ...(invocationContext ? ["parameters"] : [])] },
      { name: record.id, fields: ["arguments", "args", "input", "functionArguments", ...(invocationContext ? ["parameters"] : [])] },
    ];
    for (const named of candidates) {
      if (typeof named.name !== "string" || !names.has(named.name)) continue;
      for (const key of named.fields) {
        if (!(key in record)) continue;
        const args = encodedArguments(record[key]);
        if (args && validateToolArguments(named.name, args, tools)) return { name: named.name, arguments: args };
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      const childInvocationContext = invocationContext && ["payload", "invocation", "call", "toolCall", "functionCall", "value"].includes(key);
      const call = walk(nested, depth + 1, childInvocationContext);
      if (call) return call;
    }
    return null;
  };
  return walk(value, 0);
}

function webSocketURL(account: OAuthTokenSet, sessionId: string, conversationId: string, requestId: string): string {
  const url = new URL(`${CHAT_HUB}/${encodeURIComponent(account.oid)}@${encodeURIComponent(account.tid)}`);
  url.searchParams.set("chatsessionid", requestId);
  url.searchParams.set("clientrequestid", requestId);
  url.searchParams.set("X-SessionId", sessionId);
  url.searchParams.set("ConversationId", conversationId);
  url.searchParams.set("access_token", account.accessToken);
  url.searchParams.set("variants", VARIANTS);
  url.searchParams.set("source", '"officeweb"');
  url.searchParams.set("product", "Office");
  url.searchParams.set("agentHost", "Bizchat.FullScreen");
  url.searchParams.set("licenseType", "Starter");
  url.searchParams.set("agent", "web");
  url.searchParams.set("scenario", "OfficeWebIncludedCopilot");
  return url.toString();
}

export interface ChatHubImageAttachment {
  type: "image";
  url: string;
  mimeType: string;
}

/**
 * Validate the internal attachment boundary independently of the OpenAI
 * adapter. This must run before dialing ChatHub so a malformed or oversized
 * image can never consume an account connection.
 */
export function chatHubAttachments(value: unknown): ChatHubImageAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("INVALID_CHAT_HUB_ATTACHMENTS");
  const normalized = normalizeMultimodalContent(value);
  // ChatHubRequest.attachments is image-only. Reject runtime callers that try
  // to smuggle text or unsupported content through the internal field.
  if (normalized.text || normalized.attachments.length !== value.length) {
    throw new Error("INVALID_CHAT_HUB_ATTACHMENTS");
  }
  return normalized.attachments.map((attachment) => ({
    type: "image",
    url: attachment.url,
    mimeType: attachment.mimeType,
  }));
}

function buildChatPayload(request: ChatHubRequest, requestId: string, attachments: ChatHubImageAttachment[]): string {
  const invocation = {
    arguments: [{
      source: "officeweb",
      clientCorrelationId: crypto.randomUUID(),
      sessionId: request.sessionId,
      optionsSets: [],
      options: {},
      allowedMessageTypes: ["Chat", "EndOfRequest"],
      sliceIds: [],
      threadLevelGptId: {},
      conversationId: request.conversationId,
      traceId: crypto.randomUUID(),
      isStartOfSession: request.started,
      productThreadType: "Office",
      clientInfo: { clientPlatform: "mcmcopilot-web", clientAppName: "Office" },
      tone: request.tone,
      streamingMode: "ConciseWithPadding",
      message: {
        author: "user",
        attachments,
        inputMethod: "Keyboard",
        text: toolProtocolPrompt(request.text, request.tools, request.toolChoice),
        requestId,
        locationInfo: { timeZoneOffset: 8, timeZone: "Asia/Shanghai" },
        locale: "en-US",
        messageType: "Chat",
        experienceType: "Default",
      },
      plugins: clientPlugins(request.tools),
      toolChoice: request.toolChoice,
    }],
    invocationId: "0",
    target: "chat",
    type: 4,
  };
  const metrics = {
    arguments: [{ Timestamps: { ConnectionStart: "", UserInputStart: "", ConnectionEstablished: "", UserInputSubmit: "" } }],
    target: "Metrics",
    type: 1,
  };
  return `${JSON.stringify(invocation)}${RS}${JSON.stringify(metrics)}${RS}`;
}

/** Exposed for protocol contract tests; runtime validation is identical. */
export function chatPayload(request: ChatHubRequest, requestId: string): string {
  return buildChatPayload(request, requestId, chatHubAttachments(request.attachments));
}

/** Merge de-duplicated image outputs while bounding retained URL/data bytes. */
export function appendUpstreamImageURLs(current: readonly string[], event: unknown): string[] {
  const output = current.slice(0, 4);
  const seen = new Set(output);
  let characters = output.reduce((total, value) => total + value.length, 0);
  for (const candidate of extractUpstreamImageURLs(event)) {
    if (output.length >= 4 || seen.has(candidate)) continue;
    if (characters + candidate.length > MAX_UPSTREAM_IMAGE_URL_CHARACTERS) {
      throw new Error("CHAT_IMAGE_OUTPUT_TOO_LARGE");
    }
    seen.add(candidate);
    output.push(candidate);
    characters += candidate.length;
  }
  return output;
}

function asText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data ?? "");
}

export interface SocketReader {
  next(timeoutMs: number): Promise<string>;
  close(): void;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause ?? "UNKNOWN_CHAT_ERROR");
}

/**
 * A same-account reconnect is safe only while the invocation has not been
 * submitted to ChatHub. Once chatPayload() has been sent, the upstream may
 * already have performed searches or other side effects even if no text delta
 * has reached the client. Replaying that invocation can duplicate work and is
 * a material account-risk signal.
 */
export function mayReconnectChatHubFailure(cause: unknown, invocationSubmitted: boolean): boolean {
  if (invocationSubmitted) return false;
  const message = failureMessage(cause).toUpperCase();
  if (message === "WS_DIAL_ERROR" || message === "WS_READ_TIMEOUT" || message === "WS_ERROR_BEFORE_COMPLETION") return true;
  if (message.startsWith("WS_CLOSED_BEFORE_COMPLETION:")) return true;
  if (message.startsWith("WS_DIAL_FAILED:408") || message.startsWith("WS_DIAL_FAILED:425")) return true;
  return /^WS_DIAL_FAILED:5\d\d(?:\D|$)/u.test(message);
}

export class ChatHubAttemptError extends Error {
  readonly reconnectSafe: boolean;
  readonly invocationSubmitted: boolean;
  readonly terminalEmptyQuota: boolean;

  constructor(cause: unknown, invocationSubmitted: boolean, terminalEmptyQuota = false) {
    super(failureMessage(cause));
    this.name = "ChatHubAttemptError";
    this.invocationSubmitted = invocationSubmitted;
    this.terminalEmptyQuota = terminalEmptyQuota;
    this.reconnectSafe = mayReconnectChatHubFailure(cause, invocationSubmitted);
  }
}

/**
 * Cross-account failover is another replay of the logical invocation. Keep
 * this decision structured: once ChatHub accepted chatPayload(), neither a
 * timeout nor a close nor a transient 5xx may cause the prompt to be sent to
 * a second account, even when no downstream delta was observed.
 */
export function mayFailOverChatHubFailure(cause: unknown): boolean {
  const message = failureMessage(cause).toUpperCase();
  if (message === "REQUEST_ABORTED" || message === "CHAT_DEADLINE_EXCEEDED" || message === "CHAT_PROGRESS_TIMEOUT") return false;
  if (cause instanceof ChatHubAttemptError && cause.terminalEmptyQuota) return true;
  return !(cause instanceof ChatHubAttemptError) || !cause.invocationSubmitted;
}

export function chatHubInvocationWasSubmitted(cause: unknown): boolean {
  return cause instanceof ChatHubAttemptError && cause.invocationSubmitted;
}

export function isTerminalEmptyQuotaFailure(cause: unknown): boolean {
  return cause instanceof ChatHubAttemptError && cause.terminalEmptyQuota;
}

/**
 * Wait for the next semantic frame without treating an otherwise healthy,
 * silent WebSocket as dead every 60 seconds. The outer request deadline stays
 * authoritative; the short reads merely let the runtime observe cancellation
 * and keep sending protocol pings while a long model turn is computing.
 */
export async function nextChatHubFrame(
  reader: Pick<SocketReader, "next">,
  deadlineAt: number,
  readSliceMs = 60_000,
): Promise<string> {
  for (;;) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("CHAT_DEADLINE_EXCEEDED");
    try {
      return await reader.next(Math.max(1, Math.min(readSliceMs, remaining)));
    } catch (cause) {
      if (failureMessage(cause) !== "WS_READ_TIMEOUT") throw cause;
      if (Date.now() >= deadlineAt) throw new Error("CHAT_DEADLINE_EXCEEDED");
    }
  }
}

export async function nextProgressBoundedChatHubFrame(
  reader: Pick<SocketReader, "next">,
  requestDeadlineAt: number,
  progressDeadlineAt: number,
): Promise<string> {
  const effectiveDeadline = Math.min(requestDeadlineAt, progressDeadlineAt);
  try {
    return await nextChatHubFrame(reader, effectiveDeadline);
  } catch (cause) {
    if (
      failureMessage(cause) === "CHAT_DEADLINE_EXCEEDED"
      && progressDeadlineAt < requestDeadlineAt
      && Date.now() >= progressDeadlineAt
    ) {
      throw new Error("CHAT_PROGRESS_TIMEOUT");
    }
    throw cause;
  }
}

/** Parse the SignalR handshake without consuming a coalesced first event. */
export function parseSignalRHandshake(frame: string): string {
  const parts = frame.split(RS);
  const firstIndex = parts.findIndex((part) => part.trim().length > 0);
  if (firstIndex < 0) throw new Error("WS_HANDSHAKE_EMPTY");
  let handshake: unknown;
  try {
    handshake = JSON.parse(parts[firstIndex]) as unknown;
  } catch {
    throw new Error("WS_HANDSHAKE_INVALID");
  }
  if (!handshake || typeof handshake !== "object" || Array.isArray(handshake)) throw new Error("WS_HANDSHAKE_INVALID");
  const record = handshake as Record<string, unknown>;
  if (Object.hasOwn(record, "error")) throw new Error("WS_HANDSHAKE_FAILED");
  if (Object.keys(record).length > 0) throw new Error("WS_HANDSHAKE_UNEXPECTED_FRAME");
  return parts.slice(firstIndex + 1).filter((part) => part.trim()).map((part) => `${part}${RS}`).join("");
}

export function socketReader(socket: WebSocket, maximumQueuedCharacters = MAX_QUEUED_SOCKET_CHARACTERS): SocketReader {
  const queued: string[] = [];
  let queuedCharacters = 0;
  const waiting: Array<{ resolve: (value: string) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let terminal: Error | null = null;
  const settle = (value: string): void => {
    if (terminal) return;
    const waiter = waiting.shift();
    if (!waiter) {
      if (queuedCharacters + value.length > maximumQueuedCharacters) {
        fail(new Error("WS_BUFFER_TOO_LARGE"), true);
        try { socket.close(1009, "buffer too large"); } catch { /* already closed */ }
        return;
      }
      queued.push(value);
      queuedCharacters += value.length;
    }
    else {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  };
  const fail = (reason: Error, discardQueued = false): void => {
    terminal = reason;
    if (discardQueued) {
      queued.length = 0;
      queuedCharacters = 0;
    }
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  };
  socket.addEventListener("message", (event) => {
    const value = asText(event.data);
    if (value.length > MAX_FRAME_CHARACTERS) {
      fail(new Error("WS_FRAME_TOO_LARGE"), true);
      try { socket.close(1009, "frame too large"); } catch { /* already closed */ }
      return;
    }
    settle(value);
  });
  socket.addEventListener("close", (event) => fail(new Error(`WS_CLOSED_BEFORE_COMPLETION:${event.code}`)));
  socket.addEventListener("error", () => fail(new Error("WS_ERROR_BEFORE_COMPLETION")));
  return {
    next(timeoutMs: number): Promise<string> {
      const value = queued.shift();
      if (value !== undefined) {
        queuedCharacters -= value.length;
        return Promise.resolve(value);
      }
      if (terminal) return Promise.reject(terminal);
      return new Promise((resolve, reject) => {
        const record = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiting.indexOf(record);
            if (index >= 0) waiting.splice(index, 1);
            reject(new Error("WS_READ_TIMEOUT"));
          }, timeoutMs),
        };
        waiting.push(record);
      });
    },
    close(): void {
      fail(new Error("WS_CLOSED"));
      try { socket.close(1000, "complete"); } catch { /* already closed */ }
    },
  };
}

export function appendChatSnapshot(current: string, snapshot: string, emit?: (delta: string) => void): string {
  if (!snapshot) return current;
  if (!current) {
    emit?.(snapshot);
    return snapshot;
  }
  if (snapshot.startsWith(current)) {
    const delta = snapshot.slice(current.length);
    if (delta) emit?.(delta);
    return snapshot;
  }
  return current;
}

async function runChatHub(
  account: OAuthTokenSet,
  request: ChatHubRequest,
  emit?: (delta: string) => void,
  relay?: ChatHubRelay,
): Promise<ChatHubResult> {
  if (request.signal?.aborted) throw new Error("REQUEST_ABORTED");
  // This is deliberately outside the WebSocket fetch try/catch. A protocol
  // validation failure is a caller error, not a transport failure eligible
  // for reconnect or cross-account failover.
  const attachments = chatHubAttachments(request.attachments);
  const requestId = crypto.randomUUID();
  let invocationSubmitted = false;
  let invalidJSONFrames = 0;
  const unknownFrameTypes = new Set<string>();
  const unknownTargets = new Set<string>();
  let response: Response;
  const connection = relay
    ? await relayWebSocketRequest(account, request.sessionId, request.conversationId, requestId, relay)
    : {
        url: webSocketURL(account, request.sessionId, request.conversationId, requestId),
        headers: new Headers({
          Upgrade: "websocket",
          Origin: "https://m365.cloud.microsoft",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
        }),
      };
  try {
    response = await fetch(connection.url, {
      headers: connection.headers,
      signal: request.signal,
    });
  } catch {
    // Never propagate the fetch error: Cloudflare includes the full URL and
    // therefore the access_token query parameter in that error string.
    if (request.deadlineAt && Date.now() >= request.deadlineAt) {
      throw new ChatHubAttemptError(new Error("CHAT_DEADLINE_EXCEEDED"), false);
    }
    if (request.signal?.aborted) throw new ChatHubAttemptError(new Error("REQUEST_ABORTED"), false);
    if (relay) throw new ChatHubAttemptError(new Error("RELAY_DIAL_ERROR"), false);
    throw new ChatHubAttemptError(new Error("WS_DIAL_ERROR"), false);
  }
  const socket = response.webSocket;
  if (!socket) throw new ChatHubAttemptError(new Error(`${relay ? "RELAY_DIAL_FAILED" : "WS_DIAL_FAILED"}:${response.status}`), false);
  socket.accept();
  const reader = socketReader(socket);
  const abort = (): void => reader.close();
  request.signal?.addEventListener("abort", abort, { once: true });
  let ping: ReturnType<typeof setInterval> | undefined;
  try {
    socket.send(`{"protocol":"json","version":1}${RS}`);
    const deadline = request.deadlineAt ?? Date.now() + 10 * 60_000;
    let pendingFrame = parseSignalRHandshake(await reader.next(Math.max(1, Math.min(45_000, deadline - Date.now()))));
    ping = setInterval(() => {
      try { socket.send(`{"type":6}${RS}`); } catch { /* read side reports closure */ }
    }, 15_000);
    socket.send(buildChatPayload(request, requestId, attachments));
    invocationSubmitted = true;

    let streamed = "";
    let final = "";
    let resultError = "";
    let throttling: unknown;
    let functionCall: FunctionCall | null = null;
    let images: string[] = [];
    let progressDeadline = Math.min(deadline, Date.now() + CHAT_PROGRESS_IDLE_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const frame = pendingFrame || await nextProgressBoundedChatHubFrame(reader, deadline, progressDeadline);
      pendingFrame = "";
      let semanticProgress = false;
      for (const part of frame.split(RS)) {
        if (!part.trim()) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(part) as Record<string, unknown>; } catch {
          invalidJSONFrames += 1;
          continue;
        }
        images = appendUpstreamImageURLs(images, event);
        const parsedFunctionCall = parseNativeFunctionCall(event, request.tools);
        if (!functionCall && parsedFunctionCall) semanticProgress = true;
        functionCall ||= parsedFunctionCall;
        const type = Number(event.type ?? 0);
        if (![1, 2, 3, 6, 7].includes(type)) {
          unknownFrameTypes.add(Number.isSafeInteger(type) ? String(type) : "non_numeric");
        }
        if (type === 6) {
          socket.send(`{"type":6}${RS}`);
          continue;
        }
        if (type === 1 && event.target === "update") {
          semanticProgress = true;
          for (const raw of (event.arguments as unknown[] | undefined) ?? []) {
            const update = raw as Record<string, unknown>;
            if (Object.hasOwn(update, "throttling")) throttling = update.throttling;
            const messages = (update.messages as Array<Record<string, unknown>> | undefined) ?? [];
            const toolFrame = messages.some((message) => message.messageType === "Progress" || ["SearchResults", "Code", "ToolCall"].includes(String(message.contentType ?? "")));
            if (!toolFrame && typeof update.writeAtCursor === "string") {
              streamed += update.writeAtCursor;
              if (streamed.length > MAX_OUTPUT_CHARACTERS) throw new Error("CHAT_OUTPUT_TOO_LARGE");
              emit?.(update.writeAtCursor);
            }
            for (const message of messages) {
              if (message.author === "bot" && typeof message.text === "string") {
                if (message.text.length > MAX_OUTPUT_CHARACTERS) throw new Error("CHAT_OUTPUT_TOO_LARGE");
                streamed = appendChatSnapshot(streamed, message.text, emit);
              }
            }
          }
          continue;
        }
        if (type === 1) {
          unknownTargets.add(safeProtocolLabel(event.target));
          continue;
        }
        if (type === 2) {
          semanticProgress = true;
          const item = event.item as Record<string, unknown> | undefined;
          if (item && Object.hasOwn(item, "throttling")) throttling = item.throttling;
          const result = item?.result as Record<string, unknown> | undefined;
          if (typeof result?.message === "string") {
            if (result.message.length > MAX_OUTPUT_CHARACTERS) throw new Error("CHAT_OUTPUT_TOO_LARGE");
            final = result.message;
          }
          if (typeof result?.value === "string" && result.value) {
            try {
              const parsed = JSON.parse(result.value) as unknown;
              resultError = upstreamErrorLabel(parsed);
              if (resultError === "unknown") resultError = "";
            } catch { /* opaque successful value */ }
          }
          continue;
        }
        if (type === 3) {
          if (event.error) throw new Error(`CHAT_COMPLETION_ERROR:${upstreamErrorLabel(event.error)}`);
          if (resultError) throw new Error(`CHAT_UPSTREAM_ERROR:${resultError}`);
          const text = scrubNarration(final || streamed);
          if (!text && !functionCall && images.length === 0) {
            if (quotaExhausted(throttling)) throw new Error("CHAT_THROTTLED_QUOTA_EXHAUSTED");
            throw new Error("CHAT_RETURNED_NO_CONTENT");
          }
          return {
            text,
            conversationId: request.conversationId,
            sessionId: request.sessionId,
            requestId,
            ...(images.length > 0 ? { images } : {}),
            ...(functionCall ? { functionCall } : {}),
            ...(throttling === undefined ? {} : { throttling }),
          };
        }
        if (type === 7) throw new Error(`CHAT_CLOSED_BEFORE_COMPLETION:${upstreamErrorLabel(event.error)}`);
      }
      if (semanticProgress) {
        progressDeadline = Math.min(deadline, Date.now() + CHAT_PROGRESS_IDLE_TIMEOUT_MS);
      }
    }
    throw new Error("CHAT_DEADLINE_EXCEEDED");
  } catch (cause) {
    // Abort is not an account failure and must never trigger either a
    // same-account replay or a switch to another account in exchange().
    if (request.deadlineAt && Date.now() >= request.deadlineAt) {
      throw new ChatHubAttemptError(new Error("CHAT_DEADLINE_EXCEEDED"), invocationSubmitted);
    }
    if (request.signal?.aborted) throw new ChatHubAttemptError(new Error("REQUEST_ABORTED"), invocationSubmitted);
    throw new ChatHubAttemptError(
      cause,
      invocationSubmitted,
      failureMessage(cause).toUpperCase() === "CHAT_THROTTLED_QUOTA_EXHAUSTED",
    );
  } finally {
    if (invalidJSONFrames > 0 || unknownFrameTypes.size > 0 || unknownTargets.size > 0) {
      console.warn(JSON.stringify({
        event: "chathub_protocol_drift",
        invalid_json_frames: invalidJSONFrames,
        unknown_frame_types: [...unknownFrameTypes].slice(0, 16),
        unknown_targets: [...unknownTargets].slice(0, 16),
      }));
    }
    request.signal?.removeEventListener("abort", abort);
    if (ping) clearInterval(ping);
    reader.close();
  }
}

export async function chatHub(
  account: OAuthTokenSet,
  request: ChatHubRequest,
  emit?: (delta: string) => void,
  relay?: ChatHubRelay,
): Promise<ChatHubResult> {
  let last: unknown;
  const deadlineAt = request.deadlineAt ?? Date.now() + 10 * 60_000;
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
  const signal = request.signal ? AbortSignal.any([request.signal, deadlineSignal]) : deadlineSignal;
  const boundedRequest = { ...request, deadlineAt, signal };
  // One bounded reconnect is allowed only before any downstream delta. All
  // attempts share one 600-second deadline, so a retry can never multiply the
  // total task duration or turn an upstream stall into an apparent loop.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let emitted = false;
    try {
      return await runChatHub(account, boundedRequest, (delta) => {
        if (delta) emitted = true;
        emit?.(delta);
      }, relay);
    } catch (cause) {
      if (Date.now() >= deadlineAt) {
        if (cause instanceof ChatHubAttemptError) throw cause;
        throw new ChatHubAttemptError(new Error("CHAT_DEADLINE_EXCEEDED"), false);
      }
      last = cause;
      if (
        signal.aborted
        || emitted
        || attempt === 1
        || Date.now() >= deadlineAt
        || !(cause instanceof ChatHubAttemptError && cause.reconnectSafe)
      ) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw last;
}
