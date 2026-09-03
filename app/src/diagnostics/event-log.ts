import { formatMemoryEventDetail } from "./memory-stats";

export const EVENT_LOG_KEY = "mailuo.eventlog.v1";
export const MAX_EVENT_LOG_ENTRIES = 200;
export const MAX_EVENT_DETAIL_CODE_POINTS = 120;
export const MAX_DIAGNOSTIC_EVENT_DETAIL_CODE_POINTS = 200;
export const MAX_JAVA_CRASH_EVENT_DETAIL_CODE_POINTS = 400;

export const EVENT_KINDS = [
  "app_start",
  "route",
  "transition_start",
  "transition_done",
  "upload_start",
  "upload_progress",
  "upload_done",
  "confirm_start",
  "confirm_ok",
  "confirm_error",
  "reject",
  "clear_all",
  "app_background",
  "app_active",
  "crash",
  "java_crash",
  "acknowledged",
  "exit_reason",
  "exit_trace",
  "insights_start",
  "insights_ok",
  "insights_error",
  "notice_routed",
  "mem",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type EventLogEntry = {
  t: string;
  kind: EventKind;
  detail: string;
};

export type SyncEventLogStorage = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
};

export type PreviousSessionSnapshot = {
  events: EventLogEntry[];
  appStartedAt: string | null;
  lastEvent: EventLogEntry;
  possiblyAbnormalExit: boolean;
};

type EventWriteOptions = {
  now?: () => Date;
};

let configuredStorage: SyncEventLogStorage | null = null;

export function configureEventLogStorage(
  storage: SyncEventLogStorage | null,
) {
  configuredStorage = storage;
}

export function readEventLog(
  storage: SyncEventLogStorage | null = configuredStorage,
): EventLogEntry[] {
  if (!storage) {
    return [];
  }

  try {
    const serialized = storage.getItemSync(EVENT_LOG_KEY);
    if (!serialized) {
      return [];
    }

    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(toEventLogEntry)
      .filter((entry): entry is EventLogEntry => entry !== null)
      .slice(-MAX_EVENT_LOG_ENTRIES);
  } catch {
    return [];
  }
}

export function appendEvent(
  storage: SyncEventLogStorage | null,
  kind: EventKind,
  detail = "",
  options: EventWriteOptions = {},
): EventLogEntry | null {
  if (!storage) {
    return null;
  }

  try {
    const entry: EventLogEntry = {
      t: (options.now ?? (() => new Date()))().toISOString(),
      kind,
      detail: truncateCodePoints(detail, eventDetailLimit(kind)),
    };
    const entries = [...readEventLog(storage), entry]
      .slice(-MAX_EVENT_LOG_ENTRIES);
    storage.setItemSync(EVENT_LOG_KEY, JSON.stringify(entries));
    return entry;
  } catch {
    return null;
  }
}

export function logEvent(kind: EventKind, detail = "") {
  const entry = appendEvent(configuredStorage, kind, detail);

  if (kind === "upload_progress") {
    appendEvent(
      configuredStorage,
      "mem",
      formatMemoryEventDetail("upload_progress"),
    );
  }

  return entry;
}

export function capturePreviousSession(
  storage: SyncEventLogStorage | null = configuredStorage,
): PreviousSessionSnapshot | null {
  const entries = readEventLog(storage);
  if (entries.length === 0) {
    return null;
  }

  const latestStartIndex = findLatestAppStart(entries);
  const events = entries.slice(latestStartIndex < 0 ? 0 : latestStartIndex);
  const lastEvent = events[events.length - 1];
  if (!lastEvent) {
    return null;
  }
  const lastLifecycleEvent = findLastLifecycleEvent(events);

  return {
    events,
    appStartedAt: latestStartIndex < 0 ? null : entries[latestStartIndex]?.t ?? null,
    lastEvent,
    possiblyAbnormalExit: lastLifecycleEvent?.kind !== "app_background",
  };
}

export function startAppSession(
  storage: SyncEventLogStorage | null | undefined = undefined,
  options: EventWriteOptions = {},
) {
  if (storage !== undefined) {
    configureEventLogStorage(storage);
  }

  const target = storage === undefined ? configuredStorage : storage;
  const previousSession = capturePreviousSession(target);
  appendEvent(target, "app_start", "", options);
  return previousSession;
}

export function acknowledgePreviousSession(
  storage: SyncEventLogStorage | null | undefined,
  previousSession: PreviousSessionSnapshot | null,
  options: EventWriteOptions = {},
) {
  const target = storage === undefined ? configuredStorage : storage;
  const detail = previousSession?.appStartedAt
    ? `previous_app_start=${previousSession.appStartedAt}`
    : previousSession
      ? `previous_last=${previousSession.lastEvent.t}/${previousSession.lastEvent.kind}`
      : "previous_session=unknown";

  return appendEvent(target, "acknowledged", detail, options);
}

function findLatestAppStart(entries: EventLogEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === "app_start") {
      return index;
    }
  }
  return -1;
}

function findLastLifecycleEvent(entries: EventLogEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === "app_start" ||
      entry?.kind === "app_active" ||
      entry?.kind === "app_background"
    ) {
      return entry;
    }
  }
  return null;
}

function toEventLogEntry(value: unknown): EventLogEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<EventLogEntry>;
  if (
    typeof candidate.t !== "string" ||
    !isEventKind(candidate.kind) ||
    (candidate.detail !== undefined && typeof candidate.detail !== "string")
  ) {
    return null;
  }

  return {
    t: candidate.t,
    kind: candidate.kind,
    detail: truncateCodePoints(
      candidate.detail ?? "",
      eventDetailLimit(candidate.kind),
    ),
  };
}

function eventDetailLimit(kind: EventKind) {
  if (kind === "java_crash") {
    return MAX_JAVA_CRASH_EVENT_DETAIL_CODE_POINTS;
  }

  return kind === "exit_reason" || kind === "exit_trace" || kind === "mem"
    ? MAX_DIAGNOSTIC_EVENT_DETAIL_CODE_POINTS
    : MAX_EVENT_DETAIL_CODE_POINTS;
}

function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && EVENT_KINDS.some((kind) => kind === value);
}

function truncateCodePoints(value: string, limit: number) {
  return Array.from(value).slice(0, limit).join("");
}
