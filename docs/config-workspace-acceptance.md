# TOML 配置与独立工作区验收

日期：2026-10-03。配置文件、个人工作区、共享目录和凭据目录均已实现；旧版本数据不迁移。本文区分已通过的验证与旧目录清理遗留项。

## 1. 实现范围

- 统一 Node 配置模块供后端、Vite 开发代理和数据库工具使用。默认 `~/.Isles/config.toml`，现有环境变量覆盖 TOML，`ISLES_CONFIG_FILE` 可指定独立文件。
- 目录支持 `~` 和配置文件目录下的相对路径。数据库与 token 默认在 `~/.Isles/data`，工作文件在 `~/.Isles/workspace`，不随安装目录变化。
- 每个 Agent 使用独立 workspace，并在 `AGENTS.md` 中获得同一个共享目录绝对路径；凭据按数据目录与 Agent ID 定位。
- 已有 Codex 路径界面写入 TOML。保存前重读文件，保留其他字段值；仅可执行文件选择实时刷新，其他配置重启后加载。非法配置会报告文件与字段，已有文件不被覆盖。
- 当前 schema 已整理为唯一初始化基线，旧格式探测、备份转换和 JSON 设置均已删除。首发前不提供兼容路径。

## 2. 自动化检查

| 检查                                              | 结果                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                      | 格式、lint、类型检查、89 项测试和生产构建通过；本机同时设置 `ISLES_TEST_CODEX_BIN`，协议生成验证没有跳过。 |
| `ISLES_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e` | 7 项通过，包括 Codex 路径保存/清空、Vite 代理、群聊、停止/恢复和执行中收信。                               |
| `pnpm db:migrate` + 独立 `ISLES_CONFIG_FILE`      | 使用配置文件旁的 `data/isles.sqlite` 与 `runtime-lock.sqlite`，没有写入安装目录。                          |

配置测试覆盖默认文件生成、环境变量优先级、相对目录和 `~`、错误 TOML/字段、带引号的 Windows 程序路径、仅引号/空白路径拒绝、最新磁盘字段保留与串行写入。服务测试覆盖启动失败释放数据锁，以及同版本工作区配置变化后已有 Agent 保持原路径、新 Agent 使用新根目录。

## 3. 真实 Codex 验证

可复现入口：

```powershell
pnpm --filter @isles/server exec tsx test/verify-native-config.ts
```

该入口在系统临时目录中创建独立配置、数据库和工作区，使用用户原生 Codex 认证；不读取旧 `.isles` 数据。报告保留在脚本输出的 `report.json` 中，不包含 MCP token 或认证凭据。

本次成功报告：`C:\Users\15384\AppData\Local\Temp\isles-native-config-4UV1jT\report.json`。原生版本为 `codex-cli 0.160.0`，模型为 `gpt-6.1-sol`、思考等级 `high`，运行时间为北京时间 13:50:29–13:51:24。

- 两个 Agent 的个人目录分别位于配置的 `work/agents/<id>/workspace`，token 位于独立的 `data/agents/<id>`。
- 第一个 Agent 根据自己的 `AGENTS.md` 写入共享文件；第二个 Agent 根据自己的规则文件找到并读取该文件，通过私聊 MCP 返回实际文件内容。
- Codex 配置 API 写回 TOML 后，目录字段保持一致。
- 应用关闭并重启后，两个原生 thread ID 保持一致，第二个 Agent 再次读取原共享文件并回复成功。
- 两次 `thread/start`、两次 `thread/resume` 均返回各自 workspace 的 `AGENTS.md` 加载路径，未传入 Isles 的 `developerInstructions`。
- 验证前后用户原生 Codex 的 `config.toml` SHA-256 一致。

两个原生 thread：`01a10050-6230-7ea3-b4a5-1c37e2a8831b`、`01a10050-6223-7352-90bc-f3f5e02a4ff0`。本轮没有重复真实压缩验证；其历史事实保留在 [基础修复记录](foundation-repair-plan.md#8-验收记录)，本轮覆盖配置、文件加载、共享目录与同版本重启恢复。

## 4. 旧目录清理遗留项

已停止原开发服务。永久删除 `D:\workspace\Isles\.isles` 两次被自动审批拒绝，返回原因仅为 `blocked by policy`。随后在核验源、目标均位于本项目且不是链接后，执行可恢复隔离移动。

旧数据库及可移动文件已进入 `D:\workspace\Isles\.isles-legacy-20261003`；原 `.isles` 中仍有被其他进程占用的历史验收工作区，移动未完全完成。两处均已排除在 Git、格式和 lint 检查之外。释放历史工作区占用后仍需永久清理这两处目录；新服务使用 `~/.Isles`，没有加载或迁移这些旧数据。
