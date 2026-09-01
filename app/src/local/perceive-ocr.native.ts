import TextRecognition, {
  TextRecognitionScript,
  type TextLine,
} from "@react-native-ml-kit/text-recognition";

import {
  perceiveScreenshotWithOcr,
  type OcrRecognitionResult,
  type OcrRecognizer,
  type RegionSampler,
} from "./perceive-ocr";

type PatchedTextLine = TextLine & { confidence?: number | null };

function tagOcrCallError(error: unknown, label: string): Error {
  const taggedError = error instanceof Error ? error : new Error(String(error));
  const originalStack = taggedError.stack;

  taggedError.message = `${label} ${taggedError.message}`;

  if (originalStack) {
    taggedError.stack = originalStack;
  }

  return taggedError;
}

const recognizeWithMlKit: OcrRecognizer = async (uri) => {
  try {
    const recognized = await TextRecognition.recognize(uri, TextRecognitionScript.CHINESE);

    return {
      blocks: recognized.blocks.map((block) => ({
        frame: block.frame,
        lines: block.lines.map((line) => ({
          text: line.text,
          frame: line.frame,
          confidence: (line as PatchedTextLine).confidence ?? null,
        })),
      })),
    } satisfies OcrRecognitionResult;
  } catch (error) {
    throw tagOcrCallError(error, "[mlkit-recognize]");
  }
};

const sampleWithNativeModule: RegionSampler = async (requests) => {
  try {
    // The copied sampler is Android-only. Keeping the require inside the call
    // prevents module loading on paths that stay with Qwen-VL.
    const native = require(
      "../../modules/tenglu-region-sampler/src/TengluRegionSamplerModule"
    ) as { sampleRegions: RegionSampler };
    return await native.sampleRegions(requests);
  } catch (error) {
    throw tagOcrCallError(error, "[region-sampler]");
  }
};

export async function perceiveScreenshotWithNativeOcr(uri: string) {
  return perceiveScreenshotWithOcr({
    uri,
    recognize: recognizeWithMlKit,
    sampleRegions: sampleWithNativeModule,
  });
}
