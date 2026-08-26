import { z } from 'zod';

import { createDeepSeekProvider } from '../llm/deepseek.ts';
import {
  buildInsightGenerationPrompt,
  type InsightPromptContact,
  type InsightPromptObservation,
  type InsightPromptSummary,
} from '../llm/prompts.ts';
import type { StructuredOutputProvider } from '../llm/provider.ts';

const InsightKindSchema = z.enum([
  'relationship_read',
  'suggested_action',
  'conversation_hook',
]);

const InsightOutputItemSchema = z
  .object({
    kind: InsightKindSchema,
    content: z.string().min(1),
    based_on: z.array(z.number().int().safe()).default([]),
  })
  .strict();

const InsightOutputSchema = z
  .object({
    insights: z.array(InsightOutputItemSchema).max(3).default([]),
  })
  .strict();

export type InsightKind = z.infer<typeof InsightKindSchema>;

export type InsightContactRecord = InsightPromptContact;

export type InsightObservationRecord = InsightPromptObservation & {
  contact_id: number;
  screenshot_id: number | null;
};

export type InsightSummaryRecord = InsightPromptSummary & {
  contact_id: number;
};

export type InsightContextRecord = {
  contact: InsightContactRecord;
  observations: InsightObservationRecord[];
  recentInsights: InsightSummaryRecord[];
};

export type InsightGenerationEntry = {
  contact_id: number;
  kind: InsightKind;
  content: string;
  based_on: number[];
  generated_at: string;
};

export type InsightGenerationRecord = InsightGenerationEntry & {
  id: number;
};

export type InsightGenerationDb = {
  getInsightContext(contactId: number): InsightContextRecord | null;
  insertInsights(entries: InsightGenerationEntry[]): InsightGenerationRecord[];
};

export type GenerateInsightsOptions = {
  db: InsightGenerationDb;
  contactIds: number[];
  provider?: StructuredOutputProvider;
  now?: Date;
};

export type InsightGenerationResult = {
  requested_contact_ids: number[];
  processed_contact_ids: number[];
  skipped_contact_ids: number[];
  generated: InsightGenerationRecord[];
};

type SanitizedInsightDraft = InsightGenerationEntry;

function dedupeContactIds(contactIds: number[]): number[] {
  const seen = new Set<number>();
  const deduped: number[] = [];

  for (const contactId of contactIds) {
    if (!Number.isSafeInteger(contactId) || seen.has(contactId)) {
      continue;
    }

    seen.add(contactId);
    deduped.push(contactId);
  }

  return deduped;
}

function normalizeInsightContent(content: string): string {
  return content.trim().replace(/\s+/gu, ' ');
}

function sanitizeBasedOnIds(
  basedOn: number[],
  allowedObservationIds: Set<number>,
): number[] {
  const seen = new Set<number>();
  const sanitized: number[] = [];

  for (const observationId of basedOn) {
    if (!allowedObservationIds.has(observationId) || seen.has(observationId)) {
      continue;
    }

    seen.add(observationId);
    sanitized.push(observationId);
  }

  return sanitized;
}

function sanitizeInsightDrafts(options: {
  contactId: number;
  generatedAt: string;
  allowedObservationIds: Set<number>;
  output: z.infer<typeof InsightOutputSchema>;
}): SanitizedInsightDraft[] {
  const drafts: SanitizedInsightDraft[] = [];

  for (const item of options.output.insights) {
    const content = normalizeInsightContent(item.content);

    if (!content) {
      continue;
    }

    const basedOn = sanitizeBasedOnIds(item.based_on, options.allowedObservationIds);

    if (basedOn.length === 0) {
      continue;
    }

    drafts.push({
      contact_id: options.contactId,
      kind: item.kind,
      content,
      based_on: basedOn,
      generated_at: options.generatedAt,
    });
  }

  return drafts;
}

function dedupeInsightEntries(entries: SanitizedInsightDraft[]): SanitizedInsightDraft[] {
  const seen = new Set<string>();
  const deduped: SanitizedInsightDraft[] = [];

  for (const entry of entries) {
    const key = [
      entry.contact_id,
      entry.kind,
      entry.content,
      entry.based_on.join(','),
    ].join('|');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

export async function generateInsights({
  db,
  contactIds,
  provider = createDeepSeekProvider(),
  now = new Date(),
}: GenerateInsightsOptions): Promise<InsightGenerationResult> {
  const requestedContactIds = dedupeContactIds(contactIds);
  const generatedAt = now.toISOString();
  const contextsToProcess: Array<{
    contactId: number;
    context: InsightContextRecord;
    allowedObservationIds: Set<number>;
  }> = [];
  const skippedContactIds: number[] = [];

  for (const contactId of requestedContactIds) {
    const context = db.getInsightContext(contactId);

    if (!context || context.observations.length === 0) {
      skippedContactIds.push(contactId);
      continue;
    }

    contextsToProcess.push({
      contactId,
      context,
      allowedObservationIds: new Set(
        context.observations.map((observation) => observation.id),
      ),
    });
  }

  const drafts: SanitizedInsightDraft[] = [];

  for (const item of contextsToProcess) {
    const prompt = buildInsightGenerationPrompt({
      contact: item.context.contact,
      observations: item.context.observations.map((observation) => ({
        id: observation.id,
        kind: observation.kind,
        content: observation.content,
        source_quote: observation.source_quote,
        observed_at: observation.observed_at,
      })),
      recentInsights: item.context.recentInsights.map((insight) => ({
        id: insight.id,
        kind: insight.kind,
        content: insight.content,
        based_on: insight.based_on,
        generated_at: insight.generated_at,
      })),
    });

    const output = await provider.generateStructuredOutput({
      schema: InsightOutputSchema,
      messages: [
        {
          role: 'system',
          content: prompt.systemPrompt,
        },
        {
          role: 'user',
          content: prompt.userPrompt,
        },
      ],
      temperature: 0,
      maxOutputTokens: 700,
      responseFormat: { type: 'json_object' },
    });

    drafts.push(
      ...sanitizeInsightDrafts({
        contactId: item.contactId,
        generatedAt,
        allowedObservationIds: item.allowedObservationIds,
        output,
      }),
    );
  }

  const dedupedDrafts = dedupeInsightEntries(drafts);
  const generated =
    dedupedDrafts.length > 0 ? db.insertInsights(dedupedDrafts) : [];

  return {
    requested_contact_ids: requestedContactIds,
    processed_contact_ids: contextsToProcess.map((item) => item.contactId),
    skipped_contact_ids: skippedContactIds,
    generated,
  };
}
