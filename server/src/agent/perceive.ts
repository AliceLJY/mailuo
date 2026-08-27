import {
  perceiveScreenshot as perceiveScreenshotCore,
  type PerceptionResult,
} from '../../../shared/core/agent/perceive.ts';
import type { StructuredOutputProvider } from '../../../shared/core/llm/provider.ts';
import { createQwenProvider, readScreenshotImage } from '../llm/qwen.ts';

export {
  isSelfName,
  parseStoredPerceptionResult,
  PerceptionEventSchema,
  PerceptionFactSchema,
  PerceptionParticipantSchema,
  PerceptionQuoteSchema,
  PerceptionResultSchema,
} from '../../../shared/core/agent/perceive.ts';
export type {
  PerceptionResult,
  ScreenshotImageInput,
} from '../../../shared/core/agent/perceive.ts';

export type PerceiveScreenshotOptions = {
  imagePath: string;
  imageMimeType?: string;
  note?: string;
  provider?: StructuredOutputProvider;
  now?: Date;
};

export async function perceiveScreenshot({
  imagePath,
  imageMimeType,
  note,
  provider = createQwenProvider(),
  now = new Date(),
}: PerceiveScreenshotOptions): Promise<PerceptionResult> {
  const image = await readScreenshotImage(imagePath, imageMimeType);

  return perceiveScreenshotCore({ image, note, provider, now });
}
