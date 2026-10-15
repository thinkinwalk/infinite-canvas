@AGENTS.md

## Claude Code 补充

- 本项目规则统一维护在 `AGENTS.md`（与 Codex 共用），新增规则写到 `AGENTS.md`，不要写到本文件。
- 项目技能位于 `.agents/skills/`（frontend-design、vercel-react-best-practices），做前端 UI 或 React 性能相关改动时先阅读对应 `SKILL.md`。
- 后端为 Go（`main.go`、`handler/`、`service/`、`repository/`、`router/`），前端在 `web/`，文档站在 `docs/`。
- `.env` 含密钥，不要读取或回显其中的值。
