import { z } from 'zod';

import { MEETING_KINDS } from '../../types.ts';
import { buildPerceptionSystemPrompt, buildPerceptionUserPrompt } from '../llm/prompts.ts';
import type { StructuredOutputProvider } from '../llm/provider.ts';
import { normalizeContactText } from '../text/compare.ts';

const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
const IsoDateTimeWithOffsetSchema = z.string().datetime({ offset: true });

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeSelfName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function isSelfName(value: string, selfNames: readonly string[] = []): boolean {
  const normalizedValue = normalizeSelfName(value);

  return normalizedValue === '我' || (
    normalizedValue.length > 0 && selfNames.some(
      (selfName) => normalizeSelfName(selfName) === normalizedValue,
    )
  );
}

export const PerceptionParticipantSchema = z.object({
  name: z.string().min(1),
  is_self: z.boolean(),
  role: z.enum(['speaker', 'mentioned']).optional(),
  speech_act: z.enum(['initiate', 'respond']).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  company: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  wechat_id: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  interaction_summary: z.string().trim().min(1).optional(),
  confidence: ConfidenceSchema,
  source_quote: z.string().min(1),
}).strict();

export const PerceptionEventSchema = z.object({
  kind: z.enum(MEETING_KINDS),
  title: z.string().min(1),
  time_text: z.string(),
  time_iso: IsoDateTimeWithOffsetSchema.nullable(),
  has_time_signal: z.boolean(),
  location: z.string().min(1).optional(),
  participant_names: z.array(z.string().min(1)).default([]),
  agenda: z.string().min(1).optional(),
  confidence: ConfidenceSchema,
  source_quote: z.string().min(1),
}).strict();

export const PerceptionFactSchema = z.object({
  subject_name: z.string().min(1),
  field: z.enum(['alias', 'company', 'title', 'phone', 'wechat_id', 'notes', 'other']),
  value: z.string().min(1),
  confidence: ConfidenceSchema,
  source_quote: z.string().min(1),
}).strict();

export const PerceptionQuoteSchema = z.object({
  speaker_name: z.string().min(1).nullable(),
  text: z.string().min(1),
  source_quote: z.string().min(1),
}).strict();

export const PerceptionResultSchema = z.object({
  participants: z.array(PerceptionParticipantSchema).default([]),
  events: z.array(PerceptionEventSchema).default([]),
  facts: z.array(PerceptionFactSchema).default([]),
  quotes: z.array(PerceptionQuoteSchema).default([]),
}).strict();

export type PerceptionResult = z.infer<typeof PerceptionResultSchema>;

export function applySelfNames(
  extraction: PerceptionResult,
  selfNames: readonly string[],
  knownContactNames: ReadonlySet<string> = new Set(),
): PerceptionResult {
  if (selfNames.length === 0 && knownContactNames.size === 0) {
    return extraction;
  }

  const participants = extraction.participants.map((participant) => {
    if (!participant.is_self) {
      return isSelfName(participant.name, selfNames)
        ? { ...participant, is_self: true }
        : participant;
    }

    // Reverse case: the model marked this participant as "me", but it is neither the
    // literal "我" nor one of the registered self-nicknames, and it matches an already
    // known contact — that is someone else's account, not a self-name mismatch. Names that
    // are not known contacts (e.g. Alice's own account name under a different app/company)
    // are left alone so a correct self-judgment is never flipped.
    if (
      participant.name !== '我' &&
      !isSelfName(participant.name, selfNames) &&
      knownContactNames.has(normalizeContactText(participant.name))
    ) {
      return { ...participant, is_self: false };
    }

    return participant;
  });

  // Nicknames only ever land on extraction.participants[].is_self above; an event's own
  // participant_names is a separate list that the model free-writes, so a registered
  // nickname that only shows up there (no mirrored participants[] entry) would otherwise
  // never resolve to "我". Collapse every self-name hit within one event into a single "我".
  const events = selfNames.length === 0 ? extraction.events : extraction.events.map((event) => {
    const hasSelfHit = event.participant_names.some((name) => isSelfName(name, selfNames));

    if (!hasSelfHit) {
      return event;
    }

    return {
      ...event,
      participant_names: [
        ...event.participant_names.filter((name) => !isSelfName(name, selfNames)),
        '我',
      ],
    };
  });

  return {
    ...extraction,
    participants,
    events,
  };
}

export type ScreenshotImageInput = {
  base64: string;
  mimeType: string;
};

function normalizeLegacyParticipant(value: unknown): unknown {
  if (!isRecord(value) || hasOwnProperty(value, 'is_self')) {
    return value;
  }

  return {
    ...value,
    is_self: hasNonEmptyString(value.name) ? isSelfName(value.name) : false,
  };
}

function normalizeLegacyEvent(value: unknown): unknown {
  if (!isRecord(value) || hasOwnProperty(value, 'has_time_signal')) {
    return value;
  }

  return {
    ...value,
    has_time_signal: hasNonEmptyString(value.time_iso),
  };
}

export function parseStoredPerceptionResult(rawExtraction: unknown): PerceptionResult | null {
  const strictResult = PerceptionResultSchema.safeParse(rawExtraction);

  if (strictResult.success) {
    return strictResult.data;
  }

  if (!isRecord(rawExtraction)) {
    return null;
  }

  const compatResult = PerceptionResultSchema.safeParse({
    ...rawExtraction,
    participants: Array.isArray(rawExtraction.participants)
      ? rawExtraction.participants.map((participant) => normalizeLegacyParticipant(participant))
      : rawExtraction.participants,
    events: Array.isArray(rawExtraction.events)
      ? rawExtraction.events.map((event) => normalizeLegacyEvent(event))
      : rawExtraction.events,
  });

  return compatResult.success ? compatResult.data : null;
}

export type PerceiveScreenshotOptions = {
  image: ScreenshotImageInput;
  note?: string;
  timestampHints?: readonly string[];
  provider: StructuredOutputProvider;
  now?: Date;
};

export async function perceiveScreenshot({
  image,
  note,
  timestampHints = [],
  provider,
  now = new Date(),
}: PerceiveScreenshotOptions): Promise<PerceptionResult> {
  const imageDataUrl = `data:${image.mimeType};base64,${image.base64}`;

  return provider.generateStructuredOutput({
    schema: PerceptionResultSchema,
    messages: [
      {
        role: 'system',
        content: buildPerceptionSystemPrompt(now, timestampHints),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPerceptionUserPrompt(note) },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0,
    responseFormat: { type: 'json_object' },
  });
}
