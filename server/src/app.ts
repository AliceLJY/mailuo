import { createWriteStream, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import multipart from "@fastify/multipart";
import type { Multipart, MultipartFile } from "@fastify/multipart";
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
  perceiveScreenshot as defaultPerceiveScreenshot,
  type PerceptionResult,
} from "./agent/perceive.ts";
import { proposeCards as defaultProposeCards } from "./agent/propose.ts";
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

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultScreenshotDir = resolve(currentDir, "..", "data", "screenshots");

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
) => ActionCard[] | Promise<ActionCard[]>;

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
  perceiveScreenshot?: PerceiveScreenshotFn;
  proposeCards?: ProposeCardsFn;
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
  const proposeCards = options.proposeCards ?? defaultProposeCards;
  const app = Fastify({ logger: true });

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
      const cards = db.saveScreenshotAnalysis({
        screenshotId: screenshot.id,
        rawExtraction: extraction,
        cards: await Promise.resolve(proposeCards(extraction)),
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

  app.setNotFoundHandler(async (_request, reply) =>
    reply.status(404).send({
      ok: false,
      error: {
        message: "Route not found",
        code: "NOT_FOUND",
      },
    } satisfies ApiFailure),
  );

  app.setErrorHandler(async (error, _request, reply) => sendError(reply, error));

  return app;
}
