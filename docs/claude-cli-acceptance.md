# Claude Code CLI 接入与验收

日期：2026-10-08。用户恢复 Claude 接入，并确认创建时发送中性用户消息解决空 session。当前注册 Codex 与 Claude Code CLI，复用同一 Runtime、聊天、权限和存储。

## 1. 实现

| 模块                                   | 职责                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/claude/executable.ts` | 显式路径、PATH、原生本地安装与 Homebrew/npm/pnpm 发现；版本验证；Windows JS launcher 通过 Node 执行。                   |
| `claude/client.ts`                     | 常驻双向 stream-json、控制响应、主线程输入确认与撤回、问题回交与所属进程关闭；stderr 排空，不保存。                     |
| `claude/adapter.ts`                    | UUID 创建/恢复、中性初始化、实际规则来源与 MCP 连接校验、执行事件和 AskUserQuestion 转换；同执行 steer 与结束竞态处理。 |
| `claude/environment.ts`、`catalog.ts`  | 共享原生 home/认证/配置；维护 CLAUDE.md 导入；原生模型与 effort 目录；缓存刷新和脱敏。                                  |
| `packages/config`、HTTP API、Web       | 独立 Claude TOML/环境覆盖和路径设置，创建页面切换真实已注册 harness，模型与能力按目录显示。                             |
| `app.ts`、`mcp/server.ts`              | preClose 清理原生进程和 MCP transport，避免长连接阻塞 HTTP 关闭；随后释放数据库及数据目录锁。                           |

路径优先级：`ISLES_CLAUDE_BIN` > `[claude].binary_path` > 自动发现；home 优先级：`ISLES_CLAUDE_HOME` > `[claude].home` > `CLAUDE_CONFIG_DIR` > `~/.claude`。新增 `GET/PUT /api/claude/config`，只修改对应的 binary_path，与 Codex 保存共用文件写入队列，保留最新磁盘字段。模型目录从原生 initialize 响应读取；`default` effort 表示沿用原生设置，其他等级使用 CLI 返回的支持值。

原生进程保留用户配置、认证、插件、skills、用户 MCP 和记忆，仅通过启动参数追加当前 Agent 的 Isles HTTP MCP，token 用环境变量展开。CLAUDE.md 的托管段仅导入 `@AGENTS.md`，其他用户内容保留；原生 get_context_usage.memoryFiles 以真实路径验证两份文件已经加载。

## 2. Session 与消息

创建时先保存 UUID，然后向原生发送：

```text
Isles session initialized. Reply only READY. Do not use tools or send messages.
```

初始化会实际调用一次模型；PreToolUse 回调在该阶段拒绝工具调用，防止初始化发布正式消息或执行工作。成功后 Agent 就绪，初始化结果只在 adapter 内处理，Isles 消息和 run 均为零。失败保留已分配的绑定并显示原因；恢复只使用原 UUID，原生记录不存在时明确报错。

普通输入将平台 run UUID 传为原生用户消息 UUID，用 replay/started 确认和 result.user_message_uuid 关联原生执行。旧输入的结果不能结束当前 run；超时、断连和结果不明保留平台语义。AskUserQuestion 关联对应工具和当前输入 UUID，转换为 Web 问题，答案回交原控制请求；过期请求拒绝。正式消息只经 Isles MCP，原生文本与工具输出展示为执行详情。

Claude 声明 steer，按 Agent 默认关闭；关闭时忙碌排队，开启时向同一执行追加批次 UUID。主线程 replay/started 或 result 的消费 UUID 列表确认接受；原生 queued 表示排队，平台继续显示投递中；收到 queued 回执后等待执行边界，长工具运行不触发输入传输确认超时。当前执行先结束时使用 cancel_async_message 撤回尚未消费的输入，明确撤回后排到下一轮；撤回失败、超时或断连时关闭所属进程并向 Runtime 报告待核对。停止使用 interrupt(cancel_queued: true) 清理原生队列。MCP 主动 receive_messages/read_messages 保持原语义。原生执行采用全权限模式，原生问题可在 Web 回答。数据库结构、固定绑定键 `(harness, nativeHome, threadId)` 和公共 threadId 字段保持既有语义。

## 3. 首次 CLI 接入的自动化与浏览器验收

- `pnpm check`：格式、ESLint、类型检查、185 项测试和生产构建通过，2 项条件跳过为 Windows 进程树用例及可选 Codex 类型生成。
- CLI 线协议测试用独立 Node stdio 进程模拟已捕获的 2.1.285 帧，覆盖无模型目录查询、认证、UUID 先保存、中性初始化、禁止初始化工具、加载校验、MCP、同 ID 恢复、旧结果过滤、问题回交、停止及断连。
- 配置/API 测试覆盖 Claude/Codex 独立保存、并发写入、环境优先级、路径重启保留、检测缓存失效和 unsupported steer 拒绝。
- MCP 关闭回归持有真实 HTTP SSE 流，验证应用关闭无需等待外部客户端主动断开。
- `ISLES_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e`：17 项全部通过；新增用例覆盖 harness 切换、独立路径设置、模型/effort、steer 禁用、私聊、同 ID 停止/恢复和混合群聊。浏览器模型执行为测试 wire 模拟，REST/SSE/MCP/storage 为真实链路。

## 4. 原生验收

命令：

```sh
pnpm --filter @isles/server exec tsx test/verify-native-claude.ts
```

环境：macOS arm64、Node.js 26.8.2、pnpm 12.4.1；Claude Code `2.1.285`、原生默认模型配置、high effort；Codex `0.159.2`、`gpt-6.1-sol / high`。本次具体安装版本均由原生目录读取，与旧文档的其他环境基线分别记录。

最终成功报告：`/var/folders/pn/j5nzy9z97cq0h_0df57g2kj80000gp/T/isles-native-claude-ZVF43S/report.json`。北京时间 13:31:29–13:32:18。使用全新临时 Isles 配置、数据、workspace 和随机端口，原生认证使用用户现有配置。

| 验收       | 结果                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| 中性初始化 | 成功；Isles 正式消息 0，run 0；原生绑定 `612c2bdb-3045-4599-95d4-b9c26ce0adb7`。                  |
| 私聊       | Claude 通过实际 Isles MCP 发布指定确认内容，原生回合正常结束。                                    |
| 停止/恢复  | 停止期间用户消息排队，恢复后处理；保留同一 UUID。                                                 |
| 原生问题   | 实际 AskUserQuestion 到达平台，Web 回答正确回交原请求，Claude 继续通过 MCP 回复。                 |
| 改名       | 下一次连接加载更新规则，原 UUID 保留。                                                            |
| 混合群聊   | Claude 与 Codex 在同一群经 MCP 正式回复；Codex thread 为 `01a119ff-1b01-7861-ac39-9a7659fc7570`。 |
| 服务重启   | 恢复原 Claude UUID，在新监听端口重新连接 MCP 并正式回复。                                         |
| 删除       | 停止并从联系人移除，保留私聊和群聊历史。                                                          |

早期验收脚本的群创建请求/状态断言与现有 API 不一致，已按 memberIds/201 修正；此前成功的单项不替代这份完整成功报告。联调还复现了原 onClose 顺序在 MCP 长连接下等待的问题，现由 preClose 与 transport 清理修复并回归验证。

## 5. 验证范围

真实验收覆盖本机 Claude/Codex 的基础闭环。Windows 的启动路径与 npm launcher 由模拟测试覆盖，Claude 的 Windows 进程树释放与真实运行尚需实机验证；上下文压缩、原生子代理、多提供方模型、CLI 后续版本和长时间运行需独立验证。Claude 实时追加的补充验收见第 7 节。

## 6. 原生参考

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)：stdio 输入输出、session ID、resume、MCP 与权限选项。
- [Headless](https://code.claude.com/docs/en/headless)：原生配置加载、事件和程序化执行。
- [Memory](https://code.claude.com/docs/en/memory)：CLAUDE.md 原生导入 AGENTS.md。
- [官方 SDK 控制协议实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)：initialize、控制请求、原生问题和输入关联；本实现直接驱动安装的 CLI。

## 7. Claude steer 接入与补充验收

2026-10-08 用户授权接入 Claude steer。创建、编辑和详情中的开关现可用于 Claude，默认仍关闭；切换只修改偏好，固定 session、原生进程与聊天业务保持既有语义。使用双向 stream-json 的批次 UUID 追加输入，在工具结束后的继续执行中消费；原生正在运行的工具可以正常完成。

- adapter 校验 session、原 run 与批次身份；只接受主线程 replay/started 和 result 消费列表的确认。追加后的工具、AskUserQuestion 和结束事件归属原 run。
- 原执行先结束时撤回尚未消费的输入，原生明确撤回或未消费的 cancelled 事件允许退回平台队列；结果不明时关闭所属进程并报告待核对，释放 Runtime 的执行等待。
- 停止同时取消原生队列，平台已取消的消息保持取消；恢复继续使用原 UUID。
- 沿用 Runtime、steer_batches 和 Web 能力开关，数据库结构保持当前基线。

| 验证                | 结果                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`        | 格式、lint、类型、199 项测试和生产构建通过；2 项条件跳过与首次 CLI 接入相同。                                                                                                  |
| Claude 协议模拟     | 同 run 追加、消费列表确认、追加 UUID 结果/提问、queued 与子代理回显、错误身份、重复批次、停止、完成抢跑撤回、撤回失败、迟到 ACK、断连、确认超时及超过传输超时的已排队等待。    |
| Claude REST/Runtime | 开启时追加消息完成于原 run，关闭时在同 session 排到下一 run；偏好-only 编辑保持原生连接。                                                                                      |
| Chrome/Playwright   | `ISLES_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e`：18 项通过，包括 Claude 开关、投递中状态、同 run MCP 回复及偏好重载。REST/SSE/MCP/storage 为真实链路，模型执行为 wire 模拟。 |
| 真实 Claude CLI     | `2.1.285`，macOS arm64，原生 default 模型与 high effort；三种来源追加、停止/恢复和服务重启验证通过。                                                                           |

真实验收命令：

```sh
pnpm --filter @isles/server exec tsx test/verify-native-claude-steer.ts
```

报告：`/var/folders/pn/j5nzy9z97cq0h_0df57g2kj80000gp/T/isles-native-claude-steer-08krmg/report.json`，北京时间 15:48:01–15:49:06，`success=true`。使用全新临时 Isles 配置、数据、workspace 和随机端口，共用原生认证与用户配置。

- 固定 Claude UUID `5e46a9ba-fa02-4a70-b957-6923f5f64538`；首个 run/turn `6c763c26-58b9-41a6-a873-5534552ebbe4`，只有一个原生最终 result，终态 completed。
- 私聊用户、群聊用户和经真实 MCP 认证的 peer 三种来源进入两个 accepted 批次，全部归属原 run；正式 MCP 回复准确包含三个不可预知值，没有调用收件箱/历史工具，peer 没有模型 run，等待工具正常完成。
- 第二次执行中停止尚未消费的原生追加输入，平台投递保持 cancelled；恢复使用原 UUID，输入没有自动重投，新的正式 MCP 回复成功。
- 两次服务重启分别保留开启、关闭偏好，均恢复原 UUID；偏好-only 修改没有启动新原生进程。

另对同版本 CLI 独立探测 cancel_async_message：运行工具期间撤回 queued 输入，原生发布 cancelled 并返回 cancelled=true，原任务正常完成。原执行结束与追加交错、撤回失败及确认超时通过协议模拟验证；Windows 实机、上下文压缩、原生子代理和长时间运行沿用第 5 节的验证范围。
