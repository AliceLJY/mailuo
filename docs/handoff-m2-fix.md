# M2 返工：真调验收发现的四个 LLM 交互质量问题

## 背景
owner 注入真实 key 后对三张 fixtures 做了真调验收。管线骨架全部工作（resolve 精确认出陈昕、status_change 留痕机制、3A 失败语义、interaction 防泛滥），mock 测试锁住的行为无一失守。但 LLM 交互质量层抓出四个问题，全部有真调证据，逐一修复。**自验一律用本机默认 Node 26 直接跑，禁止用 npx 拉临时 Node 22 替代**（上批教训，已成固定纪律）。

## Goal（四项修复，按序做）

**A. 用户本人不得建档**
真调证据：三张图都把"我"抽成 participant，e2e 后库里出现 `contacts(id=3, canonical_name='我')`，并产生了"创建联系人：我"卡和"我"的 interaction 卡。
修复：
- perceive 的抽取 prompt 明确：聊天界面中代表机主的一方（右侧气泡/自称"我"）是用户本人，输出时给该 participant 标 `is_self: true`（schema 同步加字段）；
- propose 层双保险：`is_self` 或名字归一后等于"我"的 participant，不生成 create_contact、不生成 record_interaction；
- meeting participants 里用户本人保留 `{name:"我"}` 但永不携带 contact_id、execute 时永不为其建档；
- resolve 对 is_self 的 participant 直接跳过（不做匹配、不调 LLM）。

**B. update_contact 字段映射强化**
真调证据：screenshot-3 里"跳槽去了翎点科技"，期望 `company: {old:"云沐内容", new:"翎点科技"}`，实际 company 未变，跳槽信息整段进了 notes 的变更。
修复：
- 抽取 prompt 强化：公司/职位/电话/微信号的变化必须落到对应结构化字段（facts 的 field 用 company/title/phone/wechat_id），并给"换公司类表述（跳槽/入职/去了 XX）→ field=company, value=新公司名"的显式指引与一个 few-shot 示例；
- propose 层：same_as 联系人的结构化字段 fact 与库内现值不同 → changes 里生成该字段的 {old, new}；notes 只承接真正无处安放的自由信息，禁止把可结构化的变化塞进 notes；
- 单测：mock 一份含 company 变化的抽取结果，断言 update_contact 卡的 changes 里是 company 字段而非 notes。

**C. create_meeting 需要时间信号门槛**
真调证据：screenshot-3 的"等你方便了我们再约个时间细聊"（纯客套、无任何时间）生成了 time_iso 与具体时间皆空的会议卡。
修复：
- 规则：event 必须携带时间信号才出 create_meeting 卡——time_iso 非空，或 time_text 含可辨认的时间表述（具体到日/时段的："周二""下周三下午""明晚"算；"改天""回头""等你方便"不算）；判定逻辑放 propose 层（让抽取 prompt 给 `has_time_signal: boolean`，propose 依此过滤，代码不做中文 NLP）；
- 无时间信号的约定意向归入相关联系人的 interaction 内容（"提到要再约时间细聊"），不丢失；
- 单测：mock 无时间信号 event → 断言无 meeting 卡且 interaction 内容包含该意向。

**D. 洞察输出上限调整**
真调证据：screenshot-3 的洞察两次尝试均 "JSON parse failed: Unexpected end of JSON input"——`src/agent/insight.ts:245` 写死 `maxOutputTokens: 700`，档案厚（有历史观测+多卡）时三条中文洞察 + based_on JSON 挤不下被截断；screenshot-2 能过是上下文薄。
修复：`maxOutputTokens` 提到 2000；同时洞察 prompt 里加一句"每条洞察不超过 120 字"控制单条膨胀。不做流式、不做分页（Simplicity First）。

**附带小项 E（上批验收记的账，顺带清掉）**：`resolve.ts` 里的 `fallbackEntityResolutionPrompt` 及其 `?? ` 探测逻辑是死代码（`prompts.ts` 已有正主 `buildEntityResolutionPrompt`），删除 fallback，直接 import 使用。

## Scope
`server/src/`（prompts / perceive / propose / resolve / insight / execute 相关处）+ `shared/types.ts`（is_self 字段）+ 对应测试。不动 fixtures 三张图与 seed.sql，不动 app/，不新增依赖。

## Constraints
- PLAN §0 全部适用；抽取 prompt 修改保持"只抽截图里有的，禁止推测补全"的底线不动摇。
- 中文 commit message，自验全绿才 commit，本批一个 commit。

## Done when（逐条跑，贴真实输出；全部用本机 Node 26）
1. `cd server && npm test` 全绿（含 B、C 的新增单测与 A 的过滤单测）；
2. `npx tsc --noEmit` 零报错；
3. `grep -n "fallbackEntityResolutionPrompt" src/agent/resolve.ts` 输出为空；
4. `grep -n "maxOutputTokens" src/agent/insight.ts` 显示新值 2000；
5. `git log --oneline -1` 有本批 commit。
完成后照旧：逐条贴实际输出，说明偏离决定及理由。真调复验（三张图重跑）由 owner 做，不是你的职责。
