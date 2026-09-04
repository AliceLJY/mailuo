# 脉络 Mailuo — v3-M4-fix16 施工交接（已确认的会议 / 联系人可编辑、可删除）

## 你的角色

接 v3.1.14 + fix15（已跳过卡可恢复、确认时间友好显示）。本批是**新功能**，出自 Alice 对 3.1.14 的反馈「确认了的想修改呢」——代码事实：`RoutedApi` 写操作只有确认／跳过／恢复，**日程页是纯列表、人脉详情页是纯只读**，已确认的会议和联系人在 app 里改不了也删不了。
**不动 DB schema / 不做迁移**（编辑用现有列；删除靠事务内按顺序删子表，`PRAGMA foreign_keys = ON` 已开启）。不动 prompt / perceive.ts / propose.ts / resolve.ts / execute.ts。施工图 PLAN.md（第 0 节适用），先 `git log -3` 同步认知。自验用本机 Node 26。

## 数据层事实（owner 核过 file:line）

- `app/src/local/store.ts`：已有 `createContact`(595) / `updateContactFields`(676) / `insertMeeting`(853) / `updateMeeting(meetingId, input: MeetingWriteInput)`(908)——它们在 `ExecuteDatabase` 侧、**未暴露在 `LocalStore` 接口**（`app/src/local/types.ts`）里；**没有任何 delete 方法**。
- `shared/core/schema.ts`：`meetings(id,title,time_iso,time_text,location,participants JSON,agenda,source_screenshot_id,status,created_at)`；`observations.contact_id NOT NULL REFERENCES contacts`、`insights.contact_id NOT NULL REFERENCES contacts`、`action_cards.resolved_contact_id REFERENCES contacts`——**都没有 ON DELETE**；`store.ts:208` `PRAGMA foreign_keys = ON`。
- 页面：`app/app/(tabs)/meetings.tsx`（147 行，纯列表，无详情路由）；`app/app/contacts/[id].tsx`（193 行，只读 `MetaLine`）；`app/app/_layout.tsx:167-180` 注册 Stack.Screen，已有 `contacts/[id]`，**没有** `meetings/[id]`。
- server 路由（`server/src/app.ts`）只有 get / confirm / reject；本批 **server 模式一律占位报「服务器模式暂不支持」**（与 `readDiagnosticsSnapshot` 同款），不动 `server/src`。

## Goal

### 1. 接口层：四个写操作（app）
- `RoutedApi`（`app/src/connection/dispatch.ts`）新增：`updateMeeting(id, patch: MeetingEditPatch): Promise<{ meeting: MeetingRecord }>`、`deleteMeeting(id): Promise<void>`、`updateContact(id, patch: ContactEditPatch): Promise<{ contact: ContactDetail }>`、`deleteContact(id): Promise<void>`。
  `MeetingEditPatch = { title?, time_text?, time_iso?: string|null, location?: string|null, agenda?: string|null, participants?: { name: string; contact_id?: number }[] }`；`ContactEditPatch = { canonical_name?, company?, title?, phone?, wechat_id?, notes?, aliases?: string[], tags?: string[] }`（都是 `string | null` 语义按现有列）。
- `LocalStore` 接口补 `updateMeeting` / `updateContactFields`（暴露既有实现，**不重写**）+ 新增 `deleteMeeting(id): boolean`、`deleteContact(id): boolean`。
  `deleteContact` 在**一个事务**内按序：`DELETE FROM insights WHERE contact_id=?` → `DELETE FROM observations WHERE contact_id=?` → `UPDATE action_cards SET resolved_contact_id=NULL WHERE resolved_contact_id=?` → 遍历 `meetings.participants` JSON，把 `contact_id === id` 的项去掉 `contact_id`（保留 name）→ `DELETE FROM contacts WHERE id=?`。返回是否删到。`deleteMeeting` 直接删（无 FK 指向 meetings；`agenda_append` 卡的 `duplicate_of_meeting_id` 在 payload JSON 里，执行时已有「Meeting X does not exist」守卫，不需额外处理）。
- 本地实现 `app/src/local/api.ts`：校验（标题非空、`time_iso` 若非空须为合法 ISO、`canonical_name` 非空且不为「我」、参与人名非空——沿用 fix12 的空名过滤）→ 调 store → 记黑匣子事件 `meeting_edited` / `meeting_deleted` / `contact_edited` / `contact_deleted`（`event-log.ts` 仅新增这四种，detail `id=…`）。server 实现 `app/src/api.ts` 四个占位。
- 测试（store + api）：①updateMeeting 改 title/time_iso/agenda/participants 后 `listMeetings` 反映 ②deleteMeeting 后列表消失、再删返回 false ③deleteContact 级联：其 observations / insights 消失、`action_cards.resolved_contact_id` 置空、会议参与人保留 name 去掉 contact_id、外键开启下不抛 ④updateContact 改 canonical_name / aliases / company 后 `getContactDetail` 反映；`canonical_name=「我」` 被拒 ⑤api 校验：空标题 / 非法 ISO 被拒并给中文错误。

### 2. 会议详情 + 编辑页（app）
- 新路由 `app/app/meetings/[id].tsx`（`_layout.tsx` 注册 `<Stack.Screen name="meetings/[id]" options={{ title: "会议详情" }} />`）：顶部只读摘要（标题 / `formatConfirmTime(time_iso, time_text)` / 地点 / 参与人 / 议程），下方「编辑」切换为表单——复用 `review-fields.tsx` 的 `FieldInput`（标题、聊天里的时间、确认时间〔沿用 fix15 友好显示 + 多行 ISO〕、地点、议程多行、参与人按行编辑，清空即移除、参与人可为零）→「保存」→ `updateMeeting` → toast「已保存」→ 回到只读态；「删除这条会议」→ `Alert.alert` 二次确认 → `deleteMeeting` → toast → `router.back()`。
- `(tabs)/meetings.tsx` 列表项改为可点（`Pressable`）→ `router.push(\`/meetings/${id}\`)`；返回后列表 `loadMeetings("refresh")`。
- 无 UI 单测；报告贴关键 diff 与自测截图描述。

### 3. 联系人编辑（app）
- `app/app/contacts/[id].tsx` 加「编辑」切换：姓名、公司、职位、电话、微信、别名（逗号分隔，沿用 fix8 的 `parseSelfNamesInput` 同款解析或抽通用 `parseCommaList`）、标签、备注 → 「保存」→ `updateContact` → toast → 回只读态并重载详情。「删除联系人」→ `Alert.alert`（文案说明会一并删除他的观察记录与洞察、会议里保留名字）→ `deleteContact` → `router.back()`。
- 观察记录 / 洞察本身**不做编辑**（另立）。

## 已否决 / 本批不做
- 撤销已确认的卡（逆转副作用）：走本批的编辑/删除即可。
- 观察记录（互动）与洞察的编辑/删除：另立。
- 日期选择器控件：沿用 ISO 文本 + 友好显示。
- server 模式真实实现：占位。
- 合并两个联系人：不做。

## Scope
- 可动：`app/src/connection/dispatch.ts`、`app/src/api.ts`（占位）、`app/src/local/api.ts`、`app/src/local/types.ts`、`app/src/local/store.ts`（仅暴露既有 update + 新增两个 delete）、`app/app/_layout.tsx`（仅注册一个 Screen）、新建 `app/app/meetings/[id].tsx`、`app/app/(tabs)/meetings.tsx`、`app/app/contacts/[id].tsx`、`app/src/diagnostics/event-log.ts`（仅新增四种）、`app/src/components/review/review-fields.tsx`（若需导出 `FieldInput`）、`app/src/review-order.ts`／`time-format.ts`（复用 `formatConfirmTime`）、测试。
- 不可动：DB schema / migrations、`shared/core/**`（含 execute.ts / propose.ts / schemas.ts）、`server/src/**`（测试除外）、fix1–fix15 已交付行为、`app/app.json` 版本号、依赖。

## Constraints（含仓库围栏，硬性）
- 只在 `~/Projects/mailuo` 内 `git add / commit / push origin main`；**不调用任何名为 commit / 提交 的技能**；不读写、不 cd 到本仓之外的任何目录；产出（报告）只写本仓 `docs/`；收尾不移动、不删除任何文件。
- PLAN 第 0 节适用；中文 commit；自验全绿才 commit + push；示例用虚构名；有边界疑问报 BLOCKED / NEEDS_CONTEXT。

## Done when
1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 253、app 不低于 186；`git diff --check` 干净
2. Goal 1 五组测试落地；Goal 2/3 报告贴关键 diff
3. 报告 `docs/report-v3-m4-fix16.md`（与 fix15 报告同结构，含突变检查）贴真实测试输出、文件清单、偏离决定；只写本仓的事
