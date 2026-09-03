import type { CrashRecord } from "./crash-record";
import type { EventLogEntry, PreviousSessionSnapshot } from "./event-log";
import type {
  ExitInfo,
  ExitTraceSaveResult,
} from "../../modules/tenglu-region-sampler/src/TengluRegionSampler.types";

export const MAX_VISIBLE_PREVIOUS_EVENTS = 20;

export type PreviousExitPanelCopy = {
  heading: string;
  intro: string;
};

export type ExitInfoReader = {
  readLastExitInfo(): Promise<ExitInfo[]>;
};

export type ExitTraceSaver = {
  saveLastExitTrace?(): Promise<ExitTraceSaveResult | null>;
};

export function shouldShowPreviousExit(
  crashRecord: CrashRecord | null,
  previousSession: PreviousSessionSnapshot | null | undefined,
) {
  return crashRecord !== null || previousSession?.possiblyAbnormalExit === true;
}

export function getPreviousExitPanelCopy(
  hasCrashRecord: boolean,
): PreviousExitPanelCopy {
  if (hasCrashRecord) {
    return {
      heading: "上次异常退出",
      intro: "已捕获到上次的崩溃记录。以下诊断信息已保存在本机，可以先截图，再继续使用。",
    };
  }

  return {
    heading: "上次可能异常退出",
    intro: "上次事件日志没有以进入后台结束，但未捕获到崩溃记录。以下信息可以帮助定位问题。",
  };
}

export function getRecentPreviousEvents(
  previousSession: PreviousSessionSnapshot | null | undefined,
) {
  return previousSession?.events.slice(-MAX_VISIBLE_PREVIOUS_EVENTS) ?? [];
}

export function formatEventLogEntry(entry: EventLogEntry) {
  return entry.detail
    ? `${entry.t}  ${entry.kind} · ${entry.detail}`
    : `${entry.t}  ${entry.kind}`;
}

export async function loadPreviousExitInfo(
  reader: ExitInfoReader,
  previousSession: PreviousSessionSnapshot | null | undefined,
  onMatch: (info: ExitInfo) => void = () => {},
): Promise<ExitInfo | null> {
  try {
    const previousAppStartedAt = previousSession?.appStartedAt
      ? Date.parse(previousSession.appStartedAt)
      : Number.NaN;
    const entries = await reader.readLastExitInfo();

    if (!Number.isFinite(previousAppStartedAt)) {
      return null;
    }

    const matching = entries
      .filter((entry) => (
        Number.isFinite(entry.timestamp) && entry.timestamp > previousAppStartedAt
      ))
      .sort((left, right) => right.timestamp - left.timestamp);

    for (const info of matching) {
      onMatch(info);
    }

    return matching[0] ?? null;
  } catch {
    return null;
  }
}

export async function savePreviousExitTrace(
  saver: ExitTraceSaver,
  info: ExitInfo | null,
  onResult: (result: ExitTraceSaveResult | null) => void = () => {},
): Promise<ExitTraceSaveResult | null> {
  if (!info) {
    return null;
  }

  let result: ExitTraceSaveResult | null = null;
  try {
    result = typeof saver.saveLastExitTrace === "function"
      ? await saver.saveLastExitTrace()
      : null;
  } catch {
    result = null;
  }

  try {
    onResult(result);
  } catch {
    // Diagnostics callbacks must not make startup fail.
  }
  return result;
}

export function formatExitReasonEventDetail(info: ExitInfo) {
  const description = Array.from(info.description?.trim() ?? "")
    .slice(0, 80)
    .join("");
  return [
    `reason_name=${info.reason_name}`,
    `status=${info.status}`,
    `pss_kb=${Math.round(info.pss_kb)}`,
    `has_trace=${info.has_trace}`,
    ...(description ? [`description=${description}`] : []),
  ].join(" ");
}

export function formatExitTraceEventDetail(result: ExitTraceSaveResult | null) {
  return result
    ? `byte_count=${Math.round(result.byte_count)} string_count=${Math.round(result.string_count)}`
    : "saved=false";
}

export function formatSavedExitTrace(result: ExitTraceSaveResult | null) {
  return result
    ? `已保存崩溃现场 ${Math.round(result.byte_count)} 字节`
    : "无崩溃现场";
}

export function formatSystemExitReason(info: ExitInfo | null | undefined) {
  if (!info) {
    return "系统未记录退出原因";
  }

  const description = info.description?.trim();
  return description
    ? `系统记录的退出原因：${info.reason_name}（${description}）`
    : `系统记录的退出原因：${info.reason_name}`;
}
