import { ChatSession } from "./chat-session";
import { anthropicErrorResponse, anthropicRequest } from "./anthropic";
import { authorizationURL, exchangeCode } from "./oauth";
import { openAIRequest } from "./openai";
import { codexModelCatalog, modelCatalog } from "./models";
import {
  ACCOUNT_MIGRATION_PATH,
  MigrationRequestError,
  verifyAccountMigration,
} from "./migration";
import { readJSONLimited } from "./request-body";
import { RequestMetricTracker, trackBufferedResponse, trackStreamingResponse } from "./request-metrics";
import { MAX_API_KEY_NAME_CHARACTERS, MAX_API_KEY_VALIDITY_DAYS, TenantState } from "./tenant-state";
import type { Env, RequestMetricInput } from "./types";

export { ChatSession, TenantState };

const SESSION_COOKIE = "m365_admin_session";
const MAX_JSON_BYTES = 1024 * 1024;
const CREDENTIAL_STORAGE_DESCRIPTION = "AES-256-GCM ciphertext in Durable Object SQLite (authoritative) with an encrypted Cloudflare KV mirror";
const CAPABILITY_MATRIX = Object.freeze({
  oauthPkce: true,
  multipleAccounts: true,
  orderedAccountRotation: true,
  accountIsolation: true,
  apiKeyManagement: true,
  persistentUsageStats: true,
  boundedDiagnostics: true,
  strongAccountSessionCleanup: false,
  runtimeSettingsWrite: false,
  perAccountProxy: false,
  filesystemPaths: false,
  localProcessLaunch: false,
});

function tenant(env: Env): DurableObjectStub<TenantState> {
  return env.TENANTS.getByName(env.TENANT_NAME || "default");
}

function cookie(request: Request, name: string): string {
  const raw = request.headers.get("Cookie") ?? "";
  for (const item of raw.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { type: "cloudflare_native_error", code, message } }, status, { "X-M365-Error-Code": code });
}

function isJSONObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiKeyInputError(cause: unknown): Response | null {
  const code = cause instanceof Error ? cause.message : "";
  if (code === "INVALID_API_KEY_NAME") {
    return error(400, "invalid_api_key_name", `API Key name must contain 1 to ${MAX_API_KEY_NAME_CHARACTERS} characters`);
  }
  if (code === "INVALID_API_KEY_DAYS") {
    return error(400, "invalid_api_key_days", `API Key validity must be a whole number from 0 to ${MAX_API_KEY_VALIDITY_DAYS} days`);
  }
  return null;
}

function redirect(requestURL: URL, pathname: string): Response {
  const target = new URL(pathname, requestURL);
  return new Response(null, { status: 307, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
}

async function managementPage(request: Request, env: Env, url: URL): Promise<Response> {
  const current = await tenant(env).session(cookie(request, SESSION_COOKIE));
  if (url.pathname === "/login.html") return redirect(url, "/login");
  if (url.pathname === "/login") {
    if (current.authenticated && !current.mustChangePassword) return redirect(url, "/");
    const assetURL = new URL("/login.html", url);
    const response = await env.ASSETS.fetch(new Request(assetURL, request));
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  if (!current.authenticated || current.mustChangePassword) return redirect(url, "/login");
  const assetURL = new URL(url.pathname === "/" ? "/index.html" : url.pathname, url);
  const response = await env.ASSETS.fetch(new Request(assetURL, request));
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function jsonBody<T>(request: Request): Promise<T> {
  return readJSONLimited<T>(request, MAX_JSON_BYTES);
}

async function admin(request: Request, env: Env, allowMustChange = false): Promise<{ ok: true } | { ok: false; response: Response }> {
  const current = await tenant(env).session(cookie(request, SESSION_COOKIE));
  if (!current.authenticated) return { ok: false, response: error(401, "auth_error", "administrator login required") };
  if (current.mustChangePassword && !allowMustChange) {
    return { ok: false, response: error(403, "password_change_required", "administrator password must be changed first") };
  }
  return { ok: true };
}

async function adminRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const state = tenant(env);
  if (url.pathname === "/api/admin/login" && request.method === "POST") {
    const body = await jsonBody<{ password?: string }>(request);
    const result = await state.login(body.password ?? "", request.headers.get("CF-Connecting-IP") ?? "unknown");
    if (!result.ok) {
      if (result.error === "LOGIN_RATE_LIMITED") return error(429, "rate_limit_error", "too many failed login attempts");
      return error(401, "auth_error", "invalid administrator password");
    }
    return json(
      { status: "authenticated", must_change_password: result.mustChangePassword },
      200,
      { "Set-Cookie": sessionCookie(result.token, 86_400) },
    );
  }
  if (url.pathname === "/api/admin/session" && request.method === "GET") {
    const result = await state.session(cookie(request, SESSION_COOKIE));
    return json({ authenticated: result.authenticated, must_change_password: result.mustChangePassword });
  }
  if (url.pathname === "/api/admin/logout" && request.method === "POST") {
    await state.logout(cookie(request, SESSION_COOKIE));
    return json({ status: "logged_out" }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (url.pathname === "/api/admin/change-password" && request.method === "POST") {
    // The one-time bootstrap password is only a login credential. Even during
    // first-run replacement, a caller must first prove it completed login and
    // received the HttpOnly administrator session cookie.
    const passwordAccess = await admin(request, env, true);
    if (!passwordAccess.ok) return passwordAccess.response;
    try {
      const body = await jsonBody<{ current_password?: string; new_password?: string }>(request);
      await state.changePassword(cookie(request, SESSION_COOKIE), body.current_password ?? "", body.new_password ?? "");
      return json({ status: "password_changed" }, 200, { "Set-Cookie": sessionCookie("", 0) });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "PASSWORD_CHANGE_FAILED";
      if (code === "PASSWORD_TOO_SHORT") return error(400, "password_too_short", "新密码至少需要 12 个字符");
      if (code === "INVALID_ADMIN_PASSWORD") return error(401, "invalid_admin_password", "当前密码错误");
      if (code === "ADMIN_SESSION_REQUIRED") return error(401, "admin_session_required", "请先登录管理员账号");
      throw cause;
    }
  }

  const access = await admin(request, env);
  if (!access.ok) return access.response;
  if (url.pathname === "/api/admin/keys") {
    if (request.method === "GET") {
      const keys = await state.listAPIKeys();
      return json({ keys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        createdAt: new Date(key.created_at).toISOString(),
        lastUsedAt: key.last_used_at ? new Date(key.last_used_at).toISOString() : null,
        expiresAt: key.expires_at ? new Date(key.expires_at).toISOString() : null,
        revoked: Boolean(key.revoked),
      })) });
    }
    if (request.method === "POST") {
      const body = await jsonBody<unknown>(request);
      if (!isJSONObject(body)) return error(400, "invalid_api_key_request", "API Key request body must be a JSON object");
      if (body.name !== undefined && typeof body.name !== "string") {
        return error(400, "invalid_api_key_name", `API Key name must contain 1 to ${MAX_API_KEY_NAME_CHARACTERS} characters`);
      }
      if (body.days !== undefined && typeof body.days !== "number") {
        return error(400, "invalid_api_key_days", `API Key validity must be a whole number from 0 to ${MAX_API_KEY_VALIDITY_DAYS} days`);
      }
      const name = body.name ?? "default";
      const days = body.days ?? 0;
      if (!name.trim() || name.trim().length > MAX_API_KEY_NAME_CHARACTERS) {
        return error(400, "invalid_api_key_name", `API Key name must contain 1 to ${MAX_API_KEY_NAME_CHARACTERS} characters`);
      }
      if (!Number.isInteger(days) || days < 0 || days > MAX_API_KEY_VALIDITY_DAYS) {
        return error(400, "invalid_api_key_days", `API Key validity must be a whole number from 0 to ${MAX_API_KEY_VALIDITY_DAYS} days`);
      }
      try {
        const created = await state.createAPIKey(name, days);
        return json({ key: created.key, record: created.record }, 201);
      } catch (cause) {
        const validation = apiKeyInputError(cause);
        if (validation) return validation;
        throw cause;
      }
    }
    if (request.method === "DELETE") return json({ status: await state.revokeAPIKey(url.searchParams.get("id") ?? "") ? "revoked" : "not_found" });
    if (request.method === "PATCH") {
      const body = await jsonBody<unknown>(request);
      if (!isJSONObject(body)) return error(400, "invalid_api_key_request", "API Key request body must be a JSON object");
      if (body.id !== undefined && typeof body.id !== "string") {
        return error(400, "invalid_api_key_id", "API Key id must be a string");
      }
      if (body.days !== undefined && typeof body.days !== "number") {
        return error(400, "invalid_api_key_days", `API Key validity must be a whole number from 0 to ${MAX_API_KEY_VALIDITY_DAYS} days`);
      }
      const days = body.days ?? 0;
      if (!Number.isInteger(days) || days < 0 || days > MAX_API_KEY_VALIDITY_DAYS) {
        return error(400, "invalid_api_key_days", `API Key validity must be a whole number from 0 to ${MAX_API_KEY_VALIDITY_DAYS} days`);
      }
      try {
        return json({ status: await state.updateAPIKeyExpiry(body.id ?? "", days) ? "updated" : "not_found" });
      } catch (cause) {
        const validation = apiKeyInputError(cause);
        if (validation) return validation;
        throw cause;
      }
    }
  }
  if (url.pathname === "/api/admin/settings") {
    if (request.method === "GET") return json({ settings: {
      platform: "cloudflare-native",
      maxAccounts: Number(env.MAX_ACCOUNTS),
      environment: env.ENVIRONMENT,
      credentialStorage: CREDENTIAL_STORAGE_DESCRIPTION,
      sessionTTL: "24 hours",
      adminSessionTTL: "24 hours",
      chatSessionTTL: "30 days",
      capabilities: CAPABILITY_MATRIX,
    } });
    return error(501, "not_implemented", "runtime settings editing is not available in the preview build");
  }
  if (url.pathname === "/api/admin/debug/logs" && request.method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    return json({ records: await state.listDiagnostics(limit), maxRecords: 200 });
  }
  if (url.pathname === "/api/admin/reset-stats" && request.method === "POST") {
    return json({ status: "reset", ...(await state.resetRequestStats()) });
  }
  if (url.pathname.includes("proxy")) return error(400, "proxy_unsupported", "Cloudflare-native accounts do not use server-side proxies");
  return error(404, "not_found", "management endpoint not found");
}

async function accountRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const access = await admin(request, env);
  if (!access.ok) return access.response;
  const state = tenant(env);
  if (url.pathname === "/api/accounts" && request.method === "GET") {
    const [accounts, totals] = await Promise.all([state.listAccounts(), state.statsSnapshot()]);
    return json({ accounts, ...totals, accountLimit: Number(env.MAX_ACCOUNTS) });
  }
  if (url.pathname === "/api/accounts/delete" && request.method === "POST") {
    const body = await jsonBody<{ id?: string }>(request);
    const deleted = await state.deleteAccount(body.id ?? "");
    return json({
      status: deleted ? "deleted" : "not_found",
      // Chat sessions live in separately named Durable Objects. Stable Chat
      // objects are not currently registered by account and Cloudflare does
      // not expose namespace enumeration, so claiming a numeric deletion count
      // would be false. Deleted credentials cannot be selected for new work;
      // session objects continue to expire under their bounded TTLs.
      sessionsRemoved: null,
      sessionCleanup: {
        status: "not_performed",
        reason: "authoritative_account_session_registry_unavailable",
      },
    });
  }
  if (url.pathname === "/api/accounts/refresh" && request.method === "POST") {
    try {
      const body = await jsonBody<{ id?: string }>(request);
      const account = await state.refreshActiveAccount(body.id ?? "");
      if (!account) return error(404, "account_not_found", "account not found");
      return json({ status: "refreshed", account });
    } catch (cause) {
      if (cause instanceof Error && cause.message === "ACCOUNT_NOT_ACTIVE") {
        return error(409, "account_not_active", "only the active account can be refreshed");
      }
      const code = cause instanceof Error ? cause.message : "TOKEN_REFRESH_FAILED";
      if (["MICROSOFT_REFRESH_TOKEN_MISSING", "MICROSOFT_REFRESH_TOKEN_REJECTED", "MICROSOFT_TOKEN_EXCHANGE_FAILED"].includes(code)) {
        return error(409, "token_refresh_authorization_failed", "Microsoft authorization must be renewed for this account");
      }
      if (code === "MICROSOFT_TOKEN_RATE_LIMITED") return error(429, "token_refresh_rate_limited", "Microsoft temporarily rate-limited token refresh");
      if (code === "MICROSOFT_TOKEN_SERVICE_UNAVAILABLE") return error(503, "token_refresh_unavailable", "Microsoft token service is temporarily unavailable");
      if (["ACCOUNT_CREDENTIAL_MISSING", "ACCOUNT_CREDENTIAL_CORRUPT", "ACCOUNT_CREDENTIAL_MIRROR_UNAVAILABLE"].includes(code)) {
        return error(500, "account_credential_error", "the encrypted account credential is unavailable");
      }
      return error(502, "token_refresh_failed", "Microsoft token refresh failed");
    }
  }
  return error(404, "not_found", "account endpoint not found");
}

async function oauthRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const access = await admin(request, env);
  if (!access.ok) return access.response;
  const state = tenant(env);
  if (url.pathname === "/api/auth/start" && request.method === "GET") {
    const pending = await state.createOAuthState();
    return json({ state: pending.state, url: authorizationURL(env, pending.state, pending.challenge), mode: "paste_callback" });
  }
  if (url.pathname === "/api/auth/callback" && request.method === "GET") {
    let code = url.searchParams.get("code") ?? "";
    let oauthState = url.searchParams.get("state") ?? "";
    const pasted = url.searchParams.get("url");
    if (pasted) {
      try {
        const callback = new URL(pasted);
        code ||= callback.searchParams.get("code") ?? "";
        oauthState ||= callback.searchParams.get("state") ?? "";
      } catch {
        return error(400, "invalid_callback_url", "invalid callback URL");
      }
    }
    if (!code || !oauthState) return error(400, "missing_oauth_fields", "OAuth code and state are required");
    try {
      const verifier = await state.consumeOAuthState(oauthState);
      const account = await state.upsertAccount(await exchangeCode(env, code, verifier));
      return json({ status: "authenticated", account });
    } catch (cause) {
      const codeValue = cause instanceof Error ? cause.message : "OAUTH_FAILED";
      if (codeValue === "ACCOUNT_LIMIT_REACHED") return error(409, "account_limit_reached", `this Cloudflare deployment allows up to ${Number(env.MAX_ACCOUNTS) || 1} accounts`);
      return error(400, "oauth_failed", "Microsoft authorization could not be completed");
    }
  }
  return error(404, "not_found", "OAuth endpoint not found");
}

async function migrationRoute(request: Request, env: Env): Promise<Response> {
  try {
    const verified = await verifyAccountMigration(request, env);
    const result = await tenant(env).importAccountMigration(
      verified.input.migrationId,
      verified.bodyHash,
      verified.nonceHash,
      verified.input.activeSequence,
      verified.input.accounts,
    );
    return json({
      status: result.replayed ? "already_imported" : "imported",
      migrationId: result.migrationId,
      importedCount: result.importedCount,
      activeSequence: result.activeSequence,
      replayed: result.replayed,
    }, result.replayed ? 200 : 201);
  } catch (cause) {
    if (cause instanceof MigrationRequestError) return error(cause.status, cause.code, cause.message);
    const code = cause instanceof Error ? cause.message : "";
    if (code === "MIGRATION_REPLAY") return error(409, "migration_replay", "migration nonce has already been consumed");
    if (code === "MIGRATION_ID_CONFLICT") return error(409, "migration_id_conflict", "migration id was already used for different content");
    if (code === "DUPLICATE_MIGRATION_ACCOUNT") return error(409, "duplicate_migration_account", "migration contains conflicting account identities");
    if (code === "ACCOUNT_LIMIT_REACHED") return error(409, "account_limit_reached", "migration exceeds this candidate's account limit");
    // Keep candidate diagnostics actionable without ever echoing token/body data.
    // The stable prefix makes the failure visible to the migration client while
    // avoiding a generic upstream 500 that cannot be investigated remotely.
    if (code) return error(500, "migration_internal_error", code.slice(0, 120));
    throw cause;
  }
}

async function openAI(
  request: Request,
  env: Env,
  url: URL,
  metrics: RequestMetricTracker,
): Promise<Response> {
  const raw = request.headers.get("X-API-Key")?.trim()
    || request.headers.get("Authorization")?.replace(/^Bearer\s+/iu, "").trim()
    || "";
  if (!(await tenant(env).validAPIKey(raw))) {
    if (url.pathname === "/v1/messages") return anthropicErrorResponse(401, "authentication_error", "valid API key required");
    return error(401, "auth_error", "valid API key required");
  }
  if (url.pathname === "/v1/models" && request.method === "GET") {
    if (url.searchParams.has("client_version")) return json(codexModelCatalog());
    return json({ object: "list", data: modelCatalog() });
  }
  if (url.pathname === "/v1/models") return error(405, "method_not_allowed", "GET is required for /v1/models");
  if (url.pathname === "/v1/messages") return anthropicRequest(request, env, openAIRequest, metrics);
  return openAIRequest(request, env, url, metrics);
}

function secure(response: Response, api: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (api) headers.set("Cache-Control", "no-store");
  else headers.set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const metrics = url.pathname.startsWith("/v1/") ? new RequestMetricTracker({
      requestId,
      startedAt,
      sink: {
        recordRequest: async (input: RequestMetricInput): Promise<void> => {
          const state = tenant(env);
          console.log(JSON.stringify({
            event: "request_terminal",
            request_id: requestId,
            method: request.method,
            path: url.pathname,
            status: input.status,
            semantic_status: input.semanticStatus,
            error_code: input.code ?? "",
            duration_ms: input.durationMs ?? 0,
          }));
          await Promise.all([
            state.recordRequest(input),
            state.recordDiagnostic({
              requestId,
              method: request.method,
              // Only pathname is retained. URL query and fragments never enter
              // terminal metrics or diagnostics.
              path: url.pathname,
              status: input.status,
              durationMs: input.durationMs ?? 0,
              code: `terminal_${input.semanticStatus ?? (input.status >= 400 ? "error" : "complete")}${input.code ? `_${input.code}` : ""}`,
            }),
          ]);
        },
      },
      waitUntil: (promise) => ctx.waitUntil(promise),
      onRecordError: () => console.error(JSON.stringify({ event: "terminal_metric_write_failed" })),
    }) : undefined;
    const finish = (response: Response, api: boolean): Response => {
      const headers = new Headers(response.headers);
      headers.set("X-Request-Id", requestId);
      let identified = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      if (!metrics) console.log(JSON.stringify({ event: "request", request_id: requestId, method: request.method, path: url.pathname, status: response.status }));
      if (metrics) {
        metrics.setFailureCode(identified.headers.get("X-M365-Error-Code"));
        identified = identified.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream")
          ? trackStreamingResponse(identified, metrics)
          : trackBufferedResponse(identified, metrics);
      } else if (api) {
        // Control-plane routes are fully buffered at this point. Long-running
        // /v1 streams use RequestMetricTracker above and are recorded only at
        // their real complete/error/cancel terminal event.
        ctx.waitUntil(tenant(env).recordDiagnostic({
          requestId,
          method: request.method,
          path: url.pathname,
          status: response.status,
          durationMs: Date.now() - startedAt,
          code: response.headers.get("X-M365-Error-Code") ?? "",
        }).catch(() => {
          // A diagnostic write must never fail the user request. Keep this
          // fallback constant so storage exceptions cannot disclose secrets.
          console.error(JSON.stringify({ event: "diagnostic_write_failed" }));
        }));
      }
      return secure(identified, api);
    };
    try {
      let response: Response;
      if (url.pathname === "/api/health") response = request.method === "GET"
        ? json({
            status: "ok",
            platform: "cloudflare-native",
            metadataStorage: "durable-object-sqlite",
            credentialStorage: CREDENTIAL_STORAGE_DESCRIPTION,
          })
        : error(405, "method_not_allowed", "GET is required for /api/health");
      else if (url.pathname === ACCOUNT_MIGRATION_PATH) response = await migrationRoute(request, env);
      else if (url.pathname.startsWith("/api/admin/")) response = await adminRoute(request, env, url);
      else if (url.pathname.startsWith("/api/accounts")) response = await accountRoute(request, env, url);
      else if (url.pathname.startsWith("/api/auth/")) response = await oauthRoute(request, env, url);
      else if (url.pathname.startsWith("/api/")) response = error(404, "not_found", "API endpoint not found");
      else if (url.pathname.startsWith("/v1/")) response = await openAI(request, env, url, metrics!);
      else if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/login" || url.pathname === "/login.html")) response = await managementPage(request, env, url);
      else response = await env.ASSETS.fetch(request);
      return finish(response, url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"));
    } catch (cause) {
      if (cause instanceof Error && cause.message === "REQUEST_TOO_LARGE") {
        return finish(error(413, "request_too_large", "request body exceeds the 1 MiB management API limit"), true);
      }
      if (cause instanceof SyntaxError || (cause instanceof Error && cause.message === "INVALID_JSON")) {
        return finish(error(400, "invalid_json", "request body is not valid JSON"), true);
      }
      // Never log arbitrary exception messages here. Fetch, crypto and OAuth
      // errors may embed URLs, authorization codes or credential material.
      console.error(JSON.stringify({
        event: "request_failed",
        request_id: requestId,
        path: url.pathname,
        error_class: cause instanceof Error ? cause.name : "UnknownError",
      }));
      return finish(error(500, "internal_error", "Cloudflare-native gateway request failed"), true);
    }
  },
} satisfies ExportedHandler<Env>;
