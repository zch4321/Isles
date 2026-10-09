# DeepSeek Harness 原生 SDK 桥接验收

2026-10-09 用户在 OpenCode review 后授权接入 DSH，随后确认复用已登录的桌面版，并采用原生桥接插件保留 steer。

## 实现

- 适配器位于 `apps/server/src/harness/dsh/`，桥接资源为 `apps/server/resources/dsh-bridge.mjs`。
- 本机验证基线为 macOS 桌面版 `0.2.0-rc.2`。自动发现 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，也支持用户 Applications、PATH 和既有路径设置；配置为 `[dsh].binary_path` / `ISLES_DSH_BIN`。
- `DSH_HOME` 依次采用 `ISLES_DSH_HOME`、`[dsh].home`、原生 `DSH_HOME`、`~/.dsh`。原生全局配置、SDK profile、认证及 session 存储继续由 DSH 管理；目录默认模型读取桌面 profile 保存的选择。
- 每位 Agent 独立运行 `dsh --profile sdk --patch <Isles overlay>`，保持独立工作目录和固定 session。overlay 由 Isles 保存，加载桥接、官方问答工具及该 Agent 的 Isles MCP；DSH 自带运行时提供全部原生依赖。
- 创建和恢复分别调用原生 `agents.create` / `agents.resume`。先保存固定 ID，恢复核对工作目录；创建不发初始化消息、不调用模型。原生 instruction 插件加载 `AGENTS.md`。
- 模型身份使用 `provider/model`，推理等级来自原生目录，下一次请求精确采用所选值。文本、推理、工具和原生问答复用平台的执行详情及表单。

## 原生执行与投递

标准 SDK 只有 `initialize`、`session/prompt` 和 `shutdown`；其 prompt 调用 `followup`。Isles 原生插件补齐固定会话操作、`steer`、中断、目录及问题答复，通过 DSH 自带 JSON-RPC transport 提供 stdio。

原生 session 的递增整数 turn 转为平台 turn ID。`steerEnabled` 默认关闭；开启后，桥接在同一同步段核对当前 turn 并调用 `agent.steer`，新输入在下一 step 进入该执行。RPC 返回仅表示入队；原生 `agent/inbox/claimed` 关联消费 turn，durable `user/message` 确认通过 pre-step 并进入该执行，随后平台才结算接收。事件序号及 stream attempt/revision 用于去重。

确定拒绝返回明确的结果，RPC 错误、断流或未知身份保留待核对。已提交消费事实优先于较晚到达的 RPC 错误。回合结束时撤销未消费的自有输入，以明确拒绝回执让平台继续下一轮排队。停止等待已发请求结算、撤销未消费的自有输入，再调用原生 cancel 并关闭进程；恢复清理断连遗留的自有输入。原生 dispose 继续负责其所属 Agent 的生命周期。

SDK profile 仅包含问答服务，Isles overlay 另行加载官方 `dsh-tool-ask-user`，使模型可调用 `ask_user_question`。Bridge 通过原生 waterfall 等待答案，映射为 native selected/custom；关闭与停止取消等待。DSH 原生问题服务要求 live root 调用，子代理需把待决定事项交回主 Agent。

## 自动化

新增 28 项 DSH adapter、REST 和实际 Node stdio 测试，覆盖模型身份和默认选择、固定会话、创建期间关闭、MCP 启动校验、入队与消费分离、steer CAS、拒绝与未知结果、去重、迟到 RPC 错误、问题映射，以及 stdio Unicode 分帧、凭据脱敏、malformed frame 和 shutdown。针对检查及 server 类型检查已通过。

新增 2 项浏览器流程，使用语义 native fixture 和真实 REST/SSE/MCP/SQLite，覆盖默认关闭 steer、私聊正式回复、同 session 停止恢复、多选答复和忙碌时追加到同一 run。

最终完整 `pnpm check` 通过：312 项测试通过、2 项条件跳过，格式、lint、全工作区类型检查和生产构建通过。Chrome 完整 E2E 25 项全部通过。

## 真实桌面版与账户模型

使用独立 Isles TOML、数据库、工作目录与本机随机端口，运行桌面版自带 CLI，复用已登录的 `deepseek-account`。原生目录返回 4 个模型条目；本次采用桌面版保存的 `deepseek-account/deepseek-flash`、`max` 推理等级。

真实模型完整验收通过：无模型调用的创建、私聊与群聊 MCP 正式回复、原生问答及答案、固定 session 停止恢复、终端 `sleep 12` 期间向同一 execution/run 追加输入并完成原任务、服务重启后恢复原 session。原生 home、桌面和 SDK profile 配置文件哈希保持一致。

证据目录：`/var/folders/pn/j5nzy9z97cq0h_0df57g2kj80000gp/T/isles-native-dsh-eO5Cey/`。`report.json` 的模式为 `real-desktop-cli-with-native-provider`、`passed=true`；`server.log` 为脱敏日志，`data/isles.sqlite` 记录 6 个 completed run、8 个 completed delivery、1 个 accepted steer 和已答复的原生问题。所有 4 次自有 SDK 进程均以退出码 0 结束。

验收脚本为 `apps/server/test/verify-native-dsh.ts`；可用 `ISLES_TEST_DSH_MODEL=provider/model` 明确选择另一原生目录模型。本次模型由真实服务返回，未使用脚本提供商。

构建产物的空 session 停止/恢复也通过，保持相同 ID、0 个 run；证据目录为 `/var/folders/pn/j5nzy9z97cq0h_0df57g2kj80000gp/T/isles-native-dsh-built-empty-dCZWkF/`。额外使用无法连接的 MCP 地址验证启动失败，Agent 明确报告 MCP 未就绪，threadId 保持 null、0 个 run；证据目录为 `/var/folders/pn/j5nzy9z97cq0h_0df57g2kj80000gp/T/isles-native-dsh-mcp-failure-0evM5L/`。创建前的连接检查要求原生 Isles MCP 工具实际注册，模型目录读取独立于该检查。

## 来源

- [官方 DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [官方 CLI profile 与原生 SDK 启动](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)
- 本机桌面版自带的 `dsh-sdk-protocol`、`dsh-agent`、`dsh-agent-loop`、`dsh-user-questions` 和 `dsh-llm`，版本均为 `0.2.0-rc.2`；桥接按该版本实际导出及行为验证。
