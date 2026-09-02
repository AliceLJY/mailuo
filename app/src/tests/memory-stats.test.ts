import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMemoryEventDetail,
  readHermesMemoryStats,
} from "../diagnostics/memory-stats";

test("Hermes memory sampling keeps only the requested heap fields in rounded KB", () => {
  const target = globalThis as typeof globalThis & {
    HermesInternal?: { getInstrumentedStats(): Record<string, unknown> };
  };
  const previous = target.HermesInternal;

  try {
    target.HermesInternal = {
      getInstrumentedStats() {
        return {
          js_heapSize: 2_560,
          js_allocatedBytes: 1_535,
          ignored: 99_999,
        };
      },
    };

    assert.deepEqual(readHermesMemoryStats(), {
      js_heap_kb: 3,
      js_allocated_kb: 1,
    });
  } finally {
    if (previous) {
      target.HermesInternal = previous;
    } else {
      delete target.HermesInternal;
    }
  }
});

test("memory event detail merges JS and native samples", () => {
  assert.equal(
    formatMemoryEventDetail(
      "route path=/insights",
      {
        native_heap_kb: 12_345.4,
        java_heap_kb: 23_456.5,
        avail_mb: 789.4,
        low_memory: false,
      },
      { js_heap_kb: 100, js_allocated_kb: 80 },
    ),
    "source=route path=/insights js_heap_kb=100 js_allocated_kb=80 native_heap_kb=12345 java_heap_kb=23457 avail_mb=789 low_memory=false",
  );
});
