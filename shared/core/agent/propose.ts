import {
  MEETING_CHANGE_FIELDS,
  type ActionCard,
  type ActionCardStatus,
  type ContactCandidate,
  type CreateContactPayload,
  type CreateMeetingPayload,
  type MeetingChangeField,
  type MeetingChanges,
  type MeetingKind,
  type RecordInteractionPayload,
  type UpdateContactPayload,
} from '../../types.ts';
import {
  editDistance,
  normalizeComparableText,
  normalizeContactText,
  normalizedEditSimilarity,
  tokenize,
} from '../text/compare.ts';

import { normalizeSelfName, type PerceptionResult } from './perceive.ts';
import type {
  MeetingProgressResolution,
  ParticipantResolution,
  ResolvableContact,
} from './resolve.ts';
import { resolveChineseTime } from './resolve-time.ts';

export type CardConfidence = 'high' | 'medium' | 'low';

export type ProposedCard = ActionCard;

type PerceptionFact = PerceptionResult['facts'][number];
type PerceptionQuote = PerceptionResult['quotes'][number];
type ProposeParticipant = PerceptionResult['participants'][number] & {
  is_self?: boolean;
  speech_act?: 'initiate' | 'respond';
};
type ProposeEvent = PerceptionResult['events'][number] & { has_time_signal?: boolean };
type ContactField = 'company' | 'title' | 'phone' | 'wechat_id' | 'notes';

export type ExistingMeeting = {
  id: number;
  kind: MeetingKind;
  title: string;
  time_iso: string | null;
  time_text: string;
  location: string | null;
  participants: Array<{ contact_id?: number; name: string }>;
  agenda: string | null;
};

export type BatchOtherCardReference = {
  card_id: number;
  source_quote: string;
  time_text: string;
  status: ActionCardStatus;
  // Optional: callers that can cheaply snapshot the full stored payload (e.g. the local
  // batch session) attach it here so a later merge can reconstruct the complete payload of
  // the retained/anchor card. Absent in older or hand-built references; treat as unknown.
  payload?: CreateMeetingPayload;
};

export type BatchOtherDedupMatch = {
  title: string;
  matched_card_id: number;
  similarity: number;
  // The cut (newly proposed, filtered-out) card's own time fields, carried forward so a
  // caller can backfill them onto the retained card when the retained one still lacks a
  // resolved date. dedupeBatchOtherCards always fills these in from the cut card; it does
  // not itself decide whether a merge should happen.
  time_iso: string | null;
  time_text: string;
  agenda?: string;
};

export type NoticeRouting = {
  title: string;
  decision: 'stored' | 'batch' | 'dropped' | 'timeless_dropped';
  target_title?: string;
};

export type ProposedCardsWithRouting = {
  cards: ProposedCard[];
  noticeRouting: NoticeRouting[];
};

export const MEETING_DUPLICATE_RULES = {
  similarTitleThreshold: 0.9,
  minimumSimilarTitleLength: 8,
} as const;

export const BATCH_OTHER_DEDUP_RULES = {
  sourceQuoteSimilarityThreshold: 0.85,
} as const;

const selfParticipantName = '我';
const trackedContactFields: ContactField[] = ['company', 'title', 'phone', 'wechat_id', 'notes'];
const pureAcknowledgementTexts = new Set([
  '收到',
  '好的',
  '好',
  '嗯',
  '嗯嗯',
  'OK',
  'ok',
  '好嘞',
  '了解',
  '明白',
  '知道了',
  '谢谢',
  '收到谢谢',
  '好的收到',
]);
const genericMentionNames = new Set([
  '大家',
  '各位',
  '全体',
  '同事们',
  '同学们',
  '各位同事',
  '各位领导',
  '领导们',
  '全体员工',
]);
const organizationMentionSuffixes = [
  '部',
  '处',
  '科',
  '室',
  '办',
  '办公室',
  '公司',
  '集团',
  '中心',
  '委员会',
  '工作部',
  '事业部',
  '小组',
] as const;
const acknowledgementNoisePattern = /(?:[0-9#*]\uFE0F?\u20E3|[\p{P}\p{White_Space}\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\u200D\u20E3\uFE0E\uFE0F\u{E0020}-\u{E007F}])/gu;

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const trimmed = value.trim();

    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    deduped.push(trimmed);
  }

  return deduped;
}

function normalizeMeetingTitle(value: string): string {
  return normalizeContactText(value);
}

function calendarDay(value: string | null): string | null {
  return value?.trim().match(/^\d{4}-\d{2}-\d{2}(?=T|\s|$)/u)?.[0] ?? null;
}

function findDuplicateMeeting(
  payload: CreateMeetingPayload,
  existingMeetings: ExistingMeeting[],
): ExistingMeeting | undefined {
  const kind = payload.kind ?? 'meeting';
  const normalizedTitle = normalizeMeetingTitle(payload.title);

  if (!normalizedTitle) {
    return undefined;
  }

  const sameKind = existingMeetings.filter((meeting) => meeting.kind === kind);
  const exactMatches = sameKind.filter(
    (meeting) => normalizeMeetingTitle(meeting.title) === normalizedTitle,
  );

  // Multiple existing rows with the same normalized title are ambiguous; leaking a duplicate is safer than updating the wrong row.
  if (exactMatches.length !== 0) {
    return exactMatches.length === 1 ? exactMatches[0] : undefined;
  }

  const proposedDay = calendarDay(payload.time_iso);
  if (
    !proposedDay ||
    Array.from(normalizedTitle).length < MEETING_DUPLICATE_RULES.minimumSimilarTitleLength
  ) {
    return undefined;
  }

  // A high threshold, a minimum title length, and a same-day gate intentionally favor missed duplicates over false merges.
  const similarMatches = sameKind.filter((meeting) => {
    const existingTitle = normalizeMeetingTitle(meeting.title);
    return (
      calendarDay(meeting.time_iso) === proposedDay &&
      Array.from(existingTitle).length >= MEETING_DUPLICATE_RULES.minimumSimilarTitleLength &&
      normalizedEditSimilarity(normalizedTitle, existingTitle) >=
        MEETING_DUPLICATE_RULES.similarTitleThreshold
    );
  });

  return similarMatches.length === 1 ? similarMatches[0] : undefined;
}

function normalizeMeetingChangeValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function appendMeetingAgenda(
  existingAgenda: string | null | undefined,
  additions: string[],
): string | null {
  const existing = normalizeMeetingChangeValue(existingAgenda);
  const accepted: string[] = [];
  const knownFragments = new Set(
    (existing ?? '')
      .split(/[；;\n]+/u)
      .map(normalizeComparableText)
      .filter(Boolean),
  );

  for (const addition of dedupeStrings(additions.flatMap((value) => value.split(/[；;\n]+/u)))) {
    const comparableAddition = normalizeComparableText(addition);

    if (!comparableAddition || knownFragments.has(comparableAddition)) {
      continue;
    }

    accepted.push(addition);
    knownFragments.add(comparableAddition);
  }

  return [existing, ...accepted].filter((value): value is string => Boolean(value)).join('；') || null;
}

function formatMeetingParticipants(
  participants: Array<{ contact_id?: number; name: string }>,
): string | null {
  if (participants.length === 0) {
    return null;
  }

  return participants
    .map((participant) => {
      const name = participant.name.trim();
      return participant.contact_id == null ? name : `${name}（联系人 ${participant.contact_id}）`;
    })
    .join('、');
}

function serializeMeetingParticipants(
  participants: Array<{ contact_id?: number; name: string }>,
): string {
  return JSON.stringify(
    participants.map((participant) => [participant.contact_id ?? null, participant.name.trim()]),
  );
}

function mergeMeetingParticipants(
  existing: ExistingMeeting['participants'],
  proposed: CreateMeetingPayload['participants'],
): CreateMeetingPayload['participants'] {
  const merged = existing.map((participant) => ({ ...participant }));

  for (const participant of proposed) {
    const normalizedName = normalizeComparableText(participant.name);
    const existingIndex = merged.findIndex((candidate) => {
      if (participant.contact_id != null && candidate.contact_id != null) {
        return candidate.contact_id === participant.contact_id;
      }

      return normalizeComparableText(candidate.name) === normalizedName;
    });

    if (existingIndex === -1) {
      merged.push({ ...participant });
      continue;
    }

    merged[existingIndex] = {
      ...merged[existingIndex],
      ...participant,
    };
  }

  return merged;
}

function mergeDuplicateMeetingPayload(
  existing: ExistingMeeting,
  proposed: CreateMeetingPayload,
): CreateMeetingPayload {
  const proposedTimeText = normalizeMeetingChangeValue(proposed.time_text);
  const proposedLocation = normalizeMeetingChangeValue(proposed.location);
  const proposedAgenda = normalizeMeetingChangeValue(proposed.agenda);

  return {
    ...proposed,
    time_iso: normalizeMeetingChangeValue(proposed.time_iso) ?? existing.time_iso,
    time_text: proposedTimeText ?? existing.time_text,
    ...(proposedLocation ?? existing.location
      ? { location: proposedLocation ?? existing.location! }
      : {}),
    participants: mergeMeetingParticipants(existing.participants, proposed.participants),
    ...(proposedAgenda ?? existing.agenda
      ? { agenda: proposedAgenda ?? existing.agenda! }
      : {}),
  };
}

export function buildMeetingChanges(
  existing: ExistingMeeting,
  proposed: CreateMeetingPayload,
): MeetingChanges {
  const oldValues: Record<MeetingChangeField, string | null> = {
    title: normalizeMeetingChangeValue(existing.title),
    time_iso: normalizeMeetingChangeValue(existing.time_iso),
    time_text: normalizeMeetingChangeValue(existing.time_text),
    location: normalizeMeetingChangeValue(existing.location),
    participants: formatMeetingParticipants(existing.participants),
    agenda: normalizeMeetingChangeValue(existing.agenda),
  };
  const newValues: Record<MeetingChangeField, string | null> = {
    title: normalizeMeetingChangeValue(proposed.title),
    time_iso: normalizeMeetingChangeValue(proposed.time_iso),
    time_text: normalizeMeetingChangeValue(proposed.time_text),
    location: normalizeMeetingChangeValue(proposed.location),
    participants: formatMeetingParticipants(proposed.participants),
    agenda: normalizeMeetingChangeValue(proposed.agenda),
  };
  const changes: MeetingChanges = {};

  for (const field of MEETING_CHANGE_FIELDS) {
    const unchanged = field === 'participants'
      ? serializeMeetingParticipants(existing.participants) ===
        serializeMeetingParticipants(proposed.participants)
      : oldValues[field] === newValues[field];

    if (!unchanged) {
      changes[field] = { old: oldValues[field], new: newValues[field] };
    }
  }

  return changes;
}

function isSelfParticipant(participant: ProposeParticipant): boolean {
  return participant.is_self === true || normalizeSelfName(participant.name) === selfParticipantName;
}

function buildSelfParticipantNames(participants: ProposeParticipant[]): Set<string> {
  const normalizedNames = new Set<string>([selfParticipantName]);

  for (const participant of participants) {
    if (isSelfParticipant(participant)) {
      normalizedNames.add(normalizeSelfName(participant.name));
    }
  }

  return normalizedNames;
}

function joinSourceQuotes(values: Array<string | undefined>): string {
  return dedupeStrings(values).join('\n\n');
}

function collectFactValues(
  initialValues: Array<string | undefined>,
  facts: PerceptionFact[] | undefined,
  fieldMatcher: (fact: PerceptionFact) => boolean,
): { values: string[]; sourceQuotes: string[] } {
  const seen = new Set<string>();
  const values: string[] = [];
  const sourceQuotes: string[] = [];

  for (const value of initialValues) {
    if (!value) {
      continue;
    }

    const trimmed = value.trim();

    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    values.push(trimmed);
  }

  for (const fact of facts ?? []) {
    if (!fieldMatcher(fact)) {
      continue;
    }

    const trimmed = fact.value.trim();

    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    values.push(trimmed);
    sourceQuotes.push(fact.source_quote);
  }

  return { values, sourceQuotes };
}

function indexFactsBySubject(facts: PerceptionResult['facts']): Map<string, PerceptionFact[]> {
  const indexed = new Map<string, PerceptionFact[]>();

  for (const fact of facts) {
    const list = indexed.get(normalizeComparableText(fact.subject_name)) ?? [];
    list.push(fact);
    indexed.set(normalizeComparableText(fact.subject_name), list);
  }

  return indexed;
}

function indexQuotesBySpeaker(quotes: PerceptionResult['quotes']): Map<string, PerceptionQuote[]> {
  const indexed = new Map<string, PerceptionQuote[]>();

  for (const quote of quotes) {
    if (!quote.speaker_name) {
      continue;
    }

    const list = indexed.get(normalizeComparableText(quote.speaker_name)) ?? [];
    list.push(quote);
    indexed.set(normalizeComparableText(quote.speaker_name), list);
  }

  return indexed;
}

function firstFact(
  facts: PerceptionFact[] | undefined,
  field: PerceptionFact['field'],
): PerceptionFact | undefined {
  return facts?.find((fact) => fact.field === field);
}

type StructuredNoteAnchor = {
  sourceQuote: string;
  sourceQuoteNormalized: string;
  normalizedValues: string[];
};

const noteSegmentPattern = /[\r\n]+|[，,。；;：:！？?!]+/u;
const noteEdgeTrimPattern = /^[\s，,。；;：:！？?!、]+|[\s，,。；;：:！？?!、]+$/gu;

function buildStructuredNoteAnchors(
  participant: ProposeParticipant,
  structuredFacts: Array<PerceptionFact | undefined>,
): StructuredNoteAnchor[] {
  const anchors = new Map<string, Set<string>>();
  const participantStructuredValues = [
    participant.company,
    participant.title,
    participant.phone,
    participant.wechat_id,
  ]
    .map((value) => normalizeOptionalText(value))
    .filter((value): value is string => Boolean(value));

  if (participantStructuredValues.length > 0) {
    anchors.set(participant.source_quote, new Set(participantStructuredValues));
  }

  for (const fact of structuredFacts) {
    if (!fact) {
      continue;
    }

    const normalizedValue = normalizeOptionalText(fact.value);

    if (!normalizedValue) {
      continue;
    }

    const values = anchors.get(fact.source_quote) ?? new Set<string>();
    values.add(normalizedValue);
    anchors.set(fact.source_quote, values);
  }

  return Array.from(anchors.entries()).map(([sourceQuote, values]) => ({
    sourceQuote,
    sourceQuoteNormalized: normalizeComparableText(sourceQuote),
    normalizedValues: Array.from(values.values()).map((value) => normalizeComparableText(value)),
  }));
}

function splitNoteSegments(value: string): string[] {
  return value
    .split(noteSegmentPattern)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function trimNoteSegmentEdge(value: string): string {
  return value.replace(noteEdgeTrimPattern, '').trim();
}

function extractFreeformSegmentTail(
  segment: string,
  structuredValues: string[],
): string | undefined {
  const normalizedSegment = normalizeComparableText(segment);
  const matchedStructuredValues = structuredValues.filter((structuredValue) =>
    normalizedSegment.includes(structuredValue),
  );

  if (matchedStructuredValues.length === 0) {
    return trimNoteSegmentEdge(segment);
  }

  if (matchedStructuredValues.length > 1) {
    return undefined;
  }

  const [matchedStructuredValue] = matchedStructuredValues;
  const firstMatchIndex = normalizedSegment.indexOf(matchedStructuredValue);
  const lastMatchIndex = normalizedSegment.lastIndexOf(matchedStructuredValue);

  if (firstMatchIndex !== lastMatchIndex) {
    return undefined;
  }

  const freeformTail = trimNoteSegmentEdge(
    segment.slice(firstMatchIndex + matchedStructuredValue.length),
  );

  if (!freeformTail) {
    return undefined;
  }

  const normalizedTail = normalizeComparableText(freeformTail);

  if (
    structuredValues.some(
      (structuredValue) =>
        normalizedTail === structuredValue || normalizedTail.includes(structuredValue),
    )
  ) {
    return undefined;
  }

  return freeformTail;
}

function collectFreeformNoteSegments(
  value: string,
  sourceQuote: string,
  anchors: StructuredNoteAnchor[],
): string[] {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return [];
  }

  const normalizedValue = normalizeComparableText(value);
  const normalizedSourceQuote = normalizeComparableText(sourceQuote);
  const exactStructuredValues = new Set(
    anchors.flatMap((anchor) => anchor.normalizedValues.map((structuredValue) => structuredValue)),
  );

  if (exactStructuredValues.has(normalizedValue)) {
    return [];
  }

  const matchingAnchors = anchors.filter(
    (anchor) => anchor.sourceQuoteNormalized === normalizedSourceQuote,
  );

  if (matchingAnchors.length === 0) {
    return [trimmedValue];
  }

  const structuredValues = Array.from(
    new Set(
      matchingAnchors.flatMap((anchor) => anchor.normalizedValues.map((structuredValue) => structuredValue)),
    ),
  );
  const hasStructuredValue = structuredValues.some(
    (structuredValue) =>
      normalizedValue === structuredValue || normalizedValue.includes(structuredValue),
  );

  if (!hasStructuredValue) {
    return [trimmedValue];
  }

  return splitNoteSegments(trimmedValue)
    .map((segment) => extractFreeformSegmentTail(segment, structuredValues))
    .filter((segment): segment is string => Boolean(segment));
}

function collectFreeformNotes(
  participant: ProposeParticipant,
  facts: PerceptionFact[] | undefined,
  structuredAnchors: StructuredNoteAnchor[],
): { values: string[]; sourceQuotes: string[] } {
  const seen = new Set<string>();
  const values: string[] = [];
  const sourceQuotes: string[] = [];

  const appendNoteValue = (noteValue: string | undefined, sourceQuote: string): void => {
    if (!noteValue) {
      return;
    }

    const noteSegments = collectFreeformNoteSegments(noteValue, sourceQuote, structuredAnchors);
    let appended = false;

    for (const segment of noteSegments) {
      if (seen.has(segment)) {
        continue;
      }

      seen.add(segment);
      values.push(segment);
      appended = true;
    }

    if (appended) {
      sourceQuotes.push(sourceQuote);
    }
  };

  appendNoteValue(participant.notes, participant.source_quote);

  for (const fact of facts ?? []) {
    if (fact.field !== 'notes' && fact.field !== 'other') {
      continue;
    }

    appendNoteValue(fact.value, fact.source_quote);
  }

  return { values, sourceQuotes };
}

function buildCreateContactPayload(
  participant: ProposeParticipant,
  relatedFacts: PerceptionFact[] | undefined,
  libraryFieldValues: string[] = [],
): {
  payload: CreateContactPayload;
  sourceQuote: string;
  aliases: string[];
  sourceQuotes: string[];
} {
  const aliasMerge = collectFactValues(
    participant.aliases ?? [],
    relatedFacts,
    (fact) => fact.field === 'alias',
  );

  const payload: CreateContactPayload = {
    name: participant.name,
  };

  const companyFact = participant.company ? undefined : firstFact(relatedFacts, 'company');
  const titleFact = participant.title ? undefined : firstFact(relatedFacts, 'title');
  const phoneFact = participant.phone ? undefined : firstFact(relatedFacts, 'phone');
  const wechatIdFact = participant.wechat_id ? undefined : firstFact(relatedFacts, 'wechat_id');
  const company = participant.company ?? companyFact?.value;
  const title = participant.title ?? titleFact?.value;
  const phone = participant.phone ?? phoneFact?.value;
  const wechatId = participant.wechat_id ?? wechatIdFact?.value;
  const noteMerge = collectFreeformNotes(
    participant,
    relatedFacts,
    buildStructuredNoteAnchors(participant, [
      companyFact,
      titleFact,
      phoneFact,
      wechatIdFact,
    ]),
  );
  const noteParts = noteMerge.values;

  if (company) {
    payload.company = company;
  }

  if (title) {
    payload.title = title;
  }

  const aliases = aliasMerge.values.filter((alias) =>
    !isDerivedAlias(
      alias,
      {
        canonical_name: participant.name,
        aliases: [],
        company: null,
        title: null,
      },
      payload,
      libraryFieldValues,
    ),
  );

  if (aliases.length > 0) {
    payload.aliases = aliases;
  }

  if (phone) {
    payload.phone = phone;
  }

  if (wechatId) {
    payload.wechat_id = wechatId;
  }

  if (noteParts.length > 0) {
    payload.notes = noteParts.join('；');
  }

  const sourceQuotes = [
    participant.source_quote,
    ...aliasMerge.sourceQuotes,
    companyFact?.source_quote,
    titleFact?.source_quote,
    phoneFact?.source_quote,
    wechatIdFact?.source_quote,
    ...noteMerge.sourceQuotes,
  ];

  return {
    payload,
    sourceQuote: joinSourceQuotes(sourceQuotes),
    aliases,
    sourceQuotes: dedupeStrings(sourceQuotes),
  };
}

function buildMeetingCard(
  event: ProposeEvent,
  sameAsParticipantsByName: Map<string, number | null>,
  unsureCandidatesByName: Map<string, ContactCandidate[] | null>,
  selfParticipantNames: Set<string>,
  existingMeetings: ExistingMeeting[],
): ProposedCard {
  const normalizedTimeIso = normalizeOptionalText(event.time_iso);
  let hasSelfParticipant = false;

  let payload: CreateMeetingPayload = {
    kind: event.kind,
    title: event.title,
    time_iso: normalizedTimeIso ?? null,
    time_text: event.time_text.trim(),
    participants: event.participant_names.flatMap<CreateMeetingPayload['participants'][number]>((name) => {
      const normalizedName = normalizeComparableText(name);

      if (selfParticipantNames.has(normalizeSelfName(name))) {
        if (hasSelfParticipant) {
          return [];
        }

        hasSelfParticipant = true;
        return [{ name: selfParticipantName }];
      }

      const resolvedContactId = sameAsParticipantsByName.get(normalizedName);

      if (resolvedContactId) {
        return [{ contact_id: resolvedContactId, name }];
      }

      const candidates = unsureCandidatesByName.get(normalizedName);

      return [candidates?.length ? { name, candidates } : { name }];
    }),
  };

  if (event.location) {
    payload.location = event.location;
  }

  if (event.agenda) {
    payload.agenda = event.agenda;
  }

  const duplicate = findDuplicateMeeting(payload, existingMeetings);
  if (duplicate) {
    payload = mergeDuplicateMeetingPayload(duplicate, payload);
    payload.duplicate_of_meeting_id = duplicate.id;
    payload.changes = buildMeetingChanges(duplicate, payload);
  }

  return {
    type: 'create_meeting',
    payload,
    confidence: event.confidence,
    source_quote: event.source_quote,
  };
}

function buildMeetingProgressCards(
  existingMeetings: ExistingMeeting[],
  resolutions: MeetingProgressResolution[],
): ProposedCard[] {
  const meetingsById = new Map(existingMeetings.map((meeting) => [meeting.id, meeting]));
  const fragmentsByMeeting = new Map<number, MeetingProgressResolution['fragments']>();

  for (const resolution of resolutions) {
    if (!meetingsById.has(resolution.meeting_id)) {
      continue;
    }

    const fragments = fragmentsByMeeting.get(resolution.meeting_id) ?? [];
    fragments.push(...resolution.fragments);
    fragmentsByMeeting.set(resolution.meeting_id, fragments);
  }

  const cards: ProposedCard[] = [];

  for (const [meetingId, fragments] of fragmentsByMeeting) {
    const existing = meetingsById.get(meetingId)!;
    const additions = dedupeStrings(fragments.map((fragment) => fragment.content)).filter(
      (addition) => appendMeetingAgenda(existing.agenda, [addition]) !== normalizeMeetingChangeValue(existing.agenda),
    );

    if (additions.length === 0) {
      continue;
    }

    const agendaAppend = additions.join('；');
    const nextAgenda = appendMeetingAgenda(existing.agenda, additions);
    const payload: CreateMeetingPayload = {
      kind: existing.kind,
      title: existing.title,
      time_iso: existing.time_iso,
      time_text: existing.time_text,
      ...(existing.location ? { location: existing.location } : {}),
      participants: existing.participants.map((participant) => ({ ...participant })),
      ...(nextAgenda ? { agenda: nextAgenda } : {}),
      agenda_append: agendaAppend,
      duplicate_of_meeting_id: existing.id,
      changes: {},
    };
    payload.changes = buildMeetingChanges(existing, payload);
    cards.push({
      type: 'create_meeting',
      payload,
      confidence: 'high',
      source_quote: joinSourceQuotes(fragments.map((fragment) => fragment.source_quote)),
    });
  }

  return cards;
}

function buildSameAsParticipantsByName(
  resolutions: ParticipantResolution[],
): Map<string, number | null> {
  const mapping = new Map<string, number | null>();

  for (const resolution of resolutions) {
    const current = mapping.get(resolution.normalized_name);

    if (resolution.status !== 'same_as') {
      mapping.set(resolution.normalized_name, null);
      continue;
    }

    if (current === undefined) {
      mapping.set(resolution.normalized_name, resolution.contact_id);
      continue;
    }

    if (current !== resolution.contact_id) {
      mapping.set(resolution.normalized_name, null);
    }
  }

  return mapping;
}

function buildUnsureCandidatesByName(
  resolutions: ParticipantResolution[],
  contactsById: Map<number, ResolvableContact>,
): Map<string, ContactCandidate[] | null> {
  const mapping = new Map<string, ContactCandidate[] | null>();

  for (const resolution of resolutions) {
    const candidates = resolution.status === 'unsure'
      ? resolution.candidate_ids
        .map((candidateId) => contactsById.get(candidateId))
        .filter((contact): contact is ResolvableContact => Boolean(contact))
        .map((contact) => ({
          contact_id: contact.id,
          name: contact.canonical_name,
          company: contact.company ?? null,
        }))
      : null;

    if (!mapping.has(resolution.normalized_name)) {
      mapping.set(resolution.normalized_name, candidates);
      continue;
    }

    const current = mapping.get(resolution.normalized_name);
    if (current == null || candidates == null) {
      mapping.set(resolution.normalized_name, null);
      continue;
    }

    const currentIds = new Set(current.map((candidate) => candidate.contact_id));
    const candidateIds = new Set(candidates.map((candidate) => candidate.contact_id));
    if (
      currentIds.size !== candidateIds.size ||
      Array.from(currentIds).some((candidateId) => !candidateIds.has(candidateId))
    ) {
      mapping.set(resolution.normalized_name, null);
    }
  }

  return mapping;
}

function alignParticipantResolutions(
  participants: ProposeParticipant[],
  resolutions: ParticipantResolution[],
): Array<ParticipantResolution | undefined> {
  if (resolutions.length === participants.length) {
    return resolutions;
  }

  const nonSelfParticipants = participants.filter((participant) => !isSelfParticipant(participant));

  if (resolutions.length !== nonSelfParticipants.length) {
    throw new Error('resolutions must align with extraction.participants');
  }

  const aligned: Array<ParticipantResolution | undefined> = [];
  let resolutionIndex = 0;

  for (const participant of participants) {
    if (isSelfParticipant(participant)) {
      aligned.push(undefined);
      continue;
    }

    aligned.push(resolutions[resolutionIndex]);
    resolutionIndex += 1;
  }

  return aligned;
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const absoluteMonthDayPattern = /(?:(\d{4}|[〇零一二三四五六七八九]{4})年)?(?:\d{1,2}|[〇零一二两三四五六七八九十]{1,3})月(?:\d{1,2}|[〇零一二两三四五六七八九十]{1,3})(?:日|号)/u;
const chineseYearDigitMap: Record<string, string> = {
  '〇': '0',
  '零': '0',
  '一': '1',
  '二': '2',
  '三': '3',
  '四': '4',
  '五': '5',
  '六': '6',
  '七': '7',
  '八': '8',
  '九': '9',
};
const meetingNoticePrefixes = ['通知', '告知', '转发', '提醒'] as const;
const meetingNoticeSignals = ['会议时间', '时间调整', '时间变更', '改到', '改为'] as const;
const timelessCommunicationSignals = ['确认', '对接', '沟通', '联系'] as const;

function isMeetingNoticeEvent(event: ProposeEvent): boolean {
  if (event.kind !== 'other') {
    return false;
  }

  const values = [event.title, event.source_quote].map(normalizeMeetingTitle);

  return values.some((value) => (
    meetingNoticePrefixes.some((prefix) => value.startsWith(prefix)) ||
    meetingNoticeSignals.some((signal) => value.includes(signal))
  ));
}

function isTimelessCommunicationEvent(event: ProposeEvent): boolean {
  if (
    event.kind !== 'other' ||
    event.has_time_signal !== false ||
    normalizeOptionalText(event.location)
  ) {
    return false;
  }

  const normalizedTitle = normalizeMeetingTitle(event.title);
  return timelessCommunicationSignals.some((signal) => normalizedTitle.includes(signal));
}

type MeetingNoticeCandidate = {
  title: string;
  time_iso: string | null;
  time_text: string;
  participantNames: string[];
};

function normalizeChineseTimeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/礼拜/gu, '星期')
    .replace(/週/gu, '周')
    .replace(/\s+/gu, '');
}

function normalizeBatchOtherTimeText(value: string): string {
  return normalizeContactText(normalizeChineseTimeText(value));
}

export function dedupeBatchOtherCards(
  cards: ProposedCard[],
  priorCards: readonly BatchOtherCardReference[],
): { cards: ProposedCard[]; matches: BatchOtherDedupMatch[] } {
  const candidates = priorCards.filter(
    (card) => card.status === 'pending' || card.status === 'rejected',
  );
  const matches: BatchOtherDedupMatch[] = [];
  const retainedCards = cards.filter((card) => {
    if (card.type !== 'create_meeting' || card.payload.kind !== 'other') {
      return true;
    }

    const normalizedSourceQuote = normalizeContactText(card.source_quote);
    const normalizedTimeText = normalizeBatchOtherTimeText(card.payload.time_text);
    const match = candidates
      .map((candidate) => ({
        candidate,
        similarity: normalizedEditSimilarity(
          normalizedSourceQuote,
          normalizeContactText(candidate.source_quote),
        ),
      }))
      .find(({ candidate, similarity }) => (
        similarity >= BATCH_OTHER_DEDUP_RULES.sourceQuoteSimilarityThreshold &&
        normalizeBatchOtherTimeText(candidate.time_text) === normalizedTimeText
      ));

    if (!match) {
      return true;
    }

    matches.push({
      title: card.payload.title,
      matched_card_id: match.candidate.card_id,
      similarity: match.similarity,
      time_iso: card.payload.time_iso,
      time_text: card.payload.time_text,
      ...(card.payload.agenda ? { agenda: card.payload.agenda } : {}),
    });
    return false;
  });

  return { cards: retainedCards, matches };
}

function buildAbsoluteDateAnchor(explicitYearToken: string | undefined, now: Date): Date {
  const currentYear = Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(now));
  const absoluteYear = explicitYearToken
    ? Number(Array.from(explicitYearToken, (digit) => chineseYearDigitMap[digit] ?? digit).join(''))
    : currentYear;

  return new Date(`${absoluteYear}-01-01T00:00:00+08:00`);
}

function meetingCalendarDay(
  reference: Pick<MeetingNoticeCandidate, 'time_iso' | 'time_text'>,
  now: Date,
): string | null {
  const isoDay = calendarDay(reference.time_iso);
  if (isoDay) {
    return isoDay;
  }

  const normalizedTimeText = normalizeChineseTimeText(reference.time_text);
  const absoluteDateMatch = normalizedTimeText.match(absoluteMonthDayPattern);
  if (!absoluteDateMatch) {
    return null;
  }

  return calendarDay(resolveChineseTime(
    absoluteDateMatch[0],
    buildAbsoluteDateAnchor(absoluteDateMatch[1], now),
  ));
}

function normalizeMeetingParticipantName(
  name: string,
  selfParticipantNames: ReadonlySet<string>,
): string {
  return selfParticipantNames.has(normalizeSelfName(name))
    ? selfParticipantName
    : normalizeComparableText(name);
}

function findMeetingNoticeCandidate<T>(
  notice: ProposeEvent,
  candidates: T[],
  toCandidate: (candidate: T) => MeetingNoticeCandidate,
  now: Date,
  selfParticipantNames: ReadonlySet<string>,
  options: { allowTimelessParticipantMatch?: boolean } = {},
): T | undefined {
  const normalizedNoticeTitle = normalizeMeetingTitle(notice.title);
  const titleMatches = candidates.filter((candidate) => {
    const normalizedCandidateTitle = normalizeMeetingTitle(toCandidate(candidate).title);
    return normalizedEditSimilarity(normalizedNoticeTitle, normalizedCandidateTitle) >=
      MEETING_DUPLICATE_RULES.similarTitleThreshold;
  });

  if (titleMatches.length !== 0) {
    return titleMatches.length === 1 ? titleMatches[0] : undefined;
  }

  const noticeDay = meetingCalendarDay(notice, now);
  if (!noticeDay && !options.allowTimelessParticipantMatch) {
    return undefined;
  }

  const noticeParticipantNames = new Set(
    notice.participant_names
      .map((name) => normalizeMeetingParticipantName(name, selfParticipantNames))
      .filter(Boolean),
  );
  if (noticeParticipantNames.size === 0) {
    return undefined;
  }

  const contextMatches = candidates.filter((candidate) => {
    const reference = toCandidate(candidate);
    return (!noticeDay || meetingCalendarDay(reference, now) === noticeDay) &&
      reference.participantNames.some((name) =>
        noticeParticipantNames.has(
          normalizeMeetingParticipantName(name, selfParticipantNames),
        ));
  });

  return contextMatches.length === 1 ? contextMatches[0] : undefined;
}

function meetingEventPayload(event: ProposeEvent): CreateMeetingPayload {
  return {
    kind: event.kind,
    title: event.title,
    time_iso: event.time_iso,
    time_text: event.time_text,
    participants: event.participant_names.map((name) => ({ name })),
    ...(event.location ? { location: event.location } : {}),
    ...(event.agenda ? { agenda: event.agenda } : {}),
  };
}

function routeSpecialOtherEvents(
  events: ProposeEvent[],
  existingMeetings: ExistingMeeting[],
  meetingProgressResolutions: MeetingProgressResolution[],
  now: Date,
  selfParticipantNames: ReadonlySet<string>,
): {
  events: ProposeEvent[];
  meetingProgressResolutions: MeetingProgressResolution[];
  noticeRouting: NoticeRouting[];
} {
  const routedEvents = events.map((event) => ({ ...event }));
  const discardedIndexes = new Set<number>();
  const discardedSourceQuotes = new Set<string>();
  const noticeProgressResolutions: MeetingProgressResolution[] = [];
  const noticeRouting: NoticeRouting[] = [];
  const storedMeetingCandidates = existingMeetings.filter((meeting) => meeting.kind === 'meeting');
  const batchMeetingIndexes = routedEvents
    .map((event, index) => event.kind === 'meeting' ? index : -1)
    .filter((index) => index !== -1);

  for (const [index, event] of events.entries()) {
    if (!isMeetingNoticeEvent(event)) {
      if (isTimelessCommunicationEvent(event)) {
        discardedIndexes.add(index);
        discardedSourceQuotes.add(event.source_quote.trim());
        noticeRouting.push({
          title: event.title,
          decision: 'timeless_dropped',
        });
      }
      continue;
    }

    discardedIndexes.add(index);
    discardedSourceQuotes.add(event.source_quote.trim());
    const storedTarget = findMeetingNoticeCandidate(
      event,
      storedMeetingCandidates,
      (meeting) => ({
        title: meeting.title,
        time_iso: meeting.time_iso,
        time_text: meeting.time_text,
        participantNames: meeting.participants.map((participant) => participant.name),
      }),
      now,
      selfParticipantNames,
    );

    if (storedTarget) {
      noticeRouting.push({
        title: event.title,
        decision: 'stored',
        target_title: storedTarget.title,
      });
      noticeProgressResolutions.push({
        meeting_id: storedTarget.id,
        fragments: [{ content: event.source_quote, source_quote: event.source_quote }],
      });
      continue;
    }

    const batchTargetIndex = findMeetingNoticeCandidate(
      event,
      batchMeetingIndexes,
      (candidateIndex) => {
        const candidate = routedEvents[candidateIndex];
        return {
          title: candidate.title,
          time_iso: candidate.time_iso,
          time_text: candidate.time_text,
          participantNames: candidate.participant_names,
        };
      },
      now,
      selfParticipantNames,
      { allowTimelessParticipantMatch: true },
    );

    if (batchTargetIndex == null) {
      noticeRouting.push({
        title: event.title,
        decision: 'dropped',
      });
      continue;
    }

    const batchTarget = routedEvents[batchTargetIndex];
    noticeRouting.push({
      title: event.title,
      decision: 'batch',
      target_title: batchTarget.title,
    });
    const duplicate = findDuplicateMeeting(meetingEventPayload(batchTarget), existingMeetings);

    if (duplicate) {
      noticeProgressResolutions.push({
        meeting_id: duplicate.id,
        fragments: [{ content: event.source_quote, source_quote: event.source_quote }],
      });
      continue;
    }

    const agenda = appendMeetingAgenda(batchTarget.agenda, [event.source_quote]);
    routedEvents[batchTargetIndex] = {
      ...batchTarget,
      ...(agenda ? { agenda } : {}),
      source_quote: joinSourceQuotes([batchTarget.source_quote, event.source_quote]),
    };
  }

  const splitEvidenceLabel = (value: string): { label: string | null; content: string } => {
    const match = value.match(/^([^:：\n\d]{1,20})[:：]\s*(.*)$/u);

    return match
      ? { label: normalizeContactText(match[1]), content: normalizeContactText(match[2]) }
      : { label: null, content: normalizeContactText(value) };
  };
  const discardedEvidence = [...discardedSourceQuotes]
    .map((sourceQuote) => ({
      normalized: normalizeContactText(sourceQuote),
      ...splitEvidenceLabel(sourceQuote),
    }))
    .filter((evidence) => evidence.normalized.length > 0);
  const isDiscardedSourceQuote = (sourceQuote: string): boolean => {
    const normalizedSourceQuote = normalizeContactText(sourceQuote);
    const sourceEvidence = splitEvidenceLabel(sourceQuote);

    return discardedEvidence.some((evidence) => {
      if (
        normalizedSourceQuote === evidence.normalized ||
        (
          sourceEvidence.content.length > 0 &&
          sourceEvidence.content === evidence.content &&
          (sourceEvidence.label === null || evidence.label === null)
        )
      ) {
        return true;
      }

      const shorterLength = Math.min(
        Array.from(normalizedSourceQuote).length,
        Array.from(evidence.normalized).length,
      );
      return shorterLength >= 4 && (
        normalizedSourceQuote.includes(evidence.normalized) ||
        evidence.normalized.includes(normalizedSourceQuote)
      );
    });
  };
  const retainedProgressResolutions = meetingProgressResolutions
    .map((resolution) => ({
      ...resolution,
      fragments: resolution.fragments.filter(
        (fragment) => !isDiscardedSourceQuote(fragment.source_quote),
      ),
    }))
    .filter((resolution) => resolution.fragments.length > 0);

  return {
    events: routedEvents.filter((_event, index) => !discardedIndexes.has(index)),
    meetingProgressResolutions: [
      ...retainedProgressResolutions,
      ...noticeProgressResolutions,
    ],
    noticeRouting,
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isPureAcknowledgement(value: string): boolean {
  const normalized = value.replace(acknowledgementNoisePattern, '');

  return codePointLength(normalized) <= 2 || pureAcknowledgementTexts.has(normalized);
}

const participantPrefixSeparatorPattern = /[\p{P}\p{White_Space}]/u;

function stripParticipantPrefix(
  fragment: string,
  participant: { name: string; aliases?: string[] },
): string {
  const identifiers = [participant.name, ...(participant.aliases ?? [])].filter(
    (identifier): identifier is string => Boolean(identifier),
  );

  let cutEnd = -1;

  for (const identifier of identifiers) {
    const lastIndex = fragment.lastIndexOf(identifier);

    if (lastIndex === -1) {
      continue;
    }

    const matchEnd = lastIndex + identifier.length;
    const nextChar = fragment.charAt(matchEnd);

    // Only treat the match as a label prefix (OCR sender/department tag) when it is
    // followed by a genuine separator. Without this, a name that is itself the tail of
    // real content (e.g. a self-introduction ending in the speaker's own name) or the
    // head of a short substantive remark (e.g. "荀导已到") would be misread as a bare
    // nickname line and wrongly cut down to nothing.
    if (!nextChar || !participantPrefixSeparatorPattern.test(nextChar)) {
      continue;
    }

    cutEnd = Math.max(cutEnd, matchEnd);
  }

  return cutEnd === -1 ? fragment : fragment.slice(cutEnd);
}

// An "@name" mention inside a fragment means someone else addressed this participant in
// that message; it is not evidence of what the participant themselves said. Scan every
// "@" occurrence (skipping whitespace right after it, e.g. "@ 柏贝") and check whether the
// participant's own name or any alias starts right there.
function containsAtMentionOfParticipant(
  fragment: string,
  participant: { name: string; aliases?: string[] },
): boolean {
  const identifiers = [participant.name, ...(participant.aliases ?? [])].filter(
    (identifier): identifier is string => Boolean(identifier),
  );

  if (identifiers.length === 0) {
    return false;
  }

  let atIndex = fragment.indexOf('@');

  while (atIndex !== -1) {
    let cursor = atIndex + 1;

    while (cursor < fragment.length && /\s/u.test(fragment.charAt(cursor))) {
      cursor += 1;
    }

    const remainder = fragment.slice(cursor);

    if (identifiers.some((identifier) => remainder.startsWith(identifier))) {
      return true;
    }

    atIndex = fragment.indexOf('@', atIndex + 1);
  }

  return false;
}

function shouldSkipMentionedContactCreation(
  participant: ProposeParticipant,
  relatedFacts: PerceptionFact[] | undefined,
): boolean {
  if (participant.role !== 'mentioned') {
    return false;
  }

  const normalizedName = normalizeContactText(participant.name);
  const isGenericName = genericMentionNames.has(normalizedName);
  const isOrganizationName = codePointLength(normalizedName) >= 3 &&
    organizationMentionSuffixes.some((suffix) => normalizedName.endsWith(suffix));
  const hasIdentityField = [
    participant.company,
    participant.title,
    participant.phone,
    participant.wechat_id,
    ...(participant.aliases ?? []),
  ].some((value) => Boolean(normalizeOptionalText(value)));

  return isGenericName || isOrganizationName || (
    !hasIdentityField && (relatedFacts?.length ?? 0) === 0
  );
}

function isComposedOfTokens(value: string, tokens: string[]): boolean {
  if (!value || tokens.length === 0) {
    return false;
  }

  const reachableOffsets = new Set([0]);

  for (let offset = 0; offset < value.length; offset += 1) {
    if (!reachableOffsets.has(offset)) {
      continue;
    }

    for (const token of tokens) {
      if (value.startsWith(token, offset)) {
        reachableOffsets.add(offset + token.length);
      }
    }
  }

  return reachableOffsets.has(value.length);
}

function isDerivedAlias(
  alias: string,
  contact: Pick<ResolvableContact, 'canonical_name' | 'aliases' | 'company' | 'title'>,
  proposed: Pick<CreateContactPayload, 'company' | 'title'>,
  libraryFieldValues: string[] = [],
): boolean {
  const normalizedAlias = normalizeContactText(alias);
  const knownNames = [contact.canonical_name, ...contact.aliases]
    .map(normalizeContactText)
    .filter(Boolean);

  if (!normalizedAlias || knownNames.includes(normalizedAlias)) {
    return true;
  }

  const canonicalName = normalizeContactText(contact.canonical_name);
  if (
    codePointLength(normalizedAlias) === 2 &&
    !normalizedAlias.includes(canonicalName)
  ) {
    return false;
  }

  const rawFieldValues = [
    contact.company,
    contact.title,
    proposed.company,
    proposed.title,
    ...libraryFieldValues,
  ].filter((value): value is string => Boolean(value));
  const fieldValues = Array.from(new Set(
    rawFieldValues
      .map(normalizeContactText)
      .filter(Boolean),
  ));
  const fieldTokens = Array.from(new Set(
    rawFieldValues
      .flatMap(tokenize)
      .map(normalizeContactText)
      .filter(Boolean),
  ));

  if (isComposedOfTokens(normalizedAlias, fieldTokens)) {
    return true;
  }

  return knownNames.some((knownName) => {
    let remainder: string | undefined;

    if (normalizedAlias.startsWith(knownName)) {
      remainder = normalizedAlias.slice(knownName.length);
    } else if (normalizedAlias.endsWith(knownName)) {
      remainder = normalizedAlias.slice(0, -knownName.length);
    }

    if (remainder == null) {
      return false;
    }

    const remainderLength = codePointLength(remainder);

    if (remainderLength === 0) {
      return false;
    }

    return (
      isComposedOfTokens(remainder, fieldTokens) ||
      fieldValues.some((fieldValue) => {
        const fieldValueLength = codePointLength(fieldValue);

        return (
          fieldValue.includes(remainder) ||
          (remainderLength >= 3 && editDistance(remainder, fieldValue) === 1) ||
          (
            remainder.includes(fieldValue) &&
            remainderLength - fieldValueLength === 1
          )
        );
      })
    );
  });
}

function isRedundantFieldValue(current: string, next: string): boolean {
  const normalizedCurrent = normalizeContactText(current);
  const normalizedNext = normalizeContactText(next);

  if (normalizedCurrent === normalizedNext) {
    return true;
  }

  if (!normalizedCurrent || !normalizedNext) {
    return false;
  }

  const currentLength = codePointLength(normalizedCurrent);
  const nextLength = codePointLength(normalizedNext);

  if (nextLength > currentLength && normalizedNext.includes(normalizedCurrent)) {
    return false;
  }

  if (normalizedCurrent.includes(normalizedNext)) {
    return true;
  }

  const currentTokens = new Set(tokenize(current));
  const nextTokens = tokenize(next);

  if (nextTokens.length > 0 && nextTokens.every((token) => currentTokens.has(token))) {
    return true;
  }

  if (editDistance(normalizedCurrent, normalizedNext) !== 1 || nextLength < 3) {
    return false;
  }

  return nextLength !== 3 || currentLength === nextLength;
}

function buildContactChanges(
  contact: ResolvableContact,
  payload: CreateContactPayload,
  aliasCandidates: string[],
  libraryFieldValues: string[] = [],
): UpdateContactPayload['changes'] {
  const changes: UpdateContactPayload['changes'] = {};
  const aliasAdditions = dedupeStrings(aliasCandidates).filter(
    (alias) => !isDerivedAlias(alias, contact, payload, libraryFieldValues),
  );

  if (aliasAdditions.length > 0) {
    changes.aliases = {
      old: contact.aliases.length > 0 ? contact.aliases.join('，') : null,
      new: aliasAdditions.join('，'),
    };
  }

  for (const field of trackedContactFields) {
    const nextValue = normalizeOptionalText(payload[field]);

    if (!nextValue) {
      continue;
    }

    const currentValue = normalizeOptionalText(contact[field]);

    if (
      currentValue === nextValue ||
      (
        currentValue &&
        (field === 'company' || field === 'title') &&
        isRedundantFieldValue(currentValue, nextValue)
      )
    ) {
      continue;
    }

    changes[field] = {
      old: contact[field] ?? null,
      new: nextValue,
    };
  }

  return changes;
}

function cjkLetterRatio(value: string): number {
  const letters = value.match(/\p{L}/gu) ?? [];

  if (letters.length === 0) {
    return 0;
  }

  const cjkLetters = letters.filter((letter) => (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(letter)
  ));

  return cjkLetters.length / letters.length;
}

function buildInteractionPayload(
  participantName: string,
  contact: ResolvableContact | undefined,
  participantSourceQuotes: string[],
  interactionSummaries: string[],
  relatedFacts: PerceptionFact[] | undefined,
  relatedQuotes: PerceptionQuote[] | undefined,
): { payload: RecordInteractionPayload; sourceQuote: string } {
  const preferredSummary = dedupeStrings(interactionSummaries).join('；');
  const fallbackFragments = dedupeStrings([
    participantSourceQuotes.join('；'),
    ...((relatedQuotes ?? []).map((quote) => quote.text)),
  ]);
  const useFallback = !preferredSummary || (
    cjkLetterRatio(fallbackFragments.join('；')) >= 0.5 &&
    cjkLetterRatio(preferredSummary) < 0.3
  );
  const summaryFragments = useFallback ? fallbackFragments : [preferredSummary];

  return {
    payload: {
      ...(contact ? { contact_id: contact.id } : {}),
      contact_name: contact?.canonical_name ?? participantName,
      summary: summaryFragments.join('；'),
    },
    sourceQuote: joinSourceQuotes([
      ...participantSourceQuotes,
      ...((relatedFacts ?? []).map((fact) => fact.source_quote)),
      ...((relatedQuotes ?? []).map((quote) => quote.source_quote)),
    ]),
  };
}

function mergeConfidence(values: CardConfidence[]): CardConfidence {
  if (values.includes('high')) {
    return 'high';
  }

  if (values.includes('medium')) {
    return 'medium';
  }

  return 'low';
}

function proposeCardsInternal(
  extraction: PerceptionResult,
  resolutions?: ParticipantResolution[],
  contacts: ResolvableContact[] = [],
  now = new Date(),
  existingMeetings: ExistingMeeting[] = [],
  meetingProgressResolutions: MeetingProgressResolution[] = [],
  noticeRoutingOutput: NoticeRouting[] = [],
): ProposedCard[] {
  const cards: ProposedCard[] = [];
  const participants = extraction.participants as ProposeParticipant[];
  const libraryFieldValues = dedupeStrings(contacts.flatMap((contact) => [
    contact.company ?? undefined,
    contact.title ?? undefined,
  ]));
  // Only an explicit month/day permits deterministic local resolution. Relative-only text stays with the model value, which the prompt requires to be null.
  const normalizedEvents = (extraction.events as ProposeEvent[]).map((event) => {
    const timeText = normalizeOptionalText(event.time_text);

    if (!timeText) {
      return event;
    }

    const normalizedTimeText = normalizeChineseTimeText(timeText);
    const absoluteDateMatch = normalizedTimeText.match(absoluteMonthDayPattern);

    if (!absoluteDateMatch) {
      return event;
    }

    const absoluteTimeText = normalizedTimeText
      .slice(absoluteDateMatch.index ?? 0)
      .replace(
        /\s*(?:\(\s*)?(?:周|星期)[一二三四五六日天末1-7](?:\s*\))?/gu,
        '',
      );
    const hasExplicitClockTime = /(?:\d{1,2}:\d{1,2}|[0-9〇零一二两三四五六七八九十]{1,4}(?:点|时)(?:半|[0-9〇零一二两三四五六七八九十]{1,4}分?)?)/u
      .test(absoluteTimeText);

    if (!hasExplicitClockTime) {
      return {
        ...event,
        time_iso: null,
      };
    }
    const absoluteAnchor = buildAbsoluteDateAnchor(absoluteDateMatch[1], now);

    return {
      ...event,
      time_iso: resolveChineseTime(absoluteTimeText, absoluteAnchor) ?? event.time_iso,
    };
  });
  const selfParticipantNames = buildSelfParticipantNames(participants);
  const {
    events,
    meetingProgressResolutions: routedMeetingProgressResolutions,
    noticeRouting,
  } = routeSpecialOtherEvents(
    normalizedEvents,
    existingMeetings,
    meetingProgressResolutions,
    now,
    selfParticipantNames,
  );
  noticeRoutingOutput.push(...noticeRouting);
  const factsBySubject = indexFactsBySubject(extraction.facts);
  const quotesBySpeaker = indexQuotesBySpeaker(extraction.quotes);

  if (!resolutions) {
    for (const participant of participants) {
      if (isSelfParticipant(participant)) {
        continue;
      }

      const relatedFacts = factsBySubject.get(normalizeComparableText(participant.name));

      if (shouldSkipMentionedContactCreation(participant, relatedFacts)) {
        continue;
      }

      const draft = buildCreateContactPayload(participant, relatedFacts, libraryFieldValues);

      cards.push({
        type: 'create_contact',
        payload: draft.payload,
        confidence: participant.confidence,
        source_quote: draft.sourceQuote,
      });
    }

    for (const event of events) {
      cards.push(buildMeetingCard(event, new Map(), new Map(), selfParticipantNames, existingMeetings));
    }

    cards.push(...buildMeetingProgressCards(existingMeetings, routedMeetingProgressResolutions));

    // simplified: keep the legacy M1 flow stable until execute/schema catches up with M2 cards.
    return cards;
  }

  const contactsById = new Map<number, ResolvableContact>(
    contacts.map((contact) => [contact.id, contact]),
  );
  const alignedResolutions = alignParticipantResolutions(participants, resolutions);
  const sameAsParticipantsByName = buildSameAsParticipantsByName(resolutions);
  const unsureCandidatesByName = buildUnsureCandidatesByName(resolutions, contactsById);
  const interactionCandidates = new Map<
    string,
    {
      participantName: string;
      contact?: ResolvableContact;
      confidence: CardConfidence[];
      relatedFacts: PerceptionFact[];
      relatedQuotes: PerceptionQuote[];
      participantSourceQuotes: string[];
      interactionSummaries: string[];
      requiresCreateCard: boolean;
    }
  >();

  for (const [index, participant] of participants.entries()) {
    if (isSelfParticipant(participant)) {
      continue;
    }

    const resolution = alignedResolutions[index];

    if (!resolution) {
      throw new Error('resolutions must align with extraction.participants');
    }

    const relatedFacts =
      factsBySubject.get(normalizeComparableText(participant.name)) ?? [];
    const relatedQuotes =
      quotesBySpeaker.get(normalizeComparableText(participant.name)) ?? [];
    const draft = buildCreateContactPayload(participant, relatedFacts, libraryFieldValues);
    if (participant.role !== 'mentioned' && participant.speech_act !== 'respond') {
      const interactionKey =
        resolution.status === 'same_as'
          ? `contact:${resolution.contact_id}`
          : `pending:${resolution.normalized_name}`;
      // An OCR label line that is really someone else "@"-ing this participant (e.g. a
      // notifier's broadcast "@柏贝@沈青岚...") is not this participant's own evidence.
      const isOwnSourceQuote = !containsAtMentionOfParticipant(participant.source_quote, participant);

      if (!interactionCandidates.has(interactionKey)) {
        interactionCandidates.set(interactionKey, {
          participantName: participant.name,
          contact:
            resolution.status === 'same_as'
              ? contactsById.get(resolution.contact_id)
              : undefined,
          confidence: [participant.confidence],
          relatedFacts: [...relatedFacts],
          relatedQuotes: [...relatedQuotes],
          participantSourceQuotes: isOwnSourceQuote ? [participant.source_quote] : [],
          interactionSummaries: dedupeStrings([participant.interaction_summary]),
          requiresCreateCard: resolution.status !== 'same_as',
        });
      } else {
        const existing = interactionCandidates.get(interactionKey)!;
        existing.confidence.push(participant.confidence);
        existing.relatedFacts.push(...relatedFacts);
        existing.relatedQuotes.push(...relatedQuotes);
        if (isOwnSourceQuote) {
          existing.participantSourceQuotes.push(participant.source_quote);
        }
        existing.interactionSummaries.push(...dedupeStrings([participant.interaction_summary]));
      }
    }

    if (resolution.status === 'same_as') {
      const contact = contactsById.get(resolution.contact_id);

      if (!contact) {
        throw new Error(`Missing contact ${resolution.contact_id} for same_as resolution`);
      }

      const changes = buildContactChanges(
        contact,
        draft.payload,
        [participant.name, ...(participant.aliases ?? [])],
        libraryFieldValues,
      );

      if (Object.keys(changes).length === 0) {
        continue;
      }

      cards.push({
        type: 'update_contact',
        payload: {
          contact_id: contact.id,
          contact_name: contact.canonical_name,
          changes,
        },
        confidence: participant.confidence,
        source_quote: draft.sourceQuote,
      });
      continue;
    }

    if (shouldSkipMentionedContactCreation(participant, relatedFacts)) {
      continue;
    }

    const createCard: Extract<ActionCard, { type: 'create_contact' }> = {
      type: 'create_contact',
      payload: draft.payload,
      confidence: participant.confidence,
      source_quote: draft.sourceQuote,
    };

    if (resolution.status === 'unsure') {
      createCard.disambiguation = {
        candidates: resolution.candidate_ids
          .map((candidateId) => contactsById.get(candidateId))
          .filter((contact): contact is ResolvableContact => Boolean(contact))
          .map((contact) => ({
            contact_id: contact.id,
            name: contact.canonical_name,
            company: contact.company ?? null,
          })),
      };
    }

    cards.push(createCard);
  }

  for (const event of events) {
    cards.push(
      buildMeetingCard(
        event,
        sameAsParticipantsByName,
        unsureCandidatesByName,
        selfParticipantNames,
        existingMeetings,
      ),
    );
  }

  cards.push(...buildMeetingProgressCards(existingMeetings, routedMeetingProgressResolutions));

  for (const [interactionKey, candidate] of interactionCandidates) {
    if (candidate.requiresCreateCard && !interactionKey.startsWith('pending:')) {
      continue;
    }

    if (candidate.requiresCreateCard && !cards.some((card) => {
      if (card.type !== 'create_contact') {
        return false;
      }

      return normalizeComparableText(card.payload.name) === normalizeComparableText(candidate.participantName);
    })) {
      continue;
    }

    // Quotes are the model's citation of what the participant actually said, so they take
    // priority over the raw OCR source-quote label line whenever any exist; the label line
    // (participantSourceQuotes) is only a fallback, and still needs the fix11 prefix strip.
    const sourceEvidence = candidate.relatedQuotes.length > 0
      ? dedupeStrings(candidate.relatedQuotes.map((quote) => quote.text))
      : dedupeStrings(
          candidate.participantSourceQuotes.map((fragment) =>
            stripParticipantPrefix(fragment, { name: candidate.participantName })),
        );

    if (sourceEvidence.length === 0 || sourceEvidence.every(isPureAcknowledgement)) {
      continue;
    }

    const interaction = buildInteractionPayload(
      candidate.participantName,
      candidate.contact,
      dedupeStrings(candidate.participantSourceQuotes),
      dedupeStrings(candidate.interactionSummaries),
      candidate.relatedFacts,
      candidate.relatedQuotes,
    );

    cards.push({
      type: 'record_interaction',
      payload: interaction.payload,
      confidence: mergeConfidence(candidate.confidence),
      source_quote: interaction.sourceQuote,
    });
  }

  return cards;
}

export function proposeCardsWithRouting(
  extraction: PerceptionResult,
  resolutions?: ParticipantResolution[],
  contacts: ResolvableContact[] = [],
  now = new Date(),
  existingMeetings: ExistingMeeting[] = [],
  meetingProgressResolutions: MeetingProgressResolution[] = [],
): ProposedCardsWithRouting {
  const noticeRouting: NoticeRouting[] = [];
  const cards = proposeCardsInternal(
    extraction,
    resolutions,
    contacts,
    now,
    existingMeetings,
    meetingProgressResolutions,
    noticeRouting,
  );

  return { cards, noticeRouting };
}

export function proposeCards(
  extraction: PerceptionResult,
  resolutions?: ParticipantResolution[],
  contacts: ResolvableContact[] = [],
  now = new Date(),
  existingMeetings: ExistingMeeting[] = [],
  meetingProgressResolutions: MeetingProgressResolution[] = [],
): ProposedCard[] {
  return proposeCardsWithRouting(
    extraction,
    resolutions,
    contacts,
    now,
    existingMeetings,
    meetingProgressResolutions,
  ).cards;
}
