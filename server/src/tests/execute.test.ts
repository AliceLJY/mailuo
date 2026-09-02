import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ActionCardConflictError,
  ExecuteDependencyError,
  ExecuteValidationError,
  executeCard,
  rejectCard,
} from "../agent/execute.ts";
import {
  MailuoDb,
  type StoredActionCard,
  type StoredActionCardRecord,
} from "../db.ts";

const seedSql = readFileSync(new URL("../../../fixtures/seed.sql", import.meta.url), "utf8");

function withTempDb(DbClass: typeof MailuoDb = MailuoDb) {
  const directory = mkdtempSync(join(tmpdir(), "mailuo-execute-"));
  const databasePath = join(directory, "mailuo.sqlite");
  const db = new DbClass(databasePath);

  return {
    db,
    cleanup() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function seedDb(db: MailuoDb) {
  db.getNativeDatabase().exec(seedSql);
}

function createPendingCard(args: {
  db: MailuoDb;
  rawExtraction: unknown;
  card: StoredActionCard;
  imagePath?: string;
}): StoredActionCardRecord {
  const screenshot = args.db.createScreenshot({
    imagePath: args.imagePath ?? "/tmp/test-shot.png",
    uploadedAt: "2026-08-26T00:00:00.000Z",
  });

  args.db
    .getNativeDatabase()
    .prepare("UPDATE screenshots SET raw_extraction = ? WHERE id = ?")
    .run(JSON.stringify(args.rawExtraction), screenshot.id);

  return args.db.insertActionCard({
    screenshotId: screenshot.id,
    card: args.card,
    createdAt: "2026-08-26T00:01:00.000Z",
  });
}

function countRows(db: MailuoDb, table: string) {
  const row = db
    .getNativeDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };

  return row.count;
}

test("executeCard creates a contact and stores related fact/preference observations", () => {
  const { db, cleanup } = withTempDb();

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "王磊",
            aliases: ["老王"],
            company: "未来科技",
            title: "市场总监",
            phone: "13800000000",
            notes: "更喜欢线下面聊",
            confidence: "high",
            source_quote: "我是未来科技的市场总监王磊，电话 13800000000，更喜欢线下面聊",
          },
        ],
        events: [],
        facts: [
          {
            subject_name: "王磊",
            field: "wechat_id",
            value: "wanglei_future",
            confidence: "high",
            source_quote: "微信号是 wanglei_future",
          },
        ],
        quotes: [],
      },
      card: {
        type: "create_contact",
        payload: {
          name: "王磊",
          aliases: ["王总"],
          company: "未来科技",
          title: "市场总监",
          phone: "13800000000",
          notes: "更喜欢线下面聊",
        },
        confidence: "high",
        source_quote: "我是未来科技的市场总监王磊，电话 13800000000，更喜欢线下面聊",
      },
    });

    const result = executeCard({ db, cardId: card.id });
    const contactId = result.affectedContactIds[0];
    const detail = db.getContactDetail(contactId);

    assert.equal(result.confirmedCard.status, "confirmed");
    assert.equal(result.confirmedCard.resolved_contact_id, contactId);
    assert.ok(contactId);
    assert.ok(detail);
    assert.equal(detail.contact.canonical_name, "王磊");
    assert.deepEqual(detail.contact.aliases.sort(), ["王总", "老王"]);
    assert.equal(result.observationIds.length >= 4, true);
    assert.ok(detail.observations.some((item) => item.kind === "fact" && item.content === "公司: 未来科技"));
    assert.ok(detail.observations.some((item) => item.kind === "fact" && item.content === "职位: 市场总监"));
    assert.ok(detail.observations.some((item) => item.kind === "fact" && item.content === "微信号: wanglei_future"));
    assert.ok(detail.observations.some((item) => item.kind === "preference" && item.content === "更喜欢线下面聊"));
  } finally {
    cleanup();
  }
});

test("executeCard merges create_contact into an existing contact, appends aliases, and avoids duplicate facts", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "陈老师",
            aliases: ["昕姐"],
            company: "新视界传媒",
            confidence: "high",
            source_quote: "我现在在新视界传媒，还是负责内容合作",
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_contact",
        payload: {
          name: "陈老师",
          aliases: ["昕姐"],
          company: "新视界传媒",
        },
        confidence: "high",
        source_quote: "我现在在新视界传媒，还是负责内容合作",
        disambiguation: {
          candidates: [{ contact_id: 1, name: "陈昕", company: "云沐内容" }],
        },
      },
    });

    const beforeCount = countRows(db, "contacts");
    const result = executeCard({ db, cardId: card.id, resolvedContactId: 1 });
    const detail = db.getContactDetail(1);

    assert.equal(countRows(db, "contacts"), beforeCount);
    assert.equal(result.confirmedCard.resolved_contact_id, 1);
    assert.ok(detail);
    assert.equal(detail.contact.company, "新视界传媒");
    assert.ok(detail.contact.aliases.includes("陈老师"));
    assert.ok(detail.contact.aliases.includes("昕姐"));
    assert.ok(
      detail.observations.some(
        (item) =>
          item.kind === "status_change" &&
          item.content === '公司由 "云沐内容" 变为 "新视界传媒"' &&
          item.source_quote === "我现在在新视界传媒，还是负责内容合作",
      ),
    );
    assert.equal(
      detail.observations.some(
        (item) => item.kind === "fact" && item.content === "公司: 新视界传媒",
      ),
      false,
    );
  } finally {
    cleanup();
  }
});

test("executeCard dedupes fact and preference content across screenshots while preserving earliest provenance", () => {
  const { db, cleanup } = withTempDb();

  try {
    const contact = db.createContact({
      canonicalName: "王磊",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    });
    const firstCard = createPendingCard({
      db,
      imagePath: "/tmp/fact-first.png",
      rawExtraction: {
        participants: [
          {
            name: "王磊",
            company: "某集团",
            notes: "偏好线下沟通",
            confidence: "high",
            source_quote: "王磊目前在某集团任职，也偏好线下沟通",
          },
        ],
        events: [],
        facts: [
          {
            subject_name: "王磊",
            field: "company",
            value: "某集团",
            confidence: "high",
            source_quote: "公司信息为某集团",
          },
          {
            subject_name: "王磊",
            field: "notes",
            value: "偏好线下沟通",
            confidence: "high",
            source_quote: "王磊偏好线下沟通",
          },
        ],
        quotes: [],
      },
      card: {
        type: "record_interaction",
        payload: {
          contact_id: contact.id,
          contact_name: "王磊",
          summary: "讨论合作",
        },
        confidence: "high",
        source_quote: "讨论合作",
      },
    });

    executeCard({ db, cardId: firstCard.id });

    const firstDetail = db.getContactDetail(contact.id);
    assert.ok(firstDetail);
    const firstFact = firstDetail.observations.find(
      (item) => item.kind === "fact" && item.content === "公司: 某集团",
    );
    const firstPreference = firstDetail.observations.find(
      (item) => item.kind === "preference" && item.content === "偏好线下沟通",
    );
    assert.ok(firstFact);
    assert.ok(firstPreference);
    assert.equal(firstFact.source_quote, "公司信息为某集团");
    assert.equal(firstPreference.source_quote, "王磊偏好线下沟通");

    const originalObservedAt = "2026-08-26T00:02:00.000Z";
    db.getNativeDatabase()
      .prepare("UPDATE observations SET observed_at = ? WHERE id IN (?, ?)")
      .run(originalObservedAt, firstFact.id, firstPreference.id);

    const secondCard = createPendingCard({
      db,
      imagePath: "/tmp/fact-second.png",
      rawExtraction: {
        participants: [
          {
            name: "王磊",
            company: "某集团",
            notes: "偏好线下沟通",
            confidence: "high",
            source_quote: "某集团。偏好线下沟通",
          },
        ],
        events: [],
        facts: [
          {
            subject_name: "王磊",
            field: "company",
            value: "某集团",
            confidence: "high",
            source_quote: "公司是某集团",
          },
          {
            subject_name: "王磊",
            field: "notes",
            value: "偏好线下沟通",
            confidence: "high",
            source_quote: "明确偏好线下沟通",
          },
        ],
        quotes: [],
      },
      card: {
        type: "record_interaction",
        payload: {
          contact_id: contact.id,
          contact_name: "王磊",
          summary: "讨论合作",
        },
        confidence: "high",
        source_quote: "讨论合作",
      },
    });

    executeCard({ db, cardId: secondCard.id });

    const detail = db.getContactDetail(contact.id);
    assert.ok(detail);
    const facts = detail.observations.filter(
      (item) => item.kind === "fact" && item.content === "公司: 某集团",
    );
    const preferences = detail.observations.filter(
      (item) => item.kind === "preference" && item.content === "偏好线下沟通",
    );
    const interactions = detail.observations.filter(
      (item) => item.kind === "interaction" && item.content === "讨论合作",
    );

    assert.equal(facts.length, 1);
    assert.equal(facts[0].id, firstFact.id);
    assert.equal(facts[0].screenshot_id, firstCard.screenshot_id);
    assert.equal(facts[0].observed_at, originalObservedAt);
    assert.equal(facts[0].source_quote, "某集团");
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0].id, firstPreference.id);
    assert.equal(preferences[0].screenshot_id, firstCard.screenshot_id);
    assert.equal(preferences[0].observed_at, originalObservedAt);
    assert.equal(preferences[0].source_quote, "偏好线下沟通");
    assert.equal(interactions.length, 2);
    assert.deepEqual(
      new Set(interactions.map((item) => item.screenshot_id)),
      new Set([firstCard.screenshot_id, secondCard.screenshot_id]),
    );
  } finally {
    cleanup();
  }
});

test("executeCard uses the shortest participant sentence that contains a field value and falls back to the full quote", () => {
  const { db, cleanup } = withTempDb();

  try {
    const contact = db.createContact({ canonicalName: "王磊" });
    const sourceQuote = "开场说明。王磊在某集团任职。某集团。只介绍了近况";
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "王磊",
            company: "某集团",
            title: "市场总监",
            confidence: "high",
            source_quote: sourceQuote,
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "record_interaction",
        payload: {
          contact_id: contact.id,
          contact_name: "王磊",
          summary: "介绍近况",
        },
        confidence: "high",
        source_quote: "介绍近况",
      },
    });

    executeCard({ db, cardId: card.id });

    const detail = db.getContactDetail(contact.id);
    assert.ok(detail);
    assert.equal(
      detail.observations.find((item) => item.content === "公司: 某集团")?.source_quote,
      "某集团",
    );
    assert.equal(
      detail.observations.find((item) => item.content === "职位: 市场总监")?.source_quote,
      sourceQuote,
    );
  } finally {
    cleanup();
  }
});

test('executeCard rejects create_contact cards for the self name "我" and leaves the card pending', () => {
  const { db, cleanup } = withTempDb();

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: '我',
            aliases: ['Alice'],
            confidence: 'high',
            source_quote: '我来加一下自己',
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: 'create_contact',
        payload: {
          name: ' 我 ',
          aliases: ['Alice'],
        },
        confidence: 'high',
        source_quote: '我来加一下自己',
      },
    });

    assert.throws(
      () => executeCard({ db, cardId: card.id }),
      (error) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.equal(error.statusCode, 422);
        assert.equal(error.message, 'create_contact cannot create or merge the self contact "我"');
        return true;
      },
    );

    assert.equal(countRows(db, 'contacts'), 0);
    assert.equal(countRows(db, 'observations'), 0);
    assert.equal(db.getStoredActionCardById(card.id)?.status, 'pending');
  } finally {
    cleanup();
  }
});

test('executeCard rejects create_contact cards when any alias normalizes to "我"', () => {
  const { db, cleanup } = withTempDb();

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "王磊",
            aliases: ["我"],
            confidence: "high",
            source_quote: "他们有时直接叫我",
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_contact",
        payload: {
          name: "王磊",
          aliases: [" 我 ", "老王"],
        },
        confidence: "high",
        source_quote: "他们有时直接叫我",
      },
    });

    assert.throws(
      () => executeCard({ db, cardId: card.id }),
      (error) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.equal(error.statusCode, 422);
        assert.equal(error.message, 'create_contact cannot create or merge the self contact "我"');
        return true;
      },
    );

    assert.equal(countRows(db, "contacts"), 0);
    assert.equal(countRows(db, "observations"), 0);
    assert.equal(db.getStoredActionCardById(card.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test('executeCard rejects create_contact merges that would append alias "我"', () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const beforeObservationCount = countRows(db, "observations");
    const beforeAliases = db.getContactDetail(1)?.contact.aliases ?? [];
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "陈老师",
            aliases: ["我"],
            confidence: "high",
            source_quote: "也有人直接叫我",
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_contact",
        payload: {
          name: "陈老师",
          aliases: ["我", "昕姐"],
        },
        confidence: "high",
        source_quote: "也有人直接叫我",
        disambiguation: {
          candidates: [{ contact_id: 1, name: "陈昕", company: "云沐内容" }],
        },
      },
    });

    assert.throws(
      () => executeCard({ db, cardId: card.id, resolvedContactId: 1 }),
      (error) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.equal(error.statusCode, 422);
        assert.equal(error.message, 'create_contact cannot create or merge the self contact "我"');
        return true;
      },
    );

    assert.equal(countRows(db, "contacts"), 2);
    assert.equal(countRows(db, "observations"), beforeObservationCount);
    assert.deepEqual(db.getContactDetail(1)?.contact.aliases, beforeAliases);
    assert.equal(db.getStoredActionCardById(card.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test("executeCard merge preserves omitted optional contact fields and skips bogus status_change rows", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "陈老师",
            company: "新视界传媒",
            confidence: "high",
            source_quote: "我现在在新视界传媒",
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_contact",
        payload: {
          name: "陈老师",
          company: "新视界传媒",
        },
        confidence: "high",
        source_quote: "我现在在新视界传媒",
        disambiguation: {
          candidates: [{ contact_id: 1, name: "陈昕", company: "云沐内容" }],
        },
      },
    });

    executeCard({ db, cardId: card.id, resolvedContactId: 1 });
    const detail = db.getContactDetail(1);

    assert.ok(detail);
    assert.equal(detail.contact.company, "新视界传媒");
    assert.equal(detail.contact.phone, "13900003157");
    assert.equal(detail.contact.wechat_id, "chenxin_ym");
    assert.equal(detail.contact.notes, "fictional seed contact for screenshot-3 update scenario");

    const screenshotStatusChanges = detail.observations.filter(
      (item) => item.screenshot_id === card.screenshot_id && item.kind === "status_change",
    );

    assert.deepEqual(screenshotStatusChanges.map((item) => item.content), [
      '公司由 "云沐内容" 变为 "新视界传媒"',
    ]);
  } finally {
    cleanup();
  }
});

test("executeCard uses the current DB value for update_contact status_change content", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "陈昕",
            company: "山海文化",
            confidence: "high",
            source_quote: "我上个月跳槽去了山海文化",
          },
        ],
        events: [],
        facts: [
          {
            subject_name: "陈昕",
            field: "company",
            value: "山海文化",
            confidence: "high",
            source_quote: "我上个月跳槽去了山海文化",
          },
        ],
        quotes: [],
      },
      card: {
        type: "update_contact",
        payload: {
          contact_id: 1,
          contact_name: "陈昕",
          changes: {
            company: {
              old: "错误旧值",
              new: "山海文化",
            },
          },
        },
        confidence: "high",
        source_quote: "我上个月跳槽去了山海文化",
      },
    });

    executeCard({ db, cardId: card.id });
    const detail = db.getContactDetail(1);

    assert.ok(detail);
    assert.equal(detail.contact.company, "山海文化");
    assert.ok(
      detail.observations.some(
        (item) => item.kind === "status_change" && item.content === '公司由 "云沐内容" 变为 "山海文化"',
      ),
    );
    assert.equal(
      detail.observations.some((item) => item.kind === "fact" && item.content === "公司: 山海文化"),
      false,
    );
  } finally {
    cleanup();
  }
});

test('executeCard rejects update_contact and record_interaction when they target a historical self contact', () => {
  const { db, cleanup } = withTempDb();

  try {
    const selfContact = db.createContact({
      canonicalName: "Alice",
      aliases: [" 我 "],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const updateCard = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "update_contact",
        payload: {
          contact_id: selfContact.id,
          contact_name: "Alice",
          changes: {
            notes: {
              old: null,
              new: "不该写入 self 档案",
            },
          },
        },
        confidence: "high",
        source_quote: "给自己加备注",
      },
    });
    const interactionCard = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "record_interaction",
        payload: {
          contact_id: selfContact.id,
          contact_name: "Alice",
          summary: "不该写入 self 互动",
        },
        confidence: "high",
        source_quote: "今天我又补了一句",
      },
      imagePath: "/tmp/self-contact-interaction.png",
    });

    assert.throws(
      () => executeCard({ db, cardId: updateCard.id }),
      (error) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.equal(error.statusCode, 422);
        assert.equal(error.message, 'update_contact cannot target the self contact "我"');
        return true;
      },
    );
    assert.throws(
      () => executeCard({ db, cardId: interactionCard.id }),
      (error) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.equal(error.statusCode, 422);
        assert.equal(error.message, 'record_interaction cannot target the self contact "我"');
        return true;
      },
    );

    assert.equal(db.getContactDetail(selfContact.id)?.contact.notes, null);
    assert.equal(countRows(db, "observations"), 0);
    assert.equal(db.getStoredActionCardById(updateCard.id)?.status, "pending");
    assert.equal(db.getStoredActionCardById(interactionCard.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test('executeCard rejects update_contact and record_interaction when contact_name normalizes to "我" even with a normal contact_id', () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const beforeDetail = db.getContactDetail(1);
    const beforeObservationCount = countRows(db, "observations");
    const updateCard = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "update_contact",
        payload: {
          contact_id: 1,
          contact_name: " 我 ",
          changes: {
            notes: {
              old: beforeDetail?.contact.notes ?? null,
              new: "不该写入普通联系人",
            },
          },
        },
        confidence: "high",
        source_quote: "给我自己补一句",
      },
    });
    const interactionCard = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "record_interaction",
        payload: {
          contact_id: 1,
          contact_name: "我",
          summary: "不该写入普通联系人互动",
        },
        confidence: "high",
        source_quote: "我自己补一句互动",
      },
      imagePath: "/tmp/normalized-self-name-interaction.png",
    });

    assert.throws(
      () => executeCard({ db, cardId: updateCard.id }),
      (error) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.equal(error.statusCode, 422);
        assert.equal(error.message, 'update_contact cannot target the self contact "我"');
        return true;
      },
    );
    assert.throws(
      () => executeCard({ db, cardId: interactionCard.id }),
      (error) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.equal(error.statusCode, 422);
        assert.equal(error.message, 'record_interaction cannot target the self contact "我"');
        return true;
      },
    );

    const afterDetail = db.getContactDetail(1);
    assert.ok(beforeDetail);
    assert.ok(afterDetail);
    assert.equal(afterDetail.contact.notes, beforeDetail.contact.notes);
    assert.equal(afterDetail.contact.company, beforeDetail.contact.company);
    assert.equal(countRows(db, "observations"), beforeObservationCount);
    assert.equal(db.getStoredActionCardById(updateCard.id)?.status, "pending");
    assert.equal(db.getStoredActionCardById(interactionCard.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test("executeCard creates meetings and retains unresolved participant names", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_meeting",
        payload: {
          title: "聊合作",
          time_iso: "2026-09-02T15:00:00+08:00",
          time_text: "下周三下午三点",
          location: "云沐会议室",
          participants: [
            { contact_id: 1, name: "陈老师" },
            { name: "魏总" },
          ],
        },
        confidence: "medium",
        source_quote: "下周三下午三点，陈老师和魏总一起过来聊合作",
      },
    });

    const result = executeCard({ db, cardId: card.id });
    const meetings = db.listMeetings();

    assert.equal(result.meetingId != null, true);
    assert.deepEqual(result.affectedContactIds, [1]);
    assert.equal(countRows(db, "contacts"), 2);
    assert.equal(meetings[0]?.kind, "meeting");
    assert.deepEqual(meetings[0]?.participants, [
      { contact_id: 1, name: "陈老师" },
      { name: "魏总" },
    ]);
  } finally {
    cleanup();
  }
});

test("executeCard persists a standalone item with empty time and participants", () => {
  const { db, cleanup } = withTempDb();

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [
          {
            kind: "other",
            title: "准备报名材料",
            time_text: "",
            time_iso: null,
            has_time_signal: false,
            participant_names: [],
            confidence: "high",
            source_quote: "报名要带身份证复印件和两张照片",
          },
        ],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_meeting",
        payload: {
          kind: "other",
          title: "准备报名材料",
          time_iso: null,
          time_text: "",
          participants: [],
        },
        confidence: "high",
        source_quote: "报名要带身份证复印件和两张照片",
      },
    });

    const result = executeCard({ db, cardId: card.id });
    const meetings = db.listMeetings();

    assert.equal(result.meetingId, meetings[0]?.id);
    assert.deepEqual(result.affectedContactIds, []);
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0]?.kind, "other");
    assert.equal(meetings[0]?.time_iso, null);
    assert.equal(meetings[0]?.time_text, "");
    assert.deepEqual(meetings[0]?.participants, []);
  } finally {
    cleanup();
  }
});

test("executeCard updates a duplicate meeting without inserting a new row", () => {
  const { db, cleanup } = withTempDb();

  try {
    const existing = db.insertMeeting({
      kind: "other",
      title: "准备报名材料",
      timeIso: null,
      timeText: "",
      location: "一楼服务大厅",
      participants: [{ name: "王老师" }],
      agenda: "携带身份证复印件",
      status: "upcoming",
      createdAt: "2026-08-20T01:00:00.000Z",
    });
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_meeting",
        payload: {
          kind: "other",
          title: "准备报名材料",
          time_iso: "2026-09-03T09:00:00+08:00",
          time_text: "9月3日上午9点",
          location: "二楼窗口",
          participants: [{ name: "王老师" }],
          agenda: "携带身份证复印件和两张照片",
          duplicate_of_meeting_id: existing.id,
          changes: {
            time_iso: { old: null, new: "2026-09-03T09:00:00+08:00" },
            time_text: { old: null, new: "9月3日上午9点" },
            location: { old: "一楼服务大厅", new: "二楼窗口" },
            agenda: {
              old: "携带身份证复印件",
              new: "携带身份证复印件和两张照片",
            },
          },
        },
        confidence: "high",
        source_quote: "9月3日上午9点到二楼窗口，还要带两张照片",
      },
    });
    const beforeCount = countRows(db, "meetings");

    if (card.type !== "create_meeting") {
      throw new Error("expected a create_meeting card");
    }
    const result = executeCard({
      db,
      cardId: card.id,
      payload: {
        ...card.payload,
        agenda: "用户改后的最终材料清单",
        changes: {
          agenda: { old: "伪造旧值", new: "伪造新值" },
        },
      },
    });
    const updated = db.listMeetings().find((meeting) => meeting.id === existing.id);

    assert.equal(beforeCount, 1);
    assert.equal(countRows(db, "meetings"), beforeCount);
    assert.equal(result.meetingId, existing.id);
    assert.ok(updated);
    assert.equal(updated.kind, "other");
    assert.equal(updated.time_iso, "2026-09-03T09:00:00+08:00");
    assert.equal(updated.time_text, "9月3日上午9点");
    assert.equal(updated.location, "二楼窗口");
    assert.deepEqual(updated.participants, [{ name: "王老师" }]);
    assert.equal(updated.agenda, "用户改后的最终材料清单");
    assert.equal(updated.source_screenshot_id, card.screenshot_id);
    assert.equal(updated.status, "upcoming");
    assert.equal(updated.created_at, "2026-08-20T01:00:00.000Z");
    const confirmedCard = db.getStoredActionCardById(card.id);
    assert.equal(confirmedCard?.type, "create_meeting");
    assert.equal(
      confirmedCard?.type === "create_meeting"
        ? confirmedCard.payload.duplicate_of_meeting_id
        : undefined,
      existing.id,
    );
    assert.deepEqual(
      confirmedCard?.type === "create_meeting" ? confirmedCard.payload.changes : undefined,
      {
        time_iso: { old: null, new: "2026-09-03T09:00:00+08:00" },
        time_text: { old: null, new: "9月3日上午9点" },
        location: { old: "一楼服务大厅", new: "二楼窗口" },
        agenda: { old: "携带身份证复印件", new: "用户改后的最终材料清单" },
      },
    );
  } finally {
    cleanup();
  }
});

test("executeCard rebases stale agenda-append cards onto the latest meeting in either confirmation order", () => {
  for (const order of ["arrival-first", "materials-first"] as const) {
    const { db, cleanup } = withTempDb();

    try {
      const existing = db.insertMeeting({
        kind: "other",
        title: "准备报名材料",
        timeIso: null,
        timeText: "",
        location: "一楼服务大厅",
        participants: [{ name: "王老师" }],
        agenda: "携带身份证复印件",
        status: "upcoming",
        createdAt: "2026-08-20T01:00:00.000Z",
      });
      const makeAppendCard = (agendaAppend: string, imagePath: string) => createPendingCard({
        db,
        imagePath,
        rawExtraction: { participants: [], events: [], facts: [], quotes: [] },
        card: {
          type: "create_meeting",
          payload: {
            kind: "other",
            title: "准备报名材料",
            time_iso: null,
            time_text: "",
            location: "一楼服务大厅",
            participants: [{ name: "王老师" }],
            agenda: `携带身份证复印件；${agendaAppend}`,
            agenda_append: agendaAppend,
            duplicate_of_meeting_id: existing.id,
            changes: {
              agenda: {
                old: "携带身份证复印件",
                new: `携带身份证复印件；${agendaAppend}`,
              },
            },
          },
          confidence: "high",
          source_quote: agendaAppend,
        },
      });
      const arrivalCard = makeAppendCard("荀导已经到场", "/tmp/progress-arrival.png");
      const materialsCard = makeAppendCard("报名材料已补齐", "/tmp/progress-materials.png");

      db.updateMeeting(existing.id, {
        kind: "other",
        title: "准备报名材料（窗口调整）",
        timeIso: null,
        timeText: "",
        location: "二楼新窗口",
        participants: [{ name: "王老师" }, { name: "鲍老师" }],
        agenda: "携带身份证复印件",
      });
      const ordinaryUpdateCard = createPendingCard({
        db,
        imagePath: "/tmp/ordinary-meeting-update.png",
        rawExtraction: { participants: [], events: [], facts: [], quotes: [] },
        card: {
          type: "create_meeting",
          payload: {
            kind: "other",
            title: "准备报名材料（窗口调整）",
            time_iso: null,
            time_text: "",
            location: "三楼确认窗口",
            participants: [{ name: "王老师" }, { name: "鲍老师" }],
            agenda: "携带身份证复印件",
            duplicate_of_meeting_id: existing.id,
            changes: {
              location: { old: "二楼新窗口", new: "三楼确认窗口" },
            },
          },
          confidence: "high",
          source_quote: "改到三楼确认窗口办理",
        },
      });

      const confirmationCards = order === "arrival-first"
        ? [arrivalCard, materialsCard]
        : [materialsCard, arrivalCard];
      for (const card of confirmationCards) {
        executeCard({ db, cardId: card.id });
      }
      executeCard({ db, cardId: ordinaryUpdateCard.id });

      const [updated] = db.listMeetings();
      assert.equal(countRows(db, "meetings"), 1);
      assert.ok(updated);
      assert.equal(updated.title, "准备报名材料（窗口调整）");
      assert.equal(updated.location, "三楼确认窗口");
      assert.deepEqual(updated.participants, [{ name: "王老师" }, { name: "鲍老师" }]);
      assert.deepEqual(
        new Set(updated.agenda?.split("；")),
        new Set(["携带身份证复印件", "荀导已经到场", "报名材料已补齐"]),
      );
      assert.equal(db.getStoredActionCardById(arrivalCard.id)?.status, "confirmed");
      assert.equal(db.getStoredActionCardById(materialsCard.id)?.status, "confirmed");
      assert.equal(db.getStoredActionCardById(ordinaryUpdateCard.id)?.status, "confirmed");
    } finally {
      cleanup();
    }
  }
});

test("executeCard preserves a concurrent append when an ordinary update started from an empty agenda", () => {
  const { db, cleanup } = withTempDb();

  try {
    const existing = db.insertMeeting({
      kind: "other",
      title: "项目碰头会",
      timeIso: null,
      timeText: "",
      participants: [],
      agenda: null,
    });
    const ordinaryCard = createPendingCard({
      db,
      rawExtraction: { participants: [], events: [], facts: [], quotes: [] },
      card: {
        type: "create_meeting",
        payload: {
          kind: "other",
          title: "项目碰头会",
          time_iso: null,
          time_text: "",
          participants: [],
          agenda: "确认主创名单",
          duplicate_of_meeting_id: existing.id,
          changes: { agenda: { old: null, new: "确认主创名单" } },
        },
        confidence: "high",
        source_quote: "先确认主创名单",
      },
    });
    const progressCard = createPendingCard({
      db,
      rawExtraction: { participants: [], events: [], facts: [], quotes: [] },
      card: {
        type: "create_meeting",
        payload: {
          kind: "other",
          title: "项目碰头会",
          time_iso: null,
          time_text: "",
          participants: [],
          agenda: "荀导已经到场",
          agenda_append: "荀导已经到场",
          duplicate_of_meeting_id: existing.id,
          changes: { agenda: { old: null, new: "荀导已经到场" } },
        },
        confidence: "high",
        source_quote: "荀导已经到场",
      },
    });

    executeCard({ db, cardId: progressCard.id });
    executeCard({ db, cardId: ordinaryCard.id });

    assert.equal(db.listMeetings()[0]?.agenda, "确认主创名单；荀导已经到场");
    assert.equal(countRows(db, "meetings"), 1);
  } finally {
    cleanup();
  }
});

test("executeCard rejects a changed duplicate target and leaves both meetings untouched", () => {
  const { db, cleanup } = withTempDb();

  try {
    const first = db.insertMeeting({
      kind: "other",
      title: "准备报名材料",
      timeIso: null,
      timeText: "",
      participants: [],
    });
    const second = db.insertMeeting({
      kind: "other",
      title: "提交活动预算",
      timeIso: null,
      timeText: "",
      participants: [],
    });
    const card = createPendingCard({
      db,
      rawExtraction: { participants: [], events: [], facts: [], quotes: [] },
      card: {
        type: "create_meeting",
        payload: {
          kind: "other",
          title: "准备报名材料",
          time_iso: null,
          time_text: "",
          participants: [],
          duplicate_of_meeting_id: first.id,
          changes: {},
        },
        confidence: "high",
        source_quote: "准备报名材料",
      },
    });

    if (card.type !== "create_meeting") {
      throw new Error("expected a create_meeting card");
    }
    assert.throws(
      () => executeCard({
        db,
        cardId: card.id,
        payload: {
          ...card.payload,
          duplicate_of_meeting_id: second.id,
          changes: {},
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.match(error.message, /cannot change duplicate_of_meeting_id/u);
        return true;
      },
    );
    assert.deepEqual(db.listMeetings()
      .map(({ id, title }) => ({ id, title }))
      .sort((left, right) => left.id - right.id), [
      { id: first.id, title: "准备报名材料" },
      { id: second.id, title: "提交活动预算" },
    ]);
    assert.equal(db.getStoredActionCardById(card.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test("executeCard rolls back when a duplicate meeting target no longer exists", () => {
  const { db, cleanup } = withTempDb();

  try {
    const card = createPendingCard({
      db,
      rawExtraction: { participants: [], events: [], facts: [], quotes: [] },
      card: {
        type: "create_meeting",
        payload: {
          kind: "other",
          title: "准备报名材料",
          time_iso: null,
          time_text: "",
          participants: [],
          duplicate_of_meeting_id: 999,
          changes: {},
        },
        confidence: "high",
        source_quote: "准备报名材料",
      },
    });

    assert.throws(
      () => executeCard({ db, cardId: card.id }),
      (error: unknown) => {
        assert.ok(error instanceof ExecuteDependencyError);
        assert.match(error.message, /Meeting 999 does not exist/u);
        return true;
      },
    );
    assert.equal(countRows(db, "meetings"), 0);
    assert.equal(db.getStoredActionCardById(card.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test("executeCard rejects an invalid meeting kind in code before insert", () => {
  const { db, cleanup } = withTempDb();

  try {
    const card = createPendingCard({
      db,
      rawExtraction: { participants: [], events: [], facts: [], quotes: [] },
      card: {
        type: "create_meeting",
        payload: {
          kind: "todo",
          title: "无效事项",
          time_iso: null,
          time_text: "",
          participants: [],
        },
        confidence: "high",
        source_quote: "无效事项",
      } as unknown as StoredActionCard,
    });

    assert.throws(
      () => executeCard({ db, cardId: card.id }),
      (error: unknown) => {
        assert.ok(error instanceof ExecuteValidationError);
        assert.equal(error.statusCode, 422);
        return true;
      },
    );
    assert.equal(db.listMeetings().length, 0);
    assert.equal(db.getStoredActionCardById(card.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test('executeCard strips historical self contact_ids from meeting participants and renders them as "我"', () => {
  const { db, cleanup } = withTempDb();

  try {
    const selfContact = db.createContact({
      canonicalName: "Alice",
      aliases: ["我"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "Alice",
            aliases: ["我"],
            confidence: "high",
            source_quote: "Alice 这边我来定时间",
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_meeting",
        payload: {
          title: "内部同步",
          time_iso: "2026-09-02T15:00:00+08:00",
          time_text: "下周三下午三点",
          participants: [
            { contact_id: selfContact.id, name: "Alice" },
            { name: "魏总" },
          ],
        },
        confidence: "medium",
        source_quote: "下周三下午三点我和魏总内部同步",
      },
    });

    const result = executeCard({ db, cardId: card.id });
    const meetings = db.listMeetings();

    assert.equal(result.meetingId != null, true);
    assert.deepEqual(result.affectedContactIds, []);
    assert.equal(countRows(db, "contacts"), 1);
    assert.deepEqual(meetings[0]?.participants, [{ name: "我" }, { name: "魏总" }]);
  } finally {
    cleanup();
  }
});

test('executeCard strips sibling-resolved historical self contacts from meeting participants and renders them as "我"', () => {
  const { db, cleanup } = withTempDb();

  try {
    const selfContact = db.createContact({
      canonicalName: "Alice",
      aliases: ["我"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const screenshot = db.createScreenshot({
      imagePath: "/tmp/meeting-sibling-self-shot.png",
      uploadedAt: "2026-08-26T00:00:00.000Z",
    });

    db.getNativeDatabase()
      .prepare("UPDATE screenshots SET raw_extraction = ? WHERE id = ?")
      .run(
        JSON.stringify({
          participants: [
            {
              name: "Alice",
              aliases: ["我"],
              confidence: "high",
              source_quote: "Alice 这边我来参加",
            },
          ],
          events: [],
          facts: [],
          quotes: [],
        }),
        screenshot.id,
      );

    const siblingCreateCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "create_contact",
        payload: {
          name: "Alice",
        },
        confidence: "high",
        source_quote: "Alice 这边我来参加",
      },
      createdAt: "2026-08-26T00:01:00.000Z",
    });
    const meetingCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "create_meeting",
        payload: {
          title: "内部同步",
          time_iso: "2026-09-02T15:00:00+08:00",
          time_text: "下周三下午三点",
          participants: [{ name: "Alice" }, { name: "魏总" }],
        },
        confidence: "medium",
        source_quote: "下周三下午三点 Alice 和魏总内部同步",
      },
      createdAt: "2026-08-26T00:02:00.000Z",
    });

    const confirmedSibling = db.confirmActionCardIfPending({
      cardId: siblingCreateCard.id,
      payload: siblingCreateCard.payload,
      resolvedContactId: selfContact.id,
      resolvedAt: "2026-08-26T00:01:30.000Z",
    });
    assert.ok(confirmedSibling);

    const result = executeCard({ db, cardId: meetingCard.id });
    const meetings = db.listMeetings();

    assert.equal(result.meetingId != null, true);
    assert.deepEqual(result.affectedContactIds, []);
    assert.deepEqual(meetings[0]?.participants, [{ name: "我" }, { name: "魏总" }]);
  } finally {
    cleanup();
  }
});

test("executeCard does not auto-link meeting participants from a global exact alias alone", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "陈老师",
            confidence: "high",
            source_quote: "陈老师下周来聊合作",
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_meeting",
        payload: {
          title: "聊合作",
          time_iso: "2026-09-02T15:00:00+08:00",
          time_text: "下周三下午三点",
          participants: [{ name: "陈老师" }],
        },
        confidence: "medium",
        source_quote: "陈老师下周三下午三点来聊合作",
      },
    });

    const result = executeCard({ db, cardId: card.id });
    const meetings = db.listMeetings();

    assert.equal(result.affectedContactIds.length, 0);
    assert.deepEqual(meetings[0]?.participants, [{ name: "陈老师" }]);
  } finally {
    cleanup();
  }
});

test("executeCard links meeting participants from a confirmed sibling create_contact card", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const screenshot = db.createScreenshot({
      imagePath: "/tmp/meeting-sibling-shot.png",
      uploadedAt: "2026-08-26T00:00:00.000Z",
    });

    db.getNativeDatabase()
      .prepare("UPDATE screenshots SET raw_extraction = ? WHERE id = ?")
      .run(
        JSON.stringify({
          participants: [
            {
              name: "陈老师",
              aliases: ["昕姐"],
              confidence: "high",
              source_quote: "陈老师，也可以叫我昕姐",
            },
          ],
          events: [],
          facts: [],
          quotes: [],
        }),
        screenshot.id,
      );

    const mergeCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "create_contact",
        payload: {
          name: "陈老师",
          aliases: ["昕姐"],
        },
        confidence: "high",
        source_quote: "陈老师，也可以叫我昕姐",
        disambiguation: {
          candidates: [{ contact_id: 1, name: "陈昕", company: "云沐内容" }],
        },
      },
      createdAt: "2026-08-26T00:01:00.000Z",
    });
    const meetingCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "create_meeting",
        payload: {
          title: "聊合作",
          time_iso: "2026-09-02T15:00:00+08:00",
          time_text: "下周三下午三点",
          participants: [{ name: "昕姐" }],
        },
        confidence: "medium",
        source_quote: "昕姐下周三下午三点来聊合作",
      },
      createdAt: "2026-08-26T00:02:00.000Z",
    });

    executeCard({ db, cardId: mergeCard.id, resolvedContactId: 1 });
    const result = executeCard({ db, cardId: meetingCard.id });
    const meetings = db.listMeetings();

    assert.deepEqual(result.affectedContactIds, [1]);
    assert.deepEqual(meetings[0]?.participants, [{ contact_id: 1, name: "昕姐" }]);
  } finally {
    cleanup();
  }
});

test("executeCard requires a confirmed sibling create_contact match for interactions without contact_id", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "陈老师",
            notes: "更喜欢线上沟通",
            confidence: "high",
            source_quote: "我更喜欢线上沟通",
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "record_interaction",
        payload: {
          contact_name: "陈老师",
          summary: "对方确认周五前发合作方案",
        },
        confidence: "high",
        source_quote: "周五前把方案发你",
      },
    });

    assert.throws(
      () => executeCard({ db, cardId: card.id }),
      (error) => {
        assert.ok(error instanceof ExecuteDependencyError);
        assert.equal(error.statusCode, 422);
        assert.equal(
          error.message,
          'record_interaction requires contact_id or exactly one confirmed sibling create_contact match for "陈老师"',
        );
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("executeCard uses the confirmed sibling merge target for interactions instead of a global first exact alias", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const firstAliasContact = db.createContact({
      canonicalName: "A Contact",
      aliases: ["陈老师"],
      company: "先排到前面的公司",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const screenshot = db.createScreenshot({
      imagePath: "/tmp/interaction-sibling-shot.png",
      uploadedAt: "2026-08-26T00:00:00.000Z",
    });

    db.getNativeDatabase()
      .prepare("UPDATE screenshots SET raw_extraction = ? WHERE id = ?")
      .run(
        JSON.stringify({
          participants: [
            {
              name: "陈老师",
              confidence: "high",
              source_quote: "陈老师说周五前发方案",
            },
          ],
          events: [],
          facts: [],
          quotes: [],
        }),
        screenshot.id,
      );

    const mergeCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "create_contact",
        payload: {
          name: "陈老师",
        },
        confidence: "high",
        source_quote: "陈老师说周五前发方案",
        disambiguation: {
          candidates: [
            { contact_id: 1, name: "陈昕", company: "云沐内容" },
            { contact_id: firstAliasContact.id, name: firstAliasContact.canonical_name, company: firstAliasContact.company },
          ],
        },
      },
      createdAt: "2026-08-26T00:01:00.000Z",
    });
    const interactionCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "record_interaction",
        payload: {
          contact_name: "陈老师",
          summary: "对方确认周五前发合作方案",
        },
        confidence: "high",
        source_quote: "周五前把方案发你",
      },
      createdAt: "2026-08-26T00:02:00.000Z",
    });

    executeCard({ db, cardId: mergeCard.id, resolvedContactId: 1 });
    const result = executeCard({ db, cardId: interactionCard.id });

    assert.equal(result.confirmedCard.resolved_contact_id, 1);
    assert.deepEqual(result.affectedContactIds, [1]);
    assert.equal(db.getContactDetail(firstAliasContact.id)?.observations.length, 0);
  } finally {
    cleanup();
  }
});

test("executeCard confirms later-merged interaction cards without duplicating the screenshot interaction observation", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const screenshot = db.createScreenshot({
      imagePath: "/tmp/merged-interaction-shot.png",
      uploadedAt: "2026-08-26T00:00:00.000Z",
    });

    db.getNativeDatabase()
      .prepare("UPDATE screenshots SET raw_extraction = ? WHERE id = ?")
      .run(
        JSON.stringify({
          participants: [
            {
              name: "陈老师",
              aliases: ["昕姐"],
              notes: "更喜欢线上沟通",
              confidence: "high",
              source_quote: "陈老师说自己更喜欢线上沟通",
            },
          ],
          events: [],
          facts: [],
          quotes: [],
        }),
        screenshot.id,
      );

    const mergeCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "create_contact",
        payload: {
          name: "陈老师",
          aliases: ["昕姐"],
        },
        confidence: "high",
        source_quote: "陈老师说自己更喜欢线上沟通",
        disambiguation: {
          candidates: [{ contact_id: 1, name: "陈昕", company: "云沐内容" }],
        },
      },
      createdAt: "2026-08-26T00:01:00.000Z",
    });
    const firstCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "record_interaction",
        payload: {
          contact_name: "陈老师",
          summary: "对方确认周五前发合作方案",
        },
        confidence: "high",
        source_quote: "周五前把方案发你",
      },
      createdAt: "2026-08-26T00:02:00.000Z",
    });
    const secondCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "record_interaction",
        payload: {
          contact_name: "昕姐",
          summary: "对方补充下周再约一次",
        },
        confidence: "medium",
        source_quote: "下周再约一次",
      },
      createdAt: "2026-08-26T00:03:00.000Z",
    });

    executeCard({ db, cardId: mergeCard.id, resolvedContactId: 1 });
    const firstResult = executeCard({ db, cardId: firstCard.id });
    const detailAfterFirst = db.getContactDetail(1);
    const firstInteraction = detailAfterFirst?.observations.find(
      (item) => item.screenshot_id === screenshot.id && item.kind === "interaction",
    );
    const secondResult = executeCard({ db, cardId: secondCard.id });
    const finalDetail = db.getContactDetail(1);

    assert.ok(firstInteraction);
    assert.equal(firstResult.confirmedCard.resolved_contact_id, 1);
    assert.equal(secondResult.confirmedCard.resolved_contact_id, 1);
    assert.ok(secondResult.observationIds.includes(firstInteraction.id));
    assert.ok(finalDetail);

    const screenshotInteractions = finalDetail.observations.filter(
      (item) => item.screenshot_id === screenshot.id && item.kind === "interaction",
    );
    const screenshotPreferences = finalDetail.observations.filter(
      (item) =>
        item.screenshot_id === screenshot.id &&
        item.kind === "preference" &&
        item.content === "更喜欢线上沟通",
    );

    assert.equal(screenshotInteractions.length, 1);
    assert.equal(screenshotPreferences.length, 1);
  } finally {
    cleanup();
  }
});

test("executeCard rejects interactions without a unique confirmed sibling create_contact match", () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const secondContact = db.createContact({
      canonicalName: "另一个陈老师",
      aliases: ["陈老师"],
      company: "乙公司",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const screenshot = db.createScreenshot({
      imagePath: "/tmp/ambiguous-interaction-shot.png",
      uploadedAt: "2026-08-26T00:00:00.000Z",
    });

    db.getNativeDatabase()
      .prepare("UPDATE screenshots SET raw_extraction = ? WHERE id = ?")
      .run(
        JSON.stringify({
          participants: [
            {
              name: "陈老师",
              confidence: "high",
              source_quote: "陈老师说下周继续推进",
            },
          ],
          events: [],
          facts: [],
          quotes: [],
        }),
        screenshot.id,
      );

    const firstMergeCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "create_contact",
        payload: {
          name: "陈老师",
        },
        confidence: "high",
        source_quote: "陈老师说下周继续推进",
        disambiguation: {
          candidates: [{ contact_id: 1, name: "陈昕", company: "云沐内容" }],
        },
      },
      createdAt: "2026-08-26T00:01:00.000Z",
    });
    const secondMergeCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "create_contact",
        payload: {
          name: "陈老师",
        },
        confidence: "medium",
        source_quote: "陈老师稍后再确认一遍",
        disambiguation: {
          candidates: [{ contact_id: secondContact.id, name: secondContact.canonical_name, company: secondContact.company }],
        },
      },
      createdAt: "2026-08-26T00:02:00.000Z",
    });
    const interactionCard = db.insertActionCard({
      screenshotId: screenshot.id,
      card: {
        type: "record_interaction",
        payload: {
          contact_name: "陈老师",
          summary: "对方确认下周继续推进",
        },
        confidence: "high",
        source_quote: "下周继续推进",
      },
      createdAt: "2026-08-26T00:03:00.000Z",
    });

    executeCard({ db, cardId: firstMergeCard.id, resolvedContactId: 1 });
    executeCard({ db, cardId: secondMergeCard.id, resolvedContactId: secondContact.id });

    assert.throws(
      () => executeCard({ db, cardId: interactionCard.id }),
      (error) => {
        assert.ok(error instanceof ExecuteDependencyError);
        assert.equal(error.statusCode, 422);
        assert.equal(
          error.message,
          'record_interaction requires exactly one confirmed sibling create_contact match for "陈老师"',
        );
        assert.deepEqual(error.details, {
          screenshot_id: screenshot.id,
          matched_contact_ids: [1, secondContact.id],
        });
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("executeCard returns 409 when confirming an already resolved card", () => {
  const { db, cleanup } = withTempDb();

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_contact",
        payload: {
          name: "孙萌",
        },
        confidence: "medium",
        source_quote: "我是孙萌",
      },
    });

    executeCard({ db, cardId: card.id });

    assert.throws(
      () => executeCard({ db, cardId: card.id }),
      (error) => {
        assert.ok(error instanceof ActionCardConflictError);
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("rejectCard updates status only and returns 409 on repeat rejection", () => {
  const { db, cleanup } = withTempDb();

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_contact",
        payload: {
          name: "周宁",
          company: "山川设计",
        },
        confidence: "medium",
        source_quote: "我是山川设计的周宁",
      },
    });

    const rejectedCard = rejectCard({ db, cardId: card.id });

    assert.equal(rejectedCard.status, "rejected");
    assert.equal(countRows(db, "contacts"), 0);
    assert.equal(countRows(db, "meetings"), 0);
    assert.equal(countRows(db, "observations"), 0);
    assert.throws(
      () => rejectCard({ db, cardId: card.id }),
      (error) => {
        assert.ok(error instanceof ActionCardConflictError);
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("executeCard rolls back domain writes when confirmation persistence fails", () => {
  class BrokenConfirmDb extends MailuoDb {
    override confirmActionCardIfPending(): never {
      throw new Error("forced confirm failure");
    }
  }

  const { db, cleanup } = withTempDb(BrokenConfirmDb);

  try {
    const card = createPendingCard({
      db,
      rawExtraction: {
        participants: [
          {
            name: "骆舟",
            company: "北辰咨询",
            confidence: "high",
            source_quote: "我是北辰咨询的骆舟",
          },
        ],
        events: [],
        facts: [],
        quotes: [],
      },
      card: {
        type: "create_contact",
        payload: {
          name: "骆舟",
          company: "北辰咨询",
        },
        confidence: "high",
        source_quote: "我是北辰咨询的骆舟",
      },
    });

    assert.throws(() => executeCard({ db, cardId: card.id }), /forced confirm failure/);
    assert.equal(countRows(db, "contacts"), 0);
    assert.equal(countRows(db, "observations"), 0);
    assert.equal(db.getStoredActionCardById(card.id)?.status, "pending");
  } finally {
    cleanup();
  }
});
