import { openAIRequest } from "./openai";
import { MAX_AI_REQUEST_BYTES, readJSONLimited, RequestBodyError } from "./request-body";
import type { RequestMetricTracker } from "./request-metrics";
import type { Env } from "./types";

const MAX_REQUEST_BYTES = MAX_AI_REQUEST_BYTES;
const encoder = new TextEncoder();

type OpenAIRequestHandler = (
  request: Request,
  env: Env,
  url: URL,
  metrics?: RequestMetricTracker,
) => Promise<Response>;

interface AnthropicBody {
  model?: unknown;
  max_tokens?: unknown;
  messages?: unknown;
  system?: unknown;
  stream?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  metadata?: unknown;
}

interface OpenAIErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

interface OpenAIChoice {
  message?: {
    content?: unknown;
    tool_calls?: unknown;
  };
  delta?: {
    content?: unknown;
    tool_calls?: unknown;
  };
  finish_reason?: unknown;
}

interface OpenAICompletion {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

interface ConvertedRequest {
  model: string;
  maxTokens: number;
  stream: boolean;
  openAI: Record<string, unknown>;
}

class AnthropicRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: AnthropicErrorType,
    readonly publicMessage: string,
  ) {
    super("ANTHROPIC_REQUEST_ERROR");
  }
}

type AnthropicErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "rate_limit_error"
  | "overloaded_error"
  | "api_error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonHeaders(): HeadersInit {
  return { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
}

export function anthropicErrorResponse(
  status: number,
  type: AnthropicErrorType,
  message: string,
  code: string = type,
): Response {
  const headers = new Headers(jsonHeaders());
  headers.set("X-M365-Error-Code", /^[a-z0-9_]{1,64}$/u.test(code) ? code : "api_error");
  return Response.json({ type: "error", error: { type, message } }, { status, headers });
}

function invalid(message: string, status = 400): never {
  throw new AnthropicRequestError(status, "invalid_request_error", message);
}

async function readBody(request: Request): Promise<AnthropicBody> {
  try {
    const parsed = await readJSONLimited<unknown>(request, MAX_REQUEST_BYTES);
    if (!isRecord(parsed)) invalid("request body must be a JSON object");
    return parsed as AnthropicBody;
  } catch (cause) {
    if (cause instanceof AnthropicRequestError) throw cause;
    if (cause instanceof RequestBodyError && cause.code === "REQUEST_TOO_LARGE") {
      invalid("request body exceeds the 8 MiB limit", 413);
    }
    invalid("request body must be valid JSON");
  }
}

function textBlocks(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) invalid(`${field} must be a string or an array of text blocks`);
  const pieces: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      invalid(`${field} supports text blocks only`);
    }
    pieces.push(block.text);
  }
  return pieces.join("\n");
}

function toolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = textBlocks(content, "tool_result.content");
  else if (content == null) text = "";
  else text = JSON.stringify(content);
  if (block.is_error === true && !/\b(?:error|failed|failure|exception|timed?\s*out)\b|\u9519\u8bef|\u5931\u8d25|\u8d85\u65f6/iu.test(text)) {
    return `error: ${text || "tool execution failed"}`;
  }
  return text;
}

function assistantMessage(content: unknown): Record<string, unknown> {
  if (typeof content === "string") return { role: "assistant", content };
  if (!Array.isArray(content)) invalid("assistant message content must be a string or content block array");
  const text: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of content) {
    if (!isRecord(block)) invalid("assistant content blocks must be objects");
    if (block.type === "text") {
      if (typeof block.text !== "string") invalid("text blocks require a text string");
      text.push(block.text);
      continue;
    }
    if (block.type === "tool_use") {
      const id = typeof block.id === "string" ? block.id.trim() : "";
      const name = typeof block.name === "string" ? block.name.trim() : "";
      if (!id || !name || !isRecord(block.input)) invalid("tool_use blocks require id, name, and an object input");
      toolCalls.push({ id, type: "function", function: { name, arguments: JSON.stringify(block.input) } });
      continue;
    }
    invalid(`unsupported assistant content block: ${String(block.type ?? "unknown")}`);
  }
  const result: Record<string, unknown> = { role: "assistant", content: text.length > 0 ? text.join("\n") : null };
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return result;
}

function userMessages(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) invalid("user message content must be a string or content block array");
  const result: Record<string, unknown>[] = [];
  let text: string[] = [];
  const flushText = (): void => {
    if (text.length === 0) return;
    result.push({ role: "user", content: text.join("\n") });
    text = [];
  };
  for (const block of content) {
    if (!isRecord(block)) invalid("user content blocks must be objects");
    if (block.type === "text") {
      if (typeof block.text !== "string") invalid("text blocks require a text string");
      text.push(block.text);
      continue;
    }
    if (block.type === "tool_result") {
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
      if (!callId) invalid("tool_result blocks require tool_use_id");
      flushText();
      result.push({ role: "tool", tool_call_id: callId, content: toolResultText(block) });
      continue;
    }
    invalid(`unsupported user content block: ${String(block.type ?? "unknown")}`);
  }
  flushText();
  if (result.length === 0) result.push({ role: "user", content: "" });
  return result;
}

function convertMessages(value: unknown, system: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) invalid("messages must be a non-empty array");
  const result: Record<string, unknown>[] = [];
  if (system != null) {
    const content = textBlocks(system, "system");
    if (content) result.push({ role: "system", content });
  }
  for (const raw of value) {
    if (!isRecord(raw) || !["user", "assistant"].includes(String(raw.role ?? ""))) {
      invalid("each message requires a user or assistant role");
    }
    if (raw.role === "assistant") result.push(assistantMessage(raw.content));
    else result.push(...userMessages(raw.content));
  }
  return result;
}

function convertTools(value: unknown): Record<string, unknown>[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 128) invalid("tools must be an array containing at most 128 definitions");
  return value.map((raw) => {
    if (!isRecord(raw)) invalid("tool definitions must be objects");
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || !isRecord(raw.input_schema)) invalid("each tool requires name and input_schema");
    const definition: Record<string, unknown> = {
      name,
      parameters: raw.input_schema,
    };
    if (typeof raw.description === "string") definition.description = raw.description;
    return { type: "function", function: definition };
  });
}

function convertToolChoice(value: unknown): unknown {
  if (value == null) return undefined;
  if (!isRecord(value)) invalid("tool_choice must be an object");
  switch (value.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (!name) invalid("tool_choice type tool requires a name");
      return { type: "function", function: { name } };
    }
    default:
      invalid("tool_choice type must be auto, any, none, or tool");
  }
}

export function convertAnthropicBody(parsed: AnthropicBody): ConvertedRequest {
  const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  if (!model) invalid("model is required");
  const maxTokens = typeof parsed.max_tokens === "number" && Number.isInteger(parsed.max_tokens)
    ? parsed.max_tokens
    : 0;
  if (maxTokens < 1) invalid("max_tokens must be a positive integer");
  if (parsed.stream != null && typeof parsed.stream !== "boolean") invalid("stream must be a boolean");
  const tools = convertTools(parsed.tools);
  const toolChoice = convertToolChoice(parsed.tool_choice);
  if (toolChoice !== undefined && !tools?.length && toolChoice !== "none") invalid("tool_choice requires at least one tool");
  const openAI: Record<string, unknown> = {
    model,
    messages: convertMessages(parsed.messages, parsed.system),
    stream: parsed.stream === true,
  };
  if (tools) openAI.tools = tools;
  if (toolChoice !== undefined) openAI.tool_choice = toolChoice;
  return { model, maxTokens, stream: parsed.stream === true, openAI };
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function firstChoice(value: unknown): OpenAIChoice {
  if (!Array.isArray(value) || !isRecord(value[0])) throw new Error("INVALID_OPENAI_RESPONSE");
  return value[0] as OpenAIChoice;
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("INVALID_OPENAI_RESPONSE");
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error("INVALID_OPENAI_RESPONSE");
  return parsed;
}

function anthropicId(value: unknown): string {
  const suffix = typeof value === "string" ? value.replace(/^[^_]*_/u, "") : crypto.randomUUID().replaceAll("-", "");
  return `msg_${suffix || crypto.randomUUID().replaceAll("-", "")}`;
}

function nonStreamingMessage(body: OpenAICompletion, requestedModel: string): Record<string, unknown> {
  const choice = firstChoice(body.choices);
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Record<string, unknown>[] = [];
  if (typeof message.content === "string" && message.content.length > 0) content.push({ type: "text", text: message.content });
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.function) || typeof raw.function.name !== "string") {
        throw new Error("INVALID_OPENAI_RESPONSE");
      }
      content.push({
        type: "tool_use",
        id: raw.id,
        name: raw.function.name,
        input: parseToolInput(raw.function.arguments),
      });
    }
  }
  if (content.length === 0 && message.content === "") content.push({ type: "text", text: "" });
  if (content.length === 0) throw new Error("INVALID_OPENAI_RESPONSE");
  const hasTools = content.some((item) => item.type === "tool_use");
  return {
    id: anthropicId(body.id),
    type: "message",
    role: "assistant",
    model: typeof body.model === "string" ? body.model : requestedModel,
    content,
    stop_reason: hasTools || choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: safeInteger(body.usage?.prompt_tokens),
      output_tokens: safeInteger(body.usage?.completion_tokens),
    },
    m365: {
      usage_source: "gateway_estimate",
      usage_values_are_estimates: true,
    },
  };
}

const stableErrorMessages: Record<string, string> = {
  auth_error: "valid API key required",
  invalid_json: "request body must be valid JSON",
  invalid_request_error: "request body is invalid",
  invalid_tools: "tool definitions are invalid",
  tools_too_large: "tool definitions exceed the supported limit",
  request_too_large: "request body exceeds the supported limit",
  vision_not_implemented: "image input is not enabled in this build",
  no_account: "no Microsoft 365 account is configured",
  account_cooldown: "all eligible Microsoft 365 accounts are cooling down; retry later",
  account_pool_isolated: "all Microsoft 365 accounts require administrator attention",
  session_account_unavailable: "the account bound to this conversation is unavailable",
  conversation_busy: "this conversation already has an active request",
  account_busy: "the Microsoft 365 account is busy; retry later",
  upstream_throttled: "the selected Microsoft 365 account has exhausted its current allowance",
  unsupported_model: "the requested model is not supported by this gateway",
  tool_call_generation_failed: "the model did not produce a valid required tool call",
  repeated_tool_failure: "the same tool action failed again; inspect the last result before retrying",
  repeated_tool_call: "the same tool action was already completed or proposed",
  tool_round_limit: "the bounded tool-call limit for this user task has been reached",
  pending_tool_result: "return the pending tool result before requesting another tool call",
  tool_output_already_consumed: "this tool result was already consumed",
  tool_output_mismatch: "the tool result does not match a pending call",
  invalid_tool_history: "the structured tool-call history is invalid",
  upstream_connect_error: "failed to connect to Microsoft ChatHub",
  upstream_disconnected: "Microsoft ChatHub disconnected before completion",
  upstream_timeout: "Microsoft ChatHub timed out before completion",
  upstream_response_error: "Microsoft ChatHub returned an incomplete or failed response",
  upstream_error: "Microsoft ChatHub request failed",
};

function errorType(status: number, code: string): AnthropicErrorType {
  if (status === 401 || status === 403 || code === "auth_error") return "authentication_error";
  if (status === 429 || ["account_cooldown", "account_busy", "upstream_throttled"].includes(code)) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function mappedError(status: number, body: OpenAIErrorBody): { type: AnthropicErrorType; message: string; code: string } {
  const code = typeof body.error?.code === "string" ? body.error.code : "upstream_error";
  return {
    type: errorType(status, code),
    message: stableErrorMessages[code] ?? (status >= 500 ? "Microsoft 365 gateway request failed" : "request could not be processed"),
    code: /^[a-z0-9_]{1,64}$/u.test(code) ? code : "upstream_error",
  };
}

async function mapErrorResponse(response: Response): Promise<Response> {
  let parsed: OpenAIErrorBody = {};
  try {
    parsed = await response.json<OpenAIErrorBody>();
  } catch {
    // Never copy an arbitrary upstream body into a public error.
  }
  const failure = mappedError(response.status, parsed);
  return anthropicErrorResponse(response.status, failure.type, failure.message, failure.code);
}

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function eventData(block: string): string | null {
  const lines = block.split("\n");
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
  return data.length > 0 ? data.join("\n") : null;
}

function streamingResponse(
  upstream: Response,
  model: string,
  downstreamSignal: AbortSignal,
  metrics?: RequestMetricTracker,
): Response {
  const reader = upstream.body?.getReader();
  if (!reader) return anthropicErrorResponse(502, "api_error", "Microsoft 365 gateway returned an invalid stream");
  const decoder = new TextDecoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
      let buffer = "";
      let blockIndex = -1;
      let blockOpen = false;
      let currentBlock: "text" | "tool" | "" = "";
      let sawTerminal = false;
      let failed = false;
      let inputTokens = 0;
      let outputTokens = 0;
      const send = (event: string, data: Record<string, unknown>): void => {
        if (!cancelled) controller.enqueue(sse(event, { type: event, ...data }));
      };
      const closeBlock = (): void => {
        if (!blockOpen) return;
        send("content_block_stop", { index: blockIndex });
        blockOpen = false;
        currentBlock = "";
      };
      const startText = (): void => {
        if (blockOpen && currentBlock === "text") return;
        closeBlock();
        blockIndex += 1;
        blockOpen = true;
        currentBlock = "text";
        send("content_block_start", { index: blockIndex, content_block: { type: "text", text: "" } });
      };
      const startTool = (id: string, name: string): void => {
        if (blockOpen && currentBlock === "tool") return;
        closeBlock();
        blockIndex += 1;
        blockOpen = true;
        currentBlock = "tool";
        send("content_block_start", { index: blockIndex, content_block: { type: "tool_use", id, name, input: {} } });
      };
      const streamFailure = (status: number, raw: OpenAIErrorBody): void => {
        if (failed || cancelled) return;
        failed = true;
        void metrics?.error(200);
        const failure = mappedError(status, raw);
        send("error", { error: failure });
      };
      const consume = (data: string): void => {
        if (failed || cancelled || !data || data === "[DONE]") return;
        let parsed: Record<string, unknown>;
        try {
          const raw = JSON.parse(data) as unknown;
          if (!isRecord(raw)) throw new Error("invalid");
          parsed = raw;
        } catch {
          streamFailure(502, { error: { code: "upstream_response_error" } });
          return;
        }
        if (isRecord(parsed.error)) {
          streamFailure(502, { error: { code: parsed.error.code, message: parsed.error.message } });
          return;
        }
        if (isRecord(parsed.usage)) {
          inputTokens = safeInteger(parsed.usage.prompt_tokens);
          outputTokens = safeInteger(parsed.usage.completion_tokens);
        }
        let choice: OpenAIChoice;
        try {
          choice = firstChoice(parsed.choices);
        } catch {
          streamFailure(502, { error: { code: "upstream_response_error" } });
          return;
        }
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          startText();
          send("content_block_delta", { index: blockIndex, delta: { type: "text_delta", text: delta.content } });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const raw of delta.tool_calls) {
            if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.function) || typeof raw.function.name !== "string") {
              streamFailure(502, { error: { code: "upstream_response_error" } });
              return;
            }
            startTool(raw.id, raw.function.name);
            const partial = typeof raw.function.arguments === "string" ? raw.function.arguments : "";
            if (partial) send("content_block_delta", { index: blockIndex, delta: { type: "input_json_delta", partial_json: partial } });
          }
        }
        if (typeof choice.finish_reason === "string") {
          closeBlock();
          const reason = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
          send("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
          send("message_stop", {});
          sawTerminal = true;
        } else if (Object.keys(delta).length === 0) {
          send("ping", {});
        }
      };
      const onAbort = (): void => {
        if (cancelled) return;
        cancelled = true;
        void metrics?.cancel(200);
        void reader.cancel("downstream aborted").finally(() => {
          try { controller.close(); } catch { /* downstream already closed */ }
        });
      };
      if (downstreamSignal.aborted) onAbort();
      else downstreamSignal.addEventListener("abort", onAbort, { once: true });
      send("message_start", {
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      void (async () => {
        try {
          while (!cancelled && !failed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            buffer = buffer.replace(/\r\n/gu, "\n");
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = eventData(block);
              if (data != null) consume(data);
              boundary = buffer.indexOf("\n\n");
            }
          }
          if (!cancelled && !failed && !sawTerminal) streamFailure(502, { error: { code: "upstream_disconnected" } });
        } catch {
          if (!cancelled) streamFailure(502, { error: { code: "upstream_disconnected" } });
        } finally {
          downstreamSignal.removeEventListener("abort", onAbort);
          if (!cancelled) {
            try { controller.close(); } catch { /* already closed */ }
          }
        }
      })();
    },
    async cancel() {
      cancelled = true;
      void metrics?.cancel(200);
      await reader.cancel("downstream cancelled");
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Native Anthropic Messages compatibility adapter. It deliberately reuses the
 * OpenAI request path so account ordering, isolation, ChatHub persistence,
 * bounded tool-loop protection, quota handling, and cancellation have exactly
 * one implementation in the Cloudflare build.
 */
export async function anthropicRequest(
  request: Request,
  env: Env,
  handler: OpenAIRequestHandler = openAIRequest,
  metrics?: RequestMetricTracker,
): Promise<Response> {
  if (request.method !== "POST") return anthropicErrorResponse(405, "invalid_request_error", "POST is required for /v1/messages", "method_not_allowed");
  try {
    const parsed = await readBody(request);
    const converted = convertAnthropicBody(parsed);
    const target = new URL("/v1/chat/completions", request.url);
    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");
    headers.delete("Content-Length");
    const bridged = new Request(target, {
      method: "POST",
      headers,
      body: JSON.stringify(converted.openAI),
      signal: request.signal,
    });
    const upstream = await handler(bridged, env, target, metrics);
    if (!upstream.ok) return mapErrorResponse(upstream);
    if (converted.stream) return streamingResponse(upstream, converted.model, request.signal, metrics);
    let completion: OpenAICompletion;
    try {
      completion = await upstream.json<OpenAICompletion>();
      return Response.json(nonStreamingMessage(completion, converted.model), { headers: jsonHeaders() });
    } catch {
      return anthropicErrorResponse(502, "api_error", "Microsoft 365 gateway returned an invalid response", "upstream_response_error");
    }
  } catch (cause) {
    if (cause instanceof AnthropicRequestError) return anthropicErrorResponse(cause.status, cause.errorType, cause.publicMessage, "invalid_request_error");
    return anthropicErrorResponse(500, "api_error", "Cloudflare-native gateway request failed", "internal_error");
  }
}
