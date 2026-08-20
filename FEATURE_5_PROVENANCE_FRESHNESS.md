# 来源与知识时效实现记录

> 分支：`codex/provenance-freshness`  
> 基线：`codex/version-diff-rollback`  
> 状态：功能代码与自动化测试用例已写入 GitHub；尚未在 GitHub CI 实际执行，尚未部署生产。

## 目标

这一阶段把 Knowledge Core 的文档从“有版本的 Markdown”扩展为“带来源、观察时间、人工复核和时效警告的可治理知识”。

核心不变量：

- 旧 Markdown 不增加新字段也继续合法。
- 来源字段不能成为 Secret、Cookie、私钥或带凭证 URL 的存储位置。
- `review_after` 只表示需要复核，不自动删除或判定知识错误。
- 超期知识仍可检索，但所有 Agent 主要读取路径都必须显式返回 `review_due`。
- `reviewed_at` 只能由网页登录的人类 Editor/Admin 通过专门复核操作生成。
- `knowledge:admin` Agent 可以更新正文、来源和观察时间，但不能伪造人工复核时间。
- `supersedes` 只能指向同一活动知识库中的现有文档，不能自引用。
- 正常编辑、历史回滚、人工复核都必须在 current 前进前确保 N+1 历史版本存在，避免并发删除留下断裂版本或孤立对象。

## 数据模型

迁移：`migrations/0007_note_provenance.sql`

`notes` 新增：

- `source_json`
- `observed_at`
- `reviewed_at`
- `review_after`
- `supersedes_json`
- `external_path`
- `sync_base_hash`

`review_after` 和 `external_path` 增加索引。所有列均允许 `NULL`，旧数据无需补写。

## Markdown frontmatter

支持可选字段：

```yaml
source:
  type: project
  uri: project://knowledge-core/status
  label: Knowledge Core 项目状态
  observed_at: 2026-08-20T00:00:00.000Z
review_after: 2026-11-20T00:00:00.000Z
reviewed_at: 2026-08-20T00:00:00.000Z
supersedes: []
```

`source.type`：

- `manual`
- `agent`
- `import`
- `git`
- `url`
- `project`

`reviewed_at` 不允许通过普通 Markdown 保存接口任意改变。服务端会保留当前人工复核值；提交不同值时返回 `reviewed_at_managed`。

## 来源安全

`src/worker/lib/provenance.ts` 对来源字段执行服务端校验：

- 常见私钥头
- OpenAI 风格 `sk-...`
- Stripe key
- GitHub token / fine-grained PAT
- Knowledge Core `kcore_...`
- Authorization / Cookie / Set-Cookie
- `api_key`、`access_token`、`session`、`password`、`secret` 等命名凭证
- URL `username:password@host` userinfo
- URL 查询参数中的 token/key/secret/password/signature/session/credential/auth 类字段
- URI 协议白名单
- `url` 来源仅允许 `http` / `https`

## 时效语义

时效动态计算，不保存漂移的 `stale` 布尔值：

- `review_after == null`：无复核期限
- `review_after >= now`：当前
- `review_after < now`：返回 `warnings: ["review_due"]`

超期知识不会从搜索中消失。

## API

新增：

- `GET /api/v1/collections/:collectionId/review-due?limit=...`
- `POST /api/v1/notes/:noteId/review`

人工复核要求当前 `If-Match`，并且：

1. 读取当前不可变版本。
2. 写入新的 `reviewed_at` 和可选 `review_after`。
3. 创建 N+1 R2 历史对象。
4. 在 D1 中先确保 N+1 `note_versions` 历史存在，再允许 current 前进。
5. 更新 `current.md`。
6. 投递新版本索引任务。
7. 写 `note.review` 审计。

Viewer 可读取待复核列表；只有 Editor/Admin 可以执行人工复核。

## MCP

新增只读工具：

- `list_review_due`

现有：

- `list_notes`
- `read_note`
- `search_knowledge`

现在都会返回来源、观察时间、复核时间、复核期限和 `warnings`。

当前 MCP 工具数量基线：

- 普通读 Token：9
- `knowledge:admin`：19

`kb://collections/{collectionId}/notes/{noteId}` Resource 在文档已过期时，会在 Markdown 前追加纯文本 `review_due` 警告。Resource 越权/不存在仍保持 JSON-RPC error 契约。

## Web

新增：

- `/review-due` 待复核工作区
- 文档级“来源与知识时效”上下文控件

待复核工作区展示：

- 来源
- 观察时间
- 最近人工复核
- 复核期限
- 当前版本
- `review_due`

Editor/Admin 可以选择下一次复核日期；Viewer 按钮禁用。

## 版本与并发

来源/时效必须和版本系统保持一致：

- 历史版本读取从对应 R2 Markdown 解析当时的 provenance。
- 人类历史回滚可以恢复历史来源/复核状态。
- `knowledge:admin` Agent 历史回滚会强制保留当前人类 `reviewed_at`，不能借历史版本伪造人工复核。
- 正常编辑、历史回滚、人工复核统一采用“history guard → current update”的写入顺序。
- 如果删除先赢，N+1 current 不会生成，临时 N+1 D1 历史和 R2 对象会清理。

## 自动化测试用例

新增：

- `tests/provenance.integration.test.ts`
- `tests/provenance.mcp.test.ts`
- `tests/note-version-write-race.integration.test.ts`
- `tests/web/review-due.test.ts`
- `tests/web/provenance-context.test.ts`

并更新：

- `tests/mcp.contract.test.ts`

覆盖：

- 旧 Markdown 兼容
- 来源元数据持久化
- Secret / userinfo / credential URL 拦截
- `supersedes` 同知识库与自引用约束
- `review_due` 动态警告
- 人工复核生成 N+1 不可变历史
- Agent 伪造 `reviewed_at` 被拒绝
- MCP list/read/search/resource/list_review_due
- Viewer/Editor Web 权限
- 正常编辑/人工复核与回收站并发竞争

## 尚未完成的验收动作

当前仓库没有现成 GitHub Actions 工作流，因此本分支没有云端测试执行结果。

部署或合并前仍需实际执行：

```bash
pnpm typecheck
pnpm typecheck:web
pnpm test
pnpm test:web
pnpm build
```

并应执行 Wrangler dry-run、本地/预发布 D1 migration 和关键 E2E。

本阶段没有执行生产 migration、Worker deploy、香港服务器前端更新或生产数据修改。
