# 脉络 Mailuo — v3-M4-fix5 施工交接（诊断包 + 黑匣子 + 说话人规则 + 英文摘要兜底 + 同屏新建联系人依赖提示）

## 你的角色

接 v3.1.4（`a9eac40` + tag）。fix4 真机验收通过（完成出口 / 别名过滤 / 事项参与人候选），
本批修 owner 在 3.1.4 上新报的四件 + 落实 owner 的一个提议（「做个测试版本看生成后的文件，
看它的选择机制」→ 落为诊断包）。**不动 DB schema、不做迁移。** 施工图 PLAN.md（第 0 节适用），
先 `git log -3` 同步认知。自验用本机 Node 26。分两批派活，见文末。

## 真机实证（owner，OPPO，本地模式，v3.1.4）

- ❌ **同一张截图里没先确认「新建联系人 王磊」，去确认依赖它的互动卡** → 卡片下红字
  `record_interaction requires contact_id or exactly one confirmed sibling create_contact match for "王磊"`
  （英文、不可照做）→ **随后 app 闪退** → **重开没有弹「上次异常退出」面板**（3.1.3 的崩溃记录器没接住）。
  人脉与日程数据已生成，无丢失。
- ❌ **会议通知里列名的每个人都生成了互动记录**，owner 原话「这不就是通知吗，为什么放互动里」，上一版也如此，她全部跳过。
- ❌ **一张互动摘要生成了英文**，她跳过。
- ✅ owner 决定：同批事项查重**不做**（「再重复传的时候就会有合并了，同一批对比增加工作量没必要」）；
  识别错别字进别名**不动**（她手删即可，且对下次匹配有用）；确认页时间框**不改**。
- 💡 owner 提议：「能不能做一个测试版本，看生成之后的 JS 文件、什么文件，就可以看它的选择机制」。

## 诊断（owner 已核过 file:line）

① **英文报错**：`shared/core/agent/execute.ts:1229`（0 个已确认 sibling）与 `:1239`（多于 1 个）
的 `ExecuteDependencyError`，由 `findSiblingResolvedContactIdsForDisplayedName` 在**同一张截图**内找
同名且已确认的 create_contact 卡；sibling 仍 pending 或已 rejected 都落到 :1229。这条路与 fix3 修的
跨截图 `local_batch_deferred` 依赖无关，所以 fix3 的中文文案盖不到它。确认页卡片按 id 升序
（`app/src/review-order.ts:24-26`），create_contact 本就排在互动卡前面，owner 是跳过了它。
错误直通 `getErrorMessage`（`app/src/api.ts`）→ `handleConfirm` catch。

② **面板没弹**：`CrashBoundary` 只在构造时 `readCrashRecord`（`app/src/components/crash-boundary.tsx:31`），
记录来自 `ErrorUtils` 全局 handler。四种情况它都接不住或不显示：原生崩溃（无 JS handler）、
被系统杀进程、同步写没落地、读取端 `isCrashRecord` 校验过严把部分记录丢弃。app 里**没有任何 `AppState` 监听**，
无法区分「正常退到后台」与「异常结束」。→ 需要一个**不依赖 JS 异常**的黑匣子（Goal 2）。

③ **通知列名者成互动**：`shared/core/llm/prompts.ts:76`「每个非自己参与人 interaction_summary 必填」
+ `:174/:211`「participants = 截图里出现或**被提及**的人」→ propose 对每个有摘要的参与人出 record_interaction。
extraction 里没有「说没说过话」的字段。

④ **诊断材料现成**：每张截图的 LLM 原始输出已落库 `screenshots.raw_extraction`（`app/src/local/store.ts:244`）；
OCR 导出已有目录选择器 `app/src/local/ocr-export-directory-picker.ts`（`Directory.pickDirectoryAsync()` +
`writeOcrExportToDirectory`）。本地流水线 `app/src/local/api.ts uploadScreenshot` 手里有 ocr / extraction /
resolutions / proposedCards / notices 全部中间产物，只是没有出口。**缺的**：resolution 与查重决策没有持久化、
崩溃记录与事件日志没有出口。

⑤ **英文摘要**：`propose.ts` `buildInteractionPayload`（fix2）直接用 LLM 的 `interaction_summary`，无语言校验；
prompt 已有语言规则（`prompts.ts:67`），模型偶发违反。

## Goal

### 1. 诊断包导出（app）

- 设置页新 SectionCard「诊断」：按钮**「导出诊断包」**→ 复用目录选择器 → 在所选目录下建
  `mailuo-diagnostics-<yyyyMMdd-HHmm>/`，写入：
  `meta.json`（app 版本、导出时间、平台、连接模式、诊断记录条数）、`screenshots.json`（含 `raw_extraction`
  与 `user_note`）、`action_cards.json`（全部卡片：type / status / payload / disambiguation / resolved_contact_id）、
  `contacts.json`、`observations.json`、`meetings.json`、`insights.json`、`traces/<screenshot_id>.json`、
  `crash-record.json`（若有）、`event-log.json`（Goal 2）。全部真实数据不脱敏（owner 自用）。
- **过程记录（trace）**：本地模式每张截图整理结束（成功或失败）写一份
  `documentDirectory/diagnostics/traces/<screenshot_id>.json`：
  `{ screenshot_id, started_at, finished_at, perception_path: "ocr"|"cloud"|"ocr->cloud", ocr_text?, extraction,
  resolutions: [{ participant_name, status, source?, contact_id?, candidate_ids? }], proposed_cards: [{ type, payload,
  disambiguation }], meeting_dedup: [{ title, duplicate_of_meeting_id? , similarity? }], notices, error? }`。
  只保留最近 50 份（超出删最旧，app 内部文件清理，允许）。不建表、不动 schema、不加开关（默认常开，体积 KB 级）。
- 导出结果 toast 显示目录名；失败给中文原因。测试：trace 写入/滚动删除 + 导出目录内容清单（用 fake 目录）。

### 2. 黑匣子事件日志 + 面板加固（app）

- 新模块 `app/src/diagnostics/event-log.ts`：`logEvent(kind, detail?)` **同步**追加到 kv-store 键
  `mailuo.eventlog.v1`（环形，最近 200 条，每条 `{ t, kind, detail }`，detail ≤ 120 字）。事件：`app_start`、
  `route`（路径）、`upload_start`（张数）、`upload_progress`（第几张/状态）、`upload_done`、`confirm_start`（card id/type）、
  `confirm_ok`、`confirm_error`（message 前 120 字）、`reject`、`clear_all`、`app_background` / `app_active`
  （`AppState` 监听，装在根布局）、`crash`（全局 handler 写记录时同时记一条）。
- **异常结束判定**：启动时读上一段日志（以本次 `app_start` 之前的条目为上一段）；若上一段非空且最后一条
  **不是** `app_background` → 视为「上次可能异常退出」，即使没有崩溃记录也弹面板，显示最后 20 条事件
  + 崩溃记录（若有）；文案区分「有崩溃记录」与「仅事件日志」。「知道了」清除崩溃记录并给上一段打 `acknowledged` 标记。
- `readCrashRecord` 放宽：字段缺失/类型不符时**尽量显示**已有字段（只要求 `timestamp` 与 `message` 为字符串），不再整条丢弃。
- 测试：环形截断；异常结束判定（最后一条 `app_background` → 不弹；最后一条 `confirm_error` → 弹）；放宽读取。

### 3. 同屏新建联系人依赖：中文提示 + 依赖可见（core + app）

- `execute.ts:1229/1239` 两处 `ExecuteDependencyError` 改中文并按 sibling 状态分文案：
  sibling pending：「请先确认『新建联系人 王磊』那张卡」；sibling rejected：「这张互动依赖的『新建联系人 王磊』
  已被跳过，请把这张也跳过，或先手动新建该联系人」；没有同名 sibling：「这张互动还没关联到任何联系人，
  请先在本批新建或选择对应的联系人」；多于 1 个已确认：「同名联系人有 N 个，请在卡片上选择具体是谁」。
  `findSiblingResolvedContactIdsForDisplayedName` 需要顺带返回 sibling 的状态/姓名，或在旁边加最小查询。
  server 模式走同一份 execute，文案对两端一致。
- app 确认页：互动卡无 `contact_id`、无 `local_batch_deferred`、但同截图存在同名 create_contact 卡时，
  「当前归属」显示「将关联到本张新建的联系人：王磊（待确认）」/「…已被跳过」（复用 fix3 的
  `LocalBatchAnchorInfo` 与 `LocalBatchAnchorProvider`，数据在 review 页从同组卡片里算，不新增存储）。
  确认时若 sibling 未确认，**前端先给中文提示、不调 execute**。
- 测试：`server/src/tests/execute.test.ts` 加 pending / rejected / none 三种 sibling 的中文 message 断言；
  app 侧 review 归属文案用例。

### 4. 说话人规则：只有说了话的人才记互动（core + prompt）

- extraction participant 新增 `role: 'speaker' | 'mentioned'`（zod **optional**，缺省视为 `speaker`，
  兼容库里旧 `raw_extraction`）。prompt（视觉版与文本版一致）：speaker = 在截图里**发出过至少一条消息**的人；
  mentioned = 只在消息正文、通知、名单、@ 列表里出现的人；`interaction_summary` **只对 speaker 必填**，
  mentioned 可省略。
- propose：只有 speaker 出 `record_interaction`；mentioned 仍正常出 create_contact / update_contact 与 facts
  （档案照旧更新）；事项参与人与会议查重不受影响。
- 快照照惯例：`perception-prompts.before-v3-m4-fix5.json` 应与 fix3 的 after 逐字相同（sha256 前缀 `1821b4e2`），
  after 含 role 规则；快照测试断言。
- 测试：mentioned 参与人不出 record_interaction 但出 create_contact；缺 role 的旧 extraction 行为不变。

### 5. 英文互动摘要兜底（core）

- `buildInteractionPayload`：若依据原文（该参与人的 source_quote 与相关 quotes 合并）CJK 字符占比 ≥ 50%，
  而 LLM 的 `interaction_summary` CJK 占比 < 30% → 视为语言违规，改用 fix2 的 fallback 归纳（原文引用类），
  **不额外调 LLM**。测试：英文 summary + 中文原文 → payload.summary 为 fallback 产物；中文 summary 不受影响；
  英文原文 + 英文 summary 不受影响。

## 已否决（别再提议）

- **同批事项查重**：owner 09-02 否决。
- **过滤识别错别字别名**：对下次精确匹配有用，owner 手删。
- **「通知 X 会议时间」归入已有会议进展**：等诊断包看 LLM 实际返回再定。
- **确认页时间框改版**：owner 定不改。
- **自动按 sibling 关联互动卡**（不等用户确认新建卡就直接关联）：仍是「宁可留空不猜错」，只改提示。

## 施工分两批（同一份任务书，两次派活，版本只升一次）

- **批 A = Goal 3、4、5**（core + prompt + 确认页归属文案）
- **批 B = Goal 1、2**（诊断包 + 黑匣子，app 侧）
- 每批自验全绿后各自 commit + push；批 B 在批 A 之上做。版本号两批都不动。

## Scope

- 可动（批 A）：`shared/core/agent/execute.ts`（仅 sibling 报错与状态查询）、`shared/core/agent/propose.ts`
  （speaker 过滤、摘要兜底）、`shared/core/agent/perceive.ts` 与 `shared/core/schemas.ts`（role 字段）、
  `shared/core/llm/prompts.ts`、`app/app/review/[screenshotId].tsx` 与 `app/src/components/review/review-fields.tsx`
  （sibling 归属文案与前置提示）、测试、快照。
- 可动（批 B）：`app/app/settings.tsx`、`app/app/_layout.tsx`（AppState + 事件日志）、`app/src/components/crash-boundary.tsx`、
  `app/src/diagnostics/*`（新增 event-log / diagnostics-export / trace-store）、`app/src/local/api.ts`（写 trace 的挂点）、
  `app/src/local/store.ts` / `types.ts`（若需「列出全部表」的只读查询接口）、`app/app/(tabs)/index.tsx` 与
  `app/app/review/[screenshotId].tsx`（事件埋点）、测试。
- 不可动：DB schema / migrations、`action_cards.type` CHECK、卡片拆分与确认行为、fix1–fix4 已交付行为、
  `resolve.ts` near match 规则、`app/app.json` 版本号。
- 不新增依赖（`AppState`、`expo-file-system` 均已在）；不回填历史数据。

## Constraints

- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push origin main
- 示例与测试数据一律用虚构名（王磊 / 王总 / 荀导 / 某集团 市场部）
- 有边界疑问报 BLOCKED / NEEDS_CONTEXT 停下，不要自行扩 scope

## Done when

**批 A**
1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 160、app 不低于 101；`git diff --check` 干净
2. Goal 3：三种 sibling 状态的中文 message 有测试；review 页归属文案有用例
3. Goal 4：mentioned 不出互动、档案照旧；缺 role 行为不变；快照 before 前缀 `1821b4e2`、after 含 role 规则
4. Goal 5：三组语言用例
5. 报告贴真实测试输出、快照 diff、文件清单、偏离决定

**批 B**
1. 同批 A 第 1 条（基线以批 A 交付后为准，只增不减）
2. Goal 1：trace 写入与滚动删除有测试；导出目录内容清单有测试（fake 目录）；报告贴一次真实导出的文件列表（可用 Node 假目录）
3. Goal 2：环形截断、异常结束判定、放宽读取三组测试；面板两种文案
4. 报告贴真实测试输出、文件清单、偏离决定
