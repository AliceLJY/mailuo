# 脉络 v3-M4-fix10 施工报告

日期：2026-09-03

施工基线：`main @ 4aed32b`

## 施工前闸门

- 已通读任务书与 `PLAN.md` 第 0 节，并在改代码前核查确认阶段的顺序假设。
- `batchIndex` 只参与上传阶段的 `prepareScreenshot → commitScreenshot`、字段合并优先级与证据排序；现有测试还覆盖先处理 index 2、再重试 index 1，未要求递增。
- 确认与跳过均按目标 `cardId` 执行。`preparePersistedLocalBatchConfirmation` 只检查持久化的 `anchor_card_id` 显式依赖，不含截图顺序或卡片总序断言。
- 闸门结论：PASS，无需 `NEEDS_CONTEXT`；`app/src/local/**` 未改动。

## 交付结果

### 所有 pending 卡可操作

- `isReviewCardEditable(stage, status)` 只以 `status === "pending"` 决定可编辑性，因此 current 与 upcoming 的 pending 卡都可编辑、确认或跳过；confirmed/rejected 卡仍不可操作。
- `stage === "current"` 继续单独控制绿色高亮和“当前这张”文字；upcoming 角标改为“待确认”。
- 保留处理目标不匹配时的禁用保护：卡片组件新增独立 `disabled` 输入，页面 handler 的既有 guard 也未改。
- 页面提示改为可先处理能判断的卡；非 current 卡的操作错误按 card id 回显在该卡自身，不再挂到全局 current 卡下。

### 非线性视图与自动跟随

- 新增纯函数 `findReviewAutoFollowScreenshotId`：当前显示截图仍有 pending 时返回 `null`；当前截图已无 pending 且别处有 pending 时返回全局第一张 pending 的截图 id；全批无 pending 时返回 `null`。
- 确认或跳过非 current 卡不再切换 `screenshotId`，因此正常操作后保持原视图；409 冲突刷新仍更新目标截图卡片，但会恢复刷新前的显示截图。
- `reviewBatchProgress` 的 active group 只按当前 `screenshotId` 选择，不再跟随全局 `currentPendingCard`。
- `currentPendingCard` 的首张 pending 定义与全部完成后跳洞察逻辑保持不变；没有加入“用户手动选过”的 ref。

### 依赖与乱序黑匣子

- `review-fields.tsx` 及其依赖提示文案未改。乱序点击互动卡且同截图联系人锚点仍 pending 时，继续返回“请先确认『新建联系人 …』那张卡”。
- 确认或真正执行跳过时，若 `card.id !== currentPendingCard?.id`，写入 `review_out_of_order`，detail 为 `card_id=… type=…`。
- 本地联系人跳过的二次确认只在用户选择“仍然跳过”后记录一次；取消弹窗不记跳过事件。
- 乱序确认在依赖检查前记录，因此被锚点依赖拦下的真实点击也会进入诊断；这与既有 `confirm_start` 的“尝试即记”口径一致。
- `review_out_of_order` 只新增到事件白名单，沿用普通事件的 120 Unicode 码点截断与落盘读回逻辑。

## 四组验收测试

1. `isReviewCardEditable`：upcoming+pending、current+pending 为 true；confirmed/rejected 为 false。
2. 自动跟随：当前截图仍有 pending 不跳；当前无 pending 且别处有则跳；全无 pending 不跳。
3. 乱序互动卡：锚点 pending 时仍解析出原依赖提示；未改依赖文案。
4. `review_out_of_order`：白名单、写入、读回及普通 120 Unicode 码点截断均覆盖。

另有源码级回归测试固定：confirm/reject handler 不得按被操作卡切换截图，冲突刷新必须恢复原 `screenshotId`。

## 完整验收输出

### server

命令：`cd server && npm test`

```text
ℹ tests 197
ℹ suites 0
ℹ pass 197
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1031.837209
```

门槛：`197 >= 197`。

命令：`cd server && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### app

命令：`cd app && npm test`

```text
ℹ tests 171
ℹ suites 0
ℹ pass 171
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1071.816167
```

门槛：`171 >= 165`。

命令：`cd app && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### 工作树检查

命令：`git diff --check`

```text
(无标准输出，exit 0)
```

## 文件清单

- `app/app/review/[screenshotId].tsx`
- `app/src/components/review/review-card.tsx`
- `app/src/diagnostics/event-log.ts`
- `app/src/review-order.ts`
- `app/src/tests/event-log.test.ts`
- `app/src/tests/review-fields.test.ts`
- `app/src/tests/review-order.test.ts`
- `app/src/tests/transition-mitigation.test.ts`
- `docs/report-v3-m4-fix10.md`

## 偏离与决定

- Goal 1 按任务书完成，无范围偏离；独立冷读首次发现“动作内切换截图”和“错误挂到 current 卡”两项问题，修正后复核为 no findings。
- 为完整满足“保持当前视图”，409 冲突刷新也恢复原显示截图；否则 `setScreenshotDetail` 会隐式把视图切到被操作卡来源。该处理只影响页面选择状态，不改变冲突刷新、卡片状态或请求语义。
- 页面副标题同步取消“依次确认”的线性暗示；`review-fields.tsx` 的依赖文案保持原样。
- 没有修改 DB schema、migration、`shared/core/**`、`app/src/local/**`、`app/app.json` 或依赖；没有实现撤销跳过、稍后再定按钮、联系人改名传播或其它已否决项。

## Simplicity First 记账

- 复用 `review-order.ts` 既有排序序列和事件日志既有白名单/截断机制，只新增两个小纯函数与一个事件种类。
- 自动跟随直接检查当前截图是否还有 pending，不增加手动选择 ref、状态机、数据库字段或持久化协议。
- 继续复用现有 `executeCard`、显式锚点依赖、single-flight、冲突刷新和洞察跳转，不复制执行逻辑，不增加 UI 测试框架或依赖。
- 明确略过 DB、core/local 执行层、撤销能力、依赖文案与版本号；目标不匹配保护、依赖校验、冲突处理和异步提交校验均保留。
