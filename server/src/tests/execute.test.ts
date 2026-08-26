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
    assert.deepEqual(meetings[0]?.participants, [
      { contact_id: 1, name: "陈老师" },
      { name: "魏总" },
    ]);
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
