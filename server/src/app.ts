import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { Multipart, MultipartFile } from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type {
  ActionCard,
  ApiFailure,
  ApiSuccess,
  HealthResponse,
  ScreenshotUploadResponse,
} from "../../shared/types.ts";
import {
  ConfirmCardBodySchema,
  type ConfirmCardBody,
} from "../../shared/core/schemas.ts";
import {
  createPastedTextOcrResult,
  createPastedTextSourceUri,
  perceiveOcrText,
} from "../../shared/core/agent/perceive-text.ts";
import type { StructuredOutputProvider } from "../../shared/core/llm/provider.ts";
import {
  executeCard as defaultExecuteCard,
  ExecuteError,
  rejectCard as defaultRejectCard,
} from "./agent/execute.ts";
import {
  generateInsights as defaultGenerateInsights,
  type InsightGenerationResult,
} from "./agent/insight.ts";
import {
  perceiveScreenshot as defaultPerceiveScreenshot,
  type PerceptionResult,
} from "./agent/perceive.ts";
import { proposeCards as defaultProposeCards } from "../../shared/core/agent/propose.ts";
import {
  resolveParticipants as defaultResolveParticipants,
  type ParticipantResolution,
  type ResolvableContact,
} from "./agent/resolve.ts";
import { MailuoDb } from "./db.ts";
import {
  ConfigurationError,
  ProviderRequestError,
  StructuredOutputError,
} from "./llm/provider.ts";
import {
  inferExtensionFromMimeType,
  normalizeImageMimeType,
  UnsupportedImageTypeError,
} from "./llm/qwen.ts";
import { createTextProvider as defaultCreateTextProvider } from "./llm/text.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultScreenshotDir = resolve(currentDir, "..", "data", "screenshots");
const defaultWebRoot = resolve(currentDir, "..", "public");

type PerceiveScreenshotInput = {
  imagePath: string;
  imageMimeType?: string;
  note?: string;
};

type PerceiveScreenshotFn = (
  input: PerceiveScreenshotInput,
) => Promise<PerceptionResult>;
type ProposeCardsFn = (
  extraction: PerceptionResult,
  resolutions?: ParticipantResolution[],
  contacts?: ResolvableContact[],
) => ActionCard[] | Promise<ActionCard[]>;
type ResolveParticipantsFn = typeof defaultResolveParticipants;
type ExecuteCardFn = typeof defaultExecuteCard;
type RejectCardFn = typeof defaultRejectCard;
type GenerateInsightsFn = typeof defaultGenerateInsights;
type CreateTextProviderFn = () => StructuredOutputProvider;

type ConfirmCardResponse = {
  executed: true;
  card: ReturnType<MailuoDb["getStoredActionCardById"]> extends infer T
    ? Exclude<T, null>
    : never;
  affected_contact_ids: number[];
  observation_ids: number[];
  meeting_id?: number;
  insight_status: "ok" | "failed";
  insight_error?: string;
  insights: InsightGenerationResult["generated"];
};

type RejectCardResponse = {
  card: ReturnType<MailuoDb["getStoredActionCardById"]> extends infer T
    ? Exclude<T, null>
    : never;
};

class HttpError extends Error {
  statusCode: number;
  code?: string;
  details?: unknown;

  constructor(statusCode: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function buildOperationalHttpError(error: Error): HttpError | null {
  if (error instanceof ExecuteError) {
    return new HttpError(error.statusCode, error.message, error.code, error.details);
  }

  if (error instanceof ConfigurationError) {
    return new HttpError(500, error.message, error.code);
  }

  if (error instanceof ProviderRequestError) {
    return new HttpError(502, error.message, error.code);
  }

  if (error instanceof StructuredOutputError) {
    return new HttpError(502, error.message, "LLM_SCHEMA_ERROR");
  }

  if (error instanceof UnsupportedImageTypeError) {
    return new HttpError(400, error.message, error.code);
  }

  if (error.message.startsWith("Missing required environment variable ")) {
    return new HttpError(500, error.message, "CONFIG_ERROR");
  }

  return null;
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof Error) {
    return buildOperationalHttpError(error) ?? new HttpError(500, "Unexpected server error", "INTERNAL_ERROR");
  }

  return new HttpError(500, "Unexpected server error", "INTERNAL_ERROR");
}

function getScreenshotDirectory() {
  return process.env.SCREENSHOT_DIR?.trim() || defaultScreenshotDir;
}

function resolveWebRoot(webRoot: string | false | undefined): string | null {
  if (webRoot === false) {
    return null;
  }

  if (typeof webRoot === "string" && webRoot.trim() === "") {
    return null;
  }

  const resolvedRoot = resolve(webRoot ?? defaultWebRoot);

  if (!existsSync(resolvedRoot)) {
    return null;
  }

  try {
    return statSync(resolvedRoot).isDirectory() ? resolvedRoot : null;
  } catch {
    return null;
  }
}

function isApiPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api" || pathname.startsWith("/api/");
}

function shouldServeSpaIndex(request: FastifyRequest): boolean {
  if (request.method !== "GET") {
    return false;
  }

  const url = request.raw.url ?? request.url;

  if (isApiPath(url)) {
    return false;
  }

  const acceptHeader = request.headers.accept?.toLowerCase() ?? "";

  if (!acceptHeader.includes("text/html")) {
    return false;
  }

  const pathname = url.split("?", 1)[0] ?? url;
  return extname(pathname) === "";
}

function getPublicErrorMessage(error: unknown, fallbackMessage: string): string {
  const httpError = toHttpError(error);
  return httpError.message === "Unexpected server error" ? fallbackMessage : httpError.message;
}

function parsePositiveId(rawValue: string | undefined, entityName: string): number {
  const parsed = Number(rawValue);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `Invalid ${entityName} id`, "INVALID_ID");
  }

  return parsed;
}

function parseConfirmCardBody(body: unknown): ConfirmCardBody {
  const parsed = ConfirmCardBodySchema.safeParse(body ?? {});

  if (!parsed.success) {
    throw new HttpError(422, "Invalid request body", "INVALID_REQUEST_BODY", parsed.error.issues);
  }

  return parsed.data;
}

type TextUploadBody = {
  text: string;
  note?: string;
};

function parseTextUploadBody(body: unknown): TextUploadBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(422, "Invalid request body", "INVALID_REQUEST_BODY");
  }

  const candidate = body as Record<string, unknown>;
  if (typeof candidate.text !== "string" || !candidate.text.trim()) {
    throw new HttpError(422, "Text is required", "INVALID_TEXT");
  }

  if (candidate.note !== undefined && typeof candidate.note !== "string") {
    throw new HttpError(422, "Invalid request body", "INVALID_REQUEST_BODY");
  }

  const note = candidate.note?.trim();
  return {
    text: candidate.text.trim(),
    ...(note ? { note } : {}),
  };
}

function listResolvableContacts(db: MailuoDb): ResolvableContact[] {
  return db.listContacts().map(
    ({ observation_count: _observationCount, last_interaction_at: _lastInteractionAt, ...contact }) =>
      contact,
  );
}

async function sendError(reply: FastifyReply, error: unknown) {
  const httpError = toHttpError(error);

  const errorBody: ApiFailure["error"] = {
    message: httpError.message,
  };

  if (httpError.code) {
    errorBody.code = httpError.code;
  }

  if (httpError.details !== undefined) {
    errorBody.details = httpError.details;
  }

  const payload: ApiFailure = {
    ok: false,
    error: errorBody,
  };

  return reply.status(httpError.statusCode).send(payload);
}

async function drainFilePart(part: MultipartFile) {
  for await (const _chunk of part.file) {
    // Consume the stream so Fastify can finish parsing the request cleanly.
  }
}

async function removeStoredFile(filePath: string | undefined) {
  if (!filePath) {
    return;
  }

  await rm(filePath, { force: true }).catch(() => undefined);
}

function getStoredImageExtension(part: MultipartFile): string {
  const mimeType = normalizeImageMimeType(part.mimetype);

  if (!mimeType) {
    throw new HttpError(
      400,
      `Field "image" has unsupported MIME type "${part.mimetype}"`,
      "UNSUPPORTED_IMAGE_TYPE",
    );
  }

  return inferExtensionFromMimeType(mimeType);
}

async function rejectUnexpectedMultipartPart(part: Multipart) {
  if (part.type === "file") {
    await drainFilePart(part);
    throw new HttpError(
      400,
      `Unexpected file field "${part.fieldname}"`,
      "UNEXPECTED_FILE_FIELD",
    );
  }

  throw new HttpError(
    400,
    `Unexpected multipart field "${part.fieldname}"`,
    "UNEXPECTED_FIELD",
  );
}

async function readMultipartPayload(request: FastifyRequest) {
  let note: string | undefined;
  let storedImagePath: string | undefined;
  let storedImageMimeType: string | undefined;
  let sawNote = false;

  try {
    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (part.fieldname !== "note") {
          await rejectUnexpectedMultipartPart(part);
        }

        if (sawNote) {
          throw new HttpError(
            400,
            'Field "note" may appear only once',
            "DUPLICATE_NOTE",
          );
        }

        sawNote = true;
        note = typeof part.value === "string" ? part.value : String(part.value);
        continue;
      }

      if (part.fieldname !== "image") {
        await rejectUnexpectedMultipartPart(part);
      }

      if (!part.mimetype.startsWith("image/")) {
        await drainFilePart(part);
        throw new HttpError(
          400,
          'Field "image" must be an image upload',
          "INVALID_IMAGE",
        );
      }

      if (storedImagePath) {
        await drainFilePart(part);
        throw new HttpError(
          400,
          "Only one image upload is supported",
          "TOO_MANY_IMAGES",
        );
      }

      const screenshotDir = getScreenshotDirectory();
      mkdirSync(screenshotDir, { recursive: true });
      const extension = getStoredImageExtension(part);
      const filePath = resolve(screenshotDir, `${Date.now()}-${randomUUID()}${extension}`);
      await pipeline(part.file, createWriteStream(filePath));
      storedImagePath = filePath;
      storedImageMimeType = normalizeImageMimeType(part.mimetype) ?? part.mimetype;
    }
  } catch (error) {
    await removeStoredFile(storedImagePath);
    throw error;
  }

  if (!storedImagePath || !storedImageMimeType) {
    throw new HttpError(
      400,
      'Multipart field "image" is required',
      "MISSING_IMAGE",
    );
  }

  return { imagePath: storedImagePath, imageMimeType: storedImageMimeType, note };
}

type BuildAppOptions = {
  db?: MailuoDb;
  createDb?: () => MailuoDb;
  webRoot?: string | false;
  perceiveScreenshot?: PerceiveScreenshotFn;
  resolveParticipants?: ResolveParticipantsFn;
  proposeCards?: ProposeCardsFn;
  executeCard?: ExecuteCardFn;
  rejectCard?: RejectCardFn;
  generateInsights?: GenerateInsightsFn;
  createTextProvider?: CreateTextProviderFn;
};

async function cleanupPartialScreenshotUpload(
  db: MailuoDb,
  screenshotId: number | undefined,
  imagePath: string | undefined,
  request: FastifyRequest,
) {
  if (screenshotId !== undefined) {
    try {
      db.deleteScreenshotUploadArtifacts(screenshotId);
    } catch (cleanupError) {
      request.log.error(
        { err: cleanupError, screenshotId },
        "Failed to remove partial screenshot records after upload error",
      );
    }
  }

  await removeStoredFile(imagePath);
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const ownsDb = options.db === undefined;
  const db = options.db ?? options.createDb?.() ?? new MailuoDb();
  const perceiveScreenshot = options.perceiveScreenshot ?? defaultPerceiveScreenshot;
  const resolveParticipants = options.resolveParticipants ?? defaultResolveParticipants;
  const proposeCards = options.proposeCards ?? defaultProposeCards;
  const executeCard = options.executeCard ?? defaultExecuteCard;
  const rejectCard = options.rejectCard ?? defaultRejectCard;
  const generateInsights = options.generateInsights ?? defaultGenerateInsights;
  const createTextProvider = options.createTextProvider ?? defaultCreateTextProvider;
  const webRoot = resolveWebRoot(options.webRoot);
  const canServeSpaIndex = webRoot ? existsSync(resolve(webRoot, "index.html")) : false;
  const app = Fastify({ logger: true });

  // web 版（react-native-web）页面在 Metro 端口、API 在本端口，跨端口需 CORS；
  // 单用户工具部署在 tailnet 内，origin 放开可接受
  app.register(cors, { origin: true });
  app.register(multipart);
  app.addHook("onClose", async () => {
    if (ownsDb) {
      db.close();
    }
  });

  app.get("/api/health", async (_request, reply) => {
    const payload: ApiSuccess<HealthResponse> = {
      ok: true,
      data: {
        status: "ok",
        now: new Date().toISOString(),
      },
    };

    return reply.send(payload);
  });

  app.post("/api/screenshots", async (request, reply) => {
    let imagePath: string | undefined;
    let screenshotId: number | undefined;

    try {
      const upload = await readMultipartPayload(request);
      imagePath = upload.imagePath;

      const { imageMimeType, note } = upload;
      const screenshot = db.createScreenshot({ imagePath, userNote: note ?? null });
      screenshotId = screenshot.id;
      const extraction = await perceiveScreenshot({ imagePath, imageMimeType, note });
      const contacts = listResolvableContacts(db);
      const resolutions = await resolveParticipants({ extraction, contacts });
      const cards = db.saveScreenshotAnalysis({
        screenshotId: screenshot.id,
        rawExtraction: extraction,
        cards: await Promise.resolve(proposeCards(extraction, resolutions, contacts)),
      });

      const payload: ApiSuccess<ScreenshotUploadResponse> = {
        ok: true,
        data: {
          screenshot_id: screenshot.id,
          cards,
        },
      };

      return reply.status(201).send(payload);
    } catch (error) {
      await cleanupPartialScreenshotUpload(db, screenshotId, imagePath, request);
      request.log.error({ err: error }, "Failed to process screenshot upload");
      return sendError(reply, error);
    }
  });

  app.post("/api/notes", async (request, reply) => {
    let screenshotId: number | undefined;

    try {
      const { text, note } = parseTextUploadBody(request.body);
      const screenshot = db.createScreenshot({
        imagePath: createPastedTextSourceUri(text),
        userNote: note ?? null,
      });
      screenshotId = screenshot.id;
      const extraction = await perceiveOcrText({
        ocr: createPastedTextOcrResult(text),
        note,
        provider: createTextProvider(),
      });
      const contacts = listResolvableContacts(db);
      const resolutions = await resolveParticipants({ extraction, contacts });
      const cards = db.saveScreenshotAnalysis({
        screenshotId: screenshot.id,
        rawExtraction: extraction,
        cards: await Promise.resolve(proposeCards(extraction, resolutions, contacts)),
      });

      const payload: ApiSuccess<ScreenshotUploadResponse> = {
        ok: true,
        data: {
          screenshot_id: screenshot.id,
          cards,
        },
      };

      return reply.status(201).send(payload);
    } catch (error) {
      await cleanupPartialScreenshotUpload(db, screenshotId, undefined, request);
      request.log.error({ err: error }, "Failed to process text upload");
      return sendError(reply, error);
    }
  });

  app.post("/api/cards/:id/confirm", async (request, reply) => {
    try {
      const cardId = parsePositiveId((request.params as { id?: string }).id, "card");
      const body = parseConfirmCardBody(request.body);
      const execution = executeCard({
        db,
        cardId,
        payload: body.payload,
        resolvedContactId: body.resolved_contact_id,
      });

      try {
        const insightResult = await generateInsights({
          db,
          contactIds: execution.affectedContactIds,
        });
        const payload: ApiSuccess<ConfirmCardResponse> = {
          ok: true,
          data: {
            executed: true,
            card: execution.confirmedCard,
            affected_contact_ids: execution.affectedContactIds,
            observation_ids: execution.observationIds,
            ...(execution.meetingId != null ? { meeting_id: execution.meetingId } : {}),
            insight_status: "ok",
            insights: insightResult.generated,
          },
        };

        return reply.send(payload);
      } catch (error) {
        request.log.error({ err: error, cardId }, "Failed to generate insights");
        const payload: ApiSuccess<ConfirmCardResponse> = {
          ok: true,
          data: {
            executed: true,
            card: execution.confirmedCard,
            affected_contact_ids: execution.affectedContactIds,
            observation_ids: execution.observationIds,
            ...(execution.meetingId != null ? { meeting_id: execution.meetingId } : {}),
            insight_status: "failed",
            insight_error: getPublicErrorMessage(error, "Unexpected insight generation error"),
            insights: [],
          },
        };

        return reply.send(payload);
      }
    } catch (error) {
      request.log.error({ err: error }, "Failed to confirm action card");
      return sendError(reply, error);
    }
  });

  app.post("/api/cards/:id/reject", async (request, reply) => {
    try {
      const cardId = parsePositiveId((request.params as { id?: string }).id, "card");
      const card = rejectCard({ db, cardId });
      const payload: ApiSuccess<RejectCardResponse> = {
        ok: true,
        data: { card },
      };

      return reply.send(payload);
    } catch (error) {
      request.log.error({ err: error }, "Failed to reject action card");
      return sendError(reply, error);
    }
  });

  app.get("/api/contacts", async (_request, reply) => {
    const payload = {
      ok: true,
      data: db.listContacts(),
    } satisfies ApiSuccess<ReturnType<MailuoDb["listContacts"]>>;

    return reply.send(payload);
  });

  app.get("/api/contacts/:id", async (request, reply) => {
    try {
      const contactId = parsePositiveId((request.params as { id?: string }).id, "contact");
      const detail = db.getContactDetail(contactId);

      if (!detail) {
        throw new HttpError(404, `Contact ${contactId} not found`, "NOT_FOUND");
      }

      const payload = {
        ok: true,
        data: detail,
      } satisfies ApiSuccess<NonNullable<ReturnType<MailuoDb["getContactDetail"]>>>;

      return reply.send(payload);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/meetings", async (_request, reply) => {
    const payload = {
      ok: true,
      data: db.listMeetings(),
    } satisfies ApiSuccess<ReturnType<MailuoDb["listMeetings"]>>;

    return reply.send(payload);
  });

  app.get("/api/screenshots/:id", async (request, reply) => {
    try {
      const screenshotId = parsePositiveId(
        (request.params as { id?: string }).id,
        "screenshot",
      );
      const detail = db.getScreenshotDetail(screenshotId);

      if (!detail) {
        throw new HttpError(404, `Screenshot ${screenshotId} not found`, "NOT_FOUND");
      }

      const payload = {
        ok: true,
        data: detail,
      } satisfies ApiSuccess<NonNullable<ReturnType<MailuoDb["getScreenshotDetail"]>>>;

      return reply.send(payload);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  if (webRoot) {
    app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      index: ["index.html"],
      redirect: false,
      allowedPath(_pathName, _root, request) {
        return !isApiPath(request.raw.url ?? request.url);
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (canServeSpaIndex && shouldServeSpaIndex(request)) {
      return reply.sendFile("index.html");
    }

    return reply.status(404).send({
      ok: false,
      error: {
        message: "Route not found",
        code: "NOT_FOUND",
      },
    } satisfies ApiFailure);
  });

  app.setErrorHandler(async (error, _request, reply) => sendError(reply, error));

  return app;
}
