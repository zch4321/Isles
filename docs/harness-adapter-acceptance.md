# Harness 适配层实施与验收

> 日期：2026-10-03 · 状态：适配层已完成；128 项测试、13 项浏览器测试和两套真实 Codex 回归通过。
>
> 本记录只描述本轮抽出适配层的范围与证据，不改写历史验收结论，不宣称 Kimi 或其他新 harness 已接入。

## 1. 本轮决策与范围

用户重新考虑 Claude Code 的闭源执行核心，Claude Code / Claude Agent SDK 接入暂缓。先将现有 Codex 行为完整抽入 harness 适配层，然后再添加新的 harness。当前只注册 Codex；Kimi Code 保留为后续候选，本轮不接入、不在创建页面显示为可用项。

保留现有单用户、本机 Web 的私聊、群聊、MCP 正式发言、即时唤醒、固定原生 session、停止/恢复、Agent/群管理和工作区规则行为。适配层的可扩展性通过独立语义 fake adapter 验证；它不连接第三方产品，也不构成新 harness 的真实验收。

## 2. 模块边界

| 模块                                   | 本轮责任                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/server/src/harness/types.ts`     | `HarnessAdapter`、`HarnessSession`、规范化生命周期/事件/问题与确定拒绝错误。                          |
| `apps/server/src/harness/registry.ts`  | 注册目录、重复 ID 与必需能力检查，按 Agent harness 选择 adapter。                                     |
| `apps/server/src/runtime/runtime.ts`   | 平台输入派发、固定绑定、执行互斥、结果不明、停止/恢复与问题有效性；不发送或解析 Codex RPC。           |
| `apps/server/src/runtime/workspace.ts` | 平台 data/shared 目录、MCP token、托管 AGENTS.md 和 redactor。                                        |
| `apps/server/src/codex/`               | app-server 协议与通知转换、原生模型目录/环境、中性初始化、`instructionSources` 验证与子代理问题归属。 |
| `packages/contracts` / Web             | harness 目录、能力与状态契约；动态读取实际注册项及其原生模型/等级。                                   |

`connect()` 在等待初始化之前发布可关闭的 session，确保启动途中停止与应用关闭也可释放所属进程。`createSession(onCreated)` 先保存原生 ID，再完成中性初始化和规则校验；恢复必须保持原绑定。Codex 的 `thread/inject_items` 与 `instructionSources` 只存在于 Codex adapter 的实现路径，不是所有 harness 的通用要求。

注册必须具备 `sessionResume`、`mcp` 和 `workspaceInstructions`；`interrupt`、`userQuestions`、`nativeSubagents` 可以声明差异。没有 interrupt 的 adapter 仍须在停止时关闭所属进程并保持持久停止状态。`HarnessSubmissionRejected` 仅表示确定拒绝，超时、断连或其他提交错误保留结果不明，不能自动重复执行。

## 3. API、绑定与数据边界

- `GET /api/harnesses` 返回已注册目录；当前默认只返回 Codex。
- `GET /api/harnesses/:id/status` 与 `/models` 查询所选 adapter 的实际状态和模型配置。旧 Codex 状态/模型路由删除，不保留兼容别名。
- `GET/PUT /api/codex/config` 继续保存 Codex executable 路径；更新与检测失效对应发现/模型缓存，不打断已有原生进程。
- 创建 Agent 必传已注册 `harness`；编辑不能替换 harness。Web 不预设尚未接入的候选或模型。
- API/存储保留 `threadId` 命名，含义是 adapter 返回的不透明原生 session ID。绑定唯一性按 `(harness, nativeHome, threadId)` 限定，不能按 session ID 全局路由事件。
- 本轮只更新当前 schema 的全新基线，不新增旧 schema 检测、旧数据迁移或兼容代码。不清理、不自动搬移已有 Codex 数据；旧版本数据政策见 [需求](requirements.md#12-首次发布前的数据政策)。

## 4. 验收证据

| 证据层                                            | 结果                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 独立语义 fake adapter                             | 8 项通过，直接实现语义接口，无 Codex RPC 或 MockHarness 依赖。                                           |
| 注册与跨 harness 隔离                             | 未知/重复/缺能力拒绝，锁释放，模型隔离；两个 adapter 以相同 nativeHome/session ID 独立绑定、派发与恢复。 |
| Codex adapter                                     | 6 项通过：创建/恢复/提交/取消/问答转换、ID 先保存、中性初始化、加载校验、安全字段、脱敏与初始化前关闭。  |
| `pnpm check`                                      | 格式、ESLint、类型检查、128 项测试与生产构建通过；设置 `ISLES_TEST_CODEX_BIN`，协议生成测试未跳过。      |
| `ISLES_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e` | 13 项 Chrome 测试通过，最终运行 44.2 秒。                                                                |
| `pnpm db:generate` + 独立 `ISLES_CONFIG_FILE`     | 当前 schema 与基线 snapshot 一致，无增量迁移生成。                                                       |
| `pnpm db:migrate` + 同一独立配置                  | 仅初始化临时目录的当前基线，不操作用户数据库。                                                           |
| 真实 Codex                                        | 两套最终源码的原生验收通过，CLI 为 `codex-cli 0.160.0`；报告见下文。                                     |

语义测试覆盖固定 ID 恢复、创建后初始化失败仍保留绑定、能力限制、主/子代理问题归属、旧连接回调过滤、停止/关闭、确定拒绝与结果不明，以及恢复后不重投。原生协议测试额外使用真实临时 Node 进程保持握手未完成，验证 session 在初始化前已发布且可以关闭；它不调用真实模型。

复核并修复了一个停止竞态：submit 确认尚未返回时停止 Agent，原生 interrupt 期间较晚到达的 failed 完成事件会覆盖停止状态。确定性测试先复现，再验证事件入口忽略已结束 run 后，Agent 保持 stopped、错误保持清空、run 保持 interrupted、投递保持 cancelled；迟到 item 也不能改写终态执行记录。

浏览器在既有 12 条流程外新增目录/缓存切换验证。浏览器夹具临时展示第二个语义 harness，来回切换后模型/推理等级与 Codex 专用设置正确对应；后端仍只注册 Codex，未知项 POST 被明确拒绝，没有误建 Codex Agent。创建测试助手按返回的 Agent ID 等待真实 ready/thread 绑定，避免先前页面的可用状态被误当成新建完成。此模拟项不进入生产目录。

所有自动化均使用临时配置、data 与 workspace；数据库检查目录为 `C:\Users\15384\AppData\Local\Temp\isles-harness-db-efd0e676ef7b4ebcad7b44618688e708`。新基线不自动改变已存在数据库的约束，未清理用户数据，也未加入迁移或兼容分支。

### 4.1 真实配置、工作区与 Agent 管理

命令：`pnpm --filter @isles/server exec tsx test/verify-native-config.ts`。

最终成功报告：`C:\Users\15384\AppData\Local\Temp\isles-native-config-BnGnr9\report.json`；北京时间 22:21:38–22:23:18。

两位真实 Agent 在外部个人工作区原生加载 AGENTS.md，通过 MCP 交接共享文件；应用重启后恢复同一 thread，原路径与共享文件保留。随后修改读者名称/模型/等级/权限，下一轮采用 `gpt-6-luna / xhigh`，保留原 thread 和 workspace；运行中删除后中断原生 turn、退出群、MCP 身份失效并保留历史/文件。再次重启仅恢复存活 Agent，已删除身份仍只读。配置 API 更新 TOML 保留目录字段，用户 Codex 配置 SHA-256 前后一致。

写者 thread：`01a10224-5cfe-7103-aae4-e23e6ad103bd`；已删除读者：`01a10224-5ce3-7400-ba3d-0db1b26345f3`。

### 4.2 真实名称寻址与群聊删除

命令：`pnpm --filter @isles/server exec tsx test/verify-native-names.ts`。

最终成功报告：`C:\Users\15384\AppData\Local\Temp\isles-native-names-nrYUqa\report.json`；北京时间 22:21:38–22:22:27。

同名 Agent/群通过完整目录 ID 正确完成历史读取、同频道回复与提及，自动输入仍使用名称标签。读者 turn 被接受后删除来源群，群目录与 MCP 访问失效、本群投递取消，读者仍在同一原生 turn 完成私聊回复。应用重启恢复同一 thread、保留删除标记和人类只读历史，另一位保持停止，剩余群可读取；用户 Codex 配置保持一致。

读者 thread：`01a10224-5d6d-7153-a051-bddd0daaa761`；停止同伴：`01a10224-5d6d-7fd3-870a-804725f6fd9a`。

本轮未重新执行真实上下文压缩。原生规则压缩后的历史证据见 [基础修复验收](foundation-repair-plan.md#8-验收记录)，不能将本轮启动/恢复验证扩大为压缩验收。

## 5. 尚未完成的支持

Kimi Code、Claude Code / Claude Agent SDK 及其他新 harness 均未通过本轮接入或真实验收。fake adapter 不出现在默认产品注册目录中。后续接入需要独立核对版本、认证/配置、模型目录、session 恢复、原生规则入口、MCP、问题与停止能力，并完成真实混合协作验证。

本轮不改变现有执行权限和平台授权规则，不新增旧版本兼容路径。Claude 暂缓方向是否恢复由用户后续决定。
