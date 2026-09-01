import type {
  ActionCard,
  CreateContactPayload,
  CreateMeetingPayload,
  RecordInteractionPayload,
  UpdateContactPayload,
} from '../../types.ts';

import type { PerceptionResult } from './perceive.ts';
import type { ParticipantResolution, ResolvableContact } from './resolve.ts';
import { resolveChineseTime } from './resolve-time.ts';

export type CardConfidence = 'high' | 'medium' | 'low';

export type ProposedCard = ActionCard;

type PerceptionFact = PerceptionResult['facts'][number];
type PerceptionQuote = PerceptionResult['quotes'][number];
type ProposeParticipant = PerceptionResult['participants'][number] & { is_self?: boolean };
type ProposeEvent = PerceptionResult['events'][number] & { has_time_signal?: boolean };
type ContactField = 'company' | 'title' | 'phone' | 'wechat_id' | 'notes';

const selfParticipantName = '我';
const trackedContactFields: ContactField[] = ['company', 'title', 'phone', 'wechat_id', 'notes'];
const fieldLabels: Record<ContactField | 'alias', string> = {
  alias: '别名',
  company: '公司',
  title: '职位',
  phone: '电话',
  wechat_id: '微信',
  notes: '备注',
};

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

function normalizeComparableText(value: string): string {
  return value.trim().toLocaleLowerCase();
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
  const aliases = aliasMerge.values;

  const payload: CreateContactPayload = {
    name: participant.name,
  };

  if (aliases.length > 0) {
    payload.aliases = aliases;
  }

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
  selfParticipantNames: Set<string>,
): ProposedCard {
  const normalizedTimeIso = normalizeOptionalText(event.time_iso);

  const payload: CreateMeetingPayload = {
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

      return resolvedContactId ? { contact_id: resolvedContactId, name } : { name };
    }),
  };

  if (event.location) {
    payload.location = event.location;
  }

  if (event.agenda) {
    payload.agenda = event.agenda;
  }

  return {
    type: 'create_meeting',
    payload,
    confidence: event.confidence,
    source_quote: event.source_quote,
  };
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

function buildContactChanges(
  contact: ResolvableContact,
  payload: CreateContactPayload,
): UpdateContactPayload['changes'] {
  const changes: UpdateContactPayload['changes'] = {};

  for (const field of trackedContactFields) {
    const nextValue = normalizeOptionalText(payload[field]);

    if (!nextValue) {
      continue;
    }

    const currentValue = normalizeOptionalText(contact[field]);

    if (currentValue === nextValue) {
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
  createPayload: CreateContactPayload,
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
        ...(createPayload.aliases?.length
          ? [`${fieldLabels.alias} ${createPayload.aliases.join(' / ')}`]
          : []),
        ...trackedContactFields.flatMap((field) =>
          createPayload[field] ? [`${fieldLabels[field]} ${createPayload[field]}`] : [],
        ),
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
): ProposedCard[] {
  const cards: ProposedCard[] = [];
  const participants = extraction.participants as ProposeParticipant[];
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
      const draft = buildCreateContactPayload(participant, relatedFacts);

      cards.push({
        type: 'create_contact',
        payload: draft.payload,
        confidence: participant.confidence,
        source_quote: draft.sourceQuote,
      });
    }

    for (const event of events) {
      cards.push(buildMeetingCard(event, new Map(), selfParticipantNames));
    }

    // simplified: keep the legacy M1 flow stable until execute/schema catches up with M2 cards.
    return cards;
  }

  const contactsById = new Map<number, ResolvableContact>(
    contacts.map((contact) => [contact.id, contact]),
  );
  const alignedResolutions = alignParticipantResolutions(participants, resolutions);
  const sameAsParticipantsByName = buildSameAsParticipantsByName(resolutions);
  const interactionCandidates = new Map<
    string,
    {
      participantName: string;
      contact?: ResolvableContact;
      createPayload: CreateContactPayload;
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
    const draft = buildCreateContactPayload(participant, relatedFacts);
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
        createPayload: draft.payload,
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

      const changes = buildContactChanges(contact, draft.payload);

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
    cards.push(buildMeetingCard(event, sameAsParticipantsByName, selfParticipantNames));
  }

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
      candidate.createPayload,
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
