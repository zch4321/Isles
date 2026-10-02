# Agent 消息文本协议

> 日期：2026-10-02 · 自动 turn 输入、MCP `receive_messages` 和 `read_messages` 共用此格式。
>
> Agent 运行时的说明由 [AGENTS.md 模板](../apps/server/resources/AGENTS.template.md)生成到它的工作目录，交给 harness 原生加载。本文说明接口与迁移边界，不通过首次聊天注入。

## 消息标识与头部

一条消息以 `(channel_id, seq)` 唯一定位。`seq` 是频道内递增的正整数，已分配的序号不重用；不同频道可以都有序号 1。没有单独的消息 UUID。发送重试继续使用发送者作用域内的 `clientId`，重试不分配新序号。

```text
[channel: private, seq: 8, from: user]
先帮我分析这个方案。

[channel: 频道ID, seq: 12, from: agent:成员ID]
我建议先确认接口。

[channel: 频道ID, seq: 13, from: agent:另一成员ID, reply_to: 12]
同意。
```

| 字段       | 含义                                                                 |
| ---------- | -------------------------------------------------------------------- |
| `channel`  | 实际群聊 ID，或接收 Agent 与用户私聊的别名 `private`。               |
| `seq`      | 当前频道内的消息序号。                                               |
| `from`     | `user`、`system` 或 `agent:<Agent ID>`；名称和模型通过目录工具查询。 |
| `reply_to` | 可选，回复当前频道内的某个序号。                                     |
| `mentions` | 可选，被提及的成员 ID，以 `                                          | ` 分隔；不改变群聊接收范围。 |

频道和 Agent 自身的 ID 仍保持原有定义，本次只取消消息 UUID。平台从存储记录和连接身份生成头部，不从正文解析身份。

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

MCP `send_message`、`read_messages`、`receive_messages` 的 `channelId` 接受实际频道 ID 或 `private`。别名始终在服务端绑定到当前调用 Agent 的私聊，不能用于访问其他 Agent 私聊。

`send_message` 的 `replyTo` 是同频道序号，例如 `{"channelId":"private","body":"收到","replyTo":8,"clientId":"reply-8"}`；成功结果只包含 `channel_id` 和 `seq`。不存在的序号或不属于当前频道的目标不能被引用。`mentions` 仍是成员 ID 数组。

REST 消息对象包含 `channelId`、`seq` 和数字或空值的 `replyTo`，不再包含 `id`；执行记录的输入使用 `messageSeqs`。浏览器列表与定位使用由频道和序号派生的键。MCP/HTTP 外层仍使用各自的结构化协议，消息正文展示不再嵌套一整套 JSON 元数据。

## 已有数据升级

`0001_message_sequences` 在一个事务中转换旧消息 UUID、回复、投递和事件关联，保持频道序号、执行记录、接收状态及事件游标。旧 UUID 只存在于升级前的备份或原生历史中；新的模型输入和接口以频道与序号为准。

检测到旧消息表时，启动先用 SQLite `VACUUM INTO` 在同一数据目录生成 `isles-before-channel-seq-*.sqlite` 一致性备份。迁移遇到无法映射的引用时回滚并报告备份路径，不清空数据。发生失败时服务不会启动；修复原库中的异常关联后重试，或停服后将备份恢复到独立数据目录再处理。成功升级后不要用旧代码继续写新数据库；如需回退到旧代码，停服并使用升级前的备份。
