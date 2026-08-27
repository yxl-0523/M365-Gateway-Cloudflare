import { describe, expect, it } from "vitest";
import { chatHubUpdateHasSemanticProgress } from "../src/chathub";
import { publicFailure, responsesContinuationOutputIssue } from "../src/openai";
import { RequestMetricTracker } from "../src/request-metrics";
import { guardProposedToolCalls, parseChatToolLedger } from "../src/tool-ledger";

describe("ChatHub progress deadline", () => {
  it("does not treat empty update frames as semantic progress", () => {
    expect(chatHubUpdateHasSemanticProgress({})).toBe(false);
    expect(chatHubUpdateHasSemanticProgress({ writeAtCursor: "", messages: [] })).toBe(false);
  });

  it("accepts only meaningful text, tool, bot, or throttling progress", () => {
    expect(chatHubUpdateHasSemanticProgress({ writeAtCursor: "a" })).toBe(true);
    expect(chatHubUpdateHasSemanticProgress({ throttling: {} })).toBe(true);
    expect(chatHubUpdateHasSemanticProgress({ messages: [{ messageType: "Progress" }] })).toBe(true);
    expect(chatHubUpdateHasSemanticProgress({ messages: [{ author: "bot", text: "done" }] })).toBe(true);
  });
});

describe("terminal metrics", () => {
  it("records usage and a privacy-safe failure code exactly once", async () => {
    const records: unknown[] = [];
    const tracker = new RequestMetricTracker({
      requestId: "request-1",
      sink: { recordRequest: async (input) => { records.push(input); } },
      startedAt: 100,
      now: () => 150,
    });
    tracker.observeInputText("hello world");
    tracker.observeOutputText("answer");
    tracker.setFailureCode("upstream_timeout");
    expect(tracker.usage().total_tokens).toBeGreaterThan(0);
    await Promise.all([tracker.error(200), tracker.complete(200)]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ semanticStatus: "error", code: "upstream_timeout", status: 200 });
  });
});

describe("stable protocol errors", () => {
  it("maps known timeouts without leaking upstream text", () => {
    expect(publicFailure(new Error("CHAT_PROGRESS_TIMEOUT"))).toEqual({
      code: "upstream_timeout",
      message: "Microsoft ChatHub timed out before completion",
    });
  });

  it("rejects mismatched Responses tool outputs", () => {
    expect(responsesContinuationOutputIssue([
      { type: "function_call_output", call_id: "wrong", output: "ok" },
    ], "expected")).toBe("tool_output_mismatch");
  });
});

describe("tool-loop continuation", () => {
  it("blocks an unchanged completed action but permits a materially changed next step", async () => {
    const ledger = await parseChatToolLedger([
      { role: "user", content: "inspect" },
      { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"Get-Item a"}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "error: not found" },
      { role: "assistant", tool_calls: [{ id: "call-2", type: "function", function: { name: "exec_command", arguments: '{"cmd":"Get-Item a"}' } }] },
      { role: "tool", tool_call_id: "call-2", content: "error: not found" },
    ], { activeChatTurnOnly: false });
    await expect(guardProposedToolCalls([
      { name: "exec_command", arguments: '{"cmd":"Get-Item a"}' },
    ], ledger)).resolves.toMatchObject({ allowed: false, code: "repeated_failure" });
    await expect(guardProposedToolCalls([
      { name: "exec_command", arguments: '{"cmd":"Get-Item b"}' },
    ], ledger)).resolves.toMatchObject({ allowed: true });
  });
});
