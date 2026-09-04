# 脉络 v3-M4-fix14 施工报告

日期：2026-09-04

施工基线：`main @ 165b243`

## 施工前闸门

- 已通读任务书 `docs/handoff-v3-m4-fix14.md` 与 `PLAN.md` 第 0 节；`git log -3` 确认基线为 `165b243`（fix14 交接文档本身），其前两个提交为 `db9fa49`（版本 3.1.13）与 `66e6c0b`（fix13 首批修复）。
- 逐一定位六个 Goal 的判定点：`routeSpecialOtherEvents` 内 `isMeetingNoticeEvent` 分支（Goal 1）、`isPureAcknowledgement`（Goal 2）、互动候选判定末尾 `buildInteractionPayload` 调用处（Goal 3）、`stripParticipantPrefix`（Goal 4）、`isEvidenceCoveredByEvents`（Goal 5）、互动闸最后一步（Goal 6）。全部落在 `shared/core/agent/propose.ts` 单文件内，未跨文件。
- 确认 `NoticeRouting` 类型与 `app/src/diagnostics/trace-store.ts` 的 `TraceNoticeRoutingSchema` 均为任务书点名的唯一允许改动的 app 文件/字段；核实该 schema 为 `.strict()`，确认必须显式加 `reason` 字段（不加会被 zod 拒绝）。
- 核实 `MEETING_KINDS = ["meeting", "appointment", "other"]`（`shared/types.ts`），确认 Goal 6"kind ∈ {meeting, appointment}"前置条件语义成立。
- 核实 `normalizeContactText`（`shared/core/text/compare.ts`）会把 `\p{P}`（含半角句点“.”与全角省略号“…”）连同空白一起剥离——这决定了 Goal 5 的省略号检测必须在**剥离前的原文**上做，剥离后再检测已经找不到省略号了。
- 闸门结论：PASS，无需 `NEEDS_CONTEXT`。

## 交付结果

### Goal 1：通知并入会议只认实质变更（`routeSpecialOtherEvents`）

- 新增 `meetingChangeSignals = ['调整','变更','改到','改为','改成','改期','取消','延期','推迟','提前','换到','地点']`（模块顶层，紧邻 `meetingNoticeSignals`）与纯函数 `hasMeetingChangeSignal(event)`：对 `[event.title, event.source_quote]` 各自 `normalizeMeetingTitle` 后检查是否含任一信号词。
- 在 `isMeetingNoticeEvent(event)` 为真的分支内、`discardedIndexes.add`/`discardedSourceQuotes.add` 之后、`findMeetingNoticeCandidate`（stored 匹配）调用之前插入 `if (!hasMeetingChangeSignal(event))` 早退出：命中则 `noticeRouting.push({title, decision:'dropped', reason:'no_change_signal'})` 并 `continue`，**不再尝试**任何 stored/batch 匹配。原有"匹配不到目标才 dropped"分支保持不产出 `reason` 字段（`NoticeRouting.reason` 为可选字段，未命中新分支时不设置该键，与旧行为在结构上完全等价）。
- `NoticeRouting` 类型加可选字段 `reason?: 'no_change_signal'`；`app/src/diagnostics/trace-store.ts` 的 `TraceNoticeRoutingSchema` 同步加 `reason: z.enum(["no_change_signal"]).optional()`（唯一改动的 app 文件，仅此一行 + 一行注释）。

### Goal 2：到达/状态通报算应答（`isPureAcknowledgement`）

- 新增正则 `arrivalReportPattern = /(?:已|己|巳)到(?!账|期)|到了|到啦|到位|到齐|人齐/u` 与纯函数 `isArrivalReport(value)`：噪音剥离（复用既有 `acknowledgementNoisePattern`）后码点 `<= 10` 且匹配该正则 → 真。负向前瞻 `(?!账|期)` 专门排除"已到账／已到期"这类同含"到"但语义无关的复合动词（任务书"已否决"第 3 条明确要求）。
- `isPureAcknowledgement` 新增一段：`normalizedLength <= 2` 与词表精确匹配之后、模糊编辑距离匹配之前，插入 `if (isArrivalReport(value)) return true;`。
- 该改动**推翻 fix11 的"荀导已到"保护**：`server/src/tests/propose.test.ts` 中原名为 `keeps an interaction for an arrival status report...(fix13 goal 1 regression)` 的测试已按任务书要求原地改写为反向断言，标题改为 `drops an interaction...(fix14 goal 2)`，并在测试内加注释注明这是 Alice 2026-09-04 的拍板依据（详见下文"施工中发现并处理的回归"）。

### Goal 3：互动摘要不再拼应答片段（`buildInteractionPayload` 调用处）

- 互动候选循环末尾调用 `buildInteractionPayload` 前，对第三个参数（`participantSourceQuotes`）与第六个参数（`relatedQuotes`）分别追加 `.filter((fragment) => !isPureAcknowledgement(fragment))` / `.filter((quote) => !isPureAcknowledgement(quote.text))`——两处过滤都作用在**原始**（未经 Goal 4 前缀剥离的）文本上，与任务书"传给 buildInteractionPayload 的 ... 先剔除 isPureAcknowledgement 的片段"字面一致。
- `buildInteractionPayload` 函数本体未改动：`interaction_summary`（LLM 摘要）依旧优先，只有走 fallback 拼接路径时才会用到这两个被过滤后的数组，`sourceQuote`（证据引用）也随之不再带上纯应答片段的原文。

### Goal 4：引文也过 `stripParticipantPrefix`（`stripParticipantPrefix` + 调用处）

- 互动候选循环内构建 `sourceEvidence` 的三元表达式，原来只在 `relatedQuotes.length === 0` 的 fallback 分支里调用 `stripParticipantPrefix`；现在 `relatedQuotes.length > 0` 分支也同样对 `quote.text` 调用 `stripParticipantPrefix(quote.text, { name: candidate.participantName })`。
- `stripParticipantPrefix` 本体新增"裸尾部标签"分支：在原有的前缀剥离逻辑之前，先检查是否存在某个 identifier**恰好占据整个片段的尾部**（`lastIndex + identifier.length === fragment.length`）且**前面紧邻一个真分隔符**（`participantPrefixSeparatorPattern.test(fragment.charAt(lastIndex - 1))`）——命中则直接返回 `''`。这与原有的"前缀 + 分隔符 + 名字"剥离方向相反（原逻辑要求分隔符在名字**之后**），专门对付"集团市场部 小禾"这类模型误当成引文的部门+昵称标签行；剥空后的空字符串会被 `dedupeStrings` 自然丢弃（`!value` 判假），无需额外特判。
- 未改动原有前缀剥离分支的任何判断条件，"荀导已到"（名字在尾部但前面无分隔符，紧邻的是普通汉字"监"）与"小禾：方案已发你"（名字在头部，后随分隔符）两类既有场景均验证不受影响（见下文突变检查）。

### Goal 5：事项原文含省略号时拆段判覆盖（`isEvidenceCoveredByEvents`）

- 新增 `ellipsisSplitPattern = /\.{3,}|…/u`（三个及以上半角点，或单字符全角省略号）。
- `isEvidenceCoveredByEvents` 内对每个 event 的判定新增分支：若**原始**（`normalizeContactText` 之前）`event.source_quote` 命中该正则，则按其切分为若干段，每段单独 `normalizeContactText` 后过滤出码点 `>= 4` 的段，要求这些段**全部**被 `normalizedFragment.includes(...)` 命中才算覆盖；若无省略号，走原有的"较短者 >= 8 码点且被包含"或"编辑相似度 >= 0.85"逻辑（未改动一行）。
- 关键实现细节：切分与"是否含省略号"的判断都必须在 `normalizeContactText` **之前**的原始字符串上做——`normalizeContactText` 会把点号和省略号当标点一并剥掉，剥离之后再判断/切分会完全找不到分隔点（已在施工前闸门中核实，也是本 Goal 与 Goal 1-4 相比唯一一个"顺序敏感"的实现点）。

### Goal 6：会议后勤类沟通不出互动卡（互动闸最后一步）

- 新增 `meetingLogisticsSignals`（18 个词，任务书原样落地）、纯函数 `hasMeetingOrAppointmentEvent(events)`（判定 `extraction.events` 中是否存在 `kind==='meeting'||kind==='appointment'`）与 `isMeetingLogisticsFragment(fragment)`（码点 `<= 60` 且含任一后勤词）。
- 互动候选循环内，原来的"应答剔除 + 覆盖判定"两步合并计算出 `survivingEvidence`（=剔除应答且未被事项覆盖后仍剩下的片段），跳过条件由原来的 `nonAcknowledgementEvidence.length===0 || nonAcknowledgementEvidence.every(isEvidenceCoveredByEvents)`（数学上等价于 `survivingEvidence.length===0`）扩展为：`survivingEvidence.length===0 || (hasMeetingOrAppointmentEvent(extraction.events) && survivingEvidence.every(isMeetingLogisticsFragment))`。后半段只在**本截图确有 `meeting`/`appointment` 事项**且**剩余片段清一色是短后勤词**时才追加跳过；`extraction.events` 为空或含非纯后勤内容时保持原判定不变。

## 六个 Goal 的测试组（均在 `server/src/tests/propose.test.ts`，追加于文件末尾）

### Goal 1（4 组）

1. `drops a same-batch notice that only relays a time, carrying no change signal` —— "你们通知听雨楼和卓工这个时间。"（title/source_quote 均无变更词）→ `noticeRouting` 为 `dropped`+`reason:'no_change_signal'`；同截图会议卡 `agenda` 保持 `'确认舞台方案'` 不变（未被并入）。
2. `merges a same-batch notice that names a concrete time change into the meeting agenda` —— 通知 source_quote 含"时间调整"+"改为" → `batch` 并入，`agenda` 变为 `复盘上季度指标；<通知原文>`。
3. `appends a stored-meeting notice that names a concrete time change` —— 通知 source_quote 含"改到" + 与已落库会议同名 → `stored`，产出 `duplicate_of_meeting_id` + `agenda_append`。
4. `keeps matching a stored meeting by same-day participant overlap when the notice also carries a change signal`（回归）—— 复用既有的"日期+参与人"匹配路径，通知补上"时间调整"后仍能匹配已落库会议。

### Goal 2（3 组）

1. `drops an interaction for a bare arrival report with the 己/已 OCR digit swap` —— "范导己到" → 不出互动卡。
2. `keeps an interaction when an arrival report is followed by substantive content past the length gate` —— "范导已到，随行物资也一并带过来了"（噪音剥离后 15 码点，超过 10 码点门槛）→ 出卡。
3. `keeps an interaction for "已到账" wording, deliberately excluded from the arrival vocabulary` —— "货款已到账" → 出卡（"到账"被负向前瞻排除，不进到达词表）。
4. 另有既有测试原地反转为 `drops an interaction for a bare arrival status report, reversing the fix11 protection`（"荀导已到"→不出卡），见下文回归说明。

### Goal 3（1 组）

1. `excludes an acknowledgement fragment from the interaction summary` —— quotes `['收到','明天上午10点开会带方案']` → `payload.summary === '明天上午10点开会带方案'`（不含"收到"）。

### Goal 4（2 组）

1. `drops an interaction when a nickname/department label line survives dedup alongside an event-covered quote` —— quotes `['集团市场部 小禾', <被事项覆盖的长句>]` → 不出互动卡（第一句剥成空串被 dedup 丢弃，第二句被 `isEvidenceCoveredByEvents` 判定覆盖）。
2. `keeps an interaction when a quote strips down to a real remark after its prefix label` —— quotes `['小禾：方案已发你']` → 出卡（剥去"小禾："前缀后仍是非空的真实内容）。

### Goal 5（2 组）

1. `treats a fragment covering both halves of an ellipsis-elided event source_quote as covered` —— 事项原文含"..."省略号，参与人引文是**完整**长句（同时含省略号前后两段的内容，中间用较长的独立分句连接）→ 不出互动卡。
2. `keeps an interaction when a fragment only covers one half of an ellipsis-elided event source_quote` —— 引文只含前半段 → 出卡（未覆盖，判定为独立证据）。

### Goal 6（5 组）

1. `drops an interaction when the only surviving quote is meeting-logistics chatter` —— "王总,我要晚一点参会,明早9点半..."+"好的,收到"，同截图有会议 → 不出。
2. `drops an interaction when logistics chatter is all that survives coverage filtering, on top of covered fragments` —— 三句引文两句被事项覆盖，剩一句纯后勤词 → 不出。
3. `keeps an interaction for substantive content even when a meeting event is present`（对照）—— "方案已经发你，请查收"，同截图有会议 → 出卡。
4. `keeps a meeting-logistics-worded interaction when no meeting/appointment event is on this screenshot`（对照）—— "我要晚一点参会"但截图无会议事项 → 出卡（规则未启用）。
5. `keeps an interaction when the surviving fragment exceeds the logistics length gate`（对照）—— 66 码点长句含"散会"但超过 60 码点门槛 → 出卡。

## 判别力验证（突变检查，防止测试形同虚设）

对每个 Goal 的核心判定函数各做一次临时性反向突变（改成恒定返回值或恒假分支），单独跑 `cd server && npm test`，确认**恰好**命中预期的测试集合后原样撤回，全部撤回后重新跑通 250/250：

| Goal | 突变方式 | 失败数 | 命中的测试 |
|---|---|---|---|
| 1 | `hasMeetingChangeSignal` 恒 `true` | 1 | `drops a same-batch notice that only relays a time...` |
| 2 | `isArrivalReport` 恒 `false` | 2 | `drops...reversing the fix11 protection` + `drops...己/已 OCR digit swap` |
| 3 | `buildInteractionPayload` 调用处两个过滤器还原为未过滤 | 2 | `excludes an acknowledgement fragment...` + `keeps an interaction when mixed source evidence...(fix14 goal 3 regression)` |
| 4 | `isBareTrailingLabel` 恒 `false` | 1 | `drops an interaction when a nickname/department label line...` |
| 5 | 省略号分支条件恒 `false`（首次尝试） | **0（异常）** | 无 —— 见下 |
| 5 | 省略号分支条件恒 `false`（修正 fixture 后重试） | 1 | `treats a fragment covering both halves of an ellipsis-elided event source_quote as covered` |
| 6 | 后勤跳过条件的 `&&` 链最前加 `false &&` | 3 | `drops...meeting-logistics chatter` ×2（新测试）+ `drops an interaction when the only surviving quote is meeting-logistics chatter (fix13 goal 2 baseline, fix14 goal 6 reverses the outcome)`（更新过的旧回归） |

**Goal 5 的第一次突变检查发现了一个真实的测试设计缺陷**：初版 fixture 里事项原文省略号前后两段之间的"缺口"内容太短（"的渠道复盘会"，6 个字），即使完全禁用 Goal 5 的分段逻辑、退回旧的整体包含/相似度判定，`normalizedEditSimilarity` 仍高达 0.857（超过 0.85 阈值）——因为 `normalizeContactText` 会把"..."当标点一并剥掉，剥完之后旧逻辑看到的是"两段硬拼在一起"的字符串，恰好与引文只差 6 个字，编辑相似度天然就很高。也就是说这组测试**在禁用新逻辑后依然通过**，说明它没有真正验证 Goal 5 的机制。诊断后把两段之间的缺口内容从"的渠道复盘会"（6 字）加长为"因主创档期临时冲突需要顺延"（14 字），令旧逻辑下的相似度降到 0.655（已用 `node --import tsx` 直接调用真实的 `normalizeContactText`/`normalizedEditSimilarity` 验证），重跑同一次突变后测试正确失败，确认新 fixture 真正依赖 Goal 5 的分段逻辑。已同步更新该测试及其"仅覆盖前半段"的对照测试（保持措辞一致），并在测试文件内加注释记录这次诊断过程。

六轮突变全部原样撤回（`grep MUTATION-TEST-TEMP` 已确认全仓零命中），最终代码与突变检查前完全一致。

## 施工中发现并处理的回归

实现六个 Goal 后，`npm test` 在两端各自暴露了一批既有测试失败，均是新行为按任务书要求生效导致的必然结果，不是误伤：

### server（`propose.test.ts` 3 处、`app.test.ts` 1 处）

1. **两处既有"日期匹配"通知测试失去变更信号词**（Goal 1）：`matches a stored meeting by participants and an absolute date without a clock time` 与 `date-only meeting notice matching keeps the current year and honors an explicit year` 的 `source_quote` 原文（如"提醒：9月8日评审时间另行告知"）不含任何 `meetingChangeSignals` 词，Goal 1 新增的早退出会把它们判为 `dropped/no_change_signal`，导致这两组本来验证"仅凭日期+参与人也能匹配已落库会议"的测试失去覆盖对象。处理：只在 `source_quote` 里补一句"时间调整"，不改 `time_text`/`time_iso`/`title`/参与人（这些字段才是该测试真正要验证的匹配逻辑），两组测试恢复通过且其原有断言（`duplicate_of_meeting_id`、年份推断）一字未改。
2. **既有"荀导已到"测试按任务书要求原地反转**（Goal 2，任务书明确点名的一处）：`keeps an interaction for an arrival status report...(fix13 goal 1 regression)` 改名为 `drops an interaction...reversing the fix11 protection (fix14 goal 2)`，断言从 `assert.ok(interactionCard)` 改为 `assert.deepEqual(proposeCards(...), [])`，并加注释注明依据（任务书 Goal 2 + Alice 2026-09-04 拍板）。
3. **既有"混合证据"测试的 summary 断言按 Goal 3 预期收窄**：`keeps an interaction when mixed source evidence includes one substantive quote` 原断言 `summary === '收到！；明天上午我带车牌号过去'`，正是任务书诊断包卡 #4 描述的那个 bug（"「收到」被闸滤掉但 summary 仍拼进去"）在测试里的真实体现。处理：断言改为 `summary === '明天上午我带车牌号过去'`，标题加注 `(fix14 goal 3 regression)`，测试仍然验证"混合证据里有一句真实内容就出卡"这个核心行为，只是不再断言已被 Goal 3 认定为噪音的部分也出现在摘要里。
4. **既有三引文测试被 Goal 6 判定反转**：`keeps an interaction when only one of several quotes is not covered by a same-screenshot event (fix13 goal 2)` 的唯一存活引文"你先谈完话，过来我办公室参加海棠塔剧场会议。"，其形状与任务书诊断包卡 #9（郝明川/柏贝，Alice 明确拍板"这类不出"）完全一致——都是"围绕已成卡会议的人际后勤沟通"。处理：断言从 `assert.ok(interactionCard)` 改为 `assert.equal(interactionCard, undefined)`，标题加注 `(fix13 goal 2 baseline, fix14 goal 6 reverses the outcome)`，并加注释说明这正是 Goal 6 要处理的真实场景。
5. **`server/src/tests/app.test.ts` 的集成测试撞上同一个 Goal 2 根因**：`POST /api/screenshots keeps interaction cards while only high-confidence progress creates a meeting update` 用"荀导已到"作为参与人 `interaction_summary`/`source_quote`，Goal 2 生效后该文本本身不再产生互动卡，两次断言（`highInteraction`/`mediumInteraction` 均为 `assert.ok`）失败。处理：换成语义无关的真实内容"材料已经交付"（同时验证过它**不会**被 `isPureAcknowledgement`/`isArrivalReport` 误判、也**会**被 `shared/core/agent/resolve.ts` 里独立的 `hasDirectProgressSignal` 正则（未改动，只读它确认）识别为进度信号——第一次尝试用了"材料已经备好，可以按计划开拍"，因为不含该正则要求的确切词"准备好"而漏判、导致 `progressCard` 反而消失，已重新诊断并换成"材料已经交付"验证两个机制都命中），同步改掉 3 处断言里的字面值，测试标题描述的核心行为（进度卡按置信度分级、互动卡与置信度无关地持续存在）完全不受影响。

### app（`local-api.test.ts` 2 处）

6. **`app/src/tests/local-api.test.ts` 的同类集成测试，同一个根因**：`text upload proposes a linked meeting update for a high-confidence progress match` 与 `medium meeting progress keeps the interaction card and confirmation persists its observation` 同样用"荀导已到"作为 fixture，且第二个测试还额外断言了确认后的 `observation.content.includes("荀导已到")`。处理：同样替换为"材料已经交付"，8 处字面值（`interaction_summary`/`source_quote`/`uploadText` 调用参数/`agenda_append` 断言/`observation.content.includes` 断言等）逐一核对更新，两组测试恢复通过。

以上 6 处、共 8 个测试位置是本批六个 Goal 生效后暴露的全部既有测试回归；修复后 server（250/250）与 app（177/177）均回到全绿。

## 真实测试输出

### server

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npm test`

```text
ℹ tests 250
ℹ suites 0
ℹ pass 250
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

门槛：`250 >= 233`。（施工前基线：233/233/0，与任务书标注一致；新增 17 组：Goal1×4 + Goal2×3 + Goal3×1 + Goal4×2 + Goal5×2 + Goal6×5。）

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
```

门槛：`177 >= 177`。（施工前基线：177/177/0；本批未新增 app 端测试，仅修正 2 个既有集成测试的 fixture 文本，测试数持平。）

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

- `shared/core/agent/propose.ts`（六个 Goal 的核心实现：`NoticeRouting.reason`；`meetingChangeSignals`/`hasMeetingChangeSignal` + `routeSpecialOtherEvents` 早退出；`arrivalReportPattern`/`isArrivalReport` + `isPureAcknowledgement`；`buildInteractionPayload` 调用处两处过滤；`stripParticipantPrefix` 裸尾部标签分支 + 引文分支同样剥前缀；`ellipsisSplitPattern` + `isEvidenceCoveredByEvents` 分段判定；`meetingLogisticsSignals`/`hasMeetingOrAppointmentEvent`/`isMeetingLogisticsFragment` + 互动闸最后一步）
- `app/src/diagnostics/trace-store.ts`（`TraceNoticeRoutingSchema` 加一行可选 `reason` 字段，任务书唯一允许改动的 app 文件）
- `server/src/tests/propose.test.ts`（新增 Goal1×4 + Goal2×3 + Goal3×1 + Goal4×2 + Goal5×2 + Goal6×5 共 17 组测试；修正 5 个既有测试断言，见上文"施工中发现并处理的回归"1-4）
- `server/src/tests/app.test.ts`（修正 1 个既有集成测试的 fixture 文本与 3 处断言，见上文"施工中发现并处理的回归"5）
- `app/src/tests/local-api.test.ts`（修正 2 个既有集成测试的 fixture 文本与相关断言，见上文"施工中发现并处理的回归"6）
- `docs/report-v3-m4-fix14.md`（本报告）

## 偏离与决定

1. **两处既有"日期匹配"通知测试补了变更信号词**（Goal 1，"施工中发现并处理的回归"第 1 条）——任务书只点名 Goal 2 允许改旧测试，未提及 Goal 1 会撞上既有的 fix9 日期匹配测试。核实后发现这两组测试验证的是"日期+参与人匹配"这一机制本身，与"通知是否含变更词"是两个维度；不打 change-signal 补丁、直接接受它们被判 `dropped` 会让"日期+参与人能否匹配已落库会议"这条既有能力失去测试覆盖，属于对 fix9 已交付行为的实质性回归，与任务书"不动 fix1–fix13 已交付行为"矛盾。因此选择最小侵入的修法：只在 `source_quote` 里补一个真实存在的变更词，不碰这两组测试真正要验证的字段，报告中已逐条列出并标注理由。
2. **既有"混合证据"测试与既有三引文测试的断言按 Goal 3/Goal 6 预期改写**（"施工中发现并处理的回归"第 3、4 条）——均是任务书诊断包直接点名的真实 bug（卡 #4 的"收到"拼进摘要、卡 #9/#10 的会议后勤闲聊出卡）在既有测试里的字面体现，改写后测试标题描述的核心能力（"混合证据里有真实内容就出卡"、"未被覆盖的证据能让候选人存活"）未变，只是不再断言已被本批新规则认定为噪音的那一部分内容。
3. **`server/src/tests/app.test.ts` 与 `app/src/tests/local-api.test.ts` 共 3 个集成测试被判定为"其它测试"范围内的必要修正**——任务书 Scope 写明"可动：... 其它测试/快照"，且这 3 个测试失败的根因与已获任务书明确授权的 Goal 2 反转（"荀导已到"）完全相同，只是从 `propose.test.ts` 的单元测试层面延伸到了 app/server 两侧的集成测试层面。未改动这 3 个测试所在文件的任何非测试代码（`server/src/app.ts`、`app/src/local-api.ts` 等生产代码文件本次均未触碰）。
4. **`server/src/tests/app.test.ts` fixture 文本选型一波三折，记录在案**——第一次尝试的替换文本"材料已经备好，可以按计划开拍"能通过 `isPureAcknowledgement`（不被误判为噪音），但触发了另一个未预料到的耦合：`shared/core/agent/resolve.ts`（本次禁止改动）里 `collectMeetingProgressFragments` 有一套独立的 `hasDirectProgressSignal` 正则，只认"准备好"不认"备好"，导致该 fixture 拿不到任何 meeting-progress 候选片段，`resolveMeetingProgress` 提前返回空数组，进度卡片（`progressCard`）反而消失。诊断后换成"材料已经交付"（同时命中两套独立机制各自的词表），问题解决。这一处偏离没有改动任何生产代码，纯粹是 fixture 文本选型的诊断过程，记录于此供后续窗口参考。
5. **Goal 5 的一个测试 fixture 在突变检查中被发现设计不足，已当场修正**——见上文"判别力验证"一节，初版 fixture 的省略号前后缺口太短，导致关掉 Goal 5 的新逻辑后测试依然能靠旧的编辑相似度判定通过（0.857 > 0.85 阈值），未真正锁定 Goal 5 的机制。已加长缺口内容并用 `node --import tsx` 直接调用真实的 `normalizeContactText`/`normalizedEditSimilarity` 验证新阈值（0.655 < 0.85），重新突变确认测试现在会正确失败。
6. **未复用 `MEETING_DUPLICATE_RULES`/`BATCH_OTHER_DEDUP_RULES` 的常量对象包装风格**——`arrivalReportPattern`、`ellipsisSplitPattern`、Goal 6 的 60 码点/18 词表阈值均以模块顶层字面量+注释的形式写出，未包装成新的导出常量对象。核实这两个既有常量对象在全仓无外部消费者，属于该文件历史上的局部风格选择而非强制约定，按 Simplicity First（无显式要求的抽象不写）选择更简单的写法，与 fix13 报告"偏离与决定"第 4 条的先例一致。
7. **未涉及"已否决"事项**——未用 `has_time_signal` 区分通知指令与变更信息（`meetingChangeSignals` 直接判定文本内容，不看该字段）；摘要过滤只剔应答片段，未额外剔除被事项覆盖的公告片段（`buildInteractionPayload` 的过滤条件仍只是 `isPureAcknowledgement`）；"已到账／到期"未加入到达词表（`arrivalReportPattern` 的负向前瞻已验证排除两者）；未改动 `prompts.ts` 去修正模型把昵称行当引文的根因，改用 Goal 4 的 `stripParticipantPrefix` 兜底——均按任务书"已否决 / 本批不做"逐条核对未触碰。
8. **未改** DB schema/migrations、`perceive.ts`、`prompts.ts`、`schemas.ts`、`execute.ts`、`resolve.ts`（仅只读确认其 `hasDirectProgressSignal` 正则内容，用于诊断"施工中发现并处理的回归"第 5 条，未改动其任何一行）、`api.ts`（本仓实为 `server/src/app.ts`，同样只读确认其调用链，未改动）、`batch-contacts.ts`、`compare.ts`（只调用既有导出函数 `normalizeContactText`/`normalizedEditSimilarity`/`editDistance`，未改动其实现）、fix1–fix13 已交付行为（Goal 2 明确推翻的那条除外）、`app/app.json` 版本号、依赖——`git status --porcelain` 只显示 5 个文件改动（`shared/core/agent/propose.ts`、`app/src/diagnostics/trace-store.ts`、`server/src/tests/propose.test.ts`、`server/src/tests/app.test.ts`、`app/src/tests/local-api.test.ts`）加本报告，与声明的可动范围一致。
9. **测试数据全部使用虚构名**——本批新用到的范导、小马、小禾、卓工、蔺工、蒲经理、听雨楼、魏敏、林姐、董秘等均为新造的虚构占位名，均不出现在任务书诊断包引用的真实截图人名/地名列表（海棠塔、隋导、沈青岚、郝明川、柏贝、荀导、杂技秀）中；沿用的"荀导""王磊""骆澄"等是本项目测试套件里早已使用多轮的通用虚构占位名（fix9–fix13 报告已确认过这一点）。诊断包引用的真实截图原文本次报告中均已改写为语义等价的合成示例，未逐字复制。
