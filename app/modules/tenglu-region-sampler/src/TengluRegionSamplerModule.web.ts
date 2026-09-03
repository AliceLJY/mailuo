import { registerWebModule, NativeModule } from 'expo';

import type {
  ExitInfo,
  ExitTraceSaveResult,
  JavaCrashRecord,
  MemoryStats,
} from './TengluRegionSampler.types';

// TengluRegionSamplerModule is not available on the web platform.
class TengluRegionSamplerModule extends NativeModule<{}> {}

export async function readLastExitInfo(): Promise<ExitInfo[]> {
  return [];
}

export async function saveLastExitTrace(): Promise<ExitTraceSaveResult | null> {
  return null;
}

export async function readLatestJavaCrash(): Promise<JavaCrashRecord | null> {
  return null;
}

export async function readMemoryStats(): Promise<MemoryStats | null> {
  return null;
}

export default registerWebModule(TengluRegionSamplerModule, 'TengluRegionSamplerModule');
