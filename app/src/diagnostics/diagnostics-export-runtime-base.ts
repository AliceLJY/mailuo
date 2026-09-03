import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { readDiagnosticsSnapshot } from "../api";
import type { ConnectionConfig } from "../connection/config";
import { readCrashRecord } from "./crash-record";
import { crashStorage } from "./crash-storage";
import {
  DiagnosticsExportError,
  writeDiagnosticsBundleToDirectory,
  type DiagnosticsExportResult,
  type ExitTraceExportSource,
} from "./diagnostics-export";
import { readEventLog } from "./event-log";
import { readDeviceDiagnosticsTraces } from "./trace-storage-expo";

export async function exportLocalDiagnosticsBundle(input: {
  connectionMode: ConnectionConfig["mode"] | null;
}): Promise<DiagnosticsExportResult> {
  if (Platform.OS === "web" || input.connectionMode !== "local") {
    throw new Error("诊断包只支持导出当前设备上的本地模式数据。");
  }

  let destination: Directory;
  try {
    destination = await Directory.pickDirectoryAsync();
  } catch {
    throw new Error("没有选定可写入的文件夹，诊断包未导出。");
  }

  try {
    return await writeDiagnosticsBundleToDirectory(destination, {
      snapshot: await readDiagnosticsSnapshot(),
      traces: await readDeviceDiagnosticsTraces(),
      exitTraceDirectory: openExitTraceExportSource(),
      eventLog: readEventLog(crashStorage),
      crashRecord: readCrashRecord(crashStorage),
      appVersion: Constants.expoConfig?.version ?? "unknown",
      platform: Platform.OS,
      connectionMode: input.connectionMode,
    });
  } catch (error) {
    if (error instanceof DiagnosticsExportError) {
      throw error;
    }

    const reason = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "未知错误";
    throw new Error(`导出诊断包失败：${reason}`);
  }
}

function openExitTraceExportSource(): ExitTraceExportSource | undefined {
  const source = new Directory(Paths.document, "diagnostics", "exit-traces");
  if (!source.exists) {
    return undefined;
  }

  return {
    listFileNames() {
      return source
        .list()
        .filter((entry): entry is File => entry instanceof File)
        .map((file) => file.name);
    },
    copyTo(destination) {
      return source.copy(new Directory(destination.uri));
    },
  };
}
