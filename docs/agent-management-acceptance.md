# Agent 基础管理验收

日期：2026-10-03。按用户要求补齐增删改查，前端继续使用现有详情面板、shadcn-vue 弹窗、表单和按钮。当前先采用保留历史与文件的删除方式，归档、撤销删除和永久清理尚未实现。

## 1. 行为与入口

- 创建仍使用“新建 Agent”，列表与私聊/群成员详情继续提供查询。
- 详情中新增“编辑 Agent”：修改名称、模型、推理等级和拉群权限。部分 PATCH 保留省略字段；相同值不刷新进程；不允许修改 ID、workspace、thread 或 harness。
- 原生目录校验模型/等级组合，失败时整个修改拒绝。名称和权限可以在目录不可用时保存。停止状态保持停止；活动 turn 保持捕获的配置，下一 turn 才采用新模型与等级。
- 名称、模型/等级或权限变化后，在空闲时关闭原生进程，重新准备 AGENTS.md 并恢复原 thread；运行中修改等当前 turn 结束。原生恢复失败仍显式报错，不建立替代 thread。
- “删除 Agent”弹窗说明停止、退出群聊、从联系人移除和不可恢复，并明确历史/文件保留。取消按钮默认获得焦点。
- 删除先中断执行并关闭原生进程，再提交终态 `deleted`。取消未结束投递、过期待答问题、移除全部成员关系并记录群内系统通知；通知不会自行唤醒其他 Agent。
- 已删除 Agent 的私聊进入“历史对话”，仍展示原作者名称及执行详情，没有输入框、编辑、删除、停止/恢复或权限控件。群聊原发言保留。个人工作区、共享文件、MCP token 文件和原生 session 都不删除，token 在 Isles 中失效。
- 服务重启只恢复未删除且符合运行条件的 Agent。重复 DELETE 幂等，仍可通过详情接口读取已删除记录。

## 2. 代码入口

| 位置                                                                   | 职责                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/contracts/src/index.ts`                                      | 严格的部分更新请求、Agent 的 `deleted` 状态。                      |
| `apps/server/src/app.ts`                                               | PATCH/DELETE 路由，默认活动列表和 `includeDeleted=true` 历史目录。 |
| `apps/server/src/runtime/runtime.ts`                                   | 原生目录校验、同 thread 刷新、删除时的中断和并发管理保护。         |
| `apps/server/src/storage/store.ts`                                     | 删除事务、数据保留、取消投递、成员退出、终态保护及启动恢复过滤。   |
| `apps/server/src/mcp/server.ts`                                        | 每次请求拒绝已删除身份，保留文件的 token 不再授权。                |
| `apps/web/src/components/AgentDetails.vue`                             | 编辑/删除入口与只读详情。                                          |
| `apps/web/src/components/EditAgentDialog.vue`、`DeleteAgentDialog.vue` | 表单、错误反馈与删除确认。                                         |
| `apps/web/src/components/AppSidebar.vue`、`ConversationView.vue`       | 历史对话分组及删除后的只读聊天。                                   |
| `apps/web/src/api/queries.ts`                                          | 活动联系人与历史作者目录分别缓存，SSE 统一失效刷新。               |

配置职责没有变化：Agent 身份、模型、等级、状态和权限仍保存于 SQLite，应用级路径与端口仍在 TOML。Agent 状态为文本列，本轮不新增列、不转换数据库、不加入旧版兼容分支。

## 3. 自动化与浏览器检查

| 检查                                              | 结果                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                      | 格式、lint、类型检查、105 项测试和生产构建通过。设置 `ISLES_TEST_CODEX_BIN`，原生协议生成测试没有跳过。 |
| `ISLES_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e` | 10 项 Chrome 浏览器测试全部通过。                                                                       |
| `pnpm db:generate`                                | 当前基线一致，无 schema 变化，无新迁移。                                                                |
| `pnpm db:migrate` + 独立 `ISLES_CONFIG_FILE`      | 临时配置目录下初始化 `data/isles.sqlite` 和 `runtime-lock.sqlite`，不访问用户数据。                     |

检查中发现 Drizzle Kit 通过 CommonJS 加载配置时，配置包仅有 `import` 条件导出，导致数据库生成命令报错。已将入口改为 `default` 条件，ESM 服务和数据库命令共用相同的现代 Node 模块；没有增加旧数据或旧格式兼容。

服务测试覆盖空/未知字段拒绝、非法模型组合的原子性、离线改名/权限、停止状态保留、空闲与运行中修改、连接中修改、并发目录校验、运行中删除、连接中删除、关闭进程时的恢复/删除竞态、较新停止取代等待中的恢复、删除时延迟修改拒绝、MCP 身份失效、幂等与重启不复活。删除存储测试还核对多种投递状态、问题过期、事务观察、群通知、历史及工作文件保留。

浏览器测试覆盖全部四个编辑字段、重载后的配置/会话/历史保留、模型列表不可用时编辑、删除取消、群成员详情中删除、返回群详情、联系人移除、历史作者与执行记录保留、只读入口及重载持久化。已检查 390×844 的编辑弹窗、删除确认与只读聊天截图，布局无横向溢出。

所有自动化使用临时配置、数据库和工作区；现有用户 Agent 不作为删除测试对象。

## 4. 真实 Codex 验证

入口：`pnpm --filter @isles/server exec tsx test/verify-native-config.ts`。

使用新的系统临时目录作为配置、数据与工作区，只使用原生 Codex 认证。验证两位真实 Agent 共享文件、重启恢复；随后通过 PATCH 修改其中一位的名称、模型、推理等级和权限，核对下一 turn 的原生参数、规则文件加载与原 thread；运行中 DELETE 后核对中断、成员退出、MCP 拒绝、只读历史和文件保留，再重启验证删除终态。报告不包含 token 或认证凭据。

本轮最终代码的成功报告：`C:\Users\15384\AppData\Local\Temp\isles-native-config-xA0TJ4\report.json`。原生版本 `codex-cli 0.160.0`，北京时间 17:37:20–17:38:28。

- 创建两位 `gpt-6.1-sol / high` Agent，真实写入并读取共享文件，应用重启后恢复原 thread。
- 读者改名、允许拉群，并从 `gpt-6.1-sol / high` 切换至 `gpt-6-luna / xhigh`。下一轮原生 `turn/start` 参数采用新组合，读到更新后的 AGENTS.md 并通过 MCP 回复；thread 与 workspace 不变。
- 下一轮原生 turn 确认接受后删除读者，执行记录变为 `interrupted`，群成员只剩写者。MCP 请求返回 `401`，编辑/恢复返回 `410`，私聊写入返回 `409`；历史、个人文件、共享文件与 token 文件保留。
- 再次重启，仅写者恢复原 thread；读者保持 `deleted`，新名称/模型/等级与只读详情仍可查。默认目录只列写者，包含历史的目录保留两者。
- 两次 `thread/start` 与四次 `thread/resume` 都报告各自 AGENTS.md 加载路径，未注入 `developerInstructions`；用户 Codex 配置文件 SHA-256 前后一致。

两个原生 thread 为 `01a10120-1358-7ef1-8fab-52175eadc261`（写者）和 `01a10120-1361-70e0-86be-8bfa6e50cbd2`（已删除读者）。真实上下文压缩的历史验收见 [基础修复记录](foundation-repair-plan.md#8-验收记录)，本轮不重复声明压缩验证。
