# 脉络 Mailuo — v3-M4-fix9 施工交接（同批事项查重 + 通知类同截图并入 + 路由决策入 trace）

## 你的角色

接 v3.1.8（fix7 三批 + fix8 四件，main 上另有 `e6e8642` 昵称保存 toast）。本批规则出自 **owner 直读 3.1.8 首批真机诊断包
（22 张卡 / 5 联系人 / 9 会议 / 6 截图 / 20 份 trace）并经 Alice 拍板**。**不动 DB schema、不做迁移。** 施工图 PLAN.md（第 0 节适用），
先 `git log -3` 同步认知。自验用本机 Node 26。

## 诊断包实证（v3.1.8，owner 直读）

- **「报备车」出了两张**：shot 2 卡 #10「报损备车及安排工作餐」/ shot 3 卡 #13「报备隋导车辆信息及安排工作餐」，都是
  `kind=other`、`time_text=明天上午`；两张的 `source_quote` 几乎逐字相同（「@X你和Y联系一下,给他报备明天上午过来集团开会的车牌号。
  中午给他打一份工作餐。」，仅 shot 2 的 OCR 把「报备」认成「报损」，一字之差），参与人一张是「我」一张是同一个人（shot 2 感知误判 is_self）。
  落库成两条 meetings。**成因 = 同一条消息跨了两张连续截图的重叠区**；连续截图有重叠是常态，每批都可能撞。同批 other 事项此前无任何查重
  （`findDuplicateMeeting` 只比已落库会议）。Alice 拍板：做。
- **通知类「通知海棠塔和隋导会议时间变更」被丢弃、没并入同截图的会议**：shot 1 同时感知出 `kind=meeting`「海棠塔剧场台作顶目的会议」
  （participant_names=[A, B, C, D]）与 `kind=other` 通知（has_time_signal=false、time_text 空、participant_names=[B, C]、
  source_quote「你们通知海棠塔和隋导这个时间。」）。`routeSpecialOtherEvents` 认出它是通知类，但 `findMeetingNoticeCandidate`
  第一分支标题相似度不够（「通知海棠塔和隋导会议时间变更」vs「海棠塔剧场台作顶目的会议」远低于 0.9），第二分支要求
  `meetingCalendarDay(notice) === day` 而 notice 无日期 → null → 直接 `return undefined` → 走分支③丢弃。**参与人明明有交集**。
  另：丢弃决策没进 trace（trace 的 `notices` 字段是 OCR 提示，不是路由决策），owner 从包里判不出它为何被丢。
- 已验证生效、本批不碰：fix8 Goal 1（所有 `speech_act=respond` 的参与人未出互动卡）、Goal 2 第二条（「会议参会人员确认」无时间未出卡）、
  fix7 批 C（`transition_start/done` 事件链通）；本批无闪退，`java-crashes/` 与 `exit-traces/` 均空。

## Goal

### 1. 同批 `kind=other` 事项查重（core + app；Alice 拍板「做」）

- 同一批上传（多张截图）内，后处理的截图提出 `create_meeting` 且 `payload.kind='other'` 时，与**本批先前截图已提出、当前仍 pending 的**
  `create_meeting(kind=other)` 卡比对：`normalizeContactText(source_quote)` 的 `normalizedEditSimilarity` **≥ 0.85**，且两者
  `time_text` 归一化后相同（或都为空）→ **不再提出第二张**（不出卡、不出 agenda_append）。**保留先出的那张**（两张都是缓解目标，
  用户确认一张即可；不做"择优"）。
- **判据用 `source_quote` 不用标题**——OCR 抖动让标题不可靠（报损／报备），原文却逐字近同。
- 只比同批、只比 pending；不与已落库 meetings 比（那是 `findDuplicateMeeting` 的事）；不扩到 `kind=meeting/appointment`。
  新一次上传（新 batch）不去重。
- 若 pending 那张已被用户 reject，本批后续再撞同句仍不出（reject = 用户不要这条）。
- 机制参考：本批 pending **联系人**已有同类通道——`app/src/local/batch-contacts.ts` 的 `LocalBatchContactSession`
  （`prepareScreenshot / commitScreenshot / listPendingContacts / reconcilePendingContacts`），`app/src/local/api.ts:206-410`
  是接线处。为 other 事项加一条同类的同批清单（把已提出的 other 卡 `{card_id, source_quote, time_text, status}` 随 batch session
  传入 `proposeCards`，或在 api.ts 提出前过滤）。**pending 卡本来就在 action_cards 表里**（`getStoredActionCardById`），不改 DB schema。
- trace 记 `batch_other_dedup: [{ title, matched_card_id, similarity }]`（`app/src/diagnostics/trace-store.ts` 的
  `DiagnosticsTraceSchema` 加**可选**字段）。
- 测试（虚构名）：①实证那对——「@小禾你和邬导联系一下,给他报损备明天上午过来集团开会的车牌号。中午给他打一份工作餐。」vs 同句「报备」版，
  第二张不出 ②同批两条不同 other（相似度 < 0.85）都出 ③同批一条 other 与一条 meeting 互不影响 ④跨 batch 不去重
  ⑤先出那张已 reject 后再撞同句仍不出。

### 2. 通知类：同截图内匹配放宽 + 路由决策入 trace（core + app；**Alice 2026-09-03 拍板「做吧」，与 Goal 1 同批**）

- `findMeetingNoticeCandidate` 第二分支放宽一种情况：notice 无可判日期（`meetingCalendarDay` 为 null）**且候选来自同一张截图的
  同批会议**时，只要参与人集合有交集且**候选唯一** → 视为命中（并入该会议卡自身 `agenda`，走既有分支②）。
  跨截图候选、已落库候选**仍要求同日**，不放宽。不加「标题关键词包含」兜底（YAGNI，等第二例）。
- 未匹配仍**丢弃**（分支③不变）——Alice 在 3.1.6 对这张卡的反应是「这不就是通知吗」并跳过，不回到出卡。
- 可观测性：`routeSpecialOtherEvents` 返回值增加
  `noticeRouting: [{ title, decision: 'stored' | 'batch' | 'dropped' | 'timeless_dropped', target_title? }]`；
  api.ts 写入 trace 新的可选字段 `notice_routing`；同时记黑匣子事件 `notice_routed`（detail：`decision=… title=…`，截 120 码点；
  `app/src/diagnostics/event-log.ts` 仅新增这一个事件种类）。
- 测试（虚构名）：①实证那对——同截图会议 + 无日期通知、参与人有交集 → 并入会议 agenda、不出 other 卡，trace 记 `batch`
  ②无参与人交集 → 仍丢弃，trace 记 `dropped` ③跨截图无日期 → 仍丢弃 ④同截图两个会议都有交集（候选不唯一）→ 仍丢弃。

## 已否决 / 本批不做

- 同批内联系人卡改名传播到后续引用卡（真机实例：联系人卡手改「高X涛」后，同批互动卡仍显示 OCR 原名）：Alice 未要求，另批。
- 本人昵称的 OCR 容错（真名被 OCR 认成形近字）：用设置页多昵称（逗号分隔）解决，零代码。
- 通知类未匹配时改为出普通 other 卡：见 Goal 2 第二条理由。
- 同批查重扩到 `kind=meeting/appointment`：落库查重已有，同批 meeting 重复本批未见实例。
- fix8 已否决项照旧（同批事项查重**以外**的：识别错别字别名过滤 / 确认页时间框 / 拍照时间锚定 / 有时间 other 归进展）。

## Scope

- 可动：`shared/core/agent/propose.ts`、`app/src/local/api.ts`、`app/src/local/batch-contacts.ts`（或新建同目录 `batch-*.ts`）、
  `app/src/diagnostics/trace-store.ts`（仅加可选字段）、`app/src/diagnostics/event-log.ts`（仅新增 `notice_routed`）、测试、快照。
- 不可动：DB schema / migrations、`resolve.ts`、`schemas.ts`、`execute.ts`、`perceive.ts`、`prompts.ts`、fix1–fix8 已交付行为、
  `app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）

- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when

1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 191、app 不低于 158；`git diff --check` 干净
2. Goal 1 五组测试；Goal 2 四组测试 + trace 字段 + 黑匣子事件
3. 报告贴真实测试输出、文件清单、偏离决定；只写本仓的事
