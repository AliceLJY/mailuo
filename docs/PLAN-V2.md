# 脉络 Mailuo — v2.0 施工图

> 本文档是 v2.0 后续批次的施工真相源。v1 架构与既有行为仍以仓库根目录 `PLAN.md` 为准；两者冲突时停止施工并交由 owner 裁决，不自行改设计。

## 0. 目标与边界

v2.0 交付一个安装包，提供两种可用连接模式和一个占位模式：

1. **API key 模式（BYOK 单机版）**：用户填写自己的 DashScope / DeepSeek key；agent 流水线在 app 内运行，档案存手机本地 SQLite，不依赖服务器。
2. **服务器模式**：用户填写自部署后端地址，沿用 v1 的服务端形态。
3. **订阅模式**：本期仅显示“敬请期待”的禁用态入口，不实现订阅能力。

v2 全程在 `v2-byok` 分支开发，`main` 保持 v1 可演示状态。开发与自验使用本机默认 Node 26，不用 `npx` 下载其他 Node 版本替代。

## 1. 五条核心设计决策

### 1.1 同形接口层

`app/src/api.ts` 的七个函数及其 `{ ok, data }` 成功响应中的 `data` 形状，是服务器模式与本地模式的公共契约：

- `uploadScreenshot`
- `confirmCard`
- `rejectCard`
- `getContacts`
- `getContactDetail`
- `getMeetings`
- `getScreenshotDetail`

本地模式实现同签名函数集，业务 UI 不按连接模式分叉。

### 1.2 共享核心

平台无关逻辑统一放在 `shared/core/`：prompts、zod schemas、OpenAI 兼容 provider、结构化输出重试、perceive、resolve、propose、resolve-time 与 insight 过滤。core 使用全局 `fetch`，不导入 Node 文件系统或路径模块，也不读取 `process.env`。

数据库与图片文件读取留在平台适配层：server 使用现有 SQLite 与文件目录，app 在后续批次使用移动端实现。存储接口只覆盖 core 的实际调用面，不预留未使用方法。

图片进入 core 前统一为：

```ts
type ScreenshotImageInput = {
  base64: string;
  mimeType: string;
};
```

server 负责把文件读成 base64；app 后续负责把相册 asset 转成同一形状。

### 1.3 本地存储与密钥

本地档案使用 `expo-sqlite`，schema 与 v1 `server/src/schema.sql` 同构。用户 API key 使用 `expo-secure-store` 写入系统钥匙串，绝不进入 AsyncStorage、SQLite 或源代码。

### 1.4 Web 边界

Web 版不实现本地模式。Web 始终使用服务器模式，模式选择界面只展示服务器选项；原因是本期不承担 expo-sqlite Web 支持的额外复杂度。README 在 V2-M3 同步说明。

### 1.5 分支纪律

V2-M1、V2-M2、V2-M3 的 commit 全部进入 `v2-byok`。在 v2 完成真机验收前，不把施工中状态合入 `main`。

## 2. 三批里程碑

### V2-M1：核心逻辑抽取

目标：把 server 中的平台无关逻辑移动到 `shared/core/`，server 通过薄适配器继续提供与 v1 完全一致的路由和 CLI 行为。

完成边界：

- 现有测试断言不改且全部通过；
- 新增 core 纯净性检查，禁止 `node:`、`fs`、`path` import；
- server 与 shared 一起通过 TypeScript 检查；
- 无 key CLI 仍给出原有清晰错误；
- 不改 app、fixtures、deploy，不新增依赖。

### V2-M2：App 本地模式

目标：在 app 内实现与 `app/src/api.ts` 同形的本地 API 层。

施工范围：

- 接入 `expo-sqlite`，实现与 v1 schema 同构的本地存储适配器；
- 接入 `expo-secure-store`，管理 DashScope / DeepSeek key；
- 相册 asset 转 `{ base64, mimeType }` 后调用 shared core；
- 实现七个公共 API 函数的本地版本；
- 保持服务器模式行为不变。

本批不做模式选择 UI；可通过开发配置或测试入口验证本地 API。

### V2-M3：模式选择 UI 与真机验收

目标：完成首次启动模式选择、配置管理与最终真机验收。

施工范围：

- 原生端展示 API key 模式、服务器模式、订阅占位；
- Web 端只展示服务器模式；
- 持久化用户选择，并提供后续修改入口；
- 两种可用模式复用同一套业务 UI；
- 更新 README，说明 Web 边界、密钥存储与隐私边界；
- 在 Android 与 iOS 真机分别验收服务器模式和 BYOK 本地模式。

## 3. 非目标

- 不实现订阅、支付或账号系统；
- 不为 Web 补本地 SQLite；
- 不改变 v1 API 响应契约；
- 不把 API key 写入非安全存储；
- 不在 core 中加入平台探测或 Node/RN 条件分支。
