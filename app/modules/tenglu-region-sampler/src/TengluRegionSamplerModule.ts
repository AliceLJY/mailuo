import { NativeModule, requireOptionalNativeModule } from 'expo';

// Copied unchanged from Tenglu v0.3.0's device-verified region sampler.

import type {
  ExtractedFrameBatch,
  ExitInfo,
  ExitTraceSaveResult,
  FrameCleanupResult,
  JavaCrashRecord,
  MemoryStats,
  RegionRequest,
  RegionSampleBatch,
} from './TengluRegionSampler.types';

declare class TengluRegionSamplerModule extends NativeModule<{}> {
  extractFrames(sourceUri: string, timesJson: string): Promise<string>;
  cleanupFrames(): Promise<string>;
  sampleRegions(requestsJson: string): Promise<string>;
  readLastExitInfo?(): Promise<unknown>;
  saveLastExitTrace?(): Promise<unknown>;
  readLatestJavaCrash?(): Promise<unknown>;
  readMemoryStats?(): Promise<unknown>;
}

const nativeModule = requireOptionalNativeModule<TengluRegionSamplerModule>(
  'TengluRegionSampler',
);

function requireModule(): TengluRegionSamplerModule {
  if (!nativeModule) {
    throw new Error('TengluRegionSampler native module is unavailable');
  }

  return nativeModule;
}

export async function extractFrames(
  sourceUri: string,
  timesMs: number[],
): Promise<ExtractedFrameBatch> {
  return JSON.parse(
    await requireModule().extractFrames(sourceUri, JSON.stringify(timesMs)),
  );
}

export async function cleanupFrames(): Promise<FrameCleanupResult> {
  return JSON.parse(await requireModule().cleanupFrames());
}

export async function sampleRegions(
  requests: RegionRequest[],
): Promise<RegionSampleBatch> {
  return JSON.parse(await requireModule().sampleRegions(JSON.stringify(requests)));
}

export async function readLastExitInfo(): Promise<ExitInfo[]> {
  if (typeof nativeModule?.readLastExitInfo !== 'function') {
    return [];
  }

  try {
    const result = await nativeModule.readLastExitInfo();
    return Array.isArray(result)
      ? result
          .map(parseExitInfo)
          .filter((item): item is ExitInfo => item !== null)
      : [];
  } catch {
    return [];
  }
}

export async function saveLastExitTrace(): Promise<ExitTraceSaveResult | null> {
  if (typeof nativeModule?.saveLastExitTrace !== 'function') {
    return null;
  }

  try {
    const result = await nativeModule.saveLastExitTrace();
    return isExitTraceSaveResult(result) ? result : null;
  } catch {
    return null;
  }
}

export async function readLatestJavaCrash(): Promise<JavaCrashRecord | null> {
  if (typeof nativeModule?.readLatestJavaCrash !== 'function') {
    return null;
  }

  try {
    const result = await nativeModule.readLatestJavaCrash();
    return isJavaCrashRecord(result) ? result : null;
  } catch {
    return null;
  }
}

export async function readMemoryStats(): Promise<MemoryStats | null> {
  if (typeof nativeModule?.readMemoryStats !== 'function') {
    return null;
  }

  try {
    const result = await nativeModule.readMemoryStats();
    return isMemoryStats(result) ? result : null;
  } catch {
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseExitInfo(value: unknown): ExitInfo | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = value as Partial<ExitInfo>;
  if (
    !isFiniteNumber(item.reason) ||
    typeof item.reason_name !== 'string' ||
    !isFiniteNumber(item.status) ||
    (typeof item.description !== 'string' && item.description !== null) ||
    !isFiniteNumber(item.timestamp) ||
    !isFiniteNumber(item.importance) ||
    !isFiniteNumber(item.pss_kb) ||
    !isFiniteNumber(item.rss_kb) ||
    (item.has_trace !== undefined && typeof item.has_trace !== 'boolean')
  ) {
    return null;
  }

  return {
    reason: item.reason,
    reason_name: item.reason_name,
    status: item.status,
    description: item.description,
    timestamp: item.timestamp,
    importance: item.importance,
    pss_kb: item.pss_kb,
    rss_kb: item.rss_kb,
    has_trace: item.has_trace ?? false,
  };
}

function isExitTraceSaveResult(value: unknown): value is ExitTraceSaveResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const result = value as Partial<ExitTraceSaveResult>;
  return (
    typeof result.bin_path === 'string' &&
    result.bin_path.length > 0 &&
    typeof result.strings_path === 'string' &&
    result.strings_path.length > 0 &&
    Number.isSafeInteger(result.byte_count) &&
    (result.byte_count ?? -1) >= 0 &&
    Number.isSafeInteger(result.string_count) &&
    (result.string_count ?? -1) >= 0
  );
}

function isJavaCrashRecord(value: unknown): value is JavaCrashRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const result = value as Partial<JavaCrashRecord>;
  return (
    typeof result.path === 'string' &&
    result.path.length > 0 &&
    Number.isSafeInteger(result.timestamp) &&
    (result.timestamp ?? -1) >= 0 &&
    typeof result.head === 'string'
  );
}

function isMemoryStats(value: unknown): value is MemoryStats {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const stats = value as Partial<MemoryStats>;
  return (
    isFiniteNumber(stats.native_heap_kb) &&
    isFiniteNumber(stats.java_heap_kb) &&
    isFiniteNumber(stats.avail_mb) &&
    typeof stats.low_memory === 'boolean'
  );
}

export default nativeModule;
