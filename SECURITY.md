# Security Policy

## 支持范围

当前维护版本为 `0.1.x`。部署者必须使用自己的 Cloudflare 账号、KV 命名空间、域名和 `DATA_ENCRYPTION_KEY`。

## 报告漏洞

请使用代码托管平台的私密安全报告功能，或通过维护者提供的私密渠道报告。不要在公开 Issue 中提交真实 OAuth token、API Key、Cookie、账号邮箱、KV ID、生产域名、上游 URL 查询参数或日志原文。

报告建议包含：受影响版本、最小复现、影响范围、是否需要已认证账户以及脱敏后的响应状态/错误码。

## 部署基线

- 仓库不预填 KV ID；手工部署前必须绑定本部署自己创建的 `SENSITIVE_KV`。
- `DATA_ENCRYPTION_KEY` 只能通过首次部署的临时 `--secrets-file` 或已有 Worker 的 `wrangler secret put` 注入，不能写入配置或 Git。
- `BOOTSTRAP_ADMIN_PASSWORD` 必须是每次新部署独立生成的随机 Cloudflare Secret，至少 12 个字符；首次登录后必须立即修改。
- 生产回归脚本应设置 `M365_PRODUCTION_HOST`，默认禁止误打生产域名。
- 迁移端点默认关闭；临时启用后必须删除迁移签名 Secret 并恢复关闭状态。
- 定期运行 `npm audit`、`npm run check` 并查看 Cloudflare 部署/Secret 清单。
