# Harness 升级与统一原生活动模型

> 日期：2026-10-24 · 状态：五种适配器与统一原生活动模型已完成，检查和验收通过。

## 1. 版本与协议基线

本轮按 2026-10-24 的官方发布核对并更新五种 adapter；DSH 按用户选择采用 `0.2.1-rc.3`。

| Harness          | 基线         | 接口与依据                                                                                                                                                                                                             |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex            | `0.164.0`    | [app-server](https://learn.chatgpt.com/docs/app-server)、[发布记录](https://learn.chatgpt.com/docs/changelog)及该二进制生成的 TypeScript 协议                                                                          |
| Claude Code      | `2.1.310`    | [CLI 参考](https://code.claude.com/docs/en/cli-reference)、[官方 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)，双向 `stream-json`                                                      |
| Kimi Code        | `2.3.1`      | [`kimi web` 服务 API](https://github.com/MoonshotAI/kimi-code/blob/@moonshot-ai/kimi-code@2.3.1/docs/en/reference/server-api.md)，REST/WebSocket                                                                       |
| OpenCode         | `2.1.4`      | [原生协议源码](https://github.com/anomalyco/opencode/tree/v2.1.4/packages/protocol)、[npm 发布包](https://www.npmjs.com/package/@opencode/cli/v/2.1.4)，v2 HTTP/SSE                                                    |
| DeepSeek Harness | `0.2.1-rc.3` | [指定 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)及同版本 [SDK/核心类型](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/core)，原生 SDK 桥接 |

通用 ACP adapter 保持 [官方 v1 Latest](https://agentclientprotocol.com/protocol/v1/overview)；v2 当前为 Draft。Kimi 当前接入使用本地 Web API。

## 2. 已确认的运行模型

界面保留 Agent 和执行状态。`starting`、`running`、`waiting` 及各终态按原生活动更新；任务目标、产物与验收结果通过正式聊天和文件表达。

一个 Isles run 对应一个原生 turn、execution 或阶段。同一原生 session 的后续阶段各自建立 run，本轮以独立记录呈现。原生自行继续、后台任务、异步子代理和结果回注同样记录活动与输出；没有 Isles 输入的阶段使用 `inputs=[]`，显示为原生活动。子代理使用其原生 session/turn 身份，归属原 Isles Agent；平台消息仍投递给固定的主 session。

消息投递与活动结束分别保存：

| 投递状态                             | 含义                                     |
| ------------------------------------ | ---------------------------------------- |
| `queued`                             | 等待自动投递或 MCP 收信                  |
| `submitting` / `steering`            | 已发初始输入或追加请求，等待确切原生回执 |
| `accepted`                           | 原生确认消费，界面显示“已送达”           |
| `received`                           | MCP 收信或历史工具已返回该消息           |
| `failed` / `cancelled` / `uncertain` | 尚未确认投递的失败、取消或待核对结果     |

`accepted` 保留确定的送达事实。run 完成、中断、失败、待核对，以及停止、删除或新建会话均保留已送达记录；`delivery.completed` 已移除。迟到的确切 ACK 可将仍绑定原尝试的未知或取消投递订正为 `accepted`，保留 run 终态与 Agent 的停止状态。

steer 先记录批次及目标活动，再按确切消费回执关联实际原生活动。同阶段消费归当前 run，进入后续阶段则归该阶段的 run；原目标保留在批次审计中。HTTP 入队、排队通知与确切消费使用不同的结算时点。原生明确拒绝的输入退回队列，未知结果保留待核对，已经消费的消息保持已送达。

固定 session、停止和恢复保持既有规则：每个 Agent 的主 session 持久绑定；停止先保存停止意愿，再中断和关闭所属原生连接；新消息继续排队，显式恢复使用原 session。服务启动按期望状态恢复存活 Agent，手动停止和已删除的 Agent 保持状态。自主和后台事件持续归入各自原生活动，问题、审批和输出按活动身份关联。

## 3. 本轮适配修复

- Codex：补齐索引化 reasoning、plan 增量、`subAgentActivity` 与原生问题的回答、取消和失效生命周期，核对 `0.164.0` 生成协议。
- Claude：Windows npm/pnpm 发现改为包内 `bin/claude.exe`；复验初始化、模型目录、显式权限、规则文件、双向问题、steer、上下文控制和固定 session 恢复。各原生回合单独结束并记录。
- Kimi：识别 `40931` 为其他客户端占用时的明确写入拒绝，保留原生所有权并允许稍后重试；阶段、子代理与自主事件分别记录。
- OpenCode：支持分页尾页的 `cursor.next=null`；按 `inbox.delivered` 的实际 execution 关联追加消息与活动。
- DSH：适配工具参数及异步子代理事件，跟踪后台和自主 turn、原生消费回执与输出归属，采用用户指定的 rc.3 基线。

执行权限沿用显式 Agent 配置：Codex 默认 `workspace-write` / `on-request`，Claude 默认 `acceptEdits`，DSH 默认 `workspace-write` / `ask`，OpenCode 授权个人与共享目录并沿用其余原生规则。完整访问按各 harness 的原生模式配置；Kimi 两种配置均采用 `yolo`，原生问题和必要审批继续进入 Web。

Store 使用现有 runs、deliveries 与 steer_batches 表，增加按 Agent/session/turn 查找和观察活动的接口。移除投递完成枚举只影响 TypeScript 与合同定义，SQL 结构保持当前基线。首个 release 前继续按项目政策维护全新基线。

## 4. 验收

`pnpm check` 已通过：格式、ESLint、全工作区类型检查、569 项测试和生产构建完成；1 项 macOS 原生沙盒检查在 Windows 上跳过。Codex 类型生成检查使用真实 `0.164.0` 二进制执行。

完整 Chrome 浏览器套件 44/44 通过，覆盖消息送达、后台活动、自主唤醒问答、原生会话恢复和五种 harness 的页面流程。测试使用独立临时数据；`ISLES_TEST_SERVER_PORT`、`ISLES_TEST_WEB_PORT` 可指定测试端口，`--output` 可指定独立报告目录。

所有原生验证使用隔离 home 和临时 Isles 数据。创建、恢复与目录协议检查可以保持零推理；执行行为的模型响应由本地 provider 提供。

| Harness        | 原生验证内容                                                                                                    | 报告目录（系统临时目录下）            |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Codex 0.164.0  | 目录、MCP、AGENTS.md、固定 session 创建/恢复、历史初始化、推理与文本流、用量、steer、中断                       | `isles-codex-protocol-zn9hC8`         |
| Claude 2.1.310 | 目录、显式权限、规则加载、输入回执、问答、跨回合追加、后台子代理与自动唤醒、用量控制、中断、恢复；12 次本地请求 | `isles-native-claude-protocol-3izg5H` |
| Kimi 2.3.1     | Web 输入与输出、同回合追加、中断、双进程占用 `40931`、拒绝输入未入队及释放后复用该输入 ID；5 次本地请求         | `isles-kimi-web-input-5uWwBM`         |
| OpenCode 2.1.4 | MCP 私聊/群聊、问答、追加、后台子代理和自动唤醒的三条独立活动、固定 session 恢复、服务重启；26 次本地请求       | `isles-native-opencode-5EfIvc`        |
| DSH 0.2.1-rc.3 | 真实 SDK/桥接与 Runtime/SQLite 持久化三个独立活动、已送达事实、主回合空闲时停止后台子代理、固定 session 恢复    | `isles-dsh-native-runtime-N7WFht`     |

Kimi 的零推理协议检查还覆盖原生规则、MCP、心跳和 ACP 创建会话的 Web 恢复。独立协议脚本分别位于 `apps/server/test/verify-native-*-protocol.ts`；输入和后台活动入口为 `verify-native-kimi-web-input.ts`、`verify-native-opencode.ts`、`verify-native-dsh-async.ts` 和 `verify-native-dsh-runtime.ts`。脚本在完成时输出报告目录。

独立 review 发现并修复了停止后的迟到 steer 回执创建活动、后台活动期间配置刷新及调度重入问题；回归还覆盖回答与原生结束同时到达、Kimi 完成回调立即提交下一条消息、旧连接事件与陌生会话隔离。

本轮结果在本文汇总。此前各 harness 和阶段的 acceptance 文档保留当时的版本与验收事实。
