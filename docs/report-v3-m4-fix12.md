# 脉络 v3-M4-fix12 施工报告

日期：2026-09-04

施工基线：`main @ 891b68b`

## 施工前闸门

- 已通读任务书 `docs/handoff-v3-m4-fix12.md` 与 `PLAN.md` 第 0 节；`git log -3` 确认基线为 `891b68b`（fix12 交接文档本身），其前两个提交为 `e727571`（版本 3.1.11）与 `bb257fe`（fix11 修复）。
- 逐一定位六个 Goal 的判定点：`propose.ts` 的 `sourceEvidence`/`shouldSkip`（约 1964 行起，行号因中间提交较任务书写的“约 1913 行”略有漂移）、`interactionCandidates` 构建循环（约 1815–1876 行）、`dedupeBatchOtherCards`（约 1038 行）、`perceive.ts` 的 `applySelfNames`（88 行起）、`app/src/local/api.ts` 两条感知路径（`uploadText` 约 182 行、`uploadScreenshot` 约 361 行）、`batch-contacts.ts` 的 `toBatchOtherCardReference`/`prepareScreenshot`。
- 确认 `LocalStore.saveScreenshotAnalysis`/`updatePendingActionCard` 的 `payload` 参数在 `app/src/local/types.ts` 与 `store.ts` 中本就类型为 `ActionCard["payload"]`（联合类型），且 `applyPendingActionCardUpdate` 已自带 `current.status !== "pending"` 时返回 `null` 的保护——这意味着 Goal 3 “取改动更小者” 应选择“放宽 `LocalBatchPendingCardUpdate.payload` 类型”而非新增 `pendingMeetingUpdates` 字段，store 层零改动即可承接。
- 确认 `shared/core/text/compare.ts` 的 `normalizeContactText` 与 `perceive.ts`/`propose.ts` 之间无循环依赖，可安全从 `perceive.ts` 引入。
- 闸门结论：PASS，无需 `NEEDS_CONTEXT`。

## 交付结果

### Goal 1：纯应答判定，本人引文优先（`propose.ts`）

- `sourceEvidence` 改为：`candidate.relatedQuotes.length > 0` 时只用 `dedupeStrings(relatedQuotes.map(q => q.text))`（不再对引文做 `stripParticipantPrefix`，因为模型引用的是本人发言正文，不是 OCR 标签行）；否则回退到 `dedupeStrings(participantSourceQuotes.map(f => stripParticipantPrefix(f, ...)))`，完整保留 fix11 的裁剪逻辑。
- 判定条件从 `sourceEvidence.length > 0 && sourceEvidence.every(isPureAcknowledgement)` 改为 `sourceEvidence.length === 0 || sourceEvidence.every(isPureAcknowledgement)`——`length === 0` 分支是 Goal 2 落地后才会真正出现的新状态（@mention 被剔除且无引文时证据数组会变空），两个 Goal 共用同一处判定点，一并改造。

### Goal 2：@ 提及的消息不算被提及者的证据（`propose.ts`）

- 新增纯函数 `containsAtMentionOfParticipant(fragment, participant)`：扫描片段内每个 `@` 出现位置，跳过其后空白，检查参与人的 name 或任一 alias 是否紧跟其后；命中即视为“别人 @ 他”，不区分是否为片段开头。
- `interactionCandidates` 构建处（初始 `set` 与合并 `else` 分支）新增 `isOwnSourceQuote = !containsAtMentionOfParticipant(participant.source_quote, participant)` 判断；仅当 `isOwnSourceQuote` 为真才把该 `source_quote` 推入 `participantSourceQuotes`，剔除的片段不再进入证据数组（不是替换为空字符串，而是整条不进数组）。
- 剔除后若 `participantSourceQuotes` 与 `relatedQuotes` 均为空 → Goal 1 改造后的 `sourceEvidence.length === 0` 分支自然生效，不出互动卡；`buildInteractionPayload` 接收的 `dedupeStrings(candidate.participantSourceQuotes)` 同步变干净，summary 与 source_quote 都不再包含被剔除的 @ 行。

### Goal 3：同批查重命中时合并被砍卡的日期（`propose.ts` + `batch-contacts.ts` + `trace-store.ts`）

- `propose.ts`：`BatchOtherDedupMatch` 新增 `time_iso: string | null`、`time_text: string`、`agenda?: string`，在 `dedupeBatchOtherCards` 的 `matches.push(...)` 处从**被砍的新卡**（`card.payload`）取值填入；`dedupeBatchOtherCards` 本身不做任何“要不要合并”的判断，只负责把被砍卡的时间信息带出去。`BatchOtherCardReference` 新增可选 `payload?: CreateMeetingPayload`（旧手写字面量不受影响，保持可选）。
- `batch-contacts.ts`：`toBatchOtherCardReference` 在返回值里补上 `payload: card.payload`，让 `listBatchOtherCards()`/`this.batchOtherCardsById` 携带保留卡的完整当前 payload。`prepareScreenshot` 新增一段：按 `matched_card_id` 查到保留卡引用，若 `anchor.status === "pending"` 且 `anchor.payload.time_iso == null` 且 `match.time_iso != null` → 产出一条 `{ cardId: anchor.card_id, payload: { ...anchor.payload, time_iso, time_text, ...(anchor.payload.agenda ? {} : match.agenda ? { agenda: match.agenda } : {}) }, sourceQuote: anchor.source_quote }` 追加进 `pendingCardUpdates`（与既有联系人字段合并更新共用同一数组和同一条 `api.ts → store.updatePendingActionCard` 落库通道）；`LocalBatchPendingCardUpdate.payload` 类型从 `CreateContactPayload` 放宽为 `ActionCard["payload"]`（store 层本就是这个类型，零改动）。`LocalBatchScreenshotPlan.batchOtherDedup` 改为新类型 `LocalBatchOtherDedupResult`（`{title, matched_card_id, similarity, merged_time}`），每条 match 都会算出并携带 `merged_time` 布尔值。
- `trace-store.ts`：`TraceBatchOtherDedupSchema` 仅新增 `merged_time: z.boolean().optional()` 一个可选字段，其余字段与结构不动。

### Goal 4：会议卡相关人清空即移除（`review-order.ts` + `[screenshotId].tsx`）

- `review-order.ts` 新增纯函数 `normalizeMeetingParticipantsForConfirm(participants: CreateMeetingPayload["participants"])`：`.filter(p => p.name.trim() !== "")`，空数组视为合法输出；不改变含 `contact_id`/`candidates` 的项。
- `[screenshotId].tsx` 的 `handleConfirm` 在调用 `confirmCard` 前，仅当 `card.type === "create_meeting"` 时构造 `payloadForConfirm = { ...(draft.payload as CreateMeetingPayload), participants: normalizeMeetingParticipantsForConfirm(...) }`，其余卡片类型的 `draft.payload` 原样传递；未新增任何“移除”按钮或 UI 元素。

### Goal 5：昵称覆盖到事项参与人（`perceive.ts`）

- `applySelfNames` 新增：`selfNames` 非空时，对 `extraction.events` 逐条检查 `participant_names` 中是否有任意一项命中 `isSelfName(name, selfNames)`；命中则把所有命中项一并过滤掉，末尾追加一个 `'我'`（同一事件内多次命中只产生一个 `'我'`，不重复）；`selfNames` 为空时 `events` 原样返回，不做任何改动。此逻辑与 `extraction.participants[].is_self` 的既有正向覆盖逻辑完全独立，即使某个昵称从未作为独立 `participants[]` 条目出现，也能在 `event.participant_names` 里被直接命中替换。

### Goal 6：反向自我判定（`perceive.ts` + `app/src/local/api.ts`）

- `applySelfNames` 新增第三参 `knownContactNames: ReadonlySet<string> = new Set()`（默认空集，向后兼容零参调用点）。参与人处理逻辑改写为：`is_self === false` 时维持原有正向提升逻辑不变；`is_self === true` 时，仅当 `name !== '我'` 且 `!isSelfName(name, selfNames)` 且 `knownContactNames.has(normalizeContactText(name))` 三者同时成立才翻转为 `false`——顺序上先排除“本就是注册昵称”的情况，避免昵称与联系人名字偶然重叠时被误伤。
- `app/src/local/api.ts` 新增 `buildKnownContactNames(contacts)` 辅助函数（`canonical_name` + 全部 `aliases`，逐个 `normalizeContactText` 后存入 `Set`）。两条感知路径的 `contacts` 计算都被移到 `applySelfNames` 调用之前（原本在其后），因为 `contacts` 完全不依赖 `extraction`；`uploadText` 路径用 `listResolvableContacts(store)`，`uploadScreenshot` 路径用 `[...listResolvableContacts(store), ...(batchSession?.listPendingContacts() ?? [])]`（与后续 `resolveParticipants` 用的联系人集合完全一致，只是提前了计算时机）。

## 六个 Goal 的测试组

### Goal 1（`server/src/tests/propose.test.ts`，4 组）

1. `omits an interaction when quoted evidence is a pure acknowledgement even though the OCR label has no separator before the name` —— `source_quote='集团濱艺事业部小禾'`（无空格、名在末尾）+ 引文 `['收到']` → `[]`。
2. `keeps an interaction when quoted evidence has substantive content` —— 同一 `source_quote` + 引文 `['收到','明天上午10点开会，大家准时']` → 出卡。
3. `still omits an interaction from a department-plus-name label when there are no quotes`（fix11 回归）—— 无引文、`source_quote='集团市场部 小禾 收到'` → `[]`。
4. `keeps an interaction from a bare name-prefixed label when there are no quotes` —— 无引文、`source_quote='小禾 明天上午10点开会'` → 出卡。

### Goal 2（`server/src/tests/propose.test.ts`，4 组）

1. `drops the interaction candidate when the only evidence is someone else at-mentioning the participant` —— `source_quote='@柏贝@沈青岚明天28日的会议调整为10:30开。'`，无引文 → `[]`。
2. `keeps the interaction and excludes the at-mention line from the summary when the participant has a real quote` —— 同上 `source_quote` + 引文 `['稍等一下']` → 出卡且 `payload.summary === '稍等一下'`（不含 `@柏贝`）。
3. `also excludes an at-mention with a space after the @ symbol` —— `'@ 柏贝 明天的会议时间有调整。'`（@ 后有空格）→ `[]`。
4. `leaves a fragment at-mentioning someone else unaffected` —— `'柏贝：@王磊 麻烦你确认一下。'`（@ 的是别人）→ 出卡。

### Goal 3（`server/src/tests/propose.test.ts` 1 组机制测 + `app/src/tests/local-api.test.ts` 3 组端到端）

- propose 层：`batch other dedup carries the cut card's own time_iso, time_text, and agenda onto the match for later merging` —— 直接断言 `dedupeBatchOtherCards` 返回的 `matches[0]` 精确等于 `{title, matched_card_id, similarity, time_iso, time_text, agenda}`。
- 端到端（复用既有 `damagedVehicleNotice`/`correctedVehicleNotice` 夹具与 `createBatchEventHarness`）：
  1. `backfills the retained other card's time_iso from a later duplicate that resolved a date` —— 先出 `time_iso=null`，后出匹配项 `time_iso='2026-08-26T00:00:00+08:00'` → 后出不提出、`store.getStoredActionCardById(firstOther.id)` 读到的保留卡 `payload.time_iso`/`time_text` 已更新且 `title` 未被覆盖，`trace.batch_other_dedup[0].merged_time === true`。
  2. `does not overwrite a retained other card's time_iso when it is already resolved` —— 先出已有 `time_iso` → 保留卡不变，`merged_time === false`。
  3. `does not backfill time onto a rejected other card even when the duplicate resolved a date`（对应 fix9 ⑤）—— 先出卡被 `rejectCard` 拒绝后，后出仍不提出、保留卡 `time_iso` 仍为 `null`，`merged_time === false`。

### Goal 4（`app/src/tests/review-order.test.ts`，3 组）

1. `drops a blanked-out related person and keeps the rest` —— `[{name:'柏贝'},{name:''}]` → `[{name:'柏贝'}]`。
2. `returns an empty array when every related person was blanked out` —— `[{name:''},{name:'  '}]` → `[]`。
3. `leaves resolved contact_id and candidates entries untouched` —— 含 `contact_id`/`candidates` 的项原样保留（对象引用不变）。

### Goal 5（`server/src/tests/perceive.test.ts`，4 组）

1. `rewrites a self-nickname hit inside event participant_names to 我` —— `participant_names=['柏贝','李菁雅']`，`selfNames=['李菁雅']` → `['柏贝','我']`。
2. `collapses multiple self-name hits within one event into a single 我` —— `['菁雅','李菁雅']`，`selfNames=['菁雅','李菁雅']`（两个都是已注册昵称）→ `['我']`。
3. `leaves event participant_names untouched when no self names are configured` —— `selfNames=[]` → 不动。
4. `still promotes a matching participant to is_self without a third argument`（回归）—— 不传第三参时，`participants[].is_self` 的既有正向提升逻辑不变。

### Goal 6（`server/src/tests/perceive.test.ts`，4 组）

1. `flips a wrongly self-judged known contact back to is_self=false` —— 沈青岚 `is_self=true`、已知联系人含沈青岚、`selfNames=['李菁雅']` → `false`。
2. `keeps is_self=true for a self-judged name that is not a known contact` —— “安闲静雅” `is_self=true`、不是已知联系人 → 保持 `true`。
3. `keeps or promotes a name that is itself a registered self name even if it also matches a known contact` —— 名字在 `selfNames` 里（即便同时也命中 `knownContactNames`）→ 无论起始 `is_self` 是 `true` 还是 `false`，结果都是 `true`。
4. `does not flip anything when knownContactNames is empty` —— 空集合 → 不翻。

## 施工中发现并处理的回归（现场诊断记录）

Goal 2 落地后，`cd server && npm test` 暴露 1 个既有测试失败：

- `test at src/tests/propose.test.ts` → `proposeCards proposes an alias-only confirmed update after an LLM same_as resolution`：该测试的唯一参与人 `{name:'王总', aliases:['王磊'], source_quote:'@王磊 王总，方案已经发你'}` 原本断言会同时产出 `update_contact`（别名合并）与 `record_interaction`（互动记录）两张卡。诊断：`source_quote` 以 `@王磊`（其 alias）开头，语义上是**别人**发给他的、把他艾特进来的通知（“王总，方案已经发你” 是报告“方案已发给你”，不是他自己说的话），与 Goal 2 明确要修的 bug 形状完全一致——他没有任何 `quotes`，唯一“证据”就是别人 @ 他的这条消息。按 Goal 2 的新语义，这条证据应被剔除，`sourceEvidence` 变空，`record_interaction` 卡不应再产出。
- 处理：更新该测试断言，只保留 `update_contact` 卡（别名合并不受影响），移除 `record_interaction` 卡的预期，并在测试内加注释说明这是 fix12 goal 2 的必然结果，不是误伤。此改动没有触碰该测试验证的别名合并逻辑本身（`update_contact` 的 `payload`/`changes` 断言原样保留）。

以上是 Goal 2 生效后暴露的唯一既有测试回归；修复后 `server` 测试回到全绿。其余五个 Goal 均未引发任何既有测试失败。

## 真实测试输出

### server

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npm test`

```text
ℹ tests 219
ℹ suites 0
ℹ pass 219
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 461.655709
```

门槛：`219 >= 202`。（施工前基线：202/202/0，与任务书标注一致；新增 17 组：Goal1×4 + Goal2×4 + Goal3×1 + Goal5×4 + Goal6×4。）

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### app

命令：`cd /Users/anxianjingya/Projects/mailuo/app && npm test`

```text
ℹ tests 177
ℹ suites 0
ℹ pass 177
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 513.485792
```

门槛：`177 >= 171`。（施工前基线：171/171/0；新增 6 组：Goal3 端到端×3 + Goal4×3。）

命令：`cd /Users/anxianjingya/Projects/mailuo/app && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### 工作树检查

命令：`git -C /Users/anxianjingya/Projects/mailuo diff --check`

```text
(无标准输出，exit 0)
```

## 文件清单

- `shared/core/agent/propose.ts`（Goal 1/2：新增 `containsAtMentionOfParticipant`、改造 `interactionCandidates` 构建与 `sourceEvidence`/判定逻辑；Goal 3：扩展 `BatchOtherCardReference`/`BatchOtherDedupMatch` 类型、`dedupeBatchOtherCards` 填充新字段）
- `shared/core/agent/perceive.ts`（Goal 5/6：`applySelfNames` 新增第三参 `knownContactNames`、events 覆盖逻辑、反向自我判定；新增 `normalizeContactText` 引入）
- `app/src/local/api.ts`（Goal 6：新增 `buildKnownContactNames`、两条感知路径调整 `contacts` 计算时机并传入第三参）
- `app/src/local/batch-contacts.ts`（Goal 3：`toBatchOtherCardReference` 补 `payload`、`prepareScreenshot` 新增合并逻辑、`LocalBatchPendingCardUpdate` 类型放宽、新增 `LocalBatchOtherDedupResult` 类型）
- `app/src/diagnostics/trace-store.ts`（Goal 3：`TraceBatchOtherDedupSchema` 新增可选 `merged_time` 字段）
- `app/src/review-order.ts`（Goal 4：新增纯函数 `normalizeMeetingParticipantsForConfirm`）
- `app/app/review/[screenshotId].tsx`（Goal 4：`handleConfirm` 确认 `create_meeting` 前过滤空名相关人）
- `server/src/tests/propose.test.ts`（新增 Goal1×4 + Goal2×4 + Goal3×1 共 9 组测试；修正 1 个既有测试断言，见上文回归记录）
- `server/src/tests/perceive.test.ts`（新增 Goal5×4 + Goal6×4 共 8 组测试；新增 `applySelfNames`/`PerceptionResult` 导入）
- `app/src/tests/local-api.test.ts`（新增 Goal3 端到端×3 共 3 组测试；新增 `vehicleOtherExtractionWithTime` 辅助函数；因 `LocalBatchPendingCardUpdate.payload` 类型放宽，修正 2 处既有断言的类型收窄写法）
- `app/src/tests/review-order.test.ts`（新增 Goal4×3 共 3 组测试）
- `docs/report-v3-m4-fix12.md`（本报告）

## 偏离与决定

1. **Goal 3 的“改动更小者”选择**：任务书给出两个选项（新增 `pendingMeetingUpdates` 独立字段 / 放宽 `LocalBatchPendingCardUpdate.payload` 类型）。核实后发现 `LocalStore.saveScreenshotAnalysis`/`updatePendingActionCard` 在 `app/src/local/types.ts` 与 `store.ts` 中的 `payload` 参数**早已**类型为 `ActionCard["payload"]`（联合类型），且已有 `status !== "pending"` 时返回 `null` 的保护——选择“放宽类型”这条路径使 store 层零改动，只需改 `batch-contacts.ts` 一处类型声明；连带修正了 `local-api.test.ts` 中 2 处因此类型变宽而需要收窄断言的既有测试（`.payload.aliases` 访问需要先 `as CreateContactPayload`），未改变这两个测试验证的行为本身。
2. **既有测试 `proposeCards proposes an alias-only confirmed update after an LLM same_as resolution` 的断言被修正**（详见上文“施工中发现并处理的回归”）——这是 Goal 2 明确要修的 bug 形状（@ 提及不算被提及者证据）在一个已有测试里的真实体现，不是对 fix1–fix11 已交付行为的擅自改动；`update_contact`（别名合并）部分的断言完全未动。
3. **Goal 3 的 `merged_time` 字段设计**：`dedupeBatchOtherCards`（propose.ts 层）本身不产出 `merged_time`——它无法访问保留卡的当前状态，只负责把被砍卡的时间信息带出去；`merged_time` 由 `prepareScreenshot`（batch-contacts.ts 层）在拿到保留卡的完整快照后计算并附加，通过新类型 `LocalBatchOtherDedupResult` 对外暴露，`trace-store.ts` 的 `TraceBatchOtherDedupSchema` 仅追加这一个可选字段，未改动其余结构（严格匹配任务书 Scope “仅 merged_time 可选字段”的限定）。
4. **Goal 3 的 agenda 合并未单独写端到端测试**——propose 层已直接验证 `dedupeBatchOtherCards` 会把被砍卡的 `agenda` 带到 match 上；`prepareScreenshot` 里“仅在保留卡为空时补 agenda”的分支是一行三元表达式，逻辑与 time_iso 分支同构，为避免端到端测试与已有的机制级测试重复覆盖同一段代码，未额外增补。
5. **未涉及“已否决”事项**——「移除相关人」按钮未加，「会议参会人员请示」类沟通事项借用会议时间的拦截未做，拍照/上传时间锚定相对日期未动（fix8 已否决，本批 Goal 3 是另一种时间信息丢失场景），OCR 形近字未处理，`集团 市场部` 等被抽成 name 未处理，「稍等一下／你们等下」类短回复词表未扩，均按任务书“已否决 / 本批不做”逐条核对未触碰。
6. **未改** `prompts.ts`、`schemas.ts`、`execute.ts`、`resolve.ts`、`review-fields.tsx`、`event-log.ts`、DB schema/migrations、`app/app.json` 版本号、依赖——`git diff --stat` 只显示任务书 Scope 内允许的 11 个文件（6 个实现文件 + 4 个测试文件 + 1 份本报告），与声明的可动范围一致。
7. 测试数据全部使用虚构名（小禾、柏贝、沈青岚、王磊、王总、安闲静雅、李菁雅、菁雅等）；报告与代码注释中不含任何真实姓名或机构名。
