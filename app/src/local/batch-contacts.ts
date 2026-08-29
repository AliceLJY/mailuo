import type { PerceptionResult } from "../../../shared/core/agent/perceive.ts";
import type {
  ParticipantResolution,
  ResolvableContact,
} from "../../../shared/core/agent/resolve.ts";
import type {
  ActionCard,
  CreateContactPayload,
  CreateMeetingPayload,
  RecordInteractionPayload,
  UpdateContactPayload,
} from "../../../shared/types.ts";
import type {
  ActionCardDisambiguation,
  ActionCardRecord,
  LocalBatchContactEvidence,
  LocalBatchContactMerge,
  LocalBatchDeferredDependency,
  LocalBatchDeferredMarker,
} from "../types";

type ContactField = "company" | "title" | "phone" | "wechat_id" | "notes";

const CONTACT_FIELDS: ContactField[] = ["company", "title", "phone", "wechat_id", "notes"];

type IndexedContactEvidence = LocalBatchContactEvidence & {
  batchIndex: number;
};

type PendingContact = {
  temporaryId: number;
  contact: ResolvableContact;
  anchorCard: ActionCardRecord;
  evidence: IndexedContactEvidence[];
  fieldBatchIndexes: Partial<Record<ContactField, number>>;
  realContactId: number | null;
};

type CardDependency =
  | {
      kind: "meeting_participant";
      participantIndex: number;
      temporaryId: number;
    }
  | {
      kind: "record_interaction";
      temporaryId: number;
    }
  | {
      kind: "disambiguation_candidate";
      temporaryId: number;
      candidate: ActionCardDisambiguation["candidates"][number];
    };

type PendingContactUpdate = {
  temporaryId: number;
  contact: ResolvableContact;
  evidence: IndexedContactEvidence[];
  fieldBatchIndexes: Partial<Record<ContactField, number>>;
  payload: CreateContactPayload;
  sourceQuote: string;
};

type NewPendingContact = {
  cardIndex: number;
  contact: Omit<ResolvableContact, "id">;
  evidence: IndexedContactEvidence[];
  fieldBatchIndexes: Partial<Record<ContactField, number>>;
};

export type LocalBatchPendingCardUpdate = {
  cardId: number;
  payload: CreateContactPayload;
  sourceQuote: string;
};

export type LocalBatchScreenshotPlan = {
  cards: ActionCard[];
  pendingCardUpdates: LocalBatchPendingCardUpdate[];
  dependenciesByCardIndex: Map<number, CardDependency[]>;
  pendingContactUpdates: PendingContactUpdate[];
  newPendingContacts: NewPendingContact[];
};

export type LocalBatchCommitResult = {
  cards: ActionCardRecord[];
  merges: LocalBatchContactMerge[];
  trackedCardIds: number[];
};

export type LocalBatchConfirmation = {
  payload: ActionCard["payload"];
  resolvedContactId?: number;
  disambiguation?: ActionCardDisambiguation | null;
};

export class LocalBatchContactMappingError extends Error {
  constructor(contactReference: number | string) {
    super(`Missing real contact mapping for local batch contact ${contactReference}`);
    this.name = "LocalBatchContactMappingError";
  }
}

function normalizeComparableText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function joinSourceQuotes(values: Array<string | null | undefined>): string {
  return dedupeStrings(values).join("\n\n");
}

function clonePayload<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T;
}

function cloneContact(contact: ResolvableContact): ResolvableContact {
  return {
    ...contact,
    aliases: [...contact.aliases],
  };
}

function cloneEvidence(evidence: IndexedContactEvidence[]): IndexedContactEvidence[] {
  return evidence.map((entry) => ({
    screenshot_id: entry.screenshot_id,
    source_quotes: [...entry.source_quotes],
    batchIndex: entry.batchIndex,
  }));
}

function sortEvidence(evidence: IndexedContactEvidence[]): IndexedContactEvidence[] {
  return [...evidence].sort(
    (left, right) => left.batchIndex - right.batchIndex || left.screenshot_id - right.screenshot_id,
  );
}

function publicEvidence(evidence: IndexedContactEvidence[]): LocalBatchContactEvidence[] {
  return sortEvidence(evidence).map(({ screenshot_id, source_quotes }) => ({
    screenshot_id,
    source_quotes: [...source_quotes],
  }));
}

function sourceQuoteFromEvidence(evidence: IndexedContactEvidence[]): string {
  return joinSourceQuotes(sortEvidence(evidence).flatMap((entry) => entry.source_quotes));
}

function mergeEvidence(
  current: IndexedContactEvidence[],
  incoming: IndexedContactEvidence,
): IndexedContactEvidence[] {
  const next = cloneEvidence(current);
  const existing = next.find((entry) => entry.screenshot_id === incoming.screenshot_id);

  if (existing) {
    existing.source_quotes = dedupeStrings([...existing.source_quotes, ...incoming.source_quotes]);
    existing.batchIndex = incoming.batchIndex;
  } else {
    next.push({
      screenshot_id: incoming.screenshot_id,
      source_quotes: dedupeStrings(incoming.source_quotes),
      batchIndex: incoming.batchIndex,
    });
  }

  return sortEvidence(next);
}

function collectEvidence(
  extraction: PerceptionResult,
  normalizedName: string,
  screenshotId: number,
  batchIndex: number,
  extraSourceQuotes: Array<string | null | undefined> = [],
): IndexedContactEvidence {
  const participantNames = new Set<string>([normalizedName]);
  const sourceQuotes: string[] = [];

  for (const participant of extraction.participants) {
    const names = [participant.name, ...(participant.aliases ?? [])].map(normalizeComparableText);
    if (!names.includes(normalizedName)) {
      continue;
    }

    names.forEach((name) => participantNames.add(name));
    sourceQuotes.push(participant.source_quote);
  }

  for (const fact of extraction.facts) {
    if (participantNames.has(normalizeComparableText(fact.subject_name))) {
      sourceQuotes.push(fact.source_quote);
    }
  }

  for (const quote of extraction.quotes) {
    if (quote.speaker_name && participantNames.has(normalizeComparableText(quote.speaker_name))) {
      sourceQuotes.push(quote.source_quote);
    }
  }

  for (const event of extraction.events) {
    if (event.participant_names.some((name) => participantNames.has(normalizeComparableText(name)))) {
      sourceQuotes.push(event.source_quote);
    }
  }

  return {
    screenshot_id: screenshotId,
    source_quotes: dedupeStrings([...sourceQuotes, ...extraSourceQuotes]),
    batchIndex,
  };
}

function createResolvableContact(payload: CreateContactPayload): Omit<ResolvableContact, "id"> {
  return {
    canonical_name: payload.name,
    aliases: dedupeStrings(payload.aliases ?? []).filter((alias) => alias !== payload.name),
    company: payload.company ?? null,
    title: payload.title ?? null,
    phone: payload.phone ?? null,
    wechat_id: payload.wechat_id ?? null,
    notes: payload.notes ?? null,
  };
}

function mergeParticipantIntoPending(
  pending: PendingContactUpdate,
  participant: PerceptionResult["participants"][number] | undefined,
  batchIndex: number,
) {
  if (!participant) {
    return;
  }

  const aliases = dedupeStrings([
    ...(pending.payload.aliases ?? []),
    participant.name === pending.payload.name ? undefined : participant.name,
    ...(participant.aliases ?? []),
  ]).filter((alias) => alias !== pending.payload.name);

  if (aliases.length > 0) {
    pending.payload.aliases = aliases;
    pending.contact.aliases = [...aliases];
  }

  for (const field of CONTACT_FIELDS) {
    const value = participant[field]?.trim();
    if (!value) {
      continue;
    }

    const currentValue = pending.payload[field]?.trim();
    const currentBatchIndex = pending.fieldBatchIndexes[field];
    if (currentValue && currentBatchIndex != null && batchIndex < currentBatchIndex) {
      continue;
    }

    pending.payload[field] = value;
    pending.contact[field] = value;
    pending.fieldBatchIndexes[field] = batchIndex;
  }
}

function applyUpdateCard(
  pending: PendingContactUpdate,
  card: Extract<ActionCard, { type: "update_contact" }>,
  screenshotId: number,
  batchIndex: number,
) {
  for (const [field, change] of Object.entries(card.payload.changes)) {
    if (!CONTACT_FIELDS.includes(field as ContactField)) {
      continue;
    }

    const value = change.new.trim();
    if (!value) {
      continue;
    }

    const contactField = field as ContactField;
    const currentValue = pending.payload[contactField]?.trim();
    const currentBatchIndex = pending.fieldBatchIndexes[contactField];
    if (currentValue && currentBatchIndex != null && batchIndex < currentBatchIndex) {
      continue;
    }

    pending.payload[contactField] = value;
    pending.contact[contactField] = value;
    pending.fieldBatchIndexes[contactField] = batchIndex;
  }

  pending.evidence = mergeEvidence(pending.evidence, {
    screenshot_id: screenshotId,
    source_quotes: [card.source_quote],
    batchIndex,
  });
  pending.sourceQuote = sourceQuoteFromEvidence(pending.evidence);
}

function fieldBatchIndexes(
  contact: Omit<ResolvableContact, "id">,
  batchIndex: number,
): Partial<Record<ContactField, number>> {
  return Object.fromEntries(
    CONTACT_FIELDS
      .filter((field) => Boolean(contact[field]?.trim()))
      .map((field) => [field, batchIndex]),
  ) as Partial<Record<ContactField, number>>;
}

function findParticipant(
  extraction: PerceptionResult,
  resolution: ParticipantResolution,
): PerceptionResult["participants"][number] | undefined {
  return extraction.participants.find(
    (participant) => normalizeComparableText(participant.name) === resolution.normalized_name,
  );
}

function assertTemporaryId(value: number): number {
  if (!Number.isSafeInteger(value) || value >= 0) {
    throw new TypeError(`Expected a negative temporary contact id, received ${value}`);
  }

  return value;
}

function assertNoNegativeContactIds(card: ActionCard) {
  if (card.type === "update_contact" && card.payload.contact_id < 0) {
    throw new TypeError("update_contact contains a temporary contact id");
  }

  if (
    card.type === "create_meeting" &&
    card.payload.participants.some((participant) => (participant.contact_id ?? 0) < 0)
  ) {
    throw new TypeError("create_meeting contains a temporary contact id");
  }

  if (card.type === "record_interaction" && (card.payload.contact_id ?? 0) < 0) {
    throw new TypeError("record_interaction contains a temporary contact id");
  }

  if (card.disambiguation?.candidates.some((candidate) => candidate.contact_id < 0)) {
    throw new TypeError("action card disambiguation contains a temporary contact id");
  }
}

function mapByNormalizedName<T extends { normalized_name: string }>(values: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();

  for (const value of values) {
    const entries = result.get(value.normalized_name) ?? [];
    entries.push(value);
    result.set(value.normalized_name, entries);
  }

  return result;
}

type AnchorCardLookup = (anchorCardId: number) => ActionCardRecord | null;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readDeferredMarker(
  disambiguation: ActionCardDisambiguation | null | undefined,
): LocalBatchDeferredMarker | null {
  const marker = disambiguation?.local_batch_deferred as unknown;
  if (marker == null) {
    return null;
  }

  if (
    typeof marker !== "object" ||
    marker === null ||
    (marker as { version?: unknown }).version !== 1 ||
    !Array.isArray((marker as { dependencies?: unknown }).dependencies)
  ) {
    throw new LocalBatchContactMappingError("invalid deferred marker");
  }

  const dependencies: LocalBatchDeferredDependency[] = [];
  for (const dependency of (marker as { dependencies: unknown[] }).dependencies) {
    if (typeof dependency !== "object" || dependency === null) {
      throw new LocalBatchContactMappingError("invalid deferred dependency");
    }

    const value = dependency as Record<string, unknown>;
    if (!isPositiveSafeInteger(value.anchor_card_id)) {
      throw new LocalBatchContactMappingError("invalid anchor card id");
    }

    if (value.kind === "meeting_participant") {
      if (
        typeof value.participant_index !== "number" ||
        !Number.isSafeInteger(value.participant_index) ||
        value.participant_index < 0
      ) {
        throw new LocalBatchContactMappingError("invalid meeting participant index");
      }
      dependencies.push({
        kind: value.kind,
        anchor_card_id: value.anchor_card_id,
        participant_index: value.participant_index,
      });
      continue;
    }

    if (value.kind === "record_interaction") {
      dependencies.push({
        kind: value.kind,
        anchor_card_id: value.anchor_card_id,
      });
      continue;
    }

    if (value.kind === "disambiguation_candidate") {
      const candidate = value.candidate;
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        typeof (candidate as { name?: unknown }).name !== "string" ||
        !(candidate as { name: string }).name.trim()
      ) {
        throw new LocalBatchContactMappingError("invalid deferred candidate");
      }
      const company = (candidate as { company?: unknown }).company;
      if (company !== undefined && company !== null && typeof company !== "string") {
        throw new LocalBatchContactMappingError("invalid deferred candidate company");
      }
      dependencies.push({
        kind: value.kind,
        anchor_card_id: value.anchor_card_id,
        candidate: {
          name: (candidate as { name: string }).name,
          ...(company !== undefined ? { company: company as string | null } : {}),
        },
      });
      continue;
    }

    throw new LocalBatchContactMappingError("unknown deferred dependency");
  }

  return { version: 1, dependencies };
}

function confirmedAnchorContactId(
  anchorCardId: number,
  getAnchorCard: AnchorCardLookup,
): number {
  const anchor = getAnchorCard(anchorCardId);
  if (
    !anchor ||
    anchor.type !== "create_contact" ||
    anchor.status !== "confirmed" ||
    !isPositiveSafeInteger(anchor.resolved_contact_id)
  ) {
    throw new LocalBatchContactMappingError(anchorCardId);
  }

  return anchor.resolved_contact_id;
}

function appendCandidate(
  disambiguation: ActionCardDisambiguation,
  candidate: ActionCardDisambiguation["candidates"][number],
): ActionCardDisambiguation {
  const candidates = [...disambiguation.candidates, candidate].filter(
    (entry, index, all) => all.findIndex((other) => other.contact_id === entry.contact_id) === index,
  );
  return { ...disambiguation, candidates };
}

export function preparePersistedLocalBatchConfirmation(input: {
  card: ActionCardRecord;
  payload: ActionCard["payload"];
  resolvedContactId?: number;
  getAnchorCard: AnchorCardLookup;
}): LocalBatchConfirmation {
  const marker = readDeferredMarker(input.card.disambiguation);
  const payload = clonePayload(input.payload);
  let resolvedContactId = input.resolvedContactId;
  let disambiguation = input.card.disambiguation;
  let disambiguationChanged = false;

  if (marker) {
    for (const dependency of marker.dependencies) {
      if (dependency.kind === "meeting_participant") {
        if (input.card.type !== "create_meeting") {
          throw new LocalBatchContactMappingError(dependency.anchor_card_id);
        }
        const meeting = payload as CreateMeetingPayload;
        const participant = meeting.participants[dependency.participant_index];
        if (!participant) {
          throw new TypeError(`Missing meeting participant ${dependency.participant_index}`);
        }
        meeting.participants[dependency.participant_index] = {
          ...participant,
          contact_id: confirmedAnchorContactId(
            dependency.anchor_card_id,
            input.getAnchorCard,
          ),
        };
        continue;
      }

      if (dependency.kind === "record_interaction") {
        if (input.card.type !== "record_interaction") {
          throw new LocalBatchContactMappingError(dependency.anchor_card_id);
        }
        (payload as RecordInteractionPayload).contact_id = confirmedAnchorContactId(
          dependency.anchor_card_id,
          input.getAnchorCard,
        );
      }
    }

    const candidateDependencies = marker.dependencies.filter(
      (dependency): dependency is Extract<LocalBatchDeferredDependency, {
        kind: "disambiguation_candidate";
      }> => dependency.kind === "disambiguation_candidate",
    );
    const storedDisambiguation: ActionCardDisambiguation = disambiguation ?? {
      candidates: [],
      local_batch_deferred: marker,
    };

    if (resolvedContactId != null && resolvedContactId < 0) {
      if (!Number.isSafeInteger(resolvedContactId)) {
        throw new LocalBatchContactMappingError(resolvedContactId);
      }
      const dependency = candidateDependencies.find(
        (entry) => -entry.anchor_card_id === resolvedContactId,
      );
      if (!dependency) {
        throw new LocalBatchContactMappingError(resolvedContactId);
      }
      resolvedContactId = confirmedAnchorContactId(
        dependency.anchor_card_id,
        input.getAnchorCard,
      );
      disambiguation = appendCandidate(storedDisambiguation, {
        ...dependency.candidate,
        contact_id: resolvedContactId,
      });
      disambiguationChanged = true;
    } else if (
      isPositiveSafeInteger(resolvedContactId) &&
      !storedDisambiguation.candidates.some((candidate) => candidate.contact_id === resolvedContactId)
    ) {
      for (const dependency of candidateDependencies) {
        const anchor = input.getAnchorCard(dependency.anchor_card_id);
        if (
          anchor?.type === "create_contact" &&
          anchor.status === "confirmed" &&
          anchor.resolved_contact_id === resolvedContactId
        ) {
          disambiguation = appendCandidate(storedDisambiguation, {
            ...dependency.candidate,
            contact_id: resolvedContactId,
          });
          disambiguationChanged = true;
          break;
        }
      }
    }
  }

  const cardForValidation: ActionCard = {
    ...input.card,
    payload,
    ...(disambiguation === undefined ? {} : { disambiguation }),
  } as ActionCard;
  assertNoNegativeContactIds(cardForValidation);

  return {
    payload,
    ...(resolvedContactId != null ? { resolvedContactId } : {}),
    ...(disambiguationChanged ? { disambiguation } : {}),
  };
}

export function hydrateLocalBatchCardForResponse(
  card: ActionCardRecord,
  getAnchorCard: AnchorCardLookup,
): ActionCardRecord {
  const marker = readDeferredMarker(card.disambiguation);
  if (!marker) {
    return card;
  }

  let disambiguation: ActionCardDisambiguation = card.disambiguation ?? {
    candidates: [],
    local_batch_deferred: marker,
  };
  for (const dependency of marker.dependencies) {
    if (dependency.kind !== "disambiguation_candidate") {
      continue;
    }

    const anchor = getAnchorCard(dependency.anchor_card_id);
    if (!anchor || anchor.type !== "create_contact") {
      continue;
    }

    const contactId = anchor.status === "confirmed" && isPositiveSafeInteger(anchor.resolved_contact_id)
      ? anchor.resolved_contact_id
      : anchor.status === "pending"
        ? -dependency.anchor_card_id
        : null;
    if (contactId == null) {
      continue;
    }

    disambiguation = appendCandidate(disambiguation, {
      ...dependency.candidate,
      contact_id: contactId,
    });
  }

  return { ...card, disambiguation } as ActionCardRecord;
}

export class LocalBatchContactSession {
  private nextTemporaryId = -1;
  private readonly pendingByTemporaryId = new Map<number, PendingContact>();
  private readonly temporaryIdByAnchorCardId = new Map<number, number>();
  private readonly realContactIdByTemporaryId = new Map<number, number>();
  private readonly dependenciesByCardId = new Map<number, CardDependency[]>();

  listPendingContacts(): ResolvableContact[] {
    return [...this.pendingByTemporaryId.values()]
      .filter((pending) => pending.realContactId == null)
      .map((pending) => cloneContact(pending.contact));
  }

  reconcilePendingContacts(getAnchorCard: AnchorCardLookup) {
    for (const [temporaryId, pending] of this.pendingByTemporaryId) {
      const anchor = getAnchorCard(pending.anchorCard.id);
      if (!anchor || anchor.type !== "create_contact" || anchor.status === "rejected") {
        this.removePendingContact(temporaryId);
        continue;
      }

      if (anchor.status === "confirmed") {
        if (isPositiveSafeInteger(anchor.resolved_contact_id)) {
          this.realContactIdByTemporaryId.set(temporaryId, anchor.resolved_contact_id);
          pending.realContactId = anchor.resolved_contact_id;
          pending.anchorCard = anchor;
        } else {
          this.removePendingContact(temporaryId);
        }
        continue;
      }

      pending.anchorCard = anchor;
    }
  }

  prepareScreenshot(input: {
    screenshotId: number;
    batchIndex: number;
    extraction: PerceptionResult;
    resolutions: ParticipantResolution[];
    cards: ActionCard[];
  }): LocalBatchScreenshotPlan {
    if (!Number.isSafeInteger(input.batchIndex) || input.batchIndex < 0) {
      throw new TypeError(`Expected a non-negative batch index, received ${input.batchIndex}`);
    }

    const workingPending = new Map<number, PendingContactUpdate>();
    const changedTemporaryIds = new Set<number>();

    for (const [temporaryId, pending] of this.pendingByTemporaryId) {
      workingPending.set(temporaryId, {
        temporaryId,
        contact: cloneContact(pending.contact),
        evidence: cloneEvidence(pending.evidence),
        fieldBatchIndexes: { ...pending.fieldBatchIndexes },
        payload: clonePayload(pending.anchorCard.payload as CreateContactPayload),
        sourceQuote: sourceQuoteFromEvidence(pending.evidence),
      });
    }

    for (const resolution of input.resolutions) {
      if (resolution.status !== "same_as" || resolution.contact_id >= 0) {
        continue;
      }

      const temporaryId = assertTemporaryId(resolution.contact_id);
      const pending = workingPending.get(temporaryId);
      if (!pending) {
        throw new LocalBatchContactMappingError(temporaryId);
      }

      const evidence = collectEvidence(
        input.extraction,
        resolution.normalized_name,
        input.screenshotId,
        input.batchIndex,
      );
      pending.evidence = mergeEvidence(pending.evidence, evidence);
      pending.sourceQuote = sourceQuoteFromEvidence(pending.evidence);
      mergeParticipantIntoPending(
        pending,
        findParticipant(input.extraction, resolution),
        input.batchIndex,
      );
      changedTemporaryIds.add(temporaryId);
    }

    const cards: ActionCard[] = [];
    const dependenciesByCardIndex = new Map<number, CardDependency[]>();

    const pushCard = (card: ActionCard, dependencies: CardDependency[] = []) => {
      let storedCard = card;
      if (dependencies.length > 0) {
        const persistedDependencies = dependencies.map((dependency): LocalBatchDeferredDependency => {
          const anchor = this.pendingByTemporaryId.get(dependency.temporaryId)?.anchorCard;
          if (!anchor || !isPositiveSafeInteger(anchor.id)) {
            throw new LocalBatchContactMappingError(dependency.temporaryId);
          }

          if (dependency.kind === "meeting_participant") {
            return {
              kind: dependency.kind,
              anchor_card_id: anchor.id,
              participant_index: dependency.participantIndex,
            };
          }
          if (dependency.kind === "record_interaction") {
            return {
              kind: dependency.kind,
              anchor_card_id: anchor.id,
            };
          }
          return {
            kind: dependency.kind,
            anchor_card_id: anchor.id,
            candidate: {
              name: dependency.candidate.name,
              ...(dependency.candidate.company !== undefined
                ? { company: dependency.candidate.company }
                : {}),
            },
          };
        });
        storedCard = {
          ...card,
          disambiguation: {
            candidates: card.disambiguation?.candidates ?? [],
            local_batch_deferred: {
              version: 1,
              dependencies: persistedDependencies,
            },
          },
        } as unknown as ActionCard;
      }

      assertNoNegativeContactIds(storedCard);
      const cardIndex = cards.push(storedCard) - 1;
      if (dependencies.length > 0) {
        dependenciesByCardIndex.set(cardIndex, dependencies);
      }
    };

    for (const proposedCard of input.cards) {
      if (proposedCard.type === "update_contact" && proposedCard.payload.contact_id < 0) {
        const temporaryId = assertTemporaryId(proposedCard.payload.contact_id);
        const pending = workingPending.get(temporaryId);
        if (!pending) {
          throw new LocalBatchContactMappingError(temporaryId);
        }

        applyUpdateCard(pending, proposedCard, input.screenshotId, input.batchIndex);
        changedTemporaryIds.add(temporaryId);
        continue;
      }

      if (proposedCard.type === "create_meeting") {
        const dependencies: CardDependency[] = [];
        const payload = clonePayload(proposedCard.payload);
        payload.participants = payload.participants.map((participant, participantIndex) => {
          if (participant.contact_id == null || participant.contact_id >= 0) {
            return participant;
          }

          const temporaryId = assertTemporaryId(participant.contact_id);
          if (!workingPending.has(temporaryId)) {
            throw new LocalBatchContactMappingError(temporaryId);
          }

          dependencies.push({ kind: "meeting_participant", participantIndex, temporaryId });
          return { name: participant.name };
        });
        pushCard({ ...proposedCard, payload }, dependencies);
        continue;
      }

      if (proposedCard.type === "record_interaction" && (proposedCard.payload.contact_id ?? 0) < 0) {
        const temporaryId = assertTemporaryId(proposedCard.payload.contact_id!);
        if (!workingPending.has(temporaryId)) {
          throw new LocalBatchContactMappingError(temporaryId);
        }

        const { contact_id: _temporaryContactId, ...payload } = proposedCard.payload;
        pushCard(
          { ...proposedCard, payload },
          [{ kind: "record_interaction", temporaryId }],
        );
        continue;
      }

      if (proposedCard.disambiguation?.candidates.some((candidate) => candidate.contact_id < 0)) {
        const dependencies: CardDependency[] = [];
        const positiveCandidates = proposedCard.disambiguation.candidates.filter((candidate) => {
          if (candidate.contact_id >= 0) {
            return true;
          }

          const temporaryId = assertTemporaryId(candidate.contact_id);
          if (!workingPending.has(temporaryId)) {
            throw new LocalBatchContactMappingError(temporaryId);
          }

          dependencies.push({
            kind: "disambiguation_candidate",
            temporaryId,
            candidate: { ...candidate },
          });
          return false;
        });
        pushCard(
          {
            ...proposedCard,
            disambiguation: positiveCandidates.length > 0
              ? { candidates: positiveCandidates }
              : undefined,
          } as ActionCard,
          dependencies,
        );
        continue;
      }

      pushCard(clonePayload(proposedCard));
    }

    const pendingCardUpdates = [...changedTemporaryIds].map((temporaryId) => {
      const pending = workingPending.get(temporaryId)!;
      const anchor = this.pendingByTemporaryId.get(temporaryId)!;
      return {
        cardId: anchor.anchorCard.id,
        payload: clonePayload(pending.payload),
        sourceQuote: sourceQuoteFromEvidence(pending.evidence),
      };
    });

    const candidateResolutions = input.resolutions.filter(
      (resolution) => resolution.status === "new" || resolution.status === "unsure",
    );
    const resolutionsByName = mapByNormalizedName(candidateResolutions);
    const newPendingContacts: NewPendingContact[] = [];

    for (const [cardIndex, card] of cards.entries()) {
      if (card.type !== "create_contact") {
        continue;
      }

      const normalizedName = normalizeComparableText(card.payload.name);
      const matching = resolutionsByName.get(normalizedName);
      const resolution = matching?.shift();
      if (!resolution) {
        continue;
      }

      const contact = createResolvableContact(card.payload);
      newPendingContacts.push({
        cardIndex,
        contact,
        evidence: [collectEvidence(
          input.extraction,
          resolution.normalized_name,
          input.screenshotId,
          input.batchIndex,
          [card.source_quote],
        )],
        fieldBatchIndexes: fieldBatchIndexes(contact, input.batchIndex),
      });
    }

    return {
      cards,
      pendingCardUpdates,
      dependenciesByCardIndex,
      pendingContactUpdates: [...changedTemporaryIds].map((temporaryId) => workingPending.get(temporaryId)!),
      newPendingContacts,
    };
  }

  commitScreenshot(input: {
    plan: LocalBatchScreenshotPlan;
    savedCards: ActionCardRecord[];
    updatedAnchorCards: Map<number, ActionCardRecord>;
  }): LocalBatchCommitResult {
    if (input.savedCards.length !== input.plan.cards.length) {
      throw new Error("Saved batch cards do not align with the prepared cards");
    }

    const merges: LocalBatchContactMerge[] = [];
    const trackedCardIds = new Set<number>();

    for (const update of input.plan.pendingContactUpdates) {
      const current = this.pendingByTemporaryId.get(update.temporaryId);
      const anchorCard = input.updatedAnchorCards.get(current?.anchorCard.id ?? 0);
      if (!current || !anchorCard) {
        throw new LocalBatchContactMappingError(update.temporaryId);
      }

      const next: PendingContact = {
        ...current,
        contact: cloneContact(update.contact),
        anchorCard,
        evidence: cloneEvidence(update.evidence),
        fieldBatchIndexes: { ...update.fieldBatchIndexes },
      };
      this.pendingByTemporaryId.set(update.temporaryId, next);
      trackedCardIds.add(anchorCard.id);
      merges.push({
        anchor_card: anchorCard,
        evidence: publicEvidence(next.evidence),
      });
    }

    for (const pending of input.plan.newPendingContacts) {
      const anchorCard = input.savedCards[pending.cardIndex];
      if (!anchorCard || anchorCard.type !== "create_contact") {
        throw new Error("Pending contact anchor must be a saved create_contact card");
      }

      const temporaryId = this.nextTemporaryId;
      this.nextTemporaryId -= 1;
      this.pendingByTemporaryId.set(temporaryId, {
        temporaryId,
        contact: { id: temporaryId, ...pending.contact },
        anchorCard,
        evidence: cloneEvidence(pending.evidence),
        fieldBatchIndexes: { ...pending.fieldBatchIndexes },
        realContactId: null,
      });
      this.temporaryIdByAnchorCardId.set(anchorCard.id, temporaryId);
      trackedCardIds.add(anchorCard.id);
    }

    const cards = input.savedCards.map((card, cardIndex) => {
      const dependencies = input.plan.dependenciesByCardIndex.get(cardIndex) ?? [];
      if (dependencies.length === 0) {
        return card;
      }

      this.dependenciesByCardId.set(card.id, dependencies);
      trackedCardIds.add(card.id);
      const temporaryCandidates = dependencies
        .filter((dependency): dependency is Extract<CardDependency, { kind: "disambiguation_candidate" }> =>
          dependency.kind === "disambiguation_candidate")
        .map((dependency) => {
          const anchor = this.pendingByTemporaryId.get(dependency.temporaryId)?.anchorCard;
          if (!anchor) {
            throw new LocalBatchContactMappingError(dependency.temporaryId);
          }
          return {
            ...dependency.candidate,
            contact_id: -anchor.id,
          };
        });

      if (temporaryCandidates.length === 0) {
        return card;
      }

      return {
        ...card,
        disambiguation: {
          ...(card.disambiguation ?? {}),
          candidates: [
            ...(card.disambiguation?.candidates ?? []),
            ...temporaryCandidates,
          ],
        },
      } as ActionCardRecord;
    });

    return {
      cards,
      merges,
      trackedCardIds: [...trackedCardIds],
    };
  }

  prepareConfirmation(input: {
    card: ActionCardRecord;
    payload: ActionCard["payload"];
    resolvedContactId?: number;
  }): LocalBatchConfirmation {
    return preparePersistedLocalBatchConfirmation({
      ...input,
      getAnchorCard: (anchorCardId) => {
        const temporaryId = this.temporaryIdByAnchorCardId.get(anchorCardId);
        if (temporaryId == null) {
          return null;
        }
        const pending = this.pendingByTemporaryId.get(temporaryId) ?? null;
        if (!pending) {
          return null;
        }

        const realContactId = this.realContactIdByTemporaryId.get(temporaryId);
        return realContactId == null
          ? pending.anchorCard
          : {
              ...pending.anchorCard,
              status: "confirmed",
              resolved_contact_id: realContactId,
            };
      },
    });
  }

  registerConfirmedContact(anchorCardId: number, realContactId: number) {
    const temporaryId = this.temporaryIdByAnchorCardId.get(anchorCardId);
    if (temporaryId == null) {
      return;
    }

    if (!Number.isSafeInteger(realContactId) || realContactId <= 0) {
      throw new TypeError(`Expected a positive real contact id, received ${realContactId}`);
    }

    this.realContactIdByTemporaryId.set(temporaryId, realContactId);
    const pending = this.pendingByTemporaryId.get(temporaryId);
    if (pending) {
      pending.realContactId = realContactId;
      pending.anchorCard = {
        ...pending.anchorCard,
        status: "confirmed",
        resolved_contact_id: realContactId,
      };
    }
  }

  registerRejectedAnchor(anchorCardId: number) {
    const temporaryId = this.temporaryIdByAnchorCardId.get(anchorCardId);
    if (temporaryId != null) {
      this.removePendingContact(temporaryId);
    }
  }

  hasTrackedCard(cardId: number): boolean {
    return this.temporaryIdByAnchorCardId.has(cardId) || this.dependenciesByCardId.has(cardId);
  }

  private requireRealContactId(temporaryId: number): number {
    const realContactId = this.realContactIdByTemporaryId.get(temporaryId);
    if (realContactId == null) {
      throw new LocalBatchContactMappingError(temporaryId);
    }

    return realContactId;
  }

  private removePendingContact(temporaryId: number) {
    const pending = this.pendingByTemporaryId.get(temporaryId);
    if (pending) {
      this.temporaryIdByAnchorCardId.delete(pending.anchorCard.id);
    }
    this.pendingByTemporaryId.delete(temporaryId);
    this.realContactIdByTemporaryId.delete(temporaryId);
  }
}
