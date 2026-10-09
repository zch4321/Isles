# Kimi Code ACP 接入与验收

2026-10-08 用户确认接入 Kimi Code，并先实现通用 ACP adapter。本文记录实现、依据的原生事实、已知边界与验收结果。

## 1. 实现

- **准备性重构**（`7d42bc9`）：CLI 路径配置按 harness ID 组织为 `[codex]`、`[claude]`、`[kimi]`，环境覆盖为 `ISLES_<ID>_BIN` / `ISLES_<ID>_HOME`；路径接口统一为 `GET/PUT /api/harnesses/:id/config`，descriptor 的 `configuration` 统一为 `cli-path`。抽出共享的进程树关闭（`harness/process.ts`）、目录缓存（`harness/catalog-cache.ts`）与 npm CLI 发现（`harness/executable.ts`），Claude 发现改为调用通用实现。
- **通用 ACP adapter**（`apps/server/src/acp/`）：手写、zod 校验的 JSON-RPC 2.0 stdio 客户端，不引入 ACP SDK。`AcpHarness` 描述一个 ACP agent 需要提供的内容：descriptor、发现、启动参数、原生 home 环境、会话模式、认证检测、工作区准备与凭据脱敏。
- **Kimi 配置**（`apps/server/src/kimi/`）：`kimi acp` 启动，`KIMI_CODE_HOME` 指定 home，会话模式 `yolo`，`authenticate(login)` 检测已有登录；从 `config.toml`、`credentials/*.json` 与 `server.token` 学习需要脱敏的值。能力声明：恢复、中断、原生问答、原生子代理、MCP、工作区规则为是，steer 为否。
- **Web**：路径设置和模型目录按 harness ID 读取；执行详情新增“工具调用”“状态”条目类型。规则模板中的共享配置说明改为通用的原生 harness 表述。

## 2. Session 与消息

| 环节     | 行为                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 初始化   | 声明表单式 `elicitation`，不提供文件系统与终端；要求 ACP v1、HTTP MCP 及 `session/resume` 或 `loadSession`。                                             |
| 创建     | `session/new` 返回 `session_` ID 后立即保存；随后设置模式、模型、thinking 等级。新会话无需初始化消息即可恢复。                                           |
| 恢复     | 使用原 ID 的 `session/resume`（未声明时用 `session/load`，回放不进入 run）；ID 不存在时报告错误，不创建替代会话。每次连接重新应用模式、模型与 thinking。 |
| MCP      | `mcpServers` 中传入 `http://…/mcp/<agentId>` 与 `Authorization: Bearer <token>` 请求头。                                                                 |
| 提交     | 首个内容更新、权限或表单请求、prompt 响应确认接受；此前的 RPC 错误为确定拒绝，`-32600 turn.agent_busy` 在 60 秒内退避重试；断连保留结果不明。            |
| 结束     | `end_turn` 完成，`cancelled` 中断，`refusal` 失败，`max_tokens` / `max_turn_requests` 完成并注明原因；回合结束后的迟到更新不记录。                       |
| 条目     | 连续消息块、思考块各合并为一条；工具调用按 `toolCallId` 合并（更新只含变化字段，content 整体替换）；plan 作为单一条目刷新。                              |
| 权限     | 按全权限策略选择 `allow_once`，否则 `allow_always`；`AskUserQuestion` 的权限回退取消，由表单交给用户。                                                   |
| 问答     | 表单的每个字段对应一个 Isles 问题，选项值即标签，多选字段以数组回答；拒绝发送 `decline`，中断发送 `cancel`。                                             |
| 停止     | 取消未答表单，发送 `session/cancel`，并关闭原生进程。                                                                                                    |
| 模型目录 | 在 `<data_dir>/acp-catalog/kimi` 建立不发送消息的临时会话，逐个模型读取 thinking 选项后用 `session/delete` 删除。无 thinking 选项的模型显示 `default`。  |

## 3. 原生依据

Kimi Code 2.1.1（Homebrew，`@moonshot-ai/kimi-code`）。以下行为在本机用不调用模型的 ACP 探测直接确认：

- `initialize` 返回 protocolVersion 1、`loadSession`、`sessionCapabilities`（list/resume/close/delete/fork）与 `mcpCapabilities.http`；`kimi --version` 输出纯版本号 `2.1.1`。
- 已登录时 `authenticate({methodId: 'login'})` 返回 `{}`。
- `session/new` 返回 `session_<uuid>` 与 `model`、`thinking`（`thought_level`）、`mode` 三个配置项；thinking 选项随模型变化（例如 `low/high/max` 与 `on/max`）。
- `session/set_config_option` 返回完整配置项并推送 `config_option_update`；`yolo` 模式可设置。
- 未发送任何消息的会话在进程被 SIGKILL 后可由新进程 `session/resume`；恢复后模型与模式回到默认值，因此每次连接重新设置。
- 未知或已删除的 ID 恢复返回 `-32602 Unknown sessionId`；`session/delete` 删除会话目录并在索引中记为已删除。
- 目录探测前后 `~/.kimi-code/config.toml` 哈希一致。临时会话所在目录会在 Kimi 的 `workspaces.json` 中保留一条固定记录。

以下行为依据已安装包的源码确认：

- 问题以 `elicitation/create`（`mode: "form"`）发送：单选为 `type: "string"` + `oneOf`，多选为 `type: "array"` + `items.anyOf`，`const` 为选项标签，字段键为 `q0`、`q1`…；表单 `message` 按行列出问题。
- 表单请求失败时 Kimi 回退到 `session/request_permission`，问题选项的 kind 均为 `allow_once`，因此 Isles 对 `AskUserQuestion` 的权限请求不自动选择。
- 忙碌提交返回 `-32600`，`data.code` 为 `turn.agent_busy`。
- 工具调用 ID 为 `<turnId>:<toolCallId>`；消息块不带 message ID。

## 4. 已知边界

- Kimi 的 ACP 一次执行一轮，不支持 steer；忙碌输入排队到下一轮，执行中仍可通过 `receive_messages` 主动收信。
- Kimi 后台任务触发的回合与子代理活动不通过 ACP 转发，Isles 只记录由 Isles 发起的回合。
- 原生问题只能在给出的选项中回答。
- Kimi 2.1.1 会将部分模型请求失败报告为 `end_turn`，此类 run 显示为已完成。HTTP 400 已实测可能没有任何 ACP 输出，默认服务日志也无法取得失败原因；需要核对 Kimi 的原生会话记录。通用 ACP adapter 仅依据原生协议给出的终态结算。
- 取消后紧接着开始新回合时，Kimi 迟到的消息块可能计入新 run（消息块没有回合标识）。
- 规则文件依据 Kimi 文档从工作目录加载，运行时不额外校验。
- MCP token 写入会话参数，由 Kimi 按其会话记录方式保存。

## 5. 自动化与浏览器验收

- `harness-kimi.test.ts` 使用真实 stdio fake（`acp-fixture.ts`，按上述 2.1.1 形状实现）覆盖：发现与版本校验、目录（按模型读取 thinking、删除临时会话、未登录）、创建（MCP 请求头、设置顺序）、恢复与重新设置、未知 ID、模型不支持的推理等级、条目合并、忙碌重试、确定拒绝与结果不明、接受后退出、关闭时的待核对、单选/多选/拒绝问答、权限选择、中断与迟到更新、`session/load` 回放、缺少 HTTP MCP。
- `kimi-app.test.ts` 使用真实 `buildApp`：注册与能力、路径设置独立保存、steer 开启被拒、私聊 run、停止恢复同一 session、忙碌排队到下一轮。
- 浏览器测试新增 Kimi 创建、路径设置、steer 开关禁用、MCP 私聊回复与忙碌排队。
- 结果：`pnpm check` 通过（229 项测试，2 项跳过）；`ISLES_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e` 19 项通过。

## 6. 原生验收

`apps/server/test/verify-native-kimi.ts` 使用临时 Isles 配置、数据与工作区和随机端口，连接本机已登录的 Kimi Code。依次验证：目录与原生配置不变、创建不产生 run/消息、空会话停止后恢复、私聊 MCP 回复、忙碌排队、停止恢复同一 session、原生问答、Kimi/Codex 混合群（`ISLES_TEST_SKIP_MIXED=1` 可跳过）、服务重启后恢复同一 session，以及保留历史的删除。

```sh
pnpm --filter @isles/config --filter @isles/contracts build
pnpm --filter @isles/server exec tsx test/verify-native-kimi.ts
```

可用 `ISLES_TEST_KIMI_MODEL` 指定模型。结果写入临时目录的 `report.json`。

2026-10-08 在 macOS 上以 Kimi Code 2.1.1（`kimi-code/k3`，thinking `max`）与 `codex-cli 0.161.0`（`gpt-6.1-sol`）运行，全部通过，用时约 2.5 分钟：

| 检查           | 结果                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 模型目录       | 4 个模型；`kimi-for-coding`、`k3`、`k3-256k` 为 `low/high/max`，`kimi-for-coding-highspeed` 为 `on/max`；原生 `config.toml` 哈希不变。 |
| 创建与空会话   | 创建不产生 run 或消息；未发送消息即停止，恢复后为同一 `session_` ID。                                                                  |
| 私聊           | Kimi 通过 Isles MCP（会话参数中的请求头）向 private 发送 `KIMI_PRIVATE_OK`。                                                           |
| 忙碌排队       | `sleep 20` 执行期间的新消息状态为 queued，下一轮在同一 session 中处理并回复 `KIMI_QUEUED_OK`。                                         |
| 停止与恢复     | 停止期间的消息在恢复后处理，session ID 不变。                                                                                          |
| 原生问答       | `AskUserQuestion` 以表单到达 Isles（标题“颜色”，选项“蓝色/绿色”），Web 答案回交后 Kimi 回复 `KIMI_QUESTION_OK蓝色`。                   |
| 混合群聊       | Kimi 与 Codex 各自在群内只回复一次。                                                                                                   |
| 服务重启与删除 | 关闭服务后重新启动，恢复同一 session 并回复 `KIMI_RESTART_OK`；删除 Agent 后历史保留。                                                 |

执行详情中，连续消息块与思考块各合并为一条已完成条目；Shell 显示为命令执行，Isles MCP 与 `AskUserQuestion` 显示为工具调用，均包含输入与输出。8 个 run 全部完成，无错误。

## 7. Review 修复

2026-10-09 修复三处接入问题：

- prompt 响应的校验异常与传输错误统一关闭当前连接，并将输入保留为结果待核对；收到首个更新后的异常同样结算，正常停止保持原有关闭语义。
- Kimi 在切换模型后可能保留不受支持的 thinking 值，并把它追加到选项中。目录探测在临时会话中显式设置当前 thinking 值，剔除原生明确拒绝的值；创建与恢复也显式验证 Agent 配置的 thinking。
- 问题契约保留 `multiSelect`，Kimi 与 Claude 原生多选在 Web 使用复选框，至少选择一个答案后提交完整数组；单选请求只接受一个答案。

回归覆盖包括：接受前后的异常 prompt 结果、服务继续响应及投递待核对、thinking 值继承与明确拒绝、Web 多选提交和取消选择。

验证结果：`pnpm check` 通过（234 项通过、2 项跳过），Chrome E2E 19 项全部通过。本机 Kimi Code 2.1.1 的隔离目录探测确认：第二个模型只支持 `on/max` 时，目录剔除继承的 `high`，默认值为 `max`；该探测未发起模型请求。
