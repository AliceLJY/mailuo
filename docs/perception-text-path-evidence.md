# 文本感知路径单例证据

## screenshot-1 的相对日期解析

测试时间锚点固定为 `2026-08-29T08:00:00+08:00`，当天是星期六，因此“下周三”对应
`2026-09-02`。

同一素材出现了以下结果：

- v2.0.0 视觉路径的 `qwen-vl-max` 基线把“下周三下午 3 点”解析为
  `2026-08-31T15:00:00+08:00`。8 月 31 日是下周一，日期错误。
- v3-M1 文本路径使用 `deepseek-v4-flash`，把同一句解析为
  `2026-09-02T15:00:00+08:00`，与 prompt 中固定的上海日历表一致。

视觉结果见 `docs/perception-baseline/screenshot-1.qwen-vl.json`；文本路径的人工转写输入、side 标记和完整输出见
`docs/perception-text-evidence/screenshot-1.deepseek-v4-flash.json`。

## 证据边界

这次只调用了一次 DeepSeek 生产文本 provider，没有再次调用 Qwen-VL。文本输入来自对 fixture 的人工逐行转写，
没有经过 Mac OCR，也不是尚未取得的真机 ML Kit bundle。因此它能证明：识字与理解分离后，同一时间题在文本路径
得到过正确结果，这是拆分架构的一条实际收益证据；它不能代表 OCR 字符准确率，也不能代替半 C 的同素材整体质量比较。

Qwen-VL 的日期错误来自 v2.0.0 既有生产路径，本批保留为对照证据，不修改视觉 prompt 或日期解析代码。
