# Kimi Code 本地 Web 接入

2026-10-10 用户确认将 Kimi 从 ACP 切换为 CLI 本地 `kimi web` 服务接口，保留原 session、模型和共享登录，增加 steer 与原生子代理进度。

## 接口与运行

- 按 Agent 运行独立的 `kimi web --no-open --host 127.0.0.1 --port 0`。CLI 发现和 home 设置保持原配置；启动 URL 与 token 只用于本机连接和脱敏，不写执行详情。
- 原生 REST 响应校验 envelope 的 `code`；WebSocket 等待 protocol 2 handshake 和 session subscribe ACK，使用 snapshot 的 cursor 过滤历史及重复事件。断连或内容缺口保留结果待核对。
- 创建先保存原生 ID；恢复核验同 ID 与 cwd。创建、恢复、模型目录和初始化不调用模型。此前 ACP 会话由同一原生存储按 ID 恢复，无数据库迁移或 ACP fallback。
- 工作区 `.kimi-code/mcp.json` 只维护 `isles` 项，保留其他条目；`bearerTokenEnvVar` 读取每个进程自己的 token。通过原生 workspace trust 加载，用户全局配置由原生维护。
- `AGENTS.md` 由 Kimi 原生加载。恢复保留既有系统提示快照；规则更新遵循 Kimi 自己的刷新与提醒机制。

## 输入、steer 与事件

- 自有 prompt 使用 `isles-<Agent UUID>-<run/batch UUID>`，便于明确识别并取消尚未消费的原生排队输入。主 Agent 的消费事件确认初始投递；请求结果不明不会自动重投。
- steer 先将输入加入原生队列，再调用 `prompts:steer`；同一目标 turn 的 `prompt.steered` 事件确认追加。接口没有客户端 `expectedTurnId` 原子参数，adapter 核对活动 prompt、目标 turn 和消费归属；跨执行边界保留待核对，并清理自有未消费队列。
- 主 turn 的结束结算 Isles run。原生子代理的思考、工具、模型、身份与生命周期记录在主执行详情中；子代理的完成和用量不覆盖主 run 与主上下文。主 turn 结束后的后台子代理活动不追加到已完成 run。
- 原生单选、多选、自由填写与计划确认转为 Isles 问答；答案按选项 ID 回交，取消与关闭处理原生待答请求。
- 上下文来自正式 snapshot/status API；公开协议未提供测量标识，按估算展示，窗口来自原生模型目录。
- 原生子代理模型使用 Kimi profile 配置，Isles 保持所选主模型和 thinking 等级。

## 验证

`harness-kimi-web.test.ts` 与 `kimi-app.test.ts` 使用真实 HTTP/WebSocket fixture 验证目录、创建/恢复、MCP 保留、主/子事件隔离、问答、输入确认、steer、跨执行边界、停止清理、服务重启与上下文重置。通用 ACP 的 conformance 测试保留 test-only harness，产品默认注册只使用 Kimi Web。

Chrome Kimi E2E 覆盖默认关闭 steer 的排队、主问答、同 run steer、子代理进度与子代理多选问答；REST/SSE、SQLite 和 Isles MCP 使用真实实现。

`verify-native-kimi-web-protocol.ts` 使用本机 Kimi 2.1.1、独立 home 和本地 provider，验证：

- 原生模型/thinking 目录、空 session 创建及同 ID 恢复；ACP 创建的空 session 可由 Web 按原 ID 恢复。
- 原生系统提示完整包含工作区 `AGENTS.md`；Isles MCP 工具实际可见。
- 用户 home 和已有 Agent 不参与验证；原生配置保持一致，provider 推理请求计数为零。
- 连续两个以上原生心跳周期保持连接，控制帧不进入执行详情。

2026-10-10 该原生协议验证通过，报告在运行脚本输出的隔离目录中。真实模型的生成速度、活跃 steer 和混合群协作未在本次协议验证中调用；此前 ACP 的真实模型验收见 [历史记录](kimi-acp-acceptance.md)。

## 原生依据

- [Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)：REST、WebSocket、prompt、steer、原生交互与事件。
- [CLI 参数](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)：本地 web、随机端口与多实例。
- 实现依据本机 `@moonshot-ai/kimi-code` 2.1.1 及其正式 OpenAPI/AsyncAPI；不使用 debug 反射接口。
