# 脉络 App

Expo SDK 57 客户端，目录只承载手机端代码。

## 开发前提

- 手机和电脑在同一个 Wi-Fi / 局域网
- 后端 `server/` 需要监听电脑可访问地址，默认端口 `3000`
- `app/.env` 的 `EXPO_PUBLIC_API_URL` 指向电脑局域网地址，例如 `http://192.168.3.102:3000`

## 启动

```bash
cd app
npm install
npx tsc --noEmit
npx expo start
```

常用命令：

```bash
npm run ios
npm run android
npm run web
```

## API 基址

前端统一从 `EXPO_PUBLIC_API_URL` 读取服务基址，再拼接 `/api/...` 路径。

如果手机访问不到服务，先检查两件事：

1. `server` 是否监听 `0.0.0.0:3000` 或本机 LAN 地址
2. Mac 防火墙和同网段连通性是否正常
