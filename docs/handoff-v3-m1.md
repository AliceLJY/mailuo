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
   `sampleRegions(requests)` 的请求项是 `{id, frameIndex, uri, x, y, width, height}`，
   **`frameIndex` 必填**（Kotlin 侧 `item.getInt("frameIndex")` 不给会抛）——脉络是单张静态图，固定传 `0`。
   返回的是**批对象** `{samples: RegionSample[], decoderCount, elapsedMs}`，不是裸数组；
   每个 sample 才是 `{id, side: "me"|"them"|null, rgb, ...}`。
   除 `frameIndex` 外只需要图片 uri 和矩形，不依赖视频帧，脉络能直接用。
   **有意保留原模块名与 Kotlin package 名**（`com.aliceljy.tenglu.regionsampler`）：
   两个 app 不会同时安装，改名要动 Kotlin + gradle + expo-module.config 三处，
   收益只是可读性、成本是三处出错面。在复制过来的目录里加一行注释说明来源即可。
4. **底色阈值**：白色地板 245（每通道严格大于，见 `tenglu/src/postprocess.js:64-66`）。
   绿色（自己）判据是 **`G - B > 40`，严格大于**——
   JS 侧 `tenglu/src/postprocess.js:62` 与 Kotlin 侧
   `tenglu/modules/tenglu-region-sampler/android/src/main/java/com/aliceljy/tenglu/regionsampler/TengluRegionSamplerModule.kt:396`
   两处一致。两条都不满足时返回 `null`。

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

### 4. 质量闸门（分两段，Mac 侧这段现在就能做）

**这一节 2026-08-29 重写过。** 初版把"同素材双路径对比"写成施工前的第一步，那是错的：
生产 OCR 是 React Native 原生 ML Kit，Node 脚本调不到；而脉络此刻还没有 OCR 实现，
也就产不出可比的 OCR 结果。誊录当初也是**先实现、再在第四轮加导出开关、拿真机 bundle 回 Mac 离线对比**，
顺序本来就是这样。不要为了让闸门跑起来去连 ADB 或拿 Mac Vision 顶包。

闸门拆成三半，各自的证据来源不同：

**半 A —— ML Kit 读微信界面准不准：已有答案，不必重测。**
誊录 v0.3.0 真机实测（同一个 ML Kit 引擎、同一类微信界面）：字符级 **91.4%**，
群聊段内容召回 59/60，失分几乎全是认错一两个字（硬→便、懂→憧、接→援），不是整行崩掉。
出处 `tenglu/PLAN.md:999` 那节。直接引用，不要重跑。

**半 B —— Qwen-VL 在同一批图上准不准：Mac 侧现在就能测，本批要做。**
Qwen-VL 是云端 API，Node 直接调得到。新增 `scripts/perception-baseline.mjs`：
对 `fixtures/screenshot-{1,2,3}.png` 跑现有视觉路径，把抽取 JSON 落盘成基线快照。
这份快照有两个用途——给半 C 当对照组，以及在你改 `prompts.ts` 之后回归验证视觉路径没被改坏。

**半 C —— 同素材严格对比：推迟到真机批，本批不做。**
参照誊录 `verify/M3-DEVICE-ACCEPTANCE.md` 的形态：app 内加一个导出开关，
把 OCR 原始结果（每行 text/x/y/w/h/conf + side 判定 + warnings）写成单个 JSON，
owner 在真机上跑完用系统目录选择器导出、回传到 Mac，再离线比对。
**全程不需要 USB 或 ADB**，誊录整个 M3 都是这么验的。
本批只需要保证这个导出开关做出来、格式定好，不需要拿到数据。

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
3. `node scripts/perception-baseline.mjs` 对三张 fixtures 跑通视觉路径并落盘基线快照，贴出完整输出。
   需要 `DASHSCOPE_API_KEY`；owner 已配置，缺失时报清晰错误而不是静默跳过
4. 改完 `prompts.ts` 之后重跑第 3 步，确认视觉路径的抽取结果与改动前**逐字节一致**——
   本批新增的是平行的文本版提示词，视觉版一个字都不该变。有差异就是改错了地方
5. 构造用例覆盖三条降级路径：OCR 抛错、零文本行、采样全部返回 `null`，
   三种都要能正确回退到 Qwen-VL 且不崩
6. OCR 结果导出开关做出来：格式定义写进 `docs/`，并用一个构造的 OCR 结果验证能导出成合法 JSON
   （不需要真机数据，只验格式与落盘）

真机侧（owner 跑，你只需保证 APK 可构建）：

7. `npx expo config --type public` 不报错，`eas.json` 的 preview profile 仍能出 APK

完成后照旧：逐条贴实际输出、列文件清单、说明偏离决定及理由。

**关于质量判断**：本批不判 OCR 路径的抽取质量，因为拿不到同素材证据（理由见 Goal 第 4 节）。
真机 bundle 回来之后才判，判据是：OCR 路径的抽取结果与视觉基线相比，
每一处字段差异要能归到"OCR 认错字"、"提示词理解差异"还是"缺陷"三类之一。
**如果那时发现 OCR 路径明显差于 Qwen-VL，正确处置是把默认路径反过来（默认云端、OCR 作为可选），
不是调提示词让数字好看。** 这句话现在写在这里，是为了那时候不用重新讨论一遍。

## 下一批预告（v3-M2，本批不做）

批量上传：一次选多张、按顺序处理、单张失败不中断整批、进度可见。
成本是线性的（10 张 = 10 次 LLM 调用），这一点要在 UI 上让用户有感知。
