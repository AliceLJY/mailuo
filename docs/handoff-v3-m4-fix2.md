# 脉络 Mailuo — v3-M4-fix2 施工交接（互动记录归纳 + 洞察每轮替换）

## 你的角色

接 v3.1.1（`11b1e57` + tag）。真机验收结论：事项模型、查重、备注累积、中文输出全部通过，
owner 评价「基本满足智能化」；本批修人脉侧最后两个体验缺陷。施工图 PLAN.md，
先 `git log -3` 同步认知。自验用本机 Node 26。

## 真机实证（owner，OPPO，本地模式）

- ❌ **互动记录像流水账不像归纳**：`propose.ts` `buildInteractionPayload` 的 fallback
  把 source_quotes、related quotes、「别名 XX」「职位 XX」全部 `join('；')` 硬拼——
  参与人缺 `interaction_summary` 时触发。真机样例：一条互动正文里混着两句原文引用
  加「别名 XX；职位 XX」字段变更信息
- ❌ **洞察无限堆积**：`insight.ts` 的 `dedupeInsightEntries` 只在本轮 drafts 内去重，
  从不与库中已有洞察比对，`insertInsights` 无条件追加。owner 多轮测试后单个联系人
  历史洞察 18 条，同一话头三轮几乎逐字重复，数日前的过时洞察与最新的并存

## Goal

### 1. 互动记录归纳

- **fallback 收窄**：`buildInteractionPayload` 的 summaryFragments fallback 中，
  剔除别名与 trackedContactFields 的字段变更行（它们已有 update_contact 卡承载，
  混进互动正文是噪音）；fallback 只保留原文引用类内容
- **prompt 层堵源头**（视觉版与文本版一致）：每个 participant 的 `interaction_summary`
  **必填**——一句概括本次互动的自然语言（语言跟随源内容，fix1 规则已覆盖）。
  参与人只有字段信息、无实际互动内容时，概括其信息来源场景即可，仍不许编造

### 2. 洞察每轮替换

洞察语义 = 基于当前档案的即时解读，是可再生的派生物；证据链在 observation（`based_on`），
旧洞察不是证据。因此：

- db 层新增按联系人删除洞察的最小接口（server `db.ts` 与 app `store.ts` 两端）
- `insight.ts` 编排改为**先生成、后替换**：某联系人本轮有新 drafts 时，
  在同一事务里删除其旧洞察再插入新的；**本轮无新产出（模型失败/空返回）时不删**，
  保留旧洞察优于清空
- 已有数据不需迁移：下轮生成时自然收敛

## Scope

- 可动：`shared/core/agent/propose.ts`（仅 buildInteractionPayload fallback）、
  `shared/core/agent/insight.ts`、`shared/core/llm/prompts.ts`、`server/src/db.ts` 与
  `app/src/local/store.ts`（仅新增删除洞察接口）、prompt 快照、测试
- **db 层放开口径（2026-09-01 补，回答 codex 的 NEEDS_CONTEXT）**：「删旧→插新」的原子性
  **首选新增组合接口**（如 `replaceInsightsForContacts`，内部单事务删旧+插新），
  已有 `insertInsights` 保持原样零改动；若组合接口路线有硬障碍，允许把 `insertInsights`
  改为事务感知，但要在报告里说明为什么组合接口走不通
- 不可动：数据库 schema（删数据不改结构）、卡片拆分与确认行为、M4 及 fix1 已交付行为、
  `/api/screenshots`
- 不新增依赖

## Constraints

- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push origin main
- prompt 快照前后各存一份，报告贴 diff
- 有边界疑问报 BLOCKED / NEEDS_CONTEXT

## Done when

1. 两端 `npm test` + `npx tsc --noEmit` 全绿
2. **互动归纳有测试**：构造缺 interaction_summary 的参与人 → fallback 产物不含别名/字段变更行；
   有 summary 的参与人行为不变
3. **洞察替换有测试**：同一联系人两轮生成 → 库中只剩第二轮的洞察（行数收敛）；
   模拟本轮空产出 → 旧洞察保留
4. prompt 快照测试断言两版均含 interaction_summary 必填规则
5. 报告贴真实输出、快照 diff、文件清单、偏离决定
