import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPerceptionSystemPrompt,
  buildPerceptionTextSystemPrompt,
  buildPerceptionUserPrompt,
} from "../../../shared/core/llm/prompts.ts";
import type {
  ChatCompletionRequest,
  StructuredOutputRequest,
} from "../../../shared/core/llm/provider.ts";
import { formatAnnotatedOcrText, perceiveOcrText } from "../local/perceive-text";

const OCR_LINES = [
  {
    text: "下周三下午三点见",
    side: "them" as const,
    x: 24,
    y: 100,
    width: 180,
    height: 32,
    confidence: 0.98,
  },
  {
    text: "我提前十分钟到",
    side: "me" as const,
    x: 190,
    y: 160,
    width: 176,
    height: 32,
    confidence: 0.96,
  },
  {
    text: "聊天记录",
    side: null,
    x: 150,
    y: 20,
    width: 90,
    height: 24,
    confidence: null,
  },
];

test("visual prompt builders remain byte-identical to the pre-text snapshot", () => {
  const snapshot = JSON.parse(readFileSync(
    new URL("../../../docs/perception-baseline/visual-prompts.before-text.json", import.meta.url),
    "utf8",
  )) as {
    baselineNow: string;
    buildPerceptionSystemPrompt: string;
    buildPerceptionUserPrompt: string;
  };

  assert.equal(
    buildPerceptionSystemPrompt(new Date(snapshot.baselineNow)),
    snapshot.buildPerceptionSystemPrompt,
  );
  assert.equal(buildPerceptionUserPrompt(), snapshot.buildPerceptionUserPrompt);
});

test("text perception prompt keeps the scheduling rules and changes evidence ownership semantics", () => {
  const prompt = buildPerceptionTextSystemPrompt(new Date("2026-08-29T00:00:00.000Z"));

  assert.match(prompt, /side=me is the device owner/u);
  assert.match(prompt, /side=null line/u);
  assert.match(prompt, /Otherwise do not guess/u);
  assert.match(prompt, /Never copy a side marker into source_quote/u);
  assert.match(prompt, /source_quote copied from the provided OCR text/u);
  assert.match(prompt, /one-sided delivery promise/u);
  assert.match(prompt, /calendar table above/u);
  assert.match(prompt, /confidence must be one of: high, medium, low/u);
  assert.doesNotMatch(prompt, /right-side bubbles/u);
});

test("annotated OCR text preserves each recognized line and side marker", () => {
  assert.equal(
    formatAnnotatedOcrText(OCR_LINES),
    [
      "[side=them] 下周三下午三点见",
      "[side=me] 我提前十分钟到",
      "[side=null] 聊天记录",
    ].join("\n"),
  );
});

test("OCR text perception sends a text-only structured-output request", async () => {
  const captured: StructuredOutputRequest<unknown>[] = [];
  const provider = {
    name: "fake",
    model: "fake-text",
    async complete(_request: ChatCompletionRequest) {
      throw new Error("complete is not used");
    },
    async generateStructuredOutput<T>(request: StructuredOutputRequest<T>): Promise<T> {
      captured.push(request as StructuredOutputRequest<unknown>);
      return request.schema.parse({ participants: [], events: [], facts: [], quotes: [] });
    },
  };

  const result = await perceiveOcrText({
    ocr: { lines: OCR_LINES, warnings: [], degraded: false },
    note: "合作安排",
    provider,
    now: new Date("2026-08-29T00:00:00.000Z"),
  });

  assert.deepEqual(result, { participants: [], events: [], facts: [], quotes: [] });
  assert.equal(captured.length, 1);
  const request = captured[0];
  assert.equal(request.messages[0].role, "system");
  assert.equal(typeof request.messages[1].content, "string");
  assert.match(String(request.messages[1].content), /\[side=them\] 下周三下午三点见/u);
  assert.match(String(request.messages[1].content), /User note: 合作安排/u);
  assert.equal(request.temperature, 0);
  assert.deepEqual(request.responseFormat, { type: "json_object" });
});
