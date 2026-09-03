# 脉络 Mailuo — v3-M4-fix11 施工交接（纯应答互动卡：证据剥掉参与人昵称前缀再判）

## 你的角色

接 v3.1.10。本批只有一件小事，出自 **owner 直读 3.1.10 首批真机诊断包（2026-09-04 01:32 导出，`/tmp/diag5/`）**。
**纯 core 层一个判定函数 + 测试；不动 DB schema、不动 prompt、不动 app 层。** 施工图 PLAN.md（第 0 节适用），先 `git log -3` 同步认知。自验用本机 Node 26。

## 诊断包实证（v3.1.10，owner 直读）

- shot 1 参与人「沈青岚」（虚构名下同）唯一发言是「收到」，`interaction_summary` 为空，但 LLM 给的 `speech_act=initiate`（标错）。
  fix8 的 `speech_act !== 'respond'` 闸因此放行。
- fix6 的确定性闸 `propose.ts:1879`：`sourceEvidence = dedupeStrings([...participantSourceQuotes, ...relatedQuotes.map(q=>q.text)])`，
  要求 `every(isPureAcknowledgement)`。实证里 `sourceEvidence = ["集团市场部 沈青岚 收到", "收到"]`——第一段是 OCR 原行，
  **带群昵称前缀**（部门 + 姓名），`isPureAcknowledgement` 剥掉标点/空白/emoji 后仍是长串、不在词表 → `every` 失败 → 互动卡 #6
  「集团市场部 沈青岚 收到；收到」被提出（Alice 拒了）。**两道闸一道标错、一道被前缀骗过。**
- Alice 原话：「互动的话那个还是会有一条那个什么好的道之类的」。

## Goal

### 1. 纯应答判定前剥掉参与人自身昵称前缀（core）

- 新增纯函数 `stripParticipantPrefix(fragment, participant)`：若片段包含参与人 `name`（或其任一 `aliases`），取**最后一次出现之后**的子串
  （「集团市场部 沈青岚 收到」→「 收到」）；不包含则原样返回。只对 `participantSourceQuotes` 应用（`relatedQuotes.text` 是发言正文，本就干净，
  但一并应用无害）。
- `propose.ts:1879` 的判定改为 `sourceEvidence.map(f => stripParticipantPrefix(f, participant)).every(isPureAcknowledgement)`；
  剥前缀后为空串的片段视为纯应答（空 = 只有昵称行）。
- **不改** `isPureAcknowledgement` 词表、不改 `speech_act` 逻辑、不改 prompt。LLM 标错 `initiate` 时由本闸兜底即为设计。
- 测试（虚构名）：①`["集团市场部 小禾 收到","收到"]` → 不出互动卡 ②`["小禾 好的收到"]` → 不出 ③`["小禾 明天上午10点开会，大家准时","收到"]` → 照旧出卡
  ④ 片段里名字出现两次「小禾：@小禾 收到」→ 取最后一次之后 → 不出 ⑤ 无名字的普通证据不受影响（回归）。

## 已否决 / 本批不做

- 「speaker 的全部 quotes 均为纯应答即视为 respond」：quotes 是模型挑的「notable」引文、不一定是全部发言，单看 quotes 会误杀有发起内容的人。
- 同批 other 查重的时间门放宽 / 包含式相似度：3.1.10 实证里 shot 2 被拆成两条无日期、shot 3 合成一条带日期，**若查重生效会保留先出的无日期两张、砍掉带日期的**——「保留先出」在这种 split/merge 场景反而丢信息，改法要重想，本批不碰。
- 高鸡涛/高鸿涛 OCR 形近字：不可修；`review_out_of_order` 已让她能先看后文再定。

## Scope

- 可动：`shared/core/agent/propose.ts`（仅新增纯函数 + 第 1879 行判定处）、`server/src/tests/propose.test.ts`、测试快照（若有）。
- 不可动：DB schema / migrations、`prompts.ts`、`perceive.ts`、`resolve.ts`、`execute.ts`、`app/**`、`isPureAcknowledgement` 词表、fix1–fix10 已交付行为、`app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）

- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when

1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 197、app 不低于 171；`git diff --check` 干净
2. 上面五组测试
3. 报告贴真实测试输出、文件清单、偏离决定；只写本仓的事
