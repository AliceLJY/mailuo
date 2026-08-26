# 脉络 Mailuo — M3 施工交接（Expo RN app）

## 你的角色
继续担任施工工程师。施工图 `~/Projects/mailuo/PLAN.md`（§7 App 章节是本批主体）。后端 API 已全部就绪并经真调验收（M2 已关账），本批做 Expo RN 客户端 + 两个后端附带小项。发现施工图矛盾停下来说明。**自验一律用本机 Node 26。**

## Goal

### 主体：Expo app（`app/` 目录，按 PLAN §7）
1. **脚手架**：Expo SDK 57（与本机已有 Cobbler 项目同版本，经过验证）+ TypeScript + expo-router（tabs 布局）。依赖最小化：expo-image-picker 选图，不引 UI 组件库（RN 原生组件 + StyleSheet 手写），不引状态管理库（React 内置 state/context 够用）。
   - ⚠️ npm 11 默认拦截 install scripts（本机已实证）：expo 系依赖若因 postinstall 被拦导致装完不可用，按 npm 提示用 `npm install-scripts approve <pkg>` 放行对应包，把放行了哪些包写进交付说明。
2. **四个页面**：
   - **上传 tab**（index）：选图按钮（image-picker）+ 可选备注输入 + 提交；上传中全屏 loading 带文案（"AI 正在读图，约 20 秒…"）；完成后跳卡片确认页。
   - **卡片确认页**（/review/[screenshotId]）：卡片纵向列表。每张卡：类型徽标（新联系人/更新联系人/新会议/互动记录）+ confidence 色点（high 绿 / medium 黄 / low 灰）+ 关键字段展示且**可编辑**（TextInput 就地编辑）+ "依据原文"折叠区（source_quote）。
     - update_contact 卡：逐字段展示 `旧值 → 新值`；
     - create_meeting 卡：**time_text（原文）和 time_iso（解析结果）并排展示**，time_iso 可编辑——这是时间解析错误的人工兜底位，要显眼；
     - disambiguation 非空时：单选组「新建联系人 / 合并到 <候选名>（<公司>）」，选择结果作为 confirm 的 resolved_contact_id；
     - 底部按钮：确认 / 跳过（reject）。逐张处理，全部处理完自动进洞察结果页。
   - **洞察结果页**：确认响应里的 insights 渲染成卡片（kind 对应图标与中文标签：关系解读/建议行动/话头），每条带"依据"折叠（based_on 对应的 observation 内容，从 GET /api/contacts/:id 取或响应自带）；insight_status=failed 时显示温和的失败提示（"洞察生成没成功，档案已保存，下次确认时会再生成"）。
   - **人脉 tab**：联系人列表（名字/公司/最近互动时间/观测计数）→ 详情页：档案字段 + 观测时间线（kind 图标区分：事实/偏好/状态变化/互动）+ 历史洞察。
   - **日程 tab**：会议列表按时间排序，展示 title/time_text+time_iso/location/参与人。
3. **接线**：API 基址读 `EXPO_PUBLIC_API_URL`（app 目录 `.env` + `.env.example` 只含键名；开发时指向 MacBook 局域网 IP + server 端口，README 段落写清手机与电脑需同 WiFi）。统一 fetch 封装处理 `{ok,data}/{ok,error}` 信封与错误 toast。
4. **视觉基调**：微信绿系（#07C160 主色系）致敬使用场景，卡片圆角+轻阴影，中文文案，深浅色不强求（跟系统默认即可）。

### 附带后端两小项（M2 真调复验遗留，都是 prompt 层）
5. **会议定义收紧**：抽取 prompt 中 meeting/appointment 明确限定为"双方约定共同出席/通话的时点"；**单方交付承诺**（"明天把方案发你"）不算会议，归入 interaction 内容；会议 title 只允许取自原文语义，禁止编造（原文没提"讨论"就不要写"讨论内容合作"）。加一条 propose 单测：mock 单方交付承诺 event → 无 meeting 卡。
6. **当周日历锚点**：perceive prompt 的 current_datetime 注入扩为一小段日历锚点（"今天是 YYYY-MM-DD 星期X；本周三是 M-D；下周三是 M-D"，代码算好喂给模型，不让模型自己算星期），治"下周三"稳定错两天的问题。加单测断言 prompt 文本含锚点字段。

## Scope
`app/`（主体）+ `server/src/llm/prompts.ts`、`server/src/agent/propose.ts`（附带两项）+ 对应测试 + 根 README 暂不动（M4 写）。不动 server 其他逻辑、不动 fixtures 图。

## Constraints
- PLAN §0 全部适用；Simplicity First——app 不做动画、不做下拉刷新之外的手势、不做离线缓存（Future work）。
- app 代码 `npx tsc --noEmit` 必须过；组件文件 ≤ 300 行，超了拆。
- 中文 commit message，自验全绿才 commit，本批一个 commit。

## Done when（逐条跑，贴真实输出）
1. `cd app && npx tsc --noEmit` 零报错；
2. `cd server && npm test` 全绿（含第 5、6 项新增单测）且 `npx tsc --noEmit` 零报错；
3. `cd app && npx expo start` 能正常启动（贴出启动横幅；跑通即可 Ctrl+C，真机扫码验收由 owner 和用户做）；
4. `git log --oneline -1` 有本批 commit；
5. 列出 app 页面文件清单 + 你放行过的 install-scripts 包清单（若有）。
完成后照旧：逐条贴实际输出、列文件清单、说明偏离施工图的决定及理由。真机双端验收（iPhone + OPPO 的 Expo Go）由 owner 组织，不是你的自验项。
