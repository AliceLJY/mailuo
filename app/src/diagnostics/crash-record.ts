import { appendEvent } from "./event-log";
import { readHermesInstrumentedStats } from "./memory-stats";

export const CRASH_RECORD_KEY = "mailuo.crash.last.v1";
export const MAX_CRASH_STACK_FRAMES = 8;

export type CrashBatchProgress = {
  position: number;
  totalCount: number;
  status: "pending" | "processing" | "success" | "failure";
};

export type CrashContext = {
  appVersion: string;
  currentRoute: string;
  batchProgress: CrashBatchProgress | null;
  exportOcrResults: boolean;
};

export type CrashRecord = {
  timestamp: string;
  message: string;
  name?: string;
  stackFrames?: string[];
  isFatal?: boolean;
  appVersion?: string;
  currentRoute?: string;
  batchProgress?: CrashBatchProgress | null;
  exportOcrResults?: boolean;
  hermesStats?: Record<string, number>;
};

export type CapturedCrashRecord = CrashRecord & {
  name: string;
  stackFrames: string[];
  isFatal: boolean;
  appVersion: string;
  currentRoute: string;
  batchProgress: CrashBatchProgress | null;
  exportOcrResults: boolean;
  hermesStats: Record<string, number>;
};

export type SyncCrashStorage = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
  removeItemSync(key: string): boolean;
};

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

type ErrorUtilsLike = {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
};

type CreateCrashRecordOptions = {
  context?: Partial<CrashContext>;
  hermesStats?: Record<string, unknown> | null;
  now?: () => Date;
};

const DEFAULT_CONTEXT: CrashContext = {
  appVersion: "unknown",
  currentRoute: "unknown",
  batchProgress: null,
  exportOcrResults: false,
};

let currentContext = DEFAULT_CONTEXT;

export function setCrashContext(patch: Partial<CrashContext>) {
  currentContext = { ...currentContext, ...patch };
}

export function createCrashRecord(
  error: unknown,
  isFatal: boolean,
  options: CreateCrashRecordOptions = {},
): CapturedCrashRecord {
  const context = options.context
    ? { ...DEFAULT_CONTEXT, ...options.context }
    : currentContext;
  const { message, name, stack } = describeError(error);
  const rawHermesStats = Object.prototype.hasOwnProperty.call(options, "hermesStats")
    ? options.hermesStats
    : readHermesInstrumentedStats();

  return {
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    name,
    message,
    stackFrames: extractStackFrames(stack, name, message),
    isFatal,
    appVersion: context.appVersion,
    currentRoute: context.currentRoute,
    batchProgress: context.batchProgress ? { ...context.batchProgress } : null,
    exportOcrResults: context.exportOcrResults,
    hermesStats: numericHermesStats(rawHermesStats),
  };
}

export function writeCrashRecord(
  storage: SyncCrashStorage,
  error: unknown,
  isFatal: boolean,
  options: CreateCrashRecordOptions = {},
) {
  const record = createCrashRecord(error, isFatal, options);

  try {
    storage.setItemSync(CRASH_RECORD_KEY, JSON.stringify(record));
  } catch {
    // A crash reporter must not replace the original error with a storage failure.
  }

  appendEvent(storage, "crash", record.message);

  return record;
}

export function readCrashRecord(storage: SyncCrashStorage): CrashRecord | null {
  try {
    const serialized = storage.getItemSync(CRASH_RECORD_KEY);
    if (!serialized) {
      return null;
    }

    return toCrashRecord(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export function clearCrashRecord(storage: SyncCrashStorage) {
  try {
    storage.removeItemSync(CRASH_RECORD_KEY);
    return true;
  } catch {
    return false;
  }
}

export function installGlobalCrashHandler(
  storage: SyncCrashStorage,
  errorUtils: ErrorUtilsLike | null = getErrorUtils(),
) {
  if (!errorUtils) {
    return () => {};
  }

  const originalHandler = errorUtils.getGlobalHandler();
  const crashHandler: GlobalErrorHandler = (error, isFatal) => {
    try {
      writeCrashRecord(storage, error, Boolean(isFatal));
    } finally {
      originalHandler(error, isFatal);
    }
  };

  errorUtils.setGlobalHandler(crashHandler);

  return () => {
    if (errorUtils.getGlobalHandler() === crashHandler) {
      errorUtils.setGlobalHandler(originalHandler);
    }
  };
}

function describeError(error: unknown) {
  let name = "Error";
  let message = "Unknown error";
  let stack: string | null = null;

  try {
    if (error && typeof error === "object") {
      const candidate = error as { message?: unknown; name?: unknown; stack?: unknown };
      if (typeof candidate.name === "string" && candidate.name) {
        name = candidate.name;
      }
      if (typeof candidate.message === "string" && candidate.message) {
        message = candidate.message;
      } else {
        message = String(error);
      }
      if (typeof candidate.stack === "string") {
        stack = candidate.stack;
      }
    } else if (typeof error === "string") {
      message = error;
    } else {
      message = String(error);
    }
  } catch {
    message = "Unknown error";
  }

  return { name, message, stack };
}

function extractStackFrames(
  stack: string | null,
  name: string,
  message: string,
) {
  if (!stack) {
    return [];
  }

  const lines = stack
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines[0];
  const startsWithHeader =
    header === name ||
    header === message ||
    header === `${name}: ${message}` ||
    header?.startsWith(`${name}:`) === true;

  return lines
    .slice(startsWithHeader ? 1 : 0, (startsWithHeader ? 1 : 0) + MAX_CRASH_STACK_FRAMES);
}

function getErrorUtils(): ErrorUtilsLike | null {
  const errorUtils = (globalThis as typeof globalThis & {
    ErrorUtils?: Partial<ErrorUtilsLike>;
  }).ErrorUtils;

  return (
    typeof errorUtils?.getGlobalHandler === "function" &&
    typeof errorUtils.setGlobalHandler === "function"
  )
    ? errorUtils as ErrorUtilsLike
    : null;
}

function numericHermesStats(stats: Record<string, unknown> | null | undefined) {
  const numeric: Record<string, number> = {};

  try {
    for (const [key, value] of Object.entries(stats ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) {
        numeric[key] = value;
      }
    }
  } catch {
    return {};
  }

  return numeric;
}

function toCrashRecord(value: unknown): CrashRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CrashRecord>;
  if (
    typeof candidate.timestamp !== "string" ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }

  const record: CrashRecord = {
    timestamp: candidate.timestamp,
    message: candidate.message,
  };

  if (typeof candidate.name === "string") {
    record.name = candidate.name;
  }
  if (Array.isArray(candidate.stackFrames)) {
    record.stackFrames = candidate.stackFrames
      .filter((frame): frame is string => typeof frame === "string")
      .slice(0, MAX_CRASH_STACK_FRAMES);
  }
  if (typeof candidate.isFatal === "boolean") {
    record.isFatal = candidate.isFatal;
  }
  if (typeof candidate.appVersion === "string") {
    record.appVersion = candidate.appVersion;
  }
  if (typeof candidate.currentRoute === "string") {
    record.currentRoute = candidate.currentRoute;
  }
  if (candidate.batchProgress === null || isBatchProgress(candidate.batchProgress)) {
    record.batchProgress = candidate.batchProgress;
  }
  if (typeof candidate.exportOcrResults === "boolean") {
    record.exportOcrResults = candidate.exportOcrResults;
  }
  if (isObjectRecord(candidate.hermesStats)) {
    record.hermesStats = numericHermesStats(candidate.hermesStats);
  }

  return record;
}

function isBatchProgress(value: unknown): value is CrashBatchProgress | null {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CrashBatchProgress>;
  return (
    typeof candidate.position === "number" &&
    Number.isInteger(candidate.position) &&
    candidate.position >= 1 &&
    typeof candidate.totalCount === "number" &&
    Number.isInteger(candidate.totalCount) &&
    candidate.totalCount >= 1 &&
    candidate.position <= candidate.totalCount &&
    candidate.status !== undefined &&
    ["pending", "processing", "success", "failure"].includes(candidate.status)
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
