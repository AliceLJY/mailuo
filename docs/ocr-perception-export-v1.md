# OCR 感知导出格式 v1

## 用途与质量证据

这个 JSON 只用于本地 OCR 感知的真机验收和离线对比，不含截图图片或模型 Key，但会包含截图里识别出的聊天文字、姓名等敏感内容，只应在明确需要验收时开启并由 owner 自行保管。脉络在 Android 真机上完成 ML Kit 识字与气泡归属判断后，由开启诊断开关的 owner 通过系统目录选择器导出一个文件，再回传到 Mac 与 Qwen-VL 基线逐字段比较。当前批次只定义并验证格式，不产出真机数据。

同一 OCR 引擎处理同类微信界面的已有证据直接引用誊录 v0.3.0：`tenglu/PLAN.md` 的“M3 验收通过”记录字符级准确率 91.4%、发言人 39/41；后续人工核对记录 59/60 条消息有对应内容。脉络不重复这项真机测试，也不把这组数字当成本批三张 fixture 的同素材结论。

## 文件结构

每次导出只写一个 `mailuo-ocr-<UTC 时间>.json`。`formatVersion` 为 `1` 时结构如下：

```json
{
  "formatVersion": 1,
  "kind": "mailuo-ocr-perception",
  "exportedAt": "2026-08-29T03:04:05.000Z",
  "source": {
    "name": "screenshot-1.png",
    "mimeType": "image/png",
    "width": 390,
    "height": 844,
    "md5": "0123456789abcdef0123456789abcdef"
  },
  "engine": {
    "name": "@react-native-ml-kit/text-recognition",
    "version": "2.0.0",
    "script": "Chinese"
  },
  "lines": [
    {
      "text": "周二上午十点见",
      "x": 24,
      "y": 128,
      "w": 168,
      "h": 32,
      "conf": 0.914,
      "side": "them"
    }
  ],
  "warnings": [],
  "degraded": false
}
```

字段约束：

- `formatVersion` 是解析协议版本；读取端遇到不是 `1` 的版本必须拒绝，不能猜测兼容。
- `source.md5` 是原截图文件的 MD5，只用于把真机结果与同一素材配对，不作为安全校验。读取不到时本次诊断导出失败，但不影响截图处理。
- `lines` 保留 ML Kit 每一行的原始 `text`、坐标 `x/y/w/h` 和 line confidence `conf`。坐标单位是原图像素，原点在左上角；ML Kit 没有返回该行矩形时仍保留文字，并以 `x/y/w/h` 全部为 `0` 表示坐标缺失。confidence 不可用时写 `null`，不得编造或强制夹到 0–1。
- `side` 只能是 `me`、`them` 或 `null`。坐标同时命中左右对齐峰时使用局部像素采样；采样仍无法判断时保留 `null`。
- 每个无法完成气泡归属的采样问题都写入 `warnings`；零文本行补一条“未识别到文本行”。`degraded` 由 `warnings` 是否为空计算，不能由调用方单独指定；它只表示诊断信息，不再自动触发 Qwen-VL。生产路径仅在 OCR 抛错、识别文本行数为零，或有限 confidence 低于 `0.5` 的行占全部文本行比例超过 `0.6` 时回退视觉模型；发言人归属不明和 confidence 为 `null` 的行继续走文本模型。导出的仍是视觉回退前的原始 OCR 证据。
- Android 的系统目录通常返回 SAF `content://` URI；实现通过目录对象创建 JSON 文件，不拼接本机路径。App 不保存或复用目录 URI，每次启用导出都由用户重新选择目录；系统层是否保留过授权不作为 App 的长期状态使用。

## 后续同素材比较

真机 bundle 返回后，以 `source.md5` 确认素材，再把 OCR 文本路径与 `docs/perception-baseline/` 中对应的 Qwen-VL 快照逐字段比较。差异只归为三类：OCR 认错字、提示词理解差异、实现缺陷。若 OCR 路径明显更差，默认值改为云端视觉，OCR 只保留为可选路径；不修改提示词来迁就指标。
