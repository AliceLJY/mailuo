import type {
  ActionCard,
  CreateContactPayload,
  CreateMeetingPayload,
  RecordInteractionPayload,
  UpdateContactPayload,
} from '../../../shared/types.ts';

import type { PerceptionResult } from './perceive.ts';
import type { ParticipantResolution, ResolvableContact } from './resolve.ts';

export type CardConfidence = 'high' | 'medium' | 'low';

export type ProposedCard = ActionCard;

type PerceptionFact = PerceptionResult['facts'][number];
type PerceptionQuote = PerceptionResult['quotes'][number];
type ContactField = 'company' | 'title' | 'phone' | 'wechat_id' | 'notes';

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

function buildCreateContactPayload(
  participant: PerceptionResult['participants'][number],
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
  const noteMerge = collectFactValues(
    [participant.notes],
    relatedFacts,
    (fact) => fact.field === 'notes' || fact.field === 'other',
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
  event: PerceptionResult['events'][number],
  sameAsParticipantsByName: Map<string, number | null>,
): ProposedCard | null {
  if (event.kind !== 'meeting' && event.kind !== 'appointment') {
    return null;
  }

  const payload: CreateMeetingPayload = {
    title: event.title,
    time_iso: event.time_iso,
    time_text: event.time_text,
    participants: event.participant_names.map((name) => {
      const normalizedName = normalizeComparableText(name);
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
  relatedFacts: PerceptionFact[] | undefined,
  relatedQuotes: PerceptionQuote[] | undefined,
): { payload: RecordInteractionPayload; sourceQuote: string } {
  const summaryFragments = dedupeStrings([
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
): ProposedCard[] {
  const cards: ProposedCard[] = [];
  const factsBySubject = indexFactsBySubject(extraction.facts);
  const quotesBySpeaker = indexQuotesBySpeaker(extraction.quotes);

  if (!resolutions) {
    for (const participant of extraction.participants) {
      const relatedFacts = factsBySubject.get(normalizeComparableText(participant.name));
      const draft = buildCreateContactPayload(participant, relatedFacts);

      cards.push({
        type: 'create_contact',
        payload: draft.payload,
        confidence: participant.confidence,
        source_quote: draft.sourceQuote,
      });
    }

    for (const event of extraction.events) {
      const meetingCard = buildMeetingCard(event, new Map());

      if (meetingCard) {
        cards.push(meetingCard);
      }
    }

    // simplified: keep the legacy M1 flow stable until execute/schema catches up with M2 cards.
    return cards;
  }

  if (resolutions.length !== extraction.participants.length) {
    throw new Error('resolutions must align with extraction.participants');
  }

  const contactsById = new Map<number, ResolvableContact>(
    contacts.map((contact) => [contact.id, contact]),
  );
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
      requiresCreateCard: boolean;
    }
  >();

  for (const [index, participant] of extraction.participants.entries()) {
    const resolution = resolutions[index];
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
        requiresCreateCard: resolution.status !== 'same_as',
      });
    } else {
      const existing = interactionCandidates.get(interactionKey)!;
      existing.confidence.push(participant.confidence);
      existing.relatedFacts.push(...relatedFacts);
      existing.relatedQuotes.push(...relatedQuotes);
      existing.participantSourceQuotes.push(participant.source_quote);
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

  for (const event of extraction.events) {
    const meetingCard = buildMeetingCard(event, sameAsParticipantsByName);

    if (meetingCard) {
      cards.push(meetingCard);
    }
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
