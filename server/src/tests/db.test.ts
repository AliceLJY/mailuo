import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
