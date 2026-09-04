# 脉络 Mailuo — v3-M4-fix13 施工交接（3.1.12 真机反馈四件：等待类应答 + 公告覆盖不出互动 + 事项详情默认原文 + 原文可选中）

## 你的角色

接 v3.1.12。四件小事，**每件对着 3.1.12 首批诊断包（2026-09-04 09:46 批，`/tmp/diag7/`）里一张具体的卡**，Alice 拍板「派！做！」。
core 三件 + UI 一处属性；**不动 DB schema、不动 prompt、不动 perceive.ts / schemas.ts / execute.ts / resolve.ts / api.ts / batch-contacts.ts / review-fields.tsx / event-log.ts。**
施工图 PLAN.md（第 0 节适用），先 `git log -3` 同步认知。自验用本机 Node 26。

## 诊断包实证（v3.1.12，owner 直读；人名按截图原样，测试一律换虚构名）

- **卡 #6 互动「柏贝；稍等一下；我一会ル出来；你们等下」（她拒）**：柏贝的 quotes 恰为这三句，LLM `speech_act=initiate`。等待/稍后类短回复目前不在 `pureAcknowledgementTexts`，且「我一会ル出来」含 OCR 噪音「ル」，精确词表匹配不到。
- **卡 #11 / #16 / #19 / #23 互动（她全拒）——"谁发起了会议 / 谁被通知了"**：这些人的 quotes **每一句都是同截图某个会议/事项的 `source_quote` 本身**。
  例 #11 郝明川：quotes = 「@沈青岚你和隋导联系一下,给他报损备明天上午过来集团开会的车牌号。」（= other 事项「报损备车及工作餐安排」的 source_quote）+「8月27日(周四)上午9:30在集团1512会议室召开“爱达·花城号”…」（= meeting 事项的 source_quote）。
  例 #23 沈青岚：唯一 quote「广杂请示明天上午会议除郝总参加外,市场部是否有人参会。」= other 事项「会议参会人员请示」的 source_quote。
  会议/事项已各自成卡，互动卡在重复记同一件事。**对照组（必须保留）**：#20 柏贝「郝总,我要晚一点参会,明早9点半…」+「好的,收到」——她确认了，第一句不是任何事项原文；#19 郝明川有一句「你先谈完话,过来我办公室参加海棠塔剧场会议。」不是事项原文 → 仍应出卡。
- **卡 #17「提交证明材料或情况说明」（other）`agenda=None`**：模型 `event.agenda=None`，而 `source_quote` 是完整四条要求「【补充】1,有正式且现成证明材料的,请立即堤供;2.没有直接证明材料的,可写情况说明…4.以上事项,完成一顶提供一项…」。她确认后只能手动把原文敲进详情。
- **她原话**：「依据原文我建议允许手动复制，我现在复制补进去事项详情，难道让我一个字一个字敲么」——`review-card.tsx:171` 的「依据原文」`<Text>` 没有 `selectable`。

## Goal

### 1. 等待/稍后类短回复算纯应答（core，`propose.ts isPureAcknowledgement` 约 1356 行）
- 新增词表 `waitingReplyTexts`（示例，可增删同类）：稍等、稍等一下、稍等片刻、等下、等一下、等我一下、你们等下、你们等一下、马上、马上到、马上来、马上过来、一会、一会儿、一会出来、一会儿出来、我一会出来、我一会儿出来、在路上、快到了、稍后、稍后回复、稍后回、晚点回。
  **不含**「到了 / 已到 / X已到」（fix11 保护的「荀导已到」是状态通报，不是等待回复）。
- 匹配：噪音剥离后（沿用 `acknowledgementNoisePattern`）先精确命中 `pureAcknowledgementTexts ∪ waitingReplyTexts`；**再对码点长度 ≥ 4 的片段做 `editDistance ≤ 1` 的模糊命中**（只对两个词表，不对「≤2 码点即应答」那条），以吸收 OCR 噪音（「我一会ル出来」↔「我一会儿出来」）。`editDistance` 在 `shared/core/text/compare.ts`。
- 测试（虚构名）：①quotes `['稍等一下','我一会ル出来','你们等下']` → 不出互动卡 ②`['马上到']` → 不出 ③`['荀导已到']` → 出（回归）④`['稍等一下','明天上午10点开会']` → 出 ⑤`['稍等一下下']`（距离 1）→ 不出；`['稍等一下下下']`（距离 2）→ 出。

### 2. 发言全部被同截图事项原文覆盖的参与人不出互动卡（core，`propose.ts` 互动候选判定处约 1964 行）
- 定义「覆盖」：对参与人的每条证据片段 `f`（有 quotes 用 quotes；否则用剥前缀后的 participantSourceQuotes，与 fix12 一致），存在本截图 `extraction.events` 中某事件 `e`（**用原始 `extraction.events`，不用路由/查重后的子集**——被并入或被砍的事项原文也算"已有去处"），使 `normalizeContactText(f)` 与 `normalizeContactText(e.source_quote)` 满足：较短者码点 ≥ 8 且被较长者包含，**或** `normalizedEditSimilarity ≥ 0.85`。判定可抽成纯函数 `isEvidenceCoveredByEvents(fragment, events)`；fix8 的 `isDiscardedSourceQuote`（约 1307 行）是同类包含逻辑，可参考但不必复用其闭包。
- 证据非空且**每一条都被覆盖** → 不出互动卡；任一条不被覆盖 → 照旧。
- 与 Goal 1 的关系：先剔除纯应答/等待类片段，再对**剩余**片段做覆盖判定；剩余为空 → 不出卡。
- 测试（虚构名）：①郝明川 quotes 两句分别等于同截图 other 与 meeting 的 source_quote → 不出 ②沈青岚一句 = other 的 source_quote → 不出 ③柏贝「郝总,我要晚一点参会,明早9点半…」+「好的,收到」，事项原文里没有前者 → **出卡**（对照组）④郝明川三句中一句「你先谈完话,过来我办公室参加会议」不在任何事项原文里 → **出卡** ⑤片段短于 8 码点且不相似 → 不算覆盖 ⑥被 fix9 查重砍掉的事项、被 Goal 2 通知路由并入的事项，其 source_quote 仍参与覆盖判定。

### 3. `kind=other` 事项详情为空时默认填原文（core，`propose.ts buildMeetingCard` 约 798 行）
- `event.kind === 'other'` 且 `!event.agenda?.trim()` → `payload.agenda = event.source_quote` 经 `trim()` 并把行内换行（`/\s*\n\s*/g`）压成空串（OCR 把一句话拆成多行，中文直接拼接更可读）。**meeting / appointment 不填**（公告与标题时间重复，噪音）。
- 测试（虚构名）：①other 事项 `agenda` 为空、`source_quote` 三行 → payload.agenda = 三行拼接 ②other 事项 `agenda` 已有 → 不动 ③meeting 事项 `agenda` 为空 → 仍为空。

### 4. 「依据原文」可选中复制（app，`app/src/components/review/review-card.tsx:171`）
- `<Text selectable style={styles.quoteText}>{card.source_quote}</Text>`。只加这一个属性，不加按钮。
- 无测试（纯属性）；报告里贴 diff 行即可。

## 已否决 / 本批不做
- 「填入详情」按钮：Goal 3 已覆盖主要场景，且 Alice 不喜欢多按钮。
- 「到了／已到」类状态通报算应答：与 fix11 保护的「荀导已到」冲突，不动。
- 模型把别人的话引到某参与人名下（#7「你们通知海棠塔和隋导这个时间」实为郝总所说）：规则无法判定说话人归属，不做。
- 「PDF文件过期提示」类系统消息被抽成事项：模型偶发，不加过滤。
- meeting 事项 agenda 为空时填原文：会与标题/时间重复，不做。

## Scope
- 可动：`shared/core/agent/propose.ts`、`app/src/components/review/review-card.tsx`（仅第 171 行 `selectable`）、`server/src/tests/propose.test.ts`、其它测试/快照。
- 不可动：DB schema / migrations、`perceive.ts`、`prompts.ts`、`schemas.ts`、`execute.ts`、`resolve.ts`、`api.ts`、`batch-contacts.ts`、`review-fields.tsx`、`event-log.ts`、`compare.ts`（只调用不改）、fix1–fix12 已交付行为、`app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）
- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when
1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 219、app 不低于 177；`git diff --check` 干净
2. Goal 1 五组、Goal 2 六组、Goal 3 三组测试落地；Goal 4 报告贴 diff
3. 报告 `docs/report-v3-m4-fix13.md`（与 fix12 报告同结构）贴真实测试输出、文件清单、偏离决定；只写本仓的事
