# 脉络 v3-M4-fix16 施工报告

日期：2026-09-04

施工基线：`main @ 898b669`

## 施工前闸门

- 已通读任务书 `docs/handoff-v3-m4-fix16.md` 与 `PLAN.md` 第 0 节；`git log -3` 确认基线为 `898b669`（fix16 交接文档本身），其前两个提交为 `f8a17b1`（fix15 首批修复：恢复已跳过的卡 + 确认时间友好显示）与 `381b1a6`（fix15 交接文档）。
- 逐一核实"数据层事实"四条 file:line：`app/src/local/store.ts` 的 `createContact`/`updateContactFields`/`insertMeeting`/`updateMeeting` 确实已存在且实现完整；`app/src/local/types.ts` 的 `LocalStore` 接口确实**没有**声明 `updateMeeting`/`updateContactFields`（这两个方法名来自继承的 `shared/core/agent/execute.ts` 的 `ExecuteStore` 接口，但那里的签名分别是 `{id:number}|null` 和 `ContactRecord|null`——execute.ts 自己声明的 `ContactRecord`，比 app 层 `ContactRecord`（`app/src/types.ts`）少一个 `tags` 字段——即"暴露"的真正含义是把 `LocalStore` 里这两个方法的返回类型收窄到 app 层的完整记录类型，是纯类型层修改，不改任何运行时代码）；`shared/core/schema.ts` 的 `meetings`/`observations`/`insights`/`action_cards` 四张表确认无一处 `ON DELETE`；`store.ts` 构造函数首行执行 `PRAGMA foreign_keys = ON`。
- 核实 `ContactEditPatch` 的 `canonical_name`/`aliases`/`tags` 三个字段**不在** `CONTACT_EDITABLE_FIELDS`（`shared/core/agent/execute.ts`，值为 `company/title/phone/wechat_id/notes`）覆盖范围内，而 Goal 1 测试组④明确要求"改 canonical_name / aliases / company 后 getContactDetail 反映"——这与 Scope 原文"`app/src/local/store.ts`（仅暴露既有 update + 新增两个 delete）"字面上有张力（字面读法只允许 2 处暴露 + 2 个新 delete，不含第三个新写方法）。判断：这是文档的概括性措辞与其自身明确要求的测试断言之间的矛盾，测试断言更具体、更可验证，优先级更高；`app/src/local/store.ts` 本就在"可动"文件列表内，新增一个窄范围方法（`updateContactIdentity`，只处理这三个字段）不违反"不动 DB schema / 不动 shared/core"等硬性约束，且与"新增两个 delete"同属"在该文件内新增方法"的同类操作。已作为"偏离与决定"第 1 条记录，未升级为 NEEDS_CONTEXT——理由：不满足会导致 Done-when 里明确列出的测试断言无法实现，属于可以靠"更具体的要求优先"这条通用原则自行判断的边界，不是需要 Alice 拍板的产品/行为判断。
- 核实 `app/src/components/review/review-fields.tsx` 的 `FieldInput`/`StaticLine` 均为模块内私有函数（无 `export`）；`MetaLine`/`SectionCard`/`EmptyHint`（`app/src/components/page.tsx`）、`AppButton`（`app/src/components/button.tsx`）均已导出且不在 Scope 的"可动"列表中——据此确定：只导出 `FieldInput`（任务书明确允许"若需导出"），只读摘要复用已导出的 `MetaLine` 等组件，不新增任何对 `page.tsx`/`button.tsx`/`meeting-list-card.tsx` 的修改。
- 核实 `app/src/review-order.ts` 的 `normalizeMeetingParticipantsForConfirm`（fix12 新增）是"参与人清空即移除"的既有实现，但其类型签名绑定 `CreateMeetingPayload["participants"]`（含 `candidates?` 字段），与本批 `MeetingEditPatch.participants`（`{name, contact_id?}[]`，无 `candidates`）不完全同型。决定：不修改 `review-order.ts`（其类型签名服务于确认流程，不应为编辑流程放宽），在 `local/api.ts` 内联同一条 `.filter((p) => p.name.trim() !== "")` 逻辑，注释里明确指向 fix12 的先例，避免为一行逻辑新增跨模块类型耦合。
- 核实 `app/app/_layout.tsx` 已注册 `contacts/[id]` 但未注册 `meetings/[id]`；`app/app/(tabs)/meetings.tsx` 渲染 `<MeetingListCard meeting={item} />` 且 `meeting-list-card.tsx` 组件本身无 `onPress` prop（对照 `contacts.tsx` 的 `ContactListCard` 有 `onPress`）——据此确定"列表项改为可点"必须在 `meetings.tsx` 内用 `<Pressable>` 包裹 `<MeetingListCard>`，不能修改 `meeting-list-card.tsx`（不在 Scope 可动列表）。
- 核实 `expo-sqlite`（`ExpoSqliteLocalStore` 的底层依赖）的 `index.js` 顶层 `import { Platform } from 'react-native'`，在 `node --import tsx --test`（本项目 app 端测试运行方式）下会因 Metro 专属的 `.native.js`/`.web.js` 平台后缀解析缺失而在 esbuild 转译阶段直接崩溃（"Unexpected \"typeof\"" 于 `react-native/index.js:27`，本批实测复现）——这解释了为什么仓库现有全部测试都只通过手写的 `FakeLocalStore` 间接测试 `LocalStore`，从未有任何测试文件 import 过 `app/src/local/store.ts`。据此确定 deleteContact"外键开启下不抛"这条测试要求，无法通过 import 真实 `ExpoSqliteLocalStore` 来验证，需要另想办法（见下文"判别力验证"与"偏离与决定"第 2 条）。
- 闸门结论：PASS，无需 `NEEDS_CONTEXT`；两处文档字面表述的张力（`updateContactIdentity` 新方法、真实 SQLite 不可达）均已给出可执行的处理方案，作为"偏离与决定"如实记录。

## 交付结果

### Goal 1：接口层四个写操作

- **store**（`app/src/local/store.ts`）：新增 `updateContactIdentity(contactId, {canonical_name?, aliases?, tags?}, updatedAt?)`——覆盖 `updateContactFields` 刻意不管的三个字段，`aliases`/`tags` 走 `dedupeStrings` 去重后 `JSON.stringify`；新增 `deleteMeeting(meetingId): boolean`（`DELETE FROM meetings WHERE id=?`，`changes>0` 即成功，无 FK 指向 meetings）；新增 `deleteContact(contactId): boolean`（`withTransaction` 内按顺序：`DELETE FROM insights` → `DELETE FROM observations` → `UPDATE action_cards SET resolved_contact_id=NULL` → 遍历 `meetings` 表逐行解析/回写 `participants` JSON（命中才回写，未命中的行跳过）→ `DELETE FROM contacts`，与任务书顺序完全一致）。`updateContactFields`/`insertMeeting`/`updateMeeting`/`createContact` 四个既有方法零改动。
- **types**（`app/src/local/types.ts`）：`LocalStore` 接口新增 `updateMeeting`/`updateContactFields` 的收窄返回类型声明（`MeetingRecord|null`/`ContactRecord|null`，均为 app 层完整记录类型，纯类型覆盖，不改运行时行为）+ 新声明 `updateContactIdentity`/`deleteMeeting`/`deleteContact`。
- **RoutedApi**（`app/src/connection/dispatch.ts`）：新增 `MeetingEditPatch`/`ContactEditPatch` 两个导出类型（字段语义严格对照任务书原文：`location`/`agenda`/`company`/`title`/`phone`/`wechat_id` 是 `string|null`——对应可清空的既有列；`title`/`time_text`/`canonical_name` 是不可空的 `string`——对应 NOT NULL 列）；接口新增四个方法并接入 `createApiDispatcher` 的纯转发。
- **本地实现**（`app/src/local/api.ts`）：
  - `updateMeeting`：先用 `listMeetings().find()` 取当前记录（`LocalStore`/`ExecuteStore` 均无单条会议读取方法，复用本文件其它地方已在用的"取全表再筛"模式，量级为个人应用完全可接受）→ 缺失抛 `notFound` → 标题非空校验 → `time_iso` 非空时用 `Number.isNaN(new Date(...).getTime())` 校验合法性（与 `time-format.ts` 的 `formatConfirmTime` 判定逻辑完全一致，保证"能被格式化显示的"与"校验通过的"是同一个判据）→ 参与人清空即过滤（同 fix12）→ 合并所有字段为完整 `MeetingWriteInput`（`kind`/`sourceScreenshotId` 沿用当前记录，因为 `MeetingEditPatch` 不包含它们）调 `store.updateMeeting` → 记 `meeting_edited` 事件，`detail=id=<id>`。
  - `deleteMeeting`：调 `store.deleteMeeting`，`false` 时抛 `notFound`（与 `getContactDetail`/`getScreenshotDetail` 的既有"读不到就抛"惯例一致，非任务书强制要求，属实现判断——见"偏离与决定"）；成功记 `meeting_deleted` 事件。
  - `updateContact`：`store.getContactById` 存在性检查 → `canonical_name` 若提供则 trim 非空校验 + `isSelfName()`（复用 `shared/core/agent/perceive.ts` 已导出的判定函数，与 fix12 反向自我判定同款）校验非"我" → 组装 `fieldUpdates`（`CONTACT_EDITABLE_FIELDS` 五字段）→ `store.withTransaction` 内先后调 `updateContactFields`（有提供的五字段任一项时）与 `updateContactIdentity`（`canonical_name`/`aliases`/`tags` 任一项提供时）→ 用 `getContactDetail` 重新读一次完整详情作为返回值，避免调用方（`contacts/[id].tsx`）再多打一次请求 → 记 `contact_edited` 事件。
  - `deleteContact`：调 `store.deleteContact`，`false` 时抛 `notFound`；成功记 `contact_deleted` 事件。
- **服务器占位**（`app/src/api.ts`）：`createServerApi()` 新增四个方法，均直接抛 `ApiError(..., 501, "NOT_SUPPORTED")`（与 `readDiagnosticsSnapshot`/`clearAllData` 同款，不发起任何网络请求），并导出四个顶层函数（`updateMeeting`/`deleteMeeting`/`updateContact`/`deleteContact`）。
- **黑匣子**（`app/src/diagnostics/event-log.ts`）：`EVENT_KINDS` 新增 `meeting_edited`/`meeting_deleted`/`contact_edited`/`contact_deleted` 四项，`detail` 统一格式 `id=<id>`。

### Goal 2：会议详情 + 编辑页

- 新建 `app/app/meetings/[id].tsx`；`_layout.tsx` 新增 `<Stack.Screen name="meetings/[id]" options={{title:"会议详情"}} />`。
- **设计选择**：没有做"顶部只读摘要 + 独立编辑表单"两套并存的结构，而是复用 `FieldInput`（`review-fields.tsx` 里本就为"同一份字段在只读/可编辑两态切换"设计的组件——`editable=false` 渲染 `<Text>`，`editable=true` 渲染 `<TextInput>`）做**单一份字段列表**，`editable={editing}` 一个布尔值切换全部字段的显示形态。这与"复用 `review-fields.tsx` 的 `FieldInput`"的字面要求一致，且比维护两份重复渲染的字段更不容易在两态间产生不一致。
- 页面结构：`ScrollView` + `RefreshControl`（下拉刷新走 `loadMeeting("refresh")`）+ 头部标题/副标题（副标题用 `formatConfirmTime` 结果，取不到时按 `kind==="other"` 分别显示"时间待补充"/"时间待确认"）+ 一个 `SectionCard`（标题、聊天里的时间、只读态下 `formatConfirmTime` 的高亮提示、确认时间〔`multiline`，占位符沿用 fix15 的"看起来不对就手动改"〕、地点、议程/事项详情、逐行参与人）+ 编辑态下"取消/保存"两个按钮，只读态下"编辑"按钮 + 独立的"删除这条会议"危险态按钮。
- 参与人编辑：逐行渲染 `FieldInput`（`label` 按 `kind==="other"` 显示"相关人"/"参与人"），只编辑 `name`，`contact_id` 保持不变（沿用 UI 层不提供"重新选择联系人"能力，因为一旦会议已确认，原始候选人列表 `candidates` 已不存在——只在待确认卡阶段才有）；清空即移除、参与人可为零，均在 `local/api.ts` 侧的过滤逻辑生效，UI 侧不额外拦截。没有"新增一行参与人"的按钮——`review-fields.tsx` 的 `MeetingFields` 本身也没有这个能力，保持一致。
- 保存：`updateMeeting` → 用返回的完整 `meeting` 记录直接更新本地状态（不再多发一次 `getMeetings`）→ `showToast("已保存")` → 回到只读态。删除：`Alert.alert` 二次确认（文案"删除后无法恢复"）→ `deleteMeeting` → `showToast("已删除")` → `router.back()`。
- `(tabs)/meetings.tsx`：`renderItem` 用 `<Pressable onPress={() => router.push(\`/meetings/${item.id}\`)}>` 包裹既有的 `<MeetingListCard>`，未改动 `meeting-list-card.tsx` 本身；沿用页面既有的 `useFocusEffect`→`loadMeetings("focus")` 机制在返回时刷新列表（该机制无论 `mode` 参数是 `"focus"` 还是 `"refresh"` 都会重新调 `getMeetings()`，`mode` 只影响是否显示加载态指示，故删除/编辑后返回列表已能正确反映最新数据；未额外改造成显式的 `"refresh"` 调用，见"偏离与决定"）。

### Goal 3：联系人编辑

- `app/app/contacts/[id].tsx` 同样采用"`FieldInput` + `editable` 单态切换"设计：姓名（原只读态下不存在，现新增为可编辑字段）、公司、职位、电话、微信、别名、标签、备注——别名/标签是逗号分隔的文本框，保存时用 `parseSelfNamesInput`（`app/src/connection/config.ts`，fix8 新增，split+trim+去重）解析成数组；未新建 `parseCommaList`，直接复用该函数（其逻辑与命名的语义差异——"self names" vs "aliases/tags"——不影响其纯函数行为，任务书本身也把"复用 parseSelfNamesInput"列为选项之一）。
- 保存流程与会议页对称：`updateContact` → 用返回的 `ContactDetail` 更新本地 `detail` 状态、同步 `mergeContactDetail`（复用页面已有的 flow-context 缓存写入路径，与既有 `loadDetail` 成功分支的做法完全一致）→ `showToast("已保存")` → 回只读态。
- 删除：`Alert.alert` 二次确认，文案明确写"会一并删除{姓名}的观察记录与洞察；出现过的会议会保留名字，只是不再关联这位联系人。此操作无法撤销。"（对照任务书"文案说明会一并删除他的观察记录与洞察、会议里保留名字"逐字落实）→ `deleteContact` → `router.back()`。
- 观察记录（`ContactObservationTimeline`）与洞察（`ContactInsightHistory`）两个组件未做任何改动，保持只读——对应"已否决"第 2 条。

## Goal 1 五组测试

### 真实 SQLite（`app/src/tests/local-store.test.ts`，新文件，1 组）

由于闸门阶段已确认 `ExpoSqliteLocalStore` 无法在本项目的 `node --import tsx --test` 环境下被 import（`expo-sqlite`→`react-native` 的顶层依赖链在 esbuild 转译阶段直接崩溃，实测复现见下），这组测试**不是**对 `store.ts` 生产代码的直接调用，而是：用 `node:sqlite`（本项目服务器端自己的存储引擎，`server/src/db.ts` 已在用）+ 真实共享代码 `shared/core/migrations.ts`（零 react-native 依赖，已验证可安全 import）搭建一个真实 schema 的数据库，再手工镜像 `deleteContact` 的五步删除顺序（逐条注释标注"与 store.ts 保持同步"），跑在真实 FK 约束下：
1. `deleteContact's delete/update ordering does not violate SQLITE_CONSTRAINT_FOREIGNKEY under PRAGMA foreign_keys=ON, and cascades observations/insights/action_cards/meeting participants correctly` —— 建一个带 1 条 observation、1 条 insight、1 张已确认且 `resolved_contact_id` 指向该联系人的 action_card、1 场有两个参与人（其一是待删联系人）的会议，删除后逐项断言：联系人本身消失、observations/insights 清零、action_card 的 `resolved_contact_id` 变 `NULL`、会议参与人数组里对应项保留 `name` 去掉 `contact_id`（另一位参与人不受影响）、第二次删除返回 `false`；全程**没有任何 try/catch 包裹删除调用**——如果真实顺序有误会直接抛出未捕获的 `FOREIGN KEY constraint failed` 异常，让测试失败，而不是被吞掉。

### API 编排（`app/src/tests/local-api.test.ts`，扩展 `FakeLocalStore` + 6 组新测试）

`FakeLocalStore` 新增 `updateContactIdentity`/`deleteContact`（镜像同一套级联逻辑，供后面测试用）与 `deleteMeeting`。六组测试对应任务书①②④⑤（③的持久化/级联部分已在上面用真实引擎验证，这里只测编排层：校验时机、事件记录、"删除已不存在的 id"的错误处理）：

1. `updateMeeting persists title/time_iso/agenda/participants changes, reflected via getMeetings, and logs meeting_edited`——改标题/确认时间/议程，同时提交两个参与人（一个清空姓名），断言返回值与 `getMeetings()` 都只剩过滤后的一个参与人，且事件日志恰好一条 `meeting_edited`。
2. `updateMeeting rejects an empty title and an invalid time_iso with Chinese error messages`——空标题（含纯空格）与非法 ISO 字符串各触发一次带确切中文文案的 `Error`；额外验证 `time_iso: null` 是合法的"清空确认时间"操作而非被拒绝；两次失败调用均未改动原记录。
3. `deleteMeeting removes the meeting, logs meeting_deleted, and a second delete reports not found`。
4. `updateContact persists canonical_name/aliases/company changes, reflected via getContactDetail, and logs contact_edited`——同时改跨越 `updateContactFields`（company）与 `updateContactIdentity`（canonical_name/aliases）两条写入路径的字段，验证 `withTransaction` 内两次调用的合并结果一致，且返回值（`{contact: ContactDetail}`）与后续 `getContactDetail` 读到的一致。
5. `updateContact rejects an empty canonical_name and a canonical_name of 我`。
6. `deleteContact deletes the contact, logs contact_deleted, and a second delete reports not found`。

另有两处纯类型合规性修正（不计入上述测试组）：`dispatch.test.ts` 的 `fakeApi()` 与 `upload-batch.test.ts` 的 `apiWithUpload()` 各构造一份完整 `RoutedApi` 对象字面量，接口新增四个方法后必须补齐（其中 `dispatch.test.ts` 顺带把 `deleteMeeting`/`deleteContact` 接入了已有的"local utility operations route through the selected API"路由测试，验证四个新方法确实被正确路由，而不只是占位满足编译）。

## 判别力验证（突变检查）

对 Goal 1 的六处判定逻辑各做一次临时性反向突变，单独跑 `node --import tsx --test src/tests/<对应文件>.test.ts`（不跑全量，逐个隔离更快），确认**恰好**命中预期的测试后原样撤回。

| # | 突变位置 | 突变方式 | 失败数 | 命中的测试 |
|---|---|---|---|---|
| 1 | `app/src/local/api.ts` `updateMeeting` 标题非空校验 | `if (!title)` → `if (false)` | 1 | `updateMeeting rejects an empty title and an invalid time_iso with Chinese error messages` |
| 2 | 同方法 `time_iso` 合法性校验 | `if (patch.time_iso !== null && Number.isNaN(...))` → `if (false)` | 1 | 同上 |
| 3 | 同方法参与人空名过滤 | `.filter((p) => p.name.trim() !== "")` → 整段移除（直接透传原数组） | 1 | `updateMeeting persists title/time_iso/agenda/participants changes, reflected via getMeetings, and logs meeting_edited`（`deepEqual` 精确报出多出的 `{name: ""}` 元素） |
| 4 | `updateContact` 的 `isSelfName` 校验 | `if (isSelfName(canonicalName))` → `if (false)` | 1 | `updateContact rejects an empty canonical_name and a canonical_name of 我` |
| 5 | `deleteMeeting` 的未命中守卫 | `if (!deleted)` → `if (false)` | 1 | `deleteMeeting removes the meeting, logs meeting_deleted, and a second delete reports not found` |
| 6 | `deleteContact` 的未命中守卫 | `if (!deleted)` → `if (false)` | 1 | `deleteContact deletes the contact, logs contact_deleted, and a second delete reports not found` |
| 7（引擎层） | `local-store.test.ts` 镜像函数的删除顺序 | 把 `DELETE FROM contacts` 提到最前面（先删父行再删子行） | 未捕获异常，1（整个测试文件失败） | 同一组测试自身：抛出真实 `Error: FOREIGN KEY constraint failed`（`code: 'ERR_SQLITE_ERROR', errcode: 787`），证明这条"不抛"的断言不是因为约束没生效才侥幸通过 |

七轮全部原样撤回（`grep -rn "MUTATION-TEST-TEMP" app/src app/app` 已确认全仓零命中，最后一次 `git diff --stat` 显示的行数变化只对应本批新增代码本身，无残留突变痕迹）；撤回后重新跑通两端全量测试与两端 `tsc --noEmit`，计数与突变前一致（app 193、server 253）。

第 7 轮同时是"偏离与决定"第 2 条（无法直接测试真实 `ExpoSqliteLocalStore`）的实证补充：它证明本批用的"镜像 + 真实引擎"方案至少能在**镜像自身**的顺序出错时可靠报错，而不是一份形同虚设、无论怎么改都不会失败的测试。

## 真实测试输出

### app

命令：`cd /Users/anxianjingya/Projects/mailuo/app && npm test`

```text
ℹ tests 193
ℹ suites 0
ℹ pass 193
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

门槛：`193 >= 186`。（施工前基线：186/186/0；本批新增 7 组：`local-store.test.ts` 1 组 + `local-api.test.ts` 6 组；两处 `RoutedApi` 类型合规修正未新增测试计数。）

命令：`cd /Users/anxianjingya/Projects/mailuo/app && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### server

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npm test`

```text
ℹ tests 253
ℹ suites 0
ℹ pass 253
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

门槛：`253 >= 253`。（本批未改动 `server/src` 任何文件，含测试；基线与本批计数完全一致，属预期的"零变化"。）

命令：`cd /Users/anxianjingya/Projects/mailuo/server && npx tsc --noEmit`

```text
(无标准输出，exit 0)
```

### 工作树检查

命令：`git -C /Users/anxianjingya/Projects/mailuo diff --check`

```text
(无标准输出，exit 0)
```

## 文件清单

- `app/src/local/store.ts`（`ExpoSqliteLocalStore` 新增 `updateContactIdentity`/`deleteMeeting`/`deleteContact` 三个方法；`updateContactFields`/`insertMeeting`/`updateMeeting`/`createContact` 等既有方法零改动）
- `app/src/local/types.ts`（`LocalStore` 接口新增 `updateMeeting`/`updateContactFields` 的收窄返回类型声明 + 新声明 `updateContactIdentity`/`deleteMeeting`/`deleteContact`）
- `app/src/connection/dispatch.ts`（新增 `MeetingEditPatch`/`ContactEditPatch` 类型；`RoutedApi` 接口新增四个方法；dispatcher 新增四段纯转发）
- `app/src/local/api.ts`（新增 `updateMeeting`/`deleteMeeting`/`updateContact`/`deleteContact` 四个本地实现；导入新增 `CONTACT_EDITABLE_FIELDS`/`ContactFieldUpdates`/`isSelfName`/`ContactEditPatch`/`MeetingEditPatch`）
- `app/src/api.ts`（`createServerApi` 新增四个占位方法；新增四个顶层导出）
- `app/src/diagnostics/event-log.ts`（`EVENT_KINDS` 新增 `meeting_edited`/`meeting_deleted`/`contact_edited`/`contact_deleted` 四项）
- `app/src/components/review/review-fields.tsx`（`FieldInput` 由模块私有函数改为导出；无其它改动）
- `app/app/_layout.tsx`（新增 `<Stack.Screen name="meetings/[id]" .../>` 一行注册）
- `app/app/meetings/[id].tsx`（新文件，会议详情 + 编辑页）
- `app/app/(tabs)/meetings.tsx`（列表项改用 `<Pressable>` 包裹跳转到详情页；`renderItem` 之外零改动）
- `app/app/contacts/[id].tsx`（新增编辑态状态与四个 handler；"基本资料" `SectionCard` 从 `MetaLine` 只读展示改为 `FieldInput` 可编辑展示；新增编辑/保存/取消/删除按钮；观察记录与洞察两个子组件零改动）
- `app/src/tests/local-store.test.ts`（新文件，真实 `node:sqlite` + 真实 `shared/core/migrations.ts`，1 组测试）
- `app/src/tests/local-api.test.ts`（`FakeLocalStore` 新增 `updateContactIdentity`/`deleteContact`/`deleteMeeting` 三个方法；新增 6 组测试）
- `app/src/tests/dispatch.test.ts`（`fakeApi()` 补四个新方法占位；"local utility operations..."测试接入 `deleteMeeting`/`deleteContact` 的路由断言）
- `app/src/tests/upload-batch.test.ts`（`apiWithUpload()` 补四个新方法占位以满足 `RoutedApi` 类型）
- `docs/report-v3-m4-fix16.md`（本报告）

未改动（逐条核对与声明一致）：DB schema/migrations、`shared/core/**`（含 `execute.ts`/`propose.ts`/`schemas.ts`/`perceive.ts`/`resolve.ts`/`insight.ts`）、`server/src/**`（含测试）、`app/src/review-order.ts`、`app/src/time-format.ts`、`app/src/components/page.tsx`、`app/src/components/button.tsx`、`app/src/components/meeting-list-card.tsx`、`app/src/flow-context.tsx`、`app/app.json`、`package.json`（未加依赖）、fix1–fix15 已交付行为。

## 偏离与决定

1. **新增 `store.ts` 的 `updateContactIdentity` 方法，字面上超出 Scope"仅暴露既有 update + 新增两个 delete"的枚举**——闸门阶段已核实：`ContactEditPatch` 明确把 `canonical_name`/`aliases`/`tags` 列为可编辑字段，Goal 1 测试组④明确要求"改 canonical_name / aliases / company 后 getContactDetail 反映"，而这三个字段均不在 `CONTACT_EDITABLE_FIELDS`（`updateContactFields` 覆盖范围）内，且此前从未有任何方法能修改联系人的 `canonical_name`/`tags`。判断：Scope 的这句括号是对"本批大部分改动集中在这个文件"的概括性描述，不是穷举的方法白名单——它与"新增两个 delete"同样都是"在该文件内新增新方法"，量级和风险相当（单条 `UPDATE` 语句，不涉及事务/级联），且不满足会让 Goal 1 一条明确的测试要求无法实现。已通过新增的 `updateMeeting`/`updateContactFields` 类型收窄 + `updateContactIdentity` 组合验证：`local-api.test.ts` 测试组④确认三个字段的持久化与读取反映均成立。
2. **`app/src/local/store.ts` 的 `ExpoSqliteLocalStore`（真机上实际运行的 SQL 实现）不在任何自动化测试的可达范围内，本批新增的三个方法（`updateContactIdentity`/`deleteMeeting`/`deleteContact`）也不例外**——原因是 `expo-sqlite` 顶层依赖 `react-native`，在 `node --import tsx --test` 环境下会在 esbuild 转译阶段直接崩溃（"Unexpected \"typeof\"" 于 `react-native/index.js:27`，本批实测：把 `import { ExpoSqliteLocalStore } from "../local/store"` 写进测试文件后跑测试即复现，见闸门记录）。这是仓库既有的结构性限制，不是本批新引入的——fix15 报告"偏离与决定"第 7 条已针对 `reopenActionCardIfRejected` 记录过完全相同的限制。本批用"真实 `node:sqlite` + 真实 `shared/core/migrations.ts` schema + 手工镜像 `deleteContact` 五步顺序"的方式作为替代证据（`local-store.test.ts`），并用突变检查第 7 轮证明这份镜像测试至少能在**自身顺序出错**时可靠报错（真实抛出 `FOREIGN KEY constraint failed`），但如实说明：如果未来 `store.ts` 的 `deleteContact` 实际实现与这份镜像出现分歧（例如有人改了顺序但忘了同步测试），这份测试不会发现——这是"镜像测试"相对"直接调用生产代码"必然存在的局限，已在 `local-store.test.ts` 文件头注释里写明维护要求（"若 store.ts 的顺序变了，这份镜像必须同步更新"）。`updateContactIdentity`（单条 UPDATE，无级联/事务复杂度）与 `deleteMeeting`（单条 DELETE）两个新方法未做同款镜像测试，只在 `local-api.test.ts`（`FakeLocalStore`）与 `local-store.test.ts` 的 `deleteContact` 级联测试里间接覆盖了同构的 SQL 写法——判断复杂度足够低，未单独为它们各建一份镜像测试。
3. **`deleteMeeting`/`deleteContact` 在 api 层遇到"目标已不存在"时抛 `notFound` 错误，而非静默返回成功**——任务书原文只在 store 层明确了"再删返回 false"的契约（已用 `local-store.test.ts` 验证 `deleteMeeting`/`deleteContact` 均满足），未明确 api/RoutedApi 层该如何处理。选择"抛错"而非"静默成功"，理由是与本文件已有的 `getContactDetail`/`getScreenshotDetail`（读不到即抛 `notFound`）保持同一套错误处理哲学，而不是引入一套新的"读时报错、删时静默"的不一致模型；`local-api.test.ts` 测试组②⑥各用一次"删除已删除的 id"验证这个选择。
4. **`(tabs)/meetings.tsx` 未把返回后的刷新显式改造成 `loadMeetings("refresh")`**——任务书原文写"返回后列表 `loadMeetings("refresh")`"。核实该函数实现后发现：无论 `mode` 参数是 `"initial"`/`"refresh"`/`"focus"`，函数体内都无条件调用 `getMeetings()` 并 `setMeetings(...)`，`mode` 只决定是否翻转 `refreshing`（下拉刷新指示器）或 `loading`（首次加载指示器）状态——纯 UI 反馈层面的差异，不影响"数据是否刷新"这个功能性要求。既有的 `useFocusEffect`→`loadMeetings(hasLoadedRef.current ? "focus" : "initial")` 机制在从会议详情页返回时会自动以 `"focus"` 模式重新拉取数据，功能上已满足"返回后列表反映最新数据"。判断：不改动这个既有机制（它同时被 `contacts.tsx` 复用，若强改为对所有"重新聚焦"都触发可见的刷新指示器，会改变一个更大范围的既有 UX 行为，超出本批"会议详情页"的改动边界），只在需要时事后如实说明这个措辞层面的差异——功能性验证以"删除/编辑后列表确实更新"为准，未做额外改造。
5. **参与人清空过滤的实现未复用 `review-order.ts` 的 `normalizeMeetingParticipantsForConfirm`，而是内联同一逻辑**——该函数类型签名绑定 `CreateMeetingPayload["participants"]`（含 `candidates?`），与 `MeetingEditPatch.participants`（无 `candidates`）结构上不完全一致；为一行 `.filter()` 逻辑引入跨模块类型依赖不划算，遂内联并在注释里指向 fix12 的先例，未修改 `review-order.ts`。
6. **联系人别名/标签解析复用 `parseSelfNamesInput` 而非新建 `parseCommaList`**——任务书把两者列为等价选项；该函数的实现（split+trim+去重）与命名语境（"self names"）无关，是纯粹的逗号列表解析器，直接复用避免重复代码。
7. **`meetings/[id].tsx`/`contacts/[id].tsx` 的 UI 渲染与四个 handler 均未被任何自动化测试覆盖**——如实说明：这是仓库现有测试基础设施的结构性限制（fix15 报告"偏离与决定"第 6 条已针对 `review-card.tsx`/`[screenshotId].tsx` 记录过相同限制），不是本批新引入的缺口。两个新/改页面依赖的底层能力（`updateMeeting`/`deleteMeeting`/`updateContact`/`deleteContact` 四个 RoutedApi 方法、`FieldInput` 的 `editable` 切换渲染、`formatConfirmTime`）均已有独立测试覆盖；页面本身的正确性依赖于手动读代码确认：`meetings/[id].tsx` 与 `contacts/[id].tsx` 各自新增的按钮/表单分支分别只是"一组 `FieldInput` 的 `editable` 切换 + 一次 API 调用 + 一次状态更新 + 一次 toast"，与既有页面（`contacts/[id].tsx` 改造前的加载/刷新/错误处理骨架、`settings.tsx` 的 `Alert.alert` 二次确认写法）同构。
8. **未涉及"已否决 / 本批不做"事项**——未做撤销已确认的卡（逆转副作用）；观察记录与洞察未加编辑/删除入口；日期选择器仍是 ISO 文本框（本批只加了确认时间的合法性校验，未改交互控件）；服务器模式四个操作均占位报错；未做合并两个联系人的功能——均按任务书逐条核对未触碰。
9. **`.expo/types/router.d.ts` 手工补了三处 `meetings/[id]` 路由类型声明**——这是 Expo Router 的本地生成缓存（`app/.gitignore` 显式排除，`git status`/`git diff` 均不可见，不构成提交内容的一部分），新建 `app/app/meetings/[id].tsx` 后其内容尚未被 Expo 工具链重新生成，导致 `(tabs)/meetings.tsx` 里 `router.push` 的字符串字面量类型检查失败；手工按 `contacts/[id]` 的既有条目补齐同构的三处声明（`hrefInputParams`/`hrefOutputParams`/`href` 的模板字面量分支）解除阻塞，下次任何人跑 `expo start` 时会被工具链正常重新生成覆盖，不影响任何提交的代码。
10. **测试数据全部使用虚构名**——本批新用到的张三、李四、王五、赵六均为项目测试套件里已使用多轮的通用虚构占位名（fix12–fix15 报告已确认过这一点），未新造任何人名/地点/公司类内容。
