# 脉络 v3-M4-fix15 施工报告

日期：2026-09-04

施工基线：`main @ 381b1a6`

## 施工前闸门

- 已通读任务书 `docs/handoff-v3-m4-fix15.md` 与 `PLAN.md` 第 0 节；`git log -3` 确认基线为 `381b1a6`（fix15 交接文档本身），其前两个提交为 `ae7e422`（版本 3.1.14）与 `b5ced39`（fix14 首批修复）。
- 逐一定位两个 Goal 的落点：Goal 1（恢复已跳过的卡）需要新增贯穿 `shared/core/agent/execute.ts`（`reopenCard`）→ `app/src/local/types.ts` + `store.ts`（`reopenActionCardIfRejected`）→ `app/src/connection/dispatch.ts`（`RoutedApi.reopenCard`）→ `app/src/api.ts`（服务器模式占位）→ `app/src/local/api.ts`（本地实现）→ `app/src/local/batch-contacts.ts`（`registerReopenedAnchor`）→ UI（`review-card.tsx` 按钮 + `[screenshotId].tsx` 的 `handleReopen`）的完整链路；Goal 2（确认时间友好显示）只落在新建的 `app/src/time-format.ts` + `review-fields.tsx` 两处，纯 app 端。
- 核实 `server/src/db.ts` 的 `MailuoDb implements InsightGenerationDb, ExecuteStore`——若直接给共享的 `ExecuteStore` 接口加一个必需方法 `reopenActionCardIfRejected`，会导致 `MailuoDb` 编译失败，而 `server/src` 非测试文件不可动。据此确定设计：`reopenCard` 的 `db` 参数类型用 `ExecuteStore & { reopenActionCardIfRejected(...): ... }` 的交集类型（仅在 `reopenCard` 自己的签名里，不修改 `ExecuteStore` 接口本体），`server/src` 完全不受影响，服务器模式对外仍走「不支持」占位。
- 核实 `app/src/local/batch-contacts.ts` 的 `registerRejectedAnchor`：对 `create_contact` 锚点会整条删除 `pendingByTemporaryId`/`temporaryIdByAnchorCardId` 记录；对 `create_meeting(kind=other)` 锚点只改 `status` 字段、保留 map 条目。据此确认 `registerReopenedAnchor` 两个分支不对称——`create_contact` 必须"重建"（无法简单翻转，因为记录已被删除），`create_meeting(kind=other)` 只需"翻转状态"。
- 核实 `confirmCard`（`app/src/local/api.ts`）的依赖解析（`preparePersistedLocalBatchConfirmation` 的 `getAnchorCard`）**始终**直接读 `options.store.getStoredActionCardById`，不经过 `LocalBatchContactSession`——这是任务书"依赖判定走持久化的 anchor_card_id（fix3 已有）"的代码依据，也是 Goal 1 item④（session 不存在场景）能够成立的根本原因。
- 闸门结论：PASS，无需 `NEEDS_CONTEXT`。

## 交付结果

### Goal 1：已跳过的卡可恢复为待确认

- **store**（`app/src/local/types.ts:58` + `app/src/local/store.ts:556`）：`LocalStore` 接口新增 `reopenActionCardIfRejected(cardId): ActionCardRecord | null`；`ExpoSqliteLocalStore` 新增同名方法，`UPDATE action_cards SET status='pending', resolved_at=NULL, resolved_contact_id=NULL WHERE id=? AND status='rejected'`，与 `rejectActionCardIfPending` 对称，未改动任何既有方法。
- **execute**（`shared/core/agent/execute.ts:1408-1444`）：新增 `ReopenCardInput`（`db: ExecuteStore & { reopenActionCardIfRejected(...) }`）与 `reopenCard({db, cardId})`：不存在 → `ExecuteNotFoundError`；`status !== 'rejected'` → `ActionCardConflictError`；成功返回记录，事务包裹，风格与 `rejectCard` 一致。**关键设计**：故意不扩展 `ExecuteStore` 接口本体（见上文闸门第 3 条），只在 `reopenCard` 自己的输入类型上做交集，`server/src/db.ts` 的 `MailuoDb` 零改动、零破坏。
- **RoutedApi**（`app/src/connection/dispatch.ts:43,140-142`）：新增 `reopenCard(cardId): Promise<{ card: ActionCardRecord }>` 并接入 dispatcher 透传；本地实现（`app/src/local/api.ts:572-578`）调用 `reopenActionCard({db: options.store, cardId})` 后 `batchSession?.registerReopenedAnchor(card)`；服务器实现（`app/src/api.ts:215-217`）抛「服务器模式暂不支持恢复已跳过的卡片。」（与 `readDiagnosticsSnapshot` 同款 501 占位，未动 `server/src`）。
- **batch session 逆向登记**（`app/src/local/batch-contacts.ts`）：新增 `registerReopenedAnchor(card)`（1521-1548 行）——①`create_contact`：用 `card.payload` 重建 pending 联系人，接回 `temporaryIdByAnchorCardId`/`pendingByTemporaryId`；②`create_meeting(kind='other')`：`toBatchOtherCardReference(card)` 刷新 `batchOtherCardsById` 里该卡的状态（此时 `card.status` 已是 `pending`）。**按任务书要求把 create_contact 重建逻辑抽成私有方法 `registerPendingContactForAnchor`（1554-1572 行）**，与 `commitScreenshot` 里 `newPendingContacts` 循环共用同一份实现，未复制。
- **UI**：`review-card.tsx` 新增 `onReopen` prop + `canReopen = !disabled && card.status === 'rejected'`，命中时渲染一个独立的 `tone="secondary"` 的「恢复为待确认」按钮（与已确认/待确认卡的按钮互斥，已确认的卡不加任何按钮）；`[screenshotId].tsx` 新增 `handleReopen`：调 `reopenCard(card.id)` → `refreshScreenshot(card.screenshot_id, ..., {message: '已恢复，可以重新确认', preserveScreenshotId: screenshotId})` → `logEvent('card_reopened', ...)`，冲突/失败处理与 `handleConfirm`/`handleReject` 同款（`isConflictError` 分支走刷新+提示，其余走 `actionError`+`showError`）。
- **黑匣子**：`event-log.ts` 的 `EVENT_KINDS` 新增 `"card_reopened"`（仅此一项）。

### Goal 2：「确认时间」友好显示

- 新建 `app/src/time-format.ts`，纯函数 `formatConfirmTime(timeIso, timeText)`：`timeIso` 为空/非法 → `null`；有效 → `M月D日（周X）HH:MM`；时分为 `00:00` 且 `timeText` 含"上午/中午/下午/晚上/早上"任一词 → 日期+该词；`00:00` 无时段词 → 只显示日期。**实现刻意不用 `Intl.DateTimeFormat`/时区名查表**：Asia/Shanghai 自 1991 年起固定 UTC+8、无夏令时，直接把 UTC 时刻加 8 小时后读 `getUTC*` 字段即得到正确的上海挂钟时间，零 ICU/时区数据库依赖，跨 Node（测试）/Hermes（真机）环境行为完全确定。放在新文件而非 `review-order.ts`（任务书给出两个选项）：`review-order.ts` 是卡片排序逻辑，与时间格式化是两个不相关的关注点，新建文件避免混入无关职责。
- `review-fields.tsx` 的 `MeetingFields`：确认时间字段的 `dualColumn` 内，`FieldInput` 上方新增 `formatConfirmTime` 结果（`styles.confirmTimeHint`，复用 `emphasisText` 的主色调 + 单独的字号/行距/下边距）；`FieldInput` 本身加 `multiline`（让长 ISO 串与 placeholder 换行显示，不再被单行输入框截断到只剩尾巴）；未改可编辑 ISO 文本的行为，未加日期选择器。

## 两个 Goal 的测试组

### Goal 1（6 组，分布在 `server/src/tests/execute.test.ts` 与 `app/src/tests/{local-api,dispatch,event-log,upload-batch}.test.ts`）

1. **store**（`server/src/tests/execute.test.ts`，`reopenActionCardIfRejected flips a rejected card back to pending and returns null for pending or confirmed cards`）——用测试内 `attachReopen(db)`（`Object.assign` 而非对象展开，保留 `MailuoDb` 原型方法）给真实 `MailuoDb` 挂一个 SQL 实现的 `reopenActionCardIfRejected`，直接调用（绕开 `reopenCard` 的守卫）验证：`pending`/`confirmed` 卡 → `null`；`rejected` 卡 → 翻回 `pending`，`resolved_at`/`resolved_contact_id` 清空。
2. **execute**（同文件，两组）：`reopenCard reopens a rejected card and returns 409 for cards that are not rejected`（`pending`/`confirmed` 均抛 `ActionCardConflictError`/409，`rejected` 卡成功翻转后再次调用同一 cardId 也抛 409）；`reopenCard throws NotFound for a missing card id`（`ExecuteNotFoundError`/404）。
3. **api，batch session 存活路径**（`app/src/tests/local-api.test.ts`，`reopening a rejected create_contact anchor flips its dependent interaction's message back to pending, and both confirm`）：同一 `api`/`session` 实例内，跨截图建立 create_contact 锚点 + 依赖它的 record_interaction 卡 → 拒绝锚点后确认依赖卡收到「已被跳过」→ 恢复锚点后 `getScreenshotDetail` 显示依赖卡状态回到 `pending`（等价于 UI 层「请先确认」文案）→ **额外验证**：同批第三次上传再次提到同一人名，不应重复生成 create_contact 卡且 `session.listPendingContacts()` 仍只有一条（证明 `registerReopenedAnchor` 真的重建了 pending 联系人，而不只是持久化层的巧合）→ 确认依赖卡仍会先因未确认锚点被拒 → 确认锚点 → 确认依赖卡成功，`resolved_contact_id` 与锚点一致。
4. **api，session 不存在**（同文件，`reopening an anchor with no live batch session only rewrites the store, and its dependent interaction still confirms via the persisted anchor_card_id`）：原 `api` 建好锚点+依赖卡并拒绝锚点后，`createApi()` 重新实例化（`batchSessionByCardId` 全新为空，模拟应用重启）→ `rebuiltApi.reopenCard` 只回写 store（`batchSession` 查找必然 miss，`registerReopenedAnchor` 是 no-op）→ `rebuiltApi.confirmCard` 依次确认锚点与依赖卡均成功，证明 `confirmCard` 的依赖解析完全走持久化 `local_batch_deferred` 标记，不依赖 session 存活。
5. **fix9 联动**（同文件，`reopening a rejected local-batch other item restores it as an active dedup tombstone`）：**全程单一 api 实例**（未做 API recreation，理由见下文"偏离与决定"）建立一张 `create_meeting(kind=other)` 卡 → 拒绝 → 恢复后**在下一次上传之前**立即断言 `session.listBatchOtherCards()[0].status === 'pending'`（专门验证 `registerReopenedAnchor` 自己的 `create_meeting` 分支，而不是被下一次上传触发的 `reconcileBatchOtherCards` 安全网掩盖）→ 再上传一张同句"其它事项"截图，确认仍被判定为重复（`matched_card_id === firstOther.id`）。
6. **事件白名单**（`app/src/tests/event-log.test.ts`，`the event kind whitelist includes card_reopened`）：`EVENT_KINDS.includes("card_reopened")`。

另有两处纯类型合规性修正（不计入上述 6 组）：`app/src/tests/dispatch.test.ts` 的 `fakeApi()` 与 `app/src/tests/upload-batch.test.ts` 的 `apiWithUpload()` 均各构造一份完整的 `RoutedApi` 对象字面量，`RoutedApi` 接口新增 `reopenCard` 后二者必须补一个 `throw new Error("unused")` 占位（与其余未被对应测试用到的方法同款），否则 `tsc --noEmit` 报错。

### Goal 2（5 组，`app/src/tests/time-format.test.ts`，新文件）

1. `2026-08-26T00:00:00+08:00` + 「明天上午」→ 「8月26日（周三）上午」
2. `2026-08-28T10:30:00+08:00` → 「8月28日（周五）10:30」
3. `null` → `null`
4. `"not-a-real-date"` → `null`
5. `2026-08-26T00:00:00+08:00` + 「下周三」（无时段词）→ 「8月26日（周三）」

## 判别力验证（突变检查，防止测试形同虚设）

对 Goal 1 的四处核心判定/登记代码与 Goal 2 的一处分支各做一次临时性反向突变，单独跑对应端的 `npm test`（Goal 1 用真实测试文件而非全量 `npm test`，逐个隔离更快），确认**恰好**命中预期的测试后原样撤回；另对 `EVENT_KINDS` 做一次移除测试，验证它是被 `tsc --noEmit` 而非某个运行时测试挡住。全部撤回后重新跑通两端全量测试与两端 `tsc --noEmit`。

| # | 突变位置 | 突变方式 | 失败数 | 命中的测试 |
|---|---|---|---|---|
| 1 | `shared/core/agent/execute.ts` `reopenCard` 状态守卫 | `card.status !== "rejected"` → `card.status !== "confirmed"`（改判定目标状态） | 1 | `reopenCard reopens a rejected card and returns 409 for cards that are not rejected` |
| 2 | 同文件 `reopenCard` 存在性守卫 | `if (!card)` → `if (false)` | 1 | `reopenCard throws NotFound for a missing card id` |
| 3 | `app/src/local/batch-contacts.ts` `registerReopenedAnchor` 的 `create_contact` 分支 | 整段替换为空 `return` | 1 | `reopening a rejected create_contact anchor flips its dependent interaction's message back to pending, and both confirm (fix15 goal 1 item 3, batch session alive)` |
| 4 | 同方法 `create_meeting(kind='other')` 分支 | 条件前加 `false &&` | 1 | `reopening a rejected local-batch other item restores it as an active dedup tombstone (fix15 goal 1 item 5)` |
| 5 | `app/src/time-format.ts` 的时段词分支 | `TIME_OF_DAY_WORDS.find(...)` 强制短路为 `undefined` | 1 | `a midnight time_iso with a time-of-day word in time_text shows the date and that word` |
| 6（类型层） | `app/src/diagnostics/event-log.ts` 的 `EVENT_KINDS` | 删掉 `"card_reopened"` 一项 | `tsc --noEmit` 报 2 处 TS2345 | `app/review/[screenshotId].tsx:747`（`logEvent` 调用）+ `event-log.test.ts:239`（白名单断言） |

六轮全部原样撤回（`grep -rn "MUTATION-TEST-TEMP" --include="*.ts" --include="*.tsx"` 已确认全仓零命中），最终代码与突变检查前完全一致，两端测试数与突变前一致（app 186、server 253）。

**测试设计过程中发现并当场修正的两处覆盖缺口**（均在准备突变检查、预判"这个突变会不会被别的机制掩盖"时发现，属于诊断中的正常修正，不是产品代码回归）：

1. **Goal 1 item③ 最初版本没有真正测到 `registerReopenedAnchor` 的 `create_contact` 分支**。第一版只验证依赖卡的提示文案（走持久化 `local_batch_anchor` 水合）和确认成功（走持久化 `local_batch_deferred` 标记）——这两条路径的取数都直接读 `options.store`，与 `LocalBatchContactSession` 的内存状态无关，即便把 `registerReopenedAnchor` 的 `create_contact` 分支整段删掉，这两个断言也照样通过。诊断后加了"同批第三次上传再提同一人名"的验证：若该分支被删掉，`魏雷` 会因为 session 里找不到对应的 pending 联系人而被当成全新参与人，产出一张重复的 create_contact 卡——用突变 3 实测确认了这一点（删掉分支后确实只有这一个测试失败）。
2. **Goal 1 item⑤ 最初版本仿照既有的"API recreation"tombstone 测试，用 `rebuiltApi = harness.createApi()` 做拒绝与恢复**，但 `reopenCard`/`rejectCard` 只通过 `batchSessionByCardId`（每个 api 实例私有、只在自己的 `uploadScreenshot` 里写入）查会话，`firstOther` 是在另一个 api 实例（`firstApi`）里建的卡，`rebuiltApi` 从未学到这张卡属于哪个 session——`registerReopenedAnchor` 必然是 no-op，测试能通过完全是因为下一次上传触发的 `reconcileBatchOtherCards`（既有的、独立测试过的 fix9 机制）会重新从 store 读到最新状态并自我修复。改为全程单一 api 实例，并把状态断言挪到"恢复后、下一次上传之前"，才真正测到 `registerReopenedAnchor` 自己的 `create_meeting` 分支——用突变 4 实测确认（保留旧的 recreate 写法重跑同一个突变，该测试确实不会失败；改造后才会）。

## 真实测试输出

### app

命令：`cd /Users/anxianjingya/Projects/mailuo/app && npm test`

```text
ℹ tests 186
ℹ suites 0
ℹ pass 186
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

门槛：`186 >= 177`。（施工前基线：177/177/0；本批新增 11 组：Goal1 item③④⑤×3 + Goal1 item⑥×1 + Goal2×5，另加 2 处纯类型合规修正未新增测试计数。）

命令：`cd /Users/anxianjingya/Projects/mailuo/app && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### server

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npm test`

```text
ℹ tests 253
ℹ suites 0
ℹ pass 253
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

门槛：`253 >= 250`。（施工前基线：250/250/0；本批新增 3 组：Goal1 item①×1 + item②×2。）

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### 工作树检查

命令：`git -C /Users/anxianjingya/Projects/mailuo diff --check`

```text
(无标准输出，exit 0)
```

## 文件清单

- `shared/core/agent/execute.ts`（新增 `ReopenCardInput` 类型 + `reopenCard` 函数；`ExecuteStore` 接口本体未改动一行）
- `app/src/local/types.ts`（`LocalStore` 接口新增 `reopenActionCardIfRejected`）
- `app/src/local/store.ts`（`ExpoSqliteLocalStore` 新增 `reopenActionCardIfRejected` 方法；`updateActionCardResolution` 等既有方法未改动）
- `app/src/connection/dispatch.ts`（`RoutedApi` 接口新增 `reopenCard`；dispatcher 透传实现；类型导入新增 `ActionCardRecord`）
- `app/src/api.ts`（`createServerApi` 新增 `reopenCard` 占位抛错；`export const reopenCard`）
- `app/src/local/api.ts`（新增 `reopenCard` 实现，调用共享 `reopenCard` 后登记回 batch session）
- `app/src/local/batch-contacts.ts`（新增 `registerReopenedAnchor` 公开方法 + `registerPendingContactForAnchor` 私有共用方法；`commitScreenshot` 的 `newPendingContacts` 循环改为调用该共用方法，行为不变）
- `app/src/components/review/review-card.tsx`（新增 `onReopen` prop + 已跳过卡的「恢复为待确认」按钮）
- `app/src/components/review/review-fields.tsx`（`MeetingFields` 的确认时间字段新增 `formatConfirmTime` 提示 + 输入框改 `multiline`）
- `app/src/diagnostics/event-log.ts`（`EVENT_KINDS` 新增 `"card_reopened"`）
- `app/src/time-format.ts`（新文件，`formatConfirmTime` 纯函数）
- `app/app/review/[screenshotId].tsx`（新增 `handleReopen`；`ReviewCard` JSX 接入 `onReopen`）
- `server/src/tests/execute.test.ts`（新增 `attachReopen` 测试专用 store 增强 + 3 组 reopen 测试）
- `app/src/tests/local-api.test.ts`（`FakeLocalStore` 新增 `reopenActionCardIfRejected`；新增 3 组 reopen 集成测试）
- `app/src/tests/dispatch.test.ts`（`fakeApi()` 补 `reopenCard` 占位以满足 `RoutedApi` 类型）
- `app/src/tests/upload-batch.test.ts`（`apiWithUpload()` 同上补 `reopenCard` 占位）
- `app/src/tests/event-log.test.ts`（新增 1 组白名单测试；**顺带修复了我自己第一次编辑时造成的插入错误**，见下文"偏离与决定"）
- `app/src/tests/time-format.test.ts`（新文件，5 组测试）
- `docs/report-v3-m4-fix15.md`（本报告）

## 偏离与决定

1. **`reopenCard` 的 `db` 参数用交集类型而非扩展 `ExecuteStore` 接口本体**——任务书本身已提示"不动 server/src"，但没有明说共享接口该怎么改。核实 `server/src/db.ts` 的 `MailuoDb implements ExecuteStore` 后确认：任何给 `ExecuteStore` 加必需方法的做法都会让 `MailuoDb` 编译失败，必须在 `server/src` 里补一个从未被生产代码调用的桩方法才能修好——这既是对"不动 server/src"最直接的违反，也毫无必要（服务器传输层本就要给恢复请求返回"不支持"）。改用 `ExecuteStore & {reopenActionCardIfRejected}` 的交集类型，只在 `reopenCard` 自己的输入类型上生效，`server/src` 零改动、两端 `tsc --noEmit` 均验证通过。
2. **Goal 1 item③ 的测试范围略微超出任务书字面枚举**——任务书原文只要求"跳过→恢复→确认成功；依赖卡三种提示"，我在准备突变检查时发现这份最小实现完全测不到 `registerReopenedAnchor` 的 `create_contact` 重建逻辑（详见上文"测试设计过程中发现并当场修正的两处覆盖缺口"第 1 条），遂在同一个测试里加了"同批第三次上传验证不产生重复联系人卡"的额外步骤。这不是新增第 7 组测试，只是让已经存在的 item③ 真正覆盖任务书本身要求实现的那段逻辑（"复用 commitScreenshot 里为 savedCards 建 pending 的那段逻辑，抽成私有方法共用"），而不是让它成为一段无测试保护的死代码。
3. **Goal 1 item⑤ 未沿用既有 fix9 tombstone 测试的"API recreation"结构，改为全程单一 api 实例**——原因同上（见缺口第 2 条）：`rejectCard`/`reopenCard` 只经 `batchSessionByCardId`（每个 api 实例私有）查会话，跨实例调用时该方法必然拿不到 session，`registerRejectedAnchor`/`registerReopenedAnchor` 都会变成 no-op，测试能通过完全是拜托了另一个独立机制（`reconcileBatchOtherCards`）兜底。任务书 item⑤ 没有像 item④ 那样明确要求"API recreation"这个维度，所以改用能够真正触达 `registerReopenedAnchor` 自身代码路径的单实例写法，同时保留"恢复后 dedup 仍生效"这个任务书原文要求的核心断言。
4. **`formatConfirmTime` 放进新建的 `app/src/time-format.ts` 而非 `review-order.ts`**——任务书原文给了这两个选项。`review-order.ts` 现有内容全部是卡片排序/分组逻辑，与"把一个 ISO 时间字符串格式化成中文短语"是完全不相关的两个关注点；新建文件后 `review-order.ts` 保持单一职责，`time-format.ts` 也天然对应一份独立的 `time-format.test.ts`，与仓库既有的"一个模块一个测试文件"惯例（`review-order.ts`↔`review-order.test.ts`、`event-log.ts`↔`event-log.test.ts` 等）一致。
5. **`formatConfirmTime` 的时区处理不用 `Intl.DateTimeFormat` + `timeZone` 名称查表，改用固定 UTC+8 偏移量的纯数值运算**——仓库里 `shared/core/llm/prompts.ts`/`shared/core/agent/propose.ts` 已有用 `Intl.DateTimeFormat(..., {timeZone: 'Asia/Shanghai'})` 的先例，但那类写法依赖运行环境自带完整的 IANA 时区数据库，且历史上多个 JS 引擎在 `hour12: false` 场景下对"午夜"存在渲染成 `24:00` 而非 `00:00` 的已知不一致（不同 V8/Hermes 版本表现不一）。由于 Asia/Shanghai 自 1991 年起是固定 UTC+8、全年无夏令时，直接把 UTC 时刻的毫秒数加 8 小时、再用 `getUTCFullYear`/`getUTCMonth`/`getUTCDate`/`getUTCHours`/`getUTCMinutes`/`getUTCDay` 读回，等价于查表法但零 ICU 依赖、零平台差异风险，且更容易做纯粹的单元测试（不用担心测试机与真机的 ICU 版本不一致）。周几的中文映射用一个 7 项的字面量数组（`WEEKDAY_LABELS`），不引入任何新依赖。
6. **`review-card.tsx`/`review-fields.tsx` 的 UI 渲染、`[screenshotId].tsx` 的 `handleReopen` 均未被任何自动化测试覆盖**——如实说明：这是本仓库现有测试基础设施的结构性限制，不是本批新引入的缺口。`review-card.tsx`/`review-fields.tsx` 作为 React Native 组件，仓库里唯一的测试手法是给 `review-fields.tsx` 的**纯函数导出**（`resolveReviewLocalBatchAnchor`/`getInteractionDependencyMessage` 等）配一个 mock 掉 `react-native` 模块的 loader hook（`review-fields.test.ts`），从未对组件的 JSX 渲染输出做过快照或交互测试；`[screenshotId].tsx` 作为依赖 `expo-router`/`useFlow` 的路由屏幕，同样没有任何现存测试直接调用过 `handleConfirm`/`handleReject`（`handleReopen` 与它们同构）。本批的验证依赖于：`reopenCard`（真正被调用的 API 函数）、`EVENT_KINDS`（`logEvent` 调用是否合法由 `tsc` 保证）、以及上述 API/execute 层测试共同构成的间接证据链，加上手动读代码确认三处 UI 改动分别只新增了一个按钮分支、一段提示文案渲染、一个与既有 `handleConfirm`/`handleReject` 同构的 handler。
7. **`app/src/local/store.ts` 的 `ExpoSqliteLocalStore.reopenActionCardIfRejected`（真机上实际运行的 SQL 实现）不在任何自动化测试的可达范围内**——原因与 `rejectActionCardIfPending`/`confirmActionCardIfPending` 完全相同：`expo-sqlite` 的 `openDatabaseSync` 依赖原生模块，Node 测试环境无法实例化 `ExpoSqliteLocalStore`。本批用 `server/src/tests/execute.test.ts` 里对真实 `MailuoDb`（同样是真 SQL、Node 原生 `node:sqlite`）临时挂载等价 SQL 语句的方式（`attachReopen`）验证了同一条 `UPDATE ... WHERE status='rejected'` 语句的正确性，作为无法直接测试 `ExpoSqliteLocalStore` 本体时的替代证据，但两者终究是两份独立的实现（字段名、SQL 语法完全一致，只是宿主不同）。
8. **未涉及"已否决 / 本批不做"事项**——未做撤销已确认的逆转副作用；未加日期选择器（`FieldInput` 仍是可编辑的 ISO 文本框，只是新增了上方的友好提示与 `multiline`）；服务器模式的恢复只是占位报错；已确认的卡未加任何恢复相关按钮（`review-card.tsx` 的新按钮判据是 `card.status === 'rejected'`，与 `isReviewCardEditable` 的 `pending` 判据互斥）——均按任务书逐条核对未触碰。
9. **未改** DB schema/migrations、`prompts.ts`、`perceive.ts`、`propose.ts`、`resolve.ts`、`schemas.ts`、`server/src/**` 非测试文件、fix1–fix14 已交付行为、`app/app.json` 版本号、依赖——`git status --porcelain` 显示改动的 16 个文件 + 2 个新文件（含本报告）与声明的可动范围一一对应。
10. **测试数据全部使用虚构名**——本批新用到的魏雷、钱多、冯雪、许朗均为新造的虚构占位名；沿用的王磊、周宁、孙萌、张三是本项目测试套件里早已使用多轮的通用虚构占位名（fix9–fix14 报告已确认过这一点）；`vehicleOtherExtraction`/`damagedVehicleNotice`/`correctedVehicleNotice` 直接复用既有测试文件里已经验证过的虚构车辆通知素材，未新造车牌/地点类内容。
