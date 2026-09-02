# 脉络 Mailuo — v3-M4-fix3 施工交接（人脉侧四缺陷 + 崩溃可见 + 清空数据）

## 你的角色

接 v3.1.2（`12937c0` + tag）。真机验收结论：日程、备注累积、中文输出、速度全部通过；
本批修**人脉侧四个体验缺陷**（Goal 1–5，`shared/core` 规则层 + 两份 store 镜像 + 少量 UI），
外加**让闪退可见**（Goal 6）与**清空全部数据入口**（Goal 7），两者都在 app 侧。
全批**不动 schema、不做迁移**。施工图 PLAN.md（第 0 节「宁可留空，不要猜错」适用），
先 `git log -3` 同步认知。自验用本机 Node 26。分两批派活，见文末「施工分两批」。

## 真机实证（owner，OPPO，本地模式 = 手机 OCR + 自带 API key）

- ❌ **映射报错不可读**：确认一张「还没关联到已有联系人」的互动卡时弹
  `Missing real contact mapping for local batch contact 217`。复现路径：同一批截图里
  先**跳过**了「新建联系人 王总」那张卡，再确认依赖它的互动卡。217 是锚点 create_contact
  卡的 id，不是联系人 id。用户完全看不到这张互动卡依赖哪张卡。
- ❌ **OCR 变体成新人**：每批都是同样 4 个已有联系人，但 OCR 单字误差让「一个人变成非常多」
  ——每批衍生若干变体新联系人。
- ❌ **无意义更新卡 + 别名拼接**：匹配到同一个人后，更新卡仍报公司/职位「不一样」，
  实际归一化后完全一样；「集团副总王磊」这类姓名+职位拼接被存成别名。
- ❌ **事实重复**：联系人详情里同一条事实随每次重传累加。
- ❌ **传完自动关闭**：一批 5–7 张跑完、数据已写库之后，app 直接消失，没有任何错误弹窗。
  owner 原话「虽然东西都在，但是看着很吓人」。
- ❌ **没有事后编辑 / 清空入口**：确认后发现识别错了，唯一办法是卸载重装。

## 诊断（owner 已逐处核过 file:line，直接照此改）

① **映射报错**（`app/src/local/batch-contacts.ts`）：每批一个纯内存 `LocalBatchContactSession`
（`app/app/(tabs)/index.tsx:249`）。第 N 张截图发现的新人在 `commitScreenshot`（:920-1017，
负数临时 id :960-971）登记为 pending，锚点是那张 `create_contact` 卡；后续截图的互动卡解析到它时
:820-832 剥掉负数 id、持久化 `disambiguation.local_batch_deferred = { version:1,
dependencies:[{ kind:"record_interaction", anchor_card_id }] }`。确认时
`preparePersistedLocalBatchConfirmation`（:494-601）从 sqlite 读锚点卡，
`confirmedAnchorContactId`（:467-482）要求锚点存在、是 create_contact、`status === "confirmed"`、
`resolved_contact_id` 为正数，否则 :478 抛 `LocalBatchContactMappingError(anchorCardId)`
（类定义 :97-102，message 硬编码英文）。`registerRejectedAnchor`（:1070-1075）只清内存不动
已持久化的依赖标记；`hydrateLocalBatchCardForResponse`（:603+）只 hydrate
`disambiguation_candidate` 依赖，所以延迟互动卡永远显示「还没关联到已有联系人」
（`app/src/components/review/review-fields.tsx:261`）。错误文案直通 `getErrorMessage`
（`app/src/api.ts:41-51`）→ `handleConfirm` catch（`app/app/review/[screenshotId].tsx:422-424`）。
唯一成立的用户路径 = 先跳过锚点卡 → 再确认依赖它的互动卡。

② **OCR 变体成新人**（`shared/core/agent/resolve.ts`）：`resolveParticipants`（L504-605）
本地只有精确匹配（`findExactMatches` L266-284，比较 canonical_name 与 aliases）；
1 字 OCR 变体直接交给 LLM，LLM 回 `new`（L587-593）就新建，回 `unsure` 才出消歧——
同一个人随机落两边。unsure 的 source 联合类型 L54 `'exact_multiple' | 'llm'` 是唯一要扩的地方。

③ **无意义更新卡 + 别名拼接**（`shared/core/agent/propose.ts`）：`buildContactChanges`
L846-886 里 L875 `if (currentValue === nextValue) continue;` 是唯一的 no-op 检查
（`normalizeOptionalText` L841 = trim + 小写后全等）；别名追加 L853-858 与
`buildCreateContactPayload` L606-614 都不过滤「姓名+职位/公司」拼接；`changes` 空则
L1111-1113 丢弃卡（所以 no-op 修好卡自然消失）。私有 Levenshtein
`normalizedEditSimilarity` L83-108 目前只给会议标题去重用（L149）。
`normalizeComparableText`（trim + toLocaleLowerCase）在 propose.ts:72、resolve.ts:105、
`app/src/local/batch-contacts.ts:104` 各有一份同体复制。

④ **事实重复**（`shared/core/agent/execute.ts` + 两份 store）：`observations` 表
（`shared/core/schema.ts:40-48`）无 UNIQUE 无索引，只由 `executeCard` 里的
`insertObservationIfAbsent` 写。内存去重 `addObservation`（execute.ts:664-696）的 key 是
`[contactId, screenshotId, kind, normalizedContent, normalizedQuote]`；db 层去重五元组同样含
`screenshot_id` 与 `source_quote`（`server/src/db.ts:1079-1127`，SQL :1090-1110；
`app/src/local/store.ts:660-703`，SQL :668-682）——每次重传 = 新截图行 = 同一事实再插一次。
另外同一事实经两个来源到达：participants 循环 :704-722 带整条消息 quote、facts 循环 :724-741
带短 quote，quote 不同就是两条。

⑤ **传完自动关闭**（只读调查，全文读过，未能定根因）：app **没有任何全局错误处理**
（`ErrorUtils.setGlobalHandler` / `ErrorBoundary` / unhandledrejection 全仓零命中），
release 下任何未捕获的同步 JS 异常走 RN 默认链直接进程退出、无弹窗；未处理的 Promise rejection
在 release 下则被静默吞掉（`react-native/Libraries/Promise.js:17-21`）。主动退出 / 重载零命中
（无 `BackHandler.exitApp`、无 `expo-updates`）。投递收尾链（`app/src/local/api.ts:306-332`
→ `app/src/upload-batch.ts:113-157` → `app/app/(tabs)/index.tsx:298-316` → `router.push`
到 `app/app/review/[screenshotId].tsx`）所有异步回调都有 mounted / token / generation 三重门；
确认页首次挂载会一次性渲染全部截图的全部卡片（`[screenshotId].tsx:611-659`）；流水线结束后
没有页面再渲染截图。三个确凿的原生侧重量项：ML Kit 每张 `TextRecognition.getClient()` 新建
recognizer 且**从不 `close()`**（`node_modules/@react-native-ml-kit/text-recognition/android/src/main/java/com/rnmlkit/textrecognition/TextRecognitionModule.java:168-192`）；
`local/api.ts:165-172` **无条件**先把整张图读成 base64（`app/src/local/image.ts:35-44`），
OCR 路径（:204）只用 `imagePath`、那份 base64 没人读却活到 :325 函数返回；
picker 缓存 `cacheDir/ImagePicker/` 本地模式从不清。候选根因按证据强度：
(1) 未捕获 JS 异常（机制确定、时间点吻合，但 render 路径全读未找到 throw 点）
(2) 原生内存压力被系统回收 (3) recognizer 泄漏导致原生崩溃 (4) 「导出 OCR 原始结果」开关
打开时每张弹一次目录选择器。**仓里没有任何一条能让它变红的日志或判据**——Goal 6 就是先造这把尺子。

⑥ **编辑 / 清空**：联系人详情（`app/app/contacts/[id].tsx:136-148`）、时间线
（`app/src/components/contact-observation-timeline.tsx:7-9`）、人脉与日程列表全部只读；
`RoutedApi`（`app/src/connection/dispatch.ts:28-45`）与 `LocalStore` 接口
（`app/src/local/types.ts:15-44`）没有任何 delete / update；设置页（`app/app/settings.tsx`）
只有模型 Key、服务器地址、云端视觉开关、OCR 导出开关、切换连接方式。sqlite 为
`openDatabaseSync("mailuo.sqlite")`（`app/src/local/store.ts:970-974`），模块级单例
（`app/src/local/runtime-base.ts:20-25`）进程内常开，`close()` 无调用点；
`local/api.ts:95` 的 `batchSessionByCardId` Map 随进程常驻。schema 三处外键
（`shared/core/schema.ts:35, 42, 65`）都没有 `ON DELETE CASCADE` 且 `foreign_keys=ON`。

## Goal

### 1. 映射报错可照做 + 依赖可见

- `LocalBatchContactMappingError` 携带锚点状态与锚点姓名；`confirmedAnchorContactId`
  按锚点状态给**中文** message——
  锚点被跳过（rejected）：「这张互动依赖的『新建联系人 王总』已被跳过，请把这张也跳过，或先手动新建该联系人」；
  锚点未确认（pending）：「请先确认『新建联系人 王总』那张卡」；
  锚点不存在 / 类型不对：「这张互动依赖的新建联系人卡片已不存在，请跳过这张」。
  错误类名与抛出时机不变（`app/src/tests/local-api.test.ts:638` 那条「锚点 pending 时确认要抛」
  的设计断言必须保持）。
- 互动卡「当前归属」行（`review-fields.tsx:261`）：有 `local_batch_deferred` 依赖时显示
  「将关联到本批新建的联系人：王总（待确认）」；锚点已跳过时显示「依赖的『新建联系人 王总』已被跳过」。
  锚点姓名与状态在 hydrate 时带出（`hydrateLocalBatchCardForResponse` 目前只处理
  `disambiguation_candidate`，补 `record_interaction` 依赖的最小 hydrate）。
- `handleReject` 跳过 create_contact 卡前，若本批还有 N 张卡依赖它，先提示
  「后面还有 N 张互动依赖这位联系人，跳过后它们也需要跳过或改为手动关联」再执行。
  app store 需要「统计依赖某锚点卡的卡数」时只加最小查询接口。
- **复现路径加为正式测试**（放 `local-api.test.ts:968` 那条旁）：锚点 create_contact 被 reject
  后，确认已持久化的依赖互动卡 → 抛 `LocalBatchContactMappingError`，message 含锚点姓名与
  「已被跳过」。当前覆盖缺口：`local-api.test.ts` 968-1050 只测锚点被拒的 prepare 阶段，
  没测被拒后再确认依赖卡。

### 2. OCR 变体 → 消歧候选，永不自动关联

- 新模块 `shared/core/text/compare.ts`：把 propose.ts L83-108 的编辑距离挪进来，导出
  `normalizeComparableText`（收掉 propose.ts:72 / resolve.ts:105 两份同体复制，
  batch-contacts.ts:104 那份可顺手改 import、非必需）、`editDistance`、
  `normalizedEditSimilarity`、`normalizeContactText`（NFKC + toLocaleLowerCase +
  去 `/[\p{P}\s]+/gu`）、`tokenize`（按空白与标点切）。propose.ts L149 改 import。
- resolve：精确未命中后跑 `findNearMatches(name, contacts)`——对 canonical_name 与每个 alias，
  `normalizeContactText` 后编辑距离 **=== 1**；参与人名字 ≥ 2 字；**2 字名只允许替换**
  （长度相等），不允许增删（防「王磊」vs「王」）。
- LLM 回 `new` 且 nearMatches ≥ 1 → 结果改为 `status:'unsure'`，`candidate_ids` = nearMatches
  的 id，`source:'near_match'`（L54 联合类型新增）。LLM 回 `unsure` 时 candidate_ids 与
  nearMatches 取并集去重。LLM 回 `same_as` 不受影响。**任何情况下都不自动关联**
  （PLAN 第 0 节：联系人不确定 → 询问，不自动合并）。
- 测试放 `server/src/tests/resolve.test.ts:322` 那条旁；`:389` 隐私断言（DB 侧 prompt 只含
  id/name/aliases/company）必须保持绿——near match 只用同一份 `ResolvableContact` 列表，
  不引入新字段。

### 3. 更新卡 no-op / OCR 噪音抑制 + 别名拼接过滤

- `buildContactChanges` L873-877 换成 `isRedundantFieldValue(current, next)`，**只对
  `company` / `title` 生效**（phone / wechat_id / notes 保持全等比较）。`normalizeContactText`
  之后：全等 / `current.includes(next)`（next 是 current 的截断）/ `tokenize(next)` 每个 token
  都 ∈ `tokenize(current)` / 编辑距离 === 1 且 next ≥ 3 字（3 字值只允许替换）→ 视为同值不出卡。
  **next 更长更具体（含 current 且多出内容）不抑制**——真的补全要保留。
- 别名过滤 `isDerivedAlias(alias, contact, proposed)`：归一化后等于姓名或任一已知名 → 丢；
  以姓名开头或结尾、余部（≥ 2 字）匹配公司/职位（现值或本次提议值）的 token、或整个别名
  就是公司/职位 token 拼接 → 丢；**余部只有 1 字的敬称（王总 / 荀导）保留**。
  同时用于 `buildContactChanges` 别名追加（L853-858）与 `buildCreateContactPayload`
  （L606-614）；`execute.ts:340-350` 合并别名处可选加同一过滤。
- `server/src/tests/propose.test.ts:244`（王总 same_as 王磊 → aliases old:null new:'王总'）
  必须继续绿；新测试放 `:1240`「skips no-op updates」旁。

### 4. 事实按内容去重

- execute.ts `addObservation`：kind ∈ {`fact`, `preference`} 的 key 改为
  `[contactId, kind, content]`（content = `normalizeOptionalString` 之后、真正写库的那个值，
  **不再做有损归一化**，保证内存 key 与 SQL WHERE 口径一致）；两来源撞上保留**较短** quote。
  `interaction` / `status_change` 保持旧五元组 key（它们本来就该逐次记）。
- `server/src/db.ts:1079` 与 `app/src/local/store.ts:660` 的 `insertObservationIfAbsent`
  同步：fact / preference 用 `WHERE contact_id = ? AND kind = ? AND content = ? LIMIT 1`，
  命中返回旧行；若新 quote 更短可更新 `source_quote`，**不动 observed_at、不动 screenshot_id**。
  其余 kind 保持现有五元组 SQL。
- **不加 UNIQUE 索引**（现有设备库已有重复行，建索引会失败，为此写迁移不值）。
- 测试：`server/src/tests/execute.test.ts:138`「avoids duplicate facts」旁加用例（同一联系人
  同一 fact 从两张截图 / participants 与 facts 两个来源到达 → 只 1 行，quote 取较短）；
  `app/src/tests/local-api.test.ts:361-390` 的 FakeLocalStore 五元组 key 跟着改语义；
  `server/src/tests/app.test.ts:1285` 断言 `observations.length === 2` **复核是否受影响**，
  受影响就在报告里说明那两条 observation 是什么、为什么该合并或不该合并。

### 5. 依据原文取最短句

- execute.ts participants 循环（:704-722）：把 `participant.source_quote` 按 `。！？\n` 切句，
  取**含该 fact 值**的最短句做 quote；没有任何句含该值则保留整条。
- `shared/core/llm/prompts.ts` 视觉版（~L173）与文本版（~L209）各加一句
  `source_quote should be the shortest span that supports the extracted fields.`
- prompt 快照照 fix2 惯例（见 `git show 4295221 -- app/src/tests/perception-text.test.ts`）：
  `docs/perception-baseline/perception-prompts.before-v3-m4-fix3.json` 应与 fix2 的 after
  逐字相同（sha256 前缀 `9c135c04`），`perception-prompts.after-v3-m4-fix3.json` 含新规则，
  快照测试断言两版都含最短 span 规则。

### 6. 崩溃可见：崩溃记录器 + 错误边界 + 两处有证据的原生加固

- **崩溃记录器**：新模块 `app/src/diagnostics/crash-record.ts`。在 `app/app/_layout.tsx` 最早的
  位置包一层 `ErrorUtils.setGlobalHandler`：先**同步**写入一条记录（用仓里已有的同步存储机制，
  或 expo-sqlite 的 `Storage.setItemSync`；进程马上要退出，异步写不保证落地），再调用原有 handler
  （保持 RN 默认行为，不吞 fatal）。记录字段：时间、`name`、`message`、堆栈前 8 帧、`isFatal`、
  app 版本、最近路由、批次进度（第几张 / 共几张，由上传页与确认页通过 `setCrashContext()` 上报）、
  「导出 OCR 原始结果」开关状态、若 `global.HermesInternal?.getInstrumentedStats?.()` 可用则附
  JS 堆数字。**不建表、不动 schema。**
- **下次启动可见**：根布局启动时读到记录 → 弹一个可截图的「上次异常退出」面板（name / message /
  堆栈前 8 帧 / 路由 / 批次进度），「知道了」清除记录。owner 只需截图，不导文件。
- **错误边界**：一个最小 `ErrorBoundary` 组件包住 `<Stack>`，`componentDidCatch` 写同一条记录，
  渲染错误页（同样字段 + 「回到首页」按钮）。它本身就是判别实验：装上后症状若从「消失」变成
  「错误页」，根因就是 render 期异常。
- **原生加固 a — recognizer 关闭**：照 `app/scripts/patch-mlkit-confidence.mjs`（postinstall
  补丁）同款方式，在 `TextRecognitionModule.java` 的 task 完成回调里 `recognizer.close()`
  （Google 文档要求的用法）。补丁脚本要幂等、带 needle 断言，`npm install` 后能重复跑。
- **原生加固 b — base64 懒加载**：`local/api.ts:165-172` 改为 OCR 路径不读 base64，只有真的走
  云端视觉（或 OCR 失败回退）时才读；保持现有回退语义。加测试：OCR 成功路径不触发图片 base64 读取。
- **不做**：原生内存统计模块、删 picker 缓存、`largeHeap`（没有证据支撑，等崩溃记录回来再定）。

### 7. 设置 → 清空全部数据

- `LocalStore` 接口（`app/src/local/types.ts`）加 `clearAllData()`；`store.ts` 实现为单事务
  按外键顺序 `DELETE FROM insights; observations; meetings; action_cards; screenshots; contacts;`
  （不关库、不删库文件——`runtime-base.ts` 单例握着句柄，关库改动面太大）。
  `local/api.ts:95` 的 `batchSessionByCardId` 一起 `.clear()`。
- `RoutedApi`（`dispatch.ts`）加方法并转发；`app/src/api.ts` 的 server 实现抛「服务器模式暂不支持」，
  设置页在 server 模式下隐藏该入口。
- UI：`settings.tsx` 新 SectionCard「清空全部数据」+ 二次确认（`Alert.alert`，app 目前无 Alert，
  从 react-native 引入即可）→ 调 api → `resetFlow()`（`flow-context.tsx:707-715`；`:708` 有
  in-progress 项时会拒绝，按 `settings.tsx:21` 的 `hasInProgressFlowItems` 先禁用按钮）；
  确认 `contactDetailsById` 等缓存随之清空，否则详情页会显示已删数据。
- **不清**：模型 Key、服务器地址、各开关（文案写明「Key 与设置保留」）。
- 测试：清空后 contacts / observations / action_cards / meetings 为空，旧 cardId 的确认返回未找到；
  FakeLocalStore 同步加 `clearAllData()`。

## 已否决（别再提议，也别绕道实现）

- **自动新建被跳过的锚点联系人**：覆盖用户的跳过决定，要加 rejected→confirmed 状态机，风险最高。
- **持久化临时→真实 id 映射**：不是问题所在——映射在锚点确认时已写回 sqlite，问题是锚点被拒后依赖卡无路可走。
- **observations 加 UNIQUE 索引 + 迁移**：现有设备库已有重复行。
- **让 resolve 自动把编辑距离 1 的名字关联到旧联系人**：OCR 变体和真的另一个人分不开，只能出消歧让用户点。
- **回填清理历史数据**：3.1.2 之前生成的旧 observation 与已有重复行不动（fix2 也没回填，设备数据不动是惯例；owner 要清用 Goal 7）。
- **给闪退硬猜一个根因去修**：没有一条能让它变红的证据，先上记录器与错误边界；只做上面两处有代码证据的原生加固。
- **联系人 / 事实的编辑、删除、合并**：那是下一个里程碑（M5）的范围，本批只给「清空全部」。

## 施工分两批（同一份任务书，两次派活，版本只升一次）

- **批 A = Goal 2、3、4、5**（`shared/core` 规则层 + 两份 store 的 `insertObservationIfAbsent` + prompt 快照）
- **批 B = Goal 1、6、7**（app 侧：本地批次映射、崩溃记录、清空数据）
- 每批自验全绿后各自 commit + push；批 B 在批 A 的 commit 之上做。版本号两批都不动。

## Scope

- 可动（批 A）：`shared/core/agent/resolve.ts`、`propose.ts`、`execute.ts`、`shared/core/llm/prompts.ts`；
  新增 `shared/core/text/compare.ts`；`server/src/db.ts` 与 `app/src/local/store.ts` 的
  `insertObservationIfAbsent`（两端同步）；测试；prompt 快照。
- 可动（批 B）：`app/src/local/batch-contacts.ts`（错误类携带锚点信息 + record_interaction 依赖 hydrate）、
  `app/src/local/api.ts`（懒加载 base64、clearAllData、batchSessionByCardId 清理）、
  `app/src/local/store.ts` / `types.ts`（clearAllData + 最小新增查询）、`app/src/connection/dispatch.ts`、
  `app/src/api.ts`（错误文案透传 + server 侧 clearAllData 占位）、
  `app/src/components/review/review-fields.tsx`、`app/app/review/[screenshotId].tsx`（handleReject 依赖提示 +
  crash context 上报）、`app/app/(tabs)/index.tsx`（仅 crash context 上报）、`app/app/_layout.tsx`、
  `app/app/settings.tsx`、新增 `app/src/diagnostics/`、新增错误边界组件、
  `app/scripts/`（recognizer close 补丁）、测试。
- 不可动：数据库 schema / migrations、`action_cards.type` CHECK、卡片拆分与确认行为、
  M4 / fix1 / fix2 已交付行为、`/api/screenshots`、`server` 模式的 resolve 走向（同一份
  shared/core 代码，改动对两端一致即可，不为 server 单开分支）、OCR 识别算法本身。
- 不新增依赖；不回填历史数据；不动 `app/app.json` 版本号。

## Constraints

- PLAN 第 0 节适用（宁可留空不要猜错：F2 只出候选不自动合并）；中文 commit；自验全绿才 commit + push origin main
- prompt 快照前后各存一份，报告贴 diff
- 示例与测试数据一律用虚构名（王磊 / 王总 / 荀导 / 某集团 市场部）
- 有边界疑问报 BLOCKED / NEEDS_CONTEXT 停下，不要自行扩 scope

## Done when

**批 A**

1. 两端 `npm test` + `npx tsc --noEmit` 全绿；server 不低于 146、app 不低于 88（新增测试计入）；
   `git diff --check` 干净
2. **F2 有测试**：库中有「王磊」，参与人「王蕾」且 LLM 回 new → `unsure` + candidate_ids 含王磊 +
   source `near_match`；「王磊」vs「王」不算近似；LLM 回 same_as 不受影响；`resolve.test.ts:389` 保持绿
3. **F3 有测试**：company 现值「某集团市场部」，next 为「某集团 市场部」/「市场部」/ 差一字 →
   不出更新卡；next「某集团市场部品牌组」→ 出卡；别名「王磊集团副总」/「集团副总王磊」→ 丢弃；
   「王总」保留（`propose.test.ts:244` 不变）
4. **F4 有测试**：同一联系人同一 fact 从两张截图 / 两个来源到达 → observations 只 1 行且 quote 较短；
   interaction 仍逐次记；`app.test.ts:1285` 复核结论写进报告
5. **F5**：before 快照 sha256 前缀 `9c135c04`，after 含最短 span 规则，快照测试断言
6. 报告贴真实测试输出、快照 diff、文件清单、偏离决定（含 NEEDS_CONTEXT 的问题原文）

**批 B**

1. 同批 A 第 1 条（基线以批 A 交付后的数字为准，只增不减）
2. **F1 有测试**：锚点被跳过后确认已持久化的依赖互动卡 → 抛 `LocalBatchContactMappingError`，
   message 为中文、含锚点姓名与「已被跳过」；`local-api.test.ts:638` 原断言保持
3. **F6**：全局 handler 与错误边界都能写出记录（测试：伪造一次 fatal → 记录含 name / message / 路由）；
   启动读到记录会展示面板；补丁脚本幂等且 needle 断言通过（报告贴补丁后的 Java 片段）；
   OCR 成功路径不读 base64 有测试
4. **F7**：清空后六张表为空、旧 cardId 确认返回未找到、Key 与设置保留（测试）；server 模式入口隐藏
5. 报告贴真实测试输出、文件清单、偏离决定
