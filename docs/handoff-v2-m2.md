# 脉络 Mailuo — V2-M2 施工交接（app 本地模式实现）

## 你的角色
继续 v2.0 施工，分支 `v2-byok`。施工图 `docs/PLAN-V2.md`（五条决策与三批里程碑）。V2-M1（核心逻辑抽取）已验收通过：`shared/core/` 平台无关、server 消费 core、99/99 绿。本批把 BYOK 本地模式的**引擎**装进 app（UI 是 V2-M3 的事）。发现矛盾停下来问。**自验用本机 Node 26。**

## Goal（本批 = 仅 V2-M2）
1. **依赖**：`cd app && npx expo install expo-sqlite expo-secure-store`（npm 11 拦 install scripts 时按提示 approve 并记录）。
2. **配置与密钥管理**（`app/src/connection/`）：
   - 连接配置模型：`{ mode: 'server' | 'local', serverUrl?: string }` 存 AsyncStorage 级别的普通存储（expo-sqlite 或简单 JSON 文件均可，选最简）；
   - **密钥只进 expo-secure-store**（`DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`，可选 `QWEN_MODEL`/`DEEPSEEK_MODEL` 覆盖）；提供 get/set/clear 封装；**任何日志、错误信息、状态导出中不得出现密钥值**。
3. **本地存储适配**（`app/src/local/store.ts`）：用 expo-sqlite 实现 V2-M1 抽出的存储接口；建表语句与 `server/src/schema.sql` 同构（可从 shared 层复用 SQL 文本，避免两份 schema 漂移——若 M1 未把 schema 放 shared，本批移过去并让 server 同样消费）。
4. **本地 agent 函数集**（`app/src/local/api.ts`）：实现与 `app/src/api.ts` 现有函数**同签名、同返回形状**的本地版本——upload（相册 asset → base64 → core.perceive → core.resolve → core.propose → 落库返回卡片）、confirm/reject（core.execute + core.insight）、各 get 查询。LLM 配置从 secure-store 读出注入 core provider。
   - **依赖注入纪律**：编排逻辑不得直接 import expo-sqlite / expo-secure-store——store 与密钥提供者作为参数传入（工厂函数组装），这样编排层可以在 node 环境单测（注入假体）。
5. **分发层**：`app/src/api.ts` 改造为按连接配置路由：mode=server 走现有 HTTP 实现，mode=local 走本地函数集。默认行为兼容：无配置时若存在 `EXPO_PUBLIC_API_URL` 视为 server 模式（v1 用户无感）。
6. **单测**（node 环境，`app` 内可跑的纯逻辑）：本地编排全链路（假 store + mock LLM：upload→confirm→查询终态断言联系人/观测/会议/洞察）；密钥封装的注入假体测试；分发层路由决策测试。**expo-sqlite 真实适配层的正确性由 V2-M3 真机验收兜底**，本批不强求（如实标注测试边界）。

## Scope
`app/`（主体）+ 若 schema 上移则动 `shared/` 与 `server/`（server 测试须保持全绿）。不动 UI 页面（V2-M3）、不动 fixtures、不动 main。

## Constraints
- PLAN §0 全部适用；Simplicity First；`// simplified:` 照旧。
- 密钥红线：不进日志、不进普通存储、不进代码、不进 git。
- 中文 commit message；自验全绿才 commit；全部 commit 在 `v2-byok`，**push 到 origin**（双机协作，另一台要能拉到）。

## Done when（逐条跑，贴真实输出）
1. `git branch --show-current` = v2-byok；
2. `cd server && npm test` 全绿（若 schema 上移，行为不变）；
3. `cd app && npx tsc --noEmit` 零报错；
4. app 的新增单测全绿（贴用例数与结果行；说明测试边界——哪些留给真机）；
5. `grep -rn "SecureStore\|secure-store" app/src/local/ app/src/connection/ | grep -iE "console|log"` 输出为空（密钥不进日志的静态检查）；
6. `git log --oneline main..v2-byok` 显示本批新 commit，且已 push。
完成后照旧：逐条贴实际输出、列文件清单、说明偏离决定及理由。
