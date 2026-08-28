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

const recognizeWithMlKit: OcrRecognizer = async (uri) => {
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
};

const sampleWithNativeModule: RegionSampler = async (requests) => {
  // The copied sampler is Android-only. Keeping the require inside the call
  // prevents module loading on paths that stay with Qwen-VL.
  const native = require(
    "../../modules/tenglu-region-sampler/src/TengluRegionSamplerModule"
  ) as { sampleRegions: RegionSampler };
  return native.sampleRegions(requests);
};

export async function perceiveScreenshotWithNativeOcr(uri: string) {
  return perceiveScreenshotWithOcr({
    uri,
    recognize: recognizeWithMlKit,
    sampleRegions: sampleWithNativeModule,
  });
}
