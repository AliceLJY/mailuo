import { z } from "zod";

export const MAX_DIAGNOSTICS_TRACES = 50;

const safeInteger = z.number().int().refine(Number.isSafeInteger);

const TraceResolutionSchema = z.object({
  participant_name: z.string(),
  status: z.enum(["same_as", "new", "unsure"]),
  source: z.enum(["exact", "llm", "empty_db", "exact_multiple", "near_match"]).optional(),
  contact_id: safeInteger.optional(),
  candidate_ids: z.array(safeInteger).optional(),
}).strict();

const TraceProposedCardSchema = z.object({
  type: z.enum([
    "create_contact",
    "update_contact",
    "create_meeting",
    "record_interaction",
  ]),
  payload: z.unknown(),
  disambiguation: z.unknown().nullable(),
}).strict().superRefine((value, context) => {
  for (const field of ["payload", "disambiguation"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      context.addIssue({
        code: "custom",
        message: `${field} is required`,
        path: [field],
      });
    }
  }
});

const TraceMeetingDedupSchema = z.object({
  title: z.string(),
  duplicate_of_meeting_id: safeInteger.optional(),
  similarity: z.number().finite().min(0).max(1).optional(),
}).strict();

export const DiagnosticsTraceSchema = z.object({
  screenshot_id: safeInteger.positive(),
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }),
  perception_path: z.enum(["ocr", "cloud", "ocr->cloud"]),
  ocr_text: z.string().optional(),
  extraction: z.unknown().nullable(),
  resolutions: z.array(TraceResolutionSchema),
  proposed_cards: z.array(TraceProposedCardSchema),
  meeting_dedup: z.array(TraceMeetingDedupSchema),
  notices: z.array(z.string()),
  error: z.object({
    name: z.string(),
    message: z.string(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, "extraction")) {
    context.addIssue({
      code: "custom",
      message: "extraction is required",
      path: ["extraction"],
    });
  }
});

export type DiagnosticsTrace = z.infer<typeof DiagnosticsTraceSchema>;
export type DiagnosticsTraceWriter = (
  trace: DiagnosticsTrace,
) => Promise<void> | void;

export interface DiagnosticsTraceFile {
  readonly name: string;
  readonly modificationTime?: number | null;
  write(content: string): Promise<void> | void;
  text(): Promise<string>;
  delete(): Promise<void> | void;
}

export interface DiagnosticsTraceDirectory {
  listFiles(): readonly DiagnosticsTraceFile[];
  createFile(name: string, mimeType: string | null): DiagnosticsTraceFile;
}

let configuredWriter: DiagnosticsTraceWriter | null = null;

export function configureDiagnosticsTraceWriter(
  writer: DiagnosticsTraceWriter | null,
): () => void {
  configuredWriter = writer;

  return () => {
    if (configuredWriter === writer) {
      configuredWriter = null;
    }
  };
}

export async function writeConfiguredDiagnosticsTrace(
  trace: DiagnosticsTrace,
): Promise<void> {
  await configuredWriter?.(trace);
}

export async function writeDiagnosticsTrace(
  directory: DiagnosticsTraceDirectory,
  trace: DiagnosticsTrace,
): Promise<void> {
  const validated = DiagnosticsTraceSchema.parse(trace);
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  const fileName = `${validated.screenshot_id}.json`;
  const existingFile = directory.listFiles().find((candidate) => candidate.name === fileName);

  if (existingFile) {
    await archiveChangedTrace(directory, existingFile, content);
  }

  const file = existingFile ?? directory.createFile(fileName, "application/json");

  await file.write(content);
  const written = await file.text();
  DiagnosticsTraceSchema.parse(JSON.parse(written));

  if (written !== content) {
    throw new Error("诊断过程记录写入后校验失败。");
  }

  await pruneDiagnosticsTraces(directory);
}

export async function readDiagnosticsTraces(
  directory: DiagnosticsTraceDirectory,
): Promise<DiagnosticsTrace[]> {
  const traces: DiagnosticsTrace[] = [];

  for (const file of directory.listFiles()) {
    if (!file.name.endsWith(".json")) {
      continue;
    }

    try {
      traces.push(DiagnosticsTraceSchema.parse(JSON.parse(await file.text())));
    } catch {
      // A damaged trace must not make an otherwise useful diagnostics export fail.
    }
  }

  return traces.sort((left, right) =>
    left.screenshot_id - right.screenshot_id ||
    Date.parse(left.finished_at) - Date.parse(right.finished_at) ||
    Date.parse(left.started_at) - Date.parse(right.started_at),
  );
}

async function archiveChangedTrace(
  directory: DiagnosticsTraceDirectory,
  currentFile: DiagnosticsTraceFile,
  nextContent: string,
): Promise<void> {
  const currentContent = await currentFile.text();
  if (currentContent === nextContent) {
    return;
  }

  let currentTrace: DiagnosticsTrace;
  try {
    currentTrace = DiagnosticsTraceSchema.parse(JSON.parse(currentContent));
  } catch {
    // Replace a damaged primary trace; it cannot be exported as a usable record.
    return;
  }

  const names = new Set(directory.listFiles().map((file) => file.name));
  const stamp = currentTrace.started_at.replace(/\D/gu, "");
  const baseName = `${currentTrace.screenshot_id}-${stamp}`;
  let archiveName = `${baseName}.json`;
  let suffix = 2;

  while (names.has(archiveName)) {
    archiveName = `${baseName}-${suffix}.json`;
    suffix += 1;
  }

  const archive = directory.createFile(archiveName, "application/json");
  await archive.write(currentContent);
  const archivedContent = await archive.text();
  DiagnosticsTraceSchema.parse(JSON.parse(archivedContent));
  if (archivedContent !== currentContent) {
    throw new Error("旧诊断过程记录归档后校验失败。");
  }
}

async function pruneDiagnosticsTraces(
  directory: DiagnosticsTraceDirectory,
): Promise<void> {
  const ranked = await Promise.all(
    directory
      .listFiles()
      .filter((file) => file.name.endsWith(".json"))
      .map(async (file) => ({
        file,
        finishedAt: await readFinishedAt(file),
      })),
  );

  ranked.sort((left, right) =>
    right.finishedAt - left.finishedAt || right.file.name.localeCompare(left.file.name),
  );

  for (const { file } of ranked.slice(MAX_DIAGNOSTICS_TRACES)) {
    await file.delete();
  }
}

async function readFinishedAt(file: DiagnosticsTraceFile): Promise<number> {
  try {
    const parsed = JSON.parse(await file.text()) as { finished_at?: unknown };
    if (typeof parsed.finished_at === "string") {
      const timestamp = Date.parse(parsed.finished_at);
      if (Number.isFinite(timestamp)) {
        return timestamp;
      }
    }
  } catch {
    // Fall through to file metadata for older or damaged records.
  }

  return typeof file.modificationTime === "number" && Number.isFinite(file.modificationTime)
    ? file.modificationTime
    : Number.NEGATIVE_INFINITY;
}
