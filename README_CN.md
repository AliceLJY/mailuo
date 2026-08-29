# 脉络 Mailuo

英文版： [README.md](README.md)

脉络 Mailuo 把聊天截图变成结构化行动卡片、联系人记忆和有依据的关系洞察。

| 上传 | 人脉档案 | 日程 |
|---|---|---|
| ![上传](docs/screenshots/web-upload.png) | ![人脉](docs/screenshots/web-contacts.png) | ![日程](docs/screenshots/web-meetings.png) |

> 截图为 web 版界面（Expo web 输出）；Android 原生版界面一致。图中人物、公司均为合成测试数据。

**v2 双模式真机界面**（Android，BYOK 单机版）：

| 首次启动选择 | 模型 Key 管理 | 设置 |
|---|---|---|
| ![引导页](docs/screenshots/device-onboarding.jpg) | ![Key 管理](docs/screenshots/device-api-key.jpg) | ![设置](docs/screenshots/device-settings.jpg) |

## 架构

```text
+--------------------------------+
| 应用层                         |
| - iOS PWA                      |
| - Android native               |
| - 上传 / 审核 / 人脉           |
| - 日程                         |
+----------------+---------------+
                 |
                 | HTTPS / /api
                 v
+----------------+---------------+
| 服务端                         |
| - Fastify                      |
| - node:sqlite (DatabaseSync)   |
| - 本地截图存储                 |
+--------+---------------+-------+
         |               |
         | 截图二进制    | 最小化联系人上下文
         v               v
+--------+-------+   +---+-----------------------+
| Qwen-VL        |   | DeepSeek                  |
| 感知           |   | 人物归并与洞察            |
| qwen-vl-max    |   | deepseek-v4-flash         |
+----------------+   +---------------------------+
```

只有 Qwen 会接收原始截图二进制。DeepSeek 不会接收原始图片文件，但会接收当前任务所需的截图抽取文本：`source_quote`、`facts`、`quotes`、`events`，以及人物归并所需的最小联系人摘要，或有依据洞察所需的档案与 observation 上下文。

## Agent 环

1. 感知：把截图和可选备注发给 Qwen-VL，得到结构化抽取 JSON。
2. 归并：先用 canonical name 和 aliases 命中已有联系人；精确命中失败时，再让 DeepSeek 判断 `same_as`、`new` 或 `unsure`。
3. 提议：把抽取结果变成可编辑的行动卡片，例如 `create_contact`、`update_contact`、`create_meeting`、`record_interaction`，每张卡都带 `confidence` 和 `source_quote`。
4. 人工确认：用户可以编辑字段、处理歧义、确认或拒绝每张卡。
5. 执行：把确认后的联系人、会议、别名和 observations 写回 SQLite。
6. 有依据的洞察：生成关系解读、建议行动和话头，每条都必须引用 `based_on` observation 证据。

这不是一个套壳产品，证据有三点：

- 系统返回的是结构化、可执行的卡片，不是一段自由文本。
- 人物归并会把别名裁决写回 memory，联系人档案会越用越准。
- 每条洞察都必须落在已存 observation 上，而不是只看一张截图即兴发挥。

## Memory 设计

脉络 Mailuo 把 memory 设计映射到 Atkinson-Shiffrin 模型：感觉记忆、工作记忆、长期记忆。

| 层 | 存储单元 | 生命周期 | 对应关系 |
| --- | --- | --- | --- |
| 感觉层 | `screenshots` 表的 `raw_extraction` 列 | 感知完成后主要用于溯源 | 感觉记忆 |
| 工作层 | `action_cards` 里处于 `pending` 状态的记录 | 等待用户确认或拒绝 | 工作记忆 |
| 长期层 | `contacts`、`observations`、`meetings`、`insights` 中持续累积的记录 | 按人持续累积 | 长期记忆 |

长期记忆内部有两种更新语义：

- 档案字段：结构化 `Contact` 列变化慢，只在用户确认后更新。被确认的变更还会留下 `Observation` 轨迹。
- 流水事实：`Observation` 只追加不回写，每条都锚定原文和时间。

这个拆分让模型既能用档案字段回答“这个人是谁”，也能用 observation 时间线回答“关系怎样在变化”。

## 工程故事

这个项目是靠三层测试漏斗打磨出来的。

- Mock 漏斗：在 M4 交付检查点，测试用例从 53 增长到 74，并保持全绿，覆盖 schema、提议、归并、执行、路由行为和有依据的洞察。
- 当前 M4 基线：mock suite 现在是 87/87 全绿，新增覆盖点集中在 provider 默认值、自身联系人防护、部分上传清理、无时间信号会议折叠，以及同源静态托管。
- 真调层：维护者用真实密钥验收时，抓出了 4 个 prompt 层问题，mock 之前没有兜住。系统曾经会把用户自己的 `我` 建成联系人、把公司变更塞进 `notes` 而不是 `company`、把“回头再聊”这种没有时间信号的话生成为会议，以及在 token 上限过小时截断洞察 JSON。
- 真机层：iPhone 和 Android 又抓出了 2 个平台问题。Expo SDK 57 的原生上传不再接受旧式 React Native `{ uri, name, type }` 部件，所以应用改成标准 `Blob` 和 `File`；web 端因为 Metro 开发服务器和 API 服务器分属不同端口，也需要补 CORS。

## 快速开始

前提是 Node 26 或更高版本。

1. 安装依赖。

```bash
cd server
npm install
```

```bash
cd app
npm install
```

2. 准备环境变量文件。

```bash
# server/.env
DASHSCOPE_API_KEY=
QWEN_MODEL=qwen-vl-max
QWEN_TEXT_MODEL=qwen-plus
# 选填：留空时，归并与洞察会通过 DashScope 使用 Qwen。
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
PORT=3000
```

只有 DashScope Key 是必填项。填写 DeepSeek Key 后，归并与洞察会改用 DeepSeek；不填则继续使用 Qwen。

```bash
cp app/.env.example app/.env
```

```bash
# app/.env
EXPO_PUBLIC_API_URL=http://<你的局域网 IP>:3000
```

如果要走同源 web 部署，执行 `bash scripts/build-web.sh` 时会强制把 `EXPO_PUBLIC_API_URL` 置空，让打包后的客户端固定走 `/api`。

3. 在仓库根目录打开两个终端，分别启动服务端和应用。

```bash
# 终端 1
cd server
npm run dev
```

```bash
# 终端 2
cd app
npm run start
```

4. 构建用于同源部署的 web 产物。

```bash
bash scripts/build-web.sh
```

这个脚本会以同源 API 路径导出 web 版，并同步到 `server/public/`。

## 构建与部署文档

M4 的构建和部署入口在 [deploy/README.md](deploy/README.md) 和 [scripts/build-web.sh](scripts/build-web.sh)。仓库里已经包含 `launchd` plist、安装脚本、Tailscale serve 示例，以及 Expo EAS 预览 APK 配置，但 Mac mini 上的实际部署仍然需要维护者手动执行。

## 隐私边界

- **BYOK 本地模式**：档案与导入的截图文件只保存在用户手机本地；推理时由 app 直接连接模型服务商，全程没有脉络中间服务器。模型 Key 只存入系统钥匙串（iOS Keychain / Android Keystore），界面永远不会回显全文。
- 应用数据存放在服务端主机本地的 SQLite。
- 截图文件本地存放在 `server/data/screenshots/`。
- 原始截图二进制只会在感知阶段发给 Qwen。
- **通过「粘贴文本」入口提交的内容，会原样发送给所配置的文本模型**（DeepSeek，或未配置 DeepSeek 时的 DashScope Qwen 文本模型）用于抽取，不经过视觉模型。粘贴什么就发送什么，请自行判断内容敏感度。
- DeepSeek 不接收原始图片。人物归并时，它只接收身份判断所需的截图抽取文本，例如 `source_quote`、`facts`、`quotes`、`events`，以及最小联系人摘要。
- 洞察生成时，DeepSeek 只接收已落库的截图证据文本，以及生成有依据输出所需的最小档案与 observation 上下文。未配置 DeepSeek 时，上述文本任务由 DashScope 的 Qwen 文本模型完成，数据不发往 DeepSeek。
- **说白了**：档案的存储是全本地的，但推理阶段截图与相关文本会到达模型服务商（阿里云 / DeepSeek），受其各自的数据政策约束。介意这一层的用户可以走下一条。
- **全本地路线（架构已支持，改环境变量即可）**：两个 provider 均走 OpenAI 兼容接口，可直接指向本地推理服务（如 Ollama / vLLM）——设置 `DASHSCOPE_BASE_URL` / `DEEPSEEK_BASE_URL` 指向本机端点、`QWEN_MODEL` / `DEEPSEEK_MODEL` 换成本地模型（视觉可用开源 Qwen-VL 系列），即可实现数据全程不出本机。注意本地小模型的抽取与洞察质量会相应下降，请自行评估。
- 当前部署还是单用户，没有应用层鉴权。
- 现在的实际访问边界取决于局域网或 Tailscale 的暴露范围。
- 面向多用户的鉴权和隔离仍是后续工作。

## 已知限制

- 视觉模型识别文字时会有小概率错字。维护者实测同一张图里的公司名一次识别为 `澄曜实验室`，另一次识别为 `潜曜实验室`，所以确认卡仍然要给人工核对重要字段。
- 重复上传同一张截图时，当前会重复累计观测和会议。维护者实测同图连续上传三次后，单个联系人出现 22 条观测，日程里出现两条相同会议；系统现在还不会自动去重。

## 后续工作

- **v2 分支已实现三种使用方式**：一个安装包现在提供①**API Key 本地模式**，用户填自己的模型 Key，整套处理在原生 app 内运行；②**自部署服务器模式**，连接用户自己的脉络后端；③灰色禁用的**订阅服务**占位，标注“敬请期待”。网页版仅支持服务器模式，本地模式为原生 app 专属。
- iOS 原生分发：当目标地区的 App Store 不提供 Expo Go 时，iOS 原生分发需要 Apple Developer 账号，再配合 EAS 和 TestFlight。
- 同图检测与合并。
- 洞察重试端点。
- 洞察定时主动推送。
- 系统日历集成。
- 消息应用直连。
- 群聊与多人参与场景优化。
- 多用户与鉴权。
