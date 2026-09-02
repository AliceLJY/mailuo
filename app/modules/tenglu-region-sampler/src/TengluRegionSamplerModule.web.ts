import { registerWebModule, NativeModule } from 'expo';

import type {
  ExitInfo,
  MemoryStats,
} from './TengluRegionSampler.types';

// TengluRegionSamplerModule is not available on the web platform.
class TengluRegionSamplerModule extends NativeModule<{}> {}

export async function readLastExitInfo(): Promise<ExitInfo[]> {
  return [];
}

export async function readMemoryStats(): Promise<MemoryStats | null> {
  return null;
}

export default registerWebModule(TengluRegionSamplerModule, 'TengluRegionSamplerModule');
