# 按 Agent 配置 steer：实现与验收记录

> 日期：2026-10-04 · 状态：实现与本轮验收通过
>
> 本文区分实现规则、模拟验证和真实原生验证。此前的 Harness 适配层验收不构成本次 steer 的原生证明，下面记录本轮取得的独立证据。

## 1. 已确定的产品行为

每个 Agent 持久保存 `steerEnabled`，创建时默认 `false`。用户可在创建、编辑或详情中控制“忙碌时实时接收（steer）”；支持 steer 的 harness 也允许关闭。`capabilities.steer` 是原生能力，开关是用户偏好，两者同时成立才自动追加。unsupported 禁止开启，Web 禁用且服务端独立拒绝；已有开启值仍允许关闭。只改变这一偏好不查询模型目录、不重启原生进程、不改 session，停止的 Agent 不会因修改而自动恢复。

| 情况                                  | 自动输入行为                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Agent 空闲且可以运行                  | 按既有立即唤醒策略，在固定 session 开始下一 turn。                           |
| Agent 忙碌，开关关闭或 harness 不支持 | 消息保持 queued；当前 turn 结束后合并剩余未读进入下一轮。                    |
| Agent 忙碌，支持且开启 steer          | 已有和新到达的可投递 queued 消息立即追加到同一个主 thread/turn，不另开执行。 |
| 关闭开关时已有 RPC 发出               | 后续消息排队；已发出的 RPC 继续按实际结果结算，不能当作撤销或回退。          |
| Agent 已停止                          | 继续保存消息但不自动执行，显式恢复后才处理。                                 |

追加文本沿用现有消息协议，保留频道、序号、发送者、回复和提及。原生 user input 角色不改变消息的真实来源，正文不能伪造身份。正式回复仍只通过 Isles MCP 发布。

## 2. 接收事实与故障边界

`steer_batches` 先保存批次、run/turn 和消息关联，再发出原生请求。原生确认前的消息状态为 `steering`，Web 显示“投递中”，与启动新 turn 的 `submitting` 区分。收到 ACK 只表示接受输入，不能作为工作完成或验收通过的证明。批次返回的 turn 必须符合已绑定当前 turn；迟到结果不得作用于后续执行。

| 结果                                        | 平台处理                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| 原生确认追加被接受                          | 关联原有 run，按该 turn 的实际终态推进，不能新建替代 turn。                          |
| Codex steer 的 `-32600`、`-32601`、`-32602` | 判定明确未被接受，消息退回队列；当前 turn 结束后进入下一轮，不在当前 turn 循环重试。 |
| 超时、断连、其他 RPC 错误或无法确认关联     | 保留结果待核对，不自动重投，也不假定原生没有执行。                                   |
| 服务在追加确认前关闭或重启                  | 保留批次与消息的未知结果，由最终恢复规则核对；不能自动重投。                         |
| 群消息已取消或连接已被替换                  | 较晚 ACK、结束事件和旧连接回调不能覆盖取消或影响新连接。                             |

这些确定拒绝代码仅描述 Codex steer 的分类，不扩大到所有原生错误或普通 turn 提交。其他 harness 的能力与错误语义需其 adapter 分别验证。

MCP `receive_messages` / `read_messages` 保持立即返回，实际返回的消息按接收 Agent 记为 `received`；没有新 wait 参数或阻塞等待工具。MCP receipt 不是任务完成，已被领取用于原生投递的消息也不能再作为 queued 未读重复收取。消息正文、分页标记和来源身份规则保持。

停止 Agent、暂停群、删除群及移出成员是不同控制操作。停止持久化停止状态并中断/关闭所属连接；暂停只阻止新的自动投递，主动读取仍可用；删除和移出撤销访问并按既有规则取消相关投递。已经发出的请求可能仍在原生侧执行，较晚回调不得恢复被取消状态；其他频道及主 session 不因一个群的控制操作被替换。

## 3. 实现范围与代码入口

| 入口                                                 | 责任                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`                    | steer 能力、默认关闭的创建偏好、编辑字段、Agent DTO 与 `steering` 投递状态。           |
| `apps/server/src/harness/types.ts`                   | 使用固定 session、expected turn 与批次身份追加；不把 Codex RPC 作为通用 Runtime 契约。 |
| `apps/server/src/codex/adapter.ts`                   | 原生追加与响应身份验证、确定拒绝代码分类及未知错误保留。                               |
| `apps/server/src/runtime/runtime.ts`                 | 每个 Agent 的开关、同 turn 追加互斥、开关变化、终态和旧连接竞态。                      |
| `apps/server/src/storage/` 与当前 `migrations/` 基线 | Agent 偏好、`steer_batches`、投递领取/接受/拒绝/未知结算、重启恢复。                   |
| `apps/web/src/components/`                           | 创建/编辑/详情开关、能力限制、queued/steering 状态及接收事实说明。                     |
| `apps/server/resources/AGENTS.template.md`           | 只写稳定机制与消息来源规则，不写每个 Agent 当前开关值。                                |

默认产品仍只注册 Codex。本次不接入新的 harness，不安装或恢复 Claude 接入计划。

## 4. 验收要点

- 创建默认关闭、显式开启/关闭、编辑与重载持久化；unsupported 开启在 UI 和服务端均被拒绝，已保存 true 仍可关掉。
- 偏好-only 编辑不取模型目录、不关闭当前连接；开启时忙碌 queued 立即追加，关闭时后续 queued 保留到下一 turn。
- thread/turn/Agent/连接与批次身份保持一致，主 turn 只有一条执行路径；私聊、多群、回复、提及和发送者来源保留。
- 在途 steering 不被 MCP 再取；立即返回、分页接收去重、暂停群主动读取行为保持；ACK 和 receipt 不显示成任务完成。
- 发出前持久化、接受后关联当前 run；明确拒绝退回下一轮，未知错误不重投。
- 开关关闭与 ACK 交错、turn 先结束、停止、服务关闭/重启、暂停/删除群、移出成员、旧连接回调等竞态保持终态和取消结果。
- 当前全新 schema 与基线一致；所有验证使用独立临时配置、data/workspace，不迁移或清理用户数据库。

## 5. 最终证据

| 证据                     | 本轮结果                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`             | 格式、lint、所有包类型检查、15 文件 166 项测试及 server/Web 生产构建全部通过。设置 `ISLES_TEST_CODEX_BIN` 运行真实 executable 检查，没有跳过项。Web 构建仍有约 508 kB 主包提示，不阻塞构建。                                                                                                              |
| Runtime 与存储回归       | [12 项调度测试](../apps/server/test/steer-runtime.test.ts) 与 [23 项存储测试](../apps/server/test/steer-storage.test.ts) 覆盖默认关闭、能力限制、偏好即时切换、串行追加、MCP 互斥、ACK/完成先后、停止/删除/重启和未知结果不重投；还覆盖初始 ACK 尝试改绑 turn，以及未领取的调度微任务不能造成关服待核对。 |
| Codex 协议模拟           | [9 项 adapter 测试](../apps/server/test/harness-codex.test.ts) 验证固定 expected turn、批次消息 ID、响应身份、RPC 错误码分类与在途请求关闭；不把其他错误视为明确拒绝。                                                                                                                                    |
| Chrome / Playwright      | `ISLES_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e`：16 项全部通过，保留原 13 项流程，增加开启/离线关闭与重载、能力消失后关闭，以及忙碌追加的 SSE “投递中”与同 run 正式回复。截图在 `test-results/`，包括 `steer-pending.png`、编辑与删除的移动布局。测试服务器使用临时 TOML，Vite/后端端口为 55173/54310。 |
| 当前基线生成与独立初始化 | `pnpm db:generate` 返回 10 表且无 schema 差异；`pnpm db:migrate` 成功初始化。临时配置：`C:\Users\15384\AppData\Local\Temp\isles-steer-db-15e60a72a9ad4c10a0fd5957ec8dcf5a\config.toml`；只有当前基线，无新增兼容或旧库迁移。                                                                              |
| 真实 Codex steer         | `pnpm --filter @isles/server exec tsx test/verify-native-steer.ts` 使用 `codex-cli 0.160.0`、`gpt-6.1-sol`、临时 data/workspace 与本机随机端口，报告 `success=true`。详见以下原生证据。                                                                                                                   |
| 原生回归边界             | 本轮真实验证规则加载、三来源输入、MCP 正式确认、空闲 peer 停止、同 thread 两次重启、开关持久化与原生配置 hash；未重跑上一适配层的两套完整原生验收脚本。原生问题、执行中停止与所有故障注入通过模拟/浏览器回归覆盖，不冒充本次真实证明。                                                                    |

原生报告保留于 `C:\Users\15384\AppData\Local\Temp\isles-native-steer-R505V2\report.json`，执行时间为 2026-10-04 03:00:12–03:01:06 UTC（约 54 秒）：

- reader thread `01a104da-d715-7331-ac9b-1a8d2c321d62`，唯一 run `c6f9f3e0-95cb-499e-b6d3-0ffaf63e8c6a`、turn `01a104da-dc31-7cf0-8fcb-0b4aeabde0ff`，终态 completed。
- reader 执行一条约 30.3 秒的等待命令期间，私聊用户、群聊用户与经真实 MCP 认证的 peer 分别发送不可预知标记；三个 `turn/steer` 的 expected/ACK ID 均等于原 turn，三个批次 accepted，三条输入 completed 并归属原 run。
- reader 只有一次 `turn/start`，peer 无模型 turn。MCP 工具记录只有三次 `send_message`（READY、peer 发言、最终 ACK），禁止且没有调用收件箱/历史工具；最终正式 ACK 准确包含三个来源的标记。
- 原生 `instructionSources` 包含各自工作区的 AGENTS.md。开关开启后重启持久化，随后关闭并再次重启持久化；两次恢复 reader 的同一 thread。
- 无活动 turn 的协议探测返回 `-32600 / no active turn to steer`。活动 turn 身份不符、其他拒绝码与超时竞态由协议/调度测试覆盖，没有宣称逐一真实注入。
- 用户 Codex `config.toml` 前后 SHA-256 均为 `95770354ae04769f4ccaab51b768398aff093ccf01b96686d74d95d7b1431874`。等待命令正常完成，steer 没有被当作立即中断命令的保证。

浏览器首次执行中，新验收 Agent 排在空库/固定联系人数量的旧测试前，导致 3 项测试 fixture 断言失败；将有数据的新增流程移到原流程之后，完整重跑 16 项通过。该失败来自测试共享数据的顺序，未通过修改产品行为绕过。代码 review 发现的初始 ACK 身份冲突与关服微任务误报均补了可复现回归后修复。

## 6. 数据版本与尚未覆盖边界

用户尚未宣布 v1，schema 更新当前全新基线，新增 Agent 偏好与 `steer_batches`；不实现旧库迁移、兼容分支或自动清库。旧版本数据由用户在停止旧服务后手动处理。同版本持久化及固定 session 恢复仍应验证，不能把“无旧版兼容”解释成可丢弃同版本投递结果。

只读核验现有默认 `C:\Users\15384\.Isles\data\isles.sqlite`：保留 7 个 Agent，尚无新字段与 steer_batches。本轮没有迁移、清空或用新代码启动该目录；本版本需当前基线的新数据库。个人与共享文件、旧数据库及原生 session 保留，由用户决定何时切换或清理。

未知原生结果不宣称 exactly-once；原生 ACK 不保证模型已经阅读或完成消息中的任务。后续 harness 必须分别证明追加能力、确认与错误语义，本稿不承诺其兼容性或支持状态。
