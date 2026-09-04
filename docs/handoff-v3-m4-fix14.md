# 脉络 Mailuo — v3-M4-fix14 施工交接（3.1.13 真机反馈六件：通知并入只认实质变更 + 到达通报算应答 + 摘要不拼应答 + 引文剥标签 + 省略号覆盖 + 会议后勤不出互动）

## 你的角色

接 v3.1.13。六件小事，**每件对着 3.1.13 首批诊断包（2026-09-04 15:01 批，`/tmp/diag8/`）里一张具体的卡**，Alice 拍板「按你的」。
**纯 core：只动 `shared/core/agent/propose.ts` 与测试**（trace 字段若需加只能加可选字段）。不动 DB schema / prompt / perceive.ts / schemas.ts / execute.ts / resolve.ts / api.ts / batch-contacts.ts / app/**。
施工图 PLAN.md（第 0 节适用），先 `git log -3` 同步认知。自验用本机 Node 26。

## 诊断包实证（v3.1.13，owner 直读；人名按截图原样，测试一律换虚构名）

- **海棠塔会议提议时 agenda=「你们通知海棠塔和隋导这个时间。」**（trace 1 `notice_routing decision=batch`；她清空后才确认）：fix9 Goal 2 把同截图通知并进会议 agenda，并进去的是**给别人的指令**。对照：杂技秀会议 agenda=「会议时间调整；原定于8月24日(周一)上午9:30...会议开场时间调整为当日上午9:00」她**留下了**。两条通知 `has_time_signal` 都是 false，靠时间信号分不开；分得开的是原文有没有实质变更词。
- **卡 #4 沈青岚「收到；隋导己到」（她拒）**：quotes `['收到','隋导己到']`。「收到」被闸滤掉但 **summary 仍拼进去**（fix13 只用滤后集合判定，payload 保留原证据）；「隋导己到」（OCR 己/已）是 fix11 有意保护的「X已到」形状，Alice 判为噪音。
- **卡 #13 沈青岚（她拒）**：quotes 含 `'集团市场部 沈青岚'`（模型把昵称行当引文；quotes 不过 `stripParticipantPrefix`）+ 会议调整全文；同截图事项原文是 `'原定于8月24日(周一)上午9:30...会议开场时间调整为当日上午9:00'`——**含字面「...」省略号**，包含判定失败、相似度也不够 → 未被覆盖 → 出卡。
- **卡 #9 郝明川 / #10 柏贝（她拒；Alice 拍板这类不出）**：#9 三句中「你先谈完话,过来我办公室参加海棠塔剧场会议。」不被事项覆盖；#10「郝总,我要晚一点参会,明早9点半,宓总跟我和张玲谈话,统战工作要求@」+「好的,收到」。两张都是**围绕已成卡会议的人际后勤沟通**（晚到／先来我办公室），不值得记在此人名下。

## Goal（全部在 `shared/core/agent/propose.ts`）

### 1. 通知并入会议只认实质变更（`routeSpecialOtherEvents` / `findMeetingNoticeCandidate` 调用处）
- 新增 `meetingChangeSignals = ['调整','变更','改到','改为','改成','改期','取消','延期','推迟','提前','换到','地点']`；通知事件的 `source_quote` 或 `title` 含任一 → 才走 stored（agenda_append）/ batch（并入 agenda）分支；否则 **直接丢弃**（不出卡、不并入），`noticeRouting.decision='dropped'` 并加可选 `reason: 'no_change_signal'`（`NoticeRouting` 类型加可选字段；`app/src/diagnostics/trace-store.ts` 的 zod 若为 strict 需同步加可选 `reason`，这是唯一允许碰的 app 文件、且只加一行可选字段）。
- 测试（虚构名）：①「你们通知海棠塔和隋导这个时间。」（无变更词）→ dropped/no_change_signal，会议 agenda 不变 ②「会议时间调整 原定于…调整为当日上午9:00」→ batch 并入 ③已落库会议 + 「改到下周三」→ stored ④原有 fix9 用例回归。

### 2. 到达/状态通报算应答（`isPureAcknowledgement`）
- 新增 `isArrivalReport(fragment)`：噪音剥离后码点 ≤ 10 且匹配 `/(已|己|巳)到|到了|到啦|到位|到齐|人齐/u` → 视为应答。**这条推翻 fix11 的「荀导已到」保护**：把那条既有测试的期望改为不出卡，并在报告里注明是 Alice 2026-09-04 拍板。
- 测试：①「隋导己到」→ 应答 ②「荀导已到」→ 应答（改旧测试）③「隋导已到，材料他带来了」（>10 码点）→ 不算应答 ④「已到账」？——不在词表（到账≠到达），保持不算应答。

### 3. 互动摘要不再拼应答片段（`buildInteractionPayload` 的输入）
- 传给 `buildInteractionPayload` 的 `participantSourceQuotes` / `relatedQuotes` 先剔除 `isPureAcknowledgement`（含 Goal 2 到达通报、fix13 等待类）的片段；LLM 的 `interaction_summary` 照旧优先。
- 测试：quotes `['收到','明天上午10点开会带方案']` → summary 不含「收到」。

### 4. 引文也过 `stripParticipantPrefix`
- 证据构建时对 `relatedQuotes.text` 同样 `stripParticipantPrefix(fragment, participant)`；剥后为空 → 视为应答（被 Goal 3 一并剔除）。
- 测试：quotes `['集团市场部 小禾','广杂请示明天上午会议…']`（第二句被事项覆盖）→ 不出卡；quotes `['小禾：方案已发你']` → 剥后「方案已发你」→ 出卡。

### 5. 事项原文含省略号时拆段判覆盖（`isEvidenceCoveredByEvents`）
- 若事件 `source_quote` 含 `...`（三个及以上半角点）或 `…`：按其拆成若干段，取归一化后码点 ≥ 4 的段；**每一段都被片段包含** → 视为覆盖。无省略号走原逻辑。
- 测试：事项原文「原定于8月24日(周一)上午9:30...会议开场时间调整为当日上午9:00」，片段为完整长句 → 覆盖；只含其中一段 → 不覆盖。

### 6. 会议后勤类沟通不出互动卡（互动闸最后一步）
- 前置：本截图 `extraction.events` 中存在 `kind ∈ {meeting, appointment}` 的事件。经 Goal 2/3/4 剔除与 Goal 5 覆盖后**仍剩**的片段 R：若 R 每一条都「码点 ≤ 60 且含任一会议后勤词」→ 不出互动卡。
  `meetingLogisticsSignals = ['参会','参加','晚到','晚点','迟到','过来','过去','到会','开会','会议','会议室','办公室','谈完','等我','准时','散会','结束后','先谈']`。
- 无 meeting/appointment 事件的截图不启用本规则。
- 测试（虚构名）：①柏贝「郝总,我要晚一点参会,明早9点半,宓总跟我和张玲谈话,统战工作要求@」+「好的,收到」，同截图有会议 → 不出 ②郝明川三句（两句被覆盖 + 「你先谈完话,过来我办公室参加会议。」）→ 不出 ③王磊「方案已经发你，请查收」→ **出卡**（对照） ④同一句「我要晚一点参会」但截图无会议事件 → 出卡（规则未启用）⑤片段 > 60 码点含后勤词 → 出卡。

## 已否决 / 本批不做
- 用 `has_time_signal` 区分通知指令与变更信息：两条实证都是 false，分不开。
- 摘要里剔除被事项覆盖的公告片段：只剔应答，其余保留（避免摘要为空）。
- 「已到账／到期」等含「到」的非到达语：不入到达词表。
- 模型把昵称行当引文的根因（prompt）：不动 prompt，用 Goal 4 兜。

## Scope
- 可动：`shared/core/agent/propose.ts`、`server/src/tests/propose.test.ts`、`app/src/diagnostics/trace-store.ts`（**仅** `notice_routing` 项加可选 `reason` 字段）、其它测试/快照。
- 不可动：DB schema / migrations、`perceive.ts`、`prompts.ts`、`schemas.ts`、`execute.ts`、`resolve.ts`、`api.ts`、`batch-contacts.ts`、`compare.ts`、`app/**` 其它文件、fix1–fix13 已交付行为（Goal 2 明确推翻的那条除外）、`app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）
- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when
1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 233、app 不低于 177；`git diff --check` 干净
2. 六个 Goal 的测试组落地（Goal 2 含改旧测试并注明依据）
3. 报告 `docs/report-v3-m4-fix14.md`（与 fix13 报告同结构，含突变检查）贴真实测试输出、文件清单、偏离决定；只写本仓的事
