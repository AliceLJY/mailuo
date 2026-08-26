import type {
  ActionCard,
  CreateContactPayload,
  CreateMeetingPayload,
} from '../../../shared/types.ts';

import type { PerceptionResult } from './perceive.ts';

export type CardConfidence = 'high' | 'medium' | 'low';

export type ProposedCard = Extract<ActionCard, { type: 'create_contact' | 'create_meeting' }>;

type PerceptionFact = PerceptionResult['facts'][number];

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
    const list = indexed.get(fact.subject_name) ?? [];
    list.push(fact);
    indexed.set(fact.subject_name, list);
  }

  return indexed;
}

function firstFact(
  facts: PerceptionFact[] | undefined,
  field: PerceptionFact['field'],
): PerceptionFact | undefined {
  return facts?.find((fact) => fact.field === field);
}

export function proposeCards(extraction: PerceptionResult): ProposedCard[] {
  const cards: ProposedCard[] = [];
  const factsBySubject = indexFactsBySubject(extraction.facts);

  for (const participant of extraction.participants) {
    const relatedFacts = factsBySubject.get(participant.name);
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

    const sourceQuote = joinSourceQuotes([
      participant.source_quote,
      ...aliasMerge.sourceQuotes,
      companyFact?.source_quote,
      titleFact?.source_quote,
      phoneFact?.source_quote,
      wechatIdFact?.source_quote,
      ...noteMerge.sourceQuotes,
    ]);

    cards.push({
      type: 'create_contact',
      payload,
      confidence: participant.confidence,
      source_quote: sourceQuote,
    });
  }

  for (const event of extraction.events) {
    if (event.kind !== 'meeting' && event.kind !== 'appointment') {
      continue;
    }

    const payload: CreateMeetingPayload = {
      title: event.title,
      time_iso: event.time_iso,
      time_text: event.time_text,
      participants: event.participant_names.map((name) => ({ name })),
    };

    if (event.location) {
      payload.location = event.location;
    }

    if (event.agenda) {
      payload.agenda = event.agenda;
    }

    cards.push({
      type: 'create_meeting',
      payload,
      confidence: event.confidence,
      source_quote: event.source_quote,
    });
  }

  // simplified: M1 no entity resolution, M2 upgrade.
  return cards;
}
