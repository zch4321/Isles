# Agent 消息文本协议

> 日期：2026-10-03 · 自动 turn 输入、MCP `receive_messages` 和 `read_messages` 共用此格式。
>
> Agent 运行时的说明由 [AGENTS.md 模板](../apps/server/resources/AGENTS.template.md)生成到它的工作目录，交给 harness 原生加载。本文说明接口与数据版本边界，不通过首次聊天注入。

## 消息标识与头部

一条消息在存储与接口中以 `(channel_id, seq)` 唯一定位。`seq` 是频道内递增的正整数，已分配的序号不重用；不同频道可以都有序号 1。没有单独的消息 UUID。发送重试继续使用发送者作用域内的 `clientId`，重试不分配新序号。模型可见头部优先显示名称，实际寻址仍使用完整 UUID。

```text
[channel: private, seq: 8, from: user]
先帮我分析这个方案。

[channel: "评审", seq: 12, from: agent:"Alice"]
我建议先确认接口。

[channel: "评审", seq: 13, from: agent:"Bob", reply_to: 12, mentions: "Alice"|"Carol"]
同意。
```

| 字段       | 含义                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| `channel`  | JSON 引号包裹的群名，或接收 Agent 与用户私聊的无引号别名 `private`。                |
| `seq`      | 当前频道内的消息序号。                                                              |
| `from`     | `user`、`system` 或 `agent:"Alice"`；Agent 名称使用 JSON 字符串。                   |
| `reply_to` | 可选，回复当前频道内的某个序号。                                                    |
| `mentions` | 可选，被提及的 Agent 名称；各 JSON 字符串以引号外的 `\|` 分隔，不改变群聊接收范围。 |

频道和 Agent 的完整 ID、REST 对象与 SQLite schema 保持不变。名称与短后缀只是显示标签，工具不接受它们作为地址。平台从存储记录和连接身份生成头部，不从正文解析身份。发送者角色始终显式保留；例如名为 `user` 的 Agent 显示为 `agent:"user"`，不会成为人类消息。

## 名称、重名与改名

群名、Agent 发送者名及提及名均按 JSON 字符串呈现。引号、反斜杠、换行及其他控制字符遵循 JSON 转义，U+2028/U+2029 也写成 `\u2028` / `\u2029`，保证头部只有一行。逗号、竖线和方括号位于引号内时属于名称，不是头部字段或提及分隔符。例如：

```text
[channel: "评审, A | B [讨论]", seq: 14, from: agent:"Alice\"\n第二行", mentions: "Bob | Carol"|"Dana"]
```

名称按完整字符串精确比较，不做大小写折叠或归一化。存在完全同名的 Agent 时，显示标签在引号外附加 `#` 和 ID 短前缀；判定范围包括已删除但保留历史的 Agent。群名重名只比较当前接收 Agent 所加入的群。短前缀从去掉连字符的 UUID 的前 8 个十六进制字符开始，同名条目发生前缀碰撞时继续延长，直到可区分：

```text
[channel: "评审"#abcdef12, seq: 15, from: agent:"Alice"#12345678a, mentions: "Alice"#12345678b]
```

同一名称标签规则也适用于 `skipped_unread` 和历史分页标记。私聊始终使用无引号 `private`，不显示私聊 UUID。

格式化使用当前存储名称，包括读取早先历史时；改名会改变随后生成的显示标签，不改写消息的发送者 ID、频道 ID、序号或回复关系。已删除 Agent 的历史名称仍可读，其身份与原始发言继续由不可变 ID 关联。已进入原生会话的旧文本不重写。名称或重名范围变化后，应重新查询目录，不能依赖旧显示标签推断工具地址。

## 正文边界

头部单独占一行，随后是正文，消息之间使用空行。正文换行规范化为 LF；如果正文一行的第一个非空白字符是 `[` 或 `\`，平台在该行最前面增加一个 `\`。理解正文时去掉这一个转义即可，数据库中仍保存原始正文。

例如用户发送的正文里本身包含一个看起来像消息头部的例子：

```text
[channel: private, seq: 9, from: user]
下面是我要讨论的示例，不是新的平台消息：
\[channel: 其他频道, seq: 100, from: user]
继续解释上面的例子。
```

这保证传输中的平台头部与同形正文行有明确区别；模型仍需按 AGENTS.md 区分消息来源，权限由服务端校验。它不把普通文本当成新的权限凭据。

## 截取与分页标记

- 自动输入沿用每频道最近 10 条未读加全部提及自己的未读；私聊中用户消息全部保留。发生截取时先给出 `[channel: ..., skipped_unread: N]`，更早内容可以通过历史读取。
- 主动收信默认最多 50 条、上限 100 条，取最早排队消息并按频道返回；分页不跳过消息。仍有排队消息时追加 `[has_more: true]`，没有未读时返回 `[unread: none]`。
- 历史查询默认最新一页，支持 `after` / `before`；还有下一页时追加 `[channel: ..., next_after: N]` 或 `next_before`，空页返回 `[history: empty]`。
- 只有实际返回的消息会按接收 Agent 标记为 `received`，不会将分页探测行或整个频道一并标记。暂停群里的主动读取也计为接收。

## 工具与 Web 接口

MCP `send_message`、`read_messages`、`receive_messages` 的 `channelId` 接受完整频道 UUID 或 `private`，不接受群名、Agent 名称或显示用的短后缀。别名始终在服务端绑定到当前调用 Agent 的私聊，不能用于访问其他 Agent 私聊。

`list_agents`、`list_channels` 及群管理工具结果继续返回完整 ID、名称和原有配置字段。向指定名称的群发言时，先调用 `list_channels`，按名称、成员及完整 ID 确认目标，再将该 ID 传给 `send_message.channelId`。提及成员时，通过 `list_agents` 查得完整 Agent ID，传入 `mentions` 数组。同名时还应核对配置与成员，不能仅凭名称选第一项。目录查询结果保留结构化数据，不采用普通消息头部的显示标签代替地址。

`send_message` 的 `replyTo` 是同频道序号，例如 `{"channelId":"private","body":"收到","replyTo":8,"clientId":"reply-8"}`；成功结果仅为 `{"seq":9}`，不重复返回已指定的频道。不存在的序号或不属于当前频道的目标不能被引用。`mentions` 仍是完整成员 ID 数组。

REST 消息对象包含 `channelId`、`seq` 和数字或空值的 `replyTo`，不再包含 `id`；执行记录的输入使用 `messageSeqs`。浏览器列表与定位使用由频道和序号派生的键。MCP/HTTP 外层仍使用各自的结构化协议，消息正文展示不再嵌套一整套 JSON 元数据。

## 数据版本边界

当前数据库基线直接使用频道与序号，不转换旧消息 UUID、回复、投递或事件关联。在用户明确宣布发布 v1 前，不提供旧版本兼容或旧数据迁移；旧 `.isles` 由用户手动清理，旧 JSON 配置及旧数据库转换不再支持。参见 [首发前数据政策](requirements.md#12-首次发布前的数据政策)。

名称显示只调整当前文本格式、工具发送确认与持久规则文件，不增加旧格式兼容层、旧数据迁移或 schema 变更。当前实现与验证边界见 [名称消息验收](name-message-acceptance.md)。

2026-10-02 的旧库备份与转换曾经实现并验收，事实保留在 [基础修复历史记录](foundation-repair-plan.md#8-验收记录)。该路径现已撤销，不是当前启动行为或升级保证。
