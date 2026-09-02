# 脉络 Mailuo — v3-M4-fix6 施工交接（问系统上次死因 + 纯应答不记互动 + 假人名不建联系人 + 视觉回退带分隔线提示）

## 你的角色

接 v3.1.5（`31e0b54` + tag）。fix5 真机验收通过，**首份诊断包已由 owner 读完**，本批四件全部有数据支撑。
**不动 DB schema、不做迁移。** 施工图 PLAN.md（第 0 节适用），先 `git log -3` 同步认知。自验用本机 Node 26。
⚠️ 本批含 **Kotlin 改动**（Goal 1），本机没有 Android 编译环境，Gradle 只能靠 EAS 出包验；JS 侧必须
容忍原生函数缺席（旧包 / web / 测试）。

## 诊断包实证（v3.1.5，owner 2026-09-03 直读手机导出的 `mailuo-diagnostics-*`）

- **闪退时刻钉死**：黑匣子显示 01:33:52.9 `route /insights`（确认完本批 33 张卡进入洞察页）之后**零事件**，
  36 秒后出现新的 `app_start`，**且没有 `crash` 事件** → JS 全局 handler 未执行 → 原生崩溃 / 低内存被杀 /
  系统结束三者之一。三次闪退（3.1.2 进确认页、3.1.4 确认页报错后、3.1.5 进洞察页）共同点＝**大页面切换瞬间**，
  均无 JS 痕迹。进洞察页时 `app/app/insights.tsx:55-109` 对本批全部受影响联系人 `Promise.allSettled`
  并行 `getContactDetail`，本地模式每个 detail 触发 `generateInsights`（`app/src/local/api.ts:462`），
  同时确认页 33 张卡的树在卸载。
- **说话人规则、别名过滤、诊断导出均生效**（通知截图 4 个被提及者零互动卡；5 个联系人别名全空；
  导出时第二个 sqlite 连接没撞锁）。
- **owner 跳过的 8 张互动卡里 5 张是纯应答**（摘要形如「确认收到会议通知」「回复‘好的’」，依据原文就是
  「收到！」「好的」），**跳过的 4 张新建联系人全是通知里抽出的假人名**（群昵称「Coder&Chief」「AliceL.JY」、
  机构「党群工作部」、通用词「大家」，均 role=mentioned 且无任何字段）。
- **相对日期锚错**：某张截图走了 `ocr->cloud` 回退（OCR 质量差→云端视觉），视觉模型把「今天下午14:30左右」
  锚到 8/11，owner 确认应为 8/12。同一张的 OCR 文本里分隔线顺序是「8月11日08:59 → 那句话 → 8月12日11:30」。
  上一版「灵敏」是因为走了 OCR 文本路径、带 `time_anchor=absolute-date` 标记（`app/src/local/perceive-ocr.ts:18`，
  prompt `shared/core/llm/prompts.ts:197`）；**视觉路径没有任何分隔线提示**。

## Goal

### 1. 问系统上次为什么死（Kotlin + app）

- `app/modules/tenglu-region-sampler/`（Expo Module，Kotlin `AsyncFunction` 与 `src/TengluRegionSamplerModule.ts`
  绑定 + `.web.ts` 桩）新增 `AsyncFunction("readLastExitInfo")`：Android 11+（`Build.VERSION.SDK_INT >= 30`）
  用 `ActivityManager.getHistoricalProcessExitReasons(packageName, 0, 5)` 读最近 5 条，每条返回
  `{ reason(数字), reason_name(REASON_* 名), status, description, timestamp(ms), importance, pss_kb, rss_kb }`；
  低于 API 30 或异常时返回空数组，**绝不抛**。JS 侧 `readLastExitInfo(): Promise<ExitInfo[]>`，原生函数缺席
  （web / 测试 / 旧包）返回 `[]`。
- 启动时（`app/app/_layout.tsx` 现有 `startAppSession` 之后，异步）读一次，把**时间戳晚于上一段 `app_start`**
  的条目记进黑匣子 `exit_reason` 事件（detail：`reason_name status pss_kb 描述前 80 字`），并在
  「上次可能异常退出」面板顶部显示「系统记录的退出原因：…」；没有匹配条目显示「系统未记录退出原因」。
- 黑匣子新增事件：`insights_start`（联系人数）/ `insights_ok` / `insights_error`（`insights.tsx` 加载 effect）；
  `mem` 事件在每次 `route` 与 `upload_progress` 时附 `HermesInternal.getInstrumentedStats()` 里的堆字段
  （若可用，取 `js_heapSize`/`js_allocatedBytes` 两项，KB 取整），原生内存用同一个 Kotlin 模块加
  `AsyncFunction("readMemoryStats")` 返回 `{ native_heap_kb, java_heap_kb, avail_mb, low_memory }`
  （`Debug.getNativeHeapAllocatedSize` / `Runtime` / `ActivityManager.MemoryInfo`），route 变化时异步记
  `mem` 事件，失败静默。
- 事件种类枚举（`app/src/diagnostics/event-log.ts` `EVENT_KINDS`）同步扩展；诊断包 `event-log.json` 自然带上。
- 测试：JS 侧用假模块——`readLastExitInfo` 返回样例 → 面板文案；返回空 / 抛错 → 「系统未记录」；
  事件枚举扩展有测试。Kotlin 部分在报告里贴完整源码片段，owner 靠 EAS 出包验。

### 2. 纯应答不出互动卡（core）

- `shared/core/agent/propose.ts`：某参与人**全部**依据原文（`source_quote` + 该人 related quotes）去掉标点、
  空白、emoji 后每条都命中纯应答集合 `{收到, 好的, 好, 嗯, 嗯嗯, OK, ok, 好嘞, 了解, 明白, 知道了, 谢谢, 收到谢谢, 好的收到}`
  或长度 ≤ 2 → **不出 `record_interaction`**（联系人卡与 facts 照旧）。只要有一条原文不是纯应答就照常出卡。
- 测试：三条「收到」→ 无互动卡；「收到，明天上午我带车牌号过去」→ 出卡；混合（一条纯应答 + 一条实质）→ 出卡。

### 3. 假人名不建联系人（core）

- `propose.ts` 新建联系人前过滤，命中任一即**不出 `create_contact`**（仍可作为事项参与人名字保存）：
  a. 通用称呼：`{大家, 各位, 全体, 同事们, 同学们, 各位同事, 各位领导, 领导们, 全体员工}`；
  b. 机构名：以 `部|处|科|室|办|办公室|公司|集团|中心|委员会|工作部|事业部|小组` 结尾且 ≥ 3 字、且不含常见姓氏开头的人名形状
     （简单判据：长度 ≥ 3 且结尾命中即视为机构）；
  c. `role === 'mentioned'` 且 company / title / phone / wechat_id / aliases 全空、且没有任何 facts 指向此人。
- 测试：「大家」「党群工作部」「Amy.L（mentioned 无字段）」不出新建卡；「王磊（mentioned 但 title=副总）」照常出；
  speaker 一律不受本条影响。

### 4. 视觉回退路径带分隔线提示（app + prompt）

- `app/src/local/api.ts` `uploadScreenshot`：当 OCR 已跑但走了回退（`ocr->cloud` 三种情况之一）且 OCR 行里
  存在 `WECHAT_ABSOLUTE_TIME` 分隔线（`perceive-ocr.ts` 的判定函数导出复用），把这些分隔线**按 y 坐标顺序**
  作为文本提示传给视觉感知：`perceiveScreenshot({ ..., timestampHints: ['8月11日08:59', '8月12日11:30'] })`；
  `shared/core/agent/perceive.ts` / `prompts.ts` 视觉版 prompt 加一段：
  「Local OCR detected these WeChat timestamp separators in top-to-bottom order: … Anchor relative day words
  (今天/明天/后天/昨天) of a message to the nearest separator ABOVE that message. If uncertain which separator a
  message belongs to, set time_iso to null and has_time_signal accordingly.」提示为空则不加这段。
- 同时核一遍 `perceive-ocr.ts` 输出行顺序是否严格按 y 坐标（分隔线与消息的相对顺序决定锚点）；不是则修。
- 快照照惯例（before = fix5 after，sha256 前缀 `741f75f9`；after 含分隔线提示段）；测试：给定 hints 时 prompt 含该段、
  无 hints 不含；回退路径把 OCR 分隔线传入的用例。

## 已否决（别再提议）

- 装第三方崩溃 SDK（Sentry / Bugsnag）：不加依赖；`ApplicationExitInfo` 是系统自带的。
- 同批事项查重、识别错别字别名过滤、确认页时间框：owner 之前已否决。
- 把「今天/明天」的锚点改成拍照时间或上传时间：违反「宁可留空不要猜错」；只用截图内证据。

## Scope

- 可动：`app/modules/tenglu-region-sampler/**`（新增两个 AsyncFunction + TS 绑定 + web 桩 + types）、
  `app/app/_layout.tsx`、`app/app/insights.tsx`（事件埋点）、`app/src/components/crash-boundary.tsx`、
  `app/src/diagnostics/*`、`app/src/local/api.ts`、`app/src/local/perceive-ocr.ts`（仅导出分隔线判定与行序核查）、
  `shared/core/agent/propose.ts`、`shared/core/agent/perceive.ts`、`shared/core/llm/prompts.ts`、测试、快照。
- 不可动：DB schema / migrations、`action_cards.type` CHECK、fix1–fix5 已交付行为、`resolve.ts` near match、
  `app/app.json` 版本号、ML Kit 补丁脚本。
- 不新增 npm 依赖；不回填历史数据。

## Constraints

- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push origin main
- Kotlin 代码只用 Android SDK 自带 API，加 `Build.VERSION` 守卫，任何异常吞掉返回空
- 示例与测试数据一律用虚构名（王磊 / 王总 / 荀导 / 某集团 市场部）
- 有边界疑问报 BLOCKED / NEEDS_CONTEXT 停下，不要自行扩 scope

## Done when

1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 170、app 不低于 129；`git diff --check` 干净
2. Goal 1：JS 侧三组测试（有退出记录 / 空 / 抛错）+ 事件枚举扩展；报告贴 Kotlin 两个函数完整源码
3. Goal 2：三组用例；Goal 3：四组用例
4. Goal 4：hints 有无两组 prompt 断言 + 回退路径传入用例 + 快照 before 前缀 `741f75f9`
5. 报告贴真实测试输出、快照 diff、文件清单、偏离决定
