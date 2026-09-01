import { z } from 'zod';

import {
  buildEntityResolutionPrompt,
  buildMeetingProgressResolutionPrompt,
} from '../llm/prompts.ts';
import type { ChatMessage, StructuredOutputProvider } from '../llm/provider.ts';
import type { MeetingKind } from '../../types.ts';

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

export type ResolveParticipantsOptions = {
  extraction: PerceptionResult;
  contacts: ResolvableContact[];
  provider?: StructuredOutputProvider;
  providerFactory?: () => StructuredOutputProvider;
};

export type ResolvableMeeting = {
  id: number;
  kind: MeetingKind;
  title: string;
  time_iso: string | null;
  time_text: string;
  status: string;
  created_at: string;
};

export type MeetingProgressFragment = {
  content: string;
  source_quote: string;
};

export type MeetingProgressResolution = {
  meeting_id: number;
  fragments: MeetingProgressFragment[];
};

export type ResolveMeetingProgressOptions = {
  extraction: PerceptionResult;
  meetings: ResolvableMeeting[];
  provider?: StructuredOutputProvider;
  providerFactory?: () => StructuredOutputProvider;
};

// `upcoming` is the only unfinished status produced by the current model. Keeping
// the newest 20 bounds prompt cost and excludes older context that is riskier to mis-associate.
export const MEETING_PROGRESS_CANDIDATE_LIMIT = 20;

const ResolveDecisionSchemaBase = z.object({
  decision: z.enum(['same_as', 'new', 'unsure']),
}).strict();

const directProgressSignalPatterns = [
  /(?:已|已经|现已|均已|都已|刚|刚刚)\s*(?:到(?:达|场|位)?|抵达|就位|完成|办妥|补齐|准备好|改完|处理完|提交|发送|发出|交付|确认|通过|批准|签署|签完|上线|开工|开始|结束|取消|延期|回复|联系)(?:了)?/u,
  /(?:总|导|老师|主任|经理|先生|女士|哥|姐|嘉宾|客户|领导|同事|团队)\s*(?:到了|到达了|抵达了)/u,
  /(?:完成|办妥|补齐|就位|准备好|改完|处理完|提交|发送|发出|交付|确认|批准|签署|签完|上线|开工|开始|结束|取消|延期|回复|联系)(?:了|啦|完毕)/u,
];

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

function hasDirectProgressSignal(content: string, sourceQuote: string): boolean {
  return directProgressSignalPatterns.some(
    (pattern) => pattern.test(content) || pattern.test(sourceQuote),
  );
}

function collectMeetingProgressFragments(
  extraction: PerceptionResult,
): MeetingProgressFragment[] {
  // A progress card is only useful when the unchanged proposal flow can also
  // produce the person's interaction fallback from the same perception result.
  if (!extraction.participants.some((participant) => !isSelfParticipant(participant))) {
    return [];
  }

  const candidates: MeetingProgressFragment[] = [];
  const seenSourceQuotes = new Set<string>();

  const addCandidate = (content: string | undefined, sourceQuote: string): void => {
    if (!content?.trim() || !sourceQuote.trim()) {
      return;
    }

    const sourceQuoteKey = sourceQuote.trim();

    if (
      seenSourceQuotes.has(sourceQuoteKey) ||
      !hasDirectProgressSignal(content, sourceQuote)
    ) {
      return;
    }

    seenSourceQuotes.add(sourceQuoteKey);
    candidates.push({ content, source_quote: sourceQuote });
  };

  for (const participant of extraction.participants) {
    if (participant.confidence === 'low') {
      continue;
    }

    addCandidate(participant.interaction_summary, participant.source_quote);
    addCandidate(participant.notes, participant.source_quote);
  }

  for (const fact of extraction.facts) {
    if (
      fact.confidence === 'low' ||
      (fact.field !== 'notes' && fact.field !== 'other')
    ) {
      continue;
    }

    addCandidate(fact.value, fact.source_quote);
  }

  for (const event of extraction.events) {
    if (event.confidence === 'low') {
      continue;
    }

    addCandidate(event.agenda ?? event.title, event.source_quote);
  }

  for (const quote of extraction.quotes) {
    addCandidate(quote.text, quote.source_quote);
  }

  return candidates;
}

function selectMeetingProgressCandidates(meetings: ResolvableMeeting[]): ResolvableMeeting[] {
  const seenMeetingIds = new Set<number>();

  return meetings
    .filter((meeting) => meeting.status === 'upcoming')
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .filter((meeting) => {
      if (seenMeetingIds.has(meeting.id)) {
        return false;
      }

      seenMeetingIds.add(meeting.id);
      return true;
    })
    .slice(0, MEETING_PROGRESS_CANDIDATE_LIMIT);
}

function buildMeetingProgressResponseSchema(fragmentIds: number[], meetingIds: number[]) {
  const fragmentIdSet = new Set(fragmentIds);
  const meetingIdSet = new Set(meetingIds);

  return z.object({
    matches: z.array(
      z.object({
        fragment_id: z.number().int().refine((value) => fragmentIdSet.has(value)),
        meeting_id: z.number().int().refine((value) => meetingIdSet.has(value)),
        confidence: z.enum(['high', 'medium', 'low']),
      }).strict(),
    ),
  }).strict();
}

export async function resolveMeetingProgress({
  extraction,
  meetings,
  provider,
  providerFactory,
}: ResolveMeetingProgressOptions): Promise<MeetingProgressResolution[]> {
  const meetingCandidates = selectMeetingProgressCandidates(meetings);

  if (meetingCandidates.length === 0) {
    return [];
  }

  const fragments = collectMeetingProgressFragments(extraction);

  if (fragments.length === 0) {
    return [];
  }

  let llmProvider = provider;

  if (!llmProvider && providerFactory) {
    try {
      llmProvider = providerFactory();
    } catch {
      return [];
    }
  }

  if (!llmProvider) {
    throw new TypeError('A structured-output provider is required for meeting progress resolution');
  }

  const promptFragments = fragments.map((fragment, index) => ({
    fragment_id: index + 1,
    content: fragment.content,
    source_quote: fragment.source_quote,
  }));
  const prompt = buildMeetingProgressResolutionPrompt({
    perception: extraction,
    fragments: promptFragments,
    meetings: meetingCandidates.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      time_iso: meeting.time_iso,
      time_text: meeting.time_text,
      kind: meeting.kind,
    })),
  });
  let parsedResponse: z.infer<ReturnType<typeof buildMeetingProgressResponseSchema>>;

  try {
    const rawResponse = await llmProvider.complete({
      messages: buildResolutionMessages(prompt),
      temperature: 0,
      responseFormat: { type: 'json_object' },
    });
    const responseSchema = buildMeetingProgressResponseSchema(
      promptFragments.map((fragment) => fragment.fragment_id),
      meetingCandidates.map((meeting) => meeting.id),
    );
    parsedResponse = responseSchema.parse(JSON.parse(rawResponse));
  } catch {
    return [];
  }

  const matchesByFragment = new Map<
    number,
    Array<z.infer<ReturnType<typeof buildMeetingProgressResponseSchema>>['matches'][number]>
  >();

  for (const match of parsedResponse.matches) {
    const fragmentMatches = matchesByFragment.get(match.fragment_id) ?? [];
    fragmentMatches.push(match);
    matchesByFragment.set(match.fragment_id, fragmentMatches);
  }

  const resolutionsByMeeting = new Map<number, MeetingProgressResolution>();

  for (const promptFragment of promptFragments) {
    const fragmentMatches = matchesByFragment.get(promptFragment.fragment_id) ?? [];
    const meetingIds = new Set(fragmentMatches.map((match) => match.meeting_id));

    if (
      fragmentMatches.length === 0 ||
      fragmentMatches.some((match) => match.confidence !== 'high') ||
      meetingIds.size !== 1
    ) {
      continue;
    }

    const meetingId = [...meetingIds][0];
    const resolution = resolutionsByMeeting.get(meetingId) ?? {
      meeting_id: meetingId,
      fragments: [],
    };
    resolution.fragments.push(fragments[promptFragment.fragment_id - 1]);
    resolutionsByMeeting.set(meetingId, resolution);
  }

  return [...resolutionsByMeeting.values()];
}

export async function resolveParticipants({
  extraction,
  contacts,
  provider,
  providerFactory,
}: ResolveParticipantsOptions): Promise<ParticipantResolution[]> {
  const participants = extraction.participants.filter(
    (participant) => !isSelfParticipant(participant),
  );
  const unresolvedParticipants = participants.filter(
    (participant) => findExactMatches(participant.name, contacts).length === 0,
  );
  const llmProvider =
    unresolvedParticipants.length > 0 && contacts.length > 0
      ? (provider ?? providerFactory?.())
      : undefined;

  if (unresolvedParticipants.length > 0 && contacts.length > 0 && !llmProvider) {
    throw new TypeError('A structured-output provider is required for entity resolution');
  }

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
