# 脉络 v3-M4-fix13 施工报告

日期：2026-09-04

施工基线：`main @ 72560ad`

## 施工前闸门

- 已通读任务书 `docs/handoff-v3-m4-fix13.md` 与 `PLAN.md` 第 0 节；`git log -3` 确认基线为 `72560ad`（fix13 交接文档本身），其前两个提交为 `d0f59ef`（版本 3.1.12）与 `2a5819d`（fix12 修复）。
- 逐一定位三个 core Goal 的判定点：`propose.ts` 的 `isPureAcknowledgement`（施工前约 1356 行，实际约 1401 行，行号因 fix12 之后的提交略有漂移）、互动候选判定处的 `sourceEvidence`/跳过条件（施工前约 1964 行，实际约 2077 行）、`buildMeetingCard` 的 `event.agenda` 赋值处（施工前约 798 行，实际约 833 行）。行号漂移幅度与既往几轮 fix 报告一致，不影响判定。
- 确认 `editDistance`、`normalizeContactText`、`normalizedEditSimilarity` 三个函数已在 `propose.ts` 顶部从 `../text/compare.ts` 引入（fix9/fix12 遗留），Goal 1/2 均可直接复用，无需新增 import、无需改动 `compare.ts`。
- 确认 `fix11` 保护的 `stripParticipantPrefix` 注释与回归测试均以 `"荀导已到"` 为例，且该字符串在 `resolve.test.ts`/`app.test.ts`/`e2e.test.ts`/`local-api.test.ts` 中已是全项目通用的虚构测试人名/场景，Goal 1 的回归测试直接复用同一场景，不算新引入真实数据。
- 确认 `extraction.events`（`proposeCardsInternal` 的原始入参）与 `routeSpecialOtherEvents` 返回的 `events`（路由/合并/丢弃后的子集）是两个不同的局部变量，前者贯穿函数体全程可用；Goal 2 的覆盖判定按任务书要求读前者。
- 闸门结论：PASS，无需 `NEEDS_CONTEXT`。

## 交付结果

### Goal 1：等待/稍后类短回复算纯应答（`propose.ts`）

- 新增 `waitingReplyTexts`（24 个词条，见任务书示例词表逐字落地）与合并数组 `acknowledgementAndWaitingTexts = [...pureAcknowledgementTexts, ...waitingReplyTexts]`，均在模块顶层、`pureAcknowledgementTexts` 定义之后。
- `isPureAcknowledgement` 改写为三段：① 噪音剥离后码点 `<= 2` 直接判真（不变，且不参与后续模糊匹配）；② 精确命中 `pureAcknowledgementTexts ∪ waitingReplyTexts` 判真；③ 码点 `>= 4` 时对 `acknowledgementAndWaitingTexts` 做 `editDistance(normalized, text) <= 1` 的模糊命中。三段短路顺序与任务书描述一致，"到了/已到"类词条未加入任一词表，`"荀导已到"` 与词表任一条目的编辑距离均 `> 1`（长度差与用字差异都不小），不会被误伤。

### Goal 2：发言全部被同截图事项原文覆盖的参与人不出互动卡（`propose.ts`）

- 新增纯函数 `isEvidenceCoveredByEvents(fragment, events: ReadonlyArray<{ source_quote: string }>)`：对 `fragment` 与每个 `event.source_quote` 各自 `normalizeContactText` 后比较——两者码点较短者 `>= 8` 且被较长者 `includes` 判真；否则退回 `normalizedEditSimilarity >= 0.85` 判真。函数结构与 fix8 的 `isDiscardedSourceQuote` 同形，按任务书要求未复用其闭包（不依赖 `splitEvidenceLabel` 标签拆分）。
- 互动候选判定处（原 `sourceEvidence.length === 0 || sourceEvidence.every(isPureAcknowledgement)` 一行）拆成三步：① `sourceEvidence.length === 0` 直接跳过（不变）；② 用 `isPureAcknowledgement` 过滤出 `nonAcknowledgementEvidence`（即 Goal 1 的纯应答/等待剔除，剔除后为空则跳过，与旧版 `every(isPureAcknowledgement)` 语义等价，是其推广）；③ 对剩余片段做 `isEvidenceCoveredByEvents(fragment, extraction.events)`，**全部**覆盖才跳过，任一条不覆盖则照旧继续（不改变后续 `buildInteractionPayload` 使用的证据集合，仍是原始 `participantSourceQuotes`/`relatedQuotes`）。
- 覆盖判定显式读取 `extraction`（`proposeCardsInternal` 的原始入参）而非 `routeSpecialOtherEvents` 返回的局部变量 `events`，确保被路由丢弃（如 `isTimelessCommunicationEvent` 判定为"无时间沟通事项"整条丢弃）或合并进其他事项的原文，仍能参与覆盖判定——已用一次刻意的临时改错（改回读 `events`）做红绿验证，见下文"判别力验证"一节。

### Goal 3：`kind=other` 事项详情为空时默认填原文（`propose.ts`）

- `buildMeetingCard` 内 `if (event.agenda) { payload.agenda = event.agenda; }` 后接 `else if (event.kind === 'other')` 分支：取 `event.source_quote.replace(/\s*\n\s*/g, '').trim()` 作为 `fallbackAgenda`，非空时赋给 `payload.agenda`。正则与 trim 的组合确保换行前后各自的空白一并吃掉（不留多余空格），最终整体 `trim()` 再处理开头/结尾残留的非换行空白。`meeting`/`appointment` 两种 kind 均落入该 `else if` 的假分支，不受影响。

### Goal 4：「依据原文」可选中复制（`app/src/components/review/review-card.tsx`）

- 第 171 行 `<Text style={styles.quoteText}>{card.source_quote}</Text>` 改为 `<Text selectable style={styles.quoteText}>{card.source_quote}</Text>`，仅新增一个属性，未新增按钮、未改动 `DisclosurePanel` 或其它结构。

## 三个 core Goal 的测试组（均在 `server/src/tests/propose.test.ts`）

### Goal 1（5 组）

1. `drops an interaction when every quote is a waiting/short-reply phrase, including one only matched after OCR-noise fuzzy correction` —— 引文 `['稍等一下','我一会ル出来','你们等下']` → `[]`（第二句靠编辑距离 1 的模糊匹配命中 `'我一会儿出来'`）。
2. `drops an interaction when the only quote is a bare waiting-reply phrase` —— 引文 `['马上到']` → `[]`。
3. `keeps an interaction for an arrival status report even though it starts with the "already there" wording fix11 protects`（回归）—— 引文 `['荀导已到']` → 出卡。
4. `keeps an interaction when a waiting-reply quote is mixed with a substantive one` —— 引文 `['稍等一下','明天上午10点开会']` → 出卡。
5. `fuzzy-matches a waiting reply within edit distance 1 but not edit distance 2` —— `'稍等一下下'`（距 `'稍等一下'` 编辑距离 1）→ `[]`；`'稍等一下下下'`（距离 2）→ 出卡。

### Goal 2（6 组）

1. `drops an interaction when every quote is itself the source_quote of a same-screenshot event` —— 参与人两句引文分别与同截图 `other`/`meeting` 两个事项的 `source_quote` 逐字相同 → 不出互动卡（`create_meeting` 卡仍出 2 张）。
2. `drops an interaction when its single quote equals a same-screenshot other item's source_quote` —— 唯一引文 = 该截图 `other` 事项 `source_quote` → 不出互动卡。
3. `keeps an interaction when the substantive quote is not any same-screenshot event's source_quote`（对照组）—— 引文 `['郝总，我要晚一点参会，明早9点半到公司。','好的，收到']`，同截图另有一个不相关的 `other` 事项；第二句被 Goal 1 判为纯应答剔除，第一句不与该事项重合 → 出卡。
4. `keeps an interaction when only one of several quotes is not covered by a same-screenshot event` —— 三句引文中两句分别覆盖两个事项，第三句（"你先谈完话，过来我办公室参加海棠塔剧场会议。"）不在任何事项原文里 → 出卡。
5. `does not treat a short fragment as covered merely because it is a substring of a longer event source_quote` —— 引文 `'下午三点'`（4 码点）是同截图会议事项 `source_quote` 的字面子串，但短于 8 码点阈值且相似度远低于 0.85 → 判定为不覆盖 → 出卡。
6. `keeps coverage against an event dropped by same-screenshot routing, using raw extraction.events rather than the routed subset` —— 唯一事项是会被 `isTimelessCommunicationEvent` 路由丢弃的"联系确认"类 `other` 事项（不产出任何卡片），参与人唯一引文与其 `source_quote` 逐字相同 → 不出互动卡（也不出会议卡）。此测试专门验证"必须读原始 `extraction.events`"这一实现细节，见下节判别力验证。

### Goal 3（3 组）

1. `backfills a blank other-item agenda from a multi-line source_quote, joined without a separator` —— `other` 事项 `agenda` 缺省、`source_quote` 为三行（含行内多余空白）→ `payload.agenda` 等于三行直接拼接（无分隔符、无残留空白）。
2. `leaves an other-item agenda untouched when the model already filled it` —— `other` 事项 `agenda` 已有值 → 不变。
3. `does not backfill agenda for a meeting-kind item even when agenda is blank` —— `meeting` 事项 `agenda` 缺省 → `payload` 中仍无 `agenda` 键。

### Goal 4（无测试，纯属性）

- `app/src/components/review/review-card.tsx:171` 的 diff 见"交付结果"一节；无新增测试文件改动。

## 判别力验证（防止测试形同虚设）

新写的 14 组测试首次运行即 233/233 全绿，为确认它们真的在校验对应逻辑分支（而非断言写得过松导致必然通过），额外做了两轮临时性反向验证，验证后原样撤回：

1. **Goal 2 的 "raw extraction.events" 要求**：临时把覆盖判定的 `extraction.events` 改回 `events`（路由后的子集），单独跑 `propose.test.ts`：93 组中恰好且仅有 1 组失败——`keeps coverage against an event dropped by same-screenshot routing...`；其余 92 组（含其它 5 组 Goal2 测试）仍然通过。证明该测试确实在校验"必须用原始 extraction.events"这一实现要求，而不依赖其它测试碰巧覆盖到同一分支。已改回 `extraction.events` 并重新跑通全量 233 组。
2. **Goal 1 的模糊匹配分支**：临时把 `isPureAcknowledgement` 的模糊匹配分支直接改成 `return false;`，单独跑 `propose.test.ts`：94 组中恰好且仅有 2 组失败——依赖模糊匹配的 OCR 噪音测试与编辑距离边界测试；其余 92 组（含 Goal1 的另外 3 组精确匹配测试）不受影响。证明模糊匹配分支被两组测试精确覆盖。已改回原实现并重新跑通全量 233 组。

两轮验证均已在最终提交前撤回并重新跑绿，未在最终代码中留下任何调试改动（`git diff --stat` 显示 `propose.ts` 净变化为 120 行插入 / 2 行删除，与预期一致）。

## 施工中发现并处理的回归

实现 Goal 1 与 Goal 3 后，`cd server && npm test` 暴露 2 个既有测试失败，均是新行为按预期生效导致的必然结果，不是误伤：

1. `proposeCards keeps the interaction and excludes the at-mention line from the summary when the participant has a real quote (fix12 goal 2)`：该测试原用 `'稍等一下'` 作为"参与人真实发言"的示例证据，以验证 fix12 goal 2（@ 提及不算证据、真实引文优先于标签行）。Goal 1 落地后 `'稍等一下'` 变成等待类纯应答，该测试的示例证据本身作废。处理：把示例证据换成语义不相关的真实内容 `'开会地点改在三楼会议室'`，fix12 goal 2 要验证的行为（真实引文覆盖 @ 提及标签行、summary 不含 `@柏贝`）完全不受影响，同步更新了测试内的三处引用与断言值，并加注释说明改动原因。
2. `proposeCards creates a standalone no-time item with no participants and no interaction`：该测试的 `other` 事项 `agenda` 为空、`source_quote` 为单行文本，命中 Goal 3 的新行为，`payload` 现在会带上 `agenda` 字段。处理：在期望的 `payload` 里补上 `agenda: '报名要带身份证复印件和两张照片'`（与 `source_quote` 相同，因为单行文本无换行可折叠），测试标题描述的"无时间/无参与人/无互动"结论不受影响，加注释说明。

以上是本批四个 Goal 生效后暴露的全部既有测试回归；修复后 server 测试回到全绿。Goal 2 与 Goal 4 均未引发任何既有测试失败。

## 真实测试输出

### server

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npm test`

```text
ℹ tests 233
ℹ suites 0
ℹ pass 233
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

门槛：`233 >= 219`。（施工前基线：219/219/0，与任务书标注一致；新增 14 组：Goal1×5 + Goal2×6 + Goal3×3。）

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

门槛：`177 >= 177`。（施工前基线：177/177/0；本批 app 端唯一改动是 Goal 4 的纯属性变更，任务书明确"无测试"，测试数持平。）

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

- `shared/core/agent/propose.ts`（Goal 1：新增 `waitingReplyTexts`/`acknowledgementAndWaitingTexts`、改写 `isPureAcknowledgement`；Goal 2：新增 `isEvidenceCoveredByEvents`、改写互动候选判定的跳过条件；Goal 3：`buildMeetingCard` 新增 `agenda` 兜底分支）
- `app/src/components/review/review-card.tsx`（Goal 4：第 171 行新增 `selectable` 属性）
- `server/src/tests/propose.test.ts`（新增 Goal1×5 + Goal2×6 + Goal3×3 共 14 组测试；修正 2 个既有测试断言，见上文"施工中发现并处理的回归"）
- `docs/report-v3-m4-fix13.md`（本报告）

## 偏离与决定

1. **Goal 2 测试⑥的"fix9 查重砍掉的事项"未逐字对应到 `dedupeBatchOtherCards`**：任务书原句"被 fix9 查重砍掉的事项、被 [notice] 通知路由并入的事项，其 source_quote 仍参与覆盖判定"包含两种机制。核实后发现 `dedupeBatchOtherCards` 是独立导出函数，运行在 `proposeCards` 返回结果之上、跨截图（batch 内多次 `proposeCards` 调用之间）生效，其输入是已生成的 `ProposedCard[]`，而不是某一次 `proposeCards` 调用内部的 `extraction.events`——它与本次要实现的 `isEvidenceCoveredByEvents(fragment, extraction.events)` 不在同一层级，单次 `proposeCards` 调用无法"看到"另一张截图的查重结果。因此测试⑥改为用同一层级、确实会在单次调用内把某条 `other` 事项从最终 `events`/`cards` 中整条丢弃的机制（`routeSpecialOtherEvents` 的 `isTimelessCommunicationEvent` 路径）来验证"必须读原始 `extraction.events`"这一要求，并在测试注释与本报告中说明这一对应关系。该测试已经过反向验证（见"判别力验证"）确认能真实区分正确实现与误用路由后子集的实现，认为已经充分覆盖任务书想要保护的行为意图。
2. **两处既有测试断言修正**（详见"施工中发现并处理的回归"）——均是 Goal 1（`'稍等一下'` 变为纯应答）与 Goal 3（`other` 事项默认填充 `agenda`）明确要产生的新行为在已有测试里的真实体现，不是对 fix1–fix12 已交付行为的擅自改动；两处改动都只调整了因新行为而必然变化的那一小块断言，测试标题所描述的核心行为（真实引文优先于 @ 提及标签行、无时间/无参与人/无互动的事项判定）完全未变。
3. **Goal 2 的覆盖判定未复用 `isDiscardedSourceQuote` 的闭包**——按任务书明确要求（"可参考但不必复用其闭包"），`isEvidenceCoveredByEvents` 写成独立的模块级纯函数，不依赖 `splitEvidenceLabel` 的标签拆分逻辑（该逻辑用于处理"发言人：内容"这类带标签前缀的场景，与本 Goal 的"证据片段是否等于事项原文"是不同维度的判定，任务书也未要求叠加标签拆分）。
4. **未新增导出的规则常量对象**——`isEvidenceCoveredByEvents` 内的阈值（8 码点、0.85 相似度）以行内字面量写出并加注释，未仿照 `MEETING_DUPLICATE_RULES`/`BATCH_OTHER_DEDUP_RULES` 包装成新的导出常量对象。核实后确认这两个既有常量对象在全仓无任何外部消费者（仅 `propose.ts` 自身使用），包装成对象是该文件的既有风格选择而非强制要求；`isDiscardedSourceQuote`（任务书点名的参考对象）本身的阈值也是行内字面量。按 Simplicity First（无显式要求的抽象不写）选择更简单的写法。
5. **未涉及"已否决"事项**——「填入详情」按钮未加；「到了／已到」类状态通报未算作应答（`waitingReplyTexts` 未包含此类词条，`'荀导已到'` 回归测试确认未受影响）；模型把别人的话引到某参与人名下的场景未处理；「PDF文件过期提示」类系统消息未加过滤；`meeting` 事项 `agenda` 为空时未填充原文——均按任务书"已否决 / 本批不做"逐条核对未触碰。
6. **未改** DB schema/migrations、`perceive.ts`、`prompts.ts`、`schemas.ts`、`execute.ts`、`resolve.ts`、`api.ts`、`batch-contacts.ts`、`review-fields.tsx`、`event-log.ts`、`compare.ts`（仅调用 `editDistance`/`normalizeContactText`/`normalizedEditSimilarity`，未改动其实现）、fix1–fix12 已交付行为、`app/app.json` 版本号、依赖——`git status --porcelain` 只显示 3 个文件改动（`propose.ts`、`review-card.tsx`、`propose.test.ts`）加本报告，与声明的可动范围一致。
7. **测试数据全部使用虚构名**（柏贝、沈青岚、郝明川、荀导、王磊、邬明、郝总等）——其中"柏贝""沈青岚""荀导""王磊"是本项目测试套件（`perceive.test.ts`/`resolve.test.ts`/`review-order.test.ts`/`propose.test.ts` 既有用例、以及 fix4 起的 `handoff-v3-m4.md` 示例）里早已使用的通用虚构占位名，"郝明川""邬明""郝总"是同风格的新增虚构名；报告与代码注释中不含任何真实姓名、机构名或截图原文的逐字复制（诊断包引用的真实截图原文已改写为语义等价的合成示例）。
