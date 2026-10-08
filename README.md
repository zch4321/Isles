# Isles（群岛）

**让独立的 AI 一起工作。**

面向人类与多个 Agent 的私聊、群聊和协作工作空间。每个 Agent 使用独立工作目录和固定原生 session。当前接入 **Codex app-server** 与 **Claude Code CLI**，通过独立的 harness adapter 参与私聊和混合群聊。Codex 与 Claude 均支持默认关闭的实时收信开关：开启时追加到当前执行，关闭时忙碌排队；Agent 也可通过 MCP 主动收信。Kimi Code 保留为后续候选。

Agent 基础规则保存在各自工作目录的 `AGENTS.md`，由 harness 原生加载。模型收到 `[channel: "评审", seq: 12, from: agent:"Alice"]` 这样的文本头部，自己的私聊显示为 `private`。普通消息用名称呈现群、发送者与提及对象，重名时在引号外附加 ID 短前缀；工具仍通过目录查询完整 UUID 寻址，消息仍以频道与递增序号定位。格式与数据版本边界见 [消息协议](docs/message-protocol.md)，本轮验证见 [名称消息验收](docs/name-message-acceptance.md)，历史真实加载、压缩和恢复的验证记录见 [基础修复计划](docs/foundation-repair-plan.md)。

当前已实现 M1 的 Codex 私聊闭环、M2 的 Codex 群聊与 Agent 基础管理。用户创建多个 Agent，与每个 Agent 私聊，或把几个 Agent 拉进群讨论；Agent 通过 Isles MCP 发布正式消息，原生输出只在执行详情展示。群内用户或 Agent 的发言立即唤醒其他空闲成员；忙碌成员默认独立积累未读，原生 turn 结束后立即合并剩余未读开始下一 turn。用户可按 Agent 开启“忙碌时实时接收（steer）”，把新消息追加到同一 thread 的当前 turn，不另开 turn。调度不做防抖、不等待其他成员结束。Agent 可以在当前 turn 内通过 `receive_messages` 主动收信，或通过 `read_messages` 读取历史，实际返回的消息不再自动投递；`@` 只公开标明特意对谁说。用户可以暂停群讨论、管理成员，并按 Agent 开启拉群权限。每个 Agent 在私聊和所有群中始终使用同一个原生 thread，消息与投递持久化，应用重启后继续。Agent 之间私聊、其他 harness 与用户登录留在后续阶段。

Web 界面采用工作台布局：左侧分为“群聊”和“Agents”，有已删除 Agent 或群聊时增加“历史对话”，支持按名称、成员或模型搜索并查看最近消息；中间是按发送者分组的对话，Agent 消息渲染 Markdown（不加载图片、不执行 HTML），用户消息按原文显示并高亮 `@`，系统消息居中显示。群聊输入框输入 `@` 可选择成员。右侧检查器在私聊中显示 Agent 配置、拉群权限和执行记录，在群聊中显示成员（可添加、移出或查看任一成员的执行详情）；宽屏常驻、较窄时浮层打开。窄屏下在聊天列表与单个对话之间切换。界面跟随系统的亮色/暗色设置。输入框支持 Enter 发送、Shift + Enter 换行（也兼容 Ctrl / ⌘ + Enter），切换聊天会保留各自尚未发送的草稿；草稿仅保存在当前页面，刷新后清空。

在私聊或群成员的 Agent 详情中点击“编辑 Agent”，可修改名称、模型、推理等级、拉群权限和实时收信开关。ID、工作目录及原生 thread 保持不变；运行中的 turn 使用原配置，下一次执行使用新模型和推理等级。停止的 Agent 修改后仍保持停止。名称、权限和收信开关可在模型目录暂时不可用时修改，切换模型或等级需要原生目录确认支持。

实时收信开关 `steerEnabled` 默认关闭，支持 steer 的 harness 也可在创建、编辑或 Agent 详情中保持关闭。未声明 `capabilities.steer` 的 harness 禁止开启，界面禁用该选项，服务端也拒绝开启；已保存开启值但当前 harness 不再支持时仍可关闭。只修改收信偏好不会重启原生进程、不查询模型目录，也不更换 session。开启后，忙碌 Agent 的可投递未读立即追加到当前 turn，消息仍保留频道、序号、发送者、回复和提及；关闭或不支持时继续排队到下一轮。关闭开关只影响后续调度，已经发出的原生 RPC 仍按实际响应结算。

追加请求原生确认前显示“投递中”（`steering`），确认后继续在当前执行中处理，结果可在执行记录中查看。Codex steer 将 `-32600`、`-32601`、`-32602` 视为明确拒绝，消息退回队列，当前 turn 结束后按下一轮处理；超时、断连或其他未知结果显示“待核对”，由用户核对后决定后续操作。停止 Agent、暂停群、删除群和移出成员分别采用各自的控制规则，已取消投递保持取消状态。本次实现与验收证据见 [Steer 投递验收](docs/steer-delivery-acceptance.md)。

“删除 Agent”先停止执行，再退出所有群聊并从联系人移除。当前采用保留数据的删除方式：私聊、群聊发言、执行记录、个人工作目录、共享文件与原生 session 都保留；私聊在“历史对话”中只读展示，删除后不能恢复、编辑、继续发言或加入群聊，MCP 身份失效。删除需要确认，尚不提供永久清理文件或恢复已删除 Agent 的入口。

群聊支持创建、列表与详情、改名、成员管理、暂停/继续及确认删除。“删除群聊”将它移至“历史对话”，移出所有成员、取消本群尚未结束的投递，并拒绝后续发言和 Agent 访问；人类可继续查看历史。成员 Agent 保持原运行状态与 thread，仍能在私聊和其他群工作，已经开始的原生任务可能继续完成。群聊历史、执行关联、个人工作目录和共享文件保留；当前不提供撤销删除或永久清理。行为与验证见 [群聊管理验收](docs/group-management-acceptance.md)。

## 开发

创建 Agent 时会自动检测本机 Codex。发现顺序为启动配置 `ISLES_CODEX_BIN`、界面保存的路径、PATH、桌面应用附带的 CLI 与常见 CLI 安装目录。Windows 支持 `%LOCALAPPDATA%/OpenAI/Codex/bin/<版本目录>/codex.exe`，macOS 支持系统或用户 Applications 中的 Codex.app；桌面版本目录变化后重新检测即可发现。候选程序必须能返回有效的 `codex-cli` 版本，Windows 的 npm/pnpm 启动脚本通过对应 JS 入口运行，不需要启用 shell。

自动发现失败时，在“新建 Agent → Codex 路径设置”填写完整路径并点击“保存并检测”。路径保存在 Isles 的 `config.toml` 的 `[codex].binary_path`，所有 Agent 共用，服务重启后保留；留空删除该项并恢复自动发现。环境变量覆盖项优先于界面设置，填错的显式路径会报告错误而不静默切换安装。保存后立即刷新检测，更改路径影响后续启动，不中断正在执行的原生进程，也不改变已有 session 绑定。

建议使用 Node.js 24.15+ LTS，也支持 Node.js 26；具体范围见根目录 `package.json`。项目使用 pnpm 12.4.1，并保留依赖锁文件以便重现安装。

Claude Code 同样支持自动发现与“新建 Agent → Claude Code 路径设置”。发现顺序为 `ISLES_CLAUDE_BIN`、界面保存的路径、PATH，以及 `~/.local/bin`、旧本地安装、Homebrew 和 npm/pnpm 的常见目录；Windows npm 启动脚本通过其 JS 入口运行。界面路径独立保存在 `[claude].binary_path`，更新只影响后续启动，原 session 绑定保留。原生模型和 effort 元数据来自 CLI 初始化响应；`default` effort 表示沿用原生设置，其他等级按 CLI 实际返回的支持列表提供。

SQLite 驱动包含原生模块。项目已提供 `node-gyp`，本机还需要 Python 3 和 C/C++ 构建工具；macOS 使用 Xcode Command Line Tools。

```sh
pnpm install
pnpm dev
```

打开 [本地 Web](http://127.0.0.1:5173)。Vite 将 `/api` 代理到 [本地服务](http://127.0.0.1:4310/api/health)。开发服务均只监听 `127.0.0.1`。

本机需要已安装并完成原生认证的 Codex CLI。当前协议验证基线为 `codex-cli 0.160.0`，依据 [官方 app-server 文档](https://learn.chatgpt.com/docs/app-server) 与该版本生成的类型实现，使用 `instructionSources` 校验规则文件加载。升级 CLI 后应重新验证协议。Web 创建表单从真实 `model/list` 读取可用模型和推理等级。

使用 Claude 时，本机需要已安装并完成原生认证的 Claude Code CLI。本轮已验证 `2.1.285` 的双向 `stream-json`、模型目录、规则来源、MCP、原生提问、steer 与会话恢复，直接运行本机 CLI。版本变化后重新验证原生协议；实施与真实验收见 [Claude CLI 验收](docs/claude-cli-acceptance.md)。

配置默认保存在 `~/.Isles/config.toml`；`~` 表示当前用户主目录。最小配置为：

```toml
[server]
port = 4310

[paths]
data_dir = 'data'
workspace_dir = 'workspace'
log_dir = 'logs'

[log]
level = 'info'

[codex]
# binary_path = 'C:/path/to/codex.exe'
# home = '~/.codex'

[claude]
# binary_path = '/opt/homebrew/bin/claude'
# home = '~/.claude'

[dev]
port = 5173
```

路径支持 `~` 和绝对路径；相对路径从配置文件所在目录解析，与安装目录及启动时的工作目录无关。默认数据目录为 `~/.Isles/data`，工作区根目录为 `~/.Isles/workspace`，日志目录为 `~/.Isles/logs`。未填写 Codex 路径时自动发现；未填写 Codex home 时先使用 `CODEX_HOME`，否则使用 `~/.codex`。平台规则模板、数据库基线文件和 Web 静态资源仍按安装目录定位。

Claude 路径留空时自动发现；Claude home 依次采用 `ISLES_CLAUDE_HOME`、`[claude].home`、`CLAUDE_CONFIG_DIR`、`~/.claude`。

配置优先级为 **环境变量 > TOML > 默认值**：

| 变量                | 对应配置 / 默认值                                       | 说明                                                             |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `ISLES_CONFIG_FILE` | `~/.Isles/config.toml`                                  | 指定另一份配置文件。                                             |
| `ISLES_SERVER_PORT` | `[server].port` / `4310`                                | 后端端口，前端代理同时使用该值。                                 |
| `ISLES_WEB_PORT`    | `[dev].port` / `5173`                                   | Vite 开发端口。                                                  |
| `ISLES_DATA_DIR`    | `[paths].data_dir` / `data`                             | SQLite、进程锁和 MCP token 的数据目录。                          |
| `ISLES_LOG_LEVEL`   | `[log].level` / `info`                                  | 服务日志等级：fatal、error、warn、info、debug、trace 或 silent。 |
| `ISLES_CODEX_BIN`   | `[codex].binary_path` / 自动发现                        | 可填写完整路径或 PATH 中的命令名；显式无效项直接报错。           |
| `ISLES_CODEX_HOME`  | `[codex].home` / `CODEX_HOME`，否则 `~/.codex`          | 所有 Agent 共用的 Codex 目录；Isles 不修改其中的配置。           |
| `ISLES_CLAUDE_BIN`  | `[claude].binary_path` / 自动发现                       | 可填写完整路径或 PATH 中的命令名；显式无效项直接报错。           |
| `ISLES_CLAUDE_HOME` | `[claude].home` / `CLAUDE_CONFIG_DIR`，否则 `~/.claude` | 所有 Claude Agent 共用的原生配置目录。                           |

手动修改 TOML 后需重启应用；开发时同时重启开发服务。Codex 和 Claude 路径设置分别更新自己的 `binary_path`：保存前重读最新 TOML，串行写入以保留其他字段值，然后重新序列化整份文件，原注释和排版不保留。

服务日志同时输出到终端和 `~/.Isles/logs`。日志文件按本地日期命名为 `isles-YYYY-MM-DD.log`，每行一条 JSON；单个文件达到 10 MB 后续写 `isles-YYYY-MM-DD.1.log` 等分段。Isles 保留最近 7 天的日志，总量不超过 100 MB，超出时先删除最旧的文件。`[log].level` 设置写入等级，默认 `info`，记录 Agent 生命周期、执行结果和错误；设为 `debug` 时额外记录原生 CLI 的 stderr。错误信息和 stderr 在写入前脱敏。`pnpm dev` 在终端中以易读格式显示日志，文件始终保存 JSON。

群消息不再使用防抖；旧的 `ISLES_GROUP_QUIET_MS` 与 `ISLES_GROUP_MAX_WAIT_MS` 环境变量不再生效。

默认数据库为 `~/.Isles/data/isles.sqlite`，使用 WAL 模式。在用户明确宣布首个 release 前，不提供向后兼容或旧数据迁移，数据库以当前 schema 的全新基线初始化。如果旧库阻碍启动，开发时可直接清理或覆盖并重建，无需保留旧数据或要求用户切换配置；操作前停止占用该数据目录的服务并核验目标属于 Isles。旧 JSON 配置及旧数据库转换不再支持。历史迁移验收仅记录当时的实现，不构成当前升级承诺。

每个 Agent 默认使用 `~/.Isles/workspace/agents/<id>/workspace`，MCP token 单独保存在 `~/.Isles/data/agents/<id>/isles-mcp-token`（权限 `0600`）。共享目录为 `~/.Isles/workspace/shared`；各 Agent 的 `AGENTS.md` 写入共享目录绝对路径与使用约定，协作时将产物放入该目录并在消息中提供准确路径。共享目录不提供快照、版本管理或额外权限隔离。修改工作区根目录只影响新建 Agent；同版本已有 Agent 继续使用数据库中保存的工作区路径，共享根目录随配置更新，不搬移原有文件。

Codex Agent 的原生进程直接使用你的 Codex 目录：配置、登录、MCP server、插件、skills、全局 `AGENTS.md` 与长期记忆都是你本人的那一份，只有对话上下文按 Agent 独立。Isles 不复制也不写入该目录的配置，每个 Agent 在建立或恢复 thread 时按会话设定自己的 Isles MCP 地址（token 经环境变量传入，不进入配置文件和模型上下文），并以 workspace 的 `.isles-root` 作为项目根，不加载外层 Isles 仓库的 `AGENTS.md`。Agent 的会话保存在该目录的 `sessions/`，可以在 Codex 应用或 `codex resume <thread ID>` 中查看；在其他地方继续对话前先在 Isles 停止该 Agent。修改 Codex home 后已有 Agent 无法恢复原会话，会显示错误而不创建替代会话。

每次启动原生进程前，Isles 从[唯一规则模板](apps/server/resources/AGENTS.template.md)更新 workspace 的 `AGENTS.md` 托管段，保留已有用户内容。身份、环境、消息格式和工具规则由 Codex 从文件加载，不再通过 `developerInstructions` 或历史注入保存规则。创建和恢复时检查原生返回的 `instructionSources`；没有加载该文件会明确报错。已有原生历史不改写，新输入与文件均使用当前文本协议。

Agent 的规则文件包含独立的“Shared workspace”章节：所有 Agent 可直接读写共享文件，交接时通过相关频道发送文件绝对路径和说明。文件写入不会自动唤醒其他 Agent，完成或更新后需要发消息通知；并行修改同一文件前应协调，共享仓库继续遵守自己的项目规则。

Codex 按会话使用 `danger-full-access` 与 `approvalPolicy: never`，不弹出执行审批；原生用户问题仍可在 Web 回答。原生子代理沿用你的 Codex 设置，是否使用由 Agent 自行决定；Isles 只向 Agent 的主 thread 投递消息，也只恢复这个 thread。首次创建仅通过 `thread/inject_items` 写入中性的 assistant 初始化标记 `Isles session initialized.`，使尚未聊天的空 thread 可恢复；标记不含规则，不调用模型、不创建聊天回合。恢复失败会显示错误，不能用新 thread 或 fork 替代。

Web 和管理 HTTP API 暂无登录鉴权，仅供本机使用，不承诺把人类与本机进程安全隔离。MCP 的 bearer 身份绑定 Agent，每次调用重新校验频道成员关系与权限：所有 Agent 可用 `send_message`、`receive_messages`、`read_messages`、`list_channels`、`list_agents`；只有开启拉群权限的 Agent 能看到并调用 `create_group`、`invite_to_group`。权限修改立即在服务端生效，Agent 空闲时重启原生进程并恢复原 thread 以刷新工具列表。不提供创建 Agent、移出成员或 Agent 之间私聊的工具。全权限执行也不提供 Agent 之间的操作系统沙箱。

`receive_messages` 可指定频道或读取所有成员频道的排队消息（包括暂停群），默认最多 50 条、上限 100 条，按时间取最早未读并按频道返回文本；`[has_more: true]` 表示可继续调用，收件箱为空时立即返回 `[unread: none]`。每条实际返回的消息按接收 Agent 持久化为 `received`，分页中的其余消息继续排队；`read_messages` 同样记录实际返回的消息。执行状态和结果可在 Agent 详情中查看。自动输入保留每频道最近 10 条加全部未读 `@` 的既有规则，私聊中的用户消息全部保留；自动输入中跳过的消息仍可通过历史读取。

停止 Agent 会先保存停止状态，再中断原生执行；后续消息保存排队，显式恢复才处理，`receive_messages` 也不能绕过停止状态。暂停群讨论不中断正在进行的执行，只阻止自动投递；Agent 主动收信或读取历史时仍能读取暂停群，读到的消息算已接收，继续后只自动投递剩余未读。已接受、已通过 MCP 接收、已取消或结果不明的输入不会自动重投。若服务在活动执行中关闭或异常退出，该次执行显示“待核对”，Agent 等待显式恢复；“已完成”仅表示原生 turn 结束。

Claude Agent 直接共用用户的 Claude home、原生认证、配置、插件、skills、用户 MCP 与记忆，每位 Agent 保持独立工作目录和固定 UUID。工作目录的 `CLAUDE.md` 通过 `@AGENTS.md` 导入唯一规则来源，托管段之外的用户内容保留；创建和恢复均通过原生 `get_context_usage` 校验加载的文件，并检查 Isles HTTP MCP 已连接。追加的 MCP 配置只用于当前进程，token 从环境变量读取。

Claude 首次创建会发送中性用户消息 `Isles session initialized. Reply only READY. Do not use tools or send messages.`，完成一次模型回合使会话落盘。初始化期间的工具调用被拦截，结果由 adapter 内部处理，成功后 Agent 就绪；初始化不会发布 Isles 聊天消息或生成 Isles run。失败保留已分配的 session 绑定并显示原因。后续使用 `--resume=<UUID>` 恢复原会话，输入确认与结束事件以输入 UUID 关联；原生最终输出保留为执行详情，正式发言继续使用 MCP。Claude 使用原生全权限模式，并将 `AskUserQuestion` 交到 Web 回答。Claude 支持按 Agent 开启 steer，默认关闭。开启时使用批次 UUID 发送追加输入，在原生执行边界进入当前任务，保持原 session 与 run；主线程 replay/started 或 result 的消费 UUID 列表确认接受。当前执行先结束时尝试撤回尚未消费的输入，明确撤回后排到下一轮；结果不明时关闭所属进程并显示待核对。停止同时取消原生队列中的输入。

同一数据目录仅允许一个 Isles 服务。独立的 `runtime-lock.sqlite` 持有进程锁，冲突在初始化/恢复前明确拒绝；正常关闭或进程退出后由 SQLite/操作系统释放。关闭时先释放原生进程、Web SSE 和 MCP 流，再关闭 HTTP 服务与数据库。使用另一数据目录可并行运行另一份服务。

## 检查与构建

浏览器测试默认使用 Playwright 对应的 Chromium；若本机已安装 Chrome，可在启动测试的环境中设置 `ISLES_TEST_BROWSER_CHANNEL=chrome` 后执行 `pnpm test:e2e`，复用本机浏览器。

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm check` 包含格式、ESLint、类型检查、服务测试与生产构建。独立语义 fake adapter 验证 Runtime 的协议无关派发、相同 session ID 跨 harness 的隔离、注册约束和生命周期；Codex 原生协议模拟验证 adapter 的参数、事件及问题转换。既有测试覆盖规则文件维护与加载校验、文本格式与正文转义、频道序号与回复、即时唤醒、串行队列、MCP 接收去重、暂停与成员权限、停止/恢复、待核对、问题关联和进程锁。浏览器测试使用独立临时数据目录及 `54310`/`55173` 端口，通过真实 REST/SSE/MCP 验证页面链路，原生模型执行采用测试专用模拟 adapter；生产入口不会启用它。适配层阶段的检查和真实 Codex 回归结果见 [Harness 适配层验收](docs/harness-adapter-acceptance.md)；本次 steer 的最终结果另在 [Steer 投递验收](docs/steer-delivery-acceptance.md) 记录。模拟验证不代表新 harness 已接入。

可选执行本机版本对应的类型生成检查（不调用模型）：

```sh
ISLES_TEST_CODEX_BIN=/opt/homebrew/bin/codex pnpm test
codex app-server generate-ts --out /tmp/isles-protocol
```

TOML、目录拆分与共享目录已通过 89 项自动化测试、7 项浏览器测试和两个真实 Codex Agent 的读写及同 thread 重启验证，结果见 [配置与工作区验收](docs/config-workspace-acceptance.md)。原生验收入口：

```sh
pnpm --filter @isles/server exec tsx test/verify-native-config.ts
```

该入口使用临时配置、数据及工作区目录，核对 `instructionSources`、共享文件和同版本 thread 恢复，同时验证 Agent 改名、换模型/推理等级及运行中删除；报告保留在输出的临时目录。Agent 管理的验证与代码入口见 [验收记录](docs/agent-management-acceptance.md)。真实压缩、群聊和主动收信的历史验证及其边界见 [基础修复验收记录](docs/foundation-repair-plan.md#8-验收记录)，不当成本轮重复测试结果。

群聊管理已通过 114 项自动化测试、12 项浏览器测试及真实 Codex 运行中删除/私聊继续/同 thread 重启验证，见 [验收记录](docs/group-management-acceptance.md)。名称寻址与群聊删除的真实验收入口为 `pnpm --filter @isles/server exec tsx test/verify-native-names.ts`，同样使用独立临时目录，不操作现有用户 Agent 或群聊。

构建后可以由 Fastify 同时提供前端静态文件和 API：

```sh
pnpm build
pnpm start
```

打开 [构建后的应用](http://127.0.0.1:4310)。使用开发 watcher 修改代码会重启后端；活动执行因此显示待核对。真实联调可在构建后用生产入口保持进程稳定。

## 数据库基线

```sh
pnpm db:generate
pnpm db:migrate
```

schema 位于 `apps/server/src/storage/schema.ts`，当前初始化基线位于 `apps/server/migrations/`。本次基线增加 Agent 的 `steerEnabled` 设置和 `steer_batches` 投递批次记录。上述命令用于生成和应用当前基线；启动及显式命令重复执行不会重建同版本数据，显式命令要求数据目录未被服务占用。首个 release 前，schema 变更更新全新基线，不增加旧版本数据升级路径；开发时可直接重建阻碍启动的旧库，再运行 `pnpm db:migrate`，沿用既有数据目录配置。此授权不增加运行时的旧格式识别、迁移或兼容逻辑。

## 本机接口

| 入口                                                                          | 用途                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/harnesses`                                                          | 已注册的 harness 目录与能力声明；当前只返回 Codex。                                               |
| `GET /api/harnesses/:id/status`、`GET /api/harnesses/:id/models`              | 所选 harness 的版本、认证可用性与实际模型配置。                                                   |
| `GET/PUT /api/codex/config`                                                   | 读取/保存 TOML 中的 Codex 可执行路径；响应包含 `configFilePath`，传入 `null` 删除 `binary_path`。 |
| `GET/POST /api/agents`、`GET/PATCH/DELETE /api/agents/:id`                    | 列表、创建、详情、修改名称/模型/推理等级/拉群权限/实时收信，以及保留历史的删除。                  |
| `POST /api/agents/:id/stop`、`POST /api/agents/:id/resume`                    | 持久停止及原 thread 恢复。                                                                        |
| `POST /api/agents/:id/questions/:questionId/answer`                           | 仅向仍有效的原生请求回答。                                                                        |
| `GET/POST /api/channels`、`GET/PATCH /api/channels/:id`                       | 频道列表（含成员与最后一条消息）、建群、频道快照、群改名与暂停/继续。                             |
| `DELETE /api/channels/:id`                                                    | 删除群聊，保留历史和文件；不停止成员 Agent。                                                      |
| `POST /api/channels/:id/members`、`DELETE /api/channels/:id/members/:agentId` | 添加、移出群成员。                                                                                |
| `GET/POST /api/channels/:id/messages`                                         | 有界历史与幂等发送；读取支持 `after`/`before`、`limit`，发送可带 `mentions`、`replyTo`。          |
| `GET /api/events`                                                             | SSE 持久游标补读；`Last-Event-ID` 或 `after`，非 SSE 响应为有界事件页。                           |
| `/mcp/:id`                                                                    | Agent 身份绑定的 Streamable HTTP MCP，仅供原生 Agent 连接。                                       |

普通事件页的 `cursor` 是本页最后返回 ID，`latestCursor` 是当前库的最大 ID；续读使用 `cursor`。SSE 断线自动重连，Web 同时补读权威快照以恢复聊天与状态。原生文本不会自动进入正式聊天。

创建 Agent 必须传入已注册的 `harness`；`steerEnabled` 可省略，默认 `false`，PATCH 可单独更新该字段。Web 从目录动态读取选项，仅展示实际接入项。模型和推理等级来自所选 adapter 的原生目录，不预设其他 harness。原 Codex 状态/模型路由已移除，不提供兼容别名；Codex 路径设置继续使用 `/api/codex/config`。

`GET /api/agents` 默认排除已删除 Agent；`?includeDeleted=true` 用于历史发送者目录。Agent PATCH 仅更新提供的字段，空请求或不支持的模型/等级返回 `400`；不接受修改 harness、ID、工作区或 thread。DELETE 成功返回已删除 Agent，重复删除保持相同状态。已删除 Agent 的详情仍可读取，编辑/停止/恢复返回 `410`，私聊写入返回 `409`，MCP 请求返回 `401`。

API 与存储中的 `threadId` 表示 adapter 返回的不透明原生 session ID，不要求所有 harness 使用 Codex thread 语义。绑定按 `(harness, nativeHome, threadId)` 区分；同一 Agent 不能静默替换绑定。本次更新全新数据库基线以保存 steer 偏好与批次，不迁移、清理或搬移现有 Codex 数据。

`GET /api/channels` 默认排除已删除群；`?includeDeleted=true` 包含保留的群历史。频道响应增加 `deletedAt`，未删除频道为 `null`。群 PATCH 仅接受名称与暂停状态，空请求返回 `400`；DELETE 返回删除后的频道，重复删除幂等，私聊 DELETE 返回 `400`。已删除群的详情和历史仍可由人类读取，改名、暂停/继续和成员修改返回 `410`，发消息返回 `409`；Agent 的 MCP 调用拒绝读写该群。删除状态记录在永久保留的 `group_deleted` 事件中，不能当作普通 SSE 回放历史清理。

消息对象以 `channelId` + `seq` 定位，不再包含消息 `id`；`replyTo` 为同频道数字序号，执行输入为 `messageSeqs`。MCP 发言、收信和历史工具还接受 `channelId: "private"`，由服务端解析为调用 Agent 自己的私聊频道。完整字段、正文边界和分页标记见[消息协议](docs/message-protocol.md)。

普通消息中的 JSON 引号名称和 `#` 短前缀是显示标签，不是工具地址。向某个名称的群发言，先用 `list_channels` 确认名称、成员及完整 ID，再传入 `channelId`；提及某个 Agent，先用 `list_agents` 取完整 ID，再传入 `mentions`。目录和群管理结果保留完整 ID、名称及配置，MCP `send_message` 成功只返回 `{ "seq": N }`。改名后重新查询目录；历史头部使用当前存储名称，已删除发送者仍可读，原始作者的内部 ID 不变。同名消歧包含已删除的历史 Agent；群名仅在接收 Agent 已加入的群之间比较。名称标签规则只改变模型消息的呈现，不另增寻址字段；steer 字段与批次基线按前述接口和数据政策处理。

## 工程结构

| 路径                 | 内容                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `apps/web`           | Vue 3、Vite、shadcn-vue、Tailwind CSS、TanStack Vue Query。           |
| `apps/server`        | Fastify、SQLite/Drizzle、通用 Runtime、harness 契约与 Codex adapter。 |
| `packages/contracts` | Zod 运行时校验和前后端共享协议类型。                                  |
| `packages/config`    | Node 专用 TOML 配置解析、路径定位和 Codex 路径保存。                  |
| `tests/e2e`          | Playwright 浏览器链路验证。                                           |
| `docs`               | 需求、架构与实施计划。                                                |

- [需求文档](docs/requirements.md)
- [架构设计](docs/architecture.md)
- [Harness 适配层验收](docs/harness-adapter-acceptance.md)
- [Steer 投递验收](docs/steer-delivery-acceptance.md)
- [实现计划](docs/implementation-plan.md)
- [M2 实施计划](docs/m2-implementation-plan.md)
- [消息协议](docs/message-protocol.md)
- [名称消息验收](docs/name-message-acceptance.md)
- [基础修复与验收](docs/foundation-repair-plan.md)

本项目后续开发直接在 `main` 修改，完成相应检查后提交并 push，不另建功能分支、不走 PR 流程。提交遵循 conventional 规范；如用户另行要求使用分支，分支同样遵循 conventional 规范，不使用 `codex/` 前缀。shadcn-vue Button 源码的上游许可见 [组件许可](apps/web/src/components/ui/LICENSE.shadcn-vue.txt)。
