# 脉络 Mailuo — v3-M4-fix15 施工交接（恢复已跳过的卡 + 确认时间友好显示）

## 你的角色

接 v3.1.14。两件事，出自 Alice 对 3.1.14 的真机反馈（2026-09-04 17:2x）。**不动 DB schema / 不做迁移**（`action_cards.status` 的 CHECK 本就含 `pending`，恢复 = 状态回写，不需要新列）；
不动 prompt / perceive.ts / propose.ts / resolve.ts。施工图 PLAN.md（第 0 节适用），先 `git log -3` 同步认知。自验用本机 Node 26。

## 真机实证（owner 直读 `/tmp/diag9/`，3.1.14 批）

- **Alice 原话**：「我建议卡片那个按钮加一个可以反悔的，有些跳过的，我后面想确认」。代码事实：`shared/core/agent/execute.ts rejectCard` 只允许 pending→rejected；store 无 reopen；`RoutedApi` 写操作只有 `confirmCard / rejectCard`；`review-card.tsx` 对 `status==='rejected'` 的卡 `stage='done'`、不渲染任何按钮。
  fix10 时 owner 曾评估此项为「方案 B」（撤销跳过），当时先做了非线性；现在她明确要。
- **「报车牌还是没有日期」→ 数据对、显示错**：卡 #7 `payload.time_iso = "2026-08-26T00:00:00+08:00"`（fix12 查重合并日期这次真生效并落库，trace 3 `merged_time:true`），但
  `app/src/components/review/review-fields.tsx:391-397`「确认时间」是 `dualColumn` 半宽**单行** `FieldInput`，值为 ISO 原串 → 截断后只见尾巴「…00:00+08:00」；placeholder「看起来不对就手动改」也被截。她因此把一张对的卡拒了。
  fix3 验收时已记为附带发现③、fix8 列入不做；现在有实证代价，做。

## Goal

### 1. 已跳过的卡可恢复为待确认（core + app）
- **store**（`app/src/local/types.ts` + `store.ts`）：新增 `reopenActionCardIfRejected(cardId): ActionCardRecord | null`——`UPDATE … SET status='pending', resolved_at=NULL, resolved_contact_id=NULL WHERE id=? AND status='rejected'`，与 `rejectActionCardIfPending` 对称。
- **execute**（`shared/core/agent/execute.ts`）：新增 `reopenCard({ db, cardId })`：不存在 → `ExecuteNotFoundError`；`status !== 'rejected'` → `ActionCardConflictError`（"already pending/confirmed"）；成功返回记录。事务包裹，风格与 `rejectCard` 一致。
- **RoutedApi**（`app/src/connection/dispatch.ts`）：`reopenCard(cardId): Promise<{ card: ActionCardRecord }>`；本地实现 `app/src/local/api.ts` 调 `reopenCard`，**并同步 batch session**：新增 `LocalBatchContactSession.registerReopenedAnchor(card)`（`app/src/local/batch-contacts.ts`）——
  ①若卡是 `create_contact`：按卡 payload 重建 pending 联系人并接回 `temporaryIdByAnchorCardId` / `pendingByTemporaryId`（复用 `commitScreenshot` 为 savedCards 里 create_contact 建 pending 的那段逻辑，抽成私有方法共用，不要复制一份）；
  ②若卡是 `create_meeting(kind=other)`：`batchOtherCardsById` 里该卡 status 回 `pending`（fix9 tombstone 解除）；
  ③`hasTrackedCard` 保持为真。session 不存在（app 重启后）时只做 store 回写，依赖判定走持久化的 `anchor_card_id`（fix3 已有）。
  server 实现（`app/src/api.ts`）抛「服务器模式暂不支持恢复」（与 `readDiagnosticsSnapshot` 同款占位，不动 `server/src`）。
- **UI**：`review-card.tsx` 对 `card.status === 'rejected'` 渲染一个 `tone="secondary"` 的「恢复为待确认」按钮（**只在已跳过的卡上；已确认的卡不加任何按钮**——那是另一轮的事）；`app/app/review/[screenshotId].tsx` 加 `handleReopen`：调 `reopenCard` → 刷新该截图详情（复用 `refreshScreenshot` 的 `preserveScreenshotId`）→ toast「已恢复，可以重新确认」→ 黑匣子 `card_reopened`（`event-log.ts` 仅新增此一种；detail `id=…,type=…`）。恢复后按非线性规则（fix10）该卡即可编辑，`currentPendingCard` 由既有排序自然得出。
- **依赖联动**：恢复一张 `create_contact` 后，同截图依赖它的互动卡的提示应回到「请先确认『新建联系人 X』那张卡」（`getInteractionDependencyMessage` 基于卡状态，应自动生效——加测试证明）。
- 测试：①store：rejected→pending 成功；pending/confirmed 调用返回 null ②execute：非 rejected 抛 Conflict；不存在抛 NotFound ③api：跳过一张 create_contact → 恢复 → 确认成功；同截图依赖它的互动卡在"跳过后"提示「已被跳过」、"恢复后"提示「请先确认」、"确认后"可确认（batch session 存活路径）④api：session 不存在时恢复只回写 store，后续确认走持久化依赖不报错 ⑤fix9：other 卡跳过后恢复，本批后续同句仍去重（候选 status pending 仍算）⑥事件白名单含 `card_reopened`。

### 2. 「确认时间」友好显示（app）
- 新增纯函数 `formatConfirmTime(timeIso: string | null, timeText: string): string | null`（放 `app/src/review-order.ts` 或新建 `app/src/time-format.ts`）：`time_iso` 无效/空 → null；有效 → `M月D日（周X）HH:MM`（Asia/Shanghai）；**若时分为 00:00 且 `time_text` 含 上午/中午/下午/晚上/早上 → 用「M月D日（周X）」+ 该时段词**（如「8月26日（周三）上午」），00:00 且无时段词 → 只显示日期。
- `review-fields.tsx` 确认时间字段：输入框上方（或 `helper`）显示 `formatConfirmTime` 结果（emphasis 样式）；输入框改 `multiline` 让 ISO 原串与 placeholder 不再截断；保持可编辑 ISO 的行为不变（不做日期选择器）。
- 测试：①`2026-08-26T00:00:00+08:00` + 「明天上午」→ 「8月26日（周三）上午」②`2026-08-28T10:30:00+08:00` → 「8月28日（周五）10:30」③null → null ④非法串 → null ⑤00:00 无时段词 → 「8月26日（周三）」。

## 已否决 / 本批不做
- 撤销已确认（逆转副作用）：复杂且易坏；「确认了想改」走会议/联系人编辑功能（fix16，待 Alice 定）。
- 日期选择器控件：不上，保持 ISO 文本可编辑 + 友好显示。
- 服务器模式的恢复：占位报「暂不支持」。
- 恢复按钮加在已确认卡上：不加。

## Scope
- 可动：`shared/core/agent/execute.ts`（仅新增 `reopenCard`）、`app/src/local/types.ts`、`app/src/local/store.ts`（仅新增 reopen 方法）、`app/src/connection/dispatch.ts`、`app/src/api.ts`（占位）、`app/src/local/api.ts`、`app/src/local/batch-contacts.ts`、`app/app/review/[screenshotId].tsx`、`app/src/components/review/review-card.tsx`、`app/src/components/review/review-fields.tsx`、`app/src/diagnostics/event-log.ts`（仅新增 `card_reopened`）、`app/src/review-order.ts` 或新建 `app/src/time-format.ts`、测试。
- 不可动：DB schema / migrations、`prompts.ts`、`perceive.ts`、`propose.ts`、`resolve.ts`、`schemas.ts`、`server/src/**`（测试除外）、fix1–fix14 已交付行为、`app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）
- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when
1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 250、app 不低于 177；`git diff --check` 干净
2. Goal 1 六组、Goal 2 五组测试落地
3. 报告 `docs/report-v3-m4-fix15.md`（与 fix14 报告同结构，含突变检查）贴真实测试输出、文件清单、偏离决定；只写本仓的事
