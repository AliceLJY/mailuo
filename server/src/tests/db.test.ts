import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { MAILUO_SCHEMA_SQL } from "../../../shared/core/schema.ts";
import type { ActionCard } from "../../../shared/types.ts";
import { MailuoDb } from "../db.ts";

function withTempDb() {
  const directory = mkdtempSync(join(tmpdir(), "mailuo-db-"));
  const databasePath = join(directory, "mailuo.sqlite");
  const db = new MailuoDb(databasePath);

  return {
    db,
    cleanup() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type SchemaRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

function readMeetingTableInfo(db: MailuoDb): TableInfoRow[] {
  return db.getNativeDatabase().prepare("PRAGMA table_info(meetings)").all() as TableInfoRow[];
}

function readUserVersion(db: MailuoDb): number {
  const row = db.getNativeDatabase().prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

function readSchema(db: MailuoDb): SchemaRow[] {
  return db
    .getNativeDatabase()
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as SchemaRow[];
}

test("migrates the complete legacy v0 schema through v1 and matches a fresh database", () => {
  const directory = mkdtempSync(join(tmpdir(), "mailuo-migration-"));
  const legacyPath = join(directory, "legacy.sqlite");
  const freshPath = join(directory, "fresh.sqlite");
  const legacyDb = new DatabaseSync(legacyPath);
  let legacyOpen = true;
  let migratedDb: MailuoDb | undefined;
  let freshDb: MailuoDb | undefined;

  try {
    legacyDb.exec(MAILUO_SCHEMA_SQL);
    legacyDb.prepare(
      `INSERT INTO meetings (title, time_iso, time_text, participants, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "旧版会议",
      "2026-09-03T10:00:00+08:00",
      "9月3日上午十点",
      "[]",
      "upcoming",
      "2026-09-01T00:00:00.000Z",
    );
    const legacyColumns = legacyDb.prepare("PRAGMA table_info(meetings)").all() as TableInfoRow[];
    const legacyVersion = legacyDb.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };

    assert.equal(legacyColumns.some((column) => column.name === "kind"), false);
    assert.equal(legacyVersion.user_version, 0);
    legacyDb.close();
    legacyOpen = false;

    migratedDb = new MailuoDb(legacyPath);
    freshDb = new MailuoDb(freshPath);

    const migratedRow = migratedDb
      .getNativeDatabase()
      .prepare("SELECT title, time_text, kind FROM meetings WHERE title = ?")
      .get("旧版会议") as { title: string; time_text: string; kind: string };
    const kindColumn = readMeetingTableInfo(migratedDb).find((column) => column.name === "kind");

    assert.deepEqual(kindColumn, {
      cid: 10,
      name: "kind",
      type: "TEXT",
      notnull: 1,
      dflt_value: "'meeting'",
      pk: 0,
    });
    assert.deepEqual(migratedRow, {
      title: "旧版会议",
      time_text: "9月3日上午十点",
      kind: "meeting",
    });
    assert.equal(readUserVersion(migratedDb), 1);
    assert.equal(readUserVersion(freshDb), 1);
    assert.deepEqual(readMeetingTableInfo(migratedDb), readMeetingTableInfo(freshDb));
    assert.deepEqual(readSchema(migratedDb), readSchema(freshDb));

    // The DB column deliberately has no enum CHECK; application validation owns legal values.
    freshDb
      .getNativeDatabase()
      .prepare(
        `INSERT INTO meetings (title, time_text, participants, status, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("未来类型探针", "", "[]", "upcoming", "2026-09-01T00:00:00.000Z", "future-kind");
    const futureKindRow = freshDb
      .getNativeDatabase()
      .prepare("SELECT kind FROM meetings WHERE title = ?")
      .get("未来类型探针") as { kind: string };
    assert.equal(futureKindRow.kind, "future-kind");

    migratedDb.close();
    migratedDb = undefined;
    migratedDb = new MailuoDb(legacyPath);
    assert.equal(readUserVersion(migratedDb), 1);
    assert.equal(
      readMeetingTableInfo(migratedDb).filter((column) => column.name === "kind").length,
      1,
    );
  } finally {
    if (legacyOpen) {
      legacyDb.close();
    }
    migratedDb?.close();
    freshDb?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initializes the full M1 schema", () => {
  const { db, cleanup } = withTempDb();

  try {
    const tables = db
      .getNativeDatabase()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    assert.deepEqual(
      tables.map((table) => table.name),
      [
        "action_cards",
        "contacts",
        "insights",
        "meetings",
        "observations",
        "screenshots",
      ],
    );
  } finally {
    cleanup();
  }
});

test("stores M2 action card types and full meeting participants in schema", () => {
  const { db, cleanup } = withTempDb();

  try {
    const rows = db
      .getNativeDatabase()
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('action_cards', 'meetings') ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string }>;
    const byName = new Map(rows.map((row) => [row.name, row.sql]));

    assert.match(byName.get("action_cards") ?? "", /record_interaction/);
    assert.match(byName.get("meetings") ?? "", /\bparticipants\b/);
    assert.doesNotMatch(byName.get("meetings") ?? "", /\bparticipant_ids\b/);
  } finally {
    cleanup();
  }
});

test("stores screenshots, raw extraction, and all action card types", () => {
  const { db, cleanup } = withTempDb();

  try {
    const screenshot = db.createScreenshot({
      imagePath: "/tmp/test-shot.png",
      userNote: "补充说明",
      uploadedAt: "2026-08-26T00:00:00.000Z",
    });

    const cards: ActionCard[] = [
      {
        type: "create_contact",
        payload: {
          name: "王磊",
          company: "未来科技",
          title: "市场总监",
        },
        confidence: "high",
        source_quote: "我是未来科技的市场总监王磊",
      },
      {
        type: "update_contact",
        payload: {
          contact_id: 1,
          contact_name: "王磊",
          changes: {
            company: {
              old: "旧公司",
              new: "未来科技",
            },
          },
        },
        confidence: "medium",
        source_quote: "王磊现在在未来科技",
      },
      {
        type: "create_meeting",
        payload: {
          title: "聊合作",
          time_iso: "2026-09-02T15:00:00+08:00",
          time_text: "下周三下午三点",
          participants: [{ name: "王磊" }],
        },
        confidence: "medium",
        source_quote: "下周三下午三点来我们公司聊合作",
      },
      {
        type: "record_interaction",
        payload: {
          contact_name: "王磊",
          summary: "确认下周继续推进合作",
        },
        confidence: "high",
        source_quote: "下周继续推进合作",
      },
    ];

    const savedCards = db.saveScreenshotAnalysis({
      screenshotId: screenshot.id,
      rawExtraction: { participants: [{ name: "王磊" }], events: [] },
      cards,
      createdAt: "2026-08-26T00:01:00.000Z",
    });

    const savedScreenshot = db.getScreenshotById(screenshot.id);
    const listedCards = db.listActionCardsByScreenshotId(screenshot.id);

    assert.equal(savedCards.length, 4);
    assert.equal(savedScreenshot?.image_path, "/tmp/test-shot.png");
    assert.deepEqual(savedScreenshot?.raw_extraction, {
      participants: [{ name: "王磊" }],
      events: [],
    });
    assert.deepEqual(
      listedCards.map((card) => card.type),
      ["create_contact", "update_contact", "create_meeting", "record_interaction"],
    );
    assert.deepEqual(listedCards[0]?.payload, cards[0]?.payload);
    assert.deepEqual(listedCards[1]?.payload, cards[1]?.payload);
    assert.deepEqual(listedCards[2]?.payload, cards[2]?.payload);
    assert.deepEqual(listedCards[3]?.payload, cards[3]?.payload);
  } finally {
    cleanup();
  }
});

test("deleteScreenshotUploadArtifacts removes only the targeted upload records", () => {
  const { db, cleanup } = withTempDb();

  try {
    const preservedScreenshot = db.createScreenshot({
      imagePath: "/tmp/preserved-shot.png",
      uploadedAt: "2026-08-26T00:00:00.000Z",
    });
    const failedScreenshot = db.createScreenshot({
      imagePath: "/tmp/failed-shot.png",
      uploadedAt: "2026-08-26T00:01:00.000Z",
    });

    db.saveScreenshotAnalysis({
      screenshotId: preservedScreenshot.id,
      rawExtraction: { participants: [], events: [] },
      cards: [
        {
          type: "create_contact",
          payload: { name: "王磊" },
          confidence: "high",
          source_quote: "我是未来科技的市场总监王磊",
        },
      ],
      createdAt: "2026-08-26T00:02:00.000Z",
    });
    db.saveScreenshotAnalysis({
      screenshotId: failedScreenshot.id,
      rawExtraction: { participants: [{ name: "李姐" }], events: [] },
      cards: [
        {
          type: "create_contact",
          payload: { name: "李姐" },
          confidence: "medium",
          source_quote: "李姐，下周三下午三点来我们公司聊合作",
        },
      ],
      createdAt: "2026-08-26T00:03:00.000Z",
    });

    const cleanupResult = db.deleteScreenshotUploadArtifacts(failedScreenshot.id);

    assert.deepEqual(cleanupResult, {
      deletedCardCount: 1,
      deletedScreenshot: true,
    });
    assert.equal(db.getScreenshotById(failedScreenshot.id), null);
    assert.deepEqual(db.listActionCardsByScreenshotId(failedScreenshot.id), []);
    assert.equal(db.getScreenshotById(preservedScreenshot.id)?.image_path, "/tmp/preserved-shot.png");
    assert.equal(db.listActionCardsByScreenshotId(preservedScreenshot.id).length, 1);
  } finally {
    cleanup();
  }
});
