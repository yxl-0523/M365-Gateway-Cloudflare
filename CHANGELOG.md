# Changelog

## 0.1.1 - 2026-08-27

- 全量稳定性修复：客户端断开会跨 Durable Object 取消上游 WebSocket，账号门控只在上游真正结束后释放，避免遗留活动请求造成连续 409。
- ChatHub 空更新不再续期进展超时；保留 90 秒无语义进展超时和 10 分钟逻辑硬上限。
- 统一 OpenAI、Responses、Anthropic 的终端错误码、SSE 失败统计和估算 Token 用量，诊断记录可按脱敏错误码定位。
- Microsoft 刷新令牌错误按授权失效、限流、服务不可用和凭据损坏分别映射 HTTP 状态，后台明确显示“需要重新授权”。
- 删除共享默认管理员密码；新部署必须提供随机 `BOOTSTRAP_ADMIN_PASSWORD` Secret，一键部署只显示一次随机初始密码。
- KV 绑定不再包含可误用的全零 ID；一键部署自动创建独立 KV，更新模式强制复用原 KV 和加密 Secret。
- 增加当前 Cloudflare Vitest Workers 测试池回归，覆盖 HTTP 方法、初始改密、API Key、Durable Object 取消、进展超时、工具续接和幂等统计。

## 0.1.0 - 2026-08-26

- 增加 `deploy-cloudflare.mjs` JavaScript 一键部署器，自动创建 KV、生成加密 Secret、检查并部署 Worker；更新模式强制复用原 KV 与 Secret。
- 首个明确标注的 Cloudflare 原生开源版本。
- 提供 OpenAI Chat Completions、Responses 与 Anthropic Messages 兼容接口。
- 提供 Durable Objects 会话/账户状态、KV 加密凭据镜像和同域管理后台。
- 提供工具循环保护、请求截止时间、账号级 FIFO 门控、结构化诊断与安全回归测试。
- 工具轮次达到上限时以正常完成的助手消息结束，不再错误包装为 `upstream_error` 或触发客户端任务重启。
- 当前单活账号由 Durable Object Alarm 在到期前主动续期；微软暂时不可用时采用有界指数退避，休眠账号保持凭据隔离并在唤醒时续期。
- 提供可选的固定目标出口 Relay，默认部署不依赖服务器。
- README 补充从零开始的逐步安装、Entra OAuth、Cloudflare KV/Secret、部署验收、客户端接入、升级回滚和故障排查流程。
- 发布包移除独立 `docs/` 目录并加入目录检查；README 增加宣传图和交流群 35337083。
