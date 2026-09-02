import { NativeModule, requireOptionalNativeModule } from 'expo';

// Copied unchanged from Tenglu v0.3.0's device-verified region sampler.

import type {
  ExtractedFrameBatch,
  ExitInfo,
  FrameCleanupResult,
  MemoryStats,
  RegionRequest,
  RegionSampleBatch,
} from './TengluRegionSampler.types';

declare class TengluRegionSamplerModule extends NativeModule<{}> {
  extractFrames(sourceUri: string, timesJson: string): Promise<string>;
  cleanupFrames(): Promise<string>;
  sampleRegions(requestsJson: string): Promise<string>;
  readLastExitInfo?(): Promise<unknown>;
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
      ? result.filter(isExitInfo)
      : [];
  } catch {
    return [];
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

function isExitInfo(value: unknown): value is ExitInfo {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Partial<ExitInfo>;
  return (
    isFiniteNumber(item.reason) &&
    typeof item.reason_name === 'string' &&
    isFiniteNumber(item.status) &&
    (typeof item.description === 'string' || item.description === null) &&
    isFiniteNumber(item.timestamp) &&
    isFiniteNumber(item.importance) &&
    isFiniteNumber(item.pss_kb) &&
    isFiniteNumber(item.rss_kb)
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
