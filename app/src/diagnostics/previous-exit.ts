import type { CrashRecord } from "./crash-record";
import type { EventLogEntry, PreviousSessionSnapshot } from "./event-log";

export const MAX_VISIBLE_PREVIOUS_EVENTS = 20;

export type PreviousExitPanelCopy = {
  heading: string;
  intro: string;
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
