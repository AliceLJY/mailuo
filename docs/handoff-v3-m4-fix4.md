# 脉络 Mailuo — v3-M4-fix4 施工交接（完成出口 + 别名过滤 OCR 容错 + 事项参与人近似候选）

## 你的角色

接 v3.1.3（`6a6bb07` + tag）。fix3 真机验收：映射提示、跳过前计数、清空数据、不再闪退**四条通过**；
**两条未过 + 一处设计缺口**，本批修。全部在 `shared/core/agent/propose.ts` + app 侧 UI/flow，
**不动 schema、不做迁移**。施工图 PLAN.md（第 0 节「宁可留空，不要猜错」适用），
先 `git log -3` 同步认知。自验用本机 Node 26。

## 真机实证（owner，OPPO，本地模式）

- ❌ **洞察页没有「结束」出口**：底部只有「继续整理下一批」；owner 原话「其实可以多一个选项，
  结束就好，我现在是要点继续处理才看到都落位了，如果不按直接返回，就还有提示待定未确认的」。
- ❌ **别名拼接过滤对 OCR 错字零容忍**：公司「某集团市场部」的联系人，别名字段里存进了
  「某集团市扬部 王磊」（OCR 把「场」认成「扬」）和「部 王磊」（残字 + 姓名）。另一位联系人
  别名「集团副总王磊」也留下了——建这个人的那张截图里职位字段还是空的，过滤没有参照物。
- ❌ **事项参与人的近似名没人管**：同一批里「荀导」被建为新联系人，另一张截图的事项卡参与人
  写成「荀到」（原文两种写法都有），事项卡显示「先按名字保存」，没有任何「可能是荀导」的提示。
  owner 只能跳过那张卡。

## 诊断（owner 已核过 file:line，直接照此改）

① **「完成」出口**：`app/app/insights.tsx:116-123` `Page` 的 `footer` 只有一个
`AppButton`「继续整理下一批」→ `resetFlow()` + `router.replace("/")`。
**待确认误报**：`app/app/(tabs)/index.tsx:539-544` 只要 `displayResult?.successCount` 有值就显示
「查看待确认卡片」按钮，不看本批卡片是否已全部确认/跳过——上一批的 result 没被 reset 就一直显示。

② **别名过滤**（`shared/core/agent/propose.ts` `isDerivedAlias`，约 L860-905，fix3 引入）：
余部判定只有 `isComposedOfTokens(remainder, fieldTokens)` 精确拼接；`fieldTokens` 来自
`tokenize(company/title)`，中文无空格短语整体就是一个 token。用 owner 截图原值复现
（`normalizeContactText` + `tokenize` + `isComposedOfTokens` 原样搬出）：
- 公司「某集团市场部」，别名「某集团市扬部 王磊」→ **保留**（余部「某集团市扬部」≠ token「某集团市场部」）
- 同上，别名「部 王磊」→ **保留**（余部「部」1 字，且不是完整 token）
- 对照：别名「某集团市场部 王磊」（无错字）→ 丢弃 ✓；别名「王总」（敬称）→ 保留 ✓
- 职位为空、别名「集团副总王磊」→ **保留**（`fieldTokens` 为空）；职位「集团 副总」时 → 丢弃 ✓
`buildCreateContactPayload`（约 L583-640）传给 `isDerivedAlias` 的 contact 是
`{company:null,title:null}` + `proposed = payload`，所以创建时字段为空就没有参照集。
`ResolvableContact`（`shared/core/agent/resolve.ts:29-37`）已带 `company` / `title`，
propose 手里有整个联系人库的 company/title 词汇可用。

③ **事项参与人**（`propose.ts:679-689`）：`participants: event.participant_names.map(...)` 只查
`sameAsParticipantsByName`（`same_as` 结果），其余一律 `{ name }`（UI 显示「先按名字保存」）。
`resolveParticipants` 的 `unsure`（含 fix3 新增 `source:'near_match'`）只在 L1230-1232 进
联系人卡的 `disambiguation.candidates`，**事项卡从不消费 unsure**。本批 pending 联系人已经在
`contacts` 列表里（`app/src/local/api.ts:256-259` 把 `batchSession.listPendingContacts()` 拼进去，
负数临时 id），所以 near match 本身能命中 pending，是事项卡这条路把结果丢了。
事项卡参与人关联到 pending 的依赖机制已存在（owner 截图里事项卡报过
「这张卡依赖的『新建联系人 荀导』已被跳过」），走同一套 `local_batch_deferred` 依赖即可。

## Goal

### 1. 洞察页「完成」出口 + 待确认误报

- `insights.tsx` footer 改为两个按钮：主按钮**「完成」**→ `resetFlow()` 后 `router.replace` 到
  日程 tab（让用户当场看到落位结果）；次按钮「继续整理下一批」保持现有行为。`Page` 的 `footer`
  若只接受单节点，包一层 `View`（列布局、间距用 `theme.spacing`）。
- 上传页 `index.tsx:539-544`：「查看待确认卡片」只在**本批仍有 pending 卡片**时显示（从 flow 里
  本批 `cards` 的 status 计算，不看 `successCount`）；本批卡片已全部确认/跳过 → 该位置显示
  「本批已整理完成」的静态提示（或直接回到「提交并开始整理」态，二选一，报告里说明理由）。
  **按系统返回键离开洞察页**这条路径必须覆盖（不经过任何按钮）。
- 测试：flow 层加用例——本批全部卡片 confirmed/rejected 后，「待确认」判定为 false；仍有 pending 时为 true。

### 2. 别名过滤：OCR 容错 + 参照集扩展

- `isDerivedAlias` 余部判定扩为四条（任一成立即派生）：
  a. 现有：余部由 fieldTokens 精确拼接；
  b. **子串**：某个参照值 V（归一化后的完整 company/title 字符串）满足 `V.includes(R)`（R ≥ 1 字，
     覆盖「部 王磊」这种残字——**但仅当别名含完整姓名**，敬称「王总」不含完整姓名「王磊」故不受影响）；
  c. **差一字**：R ≥ 3 字且 `editDistance(R, V) === 1`（覆盖「某集团市扬部」）；
  d. **包含加一字**：`R.includes(V)` 且 `len(R) - len(V) === 1`（OCR 多认一个字）。
- 参照集从「当前 + 本次提议」扩为三层：当前 contact 的 company/title → 本次 payload 的 → **整个联系人库
  的 company/title 去重词汇**（`ResolvableContact[]` 已带，propose 的调用方传入；没有就退回两层）。
  职位为空的「集团副总王磊」由第三层兜住（库里任何人有含「集团副总」/「副总」的职位或公司即可）。
- **敬称保护不变**：不含完整姓名的短别名（王总 / 荀导 / 小王）一律保留；`propose.test.ts:244` 必须继续绿。
- 测试放 `server/src/tests/propose.test.ts` 现有 alias 用例旁，**六个用例红绿双向**：
  「某集团市扬部 王磊」丢、「部 王磊」丢、「集团副总王磊」（title 空、库内他人 title 含「副总」）丢、
  「某集团市场部 王磊」丢、「王总」留、「Amy王磊」留（余部与任何参照值无关）。

### 3. 事项参与人的近似候选（本批 pending 也算）

- `propose.ts:679-689`：参与人不是 `same_as` 时，查该名字的 resolution；若为 `unsure`
  （source 为 `near_match` / `llm` / `exact_multiple` 均可），把候选写进事项 payload 该参与人：
  `{ name, candidates: [{ contact_id, name, company? }] }`（`contact_id` 可为本批 pending 的负数临时 id，
  与联系人卡 `disambiguation.candidates` 同形）。**默认不关联**（宁可留空）。
- 事项卡参与人 UI（`review-fields.tsx` 会议/事项参与人段）：有候选时显示「可能是：荀导（本批新建）」
  + 按钮「就是这位」→ 该参与人 `contact_id` 设为候选 id、候选提示消失；也可不选，保持「先按名字保存」。
- 负数临时 id 走现有 `local_batch_deferred` 依赖：确认时若锚点已确认则换成真实 id，被跳过则复用
  fix3 的中文提示（`confirmedAnchorContactId`）。`LocalBatchContactSession.hydrate…` 与
  `preparePersistedLocalBatchConfirmation` 若已覆盖事项参与人的 pending 关联，只需让「用户手选的候选」
  走同一条路；若没有，补最小分支，**报告里说明走的是哪条**。
- 类型：`CreateMeetingPayload.participants[]` 加可选 `candidates`；`shared/core/schemas.ts` 的 zod
  同步（这是 payload 结构不是 DB schema，允许）。
- 测试：`propose.test.ts` 加「参与人 unsure → 事项 payload 带 candidates 且无 contact_id」；
  `local-api.test.ts` 加「手选本批 pending 候选 → 锚点确认后事项参与人拿到真实 id」。

## 已否决（别再提议）

- **自动把近似名关联到旧联系人或本批 pending**：宁可留空不要猜错，只给候选让用户点。
- **改确认卡片页「确认时间」输入框**：owner 定不改（点进去能拉动看全，手机就这么宽）。
- **把敬称当派生别名过滤**：王总 / 荀导 这类是真别名，必须保留。
- **用职位关键词表（总/导/部/经理…）判派生**：owner 未批准的启发式，本批不上；参照集三层够用，
  不够在报告里写清哪个用例没兜住。

## Scope

- 可动：`shared/core/agent/propose.ts`（`isDerivedAlias`、参照集、事项参与人候选）、`shared/core/schemas.ts`
  与 `shared/types.ts`（事项参与人 `candidates` 字段）、`app/app/insights.tsx`、`app/app/(tabs)/index.tsx`
  （待确认判定）、`app/src/flow-context.tsx`（若需新增「本批是否仍有 pending」的派生值）、
  `app/src/components/review/review-fields.tsx`（事项参与人候选 UI）、`app/src/local/batch-contacts.ts`
  （仅事项参与人候选走依赖所需的最小分支）、`app/src/local/api.ts`（若需把库内 company/title 词汇传给 propose）、
  `server/src/…` 对应调用点同步、测试。
- 不可动：数据库 schema / migrations、`action_cards.type` CHECK、卡片拆分与确认行为、fix1–fix3 已交付行为、
  `/api/screenshots`、`resolve.ts` 的 near match 规则本身（fix3 已定）、`app/app.json` 版本号。
- 不新增依赖；不回填历史数据。

## Constraints

- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push origin main
- 示例与测试数据一律用虚构名（王磊 / 王总 / 荀导 / 某集团 市场部）
- 有边界疑问报 BLOCKED / NEEDS_CONTEXT 停下，不要自行扩 scope

## Done when

1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 158、app 不低于 97；`git diff --check` 干净
2. **Goal 1 有测试**：本批全部处理完 → 待确认判定 false；仍有 pending → true；洞察页 footer 两个按钮
3. **Goal 2 六个用例红绿双向**（见上），`propose.test.ts:244` 不变
4. **Goal 3 有测试**：unsure 参与人 → 事项 payload 带 candidates 无 contact_id；手选 pending 候选 → 锚点确认后拿到真实 id
5. 报告贴真实测试输出、文件清单、偏离决定（含走了哪条依赖路径）
