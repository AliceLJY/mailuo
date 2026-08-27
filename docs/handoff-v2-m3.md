# 脉络 Mailuo — V2-M3 施工交接（模式选择 UI，v2.0 最后一批）

## 你的角色
继续 v2.0 施工，分支 `v2-byok`。施工图 `docs/PLAN-V2.md`。V2-M2 已验收：本地引擎、分发层、密钥封装全部就位（server 99 绿 / app 单测 5 绿）。本批把用户能看见摸得着的部分做完。发现矛盾停下来问。**自验用本机 Node 26。**

## Goal（本批 = V2-M3，v2.0 收官批）

1. **首次启动引导页**（无连接配置时展示，代替直接进上传页）：
   - 标题与一句话说明（人话，禁工程黑话——v1 有过教训）；
   - 三个模式卡片：**「我有模型 API Key」**（副文案：填入 key 后一切在本机运行，数据只存在这台手机上）/ **「我有自己的服务器」**（副文案：连接你自建的脉络后端）/ **「订阅服务」**（灰色禁用态，角标"敬请期待"）；
   - web 平台只展示服务器卡片（分发层已强制，UI 与之一致）。
2. **API key 模式表单**：DASHSCOPE_API_KEY、DEEPSEEK_API_KEY 两个必填输入（`secureTextEntry`，粘贴友好），模型名两个选填（占位符显示默认值 qwen-vl-max / deepseek-v4-flash）；保存进 V2-M2 的 secure-store 封装。**已保存的 key 永不回显**——再次进入显示「已设置（末 4 位 ****XXXX）」+「替换」「清除」按钮。
3. **服务器模式表单**：地址输入 + 「测试连接」按钮（打 GET /api/health，成功显绿勾与响应耗时，失败显具体错误）；保存进连接配置。
4. **设置入口**：上传页右上角设置图标 → 设置页：当前模式展示、切换模式（回到选择页）、编辑当前模式的配置。切到 local 模式时首页副文案相应变化（体现"本机运行"）。
5. **local 模式的加载文案**：本地模式上传时读图仍需 10-20 秒（直连模型 API），loading 文案与 server 模式一致的两段式；报错时把 provider 的错误翻译成人话（key 无效 / 网络不通 / 模型限流 三类至少可区分）。
6. **单测**：模式选择状态机（无配置→引导页；有 server 配置→直进主页；有 local 配置且平台非 web→直进主页；web+local 配置→回退 server 表单）；key 掩码展示逻辑（只出末 4 位）。

## Scope
`app/` 内 UI 与接线；不动 shared/core 与 server（发现需要动=停下来问）；不动 main。

## Constraints
- PLAN §0 全部适用；不引 UI 库；组件 ≤300 行超拆；中文文案全走人话判据（用户能懂，无 flow/API/初始化等词）。
- 密钥红线延续：key 不进日志、不回显全文、截屏场景不可见全文（secureTextEntry 天然满足）。
- 中文 commit message；自验全绿才 commit；push 到 origin。

## Done when（逐条跑，贴真实输出）
1. `git branch --show-current` = v2-byok；
2. `cd app && npx tsc --noEmit` 零报错；`npm test` 全绿（贴用例数）；
3. `cd server && npm test` 99 全绿（确认没被波及）；
4. `cd app && CI=1 npx expo start --lan` 正常启动（贴横幅即可，Ctrl+C）；
5. 贴出引导页与设置页的全部用户可见文案清单（owner 按人话判据审）；
6. `git log --oneline main..v2-byok` 显示本批 commit 且已 push。
完成后照旧：逐条贴实际输出、列文件清单、说明偏离决定及理由。真机双模式验收（Expo Go 扫码：local 模式填真 key 走全链路 + server 模式回归）由 owner 与用户执行。
