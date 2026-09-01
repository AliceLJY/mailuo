# 脉络 Mailuo — v3-M4-fix 施工交接（输出语言 + 事项详情装载）

## 你的角色

接 v3.1.0（`aa4f28f` + tag）。M4 六个 Goal 已全部真机验收，本批修真机暴露的两个缺陷，
都在感知 prompt 层。施工图 PLAN.md，先 `git log -3` 同步认知。自验用本机 Node 26。

## 真机实证（owner，OPPO，本地模式）

- ✅ 归并提速、事项独立成卡、查重、联系人关联全部生效
- ❌ **中文截图产出英文内容**：事项标题（如 "Arrange vehicle license plate and…"）与
  互动摘要（整段英文叙述）都是英文。感知 prompt 全文英文，模型生成概括性文字时跟随了
  prompt 语言；旧版会议标题多为照抄原文所以没暴露，M4 的事项标题与摘要靠模型概括，问题显形
- ❌ **事项详情为空**：一条通知消息里列了多点具体要求（材料怎么交、没有材料怎么办、
  哪几种情形分别怎么处理），事项卡只有概括标题，「事项详情」（agenda）空白。
  管道已核实无丢失（perceive schema → buildMeetingCard `if (event.agenda)` → 落库全通），
  是 prompt 未要求装载

## Goal

### 1. 输出语言跟随源内容

视觉版与文本版 prompt 一致加规则：**模型生成的自然语言字段（event.title、agenda、
interaction_summary、notes、facts 的概括性 value）语言必须跟随截图/文本的源语言**——
中文内容出中文，英文内容出英文，混合以主导语言为准。`source_quote` 照抄原文不受影响。

### 2. 事项详情装载

prompt 一致加规则：kind="other" 的事项，消息中的**具体要求、清单条目、操作说明、
截止方式**要写进 `agenda` 字段（可分条列出），不许只出概括标题。标题概括、详情装内容，
两者分工。仍然只装消息里写明的内容，不补推测（「宁可留空」原则不变）。

## Scope

- 可动：`shared/core/llm/prompts.ts`（两版感知 prompt）、prompt 快照、相关测试
- 不可动：其余一切——本批零代码逻辑改动；agenda 管道已通，不需要动 propose/execute
- 不新增依赖

## Constraints

- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push origin main
- prompt 快照改动前后各存一份，报告贴 diff（M3 惯例）
- 有边界疑问报 BLOCKED / NEEDS_CONTEXT

## Done when

1. 两端 `npm test` + `npx tsc --noEmit` 全绿
2. prompt 快照测试断言两版 prompt 均含语言跟随规则与 agenda 装载规则，且两版规则一致
3. 报告贴快照 diff、真实命令输出、文件清单
