import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { ActionCard, ActionCardRecord } from "../../shared/types.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultDatabasePath = resolve(currentDir, "..", "data", "mailuo.sqlite");
const schemaPath = resolve(currentDir, "schema.sql");

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

export class MailuoDb {
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
    this.db.exec(readFileSync(schemaPath, "utf8"));
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

  private withTransaction<T>(callback: () => T): T {
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

  createScreenshot(input: ScreenshotInsertInput) {
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
    const insertCard = this.db.prepare(
      `INSERT INTO action_cards (
         screenshot_id,
         type,
         payload,
         confidence,
         source_quote,
         disambiguation,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    return this.withTransaction(() => {
      updateScreenshot.run(JSON.stringify(input.rawExtraction), input.screenshotId);

      return input.cards.map((card) => {
        const result = insertCard.run(
          input.screenshotId,
          card.type,
          JSON.stringify(card.payload),
          card.confidence,
          card.source_quote,
          card.disambiguation ? JSON.stringify(card.disambiguation) : null,
          createdAt,
        );

        return {
          ...card,
          id: this.toSafeInteger(result.lastInsertRowid, "lastInsertRowid"),
          screenshot_id: input.screenshotId,
          status: "pending" as const,
          created_at: createdAt,
          resolved_contact_id: null,
          resolved_at: null,
        };
      });
    });
  }

  getScreenshotById(screenshotId: number) {
    const row = this.db
      .prepare(
        `SELECT id, image_path, user_note, raw_extraction, uploaded_at
         FROM screenshots
         WHERE id = ?`,
      )
      .get(screenshotId) as
      | {
          id: number;
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
      ...row,
      raw_extraction: row.raw_extraction ? JSON.parse(row.raw_extraction) : null,
    };
  }

  listActionCardsByScreenshotId(screenshotId: number): ActionCardRecord[] {
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
      .all(screenshotId) as Array<{
      id: number;
      screenshot_id: number;
      type: ActionCard["type"];
      payload: string;
      confidence: ActionCard["confidence"];
      source_quote: string;
      disambiguation: string | null;
      status: ActionCardRecord["status"];
      resolved_contact_id: number | null;
      created_at: string;
      resolved_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      screenshot_id: row.screenshot_id,
      type: row.type,
      payload: JSON.parse(row.payload),
      confidence: row.confidence,
      source_quote: row.source_quote,
      disambiguation: row.disambiguation ? JSON.parse(row.disambiguation) : null,
      status: row.status,
      resolved_contact_id: row.resolved_contact_id,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    })) as ActionCardRecord[];
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
