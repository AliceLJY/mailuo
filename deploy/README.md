# Mailuo 部署说明

这套部署资产只负责两件事：把 Expo web 产物同步到 `server/public/`，再用 `launchd` 常驻启动 `server`。

## 1. 先准备环境

- Mac mini 上要有 `/opt/homebrew/bin/node` 和 `/opt/homebrew/bin/npm`，Node 版本需 `>=26`
- 仓库已拉到本机
- `server/.env` 已存在，至少包含键名 `DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`
- 这两个键不光要存在，去掉首尾空白后也不能为空；`install.sh` 会用 Node 26 的 `--env-file` 按这个规则检查
- `scripts/build-web.sh` 和 `deploy/install.sh` 都会拒绝 symlink 形式的 `server/` 目录，要求真实路径精确落在当前仓库物理根的 `server/`
- `QWEN_MODEL` 可选；不配时沿用服务端默认值

## 2. 构建 web 静态资源

在仓库根目录执行：

```bash
bash scripts/build-web.sh
```

这个脚本会：

- 在 `app/` 下以空的 `EXPO_PUBLIC_API_URL` 执行 `npx expo export --platform web`，强制 web 产物走同源 `/api`
- 如果 `server/public` 是 symlink，脚本会直接拒绝，避免把导出结果同步到错误位置
- 导出后检查 `app/dist/` 没有把 `app/.env` 里的非空 `EXPO_PUBLIC_API_URL` 写进产物，也没有留下明确绝对 API URL
- 把 `app/dist/` 同步到 `server/public/`
- 先确认目标真实路径精确等于真实 `server` 目录下的 `public/`，再用 `rsync -a --delete` 保持内容一致

## 3. 安装 launchd 服务

在仓库根目录执行：

```bash
bash deploy/install.sh
```

这个脚本会：

- 检查 `/opt/homebrew/bin/node` 版本和 `/opt/homebrew/bin/npm`
- 要求 `server/public/index.html` 已存在；缺 web 产物时直接失败并提示先执行 `bash scripts/build-web.sh`
- 在 `server/` 下执行 `npm ci --include=dev`
- 安装后确认 `server/node_modules/tsx` 已存在，避免 `NODE_ENV=production` 一类环境把 devDependencies 省掉
- 用 Node 26 `--env-file` 检查 `server/.env` 里的必需键名是否为非空值
- 创建 `~/ops-logs/mailuo/`
- 先复制 plist 模板，再用 `/usr/bin/plutil -replace ... -string` 写入路径字段，最后做 `plutil -lint`
- 用 `launchctl bootout` -> `sleep 2` -> `launchctl bootstrap` 重装服务
- 用 `http://127.0.0.1:3300/api/health` 做有限重试健康检查，并断言返回 JSON 满足 `ok === true` 且 `data.status === "ok"`；随后再请求 `/`，确认首页返回 HTML

## 4. 查看日志

标准输出和错误输出都在：

```bash
ls ~/ops-logs/mailuo
tail -f ~/ops-logs/mailuo/stdout.log
tail -f ~/ops-logs/mailuo/stderr.log
```

这里故意不用系统默认日志目录，避免被现有清理工具误删。

## 5. 卸载或重装

先卸载当前服务：

```bash
launchctl bootout "gui/$UID/com.alice.mailuo-server"
rm -f ~/Library/LaunchAgents/com.alice.mailuo-server.plist
```

然后回到仓库根目录重新执行：

```bash
bash deploy/install.sh
```

如果只是代码更新，通常先重新执行 `bash scripts/build-web.sh`，再执行 `bash deploy/install.sh` 就够了。

## 6. 暴露给 tailnet

部署完成后，可以把 3300 端口通过 Tailscale HTTPS 暴露出来：

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3300
```

这里固定用 `8443`，因为 app 侧约定的 EAS 预览地址就是这个 HTTPS 端口；部署命令和客户端地址保持一致，省掉额外切换。
