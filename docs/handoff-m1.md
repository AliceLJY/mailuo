# 脉络 Mailuo — M1 施工交接（后端骨架 + 感知链路）

## 你的角色
你是本项目的施工工程师。施工图是 `~/Projects/mailuo/PLAN.md`——**先完整读一遍再动手**，它是唯一施工真相源，本材料只圈定本批范围。项目讨论与设计已由 owner（Claude/Fable）完成并经用户批准，你不需要重新论证设计，发现施工图有矛盾或走不通的地方，停下来说明，不要自行改设计。

## Goal（本批 = 仅 M1，不做 M2/M3/M4 的内容）
1. **脚手架**：monorepo 结构 `server/`（Node 22 + TypeScript + Fastify + better-sqlite3 + zod，测试用 node:test + tsx，不引其他框架）、`shared/`（前后端共享类型）、`fixtures/`；`app/` 只建空目录放一行 README 占位（M3 才做）。根 `.gitignore`：node_modules、server/data/、.env。
2. **DB 层**：按 PLAN §3 的 schema 建 `server/src/schema.sql` + `db.ts`（启动时 CREATE TABLE IF NOT EXISTS 全量执行即可，不上迁移框架）。
3. **共享类型**：`shared/types.ts` —— 三种卡片 payload（PLAN §5 照抄）+ API 统一信封 `{ok,data}/{ok,error}`。
4. **LLM 层**（`server/src/llm/`）：`provider.ts` 抽象接口；`qwen.ts`（qwen-vl-max，走 dashscope 的 OpenAI 兼容端点，读 env `DASHSCOPE_API_KEY`；端点以官方文档为准，无法联网核对就用 `https://dashscope.aliyuncs.com/compatible-mode/v1`）；`deepseek.ts`（deepseek-v4-flash，读 env `DEEPSEEK_API_KEY`）；`prompts.ts` 集中管理；所有 LLM 输出过 zod 校验，失败带错误信息重试一次，再失败抛明确错误不静默吞。**代码与文档绝不出现任何 key 真值**；提供 `server/.env.example`（只有键名）。
5. **Agent 感知链路**（`server/src/agent/`）：`perceive.ts`（截图+用户备注 → 结构化抽取，prompt 注入 current_datetime，时区 Asia/Shanghai，相对时间解析为 ISO 且保留原文；只抽截图里有的，禁止推测补全）；`propose.ts`（M1 简化：不做 entity resolution，所有人物一律当新人 → create_contact 卡，约定/会议 → create_meeting 卡；confidence 只用 high/medium/low 三档；每张卡必须带 source_quote）。
6. **HTTP**：`POST /api/screenshots`（@fastify/multipart，image + note 字段，落盘 server/data/screenshots/，入库，跑 perceive→propose，返回 `{screenshot_id, cards}`）+ `GET /api/health`。
7. **CLI**：`npm run cli -- extract <image路径> [--note "补充文字"]` —— 真调 qwen 走完 perceive→propose，stdout 输出 cards JSON。缺 key 时报错信息必须清晰（指出缺哪个 env）。
8. **测试素材**：三张合成微信风格聊天截图（内容脚本见 PLAN §9，尺寸约 390×844 手机观感）。做法建议：写三个 HTML 文件（微信深色/浅色气泡样式手写 CSS），用本机 Chromium 无头截图：`/Applications/Chromium.app/Contents/MacOS/Chromium --headless --screenshot=fixtures/screenshot-1.png --window-size=390,844 --hide-scrollbars fixtures/screenshot-1.html`。HTML 源文件与 png 都入仓。**不使用任何真实聊天记录**，人名公司全部虚构。
9. **单测**（node:test，LLM 全部 mock，不联网）：propose 的卡片生成逻辑（给定抽取 JSON → 断言卡片类型/字段/confidence）；zod 校验失败重试一次的逻辑；DB 建表与基本读写。

## Scope
只在 `~/Projects/mailuo/` 内读写。不碰仓库外任何文件，不装全局工具，不新增 PLAN 未列的依赖（拿不准要不要装 → 停下来问）。

## Constraints
- PLAN §0 的 Constraints 全部适用；Simplicity First：能一个文件的不建目录，无显式要求不写抽象。
- 有意简化处用 `// simplified: <天花板>, <升级路径>` 注释标记。
- 中文 commit message；**自验全绿之后才 commit**，一批做完 commit 一次即可。

## Done when（自验清单，逐条跑，贴输出）
1. `cd server && npm test` 全绿；
2. `npx tsc --noEmit`（server 与 shared）零报错；
3. `npm run cli -- extract ../fixtures/screenshot-1.png` 在无 key 环境下给出清晰缺-key 报错（真调验收由 owner 注入 key 后执行，不是你的职责）；
4. `ls -la fixtures/`：三张 png 存在且每张 > 20KB，肉眼可辨微信聊天样式（把三张图路径列出来）;
5. `git log --oneline`：有本批 commit。
完成后：逐条贴出上面 5 项的实际输出（不要只说"已完成"），列出你创建的文件清单，说明有哪些偏离施工图的决定及理由。
