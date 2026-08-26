# 脉络 Mailuo — M2 施工交接（完整 agent 环）

## 你的角色
继续担任施工工程师。施工图仍是 `~/Projects/mailuo/PLAN.md`（注意 §0 数据库选型已修订为 node:sqlite，你上一批已完成迁移）。本批把 agent 环补完整：resolve（人物归并）→ confirm/execute（确认执行）→ insight（洞察生成）。发现施工图矛盾停下来说明，不自行改设计。

## Goal（本批 = 仅 M2，app 界面是 M3，部署是 M4）
1. **Entity resolution**（`server/src/agent/resolve.ts`，按 PLAN §4 [2] 实现）：
   - a. 精确匹配：canonical_name / aliases，大小写与首尾空白归一后比对；
   - b. 未命中 → 把库内全部联系人的 `(id, canonical_name, aliases, company)` 摘要 + 新人物名字与上下文交给 deepseek，判 `same_as:<id>` / `new` / `unsure`（unsure 时给候选 id 列表）；库为空时跳过 LLM 直接 `new`；
   - c. 判定结果进卡片：`same_as` 且有字段变化 → update_contact 卡（changes 里 old 取库内现值）；`same_as` 无字段变化 → 不出联系人卡（但 execute 时要记 interaction 观测，见第 3 点）；`new` → create_contact 卡；`unsure` → create_contact 卡 + `disambiguation` 字段带候选（`[{contact_id, name, company}]`），让用户在 UI 裁决"新建还是合并"。
   - meeting 卡的 participants 里，已归并到库内的人带上 `contact_id`。
2. **确认与执行**（`server/src/agent/execute.ts` + 路由）：
   - `POST /api/cards/:id/confirm`（body 可带编辑后 payload、以及 disambiguation 的裁决 `resolved_contact_id`）：
     - create_contact：建档，截图里出现的称呼写进 aliases；若裁决为"合并到已有联系人"，则不建新档，新称呼追加进该联系人 aliases，卡片 payload 里的新字段按 update 语义写入；
     - update_contact：更新字段；**每个被覆盖的旧值写一条 Observation（kind=status_change，content 记"字段 X 由 A 变为 B"，带 source_quote）**；
     - create_meeting：落 meetings 表，participants 里未建档的人保留名字（不强制建档）；
     - record_interaction：只给已建档联系人，或本截图里会先确认 create_contact/合并裁决的人；如果对应联系人还没落库，明确报依赖错误，不自动连带确认 create_contact；
     - 任何卡确认后：本次截图中与该联系人相关的事实写 observations（kind 按性质选 fact/preference/interaction）；同一 `(screenshot_id, resolved contact_id)` 最多保留一条 interaction observation；
     - 全部写库操作走已有的 withTransaction。
   - `POST /api/cards/:id/reject`：status=rejected，零写入。
   - 已 confirmed/rejected 的卡再次操作 → 409 明确报错。
3. **洞察生成**（`server/src/agent/insight.ts`，按 PLAN §4 [5]）：
   - owner 3A 语义：confirm 先提交 execute 事务，再尝试生成洞察；响应仍同步返回洞察结果或失败状态；
   - 每条必须带 `based_on`（引用 observation id 数组）；**模型给不出依据的条目直接丢弃，宁缺毋滥**；
   - kind 三选一：relationship_read / suggested_action / conversation_hook；
   - 洞察成功则入库 insights 表并返回；失败时仍返回 `{ok:true}` + `insight_status:"failed"` + `insight_error`，不回滚卡片状态，也不补单独 retry 端点（Future work 不做）。
4. **API 补齐**（PLAN §6 剩余四个）：GET /api/contacts（含 observation 计数、最近互动时间）、GET /api/contacts/:id（字段 + observations 时间线 + insights）、GET /api/meetings（按时间排序）、GET /api/screenshots/:id（原图路径 + raw_extraction + 关联卡片）。统一 `{ok,data}/{ok,error}` 信封。
5. **CLI e2e**：`npm run cli -- e2e <image路径>`——真调链路：extract → 全部卡片按依赖顺序自动 confirm（unsure 自动选 new）→ 打印洞察。若失败发生在 `createScreenshot` 之后但分析/卡片尚未落库，清掉这次孤儿 screenshot；一旦进入执行阶段，不回滚已执行卡。供 owner 注入 key 后做真调验收；缺 key 报错照旧清晰。
6. **单测**（LLM 全 mock，用 fixtures/seed.sql 预置数据）：
   - resolve：精确命中 / LLM same_as / new / unsure 走 disambiguation 四条路；
   - execute：四种卡片类型各一；update_contact 的 status_change 留痕；disambiguation 裁决"合并"后别名回写；重复 confirm 拒绝；
   - insight：based_on 缺失的条目被丢弃；正常条目入库；
   - 一条 mock 全链路：extract 结果 → resolve → confirm → 断言 DB 终态（联系人/观测/会议/洞察都对）。

## Scope
只在 `~/Projects/mailuo/` 内读写。不动 fixtures 三张图；seed.sql 如需微调（比如补一个用于 resolve 测试的预置联系人）可以改，改了说明理由。不新增依赖。

## Constraints
- PLAN §0 全部适用；Simplicity First；`// simplified:` 标注照旧。
- resolve 的 LLM 判定 prompt 进 `prompts.ts` 集中管理，输出走 zod + 重试一次（复用已有 generateStructuredOutput）。
- 隐私纪律：发给 deepseek 的联系人摘要只带 resolve 必需的字段（名字/别名/公司），不要把整个档案连 observations 全文一起发。
- 中文 commit message，自验全绿才 commit，一批一个 commit。

## Done when（逐条跑，贴真实输出）
1. `cd server && npm test` 全绿（贴 `ℹ pass` / `ℹ fail` 两行；预计用例数比 M1 的 17 明显增加）；
2. `npx tsc --noEmit` 零报错；
3. `node --import tsx src/cli.ts e2e ../fixtures/screenshot-2.png` 在无 key 环境给出清晰缺-key 报错；
4. mock 全链路测试存在且通过（贴该用例名与结果行）；
5. `git log --oneline -1` 有本批 commit。
完成后照旧：逐条贴实际输出、列文件清单、说明偏离施工图的决定及理由。
