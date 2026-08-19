# Knowledge Core

面向 Codex 等 AI Agent 的 Markdown 知识库。系统负责知识管理、混合检索、原文读取、权限控制和记忆提案，不负责生成聊天答案。

生产环境拆成两个入口：

- `https://rag.coylin.com`：香港服务器上的 Vue 3 管理后台，Nginx 将同源 `/api/*` 反代到 Worker。
- `https://rag-api.coylin.com`：Cloudflare Worker，承载 `/api/v1/*`、`/mcp`、`/healthz`、Queue 索引消费者和 Cron 恢复任务。

Markdown 正文和历史版本存放在私有 R2；D1 保存权限、元数据、FTS、任务、Token 哈希与审计；Vectorize 保存 1024 维余弦向量。

二期五项安全增强的详细规划见 [ROADMAP_5_FEATURES.md](./ROADMAP_5_FEATURES.md)。回收站与最高权限 Token 风控已经在当前分支完成本地实现与测试，仍未部署；版本 Diff、来源时效和批量导入导出尚未实现。

> 上线状态（2026-07-14）：Worker 已部署到 `rag-api.coylin.com`；香港服务器上的 Vue/Nginx、Let's Encrypt HTTPS 和自动续期均已完成。`rag.coylin.com` 保持 DNS only，并使用站内登录页面保护管理后台。

## 系统要求

- Node.js 22 或更高版本
- pnpm 10
- Cloudflare 账户和 Wrangler 登录状态
- Cloudflare Workers AI 权限（默认使用 1024 维多语言 BGE-M3）
- 可选：OpenAI 兼容 Rerank API

```powershell
corepack enable
pnpm install
pnpm exec wrangler login
```

## 本地开发

仓库已提供被 Git 忽略的 `.dev.vars`。本地模式使用 `admin@example.com` 作为开发身份；Embedding 配置留空时使用确定性伪向量，适合验证流程，不代表真实语义检索质量。

```powershell
pnpm db:migrate:local
pnpm dev
```

打开 [http://localhost:5173](http://localhost:5173)。Vite 会把 `/api`、`/mcp` 和 `/healthz` 代理到本地 Worker `8787` 端口；生产构建会通过 `.env.production` 在 Token 页面显示 `https://rag-api.coylin.com/mcp`。

Vectorize 当前不支持纯本地绑定。开发环境会继续完成 D1 FTS 流程并跳过不可用的本地向量调用；真实语义检索应在测试覆盖或生产 Vectorize 上验收。

## 创建 Cloudflare 资源

项目只创建一个长期生产 Worker，不创建独立 staging Worker。先登录正确账户，再执行：

```powershell
pnpm exec wrangler d1 create knowledge-core-db
pnpm exec wrangler r2 bucket create knowledge-core-notes
pnpm exec wrangler vectorize create knowledge-core-v1 --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index knowledge-core-v1 --property-name=collection_id --type=string
pnpm exec wrangler queues create knowledge-core-index
pnpm exec wrangler queues create knowledge-core-index-dlq
```

D1 创建命令会返回 `database_id`。把它替换到 `wrangler.jsonc` 的 `d1_databases[0].database_id`。其余资源名称已与配置一致。`collection_id` metadata index 必须在首次写入向量前创建，否则按知识库过滤的语义检索无法工作。当前生产 D1 ID 已写入配置，R2、Vectorize、metadata index、Queue 和 DLQ 也已于 2026-07-14 创建。

R2 Bucket 不要开启公共访问。所有 Markdown 都应经过 Worker 的管理会话或 MCP Token 权限检查读取。

## 配置 Embedding 与 Rerank

生产环境默认通过原生 `AI` binding 使用 `@cf/baai/bge-m3`，无需单独配置 Embedding URL 或 API Key。模型输出为 1024 维，与 `knowledge-core-v1` Vectorize 索引一致。

如需改用外部 OpenAI 兼容 Embedding，可在 `wrangler.jsonc` 中填写：

```jsonc
"EMBEDDING_BASE_URL": "https://your-provider.example/v1",
"EMBEDDING_MODEL": "your-multilingual-1024-model",
"RERANK_BASE_URL": "https://your-provider.example/v1",
"RERANK_MODEL": "your-reranker"
```

外部服务密钥只通过 Worker Secrets 写入：

```powershell
pnpm exec wrangler secret put EMBEDDING_API_KEY
pnpm exec wrangler secret put RERANK_API_KEY
```

Rerank 可不配置；不可用时系统保留 RRF 排序。只有启用外部 Embedding 时才需要 `EMBEDDING_API_KEY`。模型输出维度必须严格为 1024；更换模型或维度时应创建新 Vectorize 索引并全量重建，不能混用旧向量。

## 配置域名与管理员登录

1. 在 Cloudflare DNS 中创建 DNS only 的 `A` 记录：`rag` 指向 `34.150.83.74`，不要开启代理。
2. Nginx 直接提供 Let's Encrypt HTTPS，并把同源 `/api/*` 反代到 Worker。
3. 管理员在站内登录页使用 `admin@coylin.com` 和初始密码登录；Worker 返回 12 小时的 HttpOnly、Secure、SameSite=Strict 会话 Cookie。
4. Nginx 使用独立共享密钥向 Worker 证明管理请求来自受控服务器；该密钥分别存于服务器 root 配置和 Cloudflare Worker Secret。

```jsonc
"BOOTSTRAP_ADMIN_EMAILS": "admin@coylin.com",
"ADMIN_LOGIN_EMAIL": "admin@coylin.com",
"ADMIN_ORIGIN": "https://rag.coylin.com"
```

生产配置必须保持：

```jsonc
"ENVIRONMENT": "production",
"DEV_AUTH_BYPASS": "false"
```

`ADMIN_PROXY_SECRET`、`ADMIN_LOGIN_PASSWORD_HASH` 和 `ADMIN_SESSION_SECRET` 必须通过 `wrangler secret put` 写入，不能进入仓库。`rag-api.coylin.com` 是 Worker Custom Domain，不要把它指向香港服务器。`/mcp` 由独立 MCP Bearer Token 鉴权；`/healthz` 保持公开且只返回最小状态；`/api/v1/*` 同时验证 Nginx 代理凭证和管理会话。直接访问 API 会被拒绝。

`rag.coylin.com` 必须保持 DNS only。生产环境所有非只读管理请求还会校验 `Origin: https://rag.coylin.com`，登录接口由 Nginx 按 IP 限速。

## 部署 Worker

先填写真实 D1 ID 与登录配置，再按需设置外部服务 Secrets。`pnpm deploy:check` 会拒绝占位配置：

```powershell
pnpm deploy:check
pnpm test
pnpm typecheck
pnpm build
pnpm db:migrate:remote
pnpm deploy
```

`pnpm deploy` 会把 Worker 绑定到 `rag-api.coylin.com`。部署后检查：

```powershell
curl.exe https://rag-api.coylin.com/healthz
```

响应只包含：

```json
{"status":"ok"}
```

然后通过网页创建第一个知识库、管理员成员和 MCP Token。Token 明文只显示一次；服务端只保存 SHA-256 哈希。

## 部署 Vue 到香港服务器

构建产物只包含静态文件，不需要在服务器运行 Node.js：

```powershell
pnpm build:web
pnpm verify:production:web
tar -czf rag-web.tar.gz -C dist .
scp rag-web.tar.gz user@your-hk-server:/tmp/rag-web.tar.gz
```

`pnpm build:web` 会在 Vite 构建后检查 `index.html`、Vue 挂载点以及全部入口 JS/CSS 是否真实存在且非空。部署完成后必须执行 `pnpm verify:production:web`；它会从公网入口重新提取全部引用资源，检查状态码和 Content-Type，并同时验证未登录会话与 Worker 健康状态。

在服务器上把压缩包解压到 `/var/www/rag.coylin.com/releases/<release>`，再将 `/var/www/rag.coylin.com/current` 原子切换到该目录。首发先使用 `rag.coylin.com.bootstrap.conf`，保持 DNS only 并签发证书：

```bash
sudo certbot certonly --webroot -w /var/www/rag.coylin.com/current -d rag.coylin.com
```

证书签发成功后安装 `rag.coylin.com.conf` 和 `rag-api-proxy-common.conf`，保持 DNS only，再执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 对 `/api/` 的 `proxy_pass` 不包含路径后缀，因此会原样保留 `/api/v1/*`，并注入服务器私密代理凭证。部署后访问 `https://rag.coylin.com/login`，确认站内登录、退出、文档操作和 Token 页面显示的 MCP 地址都正确。

## 连接 Codex MCP

在管理后台的“`MCP Token`”页面创建 Token。普通 Agent 使用 `knowledge:read`；需要提交记忆提案时再增加 `memory:propose`。只有 `BOOTSTRAP_ADMIN_EMAILS` 中的初始管理员能签发 `knowledge:admin`：它覆盖所有当前及未来知识库，并允许受信任 Agent 直接 CRUD 知识库与 Markdown，但不能管理 Token、成员或管理员账号。最高权限 Token 必须设置 5 分钟至 7 天的有效期，默认 24 小时，并带有每分钟请求、每小时写入限额；任务结束后立即撤销，bootstrap 管理员也可以在 Token 页面一键撤销全部最高权限 Token。

先把 Token 放入运行 Codex 的环境变量：

```powershell
$env:KNOWLEDGE_CORE_MCP_TOKEN = "kcore_..."
```

在 Codex `config.toml` 中加入：

```toml
[mcp_servers.knowledge_core]
url = "https://rag-api.coylin.com/mcp"
bearer_token_env_var = "KNOWLEDGE_CORE_MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 60
```

普通 Token 连接后可发现以下 MCP Tools：

- `list_collections`
- `list_notes`
- `list_recent_changes`
- `search_knowledge`
- `read_note`
- `propose_memory`

`knowledge:admin` Token 还会发现以下 9 个写工具：

- `create_collection`
- `update_collection`
- `trash_collection`
- `delete_collection`（`trash_collection` 的兼容别名，不会物理删除）
- `restore_collection`
- `create_note`
- `update_note`
- `delete_note`
- `restore_note`

文档资源 URI 为：

```text
kb://collections/{collectionId}/notes/{noteId}
```

普通 Token 对正式知识只读；`propose_memory` 只创建待审核提案，管理员批准后才生成正式 Markdown 并进入索引。最高权限 Token 可以直接写正式知识，但集合更新/回收必须携带最后读取的 `updated_at`，文档更新/回收必须携带当前 `version`，移入回收站还必须精确确认知识库名称或文档标题。最高权限 MCP 写工具都必须携带新的 UUID `operation_id`；网络重试使用相同 ID 会回放原结果，篡改输入会被拒绝。回收后普通 API、搜索、MCP Tool 与 Resource 都无法读取对象；恢复使用最后观察到的 `trashed_at/deleted_at` 防止并发覆盖。所有 Agent 写入都会记录 Token 身份和不可变审计事件。

## 数据布局

```text
notes/{collectionId}/{noteId}/current.md
versions/{collectionId}/{noteId}/{version}.md
proposals/{collectionId}/{proposalId}.md
```

正式存储的 Markdown 始终包含服务端维护的 `id` 和 `version`。更新请求必须携带当前 ETag 作为 `If-Match`，并发冲突返回 `409`。

## 检索与索引

索引消费者执行：

```text
Markdown -> 标题/段落/代码块切分 -> 批量 Embedding
-> 写入新版 D1/FTS 与 Vectorize -> 切换 indexed_version -> 删除旧索引
```

检索执行：

```text
Vectorize 30 条 + D1 FTS5 30 条 -> RRF -> Rerank 前 20 条 -> 返回最多 8 条
```

Queue 最多自动重试 5 次，仍失败的消息进入 `knowledge-core-index-dlq`。管理后台可以查看失败任务并在授权范围内手动重试。

## 验证命令

```powershell
pnpm test          # Worker 单元、D1/R2/Queue、MCP 合约测试
pnpm typecheck     # Vue 与 Worker 严格 TypeScript
pnpm build         # 前端构建和 Worker dry-run
pnpm test:e2e      # Playwright 网页闭环
```

Windows 下 Cloudflare 测试运行时不能从中文路径启动。`pnpm test` 会自动建立无密钥 ASCII 临时副本、运行测试并清理。

## 第一版边界

- 仅接受 UTF-8 Markdown，单篇最大 2 MiB。
- 不处理图片、附件、PDF、Office、网页抓取或 OCR。
- 不提供聊天页面，也不调用模型生成答案。
- 普通 Agent 不允许直接修改正式知识；仅显式签发的 `knowledge:admin` Token 可执行带版本锁、删除确认和审计的 CRUD。
- 免费额度随 Cloudflare 套餐变化，上线前以账户 Dashboard 和官方 Limits 页面为准。

完整架构、阶段和验收标准见 [PLAN.md](./PLAN.md)。与 GitHub 开源 Agent 知识库的对比和后续优先级见 [OPEN_SOURCE_GAP.md](./OPEN_SOURCE_GAP.md)。
