import type { MemoryStats } from "../../modules/tenglu-region-sampler/src/TengluRegionSampler.types";

type HermesInternalLike = {
  getInstrumentedStats?: () => Record<string, unknown>;
};

export type HermesMemoryStats = {
  js_heap_kb?: number;
  js_allocated_kb?: number;
};

export function readHermesInstrumentedStats(): Record<string, unknown> | null {
  try {
    const hermes = (globalThis as typeof globalThis & {
      HermesInternal?: HermesInternalLike | null;
    }).HermesInternal;
    return hermes?.getInstrumentedStats?.() ?? null;
  } catch {
    return null;
  }
}

export function readHermesMemoryStats(): HermesMemoryStats {
  const stats = readHermesInstrumentedStats();
  const jsHeapKb = bytesToKilobytes(stats?.js_heapSize);
  const jsAllocatedKb = bytesToKilobytes(stats?.js_allocatedBytes);

  return {
    ...(jsHeapKb === undefined ? {} : { js_heap_kb: jsHeapKb }),
    ...(jsAllocatedKb === undefined ? {} : { js_allocated_kb: jsAllocatedKb }),
  };
}

export function formatMemoryEventDetail(
  source: string,
  nativeStats: MemoryStats | null = null,
  hermesStats: HermesMemoryStats = readHermesMemoryStats(),
) {
  const parts = [`source=${source}`];

  if (hermesStats.js_heap_kb !== undefined) {
    parts.push(`js_heap_kb=${hermesStats.js_heap_kb}`);
  }
  if (hermesStats.js_allocated_kb !== undefined) {
    parts.push(`js_allocated_kb=${hermesStats.js_allocated_kb}`);
  }
  if (nativeStats) {
    parts.push(
      `native_heap_kb=${Math.round(nativeStats.native_heap_kb)}`,
      `java_heap_kb=${Math.round(nativeStats.java_heap_kb)}`,
      `avail_mb=${Math.round(nativeStats.avail_mb)}`,
      `low_memory=${nativeStats.low_memory}`,
    );
  }

  return parts.join(" ");
}

function bytesToKilobytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value / 1024)
    : undefined;
}
