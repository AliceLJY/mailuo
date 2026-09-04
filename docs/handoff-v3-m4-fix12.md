# 脉络 Mailuo — v3-M4-fix12 施工交接（3.1.11 首批真机反馈六件：证据归属 + 查重合并日期 + 昵称覆盖会议参与人 + 相关人清空即移除）

## 你的角色

接 v3.1.11。六件小事，**每件都对着 3.1.11 首批诊断包（2026-09-04 07:49 批，`/tmp/diag6/new/`）里一张具体的卡**，Alice 已拍板「派」。
core + app 各动一点；**不动 DB schema、不动 prompt、不动 schemas.ts / execute.ts / resolve.ts、不加 UI 按钮。** 施工图 PLAN.md（第 0 节适用），
先 `git log -3` 同步认知。自验用本机 Node 26。

## 诊断包实证（v3.1.11，owner 直读；人名按截图原样，测试一律换虚构名）

- **卡 #21 互动「集团濱艺事业部沈青岚；收到」被提出（她拒了）**：`participant.source_quote='集团濱艺事业部沈青岚'`（部门+名字**无空格、名字在片段末尾**），
  `relatedQuotes=['收到']`，LLM `speech_act=initiate`。fix11 的 `stripParticipantPrefix` 要求名字后紧跟分隔符才剥——末尾无后字符 → 不剥 → `every(isPureAcknowledgement)` 失败。
- **卡 #5（柏贝）/ #6（沈青岚）互动被提出（她拒了）**：两人的 `participant.source_quote` 都是郝明川那条「@柏贝@沈青岚明天 28日…调整为10:30开。」——
  模型把 **@ 他们的消息**当成了他们的证据；#6 沈青岚没有任何 quotes，#5 柏贝的 quotes 是「稍等一下／我一会ル出来／你们等下」。互动摘要写的全是通知者的话。
- **卡 #10「报损备车牌号及安排工作餐」`time_text=明天上午, time_iso=null`**：fix9 查重在 trace 3 命中（相似度 0.975）砍掉了 shot 3 的
  「联系隋导报备车牌号并安排工作餐」——**被砍的那条 `time_iso=2026-08-26`**（模型从同截图「明天8月26日」推出），保留的先出卡没有。keep-first 丢了日期。
- **`confirm_error Invalid create_meeting payload` ×2（23:58:55 / 23:59:14）**：她在会议卡「相关人」里把被误判为「我」的那一格清空后确认；
  确认页相关人是按序号编辑的文本框，清空即留下 `name=""` 的参与人，`MeetingParticipantSchema.name.min(1)` 拒绝。参与人为零（空数组）本就合法。
  **Alice 拍板：清空即视为移除，不加「移除」按钮。**
- **shot 2 沈青岚 `is_self=true`（第四次同型误判）**：模型把她同事判成右侧气泡；沈青岚是已建联系人（本批 shot 1 建的 contact 2）。
- **她昵称框填了本名「李菁雅」却未被识别**：shot 5 事件「花城号…」`participant_names=['郝明川','沈青岚','青岚','柏贝']`——「柏贝」是 OCR 把「菁雅」认错，字不同对不上（不可修，只能靠她多登记一个昵称）；
  **但即便字对上也扫不到**：`perceive.ts applySelfNames` 只改 `extraction.participants[].is_self`，**不碰 `events[].participant_names`**，而会议卡的参与人正是从后者来的（`propose.ts buildMeetingCard` 用 `selfParticipantNames.has(normalizeSelfName(name))` 判「我」，`selfParticipantNames` 只从 participants 里 is_self 的收集）。

## Goal

### 1. 纯应答判定：本人引文优先（core，`propose.ts` 约 1913 行）
- `sourceEvidence` 改为：`candidate.relatedQuotes.length > 0` → 只用 `relatedQuotes.map(q => q.text)`；否则用 `participantSourceQuotes.map(f => stripParticipantPrefix(f, …))`（保留 fix11）。
- 理由：quotes 是模型引用的**本人发言**，OCR 原行（participant.source_quote）常是发送者标签行；本批实测模型引用基本全量。
- 测试（虚构名）：①`source_quote='集团濱艺事业部小禾'`（无空格、名在末尾）+ quotes `['收到']` → 不出互动卡 ②quotes `['收到','明天上午10点开会，大家准时']` → 出卡 ③无 quotes、`source_quote='集团市场部 小禾 收到'` → 不出（fix11 回归）④无 quotes、`source_quote='小禾 明天上午10点开会'` → 出卡。

### 2. @ 提及的消息不算被提及者的证据（core，`propose.ts` 约 1754–1775 行构建候选处）
- 构建 `candidate.participantSourceQuotes` 时，凡片段含 `@<participant.name>`（或 `@<任一 alias>`，忽略 `@` 后空白）→ 剔除（那是别人 @ 他，不是他说的）。剔除后若 `participantSourceQuotes` 与 `relatedQuotes` 均为空 → 不出互动卡。
- 同一处剔除即可让 `buildInteractionPayload` 的 summary 不再包含通知者的话。
- 测试（虚构名）：①柏贝 `source_quote='@柏贝@小禾明天28日…'`，无 quotes → 不出卡 ②同上但 quotes `['稍等一下']` → 出卡且 summary 不含「@柏贝…」那句 ③片段 `'@ 柏贝 …'`（@ 后有空格）同样剔除 ④普通片段（不含 @本人）不受影响。

### 3. 同批查重命中时把被砍卡的日期合并进保留卡（core + app）
- `dedupeBatchOtherCards` 的 match 增加被砍卡的 `time_iso` / `time_text` / `agenda`；`batch-contacts.ts prepareScreenshot` 对每个 match：若保留卡（`matched_card_id`，须仍 `pending`）`payload.time_iso == null` 且被砍卡 `time_iso != null` →
  产出一条 pending 卡更新 `{ cardId, payload: { ...保留卡 payload, time_iso, time_text } }`（`agenda` 仅在保留卡为空时补）；`api.ts` 用**既有** `options.store.updatePendingActionCard({ cardId, payload })` 落库（fix3 的 `pendingCardUpdates` 通道类型是 `CreateContactPayload`，
  可另加 `pendingMeetingUpdates: { cardId: number; payload: CreateMeetingPayload }[]`，或把类型放宽为 `ActionCard['payload']`——取改动更小者）。保留卡已 rejected / confirmed → 不更新。
- trace `batch_other_dedup` 每条加 `merged_time: boolean`。
- 测试（虚构名）：①先出 other `time_iso=null`，后出匹配 other `time_iso=2026-08-26T00:00:00+08:00` → 后出不提出、先出卡 payload 更新为该 time_iso/time_text ②先出已有 time_iso → 不改 ③先出已 rejected → 不改、后出仍不提出（fix9 ⑤）④trace 记 `merged_time`。

### 4. 会议卡相关人：清空即移除（app，`app/app/review/[screenshotId].tsx` handleConfirm）
- 确认 `create_meeting` 前把 `participants` 中 `name.trim()===''` 的项过滤掉（`[]` 合法）。**不加「移除」按钮**（Alice 拍板）。
- 测试：抽成纯函数 `normalizeMeetingParticipantsForConfirm(participants)`：①`['柏贝','']` → `['柏贝']` ②`['','  ']` → `[]` ③含 `contact_id`/`candidates` 的项原样保留。

### 5. 昵称覆盖到事项参与人（core，`perceive.ts applySelfNames`）
- `selfNames` 非空时，`events[].participant_names` 中命中 `isSelfName(name, selfNames)` 的项改写为 `'我'`（同一事件内多个命中合并为一个「我」）。`buildMeetingCard` 既有逻辑随即显示为「我」。
- 测试（虚构名）：①`participant_names=['柏贝','李菁雅']`，selfNames `['李菁雅']` → `['柏贝','我']` ②`['菁雅','李菁雅']` 两个都命中 → `['我']` ③selfNames 空 → 不动 ④`participants` 的既有 is_self 行为不变（回归）。

### 6. 反向自我判定：被判为「我」的已知联系人翻回外人（core + app）
- `applySelfNames(extraction, selfNames, knownContactNames)` 新增第三参：参与人 `is_self===true` 且 `name !== '我'` 且 `!isSelfName(name, selfNames)` 且 `normalizeContactText(name)` 命中 `knownContactNames` → `is_self=false`。**不命中已知联系人的不翻**（防误伤她自己的账号名如「安闲静雅」被模型正确判为本人的情况）。
- `api.ts` 两条感知路径（粘贴文本约 169 行、截图约 349 行）把 `[...listResolvableContacts(store), ...(batchSession?.listPendingContacts() ?? [])]` 的 `canonical_name`（+ aliases）传入；**注意现在 contacts 在 applySelfNames 之后才取，需先取**（contacts 不依赖 extraction）。
- 测试（虚构名）：①沈青岚 `is_self=true`、已知联系人含沈青岚、selfNames `['李菁雅']` → `false` ②「安闲静雅」`is_self=true`、不是已知联系人 → 保持 true ③名字在 selfNames 里的 → 保持/置 true ④`knownContactNames` 空 → 不翻。

## 已否决 / 本批不做
- 「移除相关人」按钮：Alice 拍板不加，清空即移除。
- 「会议参会人员请示」类沟通事项借用同截图会议时间（has_time_signal=true）也拦：易误伤真有时间的 other，owner 决定先观察。
- 拍照/上传时间锚定相对日期：fix8 已否决；本批第 3 条已解决这一例。
- OCR 形近字（柏贝/菁雅、高鸡涛/高鸿涛）：不可修；她可多登记昵称。
- `集团 市场部` / `集团副总` 被抽成 name：fix4 老问题，另批。
- 「稍等一下／你们等下」这类短回复算不算应答：不扩词表。

## Scope
- 可动：`shared/core/agent/propose.ts`、`shared/core/agent/perceive.ts`、`app/src/local/api.ts`、`app/src/local/batch-contacts.ts`、`app/app/review/[screenshotId].tsx`（仅 handleConfirm 前的参与人过滤 + 抽出的纯函数，纯函数可放 `app/src/review-order.ts`）、`app/src/diagnostics/trace-store.ts`（仅 `merged_time` 可选字段）、测试、快照。
- 不可动：DB schema / migrations、`prompts.ts`、`schemas.ts`、`execute.ts`、`resolve.ts`、`review-fields.tsx`、`event-log.ts`、fix1–fix11 已交付行为、`app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）
- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when
1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 202、app 不低于 171；`git diff --check` 干净
2. 六个 Goal 各自的测试组全部落地
3. 报告 `docs/report-v3-m4-fix12.md`（与 fix10/fix11 报告同结构）贴真实测试输出、文件清单、偏离决定；只写本仓的事
