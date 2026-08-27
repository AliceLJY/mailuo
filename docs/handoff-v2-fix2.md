# V2-fix2：DeepSeek Key 改为选填（单 Key 即可用）

## 背景
产品简化，维护者拍板：BYOK 模式要求用户去两家注册两个 key，注册摩擦砍半的机会真实存在——DashScope 一个 key 底下既有视觉模型（qwen-vl）也有文本模型（qwen 系列），文本任务完全可以由 qwen 文本模型承接。DeepSeek 从"必需"降为"可选的降本/加速项"。分支 `v2-byok`。**自验用本机 Node 26。**

## Goal
1. **core 层 fallback**（`shared/core/`，两端自动共享）：provider 组装处增加规则——**DeepSeek key 未配置时**，归并（resolve）与洞察（insight）的文本任务改用 DashScope 的文本模型完成（默认 `qwen-plus`，以 DashScope 官方 OpenAI 兼容文档核对模型名；新增可覆盖配置项 `QWEN_TEXT_MODEL` / 对应 app 设置字段）。已配置 DeepSeek 时行为完全不变。
2. **app 表单**：模型 Key 页的 DeepSeek API Key 从"必填"移入"选填"区，副文案："不填也能用：文本整理将同样由通义千问完成。填入后归并与洞察改用 DeepSeek（更省钱）。"保存校验只强制 DashScope key。选填区模型名下补 `Qwen 文本模型名` 输入（占位符 qwen-plus）。
3. **server 端**：`.env.example` 注释同步（DEEPSEEK_API_KEY 标可选 + 说明 fallback 行为；新增 QWEN_TEXT_MODEL 注释）；启动时缺 DEEPSEEK_API_KEY 不再报错。
4. **README 双语**：快速开始的 env 说明同步；隐私边界的 DeepSeek 条目加一句"未配置 DeepSeek 时，上述文本任务由 DashScope 的 Qwen 文本模型完成，数据不发往 DeepSeek"。
5. **单测**：无 deepseek 配置 → provider 组装返回 qwen 文本通道（模型名断言）；有 deepseek 配置 → 行为不变；app 表单校验逻辑（只强制 DashScope）。

## Scope
`shared/core/` provider 组装处 + `app/` key 表单与校验 + `server` env 处理与 .env.example + 两份 README。不动 agent 业务逻辑本身、不动 main。

## Constraints
- PLAN §0 全部适用；文案人话判据；密钥红线不变。
- 中文 commit message；自验全绿才 commit；push 到 origin。

## Done when（逐条跑，贴真实输出）
1. `cd server && npm test` 全绿 + `npx tsc --noEmit` 零报错；
2. `cd app && npm test` 全绿 + `npx tsc --noEmit` 零报错；
3. 贴出 key 表单新文案（owner 审人话）；
4. `git log --oneline -1` 在 v2-byok 且已 push。
真调复验由 owner 做（临时摘除 DeepSeek key 跑三张图全链路，验证 qwen 文本通道的归并与洞察质量）。
