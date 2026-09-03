# 脉络 v3-M4-fix11 施工报告

日期：2026-09-04

施工基线：`main @ ff8f482`

## 施工前闸门

- 已通读任务书 `docs/handoff-v3-m4-fix11.md` 与 `PLAN.md` 第 0 节；`git log -3` 确认基线为 `ff8f482`（fix11 交接文档本身），其前一提交 `0f050df` 为版本 3.1.10（fix10 已交付）。
- 定位判定点：`shared/core/agent/propose.ts:1879` 的 `sourceEvidence.every(isPureAcknowledgement)`；确认该分支所在循环变量为 `candidate`（`interactionCandidates` 的 value），而非任务书示例代码里写的 `participant`——`participant` 是更早一个循环（构建 `interactionCandidates` 时）的局部变量，在判定点所在循环里已不在作用域内，`candidate` 只携带 `participantName: string`，不携带 `aliases`。见下方「偏离与决定」。
- 确认 `ProposeParticipant`/`PerceptionParticipantSchema` 的 `name` 必填、`aliases` 可选数组；`isPureAcknowledgement` 与其噪声正则 `acknowledgementNoisePattern`、白名单 `pureAcknowledgementTexts` 均未改动。
- 闸门结论：PASS，无需 `NEEDS_CONTEXT`。

## 交付结果

### 纯函数 `stripParticipantPrefix`

- 新增于 `shared/core/agent/propose.ts`，紧跟 `isPureAcknowledgement` 之后（不改后者一行）。签名 `stripParticipantPrefix(fragment: string, participant: { name: string; aliases?: string[] }): string`。
- 逻辑：对 `[participant.name, ...(participant.aliases ?? [])]` 中每个非空标识符，找片段内**最后一次出现**的位置；若该次出现之后紧跟一个分隔符（标点或空白，复用 Unicode 属性 `\p{P}`/`\p{White_Space}`，与本文件既有噪声正则同一套字符类概念但另建常量、不改 `isPureAcknowledgement` 本体），才把这次出现计为可裁剪的前缀边界；取所有合法边界里最靠右的一个，返回该边界之后的子串；找不到任何合法边界则原样返回。
- **与任务书字面描述的差异（必要的纠正，非扩大范围）**：任务书原描述是"若片段包含参与人 name/aliases，取最后一次出现之后的子串"，不含分隔符限定。按此字面实现后，`npm test` 在 server 端暴露 2 个真实回归（细节见「偏离与决定」），根因是 `isPureAcknowledgement` 自身「≤2 码点即视为纯应答」的宽松判据只在**整条原始证据**上安全，一旦无条件裁掉参与人姓名，残余文本可能意外落到 ≤2 码点从而被误判。已用"裁剪边界后必须紧跟分隔符"这一条件堵住该缺口，纯函数本身仍是无副作用的纯函数，未改 `isPureAcknowledgement` 词表或逻辑一个字符。

### 判定点改造（`propose.ts:1879` 附近）

- 原：`if (sourceEvidence.length > 0 && sourceEvidence.every(isPureAcknowledgement))`。
- 新：对 `sourceEvidence`（`participantSourceQuotes` 与 `relatedQuotes.text` 去重合并后的数组）先 `.map((fragment) => stripParticipantPrefix(fragment, { name: candidate.participantName }))`，再 `.every(isPureAcknowledgement)`；`continue` 分支逻辑不变。
- 只对该数组整体做 `.map`，与任务书给出的代码形状一致（对 `relatedQuotes.text` 一并应用；由于发言正文通常不含说话人自己的姓名前缀，该函数会原样返回，属无害应用）。

## 五组测试（`server/src/tests/propose.test.ts`，紧接既有 acknowledgement 相关测试之后）

1. `proposeCards omits an interaction when acknowledgement evidence carries a department-plus-name prefix` —— `["集团市场部 小禾 收到","收到"]`（同一人两条证据经 `same_as` 合并），断言 `proposeCards(...)` 结果为 `[]`。
2. `proposeCards omits an interaction when an acknowledgement follows a bare name prefix` —— 单条证据 `"小禾 好的收到"`，断言结果为 `[]`。
3. `proposeCards keeps an interaction when a name-prefixed message still carries substantive content` —— `["小禾 明天上午10点开会，大家准时","收到"]`，断言仍能取到 `record_interaction` 卡（回归：有实质内容时不受本次改动影响）。
4. `proposeCards strips the prefix up to the last occurrence when the participant name repeats in a fragment` —— 单条证据 `"小禾：@小禾 收到"`（姓名出现两次），断言结果为 `[]`（验证裁剪点是最后一次出现之后，而非第一次）。
5. `proposeCards leaves ordinary acknowledgement evidence without a name prefix unaffected` —— `["收到！","好的"]`（证据中不含参与人姓名），断言结果为 `[]`（回归：无姓名前缀时行为与 fix11 之前一致）。

以上 5 组连同两个被本次改动一度破坏、随后修复复核通过的既有保护性测试（见下）已在实际测试输出中逐条核对为 `✔`。

## 施工中发现并处理的回归（现场诊断记录）

按任务书字面算法首次实现后，`cd server && npm test` 从 exit 0 变为 exit 1，2 个既有测试失败：

- `test at src/tests/app.test.ts:6:18540` → `POST /api/screenshots keeps interaction cards while only high-confidence progress creates a meeting update`：参与人"荀导"的证据 `"荀导已到"`，姓名在片段开头、紧跟无分隔符的 `"已到"`（2 码点）。无条件裁剪会切出 `"已到"`，命中 `isPureAcknowledgement` 的 `≤2 码点` 分支被误判为纯应答，导致本应保留的 `record_interaction` 卡消失。
- `test at src/tests/propose.test.ts:1:60060` → `proposeCards creates create_contact cards for new and unsure participants and links pending interactions by name`：参与人"王磊"的证据 `"我是星火科技的市场总监王磊"`（自我介绍，姓名恰好在句尾、其后无任何字符）。无条件裁剪会裁到姓名结尾即字符串末尾，产出空串，命中「空串视为纯应答」的字面描述，导致整句自我介绍被误判为纯应答，`record_interaction` 卡消失。

两者共同指向同一根因：任务书描述的"无条件裁到最后一次姓名出现之后"对"姓名是消息语义内容本身（自我介绍句尾、姓名+短状态谓语）"和"姓名是 OCR 标签前缀（部门+姓名+空白+正文）"两种结构无法区分。改为"裁剪边界必须紧跟分隔符"后，两个失败测试与新增 5 组测试同时通过，`cd server && npm test` 回到 exit 0（202/202）。

## 真实测试输出

### server

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npm test`

```text
ℹ tests 202
ℹ suites 0
ℹ pass 202
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 517.303208
```

门槛：`202 >= 197`。（施工前基线：197/197/0，与任务书标注一致。）

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### app

命令：`cd /Users/anxianjingya/Projects/mailuo/app && npm test`

```text
ℹ tests 171
ℹ suites 0
ℹ pass 171
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 570.976125
```

门槛：`171 >= 171`。（app 未改动，测试数与施工前基线一致。）

命令：`cd /Users/anxianjingya/Projects/mailuo/app && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### 工作树检查

命令：`git -C /Users/anxianjingya/Projects/mailuo diff --check`

```text
(无标准输出，exit 0)
```

## 文件清单

- `shared/core/agent/propose.ts`（新增 `stripParticipantPrefix` 纯函数 + 一个模块级分隔符正则常量；改判定点为先 `.map` 再 `.every`）
- `server/src/tests/propose.test.ts`（新增 5 个 `test(...)`，均插在既有 acknowledgement 相关测试之后，未改动任何既有测试）
- `docs/report-v3-m4-fix11.md`（本报告）

## 偏离与决定

1. **调用点用 `{ name: candidate.participantName }` 而非携带 `aliases` 的完整参与人对象**——任务书 Goal 1 描述纯函数支持"name 或其任一 aliases"，但判定点所在循环的可用变量是 `candidate`（`interactionCandidates` 的 value），其结构里只保存了 `participantName: string`，未保存 `aliases`。要把 `aliases` 传到这里，需要在更早的候选人构建处（约 1727–1784 行）给 `interactionCandidates` 的 value 类型新增字段并在两处写入点回填，这超出任务书 Scope 明确写的"仅新增纯函数 + 第 1879 行判定处"。诊断包实证与 5 组必测用例全部只涉及 `participant.name`（部门+姓名、裸姓名前缀、重复姓名），不涉及别名场景，因此判定：纯函数本体按 spec 同时支持 `aliases`（面向未来复用与可能的直接单测），但当前唯一调用点只传 `name`，不扩大改动面。若未来诊断出别名前缀场景，需要另行给 `interactionCandidates` 加字段。
2. **纯函数新增"裁剪边界须紧跟分隔符"的限定，未见于任务书字面描述**——原因见上文「施工中发现并处理的回归」。这不是对 Goal 1 意图的偏离（部门+姓名+空白+正文、裸姓名+空白+正文、重复姓名+空白+正文三种诊断场景全部满足"紧跟分隔符"），而是对任务书未覆盖的两个边界（姓名即语义内容本身）补的必要约束，两个既有保护性测试因此从失败恢复为通过，且未修改这两个测试的任何断言或它们所属的 fix1–fix10 行为。
3. **未改 `isPureAcknowledgement` 词表、`speech_act` 逻辑、prompt、DB schema、`perceive.ts`/`resolve.ts`/`execute.ts`、`app/**`、`app/app.json` 版本号、依赖**——按任务书 Scope/Constraints 逐条核对，`git diff --stat` 只显示 `shared/core/agent/propose.ts` 与 `server/src/tests/propose.test.ts` 两个文件改动，与声明的可动范围一致。
4. **未涉及"已否决"事项**——speaker 全部 quotes 均为纯应答即判 respond、other 查重时间门放宽、高鸡涛/高鸿涛 OCR 形近字，均未触碰。
5. 测试数据全部使用虚构名（小禾、集团市场部）；报告与代码注释中不含任何真实姓名或机构名。
