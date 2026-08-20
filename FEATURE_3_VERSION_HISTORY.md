# 功能三：版本 Diff 与安全回滚实现记录

> 分支：`codex/version-diff-rollback`  
> 基线：`main@659e89b`  
> 状态：代码与测试已写入 GitHub 分支；未部署生产。仓库当前没有现成 GitHub Actions 工作流，因此本文不宣称云端测试已经执行通过。

## 已实现能力

### 管理 API

- `GET /api/v1/notes/:noteId/versions`
  - Viewer 及以上可读取有权知识库的版本摘要。
  - 返回经过筛选的版本元数据，不暴露内部 R2 object key。
- `GET /api/v1/notes/:noteId/versions/:version`
  - 读取指定历史版本完整 Markdown。
  - 返回版本 ETag，并执行知识库权限与当前文档状态检查。
- `POST /api/v1/notes/:noteId/restore`
  - 必须携带当前文档 `If-Match`。
  - Viewer 不能回滚；Editor/Admin 可以回滚。
  - 回滚始终创建 `N+1`，不会覆盖或删除旧版本。
  - 已删除文档必须走回收站恢复接口，历史回滚不会替代回收站恢复。

### MCP

普通读取 Token 新增：

- `list_note_versions`
- `read_note_version`

`knowledge:admin` 额外新增：

- `restore_note_version`
  - 必填 `operation_id`
  - 必填 `expected_version`
  - 必填 `source_version`
  - 继续复用最高权限 Token 的请求/写入限额、IP 网段审计和幂等回执。

第一版没有增加服务端 Diff Tool。Agent 需要比较时读取两个版本自行处理，避免把大型 Diff 强制塞进上下文。

## Web 版本工作区

新增路由：

```text
/knowledge/:collectionId/notes/:noteId/versions
```

当当前路由包含知识库和文档 ID 时，主导航显示“版本对比”入口。

版本工作区行为：

- 按需读取两个版本；
- frontmatter 与正文分开比较；
- 自动忽略服务端生成的 `version` 字段；
- 保留并检查 Markdown `id` 一致性；
- 正文使用行级 Diff；
- 桌面双栏，移动端按旧/新版本上下排列；
- 历史内容只通过 Vue 文本插值渲染，不使用 `v-html`；
- Diff 最多输出 1600 行，中间超大差异折叠；
- LCS 计算超过阈值时退化为有界的行级增删，避免大型 Markdown 在浏览器产生过量 CPU/DOM 开销。

旧知识编辑页的历史恢复调用也继续可用：前端 API 客户端保存最近一次读取当前 Note 时得到的 ETag；旧调用未显式发送 `If-Match` 时使用这个“页面真实观察到的 ETag”。如果文档已被别人更新，服务端仍返回 `409`，不会退化为无锁回滚。

## 并发与数据不变量

回滚必须同时满足：

1. 当前版本仍等于 `expected_version`；
2. 文档仍处于活动状态，不能已经进入回收站；
3. `source_version` 必须早于当前版本；
4. 当前 Note 成功升级到 `N+1` 后，新的 `note_versions` 行才能插入；
5. R2 `versions/.../N+1.md` 使用不可覆盖写入；
6. 竞争失败时检查并清理没有任何 D1 引用的临时 R2 新版本对象；
7. 成功后刷新 `current.md`、排队新版本索引并写入 `note.restore_version` 审计事件。

审计 metadata 至少包含：

- `sourceVersion`
- `currentVersion`
- `restoredVersion`
- `jobId`

## 新增/更新测试

Worker / API / MCP：

- `tests/version-history.integration.test.ts`
  - 指定版本读取与 ETag；
  - 缺少/过期 `If-Match`；
  - Viewer 读取但不能回滚；
  - 回滚生成 v3、旧 R2 不变、新索引任务排队；
  - 审计 metadata；
  - 未授权用户猜测版本 URL 不泄漏正文。
- `tests/version-history.mcp.test.ts`
  - 普通 Token 发现并使用版本读取工具；
  - 越权知识库版本读取不泄漏；
  - Admin 发现 `restore_note_version`；
  - 相同 `operation_id` 重试只产生一次逻辑回滚。
- `tests/version-history-race.integration.test.ts`
  - 在回滚提交瞬间模拟并发删除；
  - 必须返回 `409`；
  - 文档保持 deleted；
  - 不留下 v3 D1 历史或孤立 R2 v3。
- `tests/mcp.contract.test.ts`
  - 普通工具基线从 6 更新为 8；
  - Admin 工具基线从 15 更新为 18。

Web：

- `tests/web/version-diff.test.ts`
  - frontmatter 分离；
  - 自动 version 字段忽略；
  - ID 不一致检测；
  - 大 Diff 有界输出。
- `tests/web/version-history-view.test.ts`
  - 恶意 `<script>` 仅作为文本，不产生 script DOM；
  - Viewer 回滚禁用；
  - Editor 回滚发送当前 `If-Match`。
- `tests/web/api-etag.test.ts`
  - 旧历史弹窗调用自动使用页面最近观察到的 ETag；
  - 显式 `If-Match` 永远不会被覆盖。

## 部署状态

本分支没有执行：

- 生产 D1 migration；
- Worker deploy；
- 香港服务器前端发布；
- 生产 Token 或知识数据修改。

合并或部署前仍应在可执行环境中运行：

```powershell
pnpm test
pnpm test:web
pnpm typecheck
pnpm build
pnpm test:e2e
pnpm deploy:check
```
