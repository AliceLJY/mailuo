import { z } from 'zod';

import { createDeepSeekProvider } from '../llm/deepseek.ts';
import { buildEntityResolutionPrompt } from '../llm/prompts.ts';
import type { ChatMessage, StructuredOutputProvider } from '../llm/provider.ts';

import { isSelfName, type PerceptionResult } from './perceive.ts';

type ContactSummary = {
  id: number;
  canonical_name: string;
  aliases: string[];
  company: string | null;
};

type ResolutionPromptBuilder = (
  participantContext: string,
  contactSummaries: ContactSummary[],
) => string | { systemPrompt: string; userPrompt: string };

export type ResolvableContact = {
  id: number;
  canonical_name: string;
  aliases: string[];
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  wechat_id?: string | null;
  notes?: string | null;
};

export type ParticipantResolution =
  | {
      participant_name: string;
      normalized_name: string;
      status: 'same_as';
      contact_id: number;
      source: 'exact' | 'llm';
    }
  | {
      participant_name: string;
      normalized_name: string;
      status: 'new';
      source: 'empty_db' | 'llm';
    }
  | {
      participant_name: string;
      normalized_name: string;
      status: 'unsure';
      candidate_ids: number[];
      source: 'exact_multiple' | 'llm';
    };

type ResolveParticipantsOptions = {
  extraction: PerceptionResult;
  contacts: ResolvableContact[];
  provider?: StructuredOutputProvider;
};

const ResolveDecisionSchemaBase = z.object({
  decision: z.enum(['same_as', 'new', 'unsure']),
}).strict();

function normalizeComparableText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function dedupeNumbers(values: number[]): number[] {
  const seen = new Set<number>();
  const deduped: number[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function buildResolutionSchema(candidateIds: number[]) {
  const candidateIdSet = new Set(candidateIds);
  const CandidateIdSchema = z.number().int().refine((value) => candidateIdSet.has(value), {
    message: `Expected one of candidate ids: ${candidateIds.join(', ')}`,
  });

  return z.discriminatedUnion('decision', [
    ResolveDecisionSchemaBase.extend({
      decision: z.literal('same_as'),
      contact_id: CandidateIdSchema,
    }),
    ResolveDecisionSchemaBase.extend({
      decision: z.literal('new'),
    }),
    ResolveDecisionSchemaBase.extend({
      decision: z.literal('unsure'),
      candidate_ids: z
        .array(CandidateIdSchema)
        .min(1)
        .transform((values) => dedupeNumbers(values)),
    }),
  ]);
}

function buildFactsBySubject(extraction: PerceptionResult) {
  const indexed = new Map<string, PerceptionResult['facts']>();

  for (const fact of extraction.facts) {
    const normalizedName = normalizeComparableText(fact.subject_name);
    const facts = indexed.get(normalizedName) ?? [];
    facts.push(fact);
    indexed.set(normalizedName, facts);
  }

  return indexed;
}

function buildQuotesBySpeaker(extraction: PerceptionResult) {
  const indexed = new Map<string, PerceptionResult['quotes']>();

  for (const quote of extraction.quotes) {
    if (!quote.speaker_name) {
      continue;
    }

    const normalizedName = normalizeComparableText(quote.speaker_name);
    const quotes = indexed.get(normalizedName) ?? [];
    quotes.push(quote);
    indexed.set(normalizedName, quotes);
  }

  return indexed;
}

function formatParticipantContext(
  extraction: PerceptionResult,
  participant: PerceptionResult['participants'][number],
): string {
  const normalizedName = normalizeComparableText(participant.name);
  const factsBySubject = buildFactsBySubject(extraction);
  const quotesBySpeaker = buildQuotesBySpeaker(extraction);
  const relatedFacts = factsBySubject.get(normalizedName) ?? [];
  const relatedQuotes = quotesBySpeaker.get(normalizedName) ?? [];
  const relatedEvents = extraction.events.filter((event) =>
    event.participant_names.some(
      (participantName) => normalizeComparableText(participantName) === normalizedName,
    ),
  );
  const lines = [
    `participant_name: ${participant.name}`,
    `participant_source_quote: ${participant.source_quote}`,
  ];

  if (participant.aliases?.length) {
    lines.push(`participant_aliases: ${participant.aliases.join(' | ')}`);
  }

  if (participant.company) {
    lines.push(`participant_company: ${participant.company}`);
  }

  if (participant.title) {
    lines.push(`participant_title: ${participant.title}`);
  }

  if (participant.phone) {
    lines.push(`participant_phone: ${participant.phone}`);
  }

  if (participant.wechat_id) {
    lines.push(`participant_wechat_id: ${participant.wechat_id}`);
  }

  if (participant.notes) {
    lines.push(`participant_notes: ${participant.notes}`);
  }

  if (relatedFacts.length > 0) {
    lines.push(
      `related_facts: ${JSON.stringify(
        relatedFacts.map((fact) => ({
          field: fact.field,
          value: fact.value,
          source_quote: fact.source_quote,
        })),
      )}`,
    );
  }

  if (relatedQuotes.length > 0) {
    lines.push(
      `related_quotes: ${JSON.stringify(
        relatedQuotes.map((quote) => ({
          text: quote.text,
          source_quote: quote.source_quote,
        })),
      )}`,
    );
  }

  if (relatedEvents.length > 0) {
    lines.push(
      `related_events: ${JSON.stringify(
        relatedEvents.map((event) => ({
          title: event.title,
          time_text: event.time_text,
          location: event.location ?? null,
          participant_names: event.participant_names,
          source_quote: event.source_quote,
        })),
      )}`,
    );
  }

  return lines.join('\n');
}

function isSelfParticipant(participant: PerceptionResult['participants'][number]): boolean {
  return participant.is_self || isSelfName(participant.name);
}

function findExactMatches(
  participantName: string,
  contacts: ResolvableContact[],
): ResolvableContact[] {
  const normalizedParticipantName = normalizeComparableText(participantName);
  const matches = contacts.filter((contact) => {
    if (normalizeComparableText(contact.canonical_name) === normalizedParticipantName) {
      return true;
    }

    return contact.aliases.some(
      (alias) => normalizeComparableText(alias) === normalizedParticipantName,
    );
  });

  return matches.filter(
    (contact, index) => matches.findIndex((candidate) => candidate.id === contact.id) === index,
  );
}

function buildResolutionMessages(
  prompt: ReturnType<ResolutionPromptBuilder>,
): ChatMessage[] {
  if (typeof prompt === 'string') {
    return [{ role: 'user', content: prompt }];
  }

  return [
    { role: 'system', content: prompt.systemPrompt },
    { role: 'user', content: prompt.userPrompt },
  ];
}

export async function resolveParticipants({
  extraction,
  contacts,
  provider,
}: ResolveParticipantsOptions): Promise<ParticipantResolution[]> {
  const participants = extraction.participants.filter(
    (participant) => !isSelfParticipant(participant),
  );
  const unresolvedParticipants = participants.filter(
    (participant) => findExactMatches(participant.name, contacts).length === 0,
  );
  const llmProvider =
    unresolvedParticipants.length > 0 && contacts.length > 0
      ? (provider ?? createDeepSeekProvider())
      : undefined;

  return Promise.all(
    participants.map(async (participant) => {
      const normalizedName = normalizeComparableText(participant.name);

      const exactMatches = findExactMatches(participant.name, contacts);

      if (exactMatches.length === 1) {
        return {
          participant_name: participant.name,
          normalized_name: normalizedName,
          status: 'same_as' as const,
          contact_id: exactMatches[0].id,
          source: 'exact' as const,
        };
      }

      if (exactMatches.length > 1) {
        return {
          participant_name: participant.name,
          normalized_name: normalizedName,
          status: 'unsure' as const,
          candidate_ids: exactMatches.map((contact) => contact.id),
          source: 'exact_multiple' as const,
        };
      }

      if (contacts.length === 0) {
        return {
          participant_name: participant.name,
          normalized_name: normalizedName,
          status: 'new' as const,
          source: 'empty_db' as const,
        };
      }

      const contactSummaries: ContactSummary[] = contacts.map((contact) => ({
        id: contact.id,
        canonical_name: contact.canonical_name,
        aliases: contact.aliases,
        company: contact.company ?? null,
      }));
      const prompt = buildEntityResolutionPrompt(
        formatParticipantContext(extraction, participant),
        contactSummaries,
      );
      const resolution = await llmProvider!.generateStructuredOutput({
        schema: buildResolutionSchema(contactSummaries.map((contact) => contact.id)),
        messages: buildResolutionMessages(prompt),
        temperature: 0,
        responseFormat: { type: 'json_object' },
      });

      if (resolution.decision === 'same_as') {
        return {
          participant_name: participant.name,
          normalized_name: normalizedName,
          status: 'same_as' as const,
          contact_id: resolution.contact_id,
          source: 'llm' as const,
        };
      }

      if (resolution.decision === 'new') {
        return {
          participant_name: participant.name,
          normalized_name: normalizedName,
          status: 'new' as const,
          source: 'llm' as const,
        };
      }

      return {
        participant_name: participant.name,
        normalized_name: normalizedName,
        status: 'unsure' as const,
        candidate_ids: resolution.candidate_ids,
        source: 'llm' as const,
      };
    }),
  );
}
