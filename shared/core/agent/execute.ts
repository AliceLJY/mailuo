import type {
  ActionCard,
  ActionCardRecord,
  CreateContactPayload,
  CreateMeetingPayload,
  MeetingKind,
  RecordInteractionPayload,
  UpdateContactPayload,
} from "../../types.ts";
import {
  CreateContactPayloadSchema,
  CreateMeetingPayloadSchema,
  RecordInteractionPayloadSchema,
  UpdateContactPayloadSchema,
  ZodError,
} from "../schemas.ts";
import {
  isSelfName,
  parseStoredPerceptionResult,
  type PerceptionResult,
} from "./perceive.ts";
import {
  appendMeetingAgenda,
  buildMeetingChanges,
  type ExistingMeeting,
} from "./propose.ts";

export const CONTACT_EDITABLE_FIELDS = [
  "company",
  "title",
  "phone",
  "wechat_id",
  "notes",
] as const;
const CONTACT_UPDATE_CHANGE_FIELDS = ["aliases", ...CONTACT_EDITABLE_FIELDS] as const;

export type ContactEditableField = (typeof CONTACT_EDITABLE_FIELDS)[number];
export type ContactFieldUpdates = Partial<Record<ContactEditableField, string | null>>;
export type ObservationKind = "fact" | "preference" | "status_change" | "interaction";
export type StoredActionCard = ActionCard;
export type StoredActionCardRecord = ActionCardRecord;

export type ContactRecord = {
  id: number;
  canonical_name: string;
  aliases: string[];
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat_id: string | null;
  notes: string | null;
};

export type MeetingParticipant = {
  contact_id?: number;
  name: string;
};

export type MeetingWriteInput = {
  kind: MeetingKind;
  title: string;
  timeIso: string | null;
  timeText: string;
  location?: string | null;
  participants: MeetingParticipant[];
  agenda?: string | null;
  sourceScreenshotId?: number | null;
  createdAt?: string;
};

export type ObservationInsertInput = {
  contactId: number;
  screenshotId?: number | null;
  kind: ObservationKind;
  content: string;
  sourceQuote?: string | null;
  observedAt?: string;
};

export interface ExecuteStore {
  withTransaction<T>(callback: () => T): T;
  getStoredActionCardById(cardId: number): StoredActionCardRecord | null;
  getScreenshotById(screenshotId: number): {
    id: number;
    raw_extraction: unknown;
  } | null;
  getScreenshotDetail(screenshotId: number): {
    cards: StoredActionCardRecord[];
  } | null;
  getContactById(contactId: number): ContactRecord | null;
  appendContactAliases(
    contactId: number,
    aliases: string[],
    updatedAt?: string,
  ): ContactRecord | null;
  updateContactFields(
    contactId: number,
    updates: ContactFieldUpdates,
    updatedAt?: string,
  ): ContactRecord | null;
  createContact(input: {
    canonicalName: string;
    aliases?: string[];
    company?: string | null;
    title?: string | null;
    phone?: string | null;
    wechat_id?: string | null;
    notes?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): ContactRecord;
  findObservationByContactAndScreenshot(input: {
    contactId: number;
    screenshotId: number | null;
    kind: ObservationKind;
  }): { id: number } | null;
  insertObservationIfAbsent(input: ObservationInsertInput): { id: number };
  insertMeeting(input: MeetingWriteInput): { id: number };
  updateMeeting(meetingId: number, input: MeetingWriteInput): { id: number } | null;
  listMeetings(): ExistingMeeting[];
  findResolvedContactIdsForConfirmedSiblingCreateCards(args: {
    screenshotId: number;
    displayedNames: string[];
  }): number[];
  confirmActionCardIfPending(input: {
    cardId: number;
    payload?: StoredActionCard["payload"];
    resolvedContactId?: number | null;
    resolvedAt: string;
  }): StoredActionCardRecord | null;
  rejectActionCardIfPending(
    cardId: number,
    resolvedAt?: string,
  ): StoredActionCardRecord | null;
}

const FIELD_LABELS: Record<ContactEditableField, string> = {
  company: "公司",
  title: "职位",
  phone: "电话",
  wechat_id: "微信号",
  notes: "备注",
};

export type ExecuteCardInput = {
  db: ExecuteStore;
  cardId: number;
  payload?: unknown;
  resolvedContactId?: number;
};

export type RejectCardInput = {
  db: ExecuteStore;
  cardId: number;
};

export type ExecuteResult = {
  confirmedCard: StoredActionCardRecord;
  affectedContactIds: number[];
  observationIds: number[];
  meetingId?: number;
};

type StatusChangePlan = {
  field: ContactEditableField;
  oldValue: string;
  newValue: string | null;
  content: string;
  sourceQuote: string;
};

type ObservationContext = {
  contactId: number;
  names: Set<string>;
  skipStructuredFacts: Partial<Record<ContactEditableField, string>>;
};

type RelatedParticipantsResult = {
  participants: PerceptionResult["participants"];
  names: string[];
};

export class ExecuteError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: { statusCode: number; code: string; details?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
  }
}

export class ActionCardConflictError extends ExecuteError {
  constructor(message: string) {
    super(message, {
      statusCode: 409,
      code: "ACTION_CARD_NOT_PENDING",
    });
  }
}

export class ExecuteValidationError extends ExecuteError {
  constructor(message: string, details?: unknown) {
    super(message, {
      statusCode: 422,
      code: "INVALID_PAYLOAD",
      details,
    });
  }
}

export class ExecuteDependencyError extends ExecuteError {
  constructor(message: string, details?: unknown) {
    super(message, {
      statusCode: 422,
      code: "DEPENDENCY_ERROR",
      details,
    });
  }
}

export class ExecuteNotFoundError extends ExecuteError {
  constructor(message: string) {
    super(message, {
      statusCode: 404,
      code: "NOT_FOUND",
    });
  }
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function shortestSupportingQuote(sourceQuote: string, value: string): string {
  const segments = sourceQuote
    .split(/[。！？\n]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.includes(value));

  return segments.reduce(
    (shortest, segment) => segment.length < shortest.length ? segment : shortest,
    sourceQuote,
  );
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = normalizeOptionalString(value);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function parseAliasChange(value: string): string[] {
  return dedupeStrings(value.split(/[,\n，、]/u));
}

function normalizeLookupValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function containsSelfName(values: Array<string | null | undefined>): boolean {
  return values.some((value) => value != null && isSelfName(value));
}

function assertNoSelfContactNames(values: Array<string | null | undefined>) {
  if (containsSelfName(values)) {
    throw new ExecuteValidationError('create_contact cannot create or merge the self contact "我"');
  }
}

function isHistoricalSelfContact(contact: Pick<ContactRecord, "canonical_name" | "aliases">): boolean {
  return containsSelfName([contact.canonical_name, ...contact.aliases]);
}

function isSelfMeetingParticipantName(value: string): boolean {
  return isSelfName(value);
}

function ensurePositiveSafeInteger(value: number | undefined, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExecuteValidationError(`${label} must be a positive safe integer`);
  }

  return value;
}

function sanitizeCreateContactPayload(payload: CreateContactPayload): CreateContactPayload {
  const name = normalizeOptionalString(payload.name);

  if (!name) {
    throw new ExecuteValidationError("create_contact.name must be non-empty");
  }

  const sanitized: CreateContactPayload = { name };
  const aliases = dedupeStrings(payload.aliases ?? []);
  assertNoSelfContactNames([name, ...aliases]);

  if (aliases.length > 0) {
    sanitized.aliases = aliases.filter((alias) => alias !== name);
  }

  for (const field of CONTACT_EDITABLE_FIELDS) {
    const normalized = normalizeOptionalString(payload[field]);
    if (normalized) {
      sanitized[field] = normalized;
    }
  }

  return sanitized;
}

function sanitizeUpdateContactPayload(payload: UpdateContactPayload): UpdateContactPayload {
  const contactName = normalizeOptionalString(payload.contact_name);

  if (!contactName) {
    throw new ExecuteValidationError("update_contact.contact_name must be non-empty");
  }

  if (isSelfName(contactName)) {
    throw new ExecuteValidationError('update_contact cannot target the self contact "我"');
  }

  const changes: UpdateContactPayload["changes"] = {};

  for (const [field, change] of Object.entries(payload.changes)) {
    if (!CONTACT_UPDATE_CHANGE_FIELDS.includes(field as (typeof CONTACT_UPDATE_CHANGE_FIELDS)[number])) {
      throw new ExecuteValidationError(`update_contact does not allow field "${field}"`);
    }

    if (field === "aliases") {
      const aliasAdditions = parseAliasChange(change.new);
      assertNoSelfContactNames(aliasAdditions);
      if (aliasAdditions.length > 0) {
        changes.aliases = {
          old: normalizeOptionalString(change.old),
          new: aliasAdditions.join("，"),
        };
      }
      continue;
    }

    changes[field] = {
      old: normalizeOptionalString(change.old),
      new: change.new.trim(),
    };
  }

  return {
    contact_id: payload.contact_id,
    contact_name: contactName,
    changes,
  };
}

function sanitizeCreateMeetingPayload(payload: CreateMeetingPayload): CreateMeetingPayload {
  const title = normalizeOptionalString(payload.title);

  if (!title) {
    throw new ExecuteValidationError("create_meeting requires a non-empty title");
  }

  const participants = payload.participants.map((participant) => {
    const name = normalizeOptionalString(participant.name);

    if (!name) {
      throw new ExecuteValidationError("create_meeting participants require non-empty names");
    }

    if (isSelfMeetingParticipantName(name)) {
      return { name: "我" };
    }

    const contactId = ensurePositiveSafeInteger(participant.contact_id, "participant.contact_id");
    return {
      ...(contactId ? { contact_id: contactId } : {}),
      name,
    };
  });
  const duplicateMeetingId = ensurePositiveSafeInteger(
    payload.duplicate_of_meeting_id,
    "duplicate_of_meeting_id",
  );
  const agendaAppend = normalizeOptionalString(payload.agenda_append);
  return {
    kind: payload.kind,
    title,
    time_iso: normalizeOptionalString(payload.time_iso),
    time_text: payload.time_text.trim(),
    ...(normalizeOptionalString(payload.location) ? { location: normalizeOptionalString(payload.location)! } : {}),
    participants,
    ...(normalizeOptionalString(payload.agenda) ? { agenda: normalizeOptionalString(payload.agenda)! } : {}),
    ...(duplicateMeetingId != null
      ? {
          duplicate_of_meeting_id: duplicateMeetingId,
          ...(agendaAppend ? { agenda_append: agendaAppend } : {}),
          // Diff metadata is never trusted from the client; executeCard derives it from the target row and final payload.
          changes: {},
        }
      : {}),
  };
}

function sanitizeRecordInteractionPayload(payload: RecordInteractionPayload): RecordInteractionPayload {
  const contactName = normalizeOptionalString(payload.contact_name);
  const summary = normalizeOptionalString(payload.summary);

  if (!contactName || !summary) {
    throw new ExecuteValidationError("record_interaction requires non-empty contact_name and summary");
  }

  if (isSelfName(contactName)) {
    throw new ExecuteValidationError('record_interaction cannot target the self contact "我"');
  }

  const contactId = ensurePositiveSafeInteger(payload.contact_id, "record_interaction.contact_id");

  return {
    ...(contactId ? { contact_id: contactId } : {}),
    contact_name: contactName,
    summary,
  };
}

function rebaseDuplicateMeetingAgenda(
  baseAgenda: string | null | undefined,
  currentAgenda: string | null | undefined,
  confirmedAgenda: string | null | undefined,
): string | null {
  const base = normalizeOptionalString(baseAgenda);
  const current = normalizeOptionalString(currentAgenda);
  const confirmed = normalizeOptionalString(confirmedAgenda);

  if (current === base || current === confirmed) {
    return confirmed;
  }

  const appendedSinceProposal = base == null
    ? current
    : current?.startsWith(`${base}；`)
      ? current.slice(base.length + 1)
      : null;

  return appendedSinceProposal
    ? appendMeetingAgenda(confirmed, [appendedSinceProposal])
    : confirmed;
}

function validatePayloadForType(type: StoredActionCard["type"], payload: unknown): StoredActionCard["payload"] {
  try {
    switch (type) {
      case "create_contact":
        return sanitizeCreateContactPayload(CreateContactPayloadSchema.parse(payload));
      case "update_contact":
        return sanitizeUpdateContactPayload(UpdateContactPayloadSchema.parse(payload));
      case "create_meeting":
        return sanitizeCreateMeetingPayload(CreateMeetingPayloadSchema.parse(payload));
      case "record_interaction":
        return sanitizeRecordInteractionPayload(RecordInteractionPayloadSchema.parse(payload));
      default:
        throw new ExecuteValidationError(`Unsupported action card type: ${String(type)}`);
    }
  } catch (error) {
    if (error instanceof ExecuteError) {
      throw error;
    }

    if (error instanceof ZodError) {
      throw new ExecuteValidationError(`Invalid ${type} payload`, error.issues);
    }

    throw error;
  }
}

function parseRawExtraction(rawExtraction: unknown): PerceptionResult | null {
  return parseStoredPerceptionResult(rawExtraction);
}

function collectRelatedParticipants(
  extraction: PerceptionResult | null,
  seedNames: string[],
): RelatedParticipantsResult {
  const normalizedSeeds = new Set(seedNames.map(normalizeLookupValue));
  const participants = extraction?.participants.filter((participant) => {
    const candidateNames = [participant.name, ...(participant.aliases ?? [])];
    return candidateNames.some((name) => normalizedSeeds.has(normalizeLookupValue(name)));
  }) ?? [];

  const names = dedupeStrings(
    participants.flatMap((participant) => [participant.name, ...(participant.aliases ?? [])]),
  );

  return { participants, names };
}

function buildObservationContext(
  contact: ContactRecord,
  extraNames: string[],
  statusChanges: StatusChangePlan[],
): ObservationContext {
  const names = dedupeStrings([contact.canonical_name, ...contact.aliases, ...extraNames]).map(
    normalizeLookupValue,
  );
  const skipStructuredFacts: ObservationContext["skipStructuredFacts"] = {};

  for (const change of statusChanges) {
    if (change.newValue) {
      skipStructuredFacts[change.field] = normalizeLookupValue(change.newValue);
    }
  }

  return {
    contactId: contact.id,
    names: new Set(names),
    skipStructuredFacts,
  };
}

function describeValue(value: string | null): string {
  return value ?? "(empty)";
}

function buildStatusChangeContent(field: ContactEditableField, oldValue: string, newValue: string | null): string {
  return `${FIELD_LABELS[field]}由 "${oldValue}" 变为 "${describeValue(newValue)}"`;
}

function buildFieldUpdatePlan(
  currentContact: ContactRecord,
  nextValues: Partial<Record<ContactEditableField, string | null | undefined>>,
  sourceQuote: string,
): {
  updates: ContactFieldUpdates;
  statusChanges: StatusChangePlan[];
  storedChanges: UpdateContactPayload["changes"];
} {
  const updates: ContactFieldUpdates = {};
  const statusChanges: StatusChangePlan[] = [];
  const storedChanges: UpdateContactPayload["changes"] = {};

  for (const field of CONTACT_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(nextValues, field)) {
      continue;
    }

    const nextValue = normalizeOptionalString(nextValues[field] ?? null);
    const currentValue = currentContact[field];
    storedChanges[field] = {
      old: currentValue,
      new: nextValue ?? "",
    };

    if (currentValue === nextValue) {
      continue;
    }

    updates[field] = nextValue;

    if (currentValue !== null) {
      statusChanges.push({
        field,
        oldValue: currentValue,
        newValue: nextValue,
        content: buildStatusChangeContent(field, currentValue, nextValue),
        sourceQuote,
      });
    }
  }

  return { updates, statusChanges, storedChanges };
}

function pickProvidedContactFieldUpdates(
  payload: Partial<Record<ContactEditableField, string | null | undefined>>,
): Partial<Record<ContactEditableField, string | null | undefined>> {
  const providedFields: Partial<Record<ContactEditableField, string | null | undefined>> = {};

  for (const field of CONTACT_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      providedFields[field] = payload[field];
    }
  }

  return providedFields;
}

function inferObservationKind(text: string): ObservationKind {
  return /喜欢|偏好|偏向|倾向|习惯|想要|希望|最好|更喜欢|方便/i.test(text)
    ? "preference"
    : "fact";
}

function participantFieldToObservation(
  field: ContactEditableField,
  value: string,
  sourceQuote: string,
): { kind: ObservationKind; content: string; field: ContactEditableField } {
  if (field === "notes") {
    return {
      kind: inferObservationKind(value),
      content: value,
      field,
    };
  }

  return {
    kind: "fact",
    content: `${FIELD_LABELS[field]}: ${value}`,
    field,
  };
}

function rawFactToObservation(
  field: PerceptionResult["facts"][number]["field"],
  value: string,
  sourceQuote: string,
): { kind: ObservationKind; content: string; field?: ContactEditableField } | null {
  switch (field) {
    case "company":
    case "title":
    case "phone":
    case "wechat_id":
      return {
        kind: "fact",
        content: `${FIELD_LABELS[field]}: ${value}`,
        field,
      };
    case "notes":
    case "other":
      return {
        kind: inferObservationKind(value),
        content: value,
        ...(field === "notes" ? { field } : {}),
      };
    case "alias":
      return null;
    default:
      return null;
  }
}

function insertDerivedObservations(args: {
  db: ExecuteStore;
  extraction: PerceptionResult | null;
  screenshotId: number;
  contexts: ObservationContext[];
  observedAt: string;
}): number[] {
  if (!args.extraction || args.contexts.length === 0) {
    return [];
  }

  const pending = new Map<string, ObservationInsertInput>();

  const addObservation = (
    contactId: number,
    kind: ObservationKind,
    content: string,
    sourceQuote: string,
    field?: ContactEditableField,
  ) => {
    const normalizedContent = normalizeOptionalString(content);
    const normalizedQuote = normalizeOptionalString(sourceQuote);

    if (!normalizedContent || !normalizedQuote) {
      return;
    }

    const context = args.contexts.find((item) => item.contactId === contactId);

    if (field && context?.skipStructuredFacts[field] === normalizeLookupValue(normalizedContent.replace(/^.+?: /u, ""))) {
      return;
    }

    const dedupeByContent = kind === "fact" || kind === "preference";
    const key = JSON.stringify(
      dedupeByContent
        ? [contactId, kind, normalizedContent]
        : [contactId, args.screenshotId, kind, normalizedContent, normalizedQuote],
    );
    const existing = pending.get(key);

    if (!existing) {
      pending.set(key, {
        contactId,
        screenshotId: args.screenshotId,
        kind,
        content: normalizedContent,
        sourceQuote: normalizedQuote,
        observedAt: args.observedAt,
      });
    } else if (
      dedupeByContent &&
      normalizedQuote.length < (existing.sourceQuote?.length ?? Number.POSITIVE_INFINITY)
    ) {
      pending.set(key, {
        ...existing,
        sourceQuote: normalizedQuote,
      });
    }
  };

  const matchContexts = (names: string[]) => {
    const normalizedNames = names.map(normalizeLookupValue);
    return args.contexts.filter((context) =>
      normalizedNames.some((name) => context.names.has(name)),
    );
  };

  for (const participant of args.extraction.participants) {
    const contexts = matchContexts([participant.name, ...(participant.aliases ?? [])]);

    if (contexts.length === 0) {
      continue;
    }

    for (const context of contexts) {
      for (const field of CONTACT_EDITABLE_FIELDS) {
        const value = normalizeOptionalString(participant[field]);
        if (!value) {
          continue;
        }

        const candidate = participantFieldToObservation(field, value, participant.source_quote);
        addObservation(
          context.contactId,
          candidate.kind,
          candidate.content,
          shortestSupportingQuote(participant.source_quote, value),
          candidate.field,
        );
      }
    }
  }

  for (const fact of args.extraction.facts) {
    const contexts = matchContexts([fact.subject_name]);
    const value = normalizeOptionalString(fact.value);

    if (contexts.length === 0 || !value) {
      continue;
    }

    const candidate = rawFactToObservation(fact.field, value, fact.source_quote);

    if (!candidate) {
      continue;
    }

    for (const context of contexts) {
      addObservation(context.contactId, candidate.kind, candidate.content, fact.source_quote, candidate.field);
    }
  }

  return [...pending.values()].map((input) => args.db.insertObservationIfAbsent(input).id);
}

function resolveMeetingContacts(db: ExecuteStore, participants: MeetingParticipant[]): ContactRecord[] {
  return participants
    .filter((participant): participant is MeetingParticipant & { contact_id: number } => participant.contact_id != null)
    .map((participant) => {
      const contact = db.getContactById(participant.contact_id);
      if (!contact) {
        throw new ExecuteDependencyError(
          `Meeting participant contact ${participant.contact_id} does not exist`,
        );
      }

      return contact;
    });
}

function findSiblingResolvedContactIdsForDisplayedName(args: {
  db: ExecuteStore;
  screenshotId: number;
  extraction: PerceptionResult | null;
  displayedName: string;
}): number[] {
  const relatedParticipants = collectRelatedParticipants(args.extraction, [args.displayedName]);

  return args.db.findResolvedContactIdsForConfirmedSiblingCreateCards({
    screenshotId: args.screenshotId,
    displayedNames: dedupeStrings([args.displayedName, ...relatedParticipants.names]),
  });
}

type SiblingCreateContactCard = {
  name: string;
  status: StoredActionCardRecord["status"];
};

function findSiblingCreateContactCardsForDisplayedName(args: {
  db: ExecuteStore;
  screenshotId: number;
  extraction: PerceptionResult | null;
  displayedName: string;
}): SiblingCreateContactCard[] {
  const relatedParticipants = collectRelatedParticipants(args.extraction, [args.displayedName]);
  const displayedNames = new Set(
    dedupeStrings([args.displayedName, ...relatedParticipants.names]).map(normalizeLookupValue),
  );

  return (args.db.getScreenshotDetail(args.screenshotId)?.cards ?? []).flatMap((card) => {
    if (card.type !== "create_contact") {
      return [];
    }

    const candidateNames = dedupeStrings([
      card.payload.name,
      ...(card.payload.aliases ?? []),
    ]);

    if (!candidateNames.some((name) => displayedNames.has(normalizeLookupValue(name)))) {
      return [];
    }

    return [{ name: card.payload.name, status: card.status }];
  });
}

function hydrateMeetingParticipants(args: {
  db: ExecuteStore;
  screenshotId: number;
  extraction: PerceptionResult | null;
  participants: MeetingParticipant[];
}): MeetingParticipant[] {
  const { db, screenshotId, extraction, participants } = args;

  return participants.map((participant) => {
    if (isSelfMeetingParticipantName(participant.name)) {
      return { name: "我" };
    }

    if (participant.contact_id != null) {
      const contact = db.getContactById(participant.contact_id);
      if (contact && isHistoricalSelfContact(contact)) {
        return { name: "我" };
      }

      return participant;
    }

    const matchedContactIds = findSiblingResolvedContactIdsForDisplayedName({
      db,
      screenshotId,
      extraction,
      displayedName: participant.name,
    });

    if (matchedContactIds.length !== 1) {
      return participant;
    }

    const matchedContact = db.getContactById(matchedContactIds[0]);

    if (!matchedContact) {
      throw new ExecuteDependencyError(`Contact ${matchedContactIds[0]} does not exist`);
    }

    if (isHistoricalSelfContact(matchedContact)) {
      return { name: "我" };
    }

    return {
      contact_id: matchedContactIds[0],
      name: participant.name,
    };
  });
}

export function executeCard({ db, cardId, payload, resolvedContactId }: ExecuteCardInput): ExecuteResult {
  ensurePositiveSafeInteger(cardId, "cardId");
  const normalizedResolvedContactId = ensurePositiveSafeInteger(
    resolvedContactId,
    "resolvedContactId",
  );
  const executedAt = new Date().toISOString();

  return db.withTransaction(() => {
    const card = db.getStoredActionCardById(cardId);

    if (!card) {
      throw new ExecuteNotFoundError(`Action card ${cardId} not found`);
    }

    if (card.status !== "pending") {
      throw new ActionCardConflictError(`Action card ${cardId} is already ${card.status}`);
    }

    const screenshot = db.getScreenshotById(card.screenshot_id);

    if (!screenshot) {
      throw new ExecuteDependencyError(`Screenshot ${card.screenshot_id} does not exist`);
    }

    const confirmedPayload = validatePayloadForType(card.type, payload ?? card.payload);
    const extraction = parseRawExtraction(screenshot.raw_extraction);
    const observationIds: number[] = [];
    let meetingId: number | undefined;
    let affectedContactIds: number[] = [];
    let cardResolvedContactId: number | null = null;
    let storedPayload: StoredActionCard["payload"] = confirmedPayload;
    const observationContexts: ObservationContext[] = [];

    switch (card.type) {
      case "create_contact": {
        const typedPayload = confirmedPayload as CreateContactPayload;
        const relatedParticipants = collectRelatedParticipants(extraction, [
          typedPayload.name,
          ...(typedPayload.aliases ?? []),
        ]);
        const screenshotNames = dedupeStrings([
          typedPayload.name,
          ...(typedPayload.aliases ?? []),
          ...relatedParticipants.names,
        ]);
        assertNoSelfContactNames(screenshotNames);

        if (normalizedResolvedContactId != null) {
          const allowedIds = new Set(card.disambiguation?.candidates.map((candidate) => candidate.contact_id) ?? []);

          if (!allowedIds.has(normalizedResolvedContactId)) {
            throw new ExecuteDependencyError(
              `resolvedContactId ${normalizedResolvedContactId} is not in the disambiguation candidates`,
            );
          }

          const existingContact = db.getContactById(normalizedResolvedContactId);
          if (!existingContact) {
            throw new ExecuteDependencyError(`Contact ${normalizedResolvedContactId} does not exist`);
          }

          if (isHistoricalSelfContact(existingContact)) {
            throw new ExecuteValidationError('create_contact cannot create or merge the self contact "我"');
          }

          const contactWithAliases = db.appendContactAliases(
            existingContact.id,
            screenshotNames,
            executedAt,
          );

          if (!contactWithAliases) {
            throw new ExecuteDependencyError(`Contact ${normalizedResolvedContactId} does not exist`);
          }

          const updatePlan = buildFieldUpdatePlan(
            contactWithAliases,
            pickProvidedContactFieldUpdates(typedPayload),
            card.source_quote,
          );

          const updatedContact =
            Object.keys(updatePlan.updates).length > 0
              ? db.updateContactFields(contactWithAliases.id, updatePlan.updates, executedAt)
              : contactWithAliases;

          if (!updatedContact) {
            throw new ExecuteDependencyError(`Contact ${normalizedResolvedContactId} does not exist`);
          }

          for (const change of updatePlan.statusChanges) {
            observationIds.push(
              db.insertObservationIfAbsent({
                contactId: updatedContact.id,
                screenshotId: screenshot.id,
                kind: "status_change",
                content: change.content,
                sourceQuote: change.sourceQuote,
                observedAt: executedAt,
              }).id,
            );
          }

          storedPayload = sanitizeCreateContactPayload({
            ...typedPayload,
            aliases: dedupeStrings([...(typedPayload.aliases ?? []), ...relatedParticipants.names]).filter(
              (alias) => alias !== typedPayload.name,
            ),
          });
          cardResolvedContactId = updatedContact.id;
          affectedContactIds = [updatedContact.id];
          observationContexts.push(
            buildObservationContext(updatedContact, screenshotNames, updatePlan.statusChanges),
          );
          break;
        }

        const newContact = db.createContact({
          canonicalName: typedPayload.name,
          aliases: screenshotNames.filter((name) => name !== typedPayload.name),
          company: typedPayload.company,
          title: typedPayload.title,
          phone: typedPayload.phone,
          wechat_id: typedPayload.wechat_id,
          notes: typedPayload.notes,
          createdAt: executedAt,
          updatedAt: executedAt,
        });

        storedPayload = sanitizeCreateContactPayload({
          ...typedPayload,
          aliases: screenshotNames.filter((name) => name !== typedPayload.name),
        });
        cardResolvedContactId = newContact.id;
        affectedContactIds = [newContact.id];
        observationContexts.push(buildObservationContext(newContact, screenshotNames, []));
        break;
      }

      case "update_contact": {
        const typedPayload = confirmedPayload as UpdateContactPayload;
        const existingContact = db.getContactById(typedPayload.contact_id);

        if (!existingContact) {
          throw new ExecuteDependencyError(`Contact ${typedPayload.contact_id} does not exist`);
        }

        if (isHistoricalSelfContact(existingContact)) {
          throw new ExecuteValidationError('update_contact cannot target the self contact "我"');
        }

        const aliasAdditions = typedPayload.changes.aliases
          ? parseAliasChange(typedPayload.changes.aliases.new)
          : [];
        const relatedParticipants = collectRelatedParticipants(extraction, [
          typedPayload.contact_name,
          existingContact.canonical_name,
          ...existingContact.aliases,
          ...aliasAdditions,
        ]);
        const contactWithAliases = aliasAdditions.length > 0
          ? db.appendContactAliases(existingContact.id, aliasAdditions, executedAt)
          : existingContact;

        if (!contactWithAliases) {
          throw new ExecuteDependencyError(`Contact ${typedPayload.contact_id} does not exist`);
        }

        const updatePlan = buildFieldUpdatePlan(
          contactWithAliases,
          Object.fromEntries(
            Object.entries(typedPayload.changes)
              .filter(([field]) => field !== "aliases")
              .map(([field, change]) => [field, change.new]),
          ),
          card.source_quote,
        );
        const updatedContact =
          Object.keys(updatePlan.updates).length > 0
            ? db.updateContactFields(contactWithAliases.id, updatePlan.updates, executedAt)
            : contactWithAliases;

        if (!updatedContact) {
          throw new ExecuteDependencyError(`Contact ${typedPayload.contact_id} does not exist`);
        }

        for (const change of updatePlan.statusChanges) {
          observationIds.push(
            db.insertObservationIfAbsent({
              contactId: updatedContact.id,
              screenshotId: screenshot.id,
              kind: "status_change",
              content: change.content,
              sourceQuote: change.sourceQuote,
              observedAt: executedAt,
            }).id,
          );
        }

        const aliasesChanged = existingContact.aliases.length !== contactWithAliases.aliases.length ||
          existingContact.aliases.some((alias, index) => alias !== contactWithAliases.aliases[index]);
        const storedAliasChange: UpdateContactPayload["changes"] = {};
        if (aliasesChanged) {
          storedAliasChange.aliases = {
            old: existingContact.aliases.length > 0 ? existingContact.aliases.join("，") : null,
            new: aliasAdditions.join("，"),
          };
        }
        storedPayload = {
          contact_id: updatedContact.id,
          contact_name: typedPayload.contact_name,
          changes: {
            ...storedAliasChange,
            ...updatePlan.storedChanges,
          },
        };
        cardResolvedContactId = updatedContact.id;
        affectedContactIds = [updatedContact.id];
        observationContexts.push(
          buildObservationContext(
            updatedContact,
            dedupeStrings([typedPayload.contact_name, ...relatedParticipants.names]),
            updatePlan.statusChanges,
          ),
        );
        break;
      }

      case "create_meeting": {
        const typedPayload = confirmedPayload as CreateMeetingPayload;
        const storedMeetingPayload = card.payload as CreateMeetingPayload;
        const storedDuplicateMeetingId = ensurePositiveSafeInteger(
          storedMeetingPayload.duplicate_of_meeting_id,
          "stored duplicate_of_meeting_id",
        );
        const storedAgendaAppend = normalizeOptionalString(storedMeetingPayload.agenda_append);
        const confirmedAgendaAppend = normalizeOptionalString(typedPayload.agenda_append);

        if (typedPayload.duplicate_of_meeting_id !== storedDuplicateMeetingId) {
          throw new ExecuteValidationError(
            "create_meeting cannot change duplicate_of_meeting_id during confirmation",
          );
        }

        if ((storedAgendaAppend == null) !== (confirmedAgendaAppend == null)) {
          throw new ExecuteValidationError(
            "create_meeting cannot change agenda append mode during confirmation",
          );
        }

        const existingMeeting = storedDuplicateMeetingId == null
          ? undefined
          : db.listMeetings().find((meeting) => meeting.id === storedDuplicateMeetingId);

        if (storedDuplicateMeetingId != null && !existingMeeting) {
          throw new ExecuteDependencyError(
            `Meeting ${storedDuplicateMeetingId} does not exist`,
          );
        }

        if (existingMeeting && (typedPayload.kind ?? "meeting") !== existingMeeting.kind) {
          throw new ExecuteValidationError(
            "create_meeting cannot change the kind of a duplicate target",
          );
        }

        const isAgendaAppend = storedAgendaAppend != null;
        const storedAgendaChange = storedMeetingPayload.changes?.agenda;
        const agendaAtProposal = storedAgendaChange
          ? storedAgendaChange.old
          : storedMeetingPayload.agenda;
        const hydratedParticipants = isAgendaAppend
          ? existingMeeting!.participants.map((participant) => ({ ...participant }))
          : hydrateMeetingParticipants({
              db,
              screenshotId: screenshot.id,
              extraction,
              participants: typedPayload.participants,
            });
        const meetingInput: MeetingWriteInput = isAgendaAppend
          ? {
              kind: existingMeeting!.kind,
              title: existingMeeting!.title,
              timeIso: existingMeeting!.time_iso,
              timeText: existingMeeting!.time_text,
              location: existingMeeting!.location,
              participants: hydratedParticipants,
              agenda: appendMeetingAgenda(existingMeeting!.agenda, [confirmedAgendaAppend!]),
              sourceScreenshotId: screenshot.id,
            }
          : {
              kind: typedPayload.kind ?? "meeting",
              title: typedPayload.title,
              timeIso: typedPayload.time_iso,
              timeText: typedPayload.time_text,
              location: typedPayload.location ?? null,
              participants: hydratedParticipants,
              agenda: existingMeeting
                ? rebaseDuplicateMeetingAgenda(
                    agendaAtProposal,
                    existingMeeting.agenda,
                    typedPayload.agenda,
                  )
                : typedPayload.agenda ?? null,
              sourceScreenshotId: screenshot.id,
            };
        const meeting = existingMeeting == null
          ? db.insertMeeting({ ...meetingInput, createdAt: executedAt })
          : db.updateMeeting(existingMeeting.id, meetingInput);

        if (!meeting) {
          throw new ExecuteDependencyError(
            `Meeting ${storedDuplicateMeetingId} does not exist`,
          );
        }

        const meetingContacts = resolveMeetingContacts(db, hydratedParticipants);
        meetingId = meeting.id;
        affectedContactIds = [...new Set(meetingContacts.map((contact) => contact.id))];

        for (const participant of hydratedParticipants) {
          if (participant.contact_id == null) {
            continue;
          }

          const contact = meetingContacts.find((candidate) => candidate.id === participant.contact_id);
          if (!contact) {
            continue;
          }

          observationContexts.push(
            buildObservationContext(contact, [participant.name], []),
          );
        }

        const finalMeetingPayload: CreateMeetingPayload = {
          ...typedPayload,
          kind: meetingInput.kind,
          title: meetingInput.title,
          time_iso: meetingInput.timeIso,
          time_text: meetingInput.timeText,
          ...(meetingInput.location ? { location: meetingInput.location } : { location: undefined }),
          participants: hydratedParticipants,
          ...(meetingInput.agenda ? { agenda: meetingInput.agenda } : { agenda: undefined }),
          ...(confirmedAgendaAppend ? { agenda_append: confirmedAgendaAppend } : {}),
        };
        storedPayload = existingMeeting
          ? {
              ...finalMeetingPayload,
              changes: buildMeetingChanges(existingMeeting, finalMeetingPayload),
            }
          : finalMeetingPayload;
        break;
      }

      case "record_interaction": {
        const typedPayload = confirmedPayload as RecordInteractionPayload;
        const matchedSiblingContactIds =
          typedPayload.contact_id == null
            ? findSiblingResolvedContactIdsForDisplayedName({
                db,
                screenshotId: screenshot.id,
                extraction,
                displayedName: typedPayload.contact_name,
              })
            : [];
        const siblingCreateContactCards =
          typedPayload.contact_id == null
            ? findSiblingCreateContactCardsForDisplayedName({
                db,
                screenshotId: screenshot.id,
                extraction,
                displayedName: typedPayload.contact_name,
              })
            : [];

        if (typedPayload.contact_id == null && matchedSiblingContactIds.length > 1) {
          throw new ExecuteDependencyError(
            `同名联系人有 ${matchedSiblingContactIds.length} 个，请在卡片上选择具体是谁`,
            {
              screenshot_id: screenshot.id,
              matched_contact_ids: matchedSiblingContactIds,
            },
          );
        }

        if (typedPayload.contact_id == null && matchedSiblingContactIds.length === 0) {
          const pendingSibling = siblingCreateContactCards.find((card) => card.status === "pending");
          const rejectedSibling = siblingCreateContactCards.find((card) => card.status === "rejected");
          const message = pendingSibling
            ? `请先确认『新建联系人 ${pendingSibling.name}』那张卡`
            : rejectedSibling
              ? `这张互动依赖的『新建联系人 ${rejectedSibling.name}』已被跳过，请把这张也跳过，或先手动新建该联系人`
              : "这张互动还没关联到任何联系人，请先在本批新建或选择对应的联系人";

          throw new ExecuteDependencyError(message, {
            screenshot_id: screenshot.id,
            matched_contact_ids: matchedSiblingContactIds,
          });
        }

        const summaryContactId = typedPayload.contact_id ?? matchedSiblingContactIds[0];

        const contact = db.getContactById(summaryContactId);

        if (!contact) {
          throw new ExecuteDependencyError(`Contact ${summaryContactId} does not exist`);
        }

        if (isHistoricalSelfContact(contact)) {
          throw new ExecuteValidationError('record_interaction cannot target the self contact "我"');
        }

        const relatedParticipants = collectRelatedParticipants(extraction, [
          typedPayload.contact_name,
          contact.canonical_name,
          ...contact.aliases,
        ]);

        const existingInteraction = db.findObservationByContactAndScreenshot({
          contactId: contact.id,
          screenshotId: screenshot.id,
          kind: "interaction",
        });

        observationIds.push(
          existingInteraction?.id ??
            db.insertObservationIfAbsent({
              contactId: contact.id,
              screenshotId: screenshot.id,
              kind: "interaction",
              content: typedPayload.summary,
              sourceQuote: card.source_quote,
              observedAt: executedAt,
            }).id,
        );

        storedPayload = {
          contact_id: contact.id,
          contact_name: typedPayload.contact_name,
          summary: typedPayload.summary,
        };
        cardResolvedContactId = contact.id;
        affectedContactIds = [contact.id];
        observationContexts.push(
          buildObservationContext(
            contact,
            dedupeStrings([typedPayload.contact_name, ...relatedParticipants.names]),
            [],
          ),
        );
        break;
      }

      default:
        throw new ExecuteValidationError("Unsupported action card type");
    }

    observationIds.push(
      ...insertDerivedObservations({
        db,
        extraction,
        screenshotId: screenshot.id,
        contexts: observationContexts,
        observedAt: executedAt,
      }),
    );

    const confirmedCard = db.confirmActionCardIfPending({
      cardId,
      payload: storedPayload,
      resolvedContactId: cardResolvedContactId,
      resolvedAt: executedAt,
    });

    if (!confirmedCard) {
      throw new ActionCardConflictError(`Action card ${cardId} is no longer pending`);
    }

    return {
      confirmedCard,
      affectedContactIds: [...new Set(affectedContactIds)],
      observationIds: [...new Set(observationIds)],
      ...(meetingId != null ? { meetingId } : {}),
    };
  });
}

export function rejectCard({ db, cardId }: RejectCardInput): StoredActionCardRecord {
  ensurePositiveSafeInteger(cardId, "cardId");

  return db.withTransaction(() => {
    const card = db.getStoredActionCardById(cardId);

    if (!card) {
      throw new ExecuteNotFoundError(`Action card ${cardId} not found`);
    }

    if (card.status !== "pending") {
      throw new ActionCardConflictError(`Action card ${cardId} is already ${card.status}`);
    }

    const rejectedCard = db.rejectActionCardIfPending(cardId, new Date().toISOString());

    if (!rejectedCard) {
      throw new ActionCardConflictError(`Action card ${cardId} is no longer pending`);
    }

    return rejectedCard;
  });
}

export type ReopenCardInput = {
  db: ExecuteStore & {
    reopenActionCardIfRejected(cardId: number): StoredActionCardRecord | null;
  };
  cardId: number;
};

// Symmetric with rejectCard: only a previously-rejected card can be reopened back to
// pending. Deliberately typed with a narrow intersection (ExecuteStore + the one new
// method) instead of widening the shared ExecuteStore interface itself, so servers
// backed by a store that doesn't support reopening (no client calls it there; that path
// answers with a "not supported" placeholder instead) keep type-checking unchanged.
export function reopenCard({ db, cardId }: ReopenCardInput): StoredActionCardRecord {
  ensurePositiveSafeInteger(cardId, "cardId");

  return db.withTransaction(() => {
    const card = db.getStoredActionCardById(cardId);

    if (!card) {
      throw new ExecuteNotFoundError(`Action card ${cardId} not found`);
    }

    if (card.status !== "rejected") {
      throw new ActionCardConflictError(`Action card ${cardId} is already ${card.status}`);
    }

    const reopenedCard = db.reopenActionCardIfRejected(cardId);

    if (!reopenedCard) {
      throw new ActionCardConflictError(`Action card ${cardId} is no longer rejected`);
    }

    return reopenedCard;
  });
}
