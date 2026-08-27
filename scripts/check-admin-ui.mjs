import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../web");
const [html, login, debug, readme] = await Promise.all([
  readFile(resolve(webRoot, "index.html"), "utf8"),
  readFile(resolve(webRoot, "login.html"), "utf8"),
  readFile(resolve(webRoot, "debug.html"), "utf8"),
  readFile(resolve(here, "../README.md"), "utf8"),
]);

const assertions = [
  [/<form\s+onsubmit="createKey\(event\)">/u, "API Key form must submit through createKey(event)"],
  [/id="createKeySubmit"[^>]*type="submit"[^>]*>确定创建<\/button>/u, "API Key modal must expose a visible submit button"],
  [/if\(submit\.disabled\)return/u, "API Key submission must prevent duplicate clicks"],
  [/submit\.hidden=true/u, "API Key submit button must hide after successful creation"],
  [/if\(days<1\)/u, "custom API Key lifetime must be validated before submission"],
  [/k\.lastUsedAt\?formatDate\(k\.lastUsedAt/u, "API Key UI must render the real lastUsedAt field"],
  [/Gateway Control/u, "independent Gateway Control brand must be visible"],
  [/M365 Gateway/u, "independent M365 Gateway brand must be visible"],
  [/Durable Object 强一致密文权威副本 \+ AES-GCM KV 镜像/u, "credential storage boundary must be described accurately"],
  [/本页不是实时日志/u, "diagnostics UI must not claim to be a realtime log"],
  [/不支持不带字段名的裸授权码/u, "OAuth paste instructions must reject an unsupported bare code"],
  [/role="dialog" aria-modal="true" aria-labelledby="keyModalTitle"/u, "API Key modal must expose dialog semantics"],
  [/id="notice"[^>]*role="status"[^>]*aria-live="polite"/u, "UI notices must be announced accessibly"],
];

for (const [pattern, message] of assertions) {
  if (!pattern.test(html)) throw new Error(message);
}

for (const source of [html, login, debug]) {
  if (/Copilot Bridge/u.test(source)) throw new Error("legacy Copilot Bridge brand must not remain in Cloudflare assets");
  for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)) {
    new Script(match[1]);
  }
}

const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicateIds.length > 0) throw new Error(`duplicate HTML ids: ${duplicateIds.join(", ")}`);
if ((html.match(/id="createKeySubmit"/gu) ?? []).length !== 1) throw new Error("API Key modal must have exactly one submit button");

if (/admin888/u.test(login)) throw new Error("login page must not expose a shared bootstrap password");
if (!/随机初始密码仅在部署终端显示一次/u.test(login)) throw new Error("login page must explain one-time random bootstrap credentials");
if ((login.match(/minlength="12"/gu) ?? []).length !== 2) throw new Error("both new-password inputs must enforce the 12-character minimum");
if (/8 个字符|minlength="8"/u.test(`${login}\n${html}`)) throw new Error("stale 8-character password copy must not remain");
if (!/next\.length<12/u.test(html)) throw new Error("settings page must enforce the 12-character password minimum");

if (!/sessionStorage\.setItem\('m365\.currentPage','logs'\)/u.test(debug)) throw new Error("legacy debug URL must route users to structured diagnostics");
if (/JSON\.stringify|x\.client|x\.upstream|x\.gateway|undefined/u.test(debug)) throw new Error("debug compatibility page must not render raw or nonexistent payload fields");

if (/32 MiB/u.test(readme) || !/AI 请求体 8 MiB/u.test(readme)) throw new Error("README must document the real 8 MiB AI request limit");
if (!/7 天/u.test(readme) || !/64 个/u.test(readme) || !/512 个/u.test(readme)) throw new Error("README must document bounded Responses alias retention");
if (!/最长 10 分钟/u.test(readme)) throw new Error("README must document the bounded long-task deadline");
if (!/图片输入与生成仍是未完成真实上游验收的候选能力/u.test(readme)) throw new Error("README must label image support as an unverified candidate capability");
if (!/音频、Realtime 和语音不支持/u.test(readme)) throw new Error("README must state that voice and Realtime are unsupported");

console.log("admin UI contract checks passed");
