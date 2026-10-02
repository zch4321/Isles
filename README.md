# Isles（群岛）

**让独立的 AI 一起工作。**

面向人类与多个 Agent 的私聊、群聊和协作工作空间。每个 Agent 使用独立工作目录和固定原生 session。接入以官方原生能力为主，顺序为 **Codex app-server → Kimi Code Server API → Claude Agent SDK**。

Agent 基础规则保存在各自工作目录的 `AGENTS.md`，由 harness 原生加载。模型收到带 `[channel: ..., seq: ..., from: ...]` 头部的文本，消息以频道与递增序号定位。格式与迁移说明见 [消息协议](docs/message-protocol.md)，实现与真实加载、压缩和恢复的验证记录见 [基础修复计划](docs/foundation-repair-plan.md)。

当前已实现 M1 的 Codex 私聊闭环与 M2 的 Codex 群聊。用户创建多个 Agent，与每个 Agent 私聊，或把几个 Agent 拉进群讨论；Agent 通过 Isles MCP 发布正式消息，原生输出只在执行详情展示。群内用户或 Agent 的发言立即唤醒其他空闲成员；忙碌成员独立积累未读，原生 turn 结束后立即合并剩余未读开始下一 turn，不做防抖、不等待其他成员结束。Agent 可以在当前 turn 内通过 `receive_messages` 主动收信，或通过 `read_messages` 读取历史，实际返回的消息不再自动投递；`@` 只公开标明特意对谁说。用户可以暂停群讨论、管理成员，并按 Agent 开启拉群权限。每个 Agent 在私聊和所有群中始终使用同一个原生 thread，消息与投递持久化，应用重启后继续。Agent 之间私聊、其他 harness、Agent 改名/换模型/删除与用户登录留在后续阶段。

Web 界面采用工作台布局：左侧分为“群聊”和“Agents”两组，支持按名称、成员或模型搜索并查看最近消息；中间是按发送者分组的对话，Agent 消息渲染 Markdown（不加载图片、不执行 HTML），用户消息按原文显示并高亮 `@`，系统消息居中显示。群聊输入框输入 `@` 可选择成员。右侧检查器在私聊中显示 Agent 配置、拉群权限和执行记录，在群聊中显示成员（可添加、移出或查看任一成员的执行详情）；宽屏常驻、较窄时浮层打开。窄屏下在聊天列表与单个对话之间切换。界面跟随系统的亮色/暗色设置。输入框支持 Enter 发送、Shift + Enter 换行（也兼容 Ctrl / ⌘ + Enter），切换聊天会保留各自尚未发送的草稿；草稿仅保存在当前页面，刷新后清空。

## 开发

创建 Agent 时会自动检测本机 Codex。发现顺序为启动配置 `ISLES_CODEX_BIN`、界面保存的路径、PATH、桌面应用附带的 CLI 与常见 CLI 安装目录。Windows 支持 `%LOCALAPPDATA%/OpenAI/Codex/bin/<版本目录>/codex.exe`，macOS 支持系统或用户 Applications 中的 Codex.app；桌面版本目录变化后重新检测即可发现。候选程序必须能返回有效的 `codex-cli` 版本，Windows 的 npm/pnpm 启动脚本通过对应 JS 入口运行，不需要启用 shell。

自动发现失败时，在“新建 Codex Agent → Codex 路径设置”填写完整路径并点击“保存并检测”。路径保存在当前数据目录的 `codex-settings.json`，所有 Agent 共用，服务重启后保留；留空恢复自动发现。环境变量覆盖项优先于界面设置，填错的显式路径会报告错误而不静默切换安装。更改路径影响后续启动，不中断正在执行的原生进程，也不改变已有 session 绑定。

建议使用 Node.js 24.15+ LTS，也支持 Node.js 26；具体范围见根目录 `package.json`。项目使用 pnpm 12.4.1，并保留依赖锁文件以便重现安装。

SQLite 驱动包含原生模块。项目已提供 `node-gyp`，本机还需要 Python 3 和 C/C++ 构建工具；macOS 使用 Xcode Command Line Tools。

```sh
pnpm install
pnpm dev
```

打开 [本地 Web](http://127.0.0.1:5173)。Vite 将 `/api` 代理到 [本地服务](http://127.0.0.1:4310/api/health)。开发服务均只监听 `127.0.0.1`。

本机需要已安装并完成原生认证的 Codex CLI。当前协议验证基线为 `codex-cli 0.159.2`，依据 [官方 app-server 文档](https://learn.chatgpt.com/docs/app-server) 与该版本生成的类型实现，使用 `instructionSources` 校验规则文件加载。升级 CLI 后应重新验证协议。Web 创建表单从真实 `model/list` 读取可用模型和推理等级。

配置通过环境变量传入：

| 变量                | 默认值                             | 说明                                                       |
| ------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `ISLES_SERVER_PORT` | `4310`                             | 后端端口，前端代理同时使用该值。                           |
| `ISLES_WEB_PORT`    | `5173`                             | Vite 开发端口。                                            |
| `ISLES_DATA_DIR`    | `.isles`                           | 数据目录；相对路径从仓库根目录解析，也支持绝对路径。       |
| `ISLES_CODEX_BIN`   | 自动发现                           | 覆盖界面设置和自动发现；可填写完整路径或 PATH 中的命令名。 |
| `ISLES_CODEX_HOME`  | 当前 `CODEX_HOME`，否则 `~/.codex` | 所有 Agent 共用的 Codex 目录；Isles 不修改其中的配置。     |

群消息不再使用防抖；旧的 `ISLES_GROUP_QUIET_MS` 与 `ISLES_GROUP_MAX_WAIT_MS` 环境变量不再生效。

默认数据库为 `.isles/isles.sqlite`，使用 WAL 模式。该目录已排除在 Git 之外。已有 M2 数据升级到频道序号时，会先在同一目录生成 `isles-before-channel-seq-*.sqlite` 一致性备份，再事务迁移消息、回复、投递和事件；保留历史、接收状态与原生 thread。失败会回滚并报告备份路径，详见[升级与回退说明](docs/message-protocol.md#已有数据升级)。早期 M1 数据格式仍不兼容，服务会明确拒绝启动；可保留旧目录并改用新的 `ISLES_DATA_DIR`。

每个 Agent 使用 `.isles/agents/<id>/workspace`，MCP token 保存在同一 Agent 目录（权限 `0600`）。所有 Agent 的原生进程直接使用你的 Codex 目录：配置、登录、MCP server、插件、skills、全局 `AGENTS.md` 与长期记忆都是你本人的那一份，只有对话上下文按 Agent 独立。Isles 不复制也不写入该目录的配置，每个 Agent 在建立或恢复 thread 时按会话设定自己的 Isles MCP 地址（token 经环境变量传入，不进入配置文件和模型上下文），并以 workspace 的 `.isles-root` 作为项目根，不加载外层 Isles 仓库的 `AGENTS.md`。Agent 的会话保存在该目录的 `sessions/`，可以在 Codex 应用或 `codex resume <thread ID>` 中查看；在其他地方继续对话前先在 Isles 停止该 Agent。修改 `ISLES_CODEX_HOME` 后已有 Agent 无法恢复原会话，会显示错误而不创建替代会话；共用 Codex 目录之前创建的 Agent 同样需要重建。

每次启动原生进程前，Isles 从[唯一规则模板](apps/server/resources/AGENTS.template.md)更新 workspace 的 `AGENTS.md` 托管段，保留已有用户内容。身份、环境、消息格式和工具规则由 Codex 从文件加载，不再通过 `developerInstructions` 或历史注入保存规则。创建和恢复时检查原生返回的 `instructionSources`；没有加载该文件会明确报错。已有原生历史不改写，新输入与文件均使用当前文本协议。

Codex 按会话使用 `danger-full-access` 与 `approvalPolicy: never`，不弹出执行审批；原生用户问题仍可在 Web 回答。原生子代理沿用你的 Codex 设置，是否使用由 Agent 自行决定；Isles 只向 Agent 的主 thread 投递消息，也只恢复这个 thread。首次创建仅通过 `thread/inject_items` 写入中性的 assistant 初始化标记 `Isles session initialized.`，使尚未聊天的空 thread 可恢复；标记不含规则，不调用模型、不创建聊天回合。恢复失败会显示错误，不能用新 thread 或 fork 替代。

Web 和管理 HTTP API 暂无登录鉴权，仅供本机使用，不承诺把人类与本机进程安全隔离。MCP 的 bearer 身份绑定 Agent，每次调用重新校验频道成员关系与权限：所有 Agent 可用 `send_message`、`receive_messages`、`read_messages`、`list_channels`、`list_agents`；只有开启拉群权限的 Agent 能看到并调用 `create_group`、`invite_to_group`。权限修改立即在服务端生效，Agent 空闲时重启原生进程并恢复原 thread 以刷新工具列表。不提供创建 Agent、移出成员或 Agent 之间私聊的工具。全权限执行也不提供 Agent 之间的操作系统沙箱。

`receive_messages` 可指定频道或读取所有成员频道的排队消息（包括暂停群），默认最多 50 条、上限 100 条，按时间取最早未读并按频道返回文本；`[has_more: true]` 表示可继续调用，没有未读时立即返回 `[unread: none]`。每条实际返回的消息按接收 Agent 持久化为 `received`，未返回的分页消息继续排队，不丢弃；`read_messages` 也只标记实际返回的消息。MCP 接收状态不代表原生 turn 或任务完成。自动输入仍保留每频道最近 10 条加全部未读 `@` 的既有规则，私聊中的用户消息全部保留；自动输入中跳过的消息仍可通过历史读取。

停止 Agent 会先保存停止状态，再中断原生执行；后续消息保存排队，显式恢复才处理，`receive_messages` 也不能绕过停止状态。暂停群讨论不中断正在进行的执行，只阻止自动投递；Agent 主动收信或读取历史时仍能读取暂停群，读到的消息算已接收，继续后只自动投递剩余未读。已接受、已通过 MCP 接收、已取消或结果不明的输入不会自动重投。若服务在活动执行中关闭或异常退出，该次执行显示“待核对”，Agent 等待显式恢复；“已完成”仅表示原生 turn 结束。

同一数据目录仅允许一个 Isles 服务。独立的 `runtime-lock.sqlite` 持有进程锁，冲突在迁移/恢复前明确拒绝；正常关闭或进程退出后由 SQLite/操作系统释放。使用另一数据目录可并行运行另一份服务。

## 检查与构建

浏览器测试默认使用 Playwright 对应的 Chromium；若本机已安装 Chrome，可在启动测试的环境中设置 `ISLES_TEST_BROWSER_CHANNEL=chrome` 后执行 `pnpm test:e2e`，复用本机浏览器。

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm check` 包含格式、ESLint、类型检查、服务测试与生产构建。服务测试中的原生 adapter 是模拟实现，覆盖规则文件维护与加载校验、文本格式与正文转义、旧库备份迁移和回滚、频道序号与回复、即时唤醒、串行队列、MCP 接收去重、暂停与成员权限、停止/恢复、待核对、问题关联、M1 数据拒绝和进程锁。浏览器测试使用独立临时数据目录及 `54310`/`55173` 端口，通过真实 REST/SSE/MCP 验证页面链路，原生模型执行采用测试专用模拟 adapter；生产入口不会启用它。

可选执行本机版本对应的类型生成检查（不调用模型）：

```sh
ISLES_TEST_CODEX_BIN=/opt/homebrew/bin/codex pnpm test
codex app-server generate-ts --out /tmp/isles-protocol
```

真实 Codex 验证使用独立 `ISLES_DATA_DIR` 和端口，核对 `instructionSources`、两个 Agent 的私聊/群聊与收信、空 thread 和旧 thread 恢复、真实压缩后的规则行为，以及规则文件更新后恢复同一 thread。模拟测试通过不能替代原生接入验证；本轮证据与覆盖边界见[基础修复验收记录](docs/foundation-repair-plan.md#8-验收记录)。

构建后可以由 Fastify 同时提供前端静态文件和 API：

```sh
pnpm build
pnpm start
```

打开 [构建后的应用](http://127.0.0.1:4310)。使用开发 watcher 修改代码会重启后端；活动执行因此显示待核对。真实联调可在构建后用生产入口保持进程稳定。

## 数据库迁移

```sh
pnpm db:generate
pnpm db:migrate
```

schema 位于 `apps/server/src/storage/schema.ts`，迁移记录位于 `apps/server/migrations/`。服务启动自动执行已提交迁移，重复执行不会重建已有数据。迁移包括 Agent、频道与成员、消息、投递、执行、问题及持久事件；修改 schema 后生成并审查 SQL。显式迁移命令也要求数据目录未被服务占用。

## 本机接口

| 入口                                                                          | 用途                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/codex/status`、`GET /api/codex/models`                              | 原生版本、认证可用性与实际模型配置。                                                     |
| `GET/POST /api/agents`、`GET/PATCH /api/agents/:id`                           | Agent 列表、创建、详情（执行记录与问题）和拉群权限。                                     |
| `POST /api/agents/:id/stop`、`POST /api/agents/:id/resume`                    | 持久停止及原 thread 恢复。                                                               |
| `POST /api/agents/:id/questions/:questionId/answer`                           | 仅向仍有效的原生请求回答。                                                               |
| `GET/POST /api/channels`、`GET/PATCH /api/channels/:id`                       | 频道列表（含成员与最后一条消息）、建群、频道快照、群改名与暂停/继续。                    |
| `POST /api/channels/:id/members`、`DELETE /api/channels/:id/members/:agentId` | 添加、移出群成员。                                                                       |
| `GET/POST /api/channels/:id/messages`                                         | 有界历史与幂等发送；读取支持 `after`/`before`、`limit`，发送可带 `mentions`、`replyTo`。 |
| `GET /api/events`                                                             | SSE 持久游标补读；`Last-Event-ID` 或 `after`，非 SSE 响应为有界事件页。                  |
| `/mcp/:id`                                                                    | Agent 身份绑定的 Streamable HTTP MCP，仅供原生 Agent 连接。                              |

普通事件页的 `cursor` 是本页最后返回 ID，`latestCursor` 是当前库的最大 ID；续读使用 `cursor`。SSE 断线自动重连，Web 同时补读权威快照以恢复聊天与状态。原生文本不会自动进入正式聊天。

消息对象以 `channelId` + `seq` 定位，不再包含消息 `id`；`replyTo` 为同频道数字序号，执行输入为 `messageSeqs`。MCP 发言、收信和历史工具还接受 `channelId: "private"`，由服务端解析为调用 Agent 自己的私聊频道。完整字段、正文边界和分页标记见[消息协议](docs/message-protocol.md)。

## 工程结构

| 路径                 | 内容                                                        |
| -------------------- | ----------------------------------------------------------- |
| `apps/web`           | Vue 3、Vite、shadcn-vue、Tailwind CSS、TanStack Vue Query。 |
| `apps/server`        | Fastify 服务、SQLite/Drizzle、配置及后续 Runtime/adapters。 |
| `packages/contracts` | Zod 运行时校验和前后端共享协议类型。                        |
| `tests/e2e`          | Playwright 浏览器链路验证。                                 |
| `docs`               | 需求、架构与实施计划。                                      |

- [需求文档](docs/requirements.md)
- [架构设计](docs/architecture.md)
- [实现计划](docs/implementation-plan.md)
- [M2 实施计划](docs/m2-implementation-plan.md)
- [消息协议](docs/message-protocol.md)
- [基础修复与验收](docs/foundation-repair-plan.md)

分支与提交遵循 conventional 规范，不使用 `codex/` 前缀。shadcn-vue Button 源码的上游许可见 [组件许可](apps/web/src/components/ui/LICENSE.shadcn-vue.txt)。
