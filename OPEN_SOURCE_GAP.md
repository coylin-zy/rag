# Knowledge Core 与开源 Agent 知识库对比

> 调研日期：2026-08-10<br>
> 范围：GitHub 项目 README、公开架构与功能说明；这不是源码安全审计，也不比较 Star 数。

> 状态更新（2026-08-23）：版本 Diff/回滚、最高权限 Token 风控、来源时效、批量 Markdown dry-run/apply 和流式 ZIP 导出已经进入当前代码。本文中把这些能力列为“尚未实现”的内容仅代表 2026-08-10 的调研基线；当前剩余缺口是检索评测、完整灾备恢复验证、可中断传输任务和 Git/Obsidian 同步。

## 1. 先说结论

Knowledge Core 已经不是普通的“文档问答 RAG”，而是一个轻量、私有、Agent-first 的 Markdown 知识服务：人通过网页治理内容，Agent 通过 MCP 搜索、读取、提交提案；受信任 Agent 还可以使用受保护的最高权限 Token CRUD 知识库。

它目前最接近 Cerefox、SwarmVault、sage-wiki 和 second-brain。我们的优势是 Cloudflare 原生、部署轻、权限边界清楚、Markdown/R2 版本与删除保护完整；主要差距不在“再加一个聊天框”，而在知识图谱、事实级来源与时效、矛盾处理、批量摄取/同步、版本治理、运行指标和检索评测。

## 2. 最接近的项目

| 项目 | 公开定位与强项 | Knowledge Core 相比之下 |
| --- | --- | --- |
| [Cerefox](https://github.com/fstamatelopoulos/cerefox) | 面向多 Agent 的共享记忆；Agent 可读写；支持远程/本地 MCP、Postgres + pgvector、内容哈希并发锁和追加式审计 | 我们的 Cloudflare/R2/D1 部署更轻，知识库/成员/Token 范围更明确；Cerefox 的本地部署、跨 Agent 共享记忆产品化和可查询审计更成熟 |
| [SwarmVault](https://github.com/swarmclawai/swarmvault) | local-first Markdown Wiki、知识图谱、混合检索、图浏览、审批 bundle、矛盾检测，多种文档/代码/URL 摄取 | 我们的在线权限、托管存储和管理 API 更适合常驻个人服务；它在本地文件工作流、图构建、矛盾检查和批量摄取上明显领先 |
| [sage-wiki](https://github.com/xoai/sage-wiki) | Agent 与人共同构建的图记忆；19 个 MCP 工具；Obsidian 原生 Markdown；事实级来源、置信度、双时态边和矛盾失效；支持本地模型与自托管 | 我们更小、更直接、运维面更窄；它在关系查询、来源证明、时间事实、冲突治理、Obsidian 和 MCP 工具广度上领先 |
| [second-brain](https://github.com/mshtawythug/second-brain) | Postgres + pgvector 混合搜索和实体图；MCP/CLI；可摄取 Gmail、Slack、Krisp 转录和 Markdown，强调节省 Agent 上下文 | 我们的版本保护、网页治理和 Cloudflare 部署更完整；它在外部连接器、批量摄取、实体图和本地运行方面更强 |

## 3. 相邻但不是同一种产品

- [Mem0](https://github.com/mem0ai/mem0) 和 [Graphiti](https://github.com/getzep/graphiti) 更像可嵌入其他 Agent 产品的“记忆基础设施”。Graphiti 特别强调时序上下文图；它们不是以人工维护 Markdown 知识库为中心。
- [Khoj](https://github.com/khoj-ai/khoj)、[RAGFlow](https://github.com/infiniflow/ragflow) 和 [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) 更偏完整 AI 应用：聊天、Agent、模型/文档流水线和多数据源。它们覆盖面更大，但不是我们现在需要复制的轻量“Agent 大脑接口”。

因此不应把“有没有内置聊天页面、模型选择器、工作流市场”当作 Knowledge Core 的核心缺陷。Codex 等 Agent 已经负责推理和回答，本系统应把精力放在可靠知识、权限、来源和检索质量上。

## 4. Knowledge Core 已有的优势

1. **轻量托管架构**：一个 Worker 承载管理 API、MCP、Queue Consumer 和 Cron；R2、D1、Vectorize、Queues 都是托管资源。
2. **Markdown 是事实来源**：R2 保存当前正文和不可变历史版本，D1 只保存元数据、权限、FTS、任务和审计。
3. **权限边界比多数个人项目细**：人员有 Viewer/Editor/Admin；普通 MCP Token 按知识库和 Scope 授权。
4. **两级 Agent 写入**：普通 Agent 走人工审核提案；受信任 Agent 用 `knowledge:admin` 直接 CRUD，但不能管理 Token、成员或账号。
5. **写入保护**：文档和集合更新有乐观锁；删除要求当前版本及精确名称/标题，并保留非空集合、活动 Token、待审核提案等阻断条件。
6. **可追溯性**：Agent 写入记录 `mcp:<tokenId>` 作者和 `actor_type=token` 审计；服务端只存 Token 哈希。
7. **混合检索闭环**：D1 FTS + Vectorize + RRF + 可选 Rerank，结果返回版本和 `kb://` 来源 URI。
8. **清晰的产品边界**：不重复实现 Agent 已经具备的聊天和回答生成能力。

## 5. 主要差距与优先级

### P0：先把“可长期信任”做扎实

| 缺口 | 为什么优先 | 建议最小实现 |
| --- | --- | --- |
| 检索评测与回归基线 | 现在能搜索，但不能量化“改模型/切块后是否变好” | 建 30–50 个真实问题、期望文档/片段、Recall@K/MRR 和引用正确率；每次改索引策略自动跑 |
| 版本归档和保留策略 | Diff/回滚已经实现，但旧版本保留多久仍没有策略 | 增加文档归档状态、按数量/时间清理策略和恢复演练 |
| Token 异常告警 | 用量、限速、IP 网段审计和一键撤销已经实现，但还没有主动告警 | 为异常写入、连续失败和网段变化增加通知策略 |
| 完整可恢复传输 | 多文件导入和 ZIP 导出 V1 已实现，但还不是可暂停、可恢复、可验证的灾备任务 | 增加持久 transfer job、恢复元数据、空夹具恢复验证和 Git/Obsidian 同步 |

### P1：提高知识完整性

| 缺口 | 可借鉴项目 | 建议路径 |
| --- | --- | --- |
| 事实级 provenance | sage-wiki、SwarmVault | 在文档来源之外，为派生事实保存来源文档、版本、段落、提取方式和置信度 |
| 矛盾检测与失效 | sage-wiki、SwarmVault | 新事实不直接覆盖旧事实；生成冲突候选，人工确认后标记 superseded/invalid |
| 时间知识 | Graphiti、sage-wiki | 区分“事实何时成立”和“系统何时知道”，支持 `as_of` 查询；先用于项目状态和基础设施变更 |
| 轻量知识图谱 | sage-wiki、SwarmVault、second-brain | 从文档显式链接和少量实体/关系开始，不先上复杂图数据库；图边必须能回到 Markdown 来源 |

### P2：扩大摄取和使用方式

- Obsidian/文件夹/Git 同步，支持 local-first 审阅和离线副本。
- Gmail、日历、聊天记录、代码仓库等连接器；每个连接器必须有来源、去重和撤回机制。
- 本地或单机部署选项，供不希望依赖 Cloudflare 的场景使用。
- 图浏览、关系查询、上下文包和跨知识库 federation。

## 6. 不建议现在照搬的能力

- 内置聊天、模型供应商市场或“全能 Agent”页面。
- 第一版就支持 PDF、Office、OCR、网页爬虫和几十个连接器。
- 自动把 Agent 的每次观察写成正式知识。
- 没有来源和评测的自动知识图谱。
- 为追求功能数量把最高权限 Token 扩展到账号、成员或 Token 管理。

这些能力会快速增加维护面，却不会先解决个人知识库最重要的可靠性问题。

## 7. 建议路线

1. **当前版本**：通过 CI 验证导入幂等、流式 ZIP、复核版本一致性和既有安全回归，再部署当前修复。
2. **下一小版本**：建立固定检索评测集，并补可中断 transfer job 与空夹具备份恢复验证。
3. **随后**：测当前 FTS/Vectorize/RRF，再决定是否调整模型和切块。
4. **图能力试验**：只选“项目、人员、服务、决定、依赖”少量实体；所有关系必须带来源和有效期。
5. **验证有效后**：再做 Obsidian 同步和外部连接器，不把连接器原文未经审核地直接发布。

最高权限 Token 补上了我们相对 Cerefox 的“受信任 Agent 直接维护知识”缺口，但它不是终点。下一阶段最值得做的不是继续增加 CRUD 工具，而是让每条知识更容易证明来源、发现冲突、衡量检索效果并安全回滚。
