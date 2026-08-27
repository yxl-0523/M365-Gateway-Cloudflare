import type { RequestMetricInput, RequestSemanticStatus } from "./types";
import { countPromptTokenClasses } from "./models";

const MAX_METRIC_TOKENS = 1_000_000_000;
const MAX_ACCOUNT_ID_LENGTH = 256;

export interface RequestMetricSink {
  recordRequest(input: RequestMetricInput): Promise<unknown>;
}

export interface RequestMetricTrackerOptions {
  /** Opaque, internally generated request ID. Never derive this from a URL. */
  requestId: string;
  sink: RequestMetricSink;
  /** Time at which request processing actually began. */
  startedAt?: number;
  /** Injectable monotonic-enough wall clock for deterministic tests. */
  now?: () => number;
  /** Optional initial account; a later retry may replace it. */
  accountId?: string | null;
  /** Dispatch a terminal write without making the response wait for storage. */
  waitUntil?: (promise: Promise<void>) => void;
  /** Constant callback only. It deliberately receives no exception details. */
  onRecordError?: () => void;
}

export interface RequestMetricTerminal {
  semanticStatus: RequestSemanticStatus;
  /** HTTP status exposed to the client; SSE failures commonly remain HTTP 200. */
  httpStatus: number;
}

function boundedInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(maximum, Math.trunc(value)));
}

function normalizedAccountId(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_ACCOUNT_ID_LENGTH);
}

function isHighSurrogate(value: string): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Incremental form of the gateway's conservative prompt estimator. It stores
 * only category counters and at most one UTF-16 high surrogate, so prompt,
 * response, credential, email and tool-result text cannot enter metrics.
 */
export class IncrementalTokenEstimate {
  private asciiWordCharacters = 0;
  private asciiSyntaxCharacters = 0;
  private nonAsciiCharacters = 0;
  private emojiCharacters = 0;
  private pendingHighSurrogate = "";

  add(value: string): void {
    if (!value) return;
    let input = this.pendingHighSurrogate + value;
    this.pendingHighSurrogate = "";
    const last = input.at(-1) ?? "";
    if (isHighSurrogate(last)) {
      this.pendingHighSurrogate = last;
      input = input.slice(0, -1);
    }
    const counts = countPromptTokenClasses(input);
    this.asciiWordCharacters += counts.asciiWordCharacters;
    this.asciiSyntaxCharacters += counts.asciiSyntaxCharacters;
    this.nonAsciiCharacters += counts.nonAsciiCharacters;
    this.emojiCharacters += counts.emojiCharacters;
  }

  value(): number {
    // An unmatched high surrogate is charged conservatively but never retained
    // in the persisted metric record.
    const trailing = this.pendingHighSurrogate ? 1 : 0;
    return Math.min(
      MAX_METRIC_TOKENS,
      Math.ceil(this.asciiWordCharacters / 4)
        + Math.ceil(this.asciiSyntaxCharacters / 2)
        + this.nonAsciiCharacters
        + this.emojiCharacters * 2
        + trailing,
    );
  }
}

/**
 * One lifecycle per logical API request. A retry may call `setAccountId`
 * multiple times; only the final selection is snapshotted at the first
 * terminal transition. Every later complete/error/cancel is a no-op and
 * returns the same persistence promise.
 */
export class RequestMetricTracker {
  private readonly inputEstimate = new IncrementalTokenEstimate();
  private readonly outputEstimate = new IncrementalTokenEstimate();
  private readonly requestId: string;
  private readonly sink: RequestMetricSink;
  private readonly waitUntil: ((promise: Promise<void>) => void) | undefined;
  private readonly onRecordError: (() => void) | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;
  private accountId: string;
  private terminalPromise: Promise<void> | undefined;
  private terminalValue: RequestSemanticStatus | undefined;
  private failureCode = "";

  constructor(options: RequestMetricTrackerOptions) {
    this.requestId = options.requestId;
    this.sink = options.sink;
    this.waitUntil = options.waitUntil;
    this.onRecordError = options.onRecordError;
    this.now = options.now ?? Date.now;
    const now = boundedInteger(this.now(), Number.MAX_SAFE_INTEGER);
    this.startedAt = options.startedAt == null
      ? now
      : boundedInteger(options.startedAt, Number.MAX_SAFE_INTEGER);
    this.accountId = normalizedAccountId(options.accountId);
  }

  /** Latest successful routing selection wins until the request terminates. */
  setAccountId(accountId: string | null | undefined): void {
    if (this.terminalPromise) return;
    this.accountId = normalizedAccountId(accountId);
  }

  observeInputText(value: string): void {
    if (!this.terminalPromise) this.inputEstimate.add(value);
  }

  observeOutputText(value: string): void {
    if (!this.terminalPromise) this.outputEstimate.add(value);
  }

  setFailureCode(value: string | null | undefined): void {
    if (this.terminalPromise || typeof value !== "string") return;
    const normalized = value.trim().toLowerCase();
    this.failureCode = /^[a-z][a-z0-9_]{0,63}$/u.test(normalized) ? normalized : "upstream_error";
  }

  usage(): { input_tokens: number; output_tokens: number; total_tokens: number } {
    const input = this.inputEstimate.value();
    const output = this.outputEstimate.value();
    return { input_tokens: input, output_tokens: output, total_tokens: input + output };
  }

  get semanticStatus(): RequestSemanticStatus | undefined {
    return this.terminalValue;
  }

  get settled(): Promise<void> | undefined {
    return this.terminalPromise;
  }

  complete(httpStatus = 200): Promise<void> {
    return this.finish({ semanticStatus: "complete", httpStatus });
  }

  error(httpStatus = 500): Promise<void> {
    return this.finish({ semanticStatus: "error", httpStatus });
  }

  cancel(httpStatus = 499): Promise<void> {
    return this.finish({ semanticStatus: "cancel", httpStatus });
  }

  finish(terminal: RequestMetricTerminal): Promise<void> {
    if (this.terminalPromise) return this.terminalPromise;

    // Set the terminal marker before creating/dispatching the promise. This is
    // what makes concurrent completion, error and cancellation exactly-once.
    this.terminalValue = terminal.semanticStatus;
    const endedAt = boundedInteger(this.now(), Number.MAX_SAFE_INTEGER);
    const metric: RequestMetricInput = {
      requestId: this.requestId,
      accountId: this.accountId || null,
      status: boundedInteger(terminal.httpStatus, 999),
      semanticStatus: terminal.semanticStatus,
      ...(this.failureCode ? { code: this.failureCode } : {}),
      durationMs: Math.max(0, endedAt - this.startedAt),
      tokenIn: this.inputEstimate.value(),
      tokenOut: this.outputEstimate.value(),
    };
    const persisted = Promise.resolve()
      .then(() => this.sink.recordRequest(metric))
      .then(() => undefined)
      .catch(() => {
        // Metrics must never break or disclose details from a user request.
        // The callback is intentionally detail-free for the same reason.
        try { this.onRecordError?.(); } catch { /* diagnostic only */ }
      });
    this.terminalPromise = persisted;
    try { this.waitUntil?.(persisted); } catch {
      try { this.onRecordError?.(); } catch { /* diagnostic only */ }
    }
    return persisted;
  }
}

/**
 * Wrap a streaming response without marking it complete at construction.
 * Natural EOF, source failure and downstream cancellation are distinct. If a
 * protocol emits an in-band SSE error and then closes cleanly, its pump must
 * call `tracker.error(response.status)` before closing; the EOF fallback is
 * safely ignored by the tracker's exactly-once terminal gate.
 */
export function trackStreamingResponse(response: Response, tracker: RequestMetricTracker): Response {
  if (!response.body) {
    void (response.ok ? tracker.complete(response.status) : tracker.error(response.status));
    return response;
  }

  const reader = response.body.getReader();
  const monitored = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          void tracker.complete(response.status);
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (cause) {
        void tracker.error(response.status);
        controller.error(cause);
      }
    },
    async cancel(reason) {
      void tracker.cancel(response.status);
      try { await reader.cancel(reason); } catch { /* source is already gone */ }
    },
  });
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Complete a response whose full body has already been produced in memory. */
export function trackBufferedResponse(response: Response, tracker: RequestMetricTracker): Response {
  void (response.ok ? tracker.complete(response.status) : tracker.error(response.status));
  return response;
}
