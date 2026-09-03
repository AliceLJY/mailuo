import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DIAGNOSTICS_TRACES,
  readDiagnosticsTraces,
  writeDiagnosticsTrace,
  type DiagnosticsTrace,
  type DiagnosticsTraceDirectory,
  type DiagnosticsTraceFile,
} from "../diagnostics/trace-store";

class FakeTraceFile implements DiagnosticsTraceFile {
  content = "";

  constructor(
    readonly name: string,
    private readonly owner: FakeTraceDirectory,
    readonly modificationTime: number | null = null,
  ) {}

  write(content: string) {
    this.content = content;
  }

  async text() {
    return this.content;
  }

  delete() {
    this.owner.deleteFile(this.name);
  }
}

class FakeTraceDirectory implements DiagnosticsTraceDirectory {
  private readonly files = new Map<string, FakeTraceFile>();

  listFiles() {
    return [...this.files.values()];
  }

  createFile(name: string, _mimeType: string | null) {
    if (this.files.has(name)) {
      throw new Error(`file already exists: ${name}`);
    }

    const file = new FakeTraceFile(name, this);
    this.files.set(name, file);
    return file;
  }

  seed(name: string, content: string, modificationTime: number) {
    const file = new FakeTraceFile(name, this, modificationTime);
    file.content = content;
    this.files.set(name, file);
  }

  deleteFile(name: string) {
    this.files.delete(name);
  }
}

function buildTrace(
  screenshotId: number,
  finishedAt = new Date(Date.UTC(2026, 8, 2, 0, 0, screenshotId)).toISOString(),
): DiagnosticsTrace {
  return {
    screenshot_id: screenshotId,
    started_at: "2026-09-02T00:00:00.000Z",
    finished_at: finishedAt,
    perception_path: "cloud",
    extraction: null,
    resolutions: [],
    proposed_cards: [],
    meeting_dedup: [],
    notices: [],
  };
}

test("diagnostics trace writes and idempotently rewrites the same content", async () => {
  const directory = new FakeTraceDirectory();
  const trace = {
    ...buildTrace(7),
    perception_path: "ocr->cloud",
    ocr_text: "王磊：方案已发",
    batch_other_dedup: [{
      title: "准备来访车辆",
      matched_card_id: 19,
      similarity: 0.93,
    }],
    notice_routing: [{
      title: "通知邬导会议时间变更",
      decision: "batch" as const,
      target_title: "海棠项目碰头会",
    }],
    error: { name: "Error", message: "视觉整理失败" },
  } satisfies DiagnosticsTrace;
  await writeDiagnosticsTrace(directory, trace);
  await writeDiagnosticsTrace(directory, trace);

  assert.deepEqual(directory.listFiles().map((file) => file.name), ["7.json"]);
  assert.deepEqual(await readDiagnosticsTraces(directory), [{
    ...buildTrace(7),
    perception_path: "ocr->cloud",
    ocr_text: "王磊：方案已发",
    batch_other_dedup: [{
      title: "准备来访车辆",
      matched_card_id: 19,
      similarity: 0.93,
    }],
    notice_routing: [{
      title: "通知邬导会议时间变更",
      decision: "batch",
      target_title: "海棠项目碰头会",
    }],
    error: { name: "Error", message: "视觉整理失败" },
  }]);
});

test("a reused screenshot id archives the previous attempt and keeps the latest numeric file", async () => {
  const directory = new FakeTraceDirectory();
  const failed = {
    ...buildTrace(7, "2026-09-02T00:00:01.000Z"),
    error: { name: "Error", message: "模型暂时不可用" },
  } satisfies DiagnosticsTrace;
  const succeeded = {
    ...buildTrace(7, "2026-09-02T00:02:01.000Z"),
    started_at: "2026-09-02T00:02:00.000Z",
  } satisfies DiagnosticsTrace;

  await writeDiagnosticsTrace(directory, failed);
  await writeDiagnosticsTrace(directory, succeeded);

  assert.deepEqual(
    directory.listFiles().map((file) => file.name).sort(),
    ["7-20260902000000000.json", "7.json"],
  );
  assert.deepEqual(await readDiagnosticsTraces(directory), [failed, succeeded]);
});

test("the fifty-first diagnostics trace deletes the oldest finished_at record", async () => {
  const directory = new FakeTraceDirectory();

  for (let id = 1; id <= MAX_DIAGNOSTICS_TRACES + 1; id += 1) {
    await writeDiagnosticsTrace(directory, buildTrace(id));
  }

  const names = directory.listFiles().map((file) => file.name).sort();
  assert.equal(names.length, MAX_DIAGNOSTICS_TRACES);
  assert.equal(names.includes("1.json"), false);
  assert.equal(names.includes("51.json"), true);
});

test("trace retention falls back to mtime when finished_at cannot be read", async () => {
  const directory = new FakeTraceDirectory();
  directory.seed("damaged.json", "{}", 0);

  for (let id = 1; id <= MAX_DIAGNOSTICS_TRACES; id += 1) {
    await writeDiagnosticsTrace(directory, buildTrace(id));
  }

  assert.equal(directory.listFiles().some((file) => file.name === "damaged.json"), false);
  assert.equal(directory.listFiles().length, MAX_DIAGNOSTICS_TRACES);
});
