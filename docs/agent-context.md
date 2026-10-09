# Agent 上下文管理

2026-10-09 用户确认：在私聊管理该 Agent 的上下文，查看 token 用量、窗口大小与占用比例；仅在 Agent 空闲且没有待投递消息时允许新建会话。保留 Agent 身份、聊天记录、群成员关系和工作文件。

## 交互

私聊顶部和 Agent 详情提供“上下文”入口，展示最近一次原生报告的 `usedTokens / maxTokens`、占比和更新时间。估算数据标记“估算”；窗口未知时展示已用 token；用量未知时展示“等待用量更新”。统计的是当前保留的上下文，累计计费 token 不参与占比。

“新建会话”经确认后建立新的原生 session，私聊加入系统消息“已新建会话，后续消息使用新的上下文。”原有聊天和执行记录继续可读，新输入使用新 session。该 Agent 在私聊和所有群聊共用上下文，所以入口作用于整个 Agent。

新 session 继续加载工作目录规则、MCP 工具与原生共享配置、长期记忆。初始化沿用各 harness 已验证的机制，Claude 发送中性初始化消息。新上下文包含这些基础内容；原有聊天记录可由 Agent 主动读取历史。

Agent 执行、等待回答、创建或恢复时，先等待空闲或停止；有待投递消息时，先处理完消息。待投递检查包括暂停群里的排队消息。新建会话保持原来的运行或停止意愿，操作中到达的消息排队交给新 session。新会话初始化失败时展示错误并停止该 Agent，保留已经返回的原生 ID，后续恢复使用该 ID。

## 数据来源

| Harness             | 当前用量来源                                                                       | 窗口与估算                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Codex 0.161.0       | `thread/tokenUsage/updated.tokenUsage.last.totalTokens`，与原生 TUI 的窗口口径一致 | `modelContextWindow`；最近请求后的本地内容变化在后续报告时更新                                                           |
| Claude Code 2.1.285 | `get_context_usage` 的 `detail: summary`，读取 `totalTokens/maxTokens`             | 原生估算，显示估算标识；不调用逐类 token-count 接口                                                                      |
| Kimi Code 2.1.1     | ACP `usage_update.used/size`，原生每轮结束报告当前上下文                           | 原生当前 token count 与模型窗口                                                                                          |
| OpenCode 2.0.25     | 压缩后最新 assistant 调用的 input、output、reasoning、cache read/write 总和        | 原生 `limit.context`；普通摘要尚无新请求时使用原生字符密度估算；加密 `providerContext` 压缩后等待下一次用量报告          |
| DSH 0.2.0-rc.2      | 原生 `tokenMeter.measure(session).totalTokens`，反映当前 surface 与压缩            | `resolveModelInfo().context.contextWindow` 与后续 `request/context`；原生 estimated baseline 或 surface 增量显示估算标识 |

Codex 不取累计 `total`，OpenCode 不取累计 `session.usage.updated` 或压缩请求的计费用量，DSH 不将已经包含在 output 中的 reasoning 再次相加。各 adapter 过滤主 session，统计读取失败只记脱敏日志；Claude 的过期异步响应不覆盖新快照。

## 接口与持久化

- `GET /api/agents/:id` 增加 `contextUsage` 和 `pendingMessageCount`。用量快照包含 `sessionId`、`usedTokens`、可空的 `maxTokens`、`estimated`、`updatedAt`，整体可空。
- `POST /api/agents/:id/new-session` 等待新会话初始化成功，返回 Agent。执行中、等待输入确认、初始化中、待投递消息或并发管理操作返回 409；初始化失败返回 503。
- `HarnessEvent.context_usage` 独立于 turn 生命周期。Runtime 按当前连接过滤回调，Store 按当前 session ID 记录用量，支持明确的未知快照。
- 快照、切换前后 ID 与切换状态写入现有 `agent` 事件；私聊分界使用既有系统消息。数据库结构保持不变，正常服务重启后仍能读取当前 session 快照。
- Runtime 同步建立替换边界后关闭旧连接，初始化新的 session，并验证返回 ID 与连接仍然有效。切换期间管理操作互斥，旧连接的退出与迟到事件不改变新状态。服务关闭会结束初始化并收束任务。

## 验证

`agent-context.test.ts` 使用隔离的语义 adapter 验证用量持久化、会话过滤、压缩后下降与未知值、新 ID、历史/文件/群关系保留、运行和等待状态拒绝、暂停群待投递拒绝、停止意愿、并发输入和管理、旧连接回调、初始化失败、未确认创建以及关机。

各 harness 的协议模拟测试验证当前与累计用量区分、缓存和推理口径、恢复、压缩、未知窗口及统计失败。DSH bridge 测试直接验证原生 meter 调用和主/子 session 隔离。浏览器验证用量和占比、未知数据、确认、禁用条件、错误反馈及历史保留，使用独立的测试端口。

另以隔离的 DSH_HOME 对桌面版原生 SDK profile 进行纯初始化核验，确认默认启用 token-meter、服务实际存在，空上下文测量为零；该核验未创建 Agent 或发送模型请求。

本轮未通过实际模型请求验收所有 harness 的新增用量链路；当前算法依据已安装版本的接口、源码及对应原生 UI，后续版本按同一协议继续核对。

原生参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[OpenCode TUI 用量算法](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/tui/src/util/session.ts)、[DSH](https://github.com/deepseek-ai/deepseek-harness)。
