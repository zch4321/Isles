# 名称优先的 Agent 消息验收

日期：2026-10-03。普通消息优先显示名称，精确重名时附短 ID；完整 ID 用于目录查询、工具寻址和内部持久化。本轮不改变 Web 的现有名称界面、REST 对象或数据库 schema。

## 1. 消息与引用

```text
[channel: "评审群", seq: 12, from: agent:"Alice", reply_to: 10, mentions: "Bob"]
请检查接口。

[channel: "评审群"#abcdef12, seq: 13, from: agent:"Alice"#12345678]
同名群和同名成员用短前缀区分。
```

- 群名、Agent 发送者名和提及名使用 JSON 字符串。逗号、冒号、竖线、括号和引号不会拆开字段；换行和 U+2028/U+2029 转义后仍在同一头部行中。
- `user`、`system` 和 `agent:` 角色明确区分，自己的私聊仍为无引号 `private`。消息序号、回复和正文转义规则保持一致。
- 完全同名 Agent 在包含已删除作者的目录中消歧；群名只在接收 Agent 已加入的群中消歧。默认取去掉 UUID 连字符后的前 8 位，碰撞时逐位延长至唯一前缀。
- 自动输入、主动收信、历史和分页/截取标记共用同一份最新名称快照。改名影响重新格式化的历史，原始发送者和频道的内部 ID 不变；已有原生聊天文本不重写。
- `list_agents`、`list_channels` 及群管理结果继续返回完整 ID、名称与原有配置。工具参数只接受完整 UUID 或相应的 `private` 别名，不接受显示名称或短后缀。MCP `send_message` 成功只确认 `{ "seq": N }`，目标频道已由入参确定。
- AGENTS.md 首页使用名称与 `private`，不再单列 Agent ID 和私聊 UUID。工作区路径按内部 ID 定位，原生加载校验和托管段更新继续有效。

## 2. 代码入口

| 位置                                                              | 职责                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/server/src/runtime/envelope.ts`                             | 名称快照、精确重名分组、唯一短前缀、JSON 名称与消息格式。         |
| `apps/server/src/runtime/runtime.ts`                              | 自动输入从当前存储目录和成员频道取得名称快照。                    |
| `apps/server/src/mcp/server.ts`                                   | 收信/历史/分页采用同一格式；目录提供完整 ID，工具仍按 UUID 校验。 |
| `apps/server/resources/AGENTS.template.md`、`runtime/guidance.ts` | 持久规则、目录查找流程与省略独立 ID 字段。                        |
| `apps/server/test/guidance.test.ts`、`inbox.test.ts`              | 碰撞、转义、改名、历史作者、权限和实际 MCP 格式验证。             |
| `apps/server/test/helpers.ts`、`tests/e2e/server.ts`              | 独立的新协议测试解析器及模拟原生实例，用目录解析显示标签。        |
| `apps/server/test/verify-native-names.ts`                         | 两个真实同名 Agent/群的寻址、收信、历史和同 thread 重启验收。     |

显示名称不是身份凭据。生产代码不从消息正文或显示标签反推身份，不增加短 ID 寻址、不加入旧文本格式解析或数据迁移。

## 3. 检查

| 检查                                              | 结果                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm check`                                      | 格式、lint、类型检查、108 项测试和生产构建通过；设置 `ISLES_TEST_CODEX_BIN` 执行原生协议生成测试。 |
| `ISLES_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e` | 10 项 Chrome 浏览器测试通过，模拟原生实例按目录将名称标签还原到正确 UUID。                         |
| `verify-native-names.ts`                          | 两个真实同名 Agent、两个同名群、正式回复/提及、收信/历史及同 thread 重启通过。                     |

新增测试覆盖：同名 Agent/群的 8 位及延长前缀、名称大小写区别、已删除作者参与消歧、不可访问的同名群不影响标签、逗号/竖线/引号/换行/Unicode 分隔符、伪造正文头部、分页标记、改名后的自动输入与历史、目录仍返回 UUID、名称/短 ID 调用被拒绝以及 `{ seq }` 发送确认。

所有测试使用独立临时配置、数据和工作区，用户现有 Agent 不作为测试对象。

## 4. 真实 Codex 验证

```powershell
pnpm --filter @isles/server exec tsx test/verify-native-names.ts
```

入口创建两个同名 `gpt-6.1-sol / high` Agent，以及两个含标点的同名群。保留一位成员停止，另一位根据名称与短后缀查询目录，读取同名作者历史，然后用完整 ID 在指定群内回复与提及，最后通过私聊确认；随后核对暂停群主动收信和原 thread 重启。报告不保存 token 或认证凭据。

成功报告：`C:\Users\15384\AppData\Local\Temp\isles-native-names-GqBJkI\report.json`。版本 `codex-cli 0.160.0`，北京时间 20:19:06–20:19:26。

- 两个真实 Agent 均名为 `同名审查员, [Alpha] | "v1"`，两个群均名为 `同名评审群, [Beta] | "v1"`；消息输入和历史保留名称中的标点，并用不同短前缀区分实例。
- 运行中的 Agent 实际调用 `list_channels`、`list_agents`、`read_messages`，获得完整 ID 后在指定群内回复原成员消息，`replyTo` 和 `mentions` 均正确；另一个同名群没有收到 Agent 发言。
- 普通自动输入未重复完整群 ID 或作者 ID；历史和暂停群收信使用同样的名称标签，目录仍返回完整 UUID。
- 关闭并重新启动后，读者恢复原 thread `01a101b4-2b79-7ad0-8ac3-cf340dc41b85`，另一位成员保持停止；重新读取的历史一致。两次创建、一次恢复均确认加载各自工作区 AGENTS.md，用户 Codex 配置 SHA-256 前后一致。

规则文件的真实上下文压缩属于历史验收，本轮不重复声明压缩验证。
