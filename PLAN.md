# 脉络 Mailuo — 设计文档（PLAN）

> 聊天截图 → 结构化行动卡片 → 按人头建档 → 关系洞察。
> 一道 48 小时面试题的完整复刻：多端 app（Expo RN，iPhone + Android 双跑）+ agent 后端（mini 部署）。
> 本文档是唯一施工真相源。执行者（codex）按里程碑推进，每个里程碑有可跑的验收命令。

---

## 0. 任务信封

**Goal**：做一个 agent 产品（不是 API 套壳）：用户上传聊天截图（可附补充文字），系统理解上下文，生成可确认的 action cards（创建会议 / 创建联系人 / 更新联系人）；用户确认后，结合联系人历史档案生成洞察和建议。交付：可跑的 app + 后端 + GitHub repo + 部署好的测试环境。

**Scope**：本仓库 `~/Projects/mailuo/` 全部；部署目标 mini（launchd + tailscale serve）。

**Constraints**：
- 客户端 Expo RN（SDK 57，与 Cobbler 同版本，减少踩坑面）；验证设备 = Alice 的 iPhone Air + OPPO Find N6，都跑 Expo Go，两台都在 tailnet。
- 后端 Node 22 + TypeScript + Fastify + better-sqlite3。单用户，无鉴权系统（部署在 tailnet 内，tailscale 即边界；预留 `X-Api-Key` 简单校验一层）。
- LLM：视觉抽取走 **qwen-vl-max**（dashscope），文本推理/洞察走 **deepseek-v4-flash**。key 从环境变量读：`DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`——**代码与文档中绝不出现真值**，部署时由 owner 注入。provider 层抽象，可替换。
- 全部数据存 mini 本地 SQLite。截图文件存本地磁盘 `server/data/screenshots/`。隐私边界如实写进 README：截图会发往 qwen/deepseek API 做推理，此外不出本机。
- 禁止引入重依赖（ORM / 消息队列 / Redis 都不要）。Simplicity First：能一个文件解决的不建目录。

**Done when（总验收）**：三张测试截图各自跑通全链路（上传→卡片→确认→档案→洞察），app 在两台手机 Expo Go 可用，后端 mini 常驻 + tailnet 可达，repo 推 GitHub，README 含架构说明。

---

## 1. 为什么不是套壳（架构叙事，README 要用）

套壳 = 截图发给多模态模型、返回一段文字。本项目的 agent 结构：

```
感知 → 提议 → 人确认 → 执行 → 基于累积状态生成洞察
 ↑                                    ↓
 └────────── 档案（memory）越用越厚 ──────┘
```

三个"不是套壳"的证据点：
1. **结构化行动而非文本**：抽取产物是带 schema 的 action cards，可编辑、可执行、有置信度、有原文依据（source_quote）。
2. **Entity resolution + 越用越准的 memory**：新截图里的人要和已有档案归并（"王总" vs "老王" vs 微信昵称），拿不准时交给用户裁决，裁决结果写回别名表——系统在学习。
3. **洞察 grounded 在档案上**：每条洞察必须引用它依据的观测记录（based_on），不允许无根据生成。

## 2. Memory 设计（题眼，README 单独一节）

三层结构，对应认知科学的 Atkinson-Shiffrin 三阶段（感觉记忆 → 工作记忆 → 长期记忆）：

| 层 | 表 | 生命周期 | 类比 |
|---|---|---|---|
| 感觉层 | Screenshot + raw_extraction | 用完可弃（保留仅为溯源） | 感觉记忆 |
| 工作层 | ActionCard（pending） | 等待用户确认，确认/拒绝后归档 | 工作记忆 |
| 长期层 | Contact + Observation + Meeting | 持久，按人头累积 | 长期记忆 |

长期层内部再分两种更新语义：
- **档案字段（Contact 的结构化列）**：慢变、走确认覆盖。新截图说"换公司了"→ update_contact 卡片 → 用户确认 → 字段更新，旧值自动写入 Observation（kind=status_change）留痕。
- **观测流水（Observation）**：只追加、不修改。每条是一个原子事实 + 截图原文锚点 + 时间。

洞察生成时把两层都喂给 LLM：结构化字段给"这个人是谁"，观测时间线给"关系怎么演变的"。

## 3. 数据模型（SQLite schema）

```sql
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL,        -- 主名
  aliases TEXT NOT NULL DEFAULT '[]',  -- JSON 数组：微信昵称/备注名/群昵称
  company TEXT, title TEXT, phone TEXT, wechat_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',     -- JSON 数组
  notes TEXT,                          -- 自由备注
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE screenshots (
  id INTEGER PRIMARY KEY,
  image_path TEXT NOT NULL,
  user_note TEXT,                      -- 上传时附的补充文字
  raw_extraction TEXT,                 -- 感知层原始 JSON（溯源用）
  uploaded_at TEXT NOT NULL
);

CREATE TABLE action_cards (
  id INTEGER PRIMARY KEY,
  screenshot_id INTEGER NOT NULL REFERENCES screenshots(id),
  type TEXT NOT NULL CHECK(type IN ('create_contact','update_contact','create_meeting')),
  payload TEXT NOT NULL,               -- JSON，schema 见 §5
  confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),  -- 离散三档，不用连续分数
  source_quote TEXT NOT NULL,          -- 截图里支撑这张卡的原文
  disambiguation TEXT,                 -- JSON | null：entity resolution 拿不准时的候选列表
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
  resolved_contact_id INTEGER REFERENCES contacts(id),  -- 执行后回填
  created_at TEXT NOT NULL, resolved_at TEXT
);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  screenshot_id INTEGER REFERENCES screenshots(id),
  kind TEXT NOT NULL CHECK(kind IN ('fact','preference','status_change','interaction')),
  content TEXT NOT NULL,               -- 原子事实，一条一件事
  source_quote TEXT,                   -- 截图原文锚点
  observed_at TEXT NOT NULL
);

CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  time_iso TEXT,                       -- 解析后的 ISO 时间（可能为 null：解析失败时保留原文）
  time_text TEXT NOT NULL,             -- 截图原文的时间表述（"下周三下午三点"）
  location TEXT,
  participant_ids TEXT NOT NULL DEFAULT '[]',  -- JSON 数组 of contact_id
  agenda TEXT,
  source_screenshot_id INTEGER REFERENCES screenshots(id),
  status TEXT NOT NULL DEFAULT 'upcoming',
  created_at TEXT NOT NULL
);

CREATE TABLE insights (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  kind TEXT NOT NULL CHECK(kind IN ('relationship_read','suggested_action','conversation_hook')),
  content TEXT NOT NULL,
  based_on TEXT NOT NULL DEFAULT '[]', -- JSON 数组 of observation_id（grounding 证据）
  generated_at TEXT NOT NULL
);
```

设计要点：
- confidence 用 **high/medium/low 离散三档**（连续分数会坍缩取中，Alice 库里已有实证结论）。
- JSON 列用 TEXT 存 + 应用层解析，不上 ORM。
- 时间解析失败不是错误：`time_iso` 可空，`time_text` 永远保留原文，用户在卡片上手改。

## 4. Agent 流水线（后端 `server/src/agent/`）

```
POST /api/screenshots
  → [1 perceive]  qwen-vl-max：截图+用户备注 → 结构化抽取 JSON
                  { participants:[{name, said_or_mentioned}], events:[], facts:[], quotes:[] }
                  prompt 里注入 current_datetime（时区 Asia/Shanghai），让模型把相对时间
                  （"下周三下午三点"）直接解析为 ISO，同时保留原文。
  → [2 resolve]   每个 participant 做 entity resolution：
                  a. 精确匹配 canonical_name / aliases（大小写与空白归一）
                  b. 未命中 → 取库内全部联系人的 (name, aliases, company) 摘要 +
                     新人名+上下文，交给 deepseek 判：same_as:<id> / new / unsure(候选列表)
                  c. unsure → 卡片带 disambiguation 候选，让用户裁决
  → [3 propose]   抽取结果 → action cards（三类），每张带 confidence + source_quote。
                  规则：库里没有的人 → create_contact；已有的人出现字段变化 → update_contact
                  （payload 里带 {field: {old, new}}）；约定/会议 → create_meeting。
  → 返回 { screenshot_id, cards: [...] }（同步，10-30s，app 端转圈）

POST /api/cards/:id/confirm   （body 可带用户编辑后的 payload / 裁决后的 contact_id）
  → [4 execute]   写库：create_contact 建档（把截图里出现的称呼进 aliases）；
                  update_contact 更新字段 + 旧值写 Observation(status_change)；
                  create_meeting 落 meetings 表。
                  所有卡片确认时，本次截图相关事实写入 observations。
                  用户对 disambiguation 的裁决（合并到 X）→ 新称呼追加进 X 的 aliases。
  → [5 insight]   对本次涉及的每个 contact：档案全量（字段 + observation 时间线 +
                  近期 insights 摘要）+ 本次新增 → deepseek → 1-3 条洞察，
                  每条必须给 based_on（引用 observation id），给不出依据的丢弃。
  → 返回 { executed: true, insights: [...] }（同步生成，3-10s 可接受）

POST /api/cards/:id/reject → status=rejected，不产生任何写入
```

Prompt 纪律（`server/src/llm/prompts.ts` 集中管理）：
- 全部要求 JSON 输出 + zod 校验，校验失败重试一次（带上错误信息），再失败返回明确报错，不静默吞。
- 抽取 prompt 明确"只抽截图里有的，禁止推测补全"；洞察 prompt 明确"每条给依据，给不出就少说"。

## 5. ActionCard payload schema（shared/types.ts，前后端共享）

```ts
type CreateContactPayload = {
  name: string; aliases?: string[]; company?: string; title?: string;
  phone?: string; wechat_id?: string; notes?: string;
};
type UpdateContactPayload = {
  contact_id: number; contact_name: string;      // 冗余名字方便 UI 展示
  changes: Record<string, { old: string | null; new: string }>;
};
type CreateMeetingPayload = {
  title: string; time_iso: string | null; time_text: string;
  location?: string;
  participants: Array<{ contact_id?: number; name: string }>;  // 可能含未建档的人
  agenda?: string;
};
```

## 6. API 一览

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /api/screenshots | multipart 上传（image + note），返回 cards |
| POST | /api/cards/:id/confirm | 确认（可带编辑后 payload），返回 insights |
| POST | /api/cards/:id/reject | 拒绝 |
| GET | /api/contacts | 列表（含各自 observation 计数、最近互动时间） |
| GET | /api/contacts/:id | 档案全貌：字段 + observations 时间线 + insights |
| GET | /api/meetings | 会议列表（按时间） |
| GET | /api/screenshots/:id | 溯源：原图 + raw_extraction + 关联卡片 |
| GET | /api/health | 健康检查（launchd/监控用） |

所有响应 `{ ok: true, data }` / `{ ok: false, error }` 统一信封。

## 7. App（Expo RN，expo-router tabs）

三个 tab + 一个流程页：
1. **上传**（index）：选图（expo-image-picker）+ 备注输入框 + 提交；转圈期间展示"AI 正在读图…"。完成后直接进卡片确认流程页。
2. **卡片确认页**（/review/[screenshotId]）：卡片纵向列表，每张：类型徽标 + confidence 色点（绿/黄/灰）+ 字段（可编辑）+ source_quote（折叠展示"依据原文"）+ disambiguation 单选（"这是新联系人 / 合并到 王总"）。底部逐张 确认/跳过。全部处理完展示 insights 结果页（洞察卡片，含"依据"折叠）。
3. **人脉**（contacts）：列表 → 详情页（档案字段 + 观测时间线 + 洞察历史）。
4. **日程**（meetings）：即将到来的会议列表。

UI 基调：微信绿系配色致敬场景，卡片圆角阴影，不引 UI 库（RN 原生组件 + StyleSheet 手写），中文文案。BASE_URL 从 `EXPO_PUBLIC_API_URL` 读。

## 8. 里程碑与验收（codex 按此分批交付）

**M1 后端骨架 + 感知链路**
- 内容：项目脚手架（monorepo：server/ app/ shared/）、DB schema + migration、LLM provider（qwen/deepseek 封装 + zod 校验）、perceive + propose（先不做 resolve，全部当新人）、POST /api/screenshots 可用。
- 验收：`cd server && npm test`（schema + propose 单测，LLM 层用 fixture mock）；
  `npm run cli -- extract ../fixtures/screenshot-1.png` 输出合法 cards JSON（真调 qwen，人工看合理性）。

**M2 完整 agent 环**
- 内容：resolve（含 disambiguation）、confirm/execute、insight 生成、其余 API。
- 验收：`npm run cli -- e2e ../fixtures/screenshot-2.png` 走完 上传→自动确认→洞察 全链路；单测覆盖 execute 的三种卡片类型 + status_change 留痕 + 别名回写。

**M3 App MVP**
- 内容：四个页面 + API 对接 + loading/error 态。
- 验收：`npx tsc --noEmit` 过；Expo Go 在两台手机连 MacBook 开发服务器跑通全流程（人工验收，Alice 参与）。

**M4 部署 + 交付面**
- 内容：mini launchd plist（`com.alice.mailuo-server`）+ tailscale serve 暴露 + 部署脚本 `deploy/install.sh`；README（架构图 + agent 环说明 + memory 三层 + demo 截图/GIF + 隐私边界 + Future work）；三张测试截图 fixtures 入仓。
- 验收：手机（蜂窝网/非家庭 WiFi）Expo Go 走通全流程；`curl https://mac-mini.tail791fb9.ts.net:<port>/api/health` 返回 ok；repo 推 GitHub（可见性由 Alice 定）。

**明说不做（Future work，写进 README 防止被当遗漏）**：系统日历集成、消息 App 直连、多用户与鉴权体系、iOS 独立安装包（EAS iOS 构建需 Apple Developer 账号）、群聊多人复杂场景的深度优化、洞察定时主动推送。

## 9. 测试素材（fixtures/）

三张**合成**的微信风格聊天截图（用 HTML 渲染截屏制作，不用真实聊天记录，隐私红线）：
1. `screenshot-1.png` 单聊约会议：对方提出"下周三下午 3 点来我们公司聊合作"→ 应产出 create_meeting + （若李姐未建档）create_contact。
2. `screenshot-2.png` 新联系人自我介绍：名片式开场"我是 XX 公司的市场总监王磊，电话 138…"→ create_contact（字段齐全，high confidence）。
3. `screenshot-3.png` 老联系人状态变化：已建档的人说"我上个月跳槽去了 YY 公司"→ update_contact（company: {old, new}）+ 洞察应能引用这次变化。
配套 `fixtures/seed.sql`：预置 1-2 个联系人（覆盖 screenshot-3 的"老联系人"前提与 resolve 的模糊匹配场景）。

## 10. 风险与取舍（有意为之，别当 bug 修）

- 时间解析交给 LLM + 用户确认兜底，不引入 NLP 时间库——48h 项目里用户确认就是最好的纠错层。
- 洞察同步生成（confirm 响应 3-10s）——不上队列，简单优先；README 的 Future work 提异步化方向。
- 单用户无登录——tailnet 即边界 + 简单 API key。这是个人工具的合理安全模型，README 说明。
- Expo Go 而非独立安装包——开发/演示的正确形态；独立包是 Future work（Android APK 走 EAS 已有先例可随时出，iOS 需 $99 账号）。
- `# simplified:` 注释规约——凡有意简化处标注天花板与升级路径。

## 11. 执行与协作方式

- **owner**：CC（Fable）——设计、验收、卡点裁决；**执行**：codex（`codex-run.sh` 后台跑，写入类带 cwd + Done Gate）；**验收人**：Alice（真机体验 + 面试官视角）。
- codex 每个里程碑一个批次；批次内自跑验收命令，产物落盘后 owner 核对（只信落盘证据）。
- commit 纪律：每里程碑至少一个 commit，中文 message；未过验收不 commit。
- repo：暂本地，M4 时推 GitHub `AliceLJY/mailuo`（可见性届时由 Alice 定，倾向先 private 成品后转 public）。
