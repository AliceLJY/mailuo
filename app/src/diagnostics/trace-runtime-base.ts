import { configureDiagnosticsTraceWriter } from "./trace-store";
import { writeDeviceDiagnosticsTrace } from "./trace-storage-expo";

export function installDeviceDiagnosticsTraceWriter(): () => void {
  return configureDiagnosticsTraceWriter(writeDeviceDiagnosticsTrace);
}
