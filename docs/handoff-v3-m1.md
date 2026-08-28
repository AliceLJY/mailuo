# 脉络 Mailuo — v3-M1 施工交接（本地 OCR 感知：识字与理解分离）

## 你的角色

新一批，动的是 `perceive` 主路径。施工图 `~/Projects/mailuo/PLAN.md`，v2.0.0 刚发布并真机验收通过。
先 `git log -5` 同步认知再动手。**自验用本机 Node 26。**

本批只做 OCR 感知替换。批量上传是下一批（v3-M2），本批不要碰上传 UI。

## 背景：为什么拆

当前 `perceive` 让 Qwen-VL 同时做两件事：识字（把截图里的字读出来）和理解（把文字变成人物/事件/事实/引用）。
这两件事的难度完全不同——理解值得花 API 钱，识字在本机做就够了。

逐字段核对过 `shared/core/agent/perceive.ts` 的 schema 与 `shared/core/llm/prompts.ts:187` 的提示词：
四类输出里只有两处真正依赖视觉，`participants.is_self` 和 `quotes.speaker_name`，
本质是同一个问题（气泡归属）。其余全部文本可得。

**收益不在省钱**（实测过，输入 token 只降 33%，因为提示词那 1,100 token 是固定开销），
在于三条：原始截图不再离开本机；读图从 13-24 秒降到秒级；BYOK 从两个 key 降到一个。

## 可以直接搬的东西（隔壁项目 `~/Projects/tenglu`，同一个作者，已真机验收）

誊录 v0.3.0 已经把这条路走通并发版，直接复用，不要重新发明：

1. **OCR 引擎**：`@react-native-ml-kit/text-recognition` 版本 `2.0.0`（见 `tenglu/package.json:15`）
2. **必需的 patch**：`tenglu/scripts/patch-mlkit-confidence.mjs`，作为 `postinstall` 跑。
   官方 2.0.0 的 `TextRecognitionModule.java` 不返回 `line.getConfidence()`，这个补丁把它加回来。
   补丁会校验包版本，版本不符直接抛错拒绝打——保留这个行为，不要改成静默跳过。
3. **像素采样模块**：`tenglu/modules/tenglu-region-sampler/` 整个目录复制过来。
   `sampleRegions(requests)` 接口是 `{id, uri, x, y, width, height}` → `{side: "me"|"them"|null, rgb, ...}`，
   只需要图片 uri 和矩形，不依赖视频帧，脉络能直接用。
   **有意保留原模块名与 Kotlin package 名**（`com.aliceljy.tenglu.regionsampler`）：
   两个 app 不会同时安装，改名要动 Kotlin + gradle + expo-module.config 三处，
   收益只是可读性、成本是三处出错面。在复制过来的目录里加一行注释说明来源即可。
4. **底色阈值**：`tenglu/src/postprocess.js:64-66`，白色地板 245（每通道严格大于）。
   绿色（自己）判据是 `G-B >= 40`。两条都不满足时返回 `null`。

**必读的一条教训**（`tenglu/PLAN.md:587`）：纯文本框坐标判不出满宽消息的发言人。
微信左右气泡布局对称，消息只要占满气泡宽度，左右两侧的 `x/w` 完全一致
（实测 13 条双贴峰行全部是 `x=134 右=585 w=451`，分属不同发言人）。
纯坐标裸能力只有 85.4%，靠局部像素采样才回到满分。
**不要试图用更聪明的纯坐标算法绕过去**，那节里的 13 条数据就是证明。

## Goal

### 1. 新增本地 OCR 感知路径

新建 `app/src/local/perceive-ocr.ts`（或你认为更合适的位置，但必须在 app 侧，不进 `shared/`——
`shared/` 要保持能在 server 的 Node 环境跑，ML Kit 是原生模块）。

流程：

```
截图 uri
  -> ML Kit 识别，拿到每行的 text + frame(x,y,width,height) + confidence
  -> 按 x 分左右；满宽行（左右都够不到边距差）标为歧义
  -> 歧义行调 sampleRegions 采样气泡底色，定 side
  -> 输出 { lines: [{ text, side, x, y, width, height, confidence }], warnings: [...] }
```

判定规则，逐条照做：

- `side` 只有三种值：`"me"` / `"them"` / `null`
- 采样返回 `null`（两条阈值都不满足）时**不猜**，该行 `side` 记 `null` 并写一条 warning
- `warnings` 非空时整个结果标 `degraded: true`

### 2. 文本版感知提示词

`shared/core/llm/prompts.ts` 增加 `buildPerceptionTextSystemPrompt(now)`，与现有视觉版并存、不删不改现有的。

与视觉版的差异只有两处，其余规则（时间解析、会议 vs 单向承诺、结构化字段、confidence）逐字保留：

- 输入描述：从"截图"改为"一段已标注发言人的聊天文本"
- `is_self` 判据：从 `right-side bubbles` 改为"按每行给出的 `side` 标记，`me` 即设备主人"；
  `side` 为 `null` 的行，`is_self` 判断只能依据文本内容（例如出现"我"），不得猜测

**一个必须写进提示词的语义变化**：现在 `source_quote` 要求"逐字复制自截图"，
拆开之后它变成"逐字复制自 OCR 文本"。OCR 认错字时，用户在确认卡上看到的证据引用也会是错字。
这是有意接受的代价（确认卡本来就是给人核对的），但提示词里要写清楚它引用的是给定文本，不是原图。

### 3. 接线与回退

只改 `app/src/local/api.ts:51` 这一处感知调用。**不动** `server/src/app.ts:456`、
`server/src/cli.ts:65`，也不动 web——服务器模式和 web 版继续走 Qwen-VL，本批不碰。

回退规则：

- OCR 抛错、识别到的文本行数为 0、或 `degraded: true` → 回退到原 Qwen-VL 路径，走完整视觉感知
- 回退发生时在结果页给普通用户能懂的一句话（参考誊录的做法："部分内容可能识别不全，已用云端模型重新处理"），
  不要把 side / RGB / confidence 这些内部明细暴露给用户
- 加一个设置项让用户强制走云端视觉路径（对应誊录的"处理路径开关"）

### 4. 质量对比脚本（先跑，结果决定后面怎么调）

新增 `scripts/compare-perception.mjs`：同一张截图分别走 OCR 路径和 Qwen-VL 路径，
输出两份抽取 JSON 的字段级差异（哪些字段一致、哪些不一致、各自的 source_quote）。

这个脚本是本批的第一步，不是收尾——**先拿它跑 fixtures 里那三张，看差异长什么样，再决定提示词怎么调**。
`fixtures/screenshot-{1,2,3}.png` 是 HTML 渲染的合成数据、不是真实微信截图，
所以它只能保证不回归，不能证明真实场景可用。真实截图的验收由 owner 在真机上做。

## Scope

- 可动：`app/`、`shared/core/llm/prompts.ts`、`scripts/`、`docs/`、`package.json`
- 不可动：`server/src/app.ts` 与 `server/src/cli.ts` 的感知调用、`shared/core/agent/` 下 resolve/propose/execute/insight 的行为、
  数据库 schema、上传 UI（下一批）
- 不新增上面未列的依赖

## Constraints

- PLAN 第 0 节全部适用；`// simplified:` 照旧；中文 commit message；自验全绿才 commit，一批一个 commit
- `perceiveScreenshot` 的函数签名与返回类型不变——它是依赖注入点（`server/src/app.ts:413`），
  改签名会波及 server 和测试
- 现有 74 个用例必须全绿，不许为了让新路径通过而改断言
- 采样返回 `null` 时宁可告警也不猜，这条是产品承诺不是实现细节

## Done when（逐条跑，贴真实输出）

Mac 侧：

1. `cd server && npm test` 全绿 + `npx tsc --noEmit` 零报错
2. `cd app && npx tsc --noEmit` 零报错
3. `node scripts/compare-perception.mjs fixtures/screenshot-1.png` 能跑出两条路径的字段级差异表，
   贴出完整输出
4. 三张 fixtures 全跑一遍，说明每一处字段差异是"OCR 认错字"、"提示词理解差异"还是"缺陷"
5. 构造用例覆盖三条降级路径：OCR 抛错、零文本行、采样全部返回 `null`，
   三种都要能正确回退到 Qwen-VL 且不崩

真机侧（owner 跑，你只需保证 APK 可构建）：

6. `npx expo config --type public` 不报错，`eas.json` 的 preview profile 仍能出 APK

完成后照旧：逐条贴实际输出、列文件清单、说明偏离决定及理由。
**如果第 4 步发现 OCR 路径的抽取质量明显差于 Qwen-VL，停下来报告，不要自己调提示词硬凑**——
那种情况下的正确处置是把默认路径反过来（默认云端、OCR 作为可选），而不是让数字看起来好看。

## 下一批预告（v3-M2，本批不做）

批量上传：一次选多张、按顺序处理、单张失败不中断整批、进度可见。
成本是线性的（10 张 = 10 次 LLM 调用），这一点要在 UI 上让用户有感知。
