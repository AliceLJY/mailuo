import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  generateInsights,
  type GenerateInsightsOptions,
  type InsightContextRecord,
  type InsightGenerationDb,
  type InsightGenerationEntry,
  type InsightGenerationRecord,
  type InsightObservationRecord,
  type InsightSummaryRecord,
} from '../../../shared/core/agent/insight.ts';
import {
  buildEntityResolutionPrompt,
  buildInsightGenerationPrompt,
} from '../../../shared/core/llm/prompts.ts';
import type {
  ChatCompletionRequest,
  ChatMessage,
  StructuredOutputProvider,
  StructuredOutputRequest,
} from '../../../shared/core/llm/provider.ts';

const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

class MockStructuredOutputProvider implements StructuredOutputProvider {
  readonly name = 'MockStructuredOutputProvider';
  readonly model = 'mock-model';
  readonly calls: Array<{ messages: ChatMessage[]; maxOutputTokens?: number }> = [];
  private readonly responses: Array<unknown | Error>;

  constructor(responses: Array<unknown | Error>) {
    this.responses = [...responses];
  }

  async complete(_request: ChatCompletionRequest): Promise<string> {
    throw new Error('complete should not be called in this test');
  }

  async generateStructuredOutput<T>(request: StructuredOutputRequest<T>): Promise<T> {
    this.calls.push({
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
    });
    const next = this.responses.shift();

    if (!next) {
      throw new Error('No mock response available');
    }

    if (next instanceof Error) {
      throw next;
    }

    return request.schema.parse(next);
  }
}

class SqliteInsightDb implements InsightGenerationDb {
  private readonly nativeDb: DatabaseSync;

  constructor(databasePath: string) {
    this.nativeDb = new DatabaseSync(databasePath);
    this.nativeDb.exec(schemaSql);
  }

  close() {
    this.nativeDb.close();
  }

  createContact(input: Partial<InsightContextRecord['contact']> & { canonical_name: string }) {
    const createdAt = input.created_at ?? '2026-08-20T00:00:00.000Z';
    const updatedAt = input.updated_at ?? createdAt;
    const statement = this.nativeDb.prepare(
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
    );
    const result = statement.run(
      input.canonical_name,
      JSON.stringify(input.aliases ?? []),
      input.company ?? null,
      input.title ?? null,
      input.phone ?? null,
      input.wechat_id ?? null,
      JSON.stringify(input.tags ?? []),
      input.notes ?? null,
      createdAt,
      updatedAt,
    );

    return Number(result.lastInsertRowid);
  }

  createObservation(
    input: Partial<InsightObservationRecord> & {
      contact_id: number;
      kind: InsightObservationRecord['kind'];
      content: string;
    },
  ) {
    const statement = this.nativeDb.prepare(
      `INSERT INTO observations (
         contact_id,
         screenshot_id,
         kind,
         content,
         source_quote,
         observed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = statement.run(
      input.contact_id,
      input.screenshot_id ?? null,
      input.kind,
      input.content,
      input.source_quote ?? null,
      input.observed_at ?? '2026-08-20T01:00:00.000Z',
    );

    return Number(result.lastInsertRowid);
  }

  createHistoricalInsight(
    input: Partial<InsightSummaryRecord> & {
      contact_id: number;
      kind: InsightSummaryRecord['kind'];
      content: string;
      based_on: number[];
    },
  ) {
    const statement = this.nativeDb.prepare(
      `INSERT INTO insights (
         contact_id,
         kind,
         content,
         based_on,
         generated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const result = statement.run(
      input.contact_id,
      input.kind,
      input.content,
      JSON.stringify(input.based_on),
      input.generated_at ?? '2026-08-21T00:00:00.000Z',
    );

    return Number(result.lastInsertRowid);
  }

  getInsightContext(contactId: number): InsightContextRecord | null {
    const contact = this.nativeDb
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
      .get(contactId) as
      | {
          id: number;
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
        }
      | undefined;

    if (!contact) {
      return null;
    }

    const observations = this.nativeDb
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
         ORDER BY observed_at ASC, id ASC`,
      )
      .all(contactId) as Array<{
      id: number;
      contact_id: number;
      screenshot_id: number | null;
      kind: InsightObservationRecord['kind'];
      content: string;
      source_quote: string | null;
      observed_at: string;
    }>;

    const recentInsights = this.nativeDb
      .prepare(
        `SELECT
           id,
           contact_id,
           kind,
           content,
           based_on,
           generated_at
         FROM insights
         WHERE contact_id = ?
         ORDER BY generated_at DESC, id DESC
         LIMIT 5`,
      )
      .all(contactId) as Array<{
      id: number;
      contact_id: number;
      kind: InsightSummaryRecord['kind'];
      content: string;
      based_on: string;
      generated_at: string;
    }>;

    return {
      contact: {
        id: contact.id,
        canonical_name: contact.canonical_name,
        aliases: JSON.parse(contact.aliases) as string[],
        company: contact.company,
        title: contact.title,
        phone: contact.phone,
        wechat_id: contact.wechat_id,
        tags: JSON.parse(contact.tags) as string[],
        notes: contact.notes,
        created_at: contact.created_at,
        updated_at: contact.updated_at,
      },
      observations,
      recentInsights: recentInsights.map((insight) => ({
        ...insight,
        based_on: JSON.parse(insight.based_on) as number[],
      })),
    };
  }

  insertInsights(entries: InsightGenerationEntry[]): InsightGenerationRecord[] {
    const insert = this.nativeDb.prepare(
      `INSERT INTO insights (
         contact_id,
         kind,
         content,
         based_on,
         generated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );

    this.nativeDb.exec('BEGIN');

    try {
      const records = entries.map((entry) => {
        const result = insert.run(
          entry.contact_id,
          entry.kind,
          entry.content,
          JSON.stringify(entry.based_on),
          entry.generated_at,
        );

        return {
          id: Number(result.lastInsertRowid),
          ...entry,
        };
      });

      this.nativeDb.exec('COMMIT');
      return records;
    } catch (error) {
      try {
        this.nativeDb.exec('ROLLBACK');
      } catch {
        // Preserve the original insert failure if rollback also fails.
      }

      throw error;
    }
  }

  listInsights(): InsightGenerationRecord[] {
    const rows = this.nativeDb
      .prepare(
        `SELECT
           id,
           contact_id,
           kind,
           content,
           based_on,
           generated_at
         FROM insights
         ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      contact_id: number;
      kind: InsightSummaryRecord['kind'];
      content: string;
      based_on: string;
      generated_at: string;
    }>;

    return rows.map((row) => ({
      ...row,
      based_on: JSON.parse(row.based_on) as number[],
    }));
  }
}

function withTempInsightDb() {
  const directory = mkdtempSync(join(tmpdir(), 'mailuo-insight-'));
  const databasePath = join(directory, 'mailuo.sqlite');
  const db = new SqliteInsightDb(databasePath);

  return {
    db,
    cleanup() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function runGenerateInsights(
  options: Omit<GenerateInsightsOptions, 'now'> & { now?: string },
) {
  return generateInsights({
    ...options,
    now: options.now ? new Date(options.now) : undefined,
  });
}

test('generateInsights drops ungrounded items, sanitizes based_on, and inserts valid insights', async () => {
  const { db, cleanup } = withTempInsightDb();

  try {
    const contactId = db.createContact({
      canonical_name: '王磊',
      aliases: ['老王'],
      company: '星火科技',
      title: '市场总监',
      phone: '13800001234',
      wechat_id: 'wl-sh',
      tags: ['合作'],
      notes: '沟通积极',
    });
    const observationId1 = db.createObservation({
      contact_id: contactId,
      kind: 'interaction',
      content: '对方主动提出线下聊合作',
      source_quote: '来我们公司聊合作',
      observed_at: '2026-08-20T10:00:00.000Z',
    });
    const observationId2 = db.createObservation({
      contact_id: contactId,
      kind: 'status_change',
      content: '对方上个月跳槽到星火科技',
      source_quote: '我上个月跳槽去了星火科技',
      observed_at: '2026-08-21T10:00:00.000Z',
    });
    db.createHistoricalInsight({
      contact_id: contactId,
      kind: 'relationship_read',
      content: '最近合作节奏在升温',
      based_on: [observationId1],
    });

    const provider = new MockStructuredOutputProvider([
      {
        insights: [
          {
            kind: 'relationship_read',
            content: '  对方近期推进合作的意愿比较明确  ',
            based_on: [observationId1, 999999],
          },
          {
            kind: 'suggested_action',
            content: '这条没有有效依据',
            based_on: [999999],
          },
          {
            kind: 'conversation_hook',
            content: '可以追问他在新公司的优先项目',
            based_on: [observationId2, observationId2],
          },
        ],
      },
    ]);

    const result = await runGenerateInsights({
      db,
      contactIds: [contactId, contactId],
      provider,
      now: '2026-08-26T05:00:00.000Z',
    });

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]?.maxOutputTokens, 2000);
    assert.match(
      String(provider.calls[0]?.messages[0]?.content ?? ''),
      /within 120 Chinese characters/u,
    );
    assert.deepEqual(result.requested_contact_ids, [contactId]);
    assert.deepEqual(result.processed_contact_ids, [contactId]);
    assert.deepEqual(result.skipped_contact_ids, []);
    assert.equal(result.generated.length, 2);
    assert.deepEqual(
      result.generated.map((entry) => ({
        contact_id: entry.contact_id,
        kind: entry.kind,
        content: entry.content,
        based_on: entry.based_on,
        generated_at: entry.generated_at,
      })),
      [
        {
          contact_id: contactId,
          kind: 'relationship_read',
          content: '对方近期推进合作的意愿比较明确',
          based_on: [observationId1],
          generated_at: '2026-08-26T05:00:00.000Z',
        },
        {
          contact_id: contactId,
          kind: 'conversation_hook',
          content: '可以追问他在新公司的优先项目',
          based_on: [observationId2],
          generated_at: '2026-08-26T05:00:00.000Z',
        },
      ],
    );

    const storedInsights = db.listInsights();
    assert.equal(storedInsights.length, 3);
    assert.deepEqual(
      storedInsights.slice(1).map((entry) => ({
        kind: entry.kind,
        content: entry.content,
        based_on: entry.based_on,
      })),
      [
        {
          kind: 'relationship_read',
          content: '对方近期推进合作的意愿比较明确',
          based_on: [observationId1],
        },
        {
          kind: 'conversation_hook',
          content: '可以追问他在新公司的优先项目',
          based_on: [observationId2],
        },
      ],
    );
  } finally {
    cleanup();
  }
});

test('generateInsights skips missing contacts and contacts without observations without calling the LLM', async () => {
  const { db, cleanup } = withTempInsightDb();

  try {
    const contactId = db.createContact({
      canonical_name: '李姐',
      aliases: ['鲍总'],
    });
    const provider = new MockStructuredOutputProvider([]);

    const result = await runGenerateInsights({
      db,
      contactIds: [contactId, 999999, contactId],
      provider,
      now: '2026-08-26T05:00:00.000Z',
    });

    assert.equal(provider.calls.length, 0);
    assert.deepEqual(result.requested_contact_ids, [contactId, 999999]);
    assert.deepEqual(result.processed_contact_ids, []);
    assert.deepEqual(result.skipped_contact_ids, [contactId, 999999]);
    assert.deepEqual(result.generated, []);
    assert.deepEqual(db.listInsights(), []);
  } finally {
    cleanup();
  }
});

test('generateInsights does not insert partial results when a later provider call fails', async () => {
  const { db, cleanup } = withTempInsightDb();

  try {
    const contactId1 = db.createContact({ canonical_name: '王磊' });
    const contactId2 = db.createContact({ canonical_name: '张敏' });
    const observationId1 = db.createObservation({
      contact_id: contactId1,
      kind: 'interaction',
      content: '对方本周回复明显变快',
    });
    db.createObservation({
      contact_id: contactId2,
      kind: 'interaction',
      content: '对方约了下周电话沟通',
    });

    const provider = new MockStructuredOutputProvider([
      {
        insights: [
          {
            kind: 'suggested_action',
            content: '可以顺着本周话题继续推进',
            based_on: [observationId1],
          },
        ],
      },
      new Error('provider boom'),
    ]);

    await assert.rejects(
      runGenerateInsights({
        db,
        contactIds: [contactId1, contactId2],
        provider,
        now: '2026-08-26T05:00:00.000Z',
      }),
      /provider boom/,
    );

    assert.equal(provider.calls.length, 2);
    assert.deepEqual(db.listInsights(), []);
  } finally {
    cleanup();
  }
});

test('entity resolution and insight prompts stay grounded to the supplied evidence', () => {
  const resolutionPrompt = buildEntityResolutionPrompt('截图里写的是王总，说他刚去了星火科技。', [
    {
      id: 7,
      canonical_name: '王磊',
      aliases: ['王总', '老王'],
      company: '星火科技',
      title: '市场总监',
    } as unknown as {
      id: number;
      canonical_name: string;
      aliases: string[];
      company: string | null;
    },
  ]);

  assert.match(resolutionPrompt.systemPrompt, /same_as/);
  assert.match(resolutionPrompt.systemPrompt, /new/);
  assert.match(resolutionPrompt.systemPrompt, /unsure/);
  assert.match(resolutionPrompt.systemPrompt, /only existing-contact fields you may use are id, canonical_name, aliases, and company/i);
  assert.match(resolutionPrompt.systemPrompt, /Do not include null placeholders, empty arrays, or extra keys from other decisions/i);
  assert.doesNotMatch(resolutionPrompt.systemPrompt, /otherwise null/i);
  assert.doesNotMatch(resolutionPrompt.systemPrompt, /otherwise \[\]/i);
  assert.match(resolutionPrompt.userPrompt, /"canonical_name": "王磊"/);
  assert.doesNotMatch(resolutionPrompt.userPrompt, /市场总监/);

  const insightPrompt = buildInsightGenerationPrompt({
    contact: {
      id: 7,
      canonical_name: '王磊',
      aliases: ['王总'],
      company: '星火科技',
      title: '市场总监',
      phone: '13800001234',
      wechat_id: 'wl-sh',
      tags: ['合作'],
      notes: '跟进中',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-21T00:00:00.000Z',
    },
    observations: [
      {
        id: 101,
        kind: 'interaction',
        content: '对方主动提出线下见面',
        source_quote: '来我们公司聊合作',
        observed_at: '2026-08-20T10:00:00.000Z',
      },
    ],
    recentInsights: [
      {
        id: 201,
        kind: 'relationship_read',
        content: '合作节奏在升温',
        based_on: [101],
        generated_at: '2026-08-21T00:00:00.000Z',
      },
    ],
  });

  assert.match(insightPrompt.systemPrompt, /based_on/);
  assert.match(insightPrompt.systemPrompt, /If you cannot ground an insight, do not output it/);
  assert.match(insightPrompt.systemPrompt, /within 120 Chinese characters/);
  assert.match(insightPrompt.userPrompt, /"phone": "13800001234"/);
  assert.match(insightPrompt.userPrompt, /"id": 101/);
  assert.match(insightPrompt.userPrompt, /"recent_insight_summaries"/);
  assert.match(insightPrompt.userPrompt, /合作节奏在升温/);
});
