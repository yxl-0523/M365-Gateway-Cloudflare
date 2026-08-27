# Changelog

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
