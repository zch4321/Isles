# OpenCode 原生 v2 接入验收

2026-10-09 用户确认：先集中 harness 目录，再接 OpenCode；DSH 等本轮 review 后接入。

## 实现

- 目录重构单独提交 `1063fdb`：既有 Codex、Claude、ACP、Kimi 放入 `apps/server/src/harness/`，公共发现、进程关闭与目录缓存放入 `shared/`。
- OpenCode 直接运行本机 CLI `serve --stdio --hostname 127.0.0.1 --port 0`，使用原生 v2 HTTP/SSE；每位 Agent 独立进程和固定 `ses_` ID。创建不发消息、不调用模型。
- 原生配置目录采用 `ISLES_OPENCODE_HOME`、TOML、`OPENCODE_CONFIG_DIR`、XDG 配置目录的优先级；认证和 session 继续使用原生 `OPENCODE_DB`，默认 `~/.local/share/opencode/opencode.db`。不写用户配置，进程级 JSONC 配置覆盖加入该 Agent 的 Isles MCP bearer。
- 原生 integration API 确认插件启动完成后读取模型；`provider/model` 保留提供商身份，推理等级映射为模型 variant，`default` 不添加 variant。原生目录中的可用模型包含免登录免费模型，不证明远端账号或模型请求已经成功。
- `/api/event` 的 `server.connected` 是订阅就绪边界。只把绑定 session 的已提交 execution 和 inbox 事件转为平台回合及接收确认，HTTP 入队响应自身不结算投递。模型文本、推理、工具及原生文本/多选问题归入既有执行详情。
- `steerEnabled` 默认关闭；开启后用稳定批次消息 ID 投递，在下一执行步骤边界接收。没有原生 expectedTurnId 原子条件，因此核对 execution 身份；跨回合、断流和未知结果进入待核对，关闭所属连接，不自动重投。
- 停止等待已发入队请求结算后取消尚未消费的自有输入，调用原生 interrupt 并关闭进程。停止期间的输入取消属于确定拒绝；已取消平台投递保持取消状态。

## 原生协议中的两处细节

OpenCode v2.0.25 CLI 的 Bus 默认 `persist=false`，`serve` 没有启用事件归档的参数、环境变量或 JSON 配置。session 及消息投影仍持久保存，但 `session/log` 只有同步标记，不能作为该 CLI 的执行事件来源。实时事件仍包含原生事件 ID 和提交序号；失去实时连接时不假定任务结果。

初始 `server.connected` 帧没有 `created` 字段，不能按普通事件结构解析。CLI 版本输出为 `opencode v2.0.25`。两者均有回归测试。

## 自动化

- 目录重构：`pnpm check` 通过，244 项测试通过、2 项条件跳过。
- OpenCode：新增 35 项 adapter、REST 与 SSE 测试。覆盖订阅就绪、模型目录启动竞态、固定 session、按回合切换模型/variant、输入与回合身份、已提交回执优先于迟到 HTTP 错误、明确拒绝、未知结果、事件去重、原生表单、在途停止和创建期间停止。
- 完整检查：283 项测试通过、2 项条件跳过；格式、lint、类型检查与生产构建通过。
- Chrome 完整 E2E：23 项通过，包含 OpenCode 创建、默认关闭 steer、MCP 正式回复、同 session 停止恢复、多选回答和同一执行追加。

## 本机原生验证

环境：macOS，本机 `opencode v2.0.25`。验证使用独立 Isles TOML、数据库和工作目录，监听随机本机端口，保留用户原生配置与认证数据库。

已经确认真实模型目录、MCP 连接、无模型调用的 session 创建，以及 execution/inbox 事件和提供商错误的正确结算。订阅配置前，原生目录返回 11 个免费模型；默认 `opencode/exo-free` 请求返回 `Model exo-free has been deprecated.`；显式选择 `opencode/step-5-preview-free` 返回 `OpenCode's free tier can only be used from within OpenCode`。两次执行均在 Isles 显示失败及原生原因，没有被误记为成功。

真实 CLI 配合本地脚本提供商的完整链路已通过：项目 `AGENTS.md` 原生加载、私聊/群聊 MCP 正式消息、原生 question 工具及答复、固定 session 停止恢复、终端等待期间追加到同一 execution/run 并完成原任务、服务重启后恢复原 session。提供商只脚本化模型返回；CLI、HTTP/SSE、MCP、终端工具、原生表单、存储与 Runtime 均为真实实现。最新验证共 22 次提供商请求，`report.json` 中全部检查通过。证据目录：`/var/folders/pn/j5nzy9z97cq0h_0df57g2kj80000gp/T/isles-native-opencode-ASV0c1/`，其中 `report.json` 为结论、`server.log` 为脱敏日志、`data/isles.sqlite` 为平台事实。

2026-10-09 用户添加订阅后，原生目录返回 72 个已启用模型，默认模型为 `opencode-go/claude-haiku-5-5`。使用该真实远端模型及默认 variant 完整验收通过：私聊与群聊 MCP 正式消息、原生问题与答案、固定 session 停止恢复、终端 `sleep 12` 期间追加输入到同一 execution/run 并完成原任务、服务重启后恢复原 session，用户原生配置文件校验保持一致。本次没有脚本提供商，`report.json` 的模式为 `real-cli-with-native-provider`，`passed` 为 `true`；证据目录：`/var/folders/pn/j5nzy9z97cq0h_0df57g2kj80000gp/T/isles-native-opencode-Wk17GH/`，同样包含结论、脱敏日志与平台数据库。真实远端模型的成功验收已完成。

OpenCode 原生 MCP 通过 CodeMode `execute` 提供，调用方式为 `tools.isles.send_message(...)`；工具索引在 MCP 建立后异步更新，原生 `search` 和规则更新可观察其变化，本轮保留原生机制。验收脚本为 `apps/server/test/verify-native-opencode.ts`，本地模式通过 `ISLES_TEST_OPENCODE_LOCAL=1` 开启，不修改用户文件；远端模式可用 `ISLES_TEST_OPENCODE_MODEL=provider/model` 明确选择模型。

## 来源

- [OpenCode v2.0.25 原生会话 API](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/protocol/src/groups/session.ts)
- [原生已提交事件与归档开关](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/core/src/bus.ts)
- [CLI server 启动及 stdio 关闭](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/cli/src/server-process.ts)
- [事件订阅就绪标记](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/server/src/handlers/event.ts)
- [目录查询等待插件启动](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/server/src/handlers/integration.ts)
