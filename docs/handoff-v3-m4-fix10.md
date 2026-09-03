# 脉络 Mailuo — v3-M4-fix10 施工交接（确认页非线性：所有待确认的卡都能操作）

## 你的角色

接 v3.1.9（fix9 同批查重 + 通知路由）。本批只有一件事，出自 **Alice 真机描述的流程死角 + owner 核过的代码事实**，
Alice 2026-09-03 拍板「按你的（先做方案 C）」。**纯 app 层，不动 `shared/core/**`、不动 DB schema、不做迁移。**
施工图 PLAN.md（第 0 节适用），先 `git log -3` 同步认知。自验用本机 Node 26。

## 真机实证（Alice 原话，已脱敏）+ 代码事实（owner 核过 file:line）

- 她的场景：一批截图确认时，**第一张就是 OCR 错了名字的「新建联系人」卡**，那个时点没有后文、判断不了这人是谁；只能「确认」或「跳过」；
  跳过之后，后面依赖它的互动卡提示「请把这张也跳过，或先手动新建该联系人」——这人是新人、库里没人可关联；跳过又不能反悔 → **整批锁死**。
- `app/src/components/review/review-card.tsx:70`：`editable = stage === "current" && card.status === "pending"`，**upcoming 的卡只读、按钮根本不渲染**（第 170 行 `editable ? (...)`）。
- `app/app/review/[screenshotId].tsx:139-144`：`currentPendingCard = findCurrentPendingReviewCard(...)` = 排序序列里**第一张** pending（`app/src/review-order.ts`）；
  第 217-222 行 `useEffect`：`currentPendingCard.screenshot_id !== screenshotId` 时 `selectScreenshot(...)` **自动跟随**——后面截图的卡在前面没处理完之前到不了。
- `shared/core/agent/execute.ts rejectCard`：只允许 pending→rejected，**无撤销**（本批不做撤销，见已否决）。
- 依赖检查现状（**本批不改**）：`app/src/components/review/review-fields.tsx getInteractionDependencyMessage`——锚点 pending →「请先确认『新建联系人 X』那张卡」；
  rejected →「…请把这张也跳过，或先手动新建该联系人」。**在非线性下，pending 那句正好是正确引导**（她能回去处理那张）。

## Goal

### 1. 所有待确认的卡都能操作；「当前这张」只保留高亮与自动跟随（app）

- `review-card.tsx`：`editable = card.status === "pending"`，不再要求 `stage === "current"`。`stage === "current"` 仍决定高亮样式（`styles.currentCard`）与「当前这张」文字；
  upcoming 的角标文字由「后面还有」改为「待确认」（它现在能动了）。建议把这条规则抽成纯函数（如 `app/src/review-order.ts` 的 `isReviewCardEditable(stage, status)`）便于测试。
- 页面自动跟随（第 217-222 行）改为：**只在当前显示的截图已无 pending 卡时**才跳到 `currentPendingCard.screenshot_id`；判据就用「当前 `screenshotId` 下仍有 pending」，
  不引入"用户手动选过"的 ref（更简单）。用户手动切到别的截图后不被拉回。
- 确认/跳过任一非 current 的卡后：保持当前视图，不强制滚到序列第一张。
- 进度条 `reviewBatchProgress`（第 145-171 行）：以**当前显示的截图**为 `activeGroup`（用户切到哪张就显示哪张的进度），
  `currentPendingCard` 只用于「全部处理完」判断与跳洞察（第 300-320 行 `batchSettled` 逻辑不变）。
- **依赖检查不动**：乱序确认互动卡时若锚点联系人卡仍 pending，照旧被 `getInteractionDependencyMessage` 拦下并提示。
  乱序确认 `create_meeting`：参与人是 name / candidates 形式、不依赖 contact_id，无需改。
- **施工前先核一处隐含假设**：`app/src/local/batch-contacts.ts` 的 `prepareScreenshot / commitScreenshot` 按截图顺序处理提议——那发生在**上传阶段**、与确认顺序无关；
  确认阶段走 `executeCard` + `dependenciesByCardId`。grep 确认确认阶段没有"按顺序确认"的断言（如 `batchIndex` 递增检查只在 prepare 阶段）。
  **若发现确认阶段存在顺序假设 → 报 NEEDS_CONTEXT 停下**，不要自行改 `batch-contacts.ts`。
- 黑匣子：确认/跳过时若 `card.id !== currentPendingCard?.id` 记事件 `review_out_of_order`（detail：`card_id=… type=…`）；
  `app/src/diagnostics/event-log.ts` 仅新增这一个事件种类。owner 要从诊断包看出非线性被用了多少。
- 测试（纯函数 + 现有测试风格，不上 UI 测试框架）：①`isReviewCardEditable`：upcoming+pending → true，current+pending → true，done/confirmed/rejected → false
  ②自动跟随判据：当前截图仍有 pending → 不跳；无 pending 且别处有 → 跳到那张；全无 → 不跳 ③乱序确认互动卡（锚点 pending）仍返回依赖提示（复用 review-fields 现有测试样式）
  ④`review_out_of_order` 事件种类进白名单且 detail 截断规则与其它事件一致。

## 已否决 / 本批不做

- **撤销跳过（恢复为待确认）**：Alice 拍板先做非线性，撤销看非线性用一阵之后还撞不撞再定。理由：非线性是根因（线性门控制造了「不确定也得定」），撤销是补救；
  撤销要逆转 `batch-contacts.ts` 里 `registerRejectedAnchor` 删掉的 pending 联系人映射，是那 1400 行里最绕的一段。
- 「稍后再定」按钮：被非线性包含（不动即为稍后）。
- 改依赖提示文案：不动。
- 同批内联系人卡改名传播到后续引用卡：另批。

## Scope

- 可动：`app/src/components/review/review-card.tsx`、`app/app/review/[screenshotId].tsx`、`app/src/review-order.ts`、
  `app/src/diagnostics/event-log.ts`（仅新增 `review_out_of_order`）、测试。
- 不可动：DB schema / migrations、`shared/core/**`、`app/src/local/**`（含 `batch-contacts.ts` / `api.ts`）、`review-fields.tsx` 的依赖文案、
  fix1–fix9 已交付行为、`app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）

- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when

1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 197、app 不低于 165；`git diff --check` 干净
2. 上面四组测试
3. 报告贴真实测试输出、文件清单、偏离决定；只写本仓的事
