# 脉络 v3-M4-fix9 施工报告

日期：2026-09-03

施工基线：`main @ 2fcf021`

## 交付结果

### Goal 1：同批 `kind=other` 事项查重

- 新增共享纯函数，仅比较同一 `LocalBatchContactSession` 内先前截图已提出的 `create_meeting(kind="other")` 卡。原文使用 `normalizeContactText(source_quote)` 后的编辑相似度，阈值为 `>= 0.85`；`time_text` 经既有中文时间与联系人文本归一化后要求完全相同，空值与空值可匹配。
- 命中时保留先出的卡，后出的卡在保存前过滤，因此既不出新卡，也不产生 `agenda_append`。`meeting` 和 `appointment` 不进入这条规则。
- session 清单只保留 pending/rejected 的 other 卡。每张后续截图处理前从 action card 存储同步状态：confirmed 或已不存在的卡会移出清单；rejected 卡继续作为本批去重墓碑。
- 新 batch 使用新的 session，不跨 batch 去重；未改已落库 meeting 的既有查重路径。
- 命中记录写入 trace 可选字段 `batch_other_dedup: [{ title, matched_card_id, similarity }]`，无命中时不写该字段。
- 五组验收测试均覆盖：
  1. 「报损备／报备」OCR 一字差的虚构车辆通知，第二张不出卡、不出 `agenda_append`，并记录匹配卡 id 与相似度；
  2. 相同归一化时间但原文相似度低于 0.85 的两条 other 都保留；
  3. 原文和时间相同的 meeting 不受 other 去重影响；
  4. 两个独立 batch 中的相同 other 都能提出；
  5. 首张卡 reject 且 API 重建后，同 batch 再遇相同原文仍被抑制。

### Goal 2：通知类同截图匹配放宽与路由可观测性

- 通知标题高相似的既有分支不变；参与人分支只对本次 extraction 中的 meeting 候选开放“notice 无可判日期”匹配。参与人有交集且候选唯一时，把通知原文并入该 meeting 卡自身 `agenda`。
- 已落库 meeting 与跨截图 pending meeting 仍要求 notice 有可判日期且同日；没有交集或候选不唯一仍丢弃，不恢复为普通 other 卡。
- `routeSpecialOtherEvents` 的详细提议结果记录四种决策：`stored`、`batch`、`dropped`、`timeless_dropped`；命中时附 `target_title`。原 `proposeCards` 数组返回接口保留，由新详细接口包装，既有调用语义不变。
- screenshot trace 新增可选字段 `notice_routing`；本地截图与粘贴文本入口都会同步写黑匣子事件 `notice_routed`，detail 为 `decision=… title=…`。事件日志复用既有 Unicode 码点截断逻辑，最多 120 码点。
- 四组验收测试均覆盖：
  1. 同截图一个 meeting 与无日期通知参与人有交集，通知并入 agenda、不出 other 卡，trace 记录 `batch`，黑匣子事件可读；
  2. 同截图没有参与人交集时仍丢弃并记录 `dropped`；
  3. 已落库 meeting 与前一截图的 pending meeting 均不能被无日期通知跨截图命中；
  4. 同截图两个 meeting 都有参与人交集时因候选不唯一而丢弃。
- 另覆盖 trace 新字段严格解析与旧 trace 缺字段兼容、四种事件决策白名单，以及 120 个 Unicode 码点边界。

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
ℹ duration_ms 1050.846417
```

门槛：`197 >= 191`。

命令：`cd server && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### app

命令：`cd app && npm test`

```text
ℹ tests 165
ℹ suites 0
ℹ pass 165
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1085.692458
```

门槛：`165 >= 158`。

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

- `shared/core/agent/propose.ts`
- `app/src/local/batch-contacts.ts`
- `app/src/local/api.ts`
- `app/src/diagnostics/trace-store.ts`
- `app/src/diagnostics/event-log.ts`
- `server/src/tests/propose.test.ts`
- `app/src/tests/local-api.test.ts`
- `app/src/tests/trace-store.test.ts`
- `app/src/tests/event-log.test.ts`
- `docs/report-v3-m4-fix9.md`

## 偏离与决定

- Goal 1 与 Goal 2 均按任务书完成，无范围偏离；两路独立冷读审阅均为 0 findings。
- 没有修改 DB schema、migration、`resolve.ts`、`schemas.ts`、`execute.ts`、`perceive.ts`、`prompts.ts`、`app/app.json` 或依赖，也没有改变 fix1–fix8 的既有业务分支。
- `batch_other_dedup` 放在本地 batch session 的保存前过滤阶段，而不是改 `proposeCards` 的参数协议；这样复用现有 pending 卡生命周期，并保持 server 与非 batch 调用不受影响。
- rejected 同样保留在清单中，是任务书对“用户不要这条”的明确例外；confirmed/missing 则在下一张截图前同步移除。
- `notice_routing.decision="batch"` 表示命中了同截图候选分支；`stored` 表示直接命中已落库候选。该字段记录路由分支，而不是后续 meeting 去重的最终存储形态。
- screenshot trace 仍只属于截图诊断；粘贴文本没有对应 trace 文件，但同样执行通知路由，因此一并写 `notice_routed`，避免该入口产生不可见的路由决策。此补充只影响诊断事件，不改变提议卡结果。

## Simplicity First 记账

- Goal 1 复用现有 `LocalBatchContactSession`、action card 查询与 `normalizeContactText` / `normalizedEditSimilarity`，没有新增存储表、迁移、依赖或第二套 batch 生命周期。
- Goal 2 复用既有通知识别、参与人归一化、meeting agenda 合并和事件日志截断，只给同截图候选增加一个显式选项；默认调用仍保持日期门槛。
- 通过 `proposeCardsWithRouting` 包装原有提议流程并让 `proposeCards` 保持原签名，避免把诊断元数据塞进既有卡协议。
- 两个 trace 字段均为 optional 且仅在非空时写出，旧诊断包与旧精确 fixture 保持兼容。
- 明确略过 DB/migration、meeting/appointment 批内查重、标题关键词兜底、未匹配通知恢复出卡、版本号和依赖改动；输入归一化、状态同步与严格 trace 校验均保留。
