# 项目约定

- 后续开发直接在 `main` 修改、提交并 push，不另建功能分支、不走 PR 流程；提交前完成相应检查。
- 分支与提交使用 conventional 规范。不要使用 `codex/` 前缀。
- 实现过程中需要决策，或是有任何问题，随时停下来询问。
- 在用户明确宣布发布第一个正式版本（v1）之前，不实现向后兼容、旧数据迁移或任何兼容性代码；数据库保持当前 schema 的全新基线。旧 `.isles` 数据在停止旧服务后手动清理，不转换旧 JSON 配置或旧数据库。

产品约束见 `docs/requirements.md`，模块边界见 `docs/architecture.md`，阶段范围与验收见 `docs/implementation-plan.md`。其中的待确认项不视为已确定的实现规则。
