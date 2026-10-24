# Isles 实现计划

> 版本：0.25 · 日期：2026-10-24 · 状态：五种 harness 升级及统一原生活动模型已完成验收
>
> [需求](requirements.md)与[架构](architecture.md)已形成基线。本文的阶段用于组织产品开发，不要求产品里的 agent 按固定流水线工作。

## 1. 已确定的方向

- 采用已讨论的 Vue 3、Vite、TypeScript、shadcn-vue、Tailwind CSS、Fastify、SQLite/Drizzle 和 pnpm workspace。
- 以官方原生接口为主；通用 harness 适配层已完成；当前注册 Codex、Claude CLI、Kimi Code（本地 Web）、OpenCode 与 DSH，按能力配置 steer。
- Codex 是主要接入，首先用它跑通 Agent、固定 session、私聊和多 Agent 协作。
- 2026-10-08 新增通用 ACP adapter，Kimi Code 为首个 ACP harness；新增 harness 复用业务层与 Runtime，通过 adapter 表达能力差异。
- 2026-10-09 完成私聊、群聊及保留历史的 Markdown 导出，按已确认格式保存全部正式消息与系统消息，保持回复、提及和原消息编号。范围、实现及验证见 [聊天导出](chat-export-design.md)。
- 五种 harness 按原生口径报告当前上下文用量；2026-10-12 调整为没有活动执行时可新建会话，取消既有待投递，保留记录、群关系、工作文件和停止意愿。Agent 与群聊列表提供多选批量删除、确认名单和失败项重试。上下文实现与分层验证见 [上下文管理](agent-context.md)。
- 2026-10-15 创建 Agent 支持默认数量 1 的批量创建，名称作为前缀由服务端递增编号，共用配置、独立身份和上下文。
- 2026-10-03 用户曾暂缓 Claude，2026-10-08 已恢复并授权本机 CLI 接入；新增 ClaudeAdapter，创建时发送中性用户消息使 session 落盘。第三方 Claude ACP 留待后续，可复用 ACP adapter；DSH 已于 2026-10-09 获授权以原生 SDK 桥接接入。
- M0 已完成。M1 链路验收及 AGENTS.md 原生加载、真实压缩和恢复的补充验收已通过，最新证据见 [基础修复计划](foundation-repair-plan.md)。原 [实施计划](m1-implementation-plan.md)和[验收记录](m1-acceptance.md)保留为历史事实。
- M2 规则于 2026-09-30 确认，2026-10-02 调整为即时唤醒与 MCP 主动收信；任务与验收标准见 [M2 实施计划](m2-implementation-plan.md)。
- 产品中的 AI 参与者统一称为 **Agent**（M1 文档中的“对象”）；M1 实施计划和验收记录作为历史记录保留原用词。
- 2026-10-02 完成基础纠偏：稳定规则由每个 Agent 工作目录的 AGENTS.md 经 harness 原生加载；模型消息采用简洁文本，以频道内递增序号定位。当时的 M2 备份迁移和原生 thread 保留属于历史验收事实。
- 2026-10-03 用户确认：配置默认 `~/.Isles/config.toml`，平台数据默认 `~/.Isles/data`，工作区默认 `~/.Isles/workspace`；相对路径从配置文件目录解析。保留 Codex 路径 UI 与环境覆盖，增加共享目录绝对路径规则。
- 2026-10-08 用户确认：服务日志使用 Fastify 内置 pino，同时输出到终端和 `~/.Isles/logs`；按天分文件，保留 7 天、总量不超过 100 MB；等级由 `[log].level` 配置，原生 stderr 脱敏后按 `debug` 记录。
- 2026-10-03 消息头部采用名称优先：JSON 引号群名、`agent:"名称"` 和提及名，精确重名用引号外 ID 短前缀消歧，私聊为 `private`。工具通过目录取得完整 UUID，MCP 发送确认仅返回序号；内部 ID、REST 与 schema 不变。当前范围和验证见 [名称消息验收](name-message-acceptance.md)。
- 在用户明确宣布首个 release 前不实现向后兼容、旧数据迁移或兼容性代码；阻碍启动的旧库可直接清理或覆盖并按全新基线重建，无需保留旧数据或要求用户切换配置。操作前停止旧服务并核验 Isles 数据范围；旧 JSON 配置和旧数据库转换不再支持。

- 2026-10-03 补齐群聊删除与只读历史：成员退出、取消本群投递、撤销 Agent 访问，保留消息、执行关联及文件，成员原生 turn 与其他频道继续可用。删除标记使用永久保留的 `group_deleted` 事件，不增加数据库结构或旧版兼容；见 [群聊管理验收](group-management-acceptance.md)。

## 2. 阶段总览

| 阶段                     | 交付结果                                                                   | 状态                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| M0 工程初始化            | 可启动的 Web/API、共享协议、SQLite/Drizzle、检查和构建入口。               | 已完成并验证。                                                                                                  |
| M1 Codex 单 Agent 闭环   | 用户创建 Agent，私聊、观察执行、回答原生问题、停止并恢复同一 session。     | 链路及基础规则加载、压缩与恢复补充验收通过。                                                                    |
| 基础修复                 | AGENTS.md 原生加载、简洁文本协议、频道序号、压缩和恢复验证。               | 历史验收已通过；当时的旧库迁移现已撤销。                                                                        |
| M2 Codex 群聊协作        | 多个独立 Codex Agent 通过 MCP 参与群聊，权限与消息投递一致。               | 自动化与两个真实 Agent 的重新验收通过。                                                                         |
| 配置与目录拆分           | TOML 配置、数据与工作区分离、共享目录规则、当前 schema 全新基线。          | 89 项测试、7 项浏览器测试与真实 Codex 验证通过；见 [验收记录](config-workspace-acceptance.md)。                 |
| Agent 基础管理           | 编辑名称/模型/推理等级/权限，保留历史和文件的删除与只读历史入口。          | 105 项测试、10 项浏览器测试与真实 Codex 修改/删除/重启验证通过；见 [验收记录](agent-management-acceptance.md)。 |
| 名称消息呈现             | 自动输入、收信与历史共用安全名称标签；目录保留完整 ID 寻址，更新持久规则。 | 108 项测试、10 项浏览器测试与真实 Codex 同名寻址/重启验证通过；见 [验收记录](name-message-acceptance.md)。      |
| 群聊基础管理             | 创建/查询/改名/成员管理及保留历史的删除，成员继续使用同一 session。        | 本轮检查与真实 Codex 验证见 [群聊管理验收](group-management-acceptance.md)。                                    |
| Harness 适配层           | 通用契约、注册目录、规范化生命周期与事件；完整抽出既有 Codex 行为。        | 128 项测试、13 项浏览器测试与两套真实 Codex 回归通过，见 [独立验收](harness-adapter-acceptance.md)。            |
| Agent 实时收信开关       | 默认关闭的 steer 偏好、同 turn 追加、批次结算与 Web 创建/编辑入口。        | 实现完成；完整检查、浏览器与真实原生证据待汇总，见 [Steer 投递验收](steer-delivery-acceptance.md)。             |
| M3 Kimi Code（本地 Web） | Kimi 原生 Web adapter、steer、子代理进度与固定 session 协作。              | 协议与浏览器回归、本机无模型协议验证见 [记录](kimi-web-acceptance.md)；此前 ACP 验收保留。                      |
| M4 Claude CLI 接入       | 独立 adapter、固定 session、MCP、原生问答与 Codex 混合协作。               | 已接入；自动化和真实原生验收见 [记录](claude-cli-acceptance.md)。                                               |
| M5 完整体验与长期运行    | 完善文件共享、生命周期、历史检索、备份和长时间运行体验。                   | 细分范围待讨论。                                                                                                |

消息持久化、权限检查、停止和恢复从相应功能的第一阶段就实现；M5 扩展故障覆盖和体验，不用于推迟基础正确性。

统一协议与规则文件、原生加载、真实压缩与恢复及 M2 重新验收的历史结果见 [基础修复验收记录](foundation-repair-plan.md#8-验收记录)，其中的旧库迁移已按首发前政策移除。TOML、数据/工作区拆分及共享目录规则已实现并通过 [独立验收](config-workspace-acceptance.md)。按用户要求，Agent 编辑和删除从 M5 提前完成，见 [基础管理验收](agent-management-acceptance.md)。适配层已完成，当前注册 Codex、Claude CLI、Kimi Code、OpenCode 与 DSH；五种 harness 均支持默认关闭的 steer、忙碌排队和主动收信。

配置与目录拆分的验收覆盖优先级、路径解析、数据库/token 位置、Codex 发现及错误、UI 保存与实时检测、工作区稳定性、共享目录和原生规则加载。当前结果为 89 项测试、7 项浏览器测试与两个真实 Codex Agent 的读写/重启验证通过。旧目录清理仍有进程占用及工具审批限制，具体边界见 [验收记录](config-workspace-acceptance.md#4-旧目录清理遗留项)。

当前五种 harness 已接入固定 session、私聊/群聊、MCP、原生问题和权限管理。2026-10-24 按最新版本更新 adapter，并采用统一原生活动模型；完整检查、浏览器回归与原生复验正在进行，见 [本轮升级记录](harness-upgrade-2026-10-24.md)。既有阶段的自动化与真实账户验收继续保留历史结果。

### 2.1 2026-10-24：版本升级与统一原生活动模型

- 基线为 Codex `0.164.0`、Claude `2.1.310`、Kimi `2.3.1`、OpenCode `2.1.4` 与用户指定的 DSH `0.2.1-rc.3`；通用 ACP 保持官方 v1 Latest。
- 保留状态显示；每个原生阶段独立 run，持续记录后台、自主和异步子代理，无 Isles 输入时 `inputs=[]`。
- 投递与活动完成独立。确切消费标记 `accepted`（已送达），运行结束与停止保留送达事实；迟到 ACK 只订正仍绑定原尝试的消费记录。
- steer 按实际消费活动归属；固定主 session、停止意愿和原 session 恢复保持。
- 原生测试使用隔离 home、本地 provider 与临时 Isles 数据；DSH/Kimi 协议验证零推理，其余使用本地模拟推理。
- 完整 `pnpm check` 通过（569 项测试、1 项平台跳过），Chrome 浏览器 44 项通过，五种新版 CLI 本地验证完成；结果汇总在 [本轮升级记录](harness-upgrade-2026-10-24.md)。

## 3. M0：工程初始化

本轮范围：

- 建立 `apps/web`、`apps/server`、`packages/contracts` 工作区。
- 配置严格 TypeScript、ESLint、Prettier、Vitest 和 Playwright。
- 使用 Vue 3 和 Tailwind CSS 搭建工作空间空态页，引入 shadcn-vue Button。
- Web 通过真实 API 展示连接状态，连接失败时可重试。
- Fastify 提供 `/api/health`，检查实际 SQLite 连接；生产构建可由同一后端提供静态页面。
- 建立 Drizzle 数据库连接、WAL、外键检查和迁移入口，暂不创建业务表。
- M0 当时的数据目录默认位于仓库下的 `.isles/`；2026-10-03 起默认数据与工作区改为用户主目录下的独立目录，配置见 README。接口仅监听本机地址。
- 提供开发、检查、构建和启动说明；固定依赖版本并保留锁文件。

验收：从依赖安装启动，Web 能确认后端和数据库可用；格式、静态检查、类型检查、服务测试、生产构建及浏览器基本流程通过。

本轮不启动任何原生 harness，不读取其登录凭据，也不调用模型。页面中不展示伪造的 Agent 或对话。

本轮验收记录：在 macOS arm64、Node.js 26.8.2、pnpm 12.4.1 环境下，依赖安装、ESLint、类型检查、3 项服务测试、生产构建、数据库生成/迁移入口均通过；2 项 Chromium 浏览器测试通过，覆盖连接成功及断线后的手动重试。已检查桌面与窄屏截图，生产启动的 HTML、静态资源和健康检查也已验证。

## 4. M1：Codex 单 Agent 闭环

建议从最短的真实使用链路展开，再补齐管理页面。

### 4.1 按官方文档直接接入

依据 [Codex app-server 官方文档](https://learn.chatgpt.com/docs/app-server)直接实现 adapter，记录使用的 CLI 版本，并从该版本生成 TypeScript 协议类型或 JSON Schema。接口接入与业务开发同步进行，不单列前置可行性研究或完整协议验证阶段。

先接通持续运行的 stdio JSON-RPC、thread 创建、turn 输入和事件输出，完成一条真实私聊链路，再在同一阶段补齐恢复、停止和原生用户问题回传。

联调聚焦 Isles 自己的要求：消息持续进入同一个 thread，重启恢复准确的原生 ID，停止和用户问题回答作用于正确执行。独立 Agent 的目录与原生状态按官方配置实现，在多 Agent 场景中检查隔离效果。

默认依据文档中的接口语义开发。只有遇到文档缺项、实际行为不符或具体故障，再进行源码调查和针对性测试。恢复失败显式报告、投递结果不明时不盲目重试等产品约束保持不变。

### 4.2 完成用户链路

引入 Agent、session 绑定、私聊、消息、投递尝试、执行记录和必要交互请求的数据模型及迁移。

用户能够：

1. 选择 Codex 配置，创建 Agent。
2. 向 Agent 发送私聊消息，观察等待、执行和结束状态。
3. 阅读正式回复，并在执行详情中查看允许展示的工具活动。
4. 回答原生用户问题与原生执行授权请求；执行默认采用 harness 原生权限，每个 Agent 可切换完整访问。
5. 停止 Agent，重启应用后继续保持停止状态。
6. 显式恢复 Agent，并继续使用同一个原生 session。

所有写入都先持久化；内存队列只负责调度。发送后原生确认丢失时保留“待核对”，不盲目重复执行。

### 4.3 本轮已确认规则

2026-09-30 用户已确认以下规则，详细实施与验收见 [M1 实施计划](m1-implementation-plan.md)。

| 项目           | 已确认行为                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| 正式回复       | 统一由 MCP 发进私聊；原生输出显示在执行详情，不自动转成正式聊天消息。                                            |
| 忙碌时输入     | M1 当时采用持久排队；当前已增加默认关闭的 steer 偏好，见第 6.1 节。                                              |
| Codex 执行权限 | 默认 `workspace-write` + `on-request`，授权个人和共享工作区；完整访问开启时使用 `danger-full-access` + `never`。 |
| 管理入口       | M1 暂不做登录鉴权，只监听本机；MCP 仍绑定 Agent 身份并校验所属私聊。                                             |
| 实现与验收     | 一个活动的 `gpt-6.1-sol / max` 子 agent 实现并自测，主 agent 独立验收。                                          |

未鉴权的管理 HTTP API 不构成人类与本机进程的安全隔离；MCP 不暴露创建 Agent 等管理能力。后续鉴权另行实现。

验收重点：同一 Agent 连续多轮及跨重启后 thread ID 不变；原生问题关联正确；停止后新消息不自动重启；数据库提交与原生确认之间的中断可观察。

2026-09-30 验收通过：主 agent 独立完成格式、lint、类型检查、16 项服务测试、生产构建和 3 项浏览器测试；真实 Codex API/Web 链路验证了 MCP 正式回复、串行排队、运行中停止、同 thread 重启恢复和空 thread 持久化。生产入口及同目录重复启动保护也已验证。原生用户问题与故障注入使用模拟 adapter 验证，详情见 [M1 验收记录](m1-acceptance.md)。以上数量是当时的历史结果。

## 5. M2：Codex 群聊与 MCP

在 M1 基础上增加多个编号 Agent 与群聊，每个 Agent 仍有独立上下文和工作目录。基础修复后的重新验收已通过；详细任务、数据与历史验收见 [M2 实施计划](m2-implementation-plan.md)，最新规则与压缩证据见 [基础修复计划](foundation-repair-plan.md)。

交付范围：

- 用户建群、改名、添加和移除成员、暂停与继续群讨论；配置 Agent 的拉群权限。
- MCP 提供群内和私聊发言、历史查询、所在频道与成员查询、联系人目录；拥有拉群权限的 Agent 额外可建群和邀请已有 Agent。按权限隐藏工具并校验每次调用。普通消息名称优先显示；工具地址仍用目录里的完整 ID 或 `private`，目录及群管理结果保持完整 ID/名称/配置。
- 多频道输入复用每个 Agent 自己的唯一 session，按下表规则立即唤醒并合并剩余未读，支持在当前 turn 内主动收信。
- 群消息、投递状态与 SSE 支持重连和补读。
- 产品中的“对象”统一改称 Agent，界面、文档与代码标识同步修改。

### 5.1 本轮已确认规则

2026-09-30 用户确认 M2 基线；2026-10-02 取消防抖并确认 MCP 收信与读取去重。当前规则如下：

| 项目           | 已确认行为                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唤醒           | 群内任何发言（用户或 Agent）都唤醒除发言者以外的全体成员。`@` 只在群内公开标明“特意对谁说”，不改变唤醒范围；只想与某个 Agent 交流时使用私聊。                         |
| 即时唤醒       | 私聊与群聊均不防抖。空闲 Agent 立即开始 turn；忙碌默认排队，开启且支持 steer 时向当前 turn 追加。未追加的剩余未读在 turn 结束后立即合并，不等待其他 Agent 对齐轮次。  |
| 合并输入       | 一次唤醒只提交一条输入，包含所有频道的未读消息：每个频道最近 10 条未读，加上更早的全部未读 `@` 该 Agent 的消息；已投递的消息不重复发送。不设总条数上限。              |
| 被跳过的未读   | 超出上述范围的未读消息标记为已跳过，不再进入后续输入；输入中注明条数，Agent 可用历史工具读取。私聊中用户的消息都视为对该 Agent 说，不会被跳过。                       |
| 发言           | 正式发言只能通过 MCP；原生输出只在执行详情展示。规则说明只写明“只有你认为需要回复时，才调用 MCP 发送消息”，不额外规定沉默或确认方式。                                 |
| 讨论预算       | 不设自动预算或轮次上限。                                                                                                                                              |
| 暂停群讨论     | 暂停期间消息照常保存，但不自动投递；主动收信和历史读取仍可进行，读到的消息算已接收，继续后只投递剩余未读。暂停不中断正在进行的执行。                                  |
| 主动收信       | 提供立即返回的 `receive_messages`，在当前 turn 内收取未读；与 `read_messages` 共用按消息和接收 Agent 保存的接收记录，只标记实际返回的消息，不提供阻塞等待工具。       |
| Agent 之间私聊 | 本阶段不实现。                                                                                                                                                        |
| 拉群权限       | 一个权限同时覆盖建群和邀请已有 Agent，默认关闭；Agent 不能移除成员，移除由用户操作。服务端校验立即生效，工具列表在 Agent 空闲时重启原生进程并恢复同一 thread 后刷新。 |
| 历史可见范围   | 新成员可以读取群的全部历史，不对入群前消息做保护。被移出后不能再读写该群，未投递的消息取消。                                                                          |
| 数据           | M1 的本地数据不保留，M2 重新生成基线迁移。                                                                                                                            |
| Codex 目录     | 所有 Agent 直接共用用户的 Codex 目录（配置、登录、插件与长期记忆），只要求对话上下文按 Agent 独立；Isles 不复制也不修改用户配置，Agent 的差异在建立会话时按会话设定。 |
| 子代理         | harness 自带的子代理属于 Agent 自身能力，Isles 不禁止，由 Agent 自行决定是否使用；Isles 只向主 thread 投递消息、只恢复主 thread。                                     |

建议第一轮验收使用两个独立 Codex Agent，验证私聊与群聊切换时原生 ID 不变，再测试多群并发输入、暂停和权限撤销。多人类用户、跨机器执行与固定角色系统不进入本阶段。

## 6. Harness 适配层与 Agent 实时收信

适配层阶段已完整提取 Codex 行为，不新增真实 harness。其交付边界如下；本次 steer 增量见第 6.1 节：

- `HarnessAdapter` / `HarnessSession` 规范化目录、创建/恢复、提交、取消、回答/拒绝问题、关闭与事件。Runtime 仅处理平台排队、固定绑定、执行互斥、持久停止及结果不明；Codex RPC、原生通知与 `instructionSources` 不进入通用控制器。
- Codex adapter 封装 app-server、原生模型目录/环境、中性初始化、原生 AGENTS.md 加载验证，保留先保存原生 ID 再初始化的行为。
- `AgentWorkspace` 接管平台 data/shared 目录、MCP token、规则文件与 redactor；原生 executable/home/config 仍归对应 adapter。
- 注册强制要求 `sessionResume`、`mcp`、`workspaceInstructions`，其他能力逐项声明；停止始终关闭所属进程，即使 harness 没有原生 interrupt。
- Web 动态读取 `/api/harnesses` 及所选 harness 的状态/模型目录；只注册和展示 Codex。创建必传 harness，编辑不能替换；Codex 路径设置当时保留在 `/api/codex/config`，2026-10-08 起统一为 `/api/harnesses/:id/config`；移除旧状态/模型路由，不增加兼容别名。
- 保留存储/API 的 `threadId` 命名，其含义为不透明原生 session ID；当前数据库基线以 `(harness, nativeHome, threadId)` 约束绑定，不限定仅 Codex。按首发前政策不增加迁移、旧 schema 检测或兼容代码，不清理或自动搬移现有 Codex 数据。

验收需要三类独立证据：语义 fake adapter 验证平台协议无关的派发、相同 session ID 跨 harness、注册约束、生命周期与确定拒绝/结果不明；Codex 原生协议模拟验证 adapter 转换；完整检查、浏览器流程及真实 Codex 回归验证现有使用链路。创建/恢复期间停止、固定绑定、失效问题、子代理问题关联和关闭清理也须覆盖。适配层阶段的 128 项测试、13 项浏览器测试及两套真实 Codex 回归均通过，结果和边界见 [独立验收](harness-adapter-acceptance.md)；这些历史证据不代替第 6.1 节新增 steer 的验收。

### 6.1 按 Agent 配置 steer（已完成并验收）

- 新增 `capabilities.steer` 与持久 `steerEnabled`，创建默认关闭；支持 harness 也可保持关闭，创建/编辑/详情都可配置。unsupported 禁用开启且 API 独立拒绝，已有开启值仍可关闭。
- 仅修改收信偏好不查模型目录、不重启原生连接，不改 thread。开启时忙碌 queued 输入立即向当前 thread/turn 追加，保留频道、序号、来源、回复和提及；关闭或 unsupported 继续排队到下一轮。
- `steer_batches` 在发出前保存批次与原目标；`steering` 显示“投递中”，确切原生消费后为 `accepted` / “已送达”，关联实际原生活动。MCP 返回记录为 `received`；活动终态单独保存。
- Codex steer 只有 `-32600` / `-32601` / `-32602` 明确拒绝可退回队列到下一 turn；未知错误、超时、断连不自动重投。关闭开关只影响后续输入，已发 RPC 按实际结果结算；停止、暂停群、删除群和移出成员继续分别执行原控制规则。
- `receive_messages` 保持立即返回，稳定 AGENTS.md 描述收信机制。五种已注册 harness 按能力提供默认关闭的 steer；当前版本与运行模型见 [升级记录](harness-upgrade-2026-10-24.md)。
- 首个 release 前仍只更新当前全新 schema 基线，不增加兼容或旧库迁移；验收使用独立临时配置/数据。旧库阻碍默认环境启动时，按用户授权直接清理或覆盖并重建，不要求用户另配数据库；同版本正常重启继续保留数据。

2026-10-04 验收通过：`pnpm check` 的 166 项测试、完整构建、16 项 Chrome 浏览器测试，以及真实 `codex-cli 0.160.0` / `gpt-6.1-sol` 的三来源 steer 验证。私聊、用户群消息与 Agent 群消息均进入原 thread/turn；reader 只有一次 turn/start，无收件箱或历史读取；重启保留开关和原 thread。数据库脚本使用独立配置，确认 10 表新基线无差异并成功初始化。完整证据与边界见 [独立验收](steer-delivery-acceptance.md)。

### 6.2 M3：Kimi Code 本地 Web 与 ACP 接入历史

Kimi 当前使用本地 `kimi web` REST/WebSocket，基线 `2.3.1`，保持固定 session、原生模型与共享登录，支持 steer、问题及子代理活动。2026-10-24 起每个原生阶段独立 run，消费回执关联实际阶段，后台和自主阶段持续记录。当前验证见 [升级记录](harness-upgrade-2026-10-24.md)，此前 Web 接入见 [Kimi Web 验收](kimi-web-acceptance.md)。以下保留 2026-10-08 的 ACP 接入事实。

2026-10-08 用户确认接入 Kimi Code，并先实现通用 ACP adapter，后续采用 ACP 的 agent 只需新增 harness 配置；DSH 的本轮接入采用原生桥接以保留 steer。

- 准备性重构：CLI 路径配置按 harness ID 组织（`[codex]`、`[claude]`、`[kimi]`），路径接口统一为 `/api/harnesses/:id/config`；抽出共享的进程树关闭、目录缓存与 npm CLI 发现。
- `acp/` 实现手写的 ACP v1 客户端、adapter 与模型目录；`kimi/` 提供发现、`KIMI_CODE_HOME`、`yolo` 模式、登录检测与凭据脱敏。
- Kimi 不支持 steer，忙碌排队；不在运行时校验规则加载；MCP token 以请求头写入会话参数。
- 验收：真实 stdio fake 覆盖目录、创建/恢复、事件合并、忙碌重试、确定拒绝与结果不明、问答、权限、中断与退出；应用集成和浏览器流程覆盖注册、路径、私聊、排队与停止恢复；`verify-native-kimi.ts` 对本机 Kimi 2.1.1 验证真实行为。

新增 harness 的真实验收应包含与 Codex 同群完成小任务；不能用 fake adapter 测试代替真实混合协作。结果见 [Kimi Code ACP 验收](kimi-acp-acceptance.md)。

## 7. M4：Claude Code CLI（已接入）

2026-10-08 用户恢复并授权本机 CLI 接入，创建时发送一条中性用户消息解决空 session。通过独立 ClaudeAdapter 复用通用 Runtime、聊天、权限与存储，直接启动本机 CLI 的常驻双向 stream-json。

- 自动发现 CLI，增加独立路径设置及 `[claude]` TOML 配置；复用原生 home、认证、用户配置、插件与记忆。
- 原生初始化响应提供模型和 effort 目录；default effort 沿用原生配置。
- 创建先保存 UUID，发送中性消息并等待内部模型回合成功；工具调用在该阶段被拒绝，结果不生成 Isles 消息或 run。
- CLAUDE.md 原生导入唯一 AGENTS.md，通过 get_context_usage 校验加载文件，并检查 Isles MCP 连接。
- 将 replay/started、result、工具和 AskUserQuestion 转为既有平台事件与问答；只恢复原 UUID，失效问题拒绝，未知结果不重投。
- Claude 支持默认关闭的 steer，批次 UUID 与主线程 replay/started、result 消费列表确认实际原生回合；每回合独立 run，后台和自主事件持续记录。停止取消未消费输入，保持固定 UUID、忙碌排队、主动收信与原生子代理能力。
- preClose 释放原生进程与 MCP 流，随后关闭 HTTP 与数据库，覆盖持久 SSE 连接阻塞退出的回归。

macOS 原生私聊、问答、停止/恢复、改名、Codex/Claude 混合群聊、同 session 服务重启和保留历史删除均已通过；Claude steer 的三来源同执行追加、在途停止与偏好重启持久化也已通过。自动化、浏览器与真实验证分层记录在 [Claude CLI 验收](claude-cli-acceptance.md)。

### 7.1 OpenCode（2026-10-09）

用户确认先集中适配器目录，再接 OpenCode；DSH 在用户 review 后另行接入。

- 既有 Codex、Claude、ACP、Kimi 和共享发现/进程/缓存代码统一放入 `harness/`，通用契约与 Runtime 分工保持。
- 使用本机 OpenCode v2 原生 HTTP/SSE，按 Agent 启动独立 stdio server，复用原生配置和认证数据库。
- 固定 session 无需初始化消息；模型与 variant 来自启动完成后的原生目录。
- 保留忙碌排队、默认关闭的 steer、MCP 主动收信、原生问题、子代理及工作目录规则。
- 原生已提交的 inbox 交付与 execution 事件确认输入归属；覆盖回合结束、在途停止、确定拒绝及结果不明的竞态。
- 自动化、浏览器及真实本机验证分层记录在 [OpenCode 验收](opencode-acceptance.md)。

### 7.2 DeepSeek Harness（2026-10-09）

OpenCode review 后用户授权接入 DSH，并确认复用已登录的桌面版及原生桥接插件方案。

- 适配器位于 `harness/dsh/`，macOS 自动发现桌面版自带 CLI，也支持现有路径设置及 `[dsh]` 配置。
- 按 Agent 启动独立 SDK profile，加载 Isles bridge、官方原生问答工具与 MCP；复用原生 home、认证和 session，默认模型选择来自桌面 profile。
- 创建不调用模型，恢复使用原生同一 session 并核对目录；native turn、claim 和 durable admission 明确平台执行及输入归属。
- 支持默认关闭的 steer，同步原生 turn CAS 校验后追加到下一 step；原生停止及退出清理自有 pending 输入，未知结果按平台规则保留。
- 新增 adapter、REST、stdio 与浏览器验证；真实桌面 CLI 和账户模型验收见 [DSH 验收](dsh-acceptance.md)。

## 8. M5：完整体验与长期运行

在真实使用的反馈基础上确定优先级：

- Agent 基础改名、模型/等级/权限修改与保留数据的删除已提前完成；归档、撤销删除和永久文件清理留待讨论。
- 群聊创建、查询、改名、成员管理及保留历史的删除已提前完成；恢复已删除群和永久历史/文件清理留待讨论。
- 消息搜索、长历史性能和上下文压缩后的检索体验。
- 共享产物的版本、预览和访问范围。
- 数据与原生 session 的一致性备份恢复。
- 长讨论的预算、终止规则和资源占用。
- 更完整的重启、重复投递、进程遗留、权限变更和原生接口异常测试。

Electron、IM、多用户和跨机器执行不并入首版，后续另行规划。

## 9. 阶段推进方式

每个阶段交付一条可以实际演示的链路，记录已实现、模拟验证和真实 harness 验证的区别。遇到待确认的产品行为先与用户讨论，不以代码默认值悄悄决定。

阶段完成后更新本文状态和验收结果，再决定下一阶段具体范围。Git 提交、推送及发布按用户授权执行。
