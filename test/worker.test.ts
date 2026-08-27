import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DurableChatHubRequest } from "../src/chat-session";
import type { OAuthTokenSet } from "../src/types";

function cookie(response: Response): string {
  return response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
}

describe("Worker HTTP contract", () => {
  it("restricts health to GET and attaches a stable error code", async () => {
    expect((await SELF.fetch("https://example.com/api/health")).status).toBe(200);
    const invalid = await SELF.fetch("https://example.com/api/health", { method: "POST" });
    expect(invalid.status).toBe(405);
    expect(invalid.headers.get("X-M365-Error-Code")).toBe("method_not_allowed");
  });

  it("requires a one-time password change and enforces method contracts", async () => {
    const first = await SELF.fetch("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-bootstrap-password-2026" }),
    });
    expect(first.status).toBe(200);
    expect((await first.clone().json<{ must_change_password: boolean }>()).must_change_password).toBe(true);
    const firstCookie = cookie(first);

    const changed = await SELF.fetch("https://example.com/api/admin/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: firstCookie },
      body: JSON.stringify({ current_password: "test-bootstrap-password-2026", new_password: "changed-password-2026" }),
    });
    expect(changed.status).toBe(200);

    const login = await SELF.fetch("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "changed-password-2026" }),
    });
    const sessionCookie = cookie(login);
    const created = await SELF.fetch("https://example.com/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ name: "test", days: 1 }),
    });
    expect(created.status).toBe(201);
    const apiKey = (await created.json<{ key: string }>()).key;

    const wrongMethod = await SELF.fetch("https://example.com/v1/models", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("X-M365-Error-Code")).toBe("method_not_allowed");

    const anthropicWrongMethod = await SELF.fetch("https://example.com/v1/messages", {
      method: "GET",
      headers: { "x-api-key": apiKey },
    });
    expect(anthropicWrongMethod.status).toBe(405);
    expect(anthropicWrongMethod.headers.get("X-M365-Error-Code")).toBe("method_not_allowed");

    const settings = await SELF.fetch("https://example.com/api/admin/settings", {
      headers: { Cookie: sessionCookie },
    });
    await expect(settings.json()).resolves.toMatchObject({
      settings: { adminSessionTTL: "24 hours", chatSessionTTL: "30 days" },
    });
  });
});

describe("Durable ChatHub cancellation fence", () => {
  it("cancels a run before any outbound Microsoft request starts", async () => {
    const runner = env.CHATS.getByName("cancel-test");
    const runId = crypto.randomUUID();
    expect(await runner.cancelChatHub(runId)).toBe("queued");
    const account: OAuthTokenSet = {
      accessToken: "unused",
      refreshToken: "unused",
      expiresAt: Date.now() + 60_000,
      email: "",
      displayName: "",
      oid: "oid",
      tid: "tid",
    };
    const request: DurableChatHubRequest = {
      runId,
      text: "must not reach upstream",
      conversationId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      started: true,
      tone: "Gpt_5_6_Chat",
      deadlineAt: Date.now() + 5_000,
    };
    const result = await runner.runChatHub(account, request);
    expect(result).toMatchObject({ ok: false, failure: { message: "REQUEST_ABORTED", invocationSubmitted: false } });
  });

  it("releases a conversation lease so the next turn continues in place", async () => {
    const session = env.CHATS.getByName("lease-release-test");
    const first = await session.acquire();
    await session.release(first.leaseId);
    const continued = await session.acquire();
    expect(continued.leaseId).not.toBe(first.leaseId);
    await session.release(continued.leaseId);
  });
});
