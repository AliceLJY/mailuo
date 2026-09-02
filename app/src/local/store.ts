import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";

import {
  CONTACT_EDITABLE_FIELDS,
  type ContactFieldUpdates,
  type MeetingParticipant,
  type MeetingWriteInput,
  type ObservationInsertInput,
  type ObservationKind,
  type StoredActionCardRecord,
} from "../../../shared/core/agent/execute.ts";
import type {
  InsightGenerationEntry,
  InsightGenerationRecord,
} from "../../../shared/core/agent/insight.ts";
import { initializeMailuoSchema } from "../../../shared/core/migrations.ts";
import {
  isMeetingKind,
  type ActionCard,
} from "../../../shared/types.ts";
import type {
  ActionCardConfidence,
  ActionCardRecord,
  ContactDetail,
  ContactListItem,
  ContactRecord,
  InsightRecord,
  MeetingRecord,
  ObservationRecord,
  ScreenshotDetail,
  ScreenshotRecord,
} from "../types";

import type { LocalStore } from "./types";

type ContactRow = Omit<ContactRecord, "aliases" | "tags"> & {
  aliases: string;
  tags: string;
};

type ScreenshotRow = {
  id: number;
  image_path: string;
  user_note: string | null;
  raw_extraction: string | null;
  uploaded_at: string;
};

type ActionCardRow = {
  id: number;
  screenshot_id: number;
  type: ActionCard["type"];
  payload: string;
  confidence: ActionCardConfidence;
  source_quote: string;
  disambiguation: string | null;
  status: ActionCardRecord["status"];
  resolved_contact_id: number | null;
  created_at: string;
  resolved_at: string | null;
};

type ObservationRow = ObservationRecord;

type MeetingRow = Omit<MeetingRecord, "kind" | "participants"> & {
  kind: string;
  participants: string;
};

type InsightRow = Omit<InsightRecord, "based_on"> & {
  based_on: string;
};

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
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

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeLookupValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function assertSafeInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`SQLite ${fieldName} is not a safe integer`);
  }

  return value;
}

function hydrateContact(row: ContactRow | null): ContactRecord | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    id: assertSafeInteger(row.id, "contacts.id"),
    aliases: dedupeStrings(parseJsonArray<string>(row.aliases)),
    tags: dedupeStrings(parseJsonArray<string>(row.tags)),
  };
}

function hydrateActionCard(row: ActionCardRow | null): StoredActionCardRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: assertSafeInteger(row.id, "action_cards.id"),
    screenshot_id: assertSafeInteger(row.screenshot_id, "action_cards.screenshot_id"),
    type: row.type,
    payload: JSON.parse(row.payload),
    confidence: row.confidence,
    source_quote: row.source_quote,
    disambiguation: row.disambiguation ? JSON.parse(row.disambiguation) : null,
    status: row.status,
    resolved_contact_id: row.resolved_contact_id,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  } as StoredActionCardRecord;
}

function hydrateMeeting(row: MeetingRow): MeetingRecord {
  if (!isMeetingKind(row.kind)) {
    throw new TypeError(`Invalid meetings.kind: ${row.kind}`);
  }

  return {
    ...row,
    id: assertSafeInteger(row.id, "meetings.id"),
    kind: row.kind,
    participants: parseJsonArray<MeetingParticipant>(row.participants).map((participant) => ({
      ...(participant.contact_id != null ? { contact_id: participant.contact_id } : {}),
      name: participant.name,
    })),
  };
}

function hydrateInsight(row: InsightRow): InsightRecord {
  return {
    ...row,
    id: assertSafeInteger(row.id, "insights.id"),
    based_on: parseJsonArray<number>(row.based_on).map((value, index) =>
      assertSafeInteger(value, `insights.based_on[${index}]`),
    ),
  };
}

export class ExpoSqliteLocalStore implements LocalStore {
  constructor(private readonly db: SQLiteDatabase) {
    this.db.execSync("PRAGMA foreign_keys = ON");
    initializeMailuoSchema({
      exec: (sql) => this.db.execSync(sql),
      getUserVersion: () => {
        const row = this.db.getFirstSync<{ user_version: number }>("PRAGMA user_version");

        if (!row) {
          throw new Error("SQLite did not return PRAGMA user_version");
        }

        return assertSafeInteger(row.user_version, "user_version");
      },
    });
  }

  withTransaction<T>(callback: () => T): T {
    let result: T | undefined;
    this.db.withTransactionSync(() => {
      result = callback();
    });
    return result as T;
  }

  createScreenshot(input: {
    imagePath: string;
    userNote?: string | null;
    uploadedAt?: string;
  }): ScreenshotRecord {
    const uploadedAt = input.uploadedAt ?? new Date().toISOString();
    const result = this.db.runSync(
      `INSERT INTO screenshots (image_path, user_note, uploaded_at)
       VALUES (?, ?, ?)`,
      input.imagePath,
      input.userNote ?? null,
      uploadedAt,
    );

    return {
      id: assertSafeInteger(result.lastInsertRowId, "lastInsertRowId"),
      image_path: input.imagePath,
      user_note: input.userNote ?? null,
      raw_extraction: null,
      uploaded_at: uploadedAt,
    };
  }

  saveScreenshotAnalysis(input: {
    screenshotId: number;
    rawExtraction: unknown;
    cards: ActionCard[];
    pendingCardUpdates?: Array<{
      cardId: number;
      payload: ActionCard["payload"];
      sourceQuote: string;
    }>;
    createdAt?: string;
  }): ActionCardRecord[] {
    const createdAt = input.createdAt ?? new Date().toISOString();

    return this.withTransaction(() => {
      this.db.runSync(
        "UPDATE screenshots SET raw_extraction = ? WHERE id = ?",
        JSON.stringify(input.rawExtraction),
        input.screenshotId,
      );

      for (const update of input.pendingCardUpdates ?? []) {
        const updated = this.applyPendingActionCardUpdate(update);
        if (!updated) {
          throw new Error(`Pending action card ${update.cardId} could not be updated`);
        }
      }

      return input.cards.map((card) =>
        this.insertActionCard(input.screenshotId, card, createdAt),
      );
    });
  }

  updatePendingActionCard(input: {
    cardId: number;
    payload?: ActionCard["payload"];
    sourceQuote?: string;
    disambiguation?: ActionCard["disambiguation"] | null;
  }): ActionCardRecord | null {
    return this.withTransaction(() => this.applyPendingActionCardUpdate(input));
  }

  private applyPendingActionCardUpdate(input: {
    cardId: number;
    payload?: ActionCard["payload"];
    sourceQuote?: string;
    disambiguation?: ActionCard["disambiguation"] | null;
  }): ActionCardRecord | null {
    const current = this.getStoredActionCardById(input.cardId);
    if (!current || current.status !== "pending") {
      return null;
    }

    const payload = input.payload ?? current.payload;
    const sourceQuote = input.sourceQuote ?? current.source_quote;
    const disambiguation = input.disambiguation === undefined
      ? current.disambiguation
      : input.disambiguation;
    const result = this.db.runSync(
      `UPDATE action_cards
       SET payload = ?, source_quote = ?, disambiguation = ?
       WHERE id = ? AND status = 'pending'`,
      JSON.stringify(payload),
      sourceQuote,
      disambiguation ? JSON.stringify(disambiguation) : null,
      input.cardId,
    );

    if (result.changes === 0) {
      return null;
    }

    return {
      ...current,
      payload,
      source_quote: sourceQuote,
      disambiguation,
    } as ActionCardRecord;
  }

  private insertActionCard(
    screenshotId: number,
    card: ActionCard,
    createdAt: string,
  ): ActionCardRecord {
    const result = this.db.runSync(
      `INSERT INTO action_cards (
         screenshot_id, type, payload, confidence, source_quote, disambiguation, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      screenshotId,
      card.type,
      JSON.stringify(card.payload),
      card.confidence,
      card.source_quote,
      card.disambiguation ? JSON.stringify(card.disambiguation) : null,
      createdAt,
    );

    return {
      ...card,
      id: assertSafeInteger(result.lastInsertRowId, "lastInsertRowId"),
      screenshot_id: screenshotId,
      disambiguation: card.disambiguation ?? null,
      status: "pending",
      resolved_contact_id: null,
      created_at: createdAt,
      resolved_at: null,
    } as ActionCardRecord;
  }

  getScreenshotById(screenshotId: number): ScreenshotRecord | null {
    const row = this.db.getFirstSync<ScreenshotRow>(
      `SELECT id, image_path, user_note, raw_extraction, uploaded_at
       FROM screenshots WHERE id = ?`,
      screenshotId,
    );

    if (!row) {
      return null;
    }

    return {
      id: assertSafeInteger(row.id, "screenshots.id"),
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
    return hydrateActionCard(
      this.db.getFirstSync<ActionCardRow>(
        `SELECT id, screenshot_id, type, payload, confidence, source_quote,
                disambiguation, status, resolved_contact_id, created_at, resolved_at
         FROM action_cards WHERE id = ?`,
        cardId,
      ),
    );
  }

  countPendingLocalBatchInteractionCards(anchorCardId: number): number {
    const normalizedAnchorCardId = assertSafeInteger(anchorCardId, "anchorCardId");
    const rows = this.db.getAllSync<{ disambiguation: string }>(
      `SELECT disambiguation
       FROM action_cards
       WHERE type = 'record_interaction'
         AND status = 'pending'
         AND disambiguation IS NOT NULL`,
    );

    return rows.reduce((count, row) => {
      try {
        const parsed = JSON.parse(row.disambiguation) as {
          local_batch_deferred?: {
            dependencies?: Array<{ kind?: unknown; anchor_card_id?: unknown }>;
          };
        };
        const dependsOnAnchor = parsed.local_batch_deferred?.dependencies?.some(
          (dependency) =>
            dependency.kind === "record_interaction" &&
            dependency.anchor_card_id === normalizedAnchorCardId,
        );
        return count + (dependsOnAnchor ? 1 : 0);
      } catch {
        return count;
      }
    }, 0);
  }

  private listStoredActionCardsByScreenshotId(screenshotId: number): ActionCardRecord[] {
    return this.db
      .getAllSync<ActionCardRow>(
        `SELECT id, screenshot_id, type, payload, confidence, source_quote,
                disambiguation, status, resolved_contact_id, created_at, resolved_at
         FROM action_cards WHERE screenshot_id = ? ORDER BY id ASC`,
        screenshotId,
      )
      .map((row) => hydrateActionCard(row))
      .filter((card): card is StoredActionCardRecord => card !== null);
  }

  findResolvedContactIdsForConfirmedSiblingCreateCards(args: {
    screenshotId: number;
    displayedNames: string[];
  }): number[] {
    const names = new Set(dedupeStrings(args.displayedNames).map(normalizeLookupValue));

    if (names.size === 0) {
      return [];
    }

    const rows = this.db.getAllSync<{ payload: string; resolved_contact_id: number }>(
      `SELECT payload, resolved_contact_id
       FROM action_cards
       WHERE screenshot_id = ?
         AND type = 'create_contact'
         AND status = 'confirmed'
         AND resolved_contact_id IS NOT NULL
       ORDER BY id ASC`,
      args.screenshotId,
    );
    const ids = new Set<number>();

    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { name?: string; aliases?: string[] };
      const candidates = dedupeStrings([payload.name, ...(payload.aliases ?? [])]);

      if (candidates.some((candidate) => names.has(normalizeLookupValue(candidate)))) {
        ids.add(assertSafeInteger(row.resolved_contact_id, "resolved_contact_id"));
      }
    }

    return [...ids];
  }

  confirmActionCardIfPending(input: {
    cardId: number;
    payload?: ActionCard["payload"];
    resolvedContactId?: number | null;
    resolvedAt: string;
  }): StoredActionCardRecord | null {
    return this.updateActionCardResolution({
      ...input,
      status: "confirmed",
    });
  }

  rejectActionCardIfPending(
    cardId: number,
    resolvedAt = new Date().toISOString(),
  ): StoredActionCardRecord | null {
    return this.updateActionCardResolution({
      cardId,
      status: "rejected",
      resolvedAt,
      resolvedContactId: null,
    });
  }

  private updateActionCardResolution(input: {
    cardId: number;
    status: "confirmed" | "rejected";
    payload?: ActionCard["payload"];
    resolvedContactId?: number | null;
    resolvedAt: string;
  }): StoredActionCardRecord | null {
    const current = this.getStoredActionCardById(input.cardId);

    if (!current || current.status !== "pending") {
      return null;
    }

    const payload = input.payload ?? current.payload;
    const resolvedContactId = input.resolvedContactId ?? null;
    const result = this.db.runSync(
      `UPDATE action_cards
       SET payload = ?, status = ?, resolved_contact_id = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
      JSON.stringify(payload),
      input.status,
      resolvedContactId,
      input.resolvedAt,
      input.cardId,
    );

    if (result.changes === 0) {
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
  }): ContactRecord {
    const canonicalName = normalizeOptionalString(input.canonicalName);

    if (!canonicalName) {
      throw new TypeError("canonicalName must be a non-empty string");
    }

    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    const aliases = dedupeStrings(input.aliases ?? []).filter((alias) => alias !== canonicalName);
    const result = this.db.runSync(
      `INSERT INTO contacts (
         canonical_name, aliases, company, title, phone, wechat_id, tags, notes,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      canonicalName,
      JSON.stringify(aliases),
      normalizeOptionalString(input.company),
      normalizeOptionalString(input.title),
      normalizeOptionalString(input.phone),
      normalizeOptionalString(input.wechat_id),
      "[]",
      normalizeOptionalString(input.notes),
      createdAt,
      updatedAt,
    );
    const contact = this.getContactById(
      assertSafeInteger(result.lastInsertRowId, "lastInsertRowId"),
    );

    if (!contact) {
      throw new Error("Failed to load inserted contact");
    }

    return contact;
  }

  getContactById(contactId: number): ContactRecord | null {
    return hydrateContact(
      this.db.getFirstSync<ContactRow>(
        `SELECT id, canonical_name, aliases, company, title, phone, wechat_id,
                tags, notes, created_at, updated_at
         FROM contacts WHERE id = ?`,
        contactId,
      ),
    );
  }

  appendContactAliases(
    contactId: number,
    aliases: string[],
    updatedAt = new Date().toISOString(),
  ): ContactRecord | null {
    const contact = this.getContactById(contactId);

    if (!contact) {
      return null;
    }

    const nextAliases = dedupeStrings([...contact.aliases, ...aliases]).filter(
      (alias) => alias !== contact.canonical_name,
    );
    this.db.runSync(
      "UPDATE contacts SET aliases = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(nextAliases),
      updatedAt,
      contactId,
    );
    return this.getContactById(contactId);
  }

  updateContactFields(
    contactId: number,
    updates: ContactFieldUpdates,
    updatedAt = new Date().toISOString(),
  ): ContactRecord | null {
    const entries = CONTACT_EDITABLE_FIELDS.filter((field) =>
      Object.prototype.hasOwnProperty.call(updates, field),
    ).map((field) => [field, normalizeOptionalString(updates[field])] as const);

    if (entries.length === 0) {
      return this.getContactById(contactId);
    }

    this.db.runSync(
      `UPDATE contacts
       SET ${entries.map(([field]) => `${field} = ?`).join(", ")}, updated_at = ?
       WHERE id = ?`,
      ...entries.map(([, value]) => value),
      updatedAt,
      contactId,
    );
    return this.getContactById(contactId);
  }

  listContacts(): ContactListItem[] {
    const rows = this.db.getAllSync<ContactRow & {
      observation_count: number;
      last_interaction_at: string | null;
    }>(
      `SELECT c.id, c.canonical_name, c.aliases, c.company, c.title, c.phone,
              c.wechat_id, c.tags, c.notes, c.created_at, c.updated_at,
              COUNT(o.id) AS observation_count,
              MAX(CASE WHEN o.kind = 'interaction' THEN o.observed_at END) AS last_interaction_at
       FROM contacts c
       LEFT JOIN observations o ON o.contact_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC, c.id DESC`,
    );

    return rows.map((row) => {
      const contact = hydrateContact(row);

      if (!contact) {
        throw new Error("Failed to hydrate contact row");
      }

      return {
        ...contact,
        observation_count: assertSafeInteger(row.observation_count, "observation_count"),
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
    return this.db.getFirstSync<ObservationRow>(
      `SELECT id, contact_id, screenshot_id, kind, content, source_quote, observed_at
       FROM observations
       WHERE contact_id = ?
         AND ((? IS NULL AND screenshot_id IS NULL) OR screenshot_id = ?)
         AND kind = ?
       ORDER BY id ASC LIMIT 1`,
      input.contactId,
      input.screenshotId,
      input.screenshotId,
      input.kind,
    );
  }

  insertObservationIfAbsent(input: ObservationInsertInput): ObservationRecord {
    const content = normalizeOptionalString(input.content);

    if (!content) {
      throw new TypeError("Observation content must be a non-empty string");
    }

    const screenshotId = input.screenshotId ?? null;
    const sourceQuote = normalizeOptionalString(input.sourceQuote);
    const dedupeByContent = input.kind === "fact" || input.kind === "preference";
    const existing = dedupeByContent
      ? this.db.getFirstSync<ObservationRow>(
          `SELECT id, contact_id, screenshot_id, kind, content, source_quote, observed_at
           FROM observations
           WHERE contact_id = ? AND kind = ? AND content = ?
           ORDER BY id ASC LIMIT 1`,
          input.contactId,
          input.kind,
          content,
        )
      : this.db.getFirstSync<ObservationRow>(
          `SELECT id, contact_id, screenshot_id, kind, content, source_quote, observed_at
           FROM observations
           WHERE contact_id = ?
             AND ((? IS NULL AND screenshot_id IS NULL) OR screenshot_id = ?)
             AND kind = ? AND content = ?
             AND ((? IS NULL AND source_quote IS NULL) OR source_quote = ?)
           LIMIT 1`,
          input.contactId,
          screenshotId,
          screenshotId,
          input.kind,
          content,
          sourceQuote,
          sourceQuote,
        );

    if (existing) {
      if (
        dedupeByContent &&
        sourceQuote &&
        (existing.source_quote == null || sourceQuote.length < existing.source_quote.length)
      ) {
        this.db.runSync(
          "UPDATE observations SET source_quote = ? WHERE id = ?",
          sourceQuote,
          existing.id,
        );
        return {
          ...existing,
          source_quote: sourceQuote,
        };
      }

      return existing;
    }

    const observedAt = input.observedAt ?? new Date().toISOString();
    const result = this.db.runSync(
      `INSERT INTO observations (
         contact_id, screenshot_id, kind, content, source_quote, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      input.contactId,
      screenshotId,
      input.kind,
      content,
      sourceQuote,
      observedAt,
    );
    const inserted = this.db.getFirstSync<ObservationRow>(
      `SELECT id, contact_id, screenshot_id, kind, content, source_quote, observed_at
       FROM observations WHERE id = ?`,
      result.lastInsertRowId,
    );

    if (!inserted) {
      throw new Error("Failed to load inserted observation");
    }

    return inserted;
  }

  private listObservationsByContactId(contactId: number): ObservationRecord[] {
    return this.db.getAllSync<ObservationRow>(
      `SELECT id, contact_id, screenshot_id, kind, content, source_quote, observed_at
       FROM observations WHERE contact_id = ? ORDER BY observed_at DESC, id DESC`,
      contactId,
    );
  }

  insertMeeting(input: MeetingWriteInput): MeetingRecord {
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
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db.runSync(
      `INSERT INTO meetings (
         title, time_iso, time_text, location, participants, agenda,
         source_screenshot_id, status, created_at, kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      title,
      normalizeOptionalString(input.timeIso),
      timeText,
      normalizeOptionalString(input.location),
      JSON.stringify(participants),
      normalizeOptionalString(input.agenda),
      input.sourceScreenshotId ?? null,
      "upcoming",
      createdAt,
      input.kind,
    );
    const row = this.db.getFirstSync<MeetingRow>(
      `SELECT id, title, time_iso, time_text, location, participants, agenda,
              source_screenshot_id, status, created_at, kind
       FROM meetings WHERE id = ?`,
      result.lastInsertRowId,
    );

    if (!row) {
      throw new Error("Failed to load inserted meeting");
    }

    return hydrateMeeting(row);
  }

  updateMeeting(meetingId: number, input: MeetingWriteInput): MeetingRecord | null {
    const normalizedMeetingId = assertSafeInteger(meetingId, "meetings.id");
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
    const result = this.db.runSync(
      `UPDATE meetings
       SET kind = ?, title = ?, time_iso = ?, time_text = ?, location = ?,
           participants = ?, agenda = ?, source_screenshot_id = ?
       WHERE id = ?`,
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

    const row = this.db.getFirstSync<MeetingRow>(
      `SELECT id, title, time_iso, time_text, location, participants, agenda,
              source_screenshot_id, status, created_at, kind
       FROM meetings WHERE id = ?`,
      normalizedMeetingId,
    );

    return row ? hydrateMeeting(row) : null;
  }

  listMeetings(): MeetingRecord[] {
    return this.db
      .getAllSync<MeetingRow>(
        `SELECT id, title, time_iso, time_text, location, participants, agenda,
                source_screenshot_id, status, created_at, kind
         FROM meetings
         ORDER BY time_iso IS NULL ASC, time_iso ASC, created_at DESC, id DESC`,
      )
      .map(hydrateMeeting);
  }

  getInsightContext(contactId: number) {
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

  insertInsights(entries: InsightGenerationEntry[]): InsightGenerationRecord[] {
    return this.withTransaction(() =>
      entries.map((entry) => {
        const content = normalizeOptionalString(entry.content);

        if (!content) {
          throw new TypeError("Insight content must be a non-empty string");
        }

        const basedOn = entry.based_on.map((value, index) =>
          assertSafeInteger(value, `based_on[${index}]`),
        );
        const result = this.db.runSync(
          `INSERT INTO insights (contact_id, kind, content, based_on, generated_at)
           VALUES (?, ?, ?, ?, ?)`,
          entry.contact_id,
          entry.kind,
          content,
          JSON.stringify(basedOn),
          entry.generated_at,
        );
        const row = this.db.getFirstSync<InsightRow>(
          `SELECT id, contact_id, kind, content, based_on, generated_at
           FROM insights WHERE id = ?`,
          result.lastInsertRowId,
        );

        if (!row) {
          throw new Error("Failed to load inserted insight");
        }

        return hydrateInsight(row);
      }),
    );
  }

  replaceInsightsForContacts(entries: InsightGenerationEntry[]): InsightGenerationRecord[] {
    if (entries.length === 0) {
      return [];
    }

    const contactIds = [...new Set(entries.map((entry, index) =>
      assertSafeInteger(entry.contact_id, `entries[${index}].contact_id`),
    ))];

    // insertInsights owns its own withTransactionSync; keep this direct insert path
    // so the delete and replacement rows remain in one non-nested transaction.
    return this.withTransaction(() => {
      for (const contactId of contactIds) {
        this.db.runSync("DELETE FROM insights WHERE contact_id = ?", contactId);
      }

      return entries.map((entry) => {
        const content = normalizeOptionalString(entry.content);

        if (!content) {
          throw new TypeError("Insight content must be a non-empty string");
        }

        const basedOn = entry.based_on.map((value, index) =>
          assertSafeInteger(value, `based_on[${index}]`),
        );
        const result = this.db.runSync(
          `INSERT INTO insights (contact_id, kind, content, based_on, generated_at)
           VALUES (?, ?, ?, ?, ?)`,
          entry.contact_id,
          entry.kind,
          content,
          JSON.stringify(basedOn),
          entry.generated_at,
        );
        const row = this.db.getFirstSync<InsightRow>(
          `SELECT id, contact_id, kind, content, based_on, generated_at
           FROM insights WHERE id = ?`,
          result.lastInsertRowId,
        );

        if (!row) {
          throw new Error("Failed to load inserted insight");
        }

        return hydrateInsight(row);
      });
    });
  }

  private listInsightsByContactId(contactId: number, limit?: number): InsightRecord[] {
    const rows = this.db.getAllSync<InsightRow>(
      `SELECT id, contact_id, kind, content, based_on, generated_at
       FROM insights WHERE contact_id = ?
       ORDER BY generated_at DESC, id DESC${limit == null ? "" : " LIMIT ?"}`,
      ...(limit == null ? [contactId] : [contactId, limit]),
    );
    return rows.map(hydrateInsight);
  }

  deleteScreenshotUploadArtifacts(screenshotId: number): void {
    this.withTransaction(() => {
      this.db.runSync("DELETE FROM action_cards WHERE screenshot_id = ?", screenshotId);
      this.db.runSync("DELETE FROM screenshots WHERE id = ?", screenshotId);
    });
  }

  clearAllData(): void {
    this.withTransaction(() => {
      this.db.runSync("DELETE FROM insights");
      this.db.runSync("DELETE FROM observations");
      this.db.runSync("DELETE FROM meetings");
      this.db.runSync("DELETE FROM action_cards");
      this.db.runSync("DELETE FROM screenshots");
      this.db.runSync("DELETE FROM contacts");
    });
  }

  close(): void {
    this.db.closeSync();
  }
}

export function createExpoSqliteLocalStore(
  databaseName = "mailuo.sqlite",
): ExpoSqliteLocalStore {
  return new ExpoSqliteLocalStore(openDatabaseSync(databaseName));
}
