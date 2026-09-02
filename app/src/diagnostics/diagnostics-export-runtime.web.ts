import type { ConnectionConfig } from "../connection/config";
import type { DiagnosticsExportResult } from "./diagnostics-export";

export async function exportLocalDiagnosticsBundle(_input: {
  connectionMode: ConnectionConfig["mode"] | null;
}): Promise<DiagnosticsExportResult> {
  throw new Error("Web 版不支持导出当前设备的本地诊断包。");
}
