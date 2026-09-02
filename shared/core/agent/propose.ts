import {
  MEETING_CHANGE_FIELDS,
  type ActionCard,
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

import type { PerceptionResult } from './perceive.ts';
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
type ProposeParticipant = PerceptionResult['participants'][number] & { is_self?: boolean };
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

export const MEETING_DUPLICATE_RULES = {
  similarTitleThreshold: 0.9,
  minimumSimilarTitleLength: 8,
} as const;

const selfParticipantName = '我';
const trackedContactFields: ContactField[] = ['company', 'title', 'phone', 'wechat_id', 'notes'];

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
  return participant.is_self === true || normalizeComparableText(participant.name) === selfParticipantName;
}

function buildSelfParticipantNames(participants: ProposeParticipant[]): Set<string> {
  const normalizedNames = new Set<string>([selfParticipantName]);

  for (const participant of participants) {
    if (isSelfParticipant(participant)) {
      normalizedNames.add(normalizeComparableText(participant.name));
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

  let payload: CreateMeetingPayload = {
    kind: event.kind,
    title: event.title,
    time_iso: normalizedTimeIso ?? null,
    time_text: event.time_text.trim(),
    participants: event.participant_names.map((name) => {
      const normalizedName = normalizeComparableText(name);

      if (selfParticipantNames.has(normalizedName)) {
        return { name: selfParticipantName };
      }

      const resolvedContactId = sameAsParticipantsByName.get(normalizedName);

      if (resolvedContactId) {
        return { contact_id: resolvedContactId, name };
      }

      const candidates = unsureCandidatesByName.get(normalizedName);

      return candidates?.length ? { name, candidates } : { name };
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

function codePointLength(value: string): number {
  return Array.from(value).length;
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

function buildInteractionPayload(
  participantName: string,
  contact: ResolvableContact | undefined,
  participantSourceQuotes: string[],
  interactionSummaries: string[],
  relatedFacts: PerceptionFact[] | undefined,
  relatedQuotes: PerceptionQuote[] | undefined,
): { payload: RecordInteractionPayload; sourceQuote: string } {
  const preferredSummary = dedupeStrings(interactionSummaries).join('；');
  const summaryFragments = preferredSummary
    ? [preferredSummary]
    : dedupeStrings([
        participantSourceQuotes.join('；'),
        ...((relatedQuotes ?? []).map((quote) => quote.text)),
      ]);

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

export function proposeCards(
  extraction: PerceptionResult,
  resolutions?: ParticipantResolution[],
  contacts: ResolvableContact[] = [],
  now = new Date(),
  existingMeetings: ExistingMeeting[] = [],
  meetingProgressResolutions: MeetingProgressResolution[] = [],
): ProposedCard[] {
  const cards: ProposedCard[] = [];
  const participants = extraction.participants as ProposeParticipant[];
  const libraryFieldValues = dedupeStrings(contacts.flatMap((contact) => [
    contact.company ?? undefined,
    contact.title ?? undefined,
  ]));
  // Only an explicit month/day permits deterministic local resolution. Relative-only text stays with the model value, which the prompt requires to be null.
  const events = (extraction.events as ProposeEvent[]).map((event) => {
    const timeText = normalizeOptionalText(event.time_text);

    if (!timeText) {
      return event;
    }

    const normalizedTimeText = timeText
      .normalize('NFKC')
      .replace(/礼拜/gu, '星期')
      .replace(/週/gu, '周')
      .replace(/\s+/gu, '');
    const absoluteDateMatch = normalizedTimeText.match(
      /(?:(\d{4}|[〇零一二三四五六七八九]{4})年)?(?:\d{1,2}|[〇零一二两三四五六七八九十]{1,3})月(?:\d{1,2}|[〇零一二两三四五六七八九十]{1,3})(?:日|号)/u,
    );

    if (!absoluteDateMatch) {
      return event;
    }

    const currentYear = Number(new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
    }).format(now));
    const explicitYearToken = absoluteDateMatch[1];
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
    const absoluteYear = explicitYearToken
      ? Number(Array.from(explicitYearToken, (digit) => chineseYearDigitMap[digit] ?? digit).join(''))
      : currentYear;
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
    const absoluteAnchor = new Date(`${absoluteYear}-01-01T00:00:00+08:00`);

    return {
      ...event,
      time_iso: resolveChineseTime(absoluteTimeText, absoluteAnchor) ?? event.time_iso,
    };
  });
  const selfParticipantNames = buildSelfParticipantNames(participants);
  const factsBySubject = indexFactsBySubject(extraction.facts);
  const quotesBySpeaker = indexQuotesBySpeaker(extraction.quotes);

  if (!resolutions) {
    for (const participant of participants) {
      if (isSelfParticipant(participant)) {
        continue;
      }

      const relatedFacts = factsBySubject.get(normalizeComparableText(participant.name));
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

    cards.push(...buildMeetingProgressCards(existingMeetings, meetingProgressResolutions));

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
    const interactionKey =
      resolution.status === 'same_as'
        ? `contact:${resolution.contact_id}`
        : `pending:${resolution.normalized_name}`;

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
        participantSourceQuotes: [participant.source_quote],
        interactionSummaries: dedupeStrings([participant.interaction_summary]),
        requiresCreateCard: resolution.status !== 'same_as',
      });
    } else {
      const existing = interactionCandidates.get(interactionKey)!;
      existing.confidence.push(participant.confidence);
      existing.relatedFacts.push(...relatedFacts);
      existing.relatedQuotes.push(...relatedQuotes);
      existing.participantSourceQuotes.push(participant.source_quote);
      existing.interactionSummaries.push(...dedupeStrings([participant.interaction_summary]));
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

  cards.push(...buildMeetingProgressCards(existingMeetings, meetingProgressResolutions));

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
