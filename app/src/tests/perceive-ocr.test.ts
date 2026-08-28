import assert from "node:assert/strict";
import test from "node:test";

import {
  collectRecognizedLines,
  findAlignmentPeaks,
  perceiveScreenshotWithOcr,
  type OcrRecognitionResult,
  type PerceivedOcrLine,
  type RegionSampleRequest,
} from "../local/perceive-ocr";

function frame(left: number, top: number, width: number, height: number) {
  return { left, top, width, height };
}

function recognizedResult(
  lines: Array<{
    text: string;
    left: number;
    top: number;
    width: number;
    height?: number;
    confidence?: number | null;
  }>,
): OcrRecognitionResult {
  return {
    blocks: [
      {
        lines: lines.map((line) => ({
          text: line.text,
          frame: frame(line.left, line.top, line.width, line.height ?? 30),
          confidence: line.confidence,
        })),
      },
    ],
  };
}

function perceivedLine(text: string, x: number, width: number): PerceivedOcrLine {
  return {
    text,
    side: null,
    x,
    y: 0,
    width,
    height: 30,
    confidence: null,
  };
}

test("collectRecognizedLines preserves raw text, geometry, confidence, and block-frame fallback", () => {
  const result = collectRecognizedLines({
    blocks: [
      {
        frame: frame(11, 22, 150, 40),
        lines: [
          {
            text: "  原样文字  ",
            frame: frame(12.5, 23.5, 120.25, 31.75),
            confidence: 0.875,
          },
          { text: "使用块坐标", confidence: Number.NaN },
          { text: "   ", frame: frame(1, 1, 10, 10), confidence: 0.2 },
        ],
      },
      { lines: [{ text: "无坐标" }] },
    ],
  });

  assert.deepEqual(result, [
    {
      text: "  原样文字  ",
      side: null,
      x: 12.5,
      y: 23.5,
      width: 120.25,
      height: 31.75,
      confidence: 0.875,
    },
    {
      text: "使用块坐标",
      side: null,
      x: 11,
      y: 22,
      width: 150,
      height: 40,
      confidence: null,
    },
  ]);
});

test("alignment peaks use left x and right x plus width while rejecting middle repeats and one-character noise", () => {
  const leftMessages = Array.from({ length: 4 }, (_, index) =>
    perceivedLine(`左侧消息${index}`, 134, 100),
  );
  const rightMessages = Array.from({ length: 4 }, (_, index) =>
    perceivedLine(`右侧消息${index}`, 485, 100),
  );
  const repeatedMiddle = Array.from({ length: 9 }, (_, index) =>
    perceivedLine(`噪声${index}`, 10 + index, 113 - index),
  );
  const oneCharacterNoise = Array.from({ length: 12 }, (_, index) =>
    perceivedLine("噪", 250, 20 + index),
  );
  const screenWidthMarker = perceivedLine("屏幕宽度标尺", 680, 40);

  assert.deepEqual(
    findAlignmentPeaks([
      ...leftMessages,
      ...rightMessages,
      ...repeatedMiddle,
      ...oneCharacterNoise,
      screenWidthMarker,
    ]),
    { left: 134, right: 585 },
  );
});

test("only a double-peak line is sampled and frameIndex remains zero", async () => {
  const requestsSeen: RegionSampleRequest[][] = [];
  const result = await perceiveScreenshotWithOcr({
    uri: "file:///screenshot.png",
    async recognize() {
      return recognizedResult([
        { text: "左侧消息", left: 134, top: 100, width: 100, confidence: 0.91 },
        { text: "双贴峰消息", left: 134.2, top: 200.4, width: 450.6, height: 39.2, confidence: 0.82 },
        { text: "右侧消息", left: 485, top: 300, width: 100, confidence: 0.93 },
        { text: "居中系统文字", left: 260, top: 400, width: 80, confidence: 0.75 },
      ]);
    },
    async sampleRegions(requests) {
      requestsSeen.push(requests);
      return { samples: [{ id: requests[0].id, side: "me" }] };
    },
  });

  assert.deepEqual(requestsSeen, [[{
    id: "bubble-1",
    frameIndex: 0,
    uri: "file:///screenshot.png",
    x: 134,
    y: 200,
    width: 451,
    height: 40,
  }]]);
  assert.deepEqual(result.lines.map((line) => line.side), ["them", "me", "me", null]);
  assert.equal(result.lines[1].text, "双贴峰消息");
  assert.equal(result.lines[1].confidence, 0.82);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.degraded, false);
});

test("multi-line bubbles are classified and sampled as one group", async () => {
  const requestsSeen: RegionSampleRequest[][] = [];
  const result = await perceiveScreenshotWithOcr({
    uri: "file:///screenshot.png",
    async recognize() {
      return recognizedResult([
        { text: "左峰锚点", left: 134, top: 20, width: 100 },
        { text: "满宽第一行", left: 134, top: 200, width: 451, height: 40 },
        { text: "换行文字", left: 134, top: 245, width: 160, height: 30 },
        { text: "右峰锚点", left: 485, top: 400, width: 100 },
      ]);
    },
    async sampleRegions(requests) {
      requestsSeen.push(requests);
      return { samples: [{ id: requests[0].id, side: "me" }] };
    },
  });

  assert.deepEqual(requestsSeen, [[{
    id: "bubble-1",
    frameIndex: 0,
    uri: "file:///screenshot.png",
    x: 134,
    y: 200,
    width: 451,
    height: 40,
  }]]);
  assert.deepEqual(result.lines.map((line) => line.side), ["them", "me", "me", "me"]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.degraded, false);
});

test("bubble grouping keeps Tenglu's strict dy and dx boundaries", async () => {
  async function classify(secondLine: {
    left: number;
    top: number;
    width: number;
  }, sampledSide: "me" | "them") {
    return perceiveScreenshotWithOcr({
      uri: "file:///screenshot.png",
      async recognize() {
        return recognizedResult([
          { text: "左峰锚点", left: 134, top: 20, width: 100 },
          { text: "满宽第一行", left: 134, top: 200, width: 451 },
          { text: "第二行文字", ...secondLine },
          { text: "右峰锚点", left: 485, top: 500, width: 100 },
        ]);
      },
      async sampleRegions(requests) {
        return { samples: [{ id: requests[0].id, side: sampledSide }] };
      },
    });
  }

  const dy61 = await classify({ left: 134, top: 261, width: 100 }, "me");
  const dy62 = await classify({ left: 134, top: 262, width: 100 }, "me");
  const dx59 = await classify({ left: 193, top: 220, width: 392 }, "them");
  const dx60 = await classify({ left: 194, top: 220, width: 391 }, "them");

  assert.deepEqual(dy61.lines.slice(1, 3).map((line) => line.side), ["me", "me"]);
  assert.deepEqual(dy62.lines.slice(1, 3).map((line) => line.side), ["me", "them"]);
  assert.deepEqual(dx59.lines.slice(1, 3).map((line) => line.side), ["them", "them"]);
  assert.deepEqual(dx60.lines.slice(1, 3).map((line) => line.side), ["them", "me"]);
});

test("Wechat time rows stay in raw output without joining a message bubble", async () => {
  let samplerCalls = 0;
  const result = await perceiveScreenshotWithOcr({
    uri: "file:///screenshot.png",
    async recognize() {
      return recognizedResult([
        { text: "左侧消息", left: 134, top: 100, width: 100 },
        { text: "昨天 09：31", left: 134, top: 145, width: 451 },
        { text: "右侧消息", left: 485, top: 300, width: 100 },
      ]);
    },
    async sampleRegions() {
      samplerCalls += 1;
      return { samples: [] };
    },
  });

  assert.deepEqual(result.lines.map((line) => line.side), ["them", null, "me"]);
  assert.equal(samplerCalls, 0);
});

test("an unresolved pixel sample leaves side null and marks the result degraded", async () => {
  const result = await perceiveScreenshotWithOcr({
    uri: "file:///screenshot.png",
    async recognize() {
      return recognizedResult([
        { text: "左侧消息", left: 134, top: 100, width: 100 },
        { text: "满宽消息", left: 134, top: 200, width: 451 },
        { text: "满宽消息换行", left: 134, top: 245, width: 160 },
        { text: "右侧消息", left: 485, top: 350, width: 100 },
      ]);
    },
    async sampleRegions(requests) {
      return { samples: [{ id: requests[0].id, side: null }] };
    },
  });

  assert.equal(result.lines[1].side, null);
  assert.equal(result.lines[2].side, null);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /底色未判定/u);
  assert.equal(result.degraded, true);
});

test("a sampler exception becomes warnings instead of escaping", async () => {
  const result = await perceiveScreenshotWithOcr({
    uri: "file:///screenshot.png",
    async recognize() {
      return recognizedResult([
        { text: "左侧消息", left: 134, top: 100, width: 100 },
        { text: "满宽消息", left: 134, top: 200, width: 451 },
        { text: "右侧消息", left: 485, top: 300, width: 100 },
      ]);
    },
    async sampleRegions() {
      throw new Error("native decoder failed");
    },
  });

  assert.equal(result.lines[1].side, null);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /native decoder failed/u);
  assert.equal(result.degraded, true);
});

test("zero recognized lines return explicitly without calling the sampler", async () => {
  let samplerCalls = 0;
  const result = await perceiveScreenshotWithOcr({
    uri: "file:///blank.png",
    async recognize() {
      return { blocks: [] };
    },
    async sampleRegions() {
      samplerCalls += 1;
      return { samples: [] };
    },
  });

  assert.deepEqual(result, { lines: [], warnings: [], degraded: false });
  assert.equal(samplerCalls, 0);
});

test("recognized text without valid geometry marks OCR degraded", async () => {
  let samplerCalls = 0;
  const result = await perceiveScreenshotWithOcr({
    uri: "file:///missing-frame.png",
    async recognize() {
      return { blocks: [{ lines: [{ text: "有文字但没有坐标" }] }] };
    },
    async sampleRegions() {
      samplerCalls += 1;
      return { samples: [] };
    },
  });

  assert.deepEqual(result.lines, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /缺少有效坐标/u);
  assert.equal(result.degraded, true);
  assert.equal(samplerCalls, 0);
});
