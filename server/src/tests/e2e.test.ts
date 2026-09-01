import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ActionCardRecord } from '../../../shared/types.ts';
import { executeCard } from '../agent/execute.ts';
import { generateInsights } from '../agent/insight.ts';
import {
  perceiveScreenshot,
  type PerceptionResult,
} from '../agent/perceive.ts';
import { proposeCards } from '../../../shared/core/agent/propose.ts';
import {
  resolveParticipants,
  type ResolvableContact,
} from '../agent/resolve.ts';
import { runE2eFlow } from '../cli.ts';
import { MailuoDb } from '../db.ts';
import type {
  ChatCompletionRequest,
  StructuredOutputProvider,
  StructuredOutputRequest,
} from '../../../shared/core/llm/provider.ts';
import { ConfigurationError } from '../../../shared/core/llm/provider.ts';

const seedSql = readFileSync(new URL('../../../fixtures/seed.sql', import.meta.url), 'utf8');
const screenshotPath = new URL('../../../fixtures/screenshot-2.png', import.meta.url).pathname;

class MockStructuredOutputProvider implements StructuredOutputProvider {
  readonly name = 'MockStructuredOutputProvider';
  readonly model = 'mock-model';
  calls = 0;

  constructor(private readonly responses: unknown[]) {}

  async complete(_request: ChatCompletionRequest): Promise<string> {
    throw new Error('complete should not be called in mock e2e tests');
  }

  async generateStructuredOutput<T>(request: StructuredOutputRequest<T>): Promise<T> {
    const response = this.responses[this.calls];
    this.calls += 1;

    if (response === undefined) {
      throw new Error('No mock response available');
    }

    return request.schema.parse(response);
  }
}

function withTempDb() {
  const directory = mkdtempSync(join(tmpdir(), 'mailuo-e2e-'));
  const databasePath = join(directory, 'mailuo.sqlite');
  const db = new MailuoDb(databasePath);

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

function listResolvableContacts(db: MailuoDb): ResolvableContact[] {
  return db.listContacts().map(
    ({ observation_count: _observationCount, last_interaction_at: _lastInteractionAt, ...contact }) =>
      contact,
  );
}

function sortCardsForExecution<T extends Pick<ActionCardRecord, 'id' | 'type'>>(cards: T[]) {
  const priority: Record<ActionCardRecord['type'], number> = {
    create_contact: 0,
    update_contact: 1,
    create_meeting: 2,
    record_interaction: 3,
  };

  return [...cards].sort((left, right) => {
    const priorityDelta = priority[left.type] - priority[right.type];
    return priorityDelta !== 0 ? priorityDelta : left.id - right.id;
  });
}

test('mock e2e chain persists contacts, meetings, observations, and insights to terminal state', async () => {
  const { db, cleanup } = withTempDb();
  seedDb(db);

  try {
    const perceiveProvider = new MockStructuredOutputProvider([
      {
        participants: [
          {
            name: '陈老师',
            is_self: false,
            company: '山海文化',
            title: '内容合作负责人',
            confidence: 'high',
            source_quote: '我上个月跳槽去了山海文化',
          },
          {
            name: '王磊',
            is_self: false,
            company: '星火科技',
            title: '市场总监',
            notes: '更喜欢线下面聊',
            confidence: 'high',
            source_quote: '我是星火科技的市场总监王磊，更喜欢线下面聊',
          },
        ],
        events: [
          {
            kind: 'meeting',
            title: '聊合作',
            time_text: '下周三下午三点',
            time_iso: '2026-09-02T15:00:00+08:00',
            has_time_signal: true,
            participant_names: ['陈老师', '王磊', '魏总'],
            confidence: 'high',
            source_quote: '下周三下午三点我们一起聊合作',
          },
        ],
        facts: [
          {
            subject_name: '陈老师',
            field: 'company',
            value: '山海文化',
            confidence: 'high',
            source_quote: '我上个月跳槽去了山海文化',
          },
          {
            subject_name: '王磊',
            field: 'phone',
            value: '13800001234',
            confidence: 'high',
            source_quote: '电话 13800001234',
          },
        ],
        quotes: [
          {
            speaker_name: '陈老师',
            text: '我上个月跳槽去了山海文化',
            source_quote: '我上个月跳槽去了山海文化',
          },
          {
            speaker_name: '王磊',
            text: '下周三下午三点见',
            source_quote: '下周三下午三点见',
          },
        ],
      } satisfies PerceptionResult,
    ]);
    const extraction = await perceiveScreenshot({
      imagePath: screenshotPath,
      provider: perceiveProvider,
    });
    const contacts = listResolvableContacts(db);
    const resolveProvider = new MockStructuredOutputProvider([
      { decision: 'new' },
    ]);
    const resolutions = await resolveParticipants({
      extraction,
      contacts,
      provider: resolveProvider,
    });
    const screenshot = db.createScreenshot({
      imagePath: screenshotPath,
      userNote: 'mock e2e',
      uploadedAt: '2026-08-26T00:00:00.000Z',
    });
    const savedCards = db.saveScreenshotAnalysis({
      screenshotId: screenshot.id,
      rawExtraction: extraction,
      cards: proposeCards(extraction, resolutions, contacts, new Date('2026-08-27T02:00:00.000Z')),
      createdAt: '2026-08-26T00:01:00.000Z',
    });
    const executionResults = sortCardsForExecution(savedCards).map((card) =>
      executeCard({ db, cardId: card.id }),
    );
    const affectedContactIds = [...new Set(executionResults.flatMap((result) => result.affectedContactIds))];
    const existingContact = db.getContactDetail(1);
    const createdContact = db.listContacts().find((contact) => contact.canonical_name === '王磊');
    const insightContactIds = [...affectedContactIds].sort((left, right) => left - right);

    assert.ok(existingContact);
    assert.ok(createdContact);

    const insightProvider = new MockStructuredOutputProvider([
      {
        insights: [
          {
            kind: 'relationship_read',
            content: '陈昕最近的合作身份有了明确变化',
            based_on: existingContact.observations.map((observation) => observation.id),
          },
        ],
      },
      {
        insights: [
          {
            kind: 'conversation_hook',
            content: '可以顺着他偏好的线下面聊继续推进',
            based_on:
              db
                .getContactDetail(createdContact.id)
                ?.observations.map((observation) => observation.id) ?? [],
          },
        ],
      },
    ]);
    const insightResult = await generateInsights({
      db,
      contactIds: insightContactIds,
      provider: insightProvider,
      now: new Date('2026-08-26T05:00:00.000Z'),
    });
    const finalExistingContact = db.getContactDetail(1);
    const finalCreatedContact = db.getContactDetail(createdContact.id);
    const meetings = db.listMeetings();
    const screenshotDetail = db.getScreenshotDetail(screenshot.id);

    assert.equal(perceiveProvider.calls, 1);
    assert.equal(resolveProvider.calls, 1);
    assert.equal(insightProvider.calls, 2);
    assert.deepEqual(
      resolutions.map((resolution) => resolution.status),
      ['same_as', 'new'],
    );
    assert.ok(finalExistingContact);
    assert.equal(finalExistingContact.contact.company, '山海文化');
    assert.ok(
      finalExistingContact.observations.some(
        (observation) =>
          observation.kind === 'status_change' &&
          observation.content === '公司由 "云沐内容" 变为 "山海文化"',
      ),
    );
    assert.ok(finalCreatedContact);
    assert.equal(finalCreatedContact.contact.phone, '13800001234');
    assert.ok(
      finalCreatedContact.observations.some(
        (observation) =>
          observation.kind === 'interaction' &&
          observation.content.includes('下周三下午三点见'),
      ),
    );
    assert.deepEqual(meetings[0]?.participants, [
      { contact_id: 1, name: '陈老师' },
      { contact_id: createdContact.id, name: '王磊' },
      { name: '魏总' },
    ]);
    assert.ok(screenshotDetail);
    assert.equal(screenshotDetail.cards.length, 5);
    assert.equal(
      screenshotDetail.cards.every((card) => card.status === 'confirmed'),
      true,
    );
    assert.deepEqual(insightResult.processed_contact_ids, insightContactIds);
    assert.equal(insightResult.generated.length, 2);
    assert.equal(finalExistingContact.insights.length, 1);
    assert.equal(finalCreatedContact.insights.length, 1);
  } finally {
    cleanup();
  }
});

test('runE2eFlow deletes the orphan screenshot row when perception fails before analysis persistence', async () => {
  const { db, cleanup } = withTempDb();

  try {
    await assert.rejects(
      () =>
        runE2eFlow({
          db,
          imagePath: screenshotPath,
          async perceiveScreenshotImpl() {
            throw new ConfigurationError(
              'Missing required environment variable DASHSCOPE_API_KEY',
              'DASHSCOPE_API_KEY',
            );
          },
        }),
      /Missing required environment variable DASHSCOPE_API_KEY/,
    );

    const screenshotRows = db
      .getNativeDatabase()
      .prepare('SELECT id, image_path, raw_extraction FROM screenshots ORDER BY id')
      .all() as Array<{ id: number; image_path: string; raw_extraction: string | null }>;
    const cardCount = db
      .getNativeDatabase()
      .prepare('SELECT COUNT(*) AS count FROM action_cards')
      .get() as { count: number };

    assert.deepEqual(screenshotRows, []);
    assert.equal(cardCount.count, 0);
  } finally {
    cleanup();
  }
});

test('runE2eFlow passes existing meetings and progress resolutions into its proposal step', async () => {
  const { db, cleanup } = withTempDb();

  try {
    const existingMeeting = db.insertMeeting({
      kind: 'other',
      title: '准备报名材料',
      timeIso: null,
      timeText: '',
      participants: [],
    });
    const meetingProgressResolutions = [{
      meeting_id: existingMeeting.id,
      fragments: [{ content: '荀导已到', source_quote: '荀导已到' }],
    }];
    let receivedResolverMeetings: unknown;
    let receivedProposalMeetings: unknown;
    let receivedMeetingProgressResolutions: unknown;
    const result = await runE2eFlow({
      db,
      imagePath: screenshotPath,
      async perceiveScreenshotImpl() {
        return { participants: [], events: [], facts: [], quotes: [] };
      },
      async resolveParticipantsImpl() {
        return [];
      },
      async resolveMeetingProgressImpl(input) {
        receivedResolverMeetings = input.meetings;
        assert.equal(typeof input.providerFactory, 'function');
        return meetingProgressResolutions;
      },
      proposeCardsImpl(
        _extraction,
        _resolutions,
        _contacts,
        _now,
        existingMeetings,
        progressResolutions,
      ) {
        receivedProposalMeetings = existingMeetings;
        receivedMeetingProgressResolutions = progressResolutions;
        return [];
      },
      async generateInsightsImpl() {
        return {
          requested_contact_ids: [],
          processed_contact_ids: [],
          skipped_contact_ids: [],
          generated: [],
        };
      },
    });

    assert.deepEqual(receivedResolverMeetings, [existingMeeting]);
    assert.deepEqual(receivedProposalMeetings, [existingMeeting]);
    assert.deepEqual(receivedMeetingProgressResolutions, meetingProgressResolutions);
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.meeting_ids, []);
  } finally {
    cleanup();
  }
});
