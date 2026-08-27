# 脉络 Mailuo — v2.0 施工交接（V2-M1：核心逻辑抽取）

## 你的角色与背景（新窗口冷启动，先读完这节）
你是本项目的施工工程师。项目现状：v1.0（自部署版）已完整交付并发布——公开仓 + Release APK + 生产部署，**main 分支必须保持可演示状态**（维护者近期有答辩）。动手前先读 `~/Projects/mailuo/PLAN.md`（v1 施工图，了解现有架构与纪律）和本材料。发现矛盾停下来说明，不自行改设计。**自验一律用本机默认 Node 26，禁止用 npx 拉其他 Node 版本替代**（v1 期间的教训，已成铁律）。

## v2.0 总体设计（三批完成，本批只做第一批）
目标：**一个安装包、两种连接模式 + 一个占位**。app 首次启动出现模式选择：
- **API key 模式（BYOK 单机版）**：用户填自己的 dashscope / deepseek key，整套 agent 流水线在 app 内本地运行，档案存手机本地 SQLite，无需任何服务器；
- **服务器模式**：填自部署后端地址（v1 现有形态）；
- **订阅模式**：仅 UI 占位（"敬请期待"，禁用态）。

五条核心设计决策（已定，不要重新论证）：
1. **同形接口层**：现有 `app/src/api.ts` 的函数签名与返回形状（`uploadScreenshot / confirmCard / rejectCard / getContacts / getContactDetail / getMeetings / getScreenshotDetail`，`{ok,data}` 语义的 data 部分）就是两种模式的公共契约。本地模式实现同签名函数集，UI 层零改动。
2. **共享逻辑抽取**：server 里平台无关的纯逻辑（prompts、zod schemas、propose 规则、resolve 匹配逻辑、resolve-time 时间解析、insight 过滤、OpenAI 兼容 provider 调用）上提到 `shared/core/`；平台绑定（数据库、文件存储）抽象为接口，server 与 app 各自实现。
3. **app 本地存储用 expo-sqlite**（schema 与 v1 的 schema.sql 同构）；**key 存 expo-secure-store**（系统钥匙串），绝不进 AsyncStorage 或代码。
4. **web 版不做本地模式**（expo-sqlite 的 web 支持复杂度不值得）：web 维持服务器模式，模式选择界面在 web 上只展示服务器选项。README 届时说明。
5. **v2 全程在分支 `v2-byok` 上开发**，main 不动。本批第一个动作就是 `git checkout -b v2-byok`。

里程碑：V2-M1 核心逻辑抽取（本批）→ V2-M2 app 本地模式实现 → V2-M3 模式选择 UI 与真机验收。

## Goal（本批 = 仅 V2-M1）
1. 建 `git checkout -b v2-byok` 分支，本批所有 commit 在此分支。
2. 新建 `shared/core/` 目录，从 `server/src/` 上提以下内容（**移动 + 调整 import，不是复制**，避免双份真相源）：
   - `llm/prompts.ts`（纯函数）与全部 zod schema；
   - `llm/provider.ts` 的 OpenAI 兼容调用与 `generateStructuredOutput`（fetch 用全局 fetch，不引 node 专属 API；`requireEnv` 这类 node 环境读取改为参数注入——key/baseUrl/model 由调用方传入配置对象）；
   - `agent/resolve-time.ts`（纯函数，直接移）;
   - `agent/propose.ts`、`agent/perceive.ts`、`agent/resolve.ts`、`agent/insight.ts` 中的纯逻辑：LLM 交互与规则判断留在 core；**数据库读写点抽象为接口**（如 `interface ContactStore { listContactSummaries(): ...; ... }`，按现有 db.ts 的实际调用面裁剪出最小接口，不要照搬全部方法）；
   - 图片输入抽象：perceive 接收 `{ base64: string, mimeType: string }` 而非文件路径（server 侧读文件转 base64 后传入；将来 app 侧从相册 asset 转 base64 传入）。
3. `server/src/` 改为消费 `shared/core/`：db.ts 实现上述存储接口；路由与 CLI 行为完全不变。
4. **行为保持的硬闸**：现有全部测试（98 个）迁移后必须全绿且**断言一条不改**——这是"重构未改变行为"的证明。测试文件的 import 路径可以改，断言不许动。
5. 新增一个防回归检查：`shared/core/` 内不得 import 任何 `node:` 前缀模块或 `fs`/`path`（写一条简单的检查测试：遍历 core 文件 grep import，断言零命中）——这是"core 能在 RN 环境跑"的静态保证。
6. `docs/PLAN-V2.md`：把本材料"总体设计"一节整理成 v2 施工图（含三批里程碑与五条决策），后续批次以它为真相源。

## Scope
`shared/`、`server/src/`、测试、`docs/PLAN-V2.md`，全部在 `v2-byok` 分支。**不动 `app/`（那是 V2-M2/M3 的事）、不动 fixtures、不动 deploy、不动 main 分支**。不新增依赖（本批纯重构，expo-sqlite/secure-store 是下批的事）。

## Constraints
- PLAN §0 纪律全部适用；Simplicity First——接口按实际调用面最小化，不做"以后可能用"的方法。
- 中文 commit message；自验全绿才 commit；本批可多个 commit（重构分步提交更安全），但每个 commit 测试须全绿。
- npm 11 会拦 install scripts（本批无新依赖应不涉及；若碰到按提示 approve 并记录）。

## Done when（逐条跑，贴真实输出）
1. `git branch --show-current` 输出 `v2-byok`；
2. `cd server && npm test` 全绿，用例数 ≥ 98（含新增的 core 纯净性检查），**并明确声明：断言未改动**；
3. `npx tsc --noEmit`（server 与 shared）零报错；
4. `node --import tsx src/cli.ts extract ../fixtures/screenshot-1.png` 在无 key 环境给出清晰缺-key 报错（行为与重构前一致）；
5. `grep -rn "node:" shared/core/ --include="*.ts" | grep -v test` 输出为空；
6. `ls docs/PLAN-V2.md` 存在；`git log --oneline main..v2-byok` 显示本批 commit 全在分支上。
完成后照旧：逐条贴实际输出、列移动文件清单、说明偏离决定及理由。真调复验（重构后三张图全链路与 v1 输出对比）由 owner 做。
