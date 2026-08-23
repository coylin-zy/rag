# Knowledge Core 技术与故障记录

> 本文按时间记录历史故障和验收过程。早期章节中的“尚待完成”只表示当时状态；当前产品状态与未完成范围以 README 和路线图顶部说明为准。

## 当前部署结构

- 前端：Vue 静态资源，部署在香港服务器 `aws-hk` 的 `/srv/apps/rag`，由 Docker 内的 Nginx 提供服务。
- 公开入口：`https://rag.coylin.com/`。
- API 与 MCP：Cloudflare Worker，健康检查为 `https://rag-api.coylin.com/healthz`。
- 存储与检索：Markdown 为知识正文，配套使用 Cloudflare R2、D1、Vectorize 与 Queues。

## 2026-08-03 白屏事故

### 用户可见现象

访问 `https://rag.coylin.com/` 时只有空白页面。入口 `index.html` 可以返回，但 Vue 应用没有启动。

### 根因

故障位于香港服务器的前端容器，不是 Cloudflare Worker。

前端静态目录 `/usr/share/nginx/html/assets` 的权限为 `700 root:root`，而 Nginx worker 使用 `nginx` 用户运行。Nginx 因此无法读取 JS/CSS，并在日志中出现：

```text
stat() ".../assets/..." failed (13: Permission denied)
```

Nginx 将静态资源读取失败表现为 404。浏览器能得到 HTML 外壳，但加载不到 Vue 入口脚本，所以显示白屏。

### 生产修复

在 `/srv/apps/rag` 中完成以下改动并以 `sudo` 重建：

1. Dockerfile 在复制静态文件后执行 `chmod -R a+rX /usr/share/nginx/html`。
2. Compose 健康检查不再只请求 `/healthz`，而是从 `index.html` 提取真实入口 JS 并验证可读取。
3. `scripts/validate.sh` 同时验证容器内与 HTTPS 域名下的入口 JS 返回 200。
4. 现有 `/srv/apps/rag/web/assets` 权限修正为 `755`。
5. 刷新 `MANIFEST.sha256`，随后运行部署脚本。

部署前备份位于：

```text
/srv/backups/rag-config-20260803T1428Z
```

### 验收结果

2026-08-03 使用直连源站方式复验：

- `https://rag.coylin.com/`：200，`text/html`。
- HTML 引用的 10 个 JS/CSS 资源：全部 200，Content-Type 正确。
- `https://rag-api.coylin.com/healthz`：200，`application/json`。
- `https://rag.coylin.com/api/v1/session`：未登录时返回预期的 401。
- `rag-frontend`：Docker 健康状态为 `healthy`。
- `/srv/apps/rag/web` 与 `/srv/apps/rag/web/assets`：均为 `755 root:root`。
- 重建后的近期容器日志：未再出现 `Permission denied`。

外网验证使用 `--resolve rag.coylin.com:443:18.163.179.215` 绕开本机失效的代理，并直接检查香港源站，避免把代理故障误判为站点故障。

## 防止再次发生

- 前端健康检查必须请求构建产物中的真实入口脚本，不能只检查一个独立健康页。
- 发布验证必须同时覆盖 HTML、入口 JS/CSS、API 反向代理和容器健康状态。
- 构建镜像时显式规范静态文件的读取和目录遍历权限，避免继承宿主机打包权限。
- 任何部署完成结论都应以公网资源返回结果和 Nginx 日志为依据，而不只看容器是否处于运行状态。

## 尚待完成的浏览器验收

当前 Codex 浏览器会话保存了对 `rag.coylin.com` 的拒绝权限，因此本轮没有绕过该设置进行可视化交互。待用户清除这条浏览器拒绝规则后，应补做：

1. 桌面与移动端首屏截图。
2. 登录流程和登录后知识库首屏。
3. 浏览器 Console 的错误与警告检查。
4. 至少一次知识条目打开、搜索或导航交互。

## 2026-08-03 防回归加固

### 已加入仓库的发布门禁

- `pnpm build:web` 在 Vite 构建后自动运行 `scripts/verify-web-build.mjs`。
- 构建检查会拒绝缺少 Vue `#app` 挂载点、module 入口、JS、CSS、文件缺失或零字节资源的产物。
- `pnpm verify:production:web` 会重新读取公网 `index.html`，逐项请求其中全部 JS/CSS，并检查 Content-Type。
- 公网检查同时要求未登录 `/api/v1/session` 返回 401，Worker `/healthz` 返回 200 JSON。

### Browser 基线状态

尝试连接用户指定的 `https://rag.coylin.com/knowledge` 标签页时，Browser 返回已保存的站点权限拒绝。按照浏览器安全约束，本轮没有切换浏览器、使用底层调试协议或以其他方式绕过。该阻塞不会影响构建与公网资源检查，但以下内容仍不能声明为已验收：

- 页面真实渲染与视觉布局。
- 浏览器 Console 健康状态。
- 登录后知识库交互。
- 桌面和移动端截图对比。

重启 Codex 后再次检查，确认不是全局权限未开启：

- `C:\Users\linzy\.codex\browser\config.toml` 已允许 `https://rag.coylin.com`，并开启完整 CDP。
- 当前任务对应的会话配置 `C:\Users\linzy\.codex\browser\sessions\019f5b3c-3072-77e0-a2a1-04c3dc947d18.toml` 仍在 `[origins].denied` 中保存了 `https://rag.coylin.com`。
- 会话级拒绝覆盖全局允许，因此 Browser 页面访问和 CDP 都继续被安全策略拒绝。
- 按照 Browser 安全约束，调试过程没有直接修改该拒绝项，也没有切换到其他浏览器或使用原始 CDP 绕过。

## 2026-08-03 浏览器持续回归记录（只读）

本轮按“模拟用户使用”的方式检查已登录管理后台，只做浏览、点击、切换视口、读取请求和 Console；不修改代码、不创建或删除知识库内容、不创建或撤销 Token、不部署服务器。问题先记录，后续再单独确认修复范围。

### 覆盖流程

- 登录后依次打开 `/knowledge`、`/search`、`/proposals`、`/tokens`、`/jobs`。
- 在移动视口打开和关闭导航抽屉，切换检索、任务、审核筛选，复制 MCP Endpoint。
- 在桌面视口检查侧栏、知识库编辑区域、表格和空状态。
- 观察页面截图、DOM、网络响应和 Browser Console。

### 已确认问题

#### P1：首屏路由可能重复请求业务 API

初始状态为 `loading=false、initialized=false` 时，`AppShell` 会先挂载 `RouterView`；会话初始化开始后又切换到 loading，完成后再次挂载页面组件，导致页面 `onMounted()` 重复执行。此前在 `/proposals` 观察到同一 `documentURL` 和 `loaderId` 下出现两次 `GET /api/v1/proposals`。

待处理位置：`src/web/components/AppShell.vue:88` 与 `src/web/stores/app.ts:24`。

#### P1：初始化失败没有明确的恢复入口

非 401 初始化失败目前只显示 Toast；`initialized` 仍为 false，页面没有稳定的错误状态和重试按钮，后续路由变化可能再次触发初始化。应补充可见的失败状态、重试动作和会话过期跳转。

待处理位置：`src/web/App.vue:17`、`src/web/components/AppShell.vue:88`、`src/web/stores/app.ts:24`。

#### P2：设置按钮无实际行为

左侧栏齿轮按钮点击后只有 active/focus 状态，没有弹层、路由或反馈。应实现只读运行信息面板，或移除该控件，不能保留无效按钮。

待处理位置：`src/web/components/AppShell.vue:72`。

#### P2：审核和任务首屏请求较慢

移动端 `/proposals` 和 `/jobs` 首次请求约 5 至 6 秒后进入空状态，最终 HTTP 均为 200，Console 没有错误。暂记为性能观察项，后续需要 Worker、D1 和队列耗时数据才能判断瓶颈。

### 当前未发现

- 未复现白屏；HTML、入口 JS/CSS 和 Worker health 均返回正常。
- 未发现新的 Browser Console error/warn。
- 未发现 390px 视口横向溢出；Token、检索、任务和审核卡片可以滚动查看。

### 验证记录

- `pnpm typecheck`：通过。
- `pnpm build:web`：通过，构建检查确认 11 个资源。
- `pnpm verify:production:web`：通过，公网 HTML/资源正常，未登录 session 为 401，Worker health 为 200。
- `pnpm test`：38/38 通过；Cloudflare 本地测试仅有 Vectorize 不支持本地开发和依赖 sourcemap 的既有警告。
- `pnpm test:web`：7/7 通过。

### 后续只读回归

1. 在桌面与 `390x844` 移动视口各重复三轮导航和刷新，统计重复请求与加载时间。
2. 对每个主要页面记录 DOM 首屏、Console、水平滚动宽度和关键按钮状态。
3. 只把可稳定复现的问题追加到本节；修复和部署另开明确授权步骤。

## 2026-08-03 实际 CRUD 与回归证据

### 临时数据范围

为模拟真实管理员操作，创建了以下隔离数据，名称均带 `[QA]`：

- 知识库：`[QA] 临时知识库 20260803153212`，ID `3d9f6ada-1d5d-4fd1-bb08-834cdb3674ed`。
- 文档：`[QA] CRUD 流程验证`，ID `20e78898-8e05-4d44-9121-18feaa49d70d`。
- Token：`[QA] 临时 Token`，只授权上述临时知识库的 `knowledge:read`，创建后验证一次性展示和复制，随后已撤销；没有记录或输出完整 Token。

### 已完成的真实操作

1. 创建知识库并确认侧栏数量从 1 变为 2。
2. 创建 Markdown 文档，等待约 7 秒后进入页面；初始索引任务为排队状态。
3. 编辑正文并保存，版本从 v1 变为 v2；等待索引完成后 `当前版本=2、已索引版本=2`。
4. 打开版本记录，恢复 v1；系统生成 v3，恢复后的正文和索引均为 v3。
5. 删除临时文档并确认侧栏文档数回到 0；对应 v1、v2、v3 索引任务和 v- 清理任务均显示“已完成”。
6. 创建、复制和撤销临时 Token；Token 页面恢复为 0 个有效凭证，临时 Token 仅保留为已撤销历史记录。
7. 使用检索页查询“临时”，返回 0 条可引用片段；切换“全部”筛选可正常取消和恢复知识库勾选。
8. 审核页切换“全部/待审核”，任务页切换“失败/全部”，空状态和筛选状态均正常。

### 阻塞与缺陷

- 产品没有删除知识库的按钮，也没有 `DELETE /api/v1/collections/:collectionId` 路由；因此文档和 Token 已清理，但上述空的临时知识库仍保留。不能通过后门直接删除，否则不再是人类流程测试。
- 设置齿轮点击后 URL 不变、`dialog` 数量仍为 0、DOM 没有反馈，确认是无效控件。
- 在同一页面加载器下，`/proposals` 连续 3 次刷新均观察到 2 次相同的 `GET /api/v1/proposals`；`/jobs` 首屏也观察到 2 次 `GET /api/v1/jobs`。本轮未修改代码。
- 创建文档和索引过程体感约 5 至 7 秒；最终任务全部完成，暂记为性能观察项。

### 移动端证据

在 `390x844` 视口打开 `/search`、`/proposals`、`/tokens`、`/jobs`：

- `document.documentElement.scrollWidth` 分别为 375、390、375、375，均不超过 `innerWidth=390`。
- 每页 DOM 有完整标题和主要控件；Console 没有新的 error/warn。
- 知识库移动导航抽屉可打开和关闭；空知识库的“编辑/预览/信息”工具按预期禁用。

### 桌面与最终验证

- 默认桌面视口 `1280x720` 下 `/knowledge`、`/search`、`/proposals`、`/tokens`、`/jobs` 均有完整首屏，`scrollWidth=1280`，Console 无新的 error/warn。
- `pnpm typecheck`：通过。
- `pnpm test:web`：7/7 通过。
- `pnpm test`：38/38 通过；既有 Vectorize 本地限制和 SDK sourcemap 警告仍存在，但没有失败测试。
- `pnpm verify:production:web`：通过，公网 11 个资源全部正常，未登录 session 为 401，Worker health 为 200。
- 用户明确改为只测试后，本轮只做浏览器操作、测试和 `tech.md` 记录；没有修改源代码、没有部署。此前仅做过一次只读 SSH 连通性探测，远端在 SSH 握手阶段关闭连接，未执行任何服务器变更命令。

## 2026-08-04 缺陷修复与本地回归

### 修改边界

- 修改前已创建 Git 快照 `1842b45 chore: save production QA baseline`。
- 本节记录的是本地代码与本地 Worker 验证；没有部署 Cloudflare Worker，也没有更新香港服务器前端。
- `output/` 为 Playwright、截图和临时调试产物，已整体加入 `.gitignore`，不进入产品提交。

### 已完成修复

1. 业务路由只在会话和知识库初始化完成后挂载，避免 `/proposals`、`/jobs` 等页面在初始化前后重复挂载并重复请求。
2. 初始化失败改为常驻错误页，提供“重新连接”；401 会回到登录页并保留原始跳转地址。
3. 设置齿轮打开只读“工作区信息”弹窗，展示管理员、连接状态、知识库数量和 MCP Endpoint。
4. 增加知识库删除入口与完整名称二次确认；只有管理员可以删除。
5. 新增 `DELETE /api/v1/collections/:collectionId`：有当前文档、有效 Token 或待审核提案时返回 409；可删除时清理 R2、Vectorize、FTS、D1 关系数据并写入 `collection.delete` 审计记录。
6. 新增迁移 `0004_collection_delete.sql`，允许删除知识库时级联移除最后一名管理员，同时继续阻止日常成员操作移除最后一名管理员。
7. 移动端 E2E 改为按 `aria-expanded` 判断文档抽屉状态，并在断言预览内容前显式切换“预览”；测试不再假设持久化数据库为空。

### 验证结果

- `pnpm test:e2e`：桌面 Chromium 与 `375x812` 移动端均通过，2/2；覆盖登录、创建知识库和 Markdown、编辑保存、版本、检索、Token、MCP 提案、人工审核与审核后检索闭环。
- `pnpm typecheck`：通过。
- `pnpm test:web`：12/12 通过；其中设置弹窗、初始化错误/重试、单次 `/proposals` 请求、移动抽屉与删除名称确认均有断言。
- `pnpm test`：39/39 通过；知识库删除覆盖不存在资源 404、无权限、非空、有效 Token 阻塞、R2 清理、D1 级联与审计记录。
- `pnpm build:web`：通过；`verify:web-build` 验证 `index.html` 与 11 个引用资源。
- 本地 Worker 仍会提示 Vectorize/AI binding 不支持纯本地模式以及依赖 sourcemap 缺失；本轮没有由这些提示引起的失败测试。

### Browser 与线上对照边界

- 应用内 Browser 对 `http://127.0.0.1:5173` 仍命中当前任务保存的 origin 拒绝规则。遵守安全约束，没有改用 `localhost`、其他浏览器或原始 CDP 绕过。
- 因此本轮可见交互证据来自仓库 Playwright 的真实 Chromium 桌面/移动端回归，设置、删除与请求去重另由组件/API 测试交叉验证；没有新增应用内 Browser 截图和 Console 记录。
- 线上 `rag.coylin.com` 仍是未部署的旧版本，本节修复不能视为生产已生效；部署前仍需远端迁移、Worker/前端发布和公网复验。
