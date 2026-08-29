export const OCR_ALIGNMENT_TOLERANCE = 30;
export const OCR_MESSAGE_MERGE_DY = 62;
export const OCR_MESSAGE_MERGE_DX = 60;
// ML Kit confidence is 0..1. A line below 0.5 is clearly uncertain, but visual
// fallback is expensive, so require more than 60% of all recognized lines to be
// below that mark. Missing confidence is unknown rather than low confidence.
export const OCR_LOW_CONFIDENCE_LINE_THRESHOLD = 0.5;
export const OCR_LOW_CONFIDENCE_RATIO_THRESHOLD = 0.6;

const WECHAT_TIME = /^(昨天\s*)?\d{1,2}[:：]\d{2}$/;

export type OcrSide = "me" | "them" | null;

export type OcrFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type OcrRecognizerLine = {
  text: string;
  frame?: OcrFrame | null;
  confidence?: number | null;
};

export type OcrRecognizerBlock = {
  frame?: OcrFrame | null;
  lines?: readonly OcrRecognizerLine[] | null;
};

export type OcrRecognitionResult = {
  blocks?: readonly OcrRecognizerBlock[] | null;
};

export type OcrRecognizer = (uri: string) => Promise<OcrRecognitionResult>;

export type RegionSampleRequest = {
  id: string;
  frameIndex: number;
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RegionSample = {
  id: string;
  side: OcrSide;
  error?: string;
};

export type RegionSampleBatch = {
  samples: readonly RegionSample[];
};

export type RegionSampler = (
  requests: RegionSampleRequest[],
) => Promise<RegionSampleBatch>;

export type PerceivedOcrLine = {
  text: string;
  side: OcrSide;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number | null;
};

export type OcrPerceptionResult = {
  lines: PerceivedOcrLine[];
  warnings: string[];
  degraded: boolean;
  hasUnresolvedMessageSpeakers?: boolean;
};

export type OcrTextQualityPolicy = {
  lowConfidenceLineThreshold: number;
  lowConfidenceRatioThreshold: number;
};

export type AlignmentPeaks = {
  left: number | null;
  right: number | null;
};

export type PerceiveScreenshotWithOcrOptions = {
  uri: string;
  recognize: OcrRecognizer;
  sampleRegions: RegionSampler;
};

export function isOcrTextQualityPoor(
  result: Pick<OcrPerceptionResult, "lines">,
  policy: OcrTextQualityPolicy = {
    lowConfidenceLineThreshold: OCR_LOW_CONFIDENCE_LINE_THRESHOLD,
    lowConfidenceRatioThreshold: OCR_LOW_CONFIDENCE_RATIO_THRESHOLD,
  },
): boolean {
  if (result.lines.length === 0) {
    return false;
  }

  const lowConfidenceLines = result.lines.filter(
    (line) =>
      typeof line.confidence === "number" &&
      Number.isFinite(line.confidence) &&
      line.confidence < policy.lowConfidenceLineThreshold,
  ).length;

  return lowConfidenceLines / result.lines.length > policy.lowConfidenceRatioThreshold;
}

function isValidFrame(frame: OcrFrame | null | undefined): frame is OcrFrame {
  return Boolean(
    frame &&
      [frame.left, frame.top, frame.width, frame.height].every(Number.isFinite) &&
      frame.width > 0 &&
      frame.height > 0,
  );
}

function collectRecognizedLinesWithWarnings(result: OcrRecognitionResult): {
  lines: PerceivedOcrLine[];
  warnings: string[];
  hasMissingGeometry: boolean;
} {
  const lines: PerceivedOcrLine[] = [];
  const warnings: string[] = [];
  let recognizedLineNumber = 0;
  let hasMissingGeometry = false;

  for (const block of result.blocks ?? []) {
    for (const line of block.lines ?? []) {
      if (typeof line.text !== "string" || !line.text.trim()) {
        continue;
      }
      recognizedLineNumber += 1;

      const frame = isValidFrame(line.frame)
        ? line.frame
        : isValidFrame(block.frame)
          ? block.frame
          : null;

      if (!frame) {
        hasMissingGeometry = true;
        warnings.push(`第 ${recognizedLineNumber} 个 OCR 文本行缺少有效坐标，已保留文字但无法判断发言人`);
        lines.push({
          text: line.text,
          side: null,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          confidence: Number.isFinite(line.confidence) ? (line.confidence ?? null) : null,
        });
        continue;
      }

      lines.push({
        text: line.text,
        side: null,
        x: frame.left,
        y: frame.top,
        width: frame.width,
        height: frame.height,
        confidence: Number.isFinite(line.confidence) ? (line.confidence ?? null) : null,
      });
    }
  }

  return { lines, warnings, hasMissingGeometry };
}

/** Convert ML Kit's block/line result without normalizing recognized text or geometry. */
export function collectRecognizedLines(result: OcrRecognitionResult): PerceivedOcrLine[] {
  return collectRecognizedLinesWithWarnings(result).lines;
}

function findPeak(counts: Map<number, number>): number | null {
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function hasUsableGeometry(line: PerceivedOcrLine): boolean {
  return (
    [line.x, line.y, line.width, line.height].every(Number.isFinite) &&
    line.width > 0 &&
    line.height > 0
  );
}

/** Tenglu's verified peak rule: left uses x, right uses x + width. */
export function findAlignmentPeaks(lines: readonly PerceivedOcrLine[]): AlignmentPeaks {
  const contentWidth = Math.max(...lines.map((line) => line.x + line.width), 1);
  const midpoint = contentWidth / 2;
  const leftCounts = new Map<number, number>();
  const rightCounts = new Map<number, number>();

  for (const line of lines) {
    if (!hasUsableGeometry(line) || Array.from(line.text.trim()).length < 2) {
      continue;
    }

    if (line.x < midpoint) {
      leftCounts.set(line.x, (leftCounts.get(line.x) ?? 0) + 1);
    }

    const right = line.x + line.width;
    if (right > midpoint) {
      rightCounts.set(right, (rightCounts.get(right) ?? 0) + 1);
    }
  }

  return {
    left: findPeak(leftCounts),
    right: findPeak(rightCounts),
  };
}

function isLeftAligned(line: PerceivedOcrLine, peaks: AlignmentPeaks): boolean {
  return (
    peaks.left !== null &&
    Math.abs(line.x - peaks.left) <= OCR_ALIGNMENT_TOLERANCE
  );
}

function isRightAligned(line: PerceivedOcrLine, peaks: AlignmentPeaks): boolean {
  return (
    peaks.right !== null &&
    Math.abs(line.x + line.width - peaks.right) <= OCR_ALIGNMENT_TOLERANCE
  );
}

function makeSampleRequest(
  line: PerceivedOcrLine,
  id: string,
  uri: string,
): RegionSampleRequest {
  const x = Math.max(0, Math.floor(line.x));
  const y = Math.max(0, Math.floor(line.y));
  const right = Math.ceil(line.x + line.width);
  const bottom = Math.ceil(line.y + line.height);

  return {
    id,
    frameIndex: 0,
    uri,
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

type OcrMessageGroup = {
  lineIndexes: number[];
  lastY: number;
  lastX: number;
};

function groupAlignedLines(
  lines: readonly PerceivedOcrLine[],
  peaks: AlignmentPeaks,
): OcrMessageGroup[] {
  const groups: OcrMessageGroup[] = [];
  const sortedLineIndexes = lines
    .map((_, lineIndex) => lineIndex)
    .filter((lineIndex) => {
      const line = lines[lineIndex];
      return (
        hasUsableGeometry(line) &&
        !WECHAT_TIME.test(line.text.trim()) &&
        (isLeftAligned(line, peaks) || isRightAligned(line, peaks))
      );
    })
    .sort((leftIndex, rightIndex) => {
      const left = lines[leftIndex];
      const right = lines[rightIndex];
      return left.y - right.y || left.x - right.x;
    });

  for (const lineIndex of sortedLineIndexes) {
    const line = lines[lineIndex];
    let current: OcrMessageGroup | null = null;
    let bestDy = Number.POSITIVE_INFINITY;
    let bestDx = Number.POSITIVE_INFINITY;

    for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
      const group = groups[groupIndex];
      const dy = line.y - group.lastY;
      const dx = Math.abs(line.x - group.lastX);
      if (
        dy >= 0 &&
        dy < OCR_MESSAGE_MERGE_DY &&
        dx < OCR_MESSAGE_MERGE_DX &&
        (dy < bestDy || (dy === bestDy && dx < bestDx))
      ) {
        current = group;
        bestDy = dy;
        bestDx = dx;
      }
    }

    if (current) {
      current.lineIndexes.push(lineIndex);
      current.lineIndexes.sort((leftIndex, rightIndex) => {
        const left = lines[leftIndex];
        const right = lines[rightIndex];
        return left.y - right.y || left.x - right.x;
      });
      current.lastY = Math.max(
        ...current.lineIndexes.map((index) => lines[index].y),
      );
      current.lastX = line.x;
    } else {
      groups.push({
        lineIndexes: [lineIndex],
        lastY: line.y,
        lastX: line.x,
      });
    }
  }

  return groups;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Recognize one screenshot and group adjacent rows into message bubbles before assigning
 * one speaker to every row in that bubble. Bubbles that hit both alignment peaks are
 * resolved exclusively by local pixel sampling.
 */
export async function perceiveScreenshotWithOcr({
  uri,
  recognize,
  sampleRegions,
}: PerceiveScreenshotWithOcrOptions): Promise<OcrPerceptionResult> {
  const collected = collectRecognizedLinesWithWarnings(await recognize(uri));
  const lines = collected.lines;
  const warnings = [...collected.warnings];

  if (lines.length === 0) {
    return {
      lines: [],
      warnings,
      degraded: warnings.length > 0,
      hasUnresolvedMessageSpeakers: collected.hasMissingGeometry,
    };
  }

  const peaks = findAlignmentPeaks(lines);
  const groups = groupAlignedLines(lines, peaks);
  const ambiguousGroups: Array<{
    groupIndex: number;
    lineIndexes: number[];
    sampleLineIndex: number;
  }> = [];

  for (const [groupIndex, group] of groups.entries()) {
    const hasLeft = group.lineIndexes.some((lineIndex) =>
      isLeftAligned(lines[lineIndex], peaks),
    );
    const hasRight = group.lineIndexes.some((lineIndex) =>
      isRightAligned(lines[lineIndex], peaks),
    );

    if (hasRight && !hasLeft) {
      for (const lineIndex of group.lineIndexes) {
        lines[lineIndex].side = "me";
      }
    } else if (hasLeft && !hasRight) {
      for (const lineIndex of group.lineIndexes) {
        lines[lineIndex].side = "them";
      }
    } else if (hasLeft && hasRight) {
      const sampleLineIndex = [...group.lineIndexes].sort((leftIndex, rightIndex) => {
        const left = lines[leftIndex];
        const right = lines[rightIndex];
        return right.width * right.height - left.width * left.height;
      })[0];
      ambiguousGroups.push({
        groupIndex,
        lineIndexes: group.lineIndexes,
        sampleLineIndex,
      });
    }
  }

  if (ambiguousGroups.length === 0) {
    return {
      lines,
      warnings,
      degraded: warnings.length > 0,
      hasUnresolvedMessageSpeakers: collected.hasMissingGeometry,
    };
  }

  const requests = ambiguousGroups.map(({ groupIndex, sampleLineIndex }) =>
    makeSampleRequest(lines[sampleLineIndex], `bubble-${groupIndex}`, uri),
  );
  let samples: readonly RegionSample[] = [];

  try {
    const batch = await sampleRegions(requests);
    samples = Array.isArray(batch.samples) ? batch.samples : [];
  } catch (error) {
    const detail = errorMessage(error);
    for (const { groupIndex } of ambiguousGroups) {
      warnings.push(`气泡 ${groupIndex + 1} 底色采样失败：${detail}`);
    }
    return {
      lines,
      warnings,
      degraded: true,
      hasUnresolvedMessageSpeakers: true,
    };
  }

  const samplesById = new Map(samples.map((sample) => [sample.id, sample]));

  for (const [requestIndex, group] of ambiguousGroups.entries()) {
    const request = requests[requestIndex];
    const sample = samplesById.get(request.id);

    if (sample?.side === "me" || sample?.side === "them") {
      for (const lineIndex of group.lineIndexes) {
        lines[lineIndex].side = sample.side;
      }
      continue;
    }

    if (sample?.error) {
      warnings.push(`气泡 ${group.groupIndex + 1} 底色采样失败：${sample.error}`);
    } else if (sample) {
      warnings.push(`气泡 ${group.groupIndex + 1} 底色未判定`);
    } else {
      warnings.push(`气泡 ${group.groupIndex + 1} 没有返回底色采样结果`);
    }
  }

  return {
    lines,
    warnings,
    degraded: warnings.length > 0,
    hasUnresolvedMessageSpeakers:
      collected.hasMissingGeometry ||
      ambiguousGroups.some((group) =>
        group.lineIndexes.some((lineIndex) => lines[lineIndex].side === null),
      ),
  };
}
