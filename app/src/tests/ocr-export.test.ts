import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildOcrExportBundle,
  OcrExportBundleSchema,
  writeOcrExportToDirectory,
} from "../local/ocr-export";

test("a constructed OCR result is written as one schema-valid JSON file", async () => {
  const exportedAt = new Date("2026-08-29T03:04:05.000Z");
  const bundle = buildOcrExportBundle({
    exportedAt,
    source: {
      name: "screenshot-1.png",
      mimeType: "image/png",
      width: 390,
      height: 844,
      md5: "0123456789abcdef0123456789abcdef",
    },
    result: {
      lines: [
        {
          text: "周二上午十点见",
          side: "them",
          x: 24,
          y: 128,
          width: 168,
          height: 32,
          confidence: 0.914,
        },
        {
          text: "好",
          side: null,
          x: 172,
          y: 192,
          width: 32,
          height: 30,
          confidence: null,
        },
      ],
      warnings: ["第 2 行底色未判定"],
      degraded: true,
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "mailuo-ocr-export-"));
  let destination = "";

  const exported = await writeOcrExportToDirectory(
    {
      createFile(name, mimeType) {
        assert.equal(mimeType, "application/json");
        destination = join(directory, name);
        return {
          uri: destination,
          write: (content) => writeFile(destination, content, "utf8"),
          text: () => readFile(destination, "utf8"),
        };
      },
    },
    bundle,
  );

  assert.equal(exported.fileUri, destination);
  assert.match(exported.fileName, /^mailuo-ocr-20260829T030405-000Z\.json$/u);

  const written = await readFile(destination, "utf8");
  const parsed = OcrExportBundleSchema.parse(JSON.parse(written));
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(parsed.lines[0], {
    text: "周二上午十点见",
    x: 24,
    y: 128,
    w: 168,
    h: 32,
    conf: 0.914,
    side: "them",
  });
  assert.deepEqual(parsed.warnings, ["第 2 行底色未判定"]);
  assert.equal(parsed.degraded, true);
});

test("zero lines add an explicit warning and derive degraded from warnings", () => {
  const bundle = buildOcrExportBundle({
    exportedAt: new Date("2026-08-29T03:04:05.000Z"),
    source: { md5: "0123456789abcdef0123456789abcdef" },
    result: { lines: [], warnings: [], degraded: false },
  });

  assert.deepEqual(bundle.warnings, ["未识别到文本行"]);
  assert.equal(bundle.degraded, true);
});
