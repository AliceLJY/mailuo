import assert from "node:assert/strict";
import test from "node:test";

import {
  writeDiagnosticsBundleToDirectory,
  type DiagnosticsDirectoryExportSource,
  type DiagnosticsExportDirectory,
  type DiagnosticsExportFile,
} from "../diagnostics/diagnostics-export";
import type { DiagnosticsTrace } from "../diagnostics/trace-store";
import type { DiagnosticsSnapshot } from "../local/types";

class FakeExportFile implements DiagnosticsExportFile {
  content = "";

  constructor(
    readonly name: string,
    readonly uri: string,
    private readonly writes: string[],
  ) {}

  write(content: string) {
    this.content = content;
    this.writes.push(this.uri);
  }

  async text() {
    return this.content;
  }
}

class FakeExportDirectory implements DiagnosticsExportDirectory {
  private readonly files = new Map<string, FakeExportFile>();
  private readonly directories = new Map<string, FakeExportDirectory>();

  constructor(
    readonly name: string,
    readonly uri: string,
    private readonly writes: string[] = [],
  ) {}

  list() {
    return [...this.directories.values(), ...this.files.values()];
  }

  createFile(name: string, _mimeType: string | null) {
    if (this.files.has(name) || this.directories.has(name)) {
      throw new Error(`entry already exists: ${name}`);
    }

    const file = new FakeExportFile(name, `${this.uri}${name}`, this.writes);
    this.files.set(name, file);
    return file;
  }

  createDirectory(name: string) {
    if (this.files.has(name) || this.directories.has(name)) {
      throw new Error(`entry already exists: ${name}`);
    }

    const directory = new FakeExportDirectory(name, `${this.uri}${name}/`, this.writes);
    this.directories.set(name, directory);
    return directory;
  }

  getDirectory(name: string) {
    return this.directories.get(name);
  }

  getFile(name: string) {
    return this.files.get(name);
  }

  writtenUris() {
    return [...this.writes];
  }

  listFilePaths(prefix = ""): string[] {
    return [
      ...[...this.files.keys()].map((name) => `${prefix}${name}`),
      ...[...this.directories].flatMap(([name, directory]) =>
        directory.listFilePaths(`${prefix}${name}/`),
      ),
    ].sort();
  }
}

class FakeDiagnosticsDirectorySource implements DiagnosticsDirectoryExportSource {
  constructor(
    private readonly directoryName: string,
    private readonly files: ReadonlyMap<string, string>,
  ) {}

  listFileNames() {
    return [...this.files.keys()];
  }

  copyTo(destination: DiagnosticsExportDirectory) {
    const copied = destination.createDirectory(this.directoryName);
    for (const [name, content] of this.files) {
      copied.createFile(name, null).write(content);
    }
  }
}

const snapshot: DiagnosticsSnapshot = {
  screenshots: [{
    id: 42,
    image_path: "file:///fake/meeting.png",
    user_note: "某集团 市场部通知",
    raw_extraction: {
      participants: [],
      events: [],
      facts: [],
      quotes: [],
    },
    uploaded_at: "2026-09-02T01:00:00.000Z",
  }],
  action_cards: [],
  contacts: [],
  observations: [],
  meetings: [],
  insights: [],
};

const trace: DiagnosticsTrace = {
  screenshot_id: 42,
  started_at: "2026-09-02T01:00:00.000Z",
  finished_at: "2026-09-02T01:00:01.000Z",
  perception_path: "ocr",
  ocr_text: "王磊：材料已发",
  extraction: snapshot.screenshots[0]?.raw_extraction ?? null,
  resolutions: [],
  proposed_cards: [],
  meeting_dedup: [],
  notices: [],
};

test("diagnostics writer creates the exact bundle file set and writes meta last", async () => {
  const destination = new FakeExportDirectory("picked", "fake:///picked/");
  const result = await writeDiagnosticsBundleToDirectory(destination, {
    snapshot,
    traces: [trace],
    exitTraceDirectory: new FakeDiagnosticsDirectorySource("exit-traces", new Map([
      ["1788397205000.bin", "binary tombstone"],
      ["1788397205000.strings.txt", "backtrace\nlibreactnative.so\n"],
    ])),
    javaCrashDirectory: new FakeDiagnosticsDirectorySource("java-crashes", new Map([
      ["1788397206000.txt", "exception_class=java.lang.IllegalStateException\n"],
    ])),
    eventLog: [{ t: "2026-09-02T01:00:00.000Z", kind: "app_start", detail: "" }],
    crashRecord: {
      timestamp: "2026-09-02T00:59:00.000Z",
      message: "测试异常",
    },
    appVersion: "3.1.4",
    platform: "android",
    connectionMode: "local",
    exportedAt: new Date(2026, 8, 2, 9, 7),
  });
  const bundle = destination.getDirectory(result.directoryName);

  assert.equal(result.directoryName, "mailuo-diagnostics-20260902-0907");
  assert.ok(bundle);
  assert.deepEqual(bundle.listFilePaths(), [
    "action_cards.json",
    "contacts.json",
    "crash-record.json",
    "event-log.json",
    "exit-traces/1788397205000.bin",
    "exit-traces/1788397205000.strings.txt",
    "insights.json",
    "java-crashes/1788397206000.txt",
    "meetings.json",
    "meta.json",
    "observations.json",
    "screenshots.json",
    "traces/42.json",
  ]);
  assert.equal(result.files.at(-1), "meta.json");
  assert.equal(bundle.writtenUris().at(-1), `${bundle.uri}meta.json`);

  const meta = JSON.parse(bundle.getFile("meta.json")?.content ?? "null");
  assert.deepEqual(meta, {
    app_version: "3.1.4",
    exported_at: new Date(2026, 8, 2, 9, 7).toISOString(),
    platform: "android",
    connection_mode: "local",
    diagnostic_record_count: 1,
  });
  const screenshots = JSON.parse(bundle.getFile("screenshots.json")?.content ?? "null");
  assert.equal(screenshots[0].user_note, "某集团 市场部通知");
  assert.deepEqual(screenshots[0].raw_extraction, snapshot.screenshots[0]?.raw_extraction);
  assert.deepEqual(
    bundle.getDirectory("exit-traces")?.listFilePaths(),
    ["1788397205000.bin", "1788397205000.strings.txt"],
  );
  assert.deepEqual(
    bundle.getDirectory("java-crashes")?.listFilePaths(),
    ["1788397206000.txt"],
  );
});

test("diagnostics writer keeps crash-record optional", async () => {
  const destination = new FakeExportDirectory("picked", "fake:///picked/");
  const result = await writeDiagnosticsBundleToDirectory(destination, {
    snapshot,
    traces: [],
    eventLog: [],
    appVersion: "3.1.4",
    platform: "ios",
    connectionMode: "local",
    exportedAt: new Date(2026, 8, 2, 9, 8),
  });
  const bundle = destination.getDirectory(result.directoryName);

  assert.ok(bundle);
  assert.ok(bundle.getDirectory("exit-traces"));
  assert.ok(bundle.getDirectory("java-crashes"));
  assert.equal(bundle.listFilePaths().includes("crash-record.json"), false);
  assert.deepEqual(bundle.listFilePaths(), [
    "action_cards.json",
    "contacts.json",
    "event-log.json",
    "insights.json",
    "meetings.json",
    "meta.json",
    "observations.json",
    "screenshots.json",
  ]);
});

test("diagnostics writer preserves every attempt when SQLite reuses a screenshot id", async () => {
  const destination = new FakeExportDirectory("picked", "fake:///picked/");
  const failed = {
    ...trace,
    finished_at: "2026-09-02T01:00:01.000Z",
    error: { name: "Error", message: "模型暂时不可用" },
  } satisfies DiagnosticsTrace;
  const succeeded = {
    ...trace,
    started_at: "2026-09-02T01:02:00.000Z",
    finished_at: "2026-09-02T01:02:01.000Z",
    ocr_text: "王磊：材料已重新发出",
  } satisfies DiagnosticsTrace;
  const result = await writeDiagnosticsBundleToDirectory(destination, {
    snapshot,
    traces: [succeeded, failed],
    eventLog: [],
    appVersion: "3.1.4",
    platform: "android",
    connectionMode: "local",
    exportedAt: new Date(2026, 8, 2, 9, 10),
  });
  const bundle = destination.getDirectory(result.directoryName);
  const tracesDirectory = bundle?.getDirectory("traces");

  assert.ok(bundle);
  assert.ok(tracesDirectory);
  assert.deepEqual(tracesDirectory.listFilePaths(), [
    "42-20260902010000000.json",
    "42.json",
  ]);
  assert.equal(
    JSON.parse(tracesDirectory.getFile("42-20260902010000000.json")?.content ?? "null").error.message,
    "模型暂时不可用",
  );
  assert.equal(
    JSON.parse(tracesDirectory.getFile("42.json")?.content ?? "null").ocr_text,
    "王磊：材料已重新发出",
  );
  assert.equal(
    JSON.parse(bundle.getFile("meta.json")?.content ?? "null").diagnostic_record_count,
    2,
  );
});

test("diagnostics writer refuses to overwrite a same-name directory", async () => {
  const destination = new FakeExportDirectory("picked", "fake:///picked/");
  const existing = destination.createDirectory("mailuo-diagnostics-20260902-0909");
  existing.createFile("keep.txt", "text/plain").write("do not overwrite");

  await assert.rejects(
    writeDiagnosticsBundleToDirectory(destination, {
      snapshot,
      traces: [],
      eventLog: [],
      appVersion: "3.1.4",
      platform: "android",
      connectionMode: "local",
      exportedAt: new Date(2026, 8, 2, 9, 9),
    }),
    /已存在同名目录.*未覆盖/u,
  );
  assert.equal(existing.getFile("keep.txt")?.content, "do not overwrite");
});
