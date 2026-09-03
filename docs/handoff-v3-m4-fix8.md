# 脉络 Mailuo — v3-M4-fix8 施工交接（互动只记发起方 + 通知类事项归进展 + 本人昵称 + 模型请求超时）

## 你的角色

接 v3.1.7（fix7 三批：导出不再关库、tombstone、Java 异常写栈、切换实验）。本批全部是 **owner 从 3.1.6 诊断包
（31 张卡的取舍 + 6 份 trace）里提炼、并已拍板的产品规则**。**不动 DB schema、不做迁移。** 施工图 PLAN.md（第 0 节适用），
先 `git log -3` 同步认知。自验用本机 Node 26。

## 诊断包实证（v3.1.6，owner 直读）

- 31 张卡里互动卡 12 张：owner **只确认了 3 张，全是发起方**（安排会议、通知时间调整、协调参会）；**跳掉的 9 张全是应答方**
  （摘要形如「确认收到会议通知」「表示会落实相关任务」「回复表示可以参加」「回应收到并被指派…」）。fix6 只拦「收到／好的」纯应答，
  太窄。
- `kind=other` 事项 8 张跳了 6 张，含「通知海棠塔和隋导会议时间变更」（owner 多次反感：「这不就是通知吗」）、
  「会议参会人员确认」「隋导来访对接」「GitHub发布链接」；同批有对应会议卡「海棠塔剧场合作项目会议」已确认。
- 一张群聊截图把 owner 本人的群昵称抽成了他人参与人（is_self=false），生成了新建联系人卡与互动卡，owner 全跳。
- trace 4 两次 `Qwen request failed: fetch failed: java.net.UnknownHostException`，**首次尝试挂了 4 分钟**才失败（无超时）。

## Goal

### 1. 互动只记「发起方」（core + prompt）

- extraction participant 新增 `speech_act: 'initiate' | 'respond'`（zod optional，缺省 `initiate` 兼容旧 raw_extraction）。
  prompt（视觉版与文本版一致）定义：**initiate** = 该人在本证据里发起了安排、通知、询问、指派、提议、告知信息（任何让对方有新事可做或新信息可知的发言）；
  **respond** = 该人的全部发言只是对他人发言的应答、确认、同意、致谢或简短表态（收到／好的／会落实／可以参加／明白），
  即使措辞较长也算 respond；两者兼有算 initiate。
- propose：`speech_act === 'respond'` 的参与人**不出 `record_interaction`**（联系人卡与 facts 照旧）；fix6 的纯应答文本规则保留作兜底。
- 快照照惯例（before = fix7 after，报告贴 sha）。测试：respond 不出互动卡；initiate 出；缺字段视为 initiate；纯应答文本规则仍生效。

### 2. 「通知／告知某会议时间」类不再单独成事项（core）

- `kind=other` 事件，标题或原文以「通知／告知／转发／提醒」开头或含「会议时间／时间调整／时间变更／改到／改为」，
  且**能在本批提议卡或已有会议里找到被指代的会议**（`normalizedEditSimilarity` 对会议标题 ≥ `MEETING_DUPLICATE_RULES` 现用阈值，
  或参与人集合有交集且时间同日）→ 不建独立事项。**分三种情况（owner 2026-09-03 裁决，原文只写了 `agenda_append` 一种，与 schema 冲突）**：
  ① 命中的是**已落库会议** → 出标准 `agenda_append` 卡（复用 M4 进展机制）；
  ② 命中的是**同批新会议卡**（尚无会议 ID）→ 把该 other 的原文并入那张会议卡自身的 `agenda`，不另建事项、不出 `agenda_append` 卡；
  ③ 找不到对应会议 → 丢弃（不出卡）。
  **为什么要分**：`shared/core/schemas.ts:92` 校验 `agenda_append` 必须带 `duplicate_of_meeting_id`，
  `shared/core/agent/execute.ts:1146` 又要求该 ID 能在 `db.listMeetings()` 里找到——同批新会议两者都不满足。
  走 ② 可在不动 DB schema / execute（本任务书禁区）的前提下达成同一效果。
- 「会议参会人员确认」「来访对接」这类**无时间、无地点、只是沟通动作**的 other：标题命中「确认／对接／沟通／联系」且 `has_time_signal=false`
  且 `location` 为空 → 不出卡。**有时间或地点的 other（如「报损备车及工作餐安排 · 明天上午」）照旧出卡**——owner 确认过这类。
- 测试：通知类归入对应会议的 agenda_append；无对应会议 → 无卡；「确认参会人员」无时间 → 无卡；有时间的 other 仍出卡。

### 3. 本人昵称强制 is_self（app + core）

- 设置页「本人在群里的昵称」（多个用逗号分隔，存本地连接配置同一处，不进 DB）；本地模式调用感知与 resolve 时传入
  `selfNames: string[]`：extraction 后处理把 `name` 归一化后命中任一昵称的参与人置 `is_self=true`（现有 `isSelfName` 逻辑旁加），
  事项参与人同名者显示为「我」。server 模式暂不支持（占位不报错）。
- 测试：命中昵称的参与人不出新建联系人卡、不出互动卡；不命中不受影响。

### 4. 模型请求超时（core）

- `shared/core/llm/provider.ts` 的 `fetch` 加 `AbortController` 超时：视觉 90s、文本 60s（常量集中一处），超时错误信息中文
  「模型请求超时（N 秒），请检查网络后重试」；现有重试逻辑不变。测试：假 fetch 永不返回 → 在超时后拒绝且消息含「超时」。

## 已否决

- 同批事项查重；识别错别字别名过滤；确认页时间框；用拍照/上传时间锚定相对日期；把「有时间的 other」也归进展。

## Scope

- 可动：`shared/core/agent/perceive.ts`、`propose.ts`、`shared/core/llm/prompts.ts`、`shared/core/llm/provider.ts`、
  `shared/core/schemas.ts`（仅 speech_act）、`app/app/settings.tsx`、`app/src/connection/config.ts`（昵称字段）、
  `app/src/local/api.ts`（传 selfNames）、测试、快照。
- 可动（**owner 2026-09-03 追加**，Goal 3 的必要调用方，属「改字段就得改 caller」不算扩 scope）：
  `app/src/local/runtime-base.ts`（第 28 行 `getProcessingSettings` 现在非 Android 直接返回硬编码默认值、根本不读连接配置，
  iOS 本地模式因此读不到 `selfNames`）、`app/app/connection/local.tsx`（第 142 行 `saveConfig` 用白名单重建配置对象，
  只列了 mode / perceptionPath / exportOcrResults，**用户设完昵称再来改一次模型或 Key 就会被清空**——这是真 bug，必须一并修）。
- 不可动：DB schema / migrations、`resolve.ts` near match、fix1–fix7 已交付行为、`app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）

- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告、快照）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when

1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 177、app 不低于 149；`git diff --check` 干净
2. Goal 1–4 各自测试见上；prompt 快照 before/after
3. 报告贴真实测试输出、快照 diff、文件清单、偏离决定；只写本仓的事
