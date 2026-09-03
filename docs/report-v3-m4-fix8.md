# 脉络 v3-M4-fix8 施工报告

日期：2026-09-03

施工基线：`main @ 897d512`

## 交付结果

### Goal 1：互动只记发起方

- 感知参与人新增可选字段 `speech_act: "initiate" | "respond"`；旧 `raw_extraction` 缺字段时保持兼容，提议阶段按 `initiate` 处理。
- 视觉与文本感知共用同一段 speech-act 规则：纯应答、确认、同意、致谢或简短表态标为 `respond`；同一参与人兼有发起与应答时标为 `initiate`；未发言的 mentioned 参与人省略该字段。
- `speech_act="respond"` 的参与人仍可生成联系人和事实更新，但不再生成 `record_interaction`；fix6 的纯应答文本兜底保持不变。
- 测试覆盖 schema 接受、拒绝和缺省兼容，以及 respond、initiate、缺字段和原有纯应答兜底。

### Goal 2：会议通知归进展或丢弃

- `kind="other"` 的会议通知按三分支处理：
  1. 唯一命中已落库会议：生成带 `duplicate_of_meeting_id` 的标准 `agenda_append` 卡；
  2. 唯一命中同批新会议：把通知原文并入该会议卡的 `agenda`，不另建卡；
  3. 无法唯一识别会议：丢弃通知。
- 匹配复用当前会议标题相似度阈值；也支持参与人有交集且绝对日期同日，包括只有月日、没有时钟的日期。无年份按当前上海年份，显式年份照原文；相对日期不自行猜测。
- 参与人同日匹配会把 extraction 中已标记为本人的昵称与库内“我”统一比较；普通姓名和事件原文保持不变。
- 丢弃 special other 时同步过滤同一证据产生的旧 meeting-progress fragment，避免调用方先行解析的结果把已丢通知重新生成卡；同一 resolution 中无关 fragment 保留。
- 无时间、无地点且标题为确认／对接／沟通／联系的沟通动作丢弃；带时间或地点的 other 保持原行为。
- 测试覆盖已落库、同批新建、无匹配三分支，标题与参与人/同日两类匹配，日期无时钟/已过月日/显式年份，昵称到“我”的匹配，以及旧 progress 的命中过滤与无关 fragment 保留。
- 未改 `shared/core/schemas.ts` 的 `agenda_append` 校验，也未改 `shared/core/agent/execute.ts`。

### Goal 3：本人昵称强制 is_self

- 本地连接配置新增 `selfNames`，设置页提供“本人在群里的昵称”输入，支持中文或英文逗号；保存时去空白、折叠连续空格并按大小写无关规则去重。
- Android、iOS 本地路径都会读取昵称配置；本地连接页重存模型或 Key 时保留 `selfNames`。server 模式显示不支持占位，不改变路由。
- 视觉、OCR 文本、视觉回退和粘贴文本四条本地感知路径统一在 extraction 后处理：昵称命中的参与人强制 `is_self=true`，原始事件姓名不改写。
- 提议阶段用同一归一化规则把事项中的本人昵称显示为“我”；同一事项命中多个本人别名时只保留一个“我”。
- 测试覆盖配置 round-trip、逗号解析与去重、旧配置兼容、匹配昵称不建联系人/互动、未匹配昵称保持原行为、会议参与人显示为单个“我”，以及通知昵称与库内“我”的会议匹配。

### Goal 4：模型请求超时

- 文本与视觉请求超时常量集中为 60 秒和 90 秒；请求中含 `image_url` 即按视觉请求计算，结构化输出重试逻辑未变。
- 同一个绝对截止时间覆盖 `fetch` 与 `response.json()`，超时后调用 `AbortController.abort()`，并返回 `PROVIDER_REQUEST_TIMEOUT` 与中文信息 `模型请求超时（N 秒），请检查网络后重试`。
- 成功、HTTP 错误、非 JSON、网络错误和超时路径都会清理计时器；原有错误语义保持。
- 测试用 mock timer 覆盖文本 60 秒、视觉 90 秒、永不返回的 fetch、永不完成的响应体、abort signal 和精确错误码/文案。

## 完整验收输出

### server

命令：`cd server && npm test`

```text
ℹ tests 191
ℹ suites 0
ℹ pass 191
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 631.559708
```

门槛：`191 >= 177`。

命令：`cd server && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### app

命令：`cd app && npm test`

```text
ℹ tests 158
ℹ suites 0
ℹ pass 158
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 738.466292
```

门槛：`158 >= 152`。

命令：`cd app && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### 工作树检查

命令：`git diff --check`

```text
(无标准输出，exit 0)
```

## Prompt 快照

- before：`docs/perception-baseline/perception-prompts.before-v3-m4-fix8.json`
  - SHA-256：`590d35628c8c19e84b7c7447bbad75d9a3f9fadf05ede0aa02b41869ccf88232`
- after：`docs/perception-baseline/perception-prompts.after-v3-m4-fix8.json`
  - SHA-256：`12dfb94156d01ead6be9b79ec5f7a8a51da618fdb2be1c194c5d2f782de422a5`

before 保留 fix7 后的 prompt 字节；after 只新增 speech-act 合约并更新对应 participants schema 行。对两个 builder 解包后的实际语义 diff 如下。

### 视觉 prompt

```diff
@@ -5,6 +5,10 @@
 In a chat screenshot, the device owner is the self side of the conversation: messages shown as "我" or the right-side bubbles. Mark that participant with is_self=true. Mark everyone else with is_self=false.
 Do not turn another person into the device owner unless the screenshot itself shows that self-side evidence.
+Participant speech-act rules:
+- Set speech_act="initiate" when the participant initiates an arrangement, notification, question, assignment, proposal, or information-sharing in this evidence—that is, any message that gives the other side something new to do or new information to know.
+- Set speech_act="respond" only when all messages from that participant merely respond to another person through acknowledgement, confirmation, agreement, thanks, or a brief stance such as "收到", "好的", "会落实", "可以参加", or "明白". Treat it as respond even when the wording is longer.
+- If the participant has both initiate and respond messages, set speech_act="initiate". Omit speech_act only when the participant sent no message in this evidence.
 Participant role rules:
@@ -42,7 +46,7 @@
 Schema requirements:
-- participants: array of people explicitly shown or mentioned in the screenshot. Include name, is_self, role ("speaker" or "mentioned"), optional aliases/company/title/phone/wechat_id/notes, interaction_summary required only for non-self role="speaker" participants and optional for role="mentioned" participants, confidence, source_quote. Omit interaction_summary for self.
+- participants: array of people explicitly shown or mentioned in the screenshot. Include name, is_self, role ("speaker" or "mentioned"), speech_act ("initiate" or "respond") for role="speaker", optional aliases/company/title/phone/wechat_id/notes, interaction_summary required only for non-self role="speaker" participants and optional for role="mentioned" participants, confidence, source_quote. Omit speech_act for role="mentioned" and interaction_summary for self.
```

### 文本 prompt

```diff
@@ -8,6 +8,10 @@
 For a side=null line, determine is_self or speaker_name only from explicit text such as "我". Otherwise do not guess, and use speaker_name=null when applicable.
 Do not turn another person into the device owner unless a side=me marker or the provided OCR text explicitly shows that self-side evidence.
+Participant speech-act rules:
+- Set speech_act="initiate" when the participant initiates an arrangement, notification, question, assignment, proposal, or information-sharing in this evidence—that is, any message that gives the other side something new to do or new information to know.
+- Set speech_act="respond" only when all messages from that participant merely respond to another person through acknowledgement, confirmation, agreement, thanks, or a brief stance such as "收到", "好的", "会落实", "可以参加", or "明白". Treat it as respond even when the wording is longer.
+- If the participant has both initiate and respond messages, set speech_act="initiate". Omit speech_act only when the participant sent no message in this evidence.
 Participant role rules:
@@ -43,7 +47,7 @@
 Schema requirements:
-- participants: array of people explicitly shown or mentioned in the provided OCR text. Include name, is_self, role ("speaker" or "mentioned"), optional aliases/company/title/phone/wechat_id/notes, interaction_summary required only for non-self role="speaker" participants and optional for role="mentioned" participants, confidence, source_quote. Omit interaction_summary for self.
+- participants: array of people explicitly shown or mentioned in the provided OCR text. Include name, is_self, role ("speaker" or "mentioned"), speech_act ("initiate" or "respond") for role="speaker", optional aliases/company/title/phone/wechat_id/notes, interaction_summary required only for non-self role="speaker" participants and optional for role="mentioned" participants, confidence, source_quote. Omit speech_act for role="mentioned" and interaction_summary for self.
```

## 文件清单

- `shared/core/agent/perceive.ts`
- `shared/core/agent/propose.ts`
- `shared/core/llm/prompts.ts`
- `shared/core/llm/provider.ts`
- `app/app/connection/local.tsx`
- `app/app/settings.tsx`
- `app/src/connection/config.ts`
- `app/src/local/api.ts`
- `app/src/local/runtime-base.ts`
- `app/src/tests/connection-config.test.ts`
- `app/src/tests/local-api.test.ts`
- `app/src/tests/perception-text.test.ts`
- `server/src/tests/perceive.test.ts`
- `server/src/tests/propose.test.ts`
- `server/src/tests/provider.test.ts`
- `docs/perception-baseline/perception-prompts.before-v3-m4-fix8.json`
- `docs/perception-baseline/perception-prompts.after-v3-m4-fix8.json`
- `docs/report-v3-m4-fix8.md`

## 偏离与决定

- 无任务书范围偏离，Goal 1–4 均按任务书及 owner 对 Goal 2 的三分支裁决实现。
- 没有修改 DB schema、migration、`resolve.ts`、`execute.ts`、`app/app.json` 或依赖，也没有改动 fix1–fix7 的既有分支。
- Goal 2 对 discarded special event 的旧 progress fragment 做证据级过滤，是保证“找不到会议则丢弃”在真实调用顺序下成立的必要防漏；无关 fragment 不删。
- Goal 2 的“同日”只从 ISO 时间或绝对月日取日历日；相对日期仍不解析，避免扩展已否决的时间锚定范围。
- Goal 4 用同一截止时间覆盖响应体读取，是“模型请求超时”的完整边界；没有增加额外重试。

## Simplicity First 记账

- Goal 1 复用现有 zod 感知 schema、共享 prompt builder 和 fix6 互动兜底，只增加一个 optional 字段与一个候选过滤条件。
- Goal 2 复用 `normalizedEditSimilarity`、`MEETING_DUPLICATE_RULES`、`buildMeetingProgressCards`、`appendMeetingAgenda` 和现有时间归一化入口；没有引入第二套会议卡或执行协议。
- Goal 3 复用本地连接配置和感知后处理入口，以一致的昵称归一化规则贯通配置、is_self 与事项显示；core 内的 is_self 与事项显示共用同一函数，不落 DB。
- Goal 4 使用平台原生 `AbortController` 与计时器；不加依赖。
- 明确略过 DB/migration、near-match、execute、版本号和依赖改动；安全校验、输入归一化、超时清理和防数据误写检查均保留。
