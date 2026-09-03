# 脉络 Mailuo — v3-M4-fix7 施工交接（导出不再关库 + 原生崩溃 tombstone 入诊断包 + 切换实验）

## 你的角色

接 v3.1.6（`ff97cc0` + tag）。3.1.6 真机反馈：纯应答不记互动、假人名不建联系人**通过**；
进洞察页仍闪退；**并暴露一个 3.1.5 引入的 P0**。本批分三批：批 A = Goal 1、2（必修 + 诊断能力，已交付 `55979b1`），批 B = Goal 2b（Java 异常写栈，必做），
批 C = Goal 3（实验性缓解，owner 拍板后才派）。**不动 DB schema、不做迁移。** 施工图 PLAN.md（第 0 节适用），
先 `git log -3` 同步认知。自验用本机 Node 26。含 Kotlin 改动，本机无 Gradle，靠 EAS 出包验；JS 侧必须容忍原生函数缺席。

## 真机实证（v3.1.6，2026-09-03 早）

- ❌ **P0**：导出诊断包后打开日程页，红字
  `Call to function 'NativeDatabase.prepareSync' has been rejected. → Caused by: java.lang.NullPointerException`。
- ❌ 确认完本批全部卡片进入洞察页时闪退（第三次同型）。黑匣子尾部：`insights_start contacts=4,missing=0` →
  `insights_ok`（全部命中缓存，**无 LLM 调用**）→ `route /insights` →
  `mem js_heap_kb=28672 js_allocated_kb=15841 native_heap_kb=123149 java_heap_kb=79274 avail_mb=2358 low_memory=false`
  → 无后续事件。**内存充裕，排除 OOM**；死在纯界面切换（确认页卡片树卸载 + 洞察页挂载）瞬间，属原生崩溃。
  面板顶部「系统记录的退出原因」那行 owner 还没截到，待补。

## 诊断（owner 已核 file:line）

① **P0 根因**：`app/src/diagnostics/diagnostics-export-runtime-base.ts` 在导出时
`createExpoSqliteLocalStore()` 新建 store 读快照，`finally { store.close() }`。而 expo-sqlite 57.0.2
`android/src/main/java/expo/modules/sqlite/SQLiteModule.kt:113`
`findCachedDatabase { it.databasePath == databasePath && it.openOptions == options && !options.useNewConnection }`
——默认 `useNewConnection=false` 时 `openDatabaseSync("mailuo.sqlite")` **返回缓存里同一个 NativeDatabase**，
`closeSync()` 关掉的就是 `app/src/local/runtime-base.ts:20-25` 单例正在用的连接；之后任何 `prepareSync` 空指针，
重启进程才恢复。3.1.5 那晚导出是最后一个动作，症状没露。

② **tombstone 可取**：Android 12+（API 31）`ApplicationExitInfo.getTraceInputStream()` 对
`REASON_CRASH_NATIVE` 返回 tombstone（protobuf），对 `REASON_ANR` 返回 ANR trace 文本；fix6 已在
`app/modules/tenglu-region-sampler/…/TengluRegionSamplerModule.kt` 有 `readLastExitInfo`，就近扩展。

③ 三次闪退（3.1.2 上传页→确认页、3.1.4 确认页报错后、3.1.6 确认页→洞察页）都发生在 `router.push/replace`
的原生 Stack 切换瞬间，切换前一页都是大树（上传页多张缩略图 / 确认页几十张卡）。**这是相关性不是根因**，
Goal 3 只作实验。

## Goal

### 1. 导出诊断包不再另开连接（P0，批 A）

- `LocalStore` 已有 `readDiagnosticsSnapshot()`（fix5）；把它经 `RoutedApi`（`app/src/connection/dispatch.ts`）
  暴露为 `readDiagnosticsSnapshot(): Promise<DiagnosticsSnapshot>`，本地实现直接调 `options.store.readDiagnosticsSnapshot()`，
  server 实现抛「服务器模式暂不支持」。`diagnostics-export-runtime-base.ts` 改调它，**删除 `createExpoSqliteLocalStore` 与
  `store.close()` 的用法**；全仓 grep 确认再无任何路径对单例数据库调 `close()`。
- 测试：导出后再查库（同一 fake store 实例）仍可用；`local-api.test.ts` 加 `readDiagnosticsSnapshot` 转发用例。

### 2. 原生崩溃 tombstone 入诊断包（批 A）

- Kotlin：`readLastExitInfo` 每条增加 `has_trace: boolean`；新增 `AsyncFunction("saveLastExitTrace")`：
  API 31+ 且最近一条（或 timestamp 最新且 reason ∈ {CRASH_NATIVE, ANR, CRASH}）有 trace 时，
  `getTraceInputStream()` 读入并写到 `<filesDir>/diagnostics/exit-traces/<timestamp>.bin`（上限保留 5 份），
  同时抽取长度 ≥ 6 的可打印 ASCII 字符串写 `<timestamp>.strings.txt`（每行一条，去重，最多 2000 行），
  返回 `{ bin_path, strings_path, byte_count, string_count }`；无 trace / 低版本 / 异常 → 返回 null，绝不抛。
- JS：启动读到匹配的 `exit_reason` 后调一次 `saveLastExitTrace()`，结果记黑匣子 `exit_trace` 事件
  （detail 含 byte_count / string_count）；诊断包导出把 `diagnostics/exit-traces/` 整个目录复制进包内 `exit-traces/`。
  面板「系统记录的退出原因」下方加一行「已保存崩溃现场 N 字节」或「无崩溃现场」。
- 测试：JS 侧假模块返回样例 → 事件与面板文案；返回 null → 「无崩溃现场」；Kotlin 贴完整源码。

### 2b. Java 未捕获异常写栈到文件（批 B，必做）

- **依据**：3.1.6 诊断包 `exit_reason=REASON_CRASH description=crash`，且黑匣子无 `crash` 事件 → 异常在 Java/Kotlin 层抛出、
  未经 JS 全局 handler；`getTraceInputStream()` 对 REASON_CRASH 通常为 null，Goal 2 的 tombstone 抓不到它。
- Kotlin（同一模块 `OnCreate` 或 `definition` 初始化时）：`Thread.setDefaultUncaughtExceptionHandler` 包一层——
  先把 `Thread.currentThread().name`、异常类名、message、完整 `stackTraceToString()`（含 cause 链）、时间戳、app 版本
  **同步**写到 `<filesDir>/diagnostics/java-crashes/<timestamp>.txt`（上限保留 5 份，写入失败静默），
  再原样交给之前的 handler（不吞、不改变崩溃行为）。安装必须幂等（重复 OnCreate 不叠包）。
- 启动时（`_layout.tsx` 现有 `previousExitDiagnosticsPromise` 链上）读最新一份 java-crash 文件（新增 `AsyncFunction("readLatestJavaCrash")`
  返回 `{ path, timestamp, head }`，head = 前 40 行），若时间戳晚于上一段 `app_start` → 黑匣子记 `java_crash` 事件
  （detail = 异常类名 + message 前 100 字 + 第一帧），面板「系统记录的退出原因」下方显示「Java 异常：<类名>：<message>」+ 前 3 帧。
- 诊断包导出把 `diagnostics/java-crashes/` 复制进包内 `java-crashes/`（与 exit-traces 同一套复制逻辑）。
- 测试：JS 侧假模块三组（有记录 / 无 / 抛错）；Kotlin 贴完整源码。**JS 侧 handler 缺席时一切降级为无**。

### 3. 切换实验（批 C，owner 拍板后才做）

- `app/app/_layout.tsx` 的 `Stack.Screen` 对 `review/[screenshotId]` 与 `insights` 设 `animation: "none"`；
- 确认页最后一张卡处理完→跳洞察页、上传页完成→跳确认页两处：先把本页大列表置空（state 清空使卡片树卸载），
  `requestAnimationFrame` 下一帧再 `router.replace/push`；黑匣子在这两处加 `transition_start/transition_done` 事件。
- **明确标注为实验**：commit message 与报告写清「缓解实验，非根因修复」；若 owner 反馈闪退消失，再决定是否保留。

## 已否决

- 装第三方崩溃 SDK；同批事项查重；错别字别名过滤；确认页时间框。
- 用 `useNewConnection: true` 另开连接再关：能绕过 P0，但仍是第二个连接，读快照走单例更干净。

## Scope

- 可动（批 A）：`app/src/diagnostics/diagnostics-export-runtime-base.ts`、`diagnostics-export.ts`（exit-traces 目录复制）、
  `app/src/connection/dispatch.ts`、`app/src/api.ts`（server 占位）、`app/src/local/api.ts`、`app/src/local/types.ts`、
  `app/modules/tenglu-region-sampler/**`、`app/src/diagnostics/event-log.ts` / `previous-exit.ts`、
  `app/src/components/crash-boundary.tsx`、`app/app/_layout.tsx`（调用 saveLastExitTrace）、测试。
- 可动（批 B）：与批 A 相同集合 + `app/src/diagnostics/*`
- 可动（批 C）：`app/src/diagnostics/event-log.ts`（仅新增 `transition_start` / `transition_done` 两个事件种类）、`app/app/_layout.tsx`（animation）、`app/app/review/[screenshotId].tsx`、`app/app/(tabs)/index.tsx`、
  `app/src/flow-context.tsx`（若需置空列表的 action）、测试。
- 不可动：DB schema / migrations、fix1–fix6 已交付规则层行为、`app/app.json` 版本号、依赖。

## Constraints

- 中文 commit；自验全绿才 commit + push origin main；Kotlin 只用 SDK 自带 API、版本守卫、异常全吞
- 示例与测试数据一律用虚构名
- 有边界疑问报 BLOCKED / NEEDS_CONTEXT 停下

## Done when

**批 A**
1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 177、app 不低于 142；`git diff --check` 干净
2. Goal 1：全仓无对单例库的 `close()` 调用路径（报告贴 grep 结果）；导出后查库仍可用有测试
3. Goal 2：JS 三组测试；Kotlin 完整源码；诊断包含 `exit-traces/`
4. 报告贴真实测试输出、文件清单、偏离决定

**批 B**
1. 两端测试与 tsc 全绿、server 不低于 177、app 不低于 146；Goal 2b 三组 JS 测试 + Kotlin 完整源码 + 诊断包含 `java-crashes/`

**批 C**
1. 同上第 1 条；两处切换 `animation: none` 与置空再跳有测试或断言；报告标注「实验」
