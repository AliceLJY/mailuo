export type RegionRequest = {
  id: string;
  frameIndex: number;
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ExtractedFrame = {
  uri: string;
  width: number;
  height: number;
  requestedTimeMs: number;
};

export type ExtractedFrameBatch = {
  frames: ExtractedFrame[];
  method: "MediaMetadataRetriever.OPTION_CLOSEST";
  staleFileCount: number;
  staleDeletedCount: number;
  elapsedMs: number;
};

export type FrameCleanupResult = {
  foundCount: number;
  deletedCount: number;
  remainingCount: number;
};

export type RegionSample = {
  id: string;
  frameIndex?: number;
  side: "me" | "them" | null;
  rgb?: number[];
  brightPixels?: number;
  decodedPixels?: number;
  sampledPixels?: number;
  width?: number;
  height?: number;
  error?: string;
  errorCode?: string;
  rect?: { x: number; y: number; width: number; height: number };
  frameWidth?: number;
  frameHeight?: number;
};

export type RegionSampleBatch = {
  samples: RegionSample[];
  decoderCount: number;
  elapsedMs: number;
};

export type ExitInfo = {
  reason: number;
  reason_name: string;
  status: number;
  description: string | null;
  timestamp: number;
  importance: number;
  pss_kb: number;
  rss_kb: number;
  has_trace: boolean;
};

export type ExitTraceSaveResult = {
  bin_path: string;
  strings_path: string;
  byte_count: number;
  string_count: number;
};

export type MemoryStats = {
  native_heap_kb: number;
  java_heap_kb: number;
  avail_mb: number;
  low_memory: boolean;
};
