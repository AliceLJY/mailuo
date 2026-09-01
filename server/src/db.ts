import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  isMeetingKind,
  type ActionCard,
  type ActionCardConfidence,
  type ActionCardRecord,
  type CreateContactPayload,
  type CreateMeetingPayload,
  type MeetingKind,
  type RecordInteractionPayload as SharedRecordInteractionPayload,
  type UpdateContactPayload,
} from "../../shared/types.ts";
import type { ExecuteStore } from "../../shared/core/agent/execute.ts";
import type {
  InsightGenerationDb,
  InsightGenerationEntry,
} from "../../shared/core/agent/insight.ts";
import { initializeMailuoSchema } from "../../shared/core/migrations.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultDatabasePath = resolve(currentDir, "..", "data", "mailuo.sqlite");

export const CONTACT_EDITABLE_FIELDS = [
  "company",
  "title",
  "phone",
  "wechat_id",
  "notes",
] as const;

export type ContactEditableField = (typeof CONTACT_EDITABLE_FIELDS)[number];
export type ObservationKind = "fact" | "preference" | "status_change" | "interaction";
export type InsightKind = "relationship_read" | "suggested_action" | "conversation_hook";

export type ContactRecord = {
  id: number;
  canonical_name: string;
  aliases: string[];
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat_id: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ContactSummary = Pick<ContactRecord, "id" | "canonical_name" | "aliases" | "company">;

export type ContactListItem = ContactRecord & {
  observation_count: number;
  last_interaction_at: string | null;
};

export type ObservationRecord = {
  id: number;
  contact_id: number;
  screenshot_id: number | null;
  kind: ObservationKind;
  content: string;
  source_quote: string | null;
  observed_at: string;
};

export type MeetingParticipant = {
  contact_id?: number;
  name: string;
};

export type MeetingRecord = {
  id: number;
  kind: MeetingKind;
  title: string;
  time_iso: string | null;
  time_text: string;
  location: string | null;
  participants: MeetingParticipant[];
  agenda: string | null;
  source_screenshot_id: number | null;
  status: string;
  created_at: string;
};

export type InsightRecord = {
  id: number;
  contact_id: number;
  kind: InsightKind;
  content: string;
  based_on: number[];
  generated_at: string;
};

export type ContactDetail = {
  contact: ContactRecord;
  observations: ObservationRecord[];
  insights: InsightRecord[];
};

export type ContactInsightContext = {
  contact: ContactRecord;
  observations: ObservationRecord[];
  recentInsights: InsightRecord[];
};

export type RecordInteractionPayload = SharedRecordInteractionPayload;
export type StoredActionCard = ActionCard;
export type StoredActionCardRecord = ActionCardRecord;

export type ScreenshotRecord = {
  id: number;
  image_path: string;
  user_note: string | null;
  raw_extraction: unknown;
  uploaded_at: string;
};

export type ScreenshotDetail = ScreenshotRecord & {
  cards: StoredActionCardRecord[];
};

type ScreenshotInsertInput = {
  imagePath: string;
  userNote?: string | null;
  uploadedAt?: string;
};

type ScreenshotAnalysisInput = {
  screenshotId: number;
  rawExtraction: unknown;
  cards: ActionCard[];
  createdAt?: string;
};

export type ActionCardInsertInput = {
  screenshotId: number;
  card: StoredActionCard;
  createdAt?: string;
};

export type ContactCreateInput = {
  canonicalName: string;
  aliases?: string[];
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  wechat_id?: string | null;
  tags?: string[];
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ContactFieldUpdates = Partial<Record<ContactEditableField, string | null>>;

export type ObservationInsertInput = {
  contactId: number;
  screenshotId?: number | null;
  kind: ObservationKind;
  content: string;
  sourceQuote?: string | null;
  observedAt?: string;
};

export type MeetingInsertInput = {
  kind: MeetingKind;
  title: string;
  timeIso: string | null;
  timeText: string;
  location?: string | null;
  participants: MeetingParticipant[];
  agenda?: string | null;
  sourceScreenshotId?: number | null;
  status?: string;
  createdAt?: string;
};

export type InsightInsertInput = {
  contactId: number;
  kind: InsightKind;
  content: string;
  basedOn: number[];
  generatedAt?: string;
};

type InsightInsertEntry =
  | InsightInsertInput
  | {
      contact_id: number;
      kind: InsightKind;
      content: string;
      based_on: number[];
      generated_at?: string;
    };

type ActionCardResolutionInput = {
  cardId: number;
  status: "confirmed" | "rejected";
  payload?: StoredActionCard["payload"];
  resolvedContactId?: number | null;
  resolvedAt: string;
};

type ContactRow = {
  id: number | bigint;
  canonical_name: string;
  aliases: string;
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat_id: string | null;
  tags: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type ObservationRow = {
  id: number | bigint;
  contact_id: number | bigint;
  screenshot_id: number | bigint | null;
  kind: ObservationKind;
  content: string;
  source_quote: string | null;
  observed_at: string;
};

type MeetingRow = {
  id: number | bigint;
  kind: string;
  title: string;
  time_iso: string | null;
  time_text: string;
  location: string | null;
  participants: string;
  agenda: string | null;
  source_screenshot_id: number | bigint | null;
  status: string;
  created_at: string;
};

type InsightRow = {
  id: number | bigint;
  contact_id: number | bigint;
  kind: InsightKind;
  content: string;
  based_on: string;
  generated_at: string;
};

type StoredActionCardRow = {
  id: number | bigint;
  screenshot_id: number | bigint;
  type: StoredActionCard["type"];
  payload: string;
  confidence: ActionCardConfidence;
  source_quote: string;
  disambiguation: string | null;
  status: StoredActionCardRecord["status"];
  resolved_contact_id: number | bigint | null;
  created_at: string;
  resolved_at: string | null;
};

type ConfirmedCreateContactSiblingRow = {
  payload: string;
  resolved_contact_id: number | bigint;
};

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function parseJsonArray<T>(value: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeLookupValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export class MailuoDb implements InsightGenerationDb, ExecuteStore {
  private readonly db: DatabaseSync;

  constructor(databasePath = process.env.DATABASE_PATH?.trim() || defaultDatabasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    const originalPrepare = this.db.prepare.bind(this.db);
    this.db.prepare = ((sql: string) => this.normalizeStatement(originalPrepare(sql))) as DatabaseSync["prepare"];
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initializeSchema();
  }

  private initializeSchema() {
    initializeMailuoSchema({
      exec: (sql) => this.db.exec(sql),
      getUserVersion: () => {
        const row = this.db.prepare("PRAGMA user_version").get() as
          | { user_version: number | bigint }
          | undefined;

        if (!row) {
          throw new Error("SQLite did not return PRAGMA user_version");
        }

        return this.toSafeInteger(row.user_version, "user_version");
      },
    });
  }

  private normalizeQueryResult<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeQueryResult(item)) as T;
    }

    if (value && typeof value === "object" && Object.getPrototypeOf(value) === null) {
      return { ...value } as T;
    }

    return value;
  }

  private normalizeStatement(statement: StatementSync): StatementSync {
    const originalAll = statement.all.bind(statement);
    statement.all = ((...args: Parameters<StatementSync["all"]>) =>
      this.normalizeQueryResult(originalAll(...args))) as StatementSync["all"];

    const originalGet = statement.get.bind(statement);
    statement.get = ((...args: Parameters<StatementSync["get"]>) =>
      this.normalizeQueryResult(originalGet(...args))) as StatementSync["get"];

    const originalIterate = statement.iterate.bind(statement);
    statement.iterate = ((...args: Parameters<StatementSync["iterate"]>) => {
      const iterator = originalIterate(...args);
      const self = this;

      return (function* () {
        for (const row of iterator) {
          yield self.normalizeQueryResult(row);
        }
      })();
    }) as StatementSync["iterate"];

    return statement;
  }

  public withTransaction<T>(callback: () => T): T {
    this.db.exec("BEGIN");

    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure if rollback itself also fails.
      }

      throw error;
    }
  }

  private toSafeInteger(value: number | bigint, fieldName: string): number {
    if (typeof value === "bigint") {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new RangeError(`SQLite ${fieldName} exceeds Number safe integer range: ${value}`);
      }

      return Number(value);
    }

    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`SQLite ${fieldName} is not a safe integer: ${value}`);
    }

    return value;
  }

  private toNullableSafeInteger(
    value: number | bigint | null | undefined,
    fieldName: string,
  ): number | null {
    if (value == null) {
      return null;
    }

    return this.toSafeInteger(value, fieldName);
  }

  private hydrateContact(row: ContactRow | undefined): ContactRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: this.toSafeInteger(row.id, "contacts.id"),
      canonical_name: row.canonical_name,
      aliases: dedupeStrings(parseJsonArray<string>(row.aliases, [])),
      company: row.company,
      title: row.title,
      phone: row.phone,
      wechat_id: row.wechat_id,
      tags: dedupeStrings(parseJsonArray<string>(row.tags, [])),
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private hydrateObservation(row: ObservationRow | undefined): ObservationRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: this.toSafeInteger(row.id, "observations.id"),
      contact_id: this.toSafeInteger(row.contact_id, "observations.contact_id"),
      screenshot_id: this.toNullableSafeInteger(row.screenshot_id, "observations.screenshot_id"),
      kind: row.kind,
      content: row.content,
      source_quote: row.source_quote,
      observed_at: row.observed_at,
    };
  }

  private hydrateMeeting(row: MeetingRow | undefined): MeetingRecord | null {
    if (!row) {
      return null;
    }

    if (!isMeetingKind(row.kind)) {
      throw new TypeError(`Invalid meetings.kind: ${row.kind}`);
    }

    const participants = parseJsonArray<MeetingParticipant>(row.participants, []).map((participant) => ({
      ...(participant.contact_id != null ? { contact_id: participant.contact_id } : {}),
      name: participant.name,
    }));

    return {
      id: this.toSafeInteger(row.id, "meetings.id"),
      kind: row.kind,
      title: row.title,
      time_iso: row.time_iso,
      time_text: row.time_text,
      location: row.location,
      participants,
      agenda: row.agenda,
      source_screenshot_id: this.toNullableSafeInteger(
        row.source_screenshot_id,
        "meetings.source_screenshot_id",
      ),
      status: row.status,
      created_at: row.created_at,
    };
  }

  private hydrateInsight(row: InsightRow | undefined): InsightRecord | null {
    if (!row) {
      return null;
    }

    const basedOn = parseJsonArray<number | string>(row.based_on, []).map((value, index) => {
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value;
      }

      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) {
          return parsed;
        }
      }

      throw new TypeError(`Invalid insights.based_on[${index}] value: ${String(value)}`);
    });

    return {
      id: this.toSafeInteger(row.id, "insights.id"),
      contact_id: this.toSafeInteger(row.contact_id, "insights.contact_id"),
      kind: row.kind,
      content: row.content,
      based_on: basedOn,
      generated_at: row.generated_at,
    };
  }

  private hydrateStoredActionCard(row: StoredActionCardRow | undefined): StoredActionCardRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: this.toSafeInteger(row.id, "action_cards.id"),
      screenshot_id: this.toSafeInteger(row.screenshot_id, "action_cards.screenshot_id"),
      type: row.type,
      payload: JSON.parse(row.payload),
      confidence: row.confidence,
      source_quote: row.source_quote,
      disambiguation: row.disambiguation ? JSON.parse(row.disambiguation) : null,
      status: row.status,
      resolved_contact_id: this.toNullableSafeInteger(
        row.resolved_contact_id,
        "action_cards.resolved_contact_id",
      ),
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    };
  }

  createScreenshot(input: ScreenshotInsertInput): ScreenshotRecord {
    const uploadedAt = input.uploadedAt ?? new Date().toISOString();
    const statement = this.db.prepare(
      `INSERT INTO screenshots (image_path, user_note, uploaded_at)
       VALUES (?, ?, ?)`,
    );
    const result = statement.run(input.imagePath, input.userNote ?? null, uploadedAt);
    return {
      id: this.toSafeInteger(result.lastInsertRowid, "lastInsertRowid"),
      image_path: input.imagePath,
      user_note: input.userNote ?? null,
      raw_extraction: null,
      uploaded_at: uploadedAt,
    };
  }

  saveScreenshotAnalysis(input: ScreenshotAnalysisInput): ActionCardRecord[] {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updateScreenshot = this.db.prepare(
      `UPDATE screenshots
       SET raw_extraction = ?
       WHERE id = ?`,
    );

    return this.withTransaction(() => {
      updateScreenshot.run(JSON.stringify(input.rawExtraction), input.screenshotId);

      return input.cards.map((card) => {
        const inserted = this.insertActionCard({
          screenshotId: input.screenshotId,
          card,
          createdAt,
        });

        return inserted as ActionCardRecord;
      });
    });
  }

  insertActionCard(input: ActionCardInsertInput): StoredActionCardRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO action_cards (
           screenshot_id,
           type,
           payload,
           confidence,
           source_quote,
           disambiguation,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.screenshotId,
        input.card.type,
        JSON.stringify(input.card.payload),
        input.card.confidence,
        input.card.source_quote,
        input.card.disambiguation ? JSON.stringify(input.card.disambiguation) : null,
        createdAt,
      );

    return {
      id: this.toSafeInteger(result.lastInsertRowid, "lastInsertRowid"),
      screenshot_id: input.screenshotId,
      type: input.card.type,
      payload: input.card.payload,
      confidence: input.card.confidence,
      source_quote: input.card.source_quote,
      disambiguation: input.card.disambiguation ?? null,
      status: "pending",
      resolved_contact_id: null,
      created_at: createdAt,
      resolved_at: null,
    } as StoredActionCardRecord;
  }

  getScreenshotById(screenshotId: number): ScreenshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, image_path, user_note, raw_extraction, uploaded_at
         FROM screenshots
         WHERE id = ?`,
      )
      .get(screenshotId) as
      | {
          id: number | bigint;
          image_path: string;
          user_note: string | null;
          raw_extraction: string | null;
          uploaded_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: this.toSafeInteger(row.id, "screenshots.id"),
      image_path: row.image_path,
      user_note: row.user_note,
      raw_extraction: row.raw_extraction ? JSON.parse(row.raw_extraction) : null,
      uploaded_at: row.uploaded_at,
    };
  }

  getScreenshotDetail(screenshotId: number): ScreenshotDetail | null {
    const screenshot = this.getScreenshotById(screenshotId);

    if (!screenshot) {
      return null;
    }

    return {
      ...screenshot,
      cards: this.listStoredActionCardsByScreenshotId(screenshotId),
    };
  }

  getStoredActionCardById(cardId: number): StoredActionCardRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           id,
           screenshot_id,
           type,
           payload,
           confidence,
           source_quote,
           disambiguation,
           status,
           resolved_contact_id,
           created_at,
           resolved_at
         FROM action_cards
         WHERE id = ?`,
      )
      .get(cardId) as StoredActionCardRow | undefined;

    return this.hydrateStoredActionCard(row);
  }

  listStoredActionCardsByScreenshotId(screenshotId: number): StoredActionCardRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           screenshot_id,
           type,
           payload,
           confidence,
           source_quote,
           disambiguation,
           status,
           resolved_contact_id,
           created_at,
           resolved_at
         FROM action_cards
         WHERE screenshot_id = ?
         ORDER BY id ASC`,
      )
      .all(screenshotId) as StoredActionCardRow[];

    return rows
      .map((row) => this.hydrateStoredActionCard(row))
      .filter((card): card is StoredActionCardRecord => card !== null);
  }

  listActionCardsByScreenshotId(screenshotId: number): ActionCardRecord[] {
    return this.listStoredActionCardsByScreenshotId(screenshotId);
  }

  findResolvedContactIdsForConfirmedSiblingCreateCards(args: {
    screenshotId: number;
    displayedNames: string[];
  }): number[] {
    const normalizedDisplayedNames = new Set(
      dedupeStrings(args.displayedNames).map(normalizeLookupValue),
    );

    if (normalizedDisplayedNames.size === 0) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT payload, resolved_contact_id
         FROM action_cards
         WHERE screenshot_id = ?
           AND type = 'create_contact'
           AND status = 'confirmed'
           AND resolved_contact_id IS NOT NULL
         ORDER BY id ASC`,
      )
      .all(args.screenshotId) as ConfirmedCreateContactSiblingRow[];
    const matchedIds = new Set<number>();

    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Partial<CreateContactPayload> | null;
      const candidateNames = dedupeStrings([
        payload?.name,
        ...(Array.isArray(payload?.aliases) ? payload.aliases : []),
      ]);

      if (
        !candidateNames.some((candidateName) =>
          normalizedDisplayedNames.has(normalizeLookupValue(candidateName)),
        )
      ) {
        continue;
      }

      matchedIds.add(
        this.toSafeInteger(row.resolved_contact_id, "action_cards.resolved_contact_id"),
      );
    }

    return [...matchedIds];
  }

  confirmActionCardIfPending(input: Omit<ActionCardResolutionInput, "status">): StoredActionCardRecord | null {
    return this.updateActionCardResolutionIfPending({
      ...input,
      status: "confirmed",
    });
  }

  rejectActionCardIfPending(cardId: number, resolvedAt = new Date().toISOString()): StoredActionCardRecord | null {
    return this.updateActionCardResolutionIfPending({
      cardId,
      status: "rejected",
      resolvedAt,
      resolvedContactId: null,
    });
  }

  private updateActionCardResolutionIfPending(
    input: ActionCardResolutionInput,
  ): StoredActionCardRecord | null {
    const current = this.getStoredActionCardById(input.cardId);

    if (!current || current.status !== "pending") {
      return null;
    }

    const payload = input.payload ?? current.payload;
    const resolvedContactId = input.resolvedContactId ?? null;

    const result = this.db
      .prepare(
        `UPDATE action_cards
         SET payload = ?, status = ?, resolved_contact_id = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        JSON.stringify(payload),
        input.status,
        resolvedContactId,
        input.resolvedAt,
        input.cardId,
      );

    if (this.toSafeInteger(result.changes, "changes") === 0) {
      return null;
    }

    return {
      ...current,
      payload,
      status: input.status,
      resolved_contact_id: resolvedContactId,
      resolved_at: input.resolvedAt,
    } as StoredActionCardRecord;
  }

  createContact(input: ContactCreateInput): ContactRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    const canonicalName = normalizeOptionalString(input.canonicalName);

    if (!canonicalName) {
      throw new TypeError("canonicalName must be a non-empty string");
    }

    const aliases = dedupeStrings(input.aliases ?? []).filter((alias) => alias !== canonicalName);
    const tags = dedupeStrings(input.tags ?? []);

    const result = this.db
      .prepare(
        `INSERT INTO contacts (
           canonical_name,
           aliases,
           company,
           title,
           phone,
           wechat_id,
           tags,
           notes,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        canonicalName,
        JSON.stringify(aliases),
        normalizeOptionalString(input.company),
        normalizeOptionalString(input.title),
        normalizeOptionalString(input.phone),
        normalizeOptionalString(input.wechat_id),
        JSON.stringify(tags),
        normalizeOptionalString(input.notes),
        createdAt,
        updatedAt,
      );

    const contact = this.getContactById(this.toSafeInteger(result.lastInsertRowid, "lastInsertRowid"));

    if (!contact) {
      throw new Error("Failed to load inserted contact");
    }

    return contact;
  }

  getContactById(contactId: number): ContactRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           id,
           canonical_name,
           aliases,
           company,
           title,
           phone,
           wechat_id,
           tags,
           notes,
           created_at,
           updated_at
         FROM contacts
         WHERE id = ?`,
      )
      .get(contactId) as ContactRow | undefined;

    return this.hydrateContact(row);
  }

  deleteContactById(contactId: number): boolean {
    const result = this.db.prepare(`DELETE FROM contacts WHERE id = ?`).run(contactId);
    return this.toSafeInteger(result.changes, "changes") > 0;
  }

  listContactSummaries(): ContactSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, canonical_name, aliases, company
         FROM contacts
         ORDER BY canonical_name COLLATE NOCASE ASC, id ASC`,
      )
      .all() as Array<{
      id: number | bigint;
      canonical_name: string;
      aliases: string;
      company: string | null;
    }>;

    return rows.map((row) => ({
      id: this.toSafeInteger(row.id, "contacts.id"),
      canonical_name: row.canonical_name,
      aliases: dedupeStrings(parseJsonArray<string>(row.aliases, [])),
      company: row.company,
    }));
  }

  findContactByExactNameOrAlias(nameOrAlias: string): ContactSummary | null {
    const target = normalizeOptionalString(nameOrAlias);

    if (!target) {
      return null;
    }

    const normalizedTarget = normalizeLookupValue(target);

    for (const contact of this.listContactSummaries()) {
      if (normalizeLookupValue(contact.canonical_name) === normalizedTarget) {
        return contact;
      }

      if (contact.aliases.some((alias) => normalizeLookupValue(alias) === normalizedTarget)) {
        return contact;
      }
    }

    return null;
  }

  appendContactAliases(contactId: number, aliases: string[], updatedAt = new Date().toISOString()) {
    const contact = this.getContactById(contactId);

    if (!contact) {
      return null;
    }

    const nextAliases = dedupeStrings([...contact.aliases, ...aliases]).filter(
      (alias) => alias !== contact.canonical_name,
    );

    this.db
      .prepare(
        `UPDATE contacts
         SET aliases = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(nextAliases), updatedAt, contactId);

    return this.getContactById(contactId);
  }

  updateContactFields(
    contactId: number,
    updates: ContactFieldUpdates,
    updatedAt = new Date().toISOString(),
  ): ContactRecord | null {
    const entries = CONTACT_EDITABLE_FIELDS.filter(
      (field) => Object.prototype.hasOwnProperty.call(updates, field),
    ).map((field) => [field, normalizeOptionalString(updates[field] ?? null)] as const);

    if (entries.length === 0) {
      return this.getContactById(contactId);
    }

    const assignments = entries.map(([field]) => `${field} = ?`).join(", ");
    const values = entries.map(([, value]) => value);

    this.db
      .prepare(
        `UPDATE contacts
         SET ${assignments}, updated_at = ?
         WHERE id = ?`,
      )
      .run(...values, updatedAt, contactId);

    return this.getContactById(contactId);
  }

  listContacts(): ContactListItem[] {
    const rows = this.db
      .prepare(
        `SELECT
           c.id,
           c.canonical_name,
           c.aliases,
           c.company,
           c.title,
           c.phone,
           c.wechat_id,
           c.tags,
           c.notes,
           c.created_at,
           c.updated_at,
           COUNT(o.id) AS observation_count,
           MAX(CASE WHEN o.kind = 'interaction' THEN o.observed_at END) AS last_interaction_at
         FROM contacts c
         LEFT JOIN observations o ON o.contact_id = c.id
         GROUP BY c.id
         ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all() as Array<
      ContactRow & {
        observation_count: number | bigint;
        last_interaction_at: string | null;
      }
    >;

    return rows.map((row) => {
      const contact = this.hydrateContact(row);

      if (!contact) {
        throw new Error("Failed to hydrate contact row");
      }

      return {
        ...contact,
        observation_count: this.toSafeInteger(row.observation_count, "observation_count"),
        last_interaction_at: row.last_interaction_at,
      };
    });
  }

  getContactDetail(contactId: number): ContactDetail | null {
    const contact = this.getContactById(contactId);

    if (!contact) {
      return null;
    }

    return {
      contact,
      observations: this.listObservationsByContactId(contactId),
      insights: this.listInsightsByContactId(contactId),
    };
  }

  findObservationByContactAndScreenshot(input: {
    contactId: number;
    screenshotId: number | null;
    kind: ObservationKind;
  }): ObservationRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           id,
           contact_id,
           screenshot_id,
           kind,
           content,
           source_quote,
           observed_at
         FROM observations
         WHERE contact_id = ?
           AND ((? IS NULL AND screenshot_id IS NULL) OR screenshot_id = ?)
           AND kind = ?
         ORDER BY id ASC
         LIMIT 1`,
      )
      .get(input.contactId, input.screenshotId, input.screenshotId, input.kind) as
      | ObservationRow
      | undefined;

    return this.hydrateObservation(row);
  }

  insertObservationIfAbsent(input: ObservationInsertInput): ObservationRecord {
    const content = normalizeOptionalString(input.content);

    if (!content) {
      throw new TypeError("Observation content must be a non-empty string");
    }

    const observedAt = input.observedAt ?? new Date().toISOString();
    const sourceQuote = normalizeOptionalString(input.sourceQuote);
    const screenshotId = input.screenshotId ?? null;

    const existingRow = this.db
      .prepare(
        `SELECT
           id,
           contact_id,
           screenshot_id,
           kind,
           content,
           source_quote,
           observed_at
         FROM observations
         WHERE contact_id = ?
           AND ((? IS NULL AND screenshot_id IS NULL) OR screenshot_id = ?)
           AND kind = ?
           AND content = ?
           AND ((? IS NULL AND source_quote IS NULL) OR source_quote = ?)
         LIMIT 1`,
      )
      .get(input.contactId, screenshotId, screenshotId, input.kind, content, sourceQuote, sourceQuote) as
      | ObservationRow
      | undefined;

    const existing = this.hydrateObservation(existingRow);
    if (existing) {
      return existing;
    }

    const result = this.db
      .prepare(
        `INSERT INTO observations (
           contact_id,
           screenshot_id,
           kind,
           content,
           source_quote,
           observed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.contactId, screenshotId, input.kind, content, sourceQuote, observedAt);

    const inserted = this.hydrateObservation(
      this.db
        .prepare(
          `SELECT
             id,
             contact_id,
             screenshot_id,
             kind,
             content,
             source_quote,
             observed_at
           FROM observations
           WHERE id = ?`,
        )
        .get(this.toSafeInteger(result.lastInsertRowid, "lastInsertRowid")) as ObservationRow | undefined,
    );

    if (!inserted) {
      throw new Error("Failed to load inserted observation");
    }

    return inserted;
  }

  listObservationsByContactId(contactId: number): ObservationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           contact_id,
           screenshot_id,
           kind,
           content,
           source_quote,
           observed_at
         FROM observations
         WHERE contact_id = ?
         ORDER BY observed_at DESC, id DESC`,
      )
      .all(contactId) as ObservationRow[];

    return rows
      .map((row) => this.hydrateObservation(row))
      .filter((observation): observation is ObservationRecord => observation !== null);
  }

  insertMeeting(input: MeetingInsertInput): MeetingRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const title = normalizeOptionalString(input.title);
    const timeText = input.timeText.trim();

    if (!title) {
      throw new TypeError("Meeting title must be a non-empty string");
    }

    if (!isMeetingKind(input.kind)) {
      throw new TypeError(`Invalid meeting kind: ${String(input.kind)}`);
    }

    const participants = input.participants.map((participant) => {
      const name = normalizeOptionalString(participant.name);

      if (!name) {
        throw new TypeError("Meeting participants must have non-empty names");
      }

      return {
        ...(participant.contact_id != null ? { contact_id: participant.contact_id } : {}),
        name,
      };
    });

    const result = this.db
      .prepare(
        `INSERT INTO meetings (
           title,
           time_iso,
           time_text,
           location,
           participants,
           agenda,
           source_screenshot_id,
           status,
           created_at,
           kind
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        normalizeOptionalString(input.timeIso),
        timeText,
        normalizeOptionalString(input.location),
        JSON.stringify(participants),
        normalizeOptionalString(input.agenda),
        input.sourceScreenshotId ?? null,
        input.status ?? "upcoming",
        createdAt,
        input.kind,
      );

    const meeting = this.hydrateMeeting(
      this.db
        .prepare(
          `SELECT
             id,
             title,
             time_iso,
             time_text,
             location,
             participants,
             agenda,
             source_screenshot_id,
             status,
             created_at,
             kind
           FROM meetings
           WHERE id = ?`,
        )
        .get(this.toSafeInteger(result.lastInsertRowid, "lastInsertRowid")) as MeetingRow | undefined,
    );

    if (!meeting) {
      throw new Error("Failed to load inserted meeting");
    }

    return meeting;
  }

  updateMeeting(meetingId: number, input: MeetingInsertInput): MeetingRecord | null {
    const normalizedMeetingId = this.toSafeInteger(meetingId, "meetings.id");
    const title = normalizeOptionalString(input.title);
    const timeText = input.timeText.trim();

    if (normalizedMeetingId <= 0) {
      throw new RangeError("Meeting id must be positive");
    }

    if (!title) {
      throw new TypeError("Meeting title must be a non-empty string");
    }

    if (!isMeetingKind(input.kind)) {
      throw new TypeError(`Invalid meeting kind: ${String(input.kind)}`);
    }

    const participants = input.participants.map((participant) => {
      const name = normalizeOptionalString(participant.name);

      if (!name) {
        throw new TypeError("Meeting participants must have non-empty names");
      }

      return {
        ...(participant.contact_id != null ? { contact_id: participant.contact_id } : {}),
        name,
      };
    });
    const result = this.db
      .prepare(
        `UPDATE meetings
         SET kind = ?, title = ?, time_iso = ?, time_text = ?, location = ?,
             participants = ?, agenda = ?, source_screenshot_id = ?
         WHERE id = ?`,
      )
      .run(
        input.kind,
        title,
        normalizeOptionalString(input.timeIso),
        timeText,
        normalizeOptionalString(input.location),
        JSON.stringify(participants),
        normalizeOptionalString(input.agenda),
        input.sourceScreenshotId ?? null,
        normalizedMeetingId,
      );

    if (result.changes === 0) {
      return null;
    }

    return this.hydrateMeeting(
      this.db
        .prepare(
          `SELECT
             id,
             title,
             time_iso,
             time_text,
             location,
             participants,
             agenda,
             source_screenshot_id,
             status,
             created_at,
             kind
           FROM meetings
           WHERE id = ?`,
        )
        .get(normalizedMeetingId) as MeetingRow | undefined,
    );
  }

  listMeetings(): MeetingRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           title,
           time_iso,
           time_text,
           location,
           participants,
           agenda,
           source_screenshot_id,
           status,
           created_at,
           kind
         FROM meetings
         ORDER BY time_iso IS NULL ASC, time_iso ASC, created_at DESC, id DESC`,
      )
      .all() as MeetingRow[];

    return rows
      .map((row) => this.hydrateMeeting(row))
      .filter((meeting): meeting is MeetingRecord => meeting !== null);
  }

  getContactInsightContext(contactId: number): ContactInsightContext | null {
    const contact = this.getContactById(contactId);

    if (!contact) {
      return null;
    }

    return {
      contact,
      observations: this.listObservationsByContactId(contactId),
      recentInsights: this.listInsightsByContactId(contactId, 5),
    };
  }

  getInsightContext(contactId: number): ContactInsightContext | null {
    return this.getContactInsightContext(contactId);
  }

  insertInsights(entries: InsightInsertEntry[]): InsightRecord[] {
    return this.withTransaction(() =>
      entries.map((entry) => {
        const content = normalizeOptionalString(entry.content);

        if (!content) {
          throw new TypeError("Insight content must be a non-empty string");
        }

        let basedOnValues: number[];
        let contactId: number;
        let generatedAtValue: string | undefined;

        if ("contactId" in entry) {
          basedOnValues = entry.basedOn;
          contactId = entry.contactId;
          generatedAtValue = entry.generatedAt;
        } else {
          basedOnValues = entry.based_on;
          contactId = entry.contact_id;
          generatedAtValue = entry.generated_at;
        }
        const basedOn = basedOnValues.map((value, index) => {
          if (!Number.isSafeInteger(value)) {
            throw new RangeError(`Insight basedOn[${index}] is not a safe integer: ${value}`);
          }

          return value;
        });

        const generatedAt = generatedAtValue ?? new Date().toISOString();
        const result = this.db
          .prepare(
            `INSERT INTO insights (
               contact_id,
               kind,
               content,
               based_on,
               generated_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(contactId, entry.kind, content, JSON.stringify(basedOn), generatedAt);

        const inserted = this.hydrateInsight(
          this.db
            .prepare(
              `SELECT
                 id,
                 contact_id,
                 kind,
                 content,
                 based_on,
                 generated_at
               FROM insights
               WHERE id = ?`,
            )
            .get(this.toSafeInteger(result.lastInsertRowid, "lastInsertRowid")) as InsightRow | undefined,
        );

        if (!inserted) {
          throw new Error("Failed to load inserted insight");
        }

        return inserted;
      }),
    );
  }

  replaceInsightsForContacts(entries: InsightGenerationEntry[]): InsightRecord[] {
    if (entries.length === 0) {
      return [];
    }

    const contactIds = [...new Set(entries.map((entry, index) => {
      if (!Number.isSafeInteger(entry.contact_id)) {
        throw new RangeError(`Insight contact_id at index ${index} is not a safe integer`);
      }

      return entry.contact_id;
    }))];
    const deleteInsights = this.db.prepare("DELETE FROM insights WHERE contact_id = ?");
    const insertInsight = this.db.prepare(
      `INSERT INTO insights (
         contact_id,
         kind,
         content,
         based_on,
         generated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const selectInsight = this.db.prepare(
      `SELECT
         id,
         contact_id,
         kind,
         content,
         based_on,
         generated_at
       FROM insights
       WHERE id = ?`,
    );

    // insertInsights owns its own BEGIN/COMMIT; keep this direct insert path so the
    // delete and replacement rows share one transaction without a nested BEGIN.
    return this.withTransaction(() => {
      for (const contactId of contactIds) {
        deleteInsights.run(contactId);
      }

      return entries.map((entry) => {
        const content = normalizeOptionalString(entry.content);

        if (!content) {
          throw new TypeError("Insight content must be a non-empty string");
        }

        const basedOn = entry.based_on.map((value, index) => {
          if (!Number.isSafeInteger(value)) {
            throw new RangeError(`Insight basedOn[${index}] is not a safe integer: ${value}`);
          }

          return value;
        });
        const result = insertInsight.run(
          entry.contact_id,
          entry.kind,
          content,
          JSON.stringify(basedOn),
          entry.generated_at,
        );
        const inserted = this.hydrateInsight(
          selectInsight.get(
            this.toSafeInteger(result.lastInsertRowid, "lastInsertRowid"),
          ) as InsightRow | undefined,
        );

        if (!inserted) {
          throw new Error("Failed to load inserted insight");
        }

        return inserted;
      });
    });
  }

  private listInsightsByContactId(contactId: number, limit?: number): InsightRecord[] {
    const sql = [
      `SELECT
         id,
         contact_id,
         kind,
         content,
         based_on,
         generated_at
       FROM insights
       WHERE contact_id = ?
       ORDER BY generated_at DESC, id DESC`,
      limit != null ? `LIMIT ${limit}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const rows = this.db.prepare(sql).all(contactId) as InsightRow[];

    return rows
      .map((row) => this.hydrateInsight(row))
      .filter((insight): insight is InsightRecord => insight !== null);
  }

  deleteScreenshotUploadArtifacts(screenshotId: number) {
    const deleteCards = this.db.prepare(
      `DELETE FROM action_cards
       WHERE screenshot_id = ?`,
    );
    const deleteScreenshot = this.db.prepare(
      `DELETE FROM screenshots
       WHERE id = ?`,
    );

    return this.withTransaction(() => {
      // simplified: action_cards.screenshot_id does not cascade, so M1 upload cleanup deletes
      // pending cards first and then the screenshot row synchronously. M2 should retain failed
      // uploads in an explicit processing/retry state instead of removing them.
      const deletedCardCount = this.toSafeInteger(deleteCards.run(screenshotId).changes, "changes");
      const deletedScreenshotCount = this.toSafeInteger(
        deleteScreenshot.run(screenshotId).changes,
        "changes",
      );

      return {
        deletedCardCount,
        deletedScreenshot: deletedScreenshotCount > 0,
      };
    });
  }

  getNativeDatabase() {
    return this.db;
  }

  close() {
    this.db.close();
  }
}
