import { z } from 'zod';

import { buildPerceptionSystemPrompt, buildPerceptionUserPrompt } from '../llm/prompts.ts';
import type { StructuredOutputProvider } from '../llm/provider.ts';
import { createQwenProvider, imageFileToDataUrl } from '../llm/qwen.ts';

const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
const IsoDateTimeWithOffsetSchema = z.string().datetime({ offset: true });

export const PerceptionParticipantSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  company: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  wechat_id: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  confidence: ConfidenceSchema,
  source_quote: z.string().min(1),
}).strict();

export const PerceptionEventSchema = z.object({
  kind: z.enum(['meeting', 'appointment', 'other']),
  title: z.string().min(1),
  time_text: z.string().min(1),
  time_iso: IsoDateTimeWithOffsetSchema.nullable(),
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
  const imageDataUrl = await imageFileToDataUrl(imagePath, imageMimeType);

  return provider.generateStructuredOutput({
    schema: PerceptionResultSchema,
    messages: [
      {
        role: 'system',
        content: buildPerceptionSystemPrompt(now),
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
