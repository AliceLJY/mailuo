# 脉络 Mailuo — M4 施工交接（打磨 + 交付面，最后一批）

## 你的角色
最后一批。施工图 `~/Projects/mailuo/PLAN.md`。真机双端已跑通（owner 已在联调中修复两处：上传改标准 Blob/File、server 加 CORS——见 commit ba93f39，先 `git log -3` 同步认知再动手）。本批 = 性能打磨 + 部署资产 + README。部署执行（mini/GitHub/EAS 云构建）由 owner 做，你只产出代码与配置。**自验用本机 Node 26。**

## Goal

### 1. 上传提速：图片压缩
- app 端上传前压图：`expo-image-manipulator`（官方库，`npx expo install` 装）——最长边 >1280 时等比缩到 1280、JPEG 0.8 输出；web 端若 manipulator 有兼容问题则跳过压缩（原图直传，标注 `// simplified:`）。
- 真机实测读图 13-24s，大头是视觉 token 量；压缩预期显著缩短，且聊天截图文字在 1280 宽下无识别损失。

### 2. 等待体验：两段式进度文案
- 上传页 loading 改两段：提交后先"正在上传截图…"，2 秒后切"AI 正在读图，通常 10-20 秒…"。计时器切换即可，不做真实进度，不引库。

### 3. qwen 模型可切换
- 确认 qwen provider 的模型名走 env（如 `QWEN_MODEL` / `DASHSCOPE_MODEL`，默认 qwen-vl-max）；没有就补上，与 deepseek 侧对称。owner 之后做 vl-plus 质量对比实验用。

### 4. web 版同源部署形态
- `app/src/api.ts` 的 `getBaseUrl`：`EXPO_PUBLIC_API_URL` 未配置且平台为 web 时，回退**相对路径**（同源）——为"server 直接托管 web 静态包"的部署形态服务；原生平台仍要求显式配置（缺失时报清晰错误）。
- server 托管 web 产物：`@fastify/static`（官方插件）挂载 `server/public/`（存在才挂，不存在不影响 API 与测试）；`/` 返回 web 版 index.html，`/api/*` 路由优先不受影响。
- 增加根目录脚本 `scripts/build-web.sh`：`cd app && npx expo export --platform web` 并把产物同步到 `server/public/`（owner 部署时跑）。

### 5. 部署资产（`deploy/` 目录，owner 在 mini 上执行）
- `deploy/com.alice.mailuo-server.plist`：launchd 常驻（KeepAlive），`WorkingDirectory` 指向仓库 server 目录，`EnvironmentVariables` 里 PATH 含 `/opt/homebrew/bin`（launchd 默认 PATH 没有 homebrew，已知坑），PORT=3300，**日志一律写 `~/ops-logs/mailuo/`（不写 ~/Library/Logs——macOS 清理类工具常按模板清扫该目录下不认识的子目录，自托管日志放那里有被误删风险）**。
- `deploy/install.sh`：幂等安装脚本——检查 node ≥26、`npm ci`、提示 `.env` 需要的键名（**不含任何真值**）、`mkdir -p ~/ops-logs/mailuo`、launchd 用 `bootout + sleep 2 + bootstrap` 顺序装载（不用 kickstart -k）、末尾 curl 本机 health 验证并打印结果。
- `deploy/README.md`：部署步骤 + tailscale serve 一行命令示例（`tailscale serve --bg --https=<port> http://127.0.0.1:3300`）。

### 6. Android APK 构建配置
- `app/eas.json`：`preview` profile 出 APK（`buildType: "apk"`），env 里 `EXPO_PUBLIC_API_URL` 设为 `https://<your-mac>.<tailnet>.ts.net:8443`（部署后的 tailnet 地址，出门可用）。
- `app/app.json` 补齐：应用名"脉络"、`android.package`（如 `com.alice.mailuo`）、图标与启动屏用纯色占位即可（不花时间做美术资产）。
- 构建触发由 owner 执行，你只保证配置文件就绪。

### 7. README（双语两份，仓库门面）
- `README.md`（英文）+ `README_CN.md`（中文），内容对等，含：
  a. 一句话定位 + 核心截图位（占位标注 owner 后补 demo 图）；
  b. 架构图（ASCII）：app（iOS PWA / Android native）→ server（Fastify + node:sqlite）→ qwen-vl（perception）/ deepseek（resolution & insights）；
  c. **Agent 环**（PLAN §1 的六步 + 三个"不是套壳"证据点）；
  d. **Memory 三层设计**（PLAN §2 的表 + 档案/流水双语义；点名 Atkinson-Shiffrin 对应）；
  e. 工程故事一节：三层测试漏斗（mock 53→74 用例全绿 / owner 真调抓出 4 个 prompt 层问题 / 真机抓出 2 个平台层问题），各举一例；
  f. 快速开始（本地跑起来的最短路径）；
  g. 隐私边界（数据仅存本机 SQLite；截图仅在推理时发往 qwen/deepseek API）；
  h. Future work：iOS 原生分发（Expo Go 已退出 App Store，需 Apple Developer 账号走 eas go/TestFlight）、洞察重试端点、系统日历集成、消息 App 直连、多用户与鉴权。
- 语言纪律：README.md 全英文、README_CN.md 全中文，不混排。

## Scope
全仓可动，但不改 agent 业务逻辑（perceive/resolve/propose/execute/insight 的行为维持现状——本批不是行为批）。不新增上面未列的依赖。

## Constraints
- PLAN §0 全部适用；`// simplified:` 照旧；中文 commit message；自验全绿才 commit，一批一个 commit。
- plist 与 install.sh 里不得出现任何密钥真值或含密钥的 URL。

## Done when（逐条跑，贴真实输出）
1. `cd server && npm test` 全绿 + `npx tsc --noEmit` 零报错；
2. `cd app && npx tsc --noEmit` 零报错；
3. `bash scripts/build-web.sh` 成功，`ls server/public/index.html` 存在；随后 `curl -s http://localhost:3300/ | head -3` 能看到 html（临时起本地 server 验，验完关）；
4. `plutil -lint deploy/com.alice.mailuo-server.plist` 通过；`bash -n deploy/install.sh` 通过；
5. `ls app/eas.json` 存在且 `npx expo config --type public 2>/dev/null | head -5` 不报错；
6. README.md 与 README_CN.md 存在，`git log --oneline -1` 有本批 commit。
完成后照旧：逐条贴实际输出、列文件清单、说明偏离决定及理由。
