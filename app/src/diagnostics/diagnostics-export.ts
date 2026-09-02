import type { ConnectionConfig } from "../connection/config";
import type { DiagnosticsSnapshot } from "../local/types";
import type { CrashRecord } from "./crash-record";
import type { EventLogEntry } from "./event-log";
import {
  DiagnosticsTraceSchema,
  type DiagnosticsTrace,
} from "./trace-store";

export type DiagnosticsExportMeta = {
  app_version: string;
  exported_at: string;
  platform: string;
  connection_mode: ConnectionConfig["mode"];
  diagnostic_record_count: number;
};

export type DiagnosticsExportInput = {
  snapshot: DiagnosticsSnapshot;
  traces: readonly DiagnosticsTrace[];
  eventLog: readonly EventLogEntry[];
  crashRecord?: CrashRecord | null;
  appVersion: string;
  platform: string;
  connectionMode: ConnectionConfig["mode"];
  exportedAt?: Date;
};

export interface DiagnosticsExportFile {
  readonly uri: string;
  write(content: string): Promise<void> | void;
  text(): Promise<string>;
}

export interface DiagnosticsExportDirectoryEntry {
  readonly name: string;
}

export interface DiagnosticsExportDirectory {
  readonly uri: string;
  list(): readonly DiagnosticsExportDirectoryEntry[];
  createFile(name: string, mimeType: string | null): DiagnosticsExportFile;
  createDirectory(name: string): DiagnosticsExportDirectory;
}

export type DiagnosticsExportResult = {
  directoryName: string;
  directoryUri: string;
  files: string[];
};

export class DiagnosticsExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticsExportError";
  }
}

export function createDiagnosticsDirectoryName(exportedAt: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return `mailuo-diagnostics-${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}-${pad(exportedAt.getHours())}${pad(exportedAt.getMinutes())}`;
}

export async function writeDiagnosticsBundleToDirectory(
  destination: DiagnosticsExportDirectory,
  input: DiagnosticsExportInput,
): Promise<DiagnosticsExportResult> {
  const exportedAt = input.exportedAt ?? new Date();
  const directoryName = createDiagnosticsDirectoryName(exportedAt);
  const traces = input.traces
    .map((trace) => DiagnosticsTraceSchema.parse(trace))
    .sort((left, right) =>
      left.screenshot_id - right.screenshot_id ||
      Date.parse(left.finished_at) - Date.parse(right.finished_at) ||
      Date.parse(left.started_at) - Date.parse(right.started_at),
    );

  let existingEntries: readonly DiagnosticsExportDirectoryEntry[];
  try {
    existingEntries = destination.list();
  } catch (error) {
    throw new DiagnosticsExportError(`无法读取所选目录：${describeError(error)}`);
  }

  if (existingEntries.some((entry) => entry.name === directoryName)) {
    throw new DiagnosticsExportError(
      `所选位置已存在同名目录“${directoryName}”，未覆盖原文件。请稍后再试。`,
    );
  }

  let directory: DiagnosticsExportDirectory;
  try {
    directory = destination.createDirectory(directoryName);
  } catch (error) {
    throw new DiagnosticsExportError(
      `无法创建诊断包目录“${directoryName}”，可能已有同名目录：${describeError(error)}`,
    );
  }

  const files: string[] = [];
  const writeRootJson = async (name: string, value: unknown) => {
    await writeJsonFile(directory, name, value);
    files.push(name);
  };

  await writeRootJson("screenshots.json", input.snapshot.screenshots);
  await writeRootJson("action_cards.json", input.snapshot.action_cards);
  await writeRootJson("contacts.json", input.snapshot.contacts);
  await writeRootJson("observations.json", input.snapshot.observations);
  await writeRootJson("meetings.json", input.snapshot.meetings);
  await writeRootJson("insights.json", input.snapshot.insights);
  await writeRootJson("event-log.json", input.eventLog);

  let traceDirectory: DiagnosticsExportDirectory;
  try {
    traceDirectory = directory.createDirectory("traces");
  } catch (error) {
    throw new DiagnosticsExportError(`无法创建 traces 目录：${describeError(error)}`);
  }

  for (const { fileName, trace } of createTraceExportEntries(traces)) {
    await writeJsonFile(traceDirectory, fileName, trace);
    files.push(`traces/${fileName}`);
  }

  if (input.crashRecord) {
    await writeRootJson("crash-record.json", input.crashRecord);
  }

  const meta: DiagnosticsExportMeta = {
    app_version: input.appVersion,
    exported_at: exportedAt.toISOString(),
    platform: input.platform,
    connection_mode: input.connectionMode,
    diagnostic_record_count: traces.length,
  };
  await writeRootJson("meta.json", meta);

  return {
    directoryName,
    directoryUri: directory.uri,
    files,
  };
}

function createTraceExportEntries(traces: readonly DiagnosticsTrace[]) {
  const newestIndexByScreenshotId = new Map<number, number>();
  traces.forEach((trace, index) => {
    newestIndexByScreenshotId.set(trace.screenshot_id, index);
  });
  const usedNames = new Set<string>();

  return traces.map((trace, index) => {
    const newest = newestIndexByScreenshotId.get(trace.screenshot_id) === index;
    const archiveStamp = trace.started_at.replace(/\D/gu, "");
    const stem = newest
      ? `${trace.screenshot_id}`
      : `${trace.screenshot_id}-${archiveStamp}`;
    let fileName = `${stem}.json`;
    let suffix = 2;

    while (usedNames.has(fileName)) {
      fileName = `${stem}-${suffix}.json`;
      suffix += 1;
    }
    usedNames.add(fileName);

    return { fileName, trace };
  });
}

async function writeJsonFile(
  directory: DiagnosticsExportDirectory,
  name: string,
  value: unknown,
): Promise<void> {
  let content: string;
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) {
      throw new TypeError("内容无法序列化为 JSON");
    }
    content = `${serialized}\n`;
  } catch (error) {
    throw new DiagnosticsExportError(`${name} 无法生成：${describeError(error)}`);
  }

  try {
    const file = directory.createFile(name, "application/json");
    await file.write(content);
    const written = await file.text();
    JSON.parse(written);

    if (written !== content) {
      throw new Error("写入后的内容与原内容不一致");
    }
  } catch (error) {
    throw new DiagnosticsExportError(`${name} 写入后校验失败：${describeError(error)}`);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  const message = String(error).trim();
  return message || "未知错误";
}
