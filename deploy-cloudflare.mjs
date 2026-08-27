#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const wranglerEntry = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const args = parseArgs(process.argv.slice(2));
let rl;
let temporaryDirectory = "";

function parseArgs(values) {
  const result = { yes: false, update: false, dryRun: false, help: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--yes" || value === "-y") result.yes = true;
    else if (value === "--update") result.update = true;
    else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (["--name", "--client-id", "--domain", "--kv-id"].includes(value)) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} 缺少参数值`);
      result[value.slice(2).replaceAll("-", "_")] = next.trim();
      index += 1;
    } else throw new Error(`未知参数：${value}`);
  }
  return result;
}

function showHelp() {
  console.log(`
M365 Gateway Cloudflare 一键部署器

新建部署：
  node deploy-cloudflare.mjs

无人值守新建（仍会打开 Cloudflare 登录）：
  node deploy-cloudflare.mjs --yes --name my-m365-gateway --client-id <Entra应用ID>

更新已有 Worker（必须复用原 KV）：
  node deploy-cloudflare.mjs --update --name my-m365-gateway --client-id <Entra应用ID> --kv-id <原KV_ID>

可选参数：
  --domain <api.example.com>  同时绑定 Cloudflare 自定义域名
  --dry-run                   只验证构建，不登录、不创建资源、不部署
  -h, --help                  显示本说明
`);
}

function run(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    // A stuck Wrangler child must fail the deployment task instead of leaving
    // Codex waiting forever with no evidence. Real deployments are bounded by
    // the same limit; rerun after inspecting the emitted command/error.
    timeout: timeoutMs,
    stdio: options.capture ? [options.input ? "pipe" : "ignore", "pipe", "pipe"] : [options.input ? "pipe" : "inherit", "inherit", "inherit"],
    input: options.input,
    env: process.env,
  });
  if (options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") throw new Error(`${command} ${commandArgs.join(" ")} 超过 ${Math.ceil(timeoutMs / 1_000)} 秒仍未退出，已终止`);
    throw result.error;
  }
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} 执行失败（退出码 ${result.status ?? "unknown"}）`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runNpm(commandArgs) {
  if (process.platform !== "win32") return run(npm, commandArgs);
  const commandLine = [npm, ...commandArgs].map((value) => /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value).join(" ");
  return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine]);
}

function runWrangler(commandArgs, options = {}) {
  if (!existsSync(wranglerEntry)) throw new Error("Wrangler 未安装，请先运行 npm ci");
  return run(process.execPath, [wranglerEntry, ...commandArgs], options);
}

function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function parseWranglerJSON(output) {
  const firstArray = output.indexOf("[");
  const lastArray = output.lastIndexOf("]");
  const firstObject = output.indexOf("{");
  const lastObject = output.lastIndexOf("}");
  const candidates = [];
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(output.slice(firstArray, lastArray + 1));
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(output.slice(firstObject, lastObject + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try next bounded JSON value */ }
  }
  throw new Error("Wrangler 返回了无法解析的 JSON");
}

export function deployedVersionId(output) {
  const parsed = parseWranglerJSON(output);
  const deployments = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.deployments) ? parsed.deployments : [];
  const latest = deployments.reduce((selected, candidate) => {
    if (!selected) return candidate;
    const selectedAt = Date.parse(String(selected?.created_on ?? ""));
    const candidateAt = Date.parse(String(candidate?.created_on ?? ""));
    if (Number.isFinite(candidateAt) && (!Number.isFinite(selectedAt) || candidateAt > selectedAt)) return candidate;
    // Wrangler currently emits oldest-to-newest. If timestamps are absent or
    // invalid, prefer the later array entry rather than the oldest deployment.
    if (!Number.isFinite(candidateAt) && !Number.isFinite(selectedAt)) return candidate;
    return selected;
  }, null);
  const versions = Array.isArray(latest?.versions) ? latest.versions : [];
  const activeVersion = versions.reduce((selected, candidate) => {
    if (typeof candidate?.version_id !== "string") return selected;
    return !selected || Number(candidate.percentage ?? 0) > Number(selected.percentage ?? 0) ? candidate : selected;
  }, null);
  const versionId = activeVersion?.version_id
    ?? (typeof latest?.version_id === "string" ? latest.version_id : "");
  if (!/^[0-9a-f-]{32,36}$/iu.test(versionId)) throw new Error("无法从 Wrangler deployment 清单确认当前生产 version ID");
  return versionId;
}

export function deployedBaseURL(output, domain) {
  if (domain) return `https://${domain}`;
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/giu) ?? [];
  const url = urls.at(-1) ?? "";
  if (!url) throw new Error("Wrangler 未返回 workers.dev 地址，无法执行部署后健康检查");
  return url.replace(/\/$/u, "");
}

async function verifyDeployment(baseURL) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/api/health`, {
        headers: { Accept: "application/json", "User-Agent": "m365-gateway-deploy-smoke/1" },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      if (response.ok) {
        let value;
        try { value = JSON.parse(body); } catch { /* validated below */ }
        if (value && typeof value === "object") return;
        last = "健康接口没有返回 JSON";
      } else last = `健康接口返回 HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`部署后健康检查失败：${last || "unknown error"}`);
}

function configuredSecretNames(configPath) {
  const output = runWrangler(["secret", "list", "--config", configPath, "--format", "json"], { capture: true });
  const parsed = parseWranglerJSON(output);
  if (!Array.isArray(parsed)) throw new Error("Wrangler Secret 清单格式无效");
  return new Set(parsed.flatMap((item) => item && typeof item === "object" && typeof item.name === "string" ? [item.name] : []));
}

async function ask(question, fallback = "") {
  if (args.yes) return fallback;
  if (!rl) throw new Error("部署器交互终端尚未初始化");
  const suffix = fallback ? ` [${fallback}]` : "";
  return (await rl.question(`${question}${suffix}: `)).trim() || fallback;
}

function assertWorkerName(value) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
    throw new Error("Worker 名称只能使用小写字母、数字和连字符，长度 1–63，首尾不能是连字符");
  }
}

function assertClientId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("M365 Client ID 必须是 Microsoft Entra Application (client) ID 的 GUID 格式");
  }
}

function assertKvId(value) {
  if (!/^[0-9a-f]{32}$/iu.test(value) || /^0{32}$/u.test(value)) {
    throw new Error("已有部署必须提供原 SENSITIVE_KV 的 32 位十六进制 ID，不能使用全零占位符");
  }
}

function normalizeDomain(value) {
  if (!value) return "";
  const normalized = value.toLowerCase().replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  if (normalized.includes("/") || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(normalized)) {
    throw new Error("自定义域名格式无效，请只填写类似 api.example.com 的主机名");
  }
  return normalized;
}

function configFor({ workerName, clientId, kvId, domain }) {
  const config = {
    name: workerName,
    main: path.join(root, "src", "index.ts"),
    compatibility_date: "2026-08-22",
    version_metadata: { binding: "CF_VERSION_METADATA" },
    workers_dev: true,
    preview_urls: true,
    assets: {
      directory: path.join(root, "web"),
      binding: "ASSETS",
      run_worker_first: true,
      html_handling: "none",
      not_found_handling: "none",
    },
    kv_namespaces: [{ binding: "SENSITIVE_KV", ...(kvId ? { id: kvId } : {}) }],
    durable_objects: {
      bindings: [
        { name: "TENANTS", class_name: "TenantState" },
        { name: "CHATS", class_name: "ChatSession" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TenantState", "ChatSession"] }],
    vars: {
      ENVIRONMENT: "production",
      TENANT_NAME: "default",
      MAX_ACCOUNTS: "40",
      MIGRATION_ENABLED: "false",
      MIGRATION_CANDIDATE_TAG: "account-migration-candidate",
      M365_CLIENT_ID: clientId,
      M365_AUTHORITY: "https://login.microsoftonline.com/common",
      M365_REDIRECT_URI: "https://login.microsoftonline.com/common/oauth2/nativeclient",
      M365_SCOPE: "openid profile offline_access https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite",
    },
    secrets: { required: ["DATA_ENCRYPTION_KEY", "BOOTSTRAP_ADMIN_PASSWORD"] },
    observability: { enabled: true, head_sampling_rate: 1 },
  };
  if (domain) config.routes = [{ pattern: domain, custom_domain: true }];
  return config;
}

async function ensureDependencies() {
  if (existsSync(wranglerEntry)) return;
  console.log("\n[1/7] 安装锁定版本依赖…");
  runNpm(["ci"]);
}

async function ensureCloudflareLogin() {
  console.log("\n[2/7] 检查 Cloudflare 登录…");
  const probe = spawnSync(process.execPath, [wranglerEntry, "whoami"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (probe.status !== 0) {
    console.log("尚未登录，将打开 Cloudflare 官方授权页面。");
    runWrangler(["login"]);
  }
  runWrangler(["whoami"]);
}

async function main() {
  rl = createInterface({ input: process.stdin, output: process.stdout });
  if (args.help) {
    showHelp();
    return;
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) throw new Error(`需要 Node.js 20 或更高版本，当前为 ${process.version}`);
  for (const required of ["package.json", "wrangler.jsonc", "src", "web"]) {
    if (!existsSync(path.join(root, required))) throw new Error(`项目文件不完整：缺少 ${required}`);
  }

  const workerName = args.name ?? await ask("Worker 名称", "m365-gateway-cf");
  const clientId = args.client_id ?? await ask("Microsoft Entra Application (client) ID", args.dryRun ? "00000000-0000-4000-8000-000000000001" : "");
  const domain = normalizeDomain(args.domain ?? await ask("自定义域名（可留空）", ""));
  assertWorkerName(workerName);
  assertClientId(clientId);

  if (args.yes && !args.dryRun && !args.client_id) throw new Error("--yes 模式必须同时提供 --client-id");
  if (args.update && args.yes && !args.kv_id) throw new Error("无人值守更新必须同时提供 --kv-id，禁止生成新 KV 覆盖旧绑定");

  await ensureDependencies();
  if (!args.dryRun) await ensureCloudflareLogin();

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "m365-gateway-cf-"));
  const configPath = path.join(temporaryDirectory, "wrangler.deploy.json");
  const secretPath = path.join(temporaryDirectory, "secrets.json");
  let kvId = args.kv_id ?? "";
  let bootstrapPassword = "";
  let secretsForDeploy = {};
  let previousVersionId = "";

  if (args.update) {
    if (!kvId || /^0{32}$/u.test(kvId)) kvId = await ask("粘贴现有 SENSITIVE_KV namespace ID", "");
    assertKvId(kvId);
  }

  await writeFile(configPath, `${JSON.stringify(configFor({ workerName, clientId, kvId, domain }), null, 2)}\n`, { mode: 0o600 });

  if (args.dryRun) {
    console.log("\n[DRY RUN] 只验证 Worker 构建，不访问 Cloudflare 资源。");
    runWrangler(["deploy", "--config", configPath, "--dry-run"]);
    return;
  }

  if (!args.update) {
    console.log("\n[3/7] 创建独立的 SENSITIVE_KV…");
    runWrangler(["kv", "namespace", "create", `${workerName}-sensitive`, "--binding", "SENSITIVE_KV", "--update-config", "--config", configPath]);
    const updated = JSON.parse(await readFile(configPath, "utf8"));
    kvId = updated?.kv_namespaces?.find((entry) => entry.binding === "SENSITIVE_KV")?.id ?? "";
    assertKvId(kvId);
    console.log("KV 已创建并仅写入临时部署配置。");

    console.log("\n[4/7] 生成 DATA_ENCRYPTION_KEY…");
    bootstrapPassword = randomSecret(24);
    secretsForDeploy = {
      DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
    };
    await writeFile(secretPath, `${JSON.stringify(secretsForDeploy)}\n`, { mode: 0o600 });
    console.log("加密密钥和随机初始管理员密码已生成；不会写入项目目录。");
  } else {
    console.log("\n[3/7] 更新模式：检查并复用现有 KV 与 Secret。");
    previousVersionId = deployedVersionId(runWrangler(["deployments", "list", "--config", configPath, "--json"], { capture: true }));
    console.log(`已记录当前生产版本：${previousVersionId}`);
    const secretNames = configuredSecretNames(configPath);
    if (!secretNames.has("DATA_ENCRYPTION_KEY")) {
      throw new Error("现有 Worker 缺少 DATA_ENCRYPTION_KEY；为避免破坏已有 OAuth 密文，已停止更新");
    }
    if (!secretNames.has("BOOTSTRAP_ADMIN_PASSWORD")) {
      bootstrapPassword = randomSecret(24);
      secretsForDeploy = { BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword };
      await writeFile(secretPath, `${JSON.stringify(secretsForDeploy)}\n`, { mode: 0o600 });
      console.log("现有 Worker 缺少新的引导密码 Secret；已生成随机值。已有管理员密码不会被覆盖。");
    }
  }

  console.log("\n[5/7] 执行 TypeScript、后台契约、Worker 回归测试和部署 dry-run…");
  runNpm(["run", "check:no-docs"]);
  runNpm(["run", "typecheck"]);
  runNpm(["run", "check:ui"]);
  runNpm(["test"]);
  runWrangler(["deploy", "--config", configPath, "--dry-run"]);

  console.log("\n[6/7] 部署 Cloudflare Worker…");
  const deployArgs = ["deploy", "--config", configPath, "--keep-vars", "--message", "one-click Cloudflare deployment"];
  if (Object.keys(secretsForDeploy).length > 0) deployArgs.push("--secrets-file", secretPath);
  const deployOutput = runWrangler(deployArgs, { capture: true });

  const baseURL = deployedBaseURL(deployOutput, domain);
  console.log(`正在验证：${baseURL}/api/health`);
  try {
    await verifyDeployment(baseURL);
  } catch (error) {
    if (args.update && previousVersionId) {
      console.error("新版本健康检查失败，正在回滚到部署前版本…");
      runWrangler(["rollback", previousVersionId, "--config", configPath, "--yes", "--message", "automatic rollback after failed health check"]);
      throw new Error(`${error instanceof Error ? error.message : String(error)}；已回滚到 ${previousVersionId}`);
    }
    throw error;
  }

  console.log("\n[7/7] 部署完成");
  console.log(`Worker：${workerName}`);
  console.log(`健康检查：${baseURL}/api/health（通过）`);
  if (domain) console.log(`管理后台：https://${domain}/`);
  else console.log("管理后台地址请使用上方 Wrangler 输出的 workers.dev URL。");
  if (bootstrapPassword) console.log(`本次生成的初始管理员密码（仅显示一次）：${bootstrapPassword}`);
  else console.log("管理员密码沿用现有 Durable Object 状态。");
  console.log("首次登录后必须立即修改管理员密码，然后添加 Microsoft 365 账号并创建 API Key。");
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  try {
    await main();
  } catch (error) {
    console.error(`\n部署失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    rl?.close();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
