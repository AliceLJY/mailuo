import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeMailuoSchema } from "../../../shared/core/migrations.ts";

// Why this file exists, and why it doesn't import ExpoSqliteLocalStore directly:
//
// `app/src/local/store.ts` implements LocalStore on top of expo-sqlite's SQLiteDatabase, and
// expo-sqlite's `index.js` imports `react-native` (for `Platform`) at the top level. Under
// plain `node --import tsx --test` (this project's test runner — see package.json's "test"
// script) there's no Metro bundler to do .native.js/.web.js platform-extension resolution, so
// requiring `react-native` fails to even parse ("Unexpected \"typeof\"" from esbuild on
// react-native/index.js, confirmed by actually running this file with the import in place
// before rewriting it). This is exactly why every other test in this suite exercises LocalStore
// through the hand-written in-memory FakeLocalStore (local-api.test.ts) instead of the real
// ExpoSqliteLocalStore — no test in this project has ever imported store.ts, for this reason.
//
// FakeLocalStore is fine for business-logic tests, but it can't prove the one claim fix16's
// deleteContact needs proven: that its DELETE/UPDATE ordering doesn't trip
// SQLITE_CONSTRAINT_FOREIGNKEY under PRAGMA foreign_keys=ON (which the real store's constructor
// turns on) — a plain-JS fake has no concept of foreign keys at all, so it can't fail that way
// even if the real ordering were wrong.
//
// `shared/core/migrations.ts` (which builds the exact same schema store.ts uses) has zero
// react-native/expo-sqlite dependency and imports cleanly under plain node — confirmed directly.
// So this file uses node:sqlite (already this project's own server-side storage engine, see
// server/src/db.ts) to build the real schema and mirrors deleteContact's five-step delete
// sequence verbatim from app/src/local/store.ts's `deleteContact` method, run against that real
// schema with real FK enforcement. This is deliberately NOT a call into the production method —
// it's the closest proof obtainable under this test runner's constraints. If deleteContact's
// SQL sequence in store.ts ever changes, this mirror must be updated to match, or it will start
// giving false confidence.
function createRealSchemaDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeMailuoSchema({
    exec: (sql) => db.exec(sql),
    getUserVersion: () => {
      const row = db.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      return row?.user_version ?? 0;
    },
  });
  return db;
}

function insertContact(db: DatabaseSync, canonicalName: string): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO contacts (canonical_name, aliases, tags, created_at, updated_at)
       VALUES (?, '[]', '[]', ?, ?)`,
    )
    .run(canonicalName, now, now);
  return Number(result.lastInsertRowid);
}

function insertMeetingRow(
  db: DatabaseSync,
  participants: Array<{ contact_id?: number; name: string }>,
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO meetings (title, time_text, participants, status, created_at, kind)
       VALUES (?, ?, ?, 'upcoming', ?, 'meeting')`,
    )
    .run("测试会议", "下周", JSON.stringify(participants), now);
  return Number(result.lastInsertRowid);
}

// Verbatim mirror of ExpoSqliteLocalStore.deleteContact (app/src/local/store.ts). Keep the
// five steps and their order in sync with that method.
function deleteContactMirroringStoreImplementation(db: DatabaseSync, contactId: number): boolean {
  db.exec("BEGIN");

  try {
    db.prepare("DELETE FROM insights WHERE contact_id = ?").run(contactId);
    db.prepare("DELETE FROM observations WHERE contact_id = ?").run(contactId);
    db.prepare(
      "UPDATE action_cards SET resolved_contact_id = NULL WHERE resolved_contact_id = ?",
    ).run(contactId);

    const meetingRows = db.prepare("SELECT id, participants FROM meetings").all() as Array<{
      id: number;
      participants: string;
    }>;

    for (const row of meetingRows) {
      const participants = JSON.parse(row.participants) as Array<{
        contact_id?: number;
        name: string;
      }>;
      const hasContact = participants.some((participant) => participant.contact_id === contactId);

      if (!hasContact) {
        continue;
      }

      const stripped = participants.map((participant) =>
        participant.contact_id === contactId ? { name: participant.name } : participant,
      );
      db.prepare("UPDATE meetings SET participants = ? WHERE id = ?").run(
        JSON.stringify(stripped),
        row.id,
      );
    }

    const result = db.prepare("DELETE FROM contacts WHERE id = ?").run(contactId);
    db.exec("COMMIT");
    return Number(result.changes) > 0;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test(
  "deleteContact's delete/update ordering does not violate SQLITE_CONSTRAINT_FOREIGNKEY " +
    "under PRAGMA foreign_keys=ON, and cascades observations/insights/action_cards/meeting " +
    "participants correctly",
  () => {
    const db = createRealSchemaDatabase();
    const contactId = insertContact(db, "王五");
    const otherContactId = insertContact(db, "赵六");

    // action_cards.screenshot_id is NOT NULL REFERENCES screenshots(id) — needs a real row.
    const now = new Date().toISOString();
    const screenshotResult = db
      .prepare(
        "INSERT INTO screenshots (image_path, uploaded_at) VALUES (?, ?)",
      )
      .run("file:///test-fixture.png", now);
    const screenshotId = Number(screenshotResult.lastInsertRowid);

    const cardResult = db
      .prepare(
        `INSERT INTO action_cards (
           screenshot_id, type, payload, confidence, source_quote, status,
           resolved_contact_id, created_at, resolved_at
         ) VALUES (?, 'record_interaction', '{}', 'high', '原文引用', 'confirmed', ?, ?, ?)`,
      )
      .run(screenshotId, contactId, now, now);
    const cardId = Number(cardResult.lastInsertRowid);

    db.prepare(
      `INSERT INTO observations (contact_id, kind, content, observed_at)
       VALUES (?, 'fact', '喜欢喝茶', ?)`,
    ).run(contactId, now);

    db.prepare(
      `INSERT INTO insights (contact_id, kind, content, based_on, generated_at)
       VALUES (?, 'relationship_read', '关系不错', '[]', ?)`,
    ).run(contactId, now);

    const meetingId = insertMeetingRow(db, [
      { contact_id: contactId, name: "王五" },
      { contact_id: otherContactId, name: "赵六" },
    ]);

    // Sanity check: fixtures are actually in place before deleting.
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM observations WHERE contact_id = ?").get(contactId) as { n: number }).n,
      1,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM insights WHERE contact_id = ?").get(contactId) as { n: number }).n,
      1,
    );

    // The assertion that matters: this must not throw SQLITE_CONSTRAINT_FOREIGNKEY. A wrong
    // delete order in the mirrored sequence above would surface as an uncaught exception here,
    // not as a false "true"/"false" result.
    const deleted = deleteContactMirroringStoreImplementation(db, contactId);
    assert.equal(deleted, true);

    assert.equal(
      db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId),
      undefined,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM observations WHERE contact_id = ?").get(contactId) as { n: number }).n,
      0,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM insights WHERE contact_id = ?").get(contactId) as { n: number }).n,
      0,
    );

    const card = db.prepare("SELECT resolved_contact_id FROM action_cards WHERE id = ?").get(cardId) as {
      resolved_contact_id: number | null;
    };
    assert.equal(card.resolved_contact_id, null);

    const meeting = db.prepare("SELECT participants FROM meetings WHERE id = ?").get(meetingId) as {
      participants: string;
    };
    assert.deepEqual(JSON.parse(meeting.participants), [
      { name: "王五" },
      { contact_id: otherContactId, name: "赵六" },
    ]);

    // Deleting an already-gone contact is a safe no-op, matching deleteMeeting's contract.
    assert.equal(deleteContactMirroringStoreImplementation(db, contactId), false);

    db.close();
  },
);
