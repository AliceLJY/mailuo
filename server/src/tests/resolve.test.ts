import assert from 'node:assert/strict';
import test from 'node:test';

import type { StructuredOutputProvider, StructuredOutputRequest } from '../llm/provider.ts';
import type { PerceptionResult } from '../agent/perceive.ts';
import {
  resolveParticipants,
  type ParticipantResolution,
  type ResolvableContact,
} from '../agent/resolve.ts';

class FakeStructuredOutputProvider implements StructuredOutputProvider {
  readonly name = 'FakeProvider';
  readonly model = 'fake-model';
  readonly prompts: string[] = [];
  calls = 0;

  constructor(private readonly responses: unknown[]) {}

  async complete(): Promise<string> {
    throw new Error('complete should not be called in these tests');
  }

  async generateStructuredOutput<T>(request: StructuredOutputRequest<T>): Promise<T> {
    this.calls += 1;
    this.prompts.push(
      JSON.stringify(
        request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ),
    );
    return request.schema.parse(this.responses[this.calls - 1]);
  }
}

function buildExtraction(participantName = '王磊'): PerceptionResult {
  return {
    participants: [
      {
        name: participantName,
        company: '星火科技',
        title: '市场总监',
        confidence: 'high',
        source_quote: `我是星火科技的市场总监${participantName}`,
      },
    ],
    events: [
      {
        kind: 'meeting',
        title: '聊合作',
        time_text: '明天下午两点',
        time_iso: '2026-08-27T14:00:00+08:00',
        location: '星火科技会议室',
        participant_names: [participantName, 'Alice'],
        confidence: 'medium',
        source_quote: `明天下午两点和${participantName}在星火科技会议室聊合作`,
      },
    ],
    facts: [
      {
        subject_name: participantName,
        field: 'phone',
        value: '13800001234',
        confidence: 'high',
        source_quote: '电话 13800001234',
      },
    ],
    quotes: [
      {
        speaker_name: participantName,
        text: `我是星火科技的市场总监${participantName}`,
        source_quote: `我是星火科技的市场总监${participantName}`,
      },
    ],
  };
}

test('resolveParticipants matches canonical names and aliases with trim + case-insensitive comparison', async () => {
  const contacts: ResolvableContact[] = [
    {
      id: 11,
      canonical_name: 'Alice',
      aliases: ['AL-1'],
      company: 'OpenAI',
    },
    {
      id: 12,
      canonical_name: '王磊',
      aliases: ['老王'],
      company: '星火科技',
    },
  ];

  const extraction = buildExtraction('  老王  ');
  const resolutions = await resolveParticipants({ extraction, contacts });

  assert.deepEqual(resolutions, [
    {
      participant_name: '  老王  ',
      normalized_name: '老王',
      status: 'same_as',
      contact_id: 12,
      source: 'exact',
    },
  ] satisfies ParticipantResolution[]);
});

test('resolveParticipants treats multiple exact matches as unsure without calling the provider', async () => {
  const provider = new FakeStructuredOutputProvider([]);
  const contacts: ResolvableContact[] = [
    { id: 21, canonical_name: '李姐', aliases: ['鲍总'], company: '甲公司' },
    { id: 22, canonical_name: '另一位', aliases: ['鲍总'], company: '乙公司' },
  ];

  const extraction = buildExtraction('鲍总');
  const resolutions = await resolveParticipants({ extraction, contacts, provider });

  assert.equal(provider.calls, 0);
  assert.deepEqual(resolutions, [
    {
      participant_name: '鲍总',
      normalized_name: '鲍总',
      status: 'unsure',
      candidate_ids: [21, 22],
      source: 'exact_multiple',
    },
  ] satisfies ParticipantResolution[]);
});

test('resolveParticipants uses the provider for same_as when exact matching fails', async () => {
  const provider = new FakeStructuredOutputProvider([
    { decision: 'same_as', contact_id: 31 },
  ]);
  const contacts: ResolvableContact[] = [
    {
      id: 31,
      canonical_name: '王磊',
      aliases: ['William'],
      company: '星火科技',
      phone: '13800001234',
      wechat_id: 'wl-sh',
      notes: '老联系人',
      title: '市场总监',
    },
  ];

  const extraction = buildExtraction('Will');
  const resolutions = await resolveParticipants({ extraction, contacts, provider });

  assert.equal(provider.calls, 1);
  assert.deepEqual(resolutions, [
    {
      participant_name: 'Will',
      normalized_name: 'will',
      status: 'same_as',
      contact_id: 31,
      source: 'llm',
    },
  ] satisfies ParticipantResolution[]);
});

test('resolveParticipants returns new when the provider says the participant is not in the DB', async () => {
  const provider = new FakeStructuredOutputProvider([{ decision: 'new' }]);
  const contacts: ResolvableContact[] = [
    { id: 41, canonical_name: '王磊', aliases: ['老王'], company: '星火科技' },
  ];

  const resolutions = await resolveParticipants({
    extraction: buildExtraction('魏敏'),
    contacts,
    provider,
  });

  assert.deepEqual(resolutions, [
    {
      participant_name: '魏敏',
      normalized_name: '魏敏',
      status: 'new',
      source: 'llm',
    },
  ] satisfies ParticipantResolution[]);
});

test('resolveParticipants returns unsure with candidate ids from the provider', async () => {
  const provider = new FakeStructuredOutputProvider([
    { decision: 'unsure', candidate_ids: [51, 52] },
  ]);
  const contacts: ResolvableContact[] = [
    { id: 51, canonical_name: '李姐', aliases: ['鲍总'], company: '甲公司' },
    { id: 52, canonical_name: '李洁', aliases: ['LJ'], company: '乙公司' },
  ];

  const resolutions = await resolveParticipants({
    extraction: buildExtraction('小李'),
    contacts,
    provider,
  });

  assert.deepEqual(resolutions, [
    {
      participant_name: '小李',
      normalized_name: '小李',
      status: 'unsure',
      candidate_ids: [51, 52],
      source: 'llm',
    },
  ] satisfies ParticipantResolution[]);
});

test('resolveParticipants skips the provider for an empty DB', async () => {
  const provider = new FakeStructuredOutputProvider([{ decision: 'same_as', contact_id: 99 }]);
  const resolutions = await resolveParticipants({
    extraction: buildExtraction('新朋友'),
    contacts: [],
    provider,
  });

  assert.equal(provider.calls, 0);
  assert.deepEqual(resolutions, [
    {
      participant_name: '新朋友',
      normalized_name: '新朋友',
      status: 'new',
      source: 'empty_db',
    },
  ] satisfies ParticipantResolution[]);
});

test('resolveParticipants keeps the DB-side prompt privacy-scoped to id/name/aliases/company', async () => {
  const provider = new FakeStructuredOutputProvider([{ decision: 'new' }]);
  const contacts: ResolvableContact[] = [
    {
      id: 61,
      canonical_name: '王磊',
      aliases: ['老王'],
      company: '星火科技',
      title: '市场总监',
      phone: '13800001234',
      wechat_id: 'wl-sh',
      notes: '不要发给模型',
    },
  ];

  await resolveParticipants({
    extraction: buildExtraction('Will'),
    contacts,
    provider,
  });

  const messages = JSON.parse(provider.prompts[0] ?? '[]') as Array<{
    role: string;
    content: string;
  }>;
  const userPrompt = messages.find((message) => message.role === 'user')?.content ?? '';
  const summariesSection = userPrompt.split('Existing contact summaries:')[1] ?? '';

  assert.match(summariesSection, /"id":\s*61/u);
  assert.match(summariesSection, /"canonical_name":\s*"王磊"/u);
  assert.match(summariesSection, /老王/u);
  assert.match(summariesSection, /"company":\s*"星火科技"/u);
  assert.doesNotMatch(summariesSection, /13800001234/u);
  assert.doesNotMatch(summariesSection, /wl-sh/u);
  assert.doesNotMatch(summariesSection, /不要发给模型/u);
  assert.doesNotMatch(summariesSection, /市场总监/u);

  assert.match(userPrompt, /related_events:/u);
  assert.match(userPrompt, /"title":"聊合作"/u);
  assert.match(userPrompt, /"time_text":"明天下午两点"/u);
  assert.match(userPrompt, /"location":"星火科技会议室"/u);
  assert.match(userPrompt, /"participant_names":\["Will","Alice"\]/u);
  assert.match(userPrompt, /明天下午两点和Will在星火科技会议室聊合作/u);
});
