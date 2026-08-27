import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import type { ScreenshotImageInput } from '../../../shared/core/agent/perceive.ts';
import { OpenAICompatibleProvider, type FetchLike, requireEnv } from './provider.ts';

const DEFAULT_QWEN_MODEL = 'qwen-vl-max';
const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

type QwenProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
};

function normalizeConfiguredModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

function getQwenModel(
  optionModel: string | undefined,
  env = process.env,
): string {
  return (
    normalizeConfiguredModel(optionModel) ??
    normalizeConfiguredModel(env.QWEN_MODEL) ??
    normalizeConfiguredModel(env.QWEN_VISION_MODEL) ??
    DEFAULT_QWEN_MODEL
  );
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
};

const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION).map(([extension, mimeType]) => [mimeType, extension]),
);

export class UnsupportedImageTypeError extends Error {
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageTypeError';
    this.code = 'UNSUPPORTED_IMAGE_TYPE';
  }
}

export class QwenProvider extends OpenAICompatibleProvider {
  constructor(options: QwenProviderOptions = {}) {
    const apiKey = options.apiKey ?? requireEnv('DASHSCOPE_API_KEY');
    const baseUrl =
      options.baseUrl ??
      process.env.DASHSCOPE_BASE_URL ??
      // simplified: deployment can switch to workspace-specific DashScope domains via DASHSCOPE_BASE_URL, M1 keeps the legacy shared endpoint as fallback.
      DEFAULT_DASHSCOPE_BASE_URL;

    super({
      name: 'Qwen',
      model: getQwenModel(options.model),
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      apiKey,
      baseUrl,
      fetchImpl: options.fetchImpl,
    });
  }
}

export function normalizeImageMimeType(mimeType: string | undefined | null): string | null {
  if (!mimeType) {
    return null;
  }

  const normalized = mimeType.trim().toLowerCase();
  const canonical = MIME_ALIASES[normalized] ?? normalized;

  return EXTENSION_BY_MIME[canonical] ? canonical : null;
}

function inferMimeTypeFromPath(imagePath: string): string {
  const extension = extname(imagePath).toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];

  if (!mimeType) {
    throw new UnsupportedImageTypeError(
      `Unsupported image file extension "${extension || '(none)'}"`,
    );
  }

  return mimeType;
}

export function inferExtensionFromMimeType(mimeType: string): string {
  const normalized = normalizeImageMimeType(mimeType);

  if (!normalized) {
    throw new UnsupportedImageTypeError(
      `Unsupported image MIME type "${mimeType}"`,
    );
  }

  return EXTENSION_BY_MIME[normalized];
}

export async function readScreenshotImage(
  imagePath: string,
  mimeType?: string,
): Promise<ScreenshotImageInput> {
  const buffer = await readFile(imagePath);
  const resolvedMimeType = normalizeImageMimeType(mimeType) ?? inferMimeTypeFromPath(imagePath);
  return {
    base64: buffer.toString('base64'),
    mimeType: resolvedMimeType,
  };
}

export function createQwenProvider(options: QwenProviderOptions = {}): QwenProvider {
  return new QwenProvider(options);
}
