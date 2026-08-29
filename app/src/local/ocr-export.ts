import { z } from "zod";

import type { OcrPerceptionResult } from "./perceive-ocr";

export const OCR_EXPORT_FORMAT_VERSION = 1;

const OcrExportLineSchema = z.object({
  text: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
  conf: z.number().finite().nullable(),
  side: z.enum(["me", "them"]).nullable(),
}).strict();

export const OcrExportBundleSchema = z.object({
  formatVersion: z.literal(OCR_EXPORT_FORMAT_VERSION),
  kind: z.literal("mailuo-ocr-perception"),
  exportedAt: z.string().datetime({ offset: true }),
  source: z.object({
    name: z.string().min(1).nullable(),
    mimeType: z.string().min(1).nullable(),
    width: z.number().finite().positive().nullable(),
    height: z.number().finite().positive().nullable(),
    md5: z.string().regex(/^[a-f\d]{32}$/iu),
  }).strict(),
  engine: z.object({
    name: z.literal("@react-native-ml-kit/text-recognition"),
    version: z.literal("2.0.0"),
    script: z.literal("Chinese"),
  }).strict(),
  lines: z.array(OcrExportLineSchema),
  warnings: z.array(z.string().min(1)),
  degraded: z.boolean(),
}).strict().superRefine((bundle, context) => {
  if (bundle.degraded !== (bundle.warnings.length > 0)) {
    context.addIssue({
      code: "custom",
      message: "degraded 必须与 warnings 是否为空一致",
      path: ["degraded"],
    });
  }
});

export type OcrExportBundle = z.infer<typeof OcrExportBundleSchema>;

export type OcrExportSource = {
  name?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  md5: string;
};

export interface JsonExportFile {
  uri: string;
  write(content: string): Promise<void> | void;
  text(): Promise<string>;
}

export interface JsonExportDirectory {
  createFile(name: string, mimeType: string | null): JsonExportFile;
}

export function buildOcrExportBundle(input: {
  result: OcrPerceptionResult;
  source: OcrExportSource;
  exportedAt?: Date;
}): OcrExportBundle {
  const source = input.source;
  const warnings = [...input.result.warnings];

  if (input.result.lines.length === 0 && !warnings.includes("未识别到文本行")) {
    warnings.push("未识别到文本行");
  }

  return OcrExportBundleSchema.parse({
    formatVersion: OCR_EXPORT_FORMAT_VERSION,
    kind: "mailuo-ocr-perception",
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    source: {
      name: source.name?.trim() || null,
      mimeType: source.mimeType?.trim() || null,
      width: typeof source.width === "number" && Number.isFinite(source.width) && source.width > 0
        ? source.width
        : null,
      height: typeof source.height === "number" && Number.isFinite(source.height) && source.height > 0
        ? source.height
        : null,
      md5: source.md5.trim().toLowerCase(),
    },
    engine: {
      name: "@react-native-ml-kit/text-recognition",
      version: "2.0.0",
      script: "Chinese",
    },
    lines: input.result.lines.map((line) => ({
      text: line.text,
      x: line.x,
      y: line.y,
      w: line.width,
      h: line.height,
      conf: line.confidence,
      side: line.side,
    })),
    warnings,
    degraded: warnings.length > 0,
  });
}

export function serializeOcrExportBundle(bundle: OcrExportBundle): string {
  return JSON.stringify(OcrExportBundleSchema.parse(bundle), null, 2) + "\n";
}

export function createOcrExportFileName(exportedAt: Date): string {
  const stamp = exportedAt.toISOString().replace(/[-:]/gu, "").replace(/\./gu, "-");
  return `mailuo-ocr-${stamp}.json`;
}

export async function writeOcrExportToDirectory(
  directory: JsonExportDirectory,
  bundle: OcrExportBundle,
): Promise<{ fileName: string; fileUri: string }> {
  const validated = OcrExportBundleSchema.parse(bundle);
  const content = serializeOcrExportBundle(validated);
  const fileName = createOcrExportFileName(new Date(validated.exportedAt));
  const file = directory.createFile(fileName, "application/json");

  await file.write(content);
  const written = await file.text();
  OcrExportBundleSchema.parse(JSON.parse(written));

  if (written !== content) {
    throw new Error("OCR JSON 写入后校验失败。");
  }

  return { fileName, fileUri: file.uri };
}
