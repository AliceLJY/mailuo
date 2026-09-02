import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ChatCompletionRequest,
  StructuredOutputProvider,
  StructuredOutputRequest,
} from '../../../shared/core/llm/provider.ts';
import type { PerceptionResult } from '../../../shared/core/agent/perceive.ts';
import {
  MEETING_PROGRESS_CANDIDATE_LIMIT,
  resolveMeetingProgress,
  resolveParticipants,
  type MeetingProgressResolution,
  type ParticipantResolution,
  type ResolvableContact,
  type ResolvableMeeting,
} from '../../../shared/core/agent/resolve.ts';
import {
  editDistance,
  normalizeComparableText,
  normalizeContactText,
  normalizedEditSimilarity,
  tokenize,
} from '../../../shared/core/text/compare.ts';

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

class FakeCompletionProvider implements StructuredOutputProvider {
  readonly name = 'FakeCompletionProvider';
  readonly model = 'fake-model';
  readonly requests: ChatCompletionRequest[] = [];
  completeCalls = 0;
  structuredOutputCalls = 0;

  constructor(private readonly responses: Array<string | Error>) {}

  async complete(request: ChatCompletionRequest): Promise<string> {
    this.completeCalls += 1;
    this.requests.push(request);
    const response = this.responses[this.completeCalls - 1];

    if (response instanceof Error) {
      throw response;
    }

    return response ?? '{"matches":[]}';
  }

  async generateStructuredOutput<T>(_request: StructuredOutputRequest<T>): Promise<T> {
    this.structuredOutputCalls += 1;
    throw new Error('generateStructuredOutput should not be called for meeting progress');
  }
}

function buildExtraction(
  participantName = '王磊',
  participantOverrides: Partial<PerceptionResult['participants'][number]> = {},
): PerceptionResult {
  return {
    participants: [
      {
        name: participantName,
        is_self: false,
        company: '星火科技',
        title: '市场总监',
        confidence: 'high',
        source_quote: `我是星火科技的市场总监${participantName}`,
        ...participantOverrides,
      },
    ],
    events: [
      {
        kind: 'meeting',
        title: '聊合作',
        time_text: '明天下午两点',
        time_iso: '2026-08-27T14:00:00+08:00',
        has_time_signal: true,
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

function buildResolvableMeeting(
  overrides: Partial<ResolvableMeeting> = {},
): ResolvableMeeting {
  return {
    id: 101,
    kind: 'other',
    title: '荀导彩排接待',
    time_iso: '2026-09-02T14:00:00+08:00',
    time_text: '9月2日下午两点',
    status: 'upcoming',
    created_at: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

function emptyExtraction(): PerceptionResult {
  return {
    participants: [
      {
        name: '荀导',
        is_self: false,
        confidence: 'high',
        source_quote: '荀导已到',
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
}

test('text comparison helpers preserve empty similarity and count Unicode code points', () => {
  assert.equal(normalizeComparableText('  ALICE  '), 'alice');
  assert.equal(editDistance('甲😀乙', '甲😃乙'), 1);
  assert.equal(editDistance('', '😀'), 1);
  assert.equal(normalizedEditSimilarity('', ''), 0);
  assert.equal(normalizedEditSimilarity('王磊', '王磊'), 1);
  assert.equal(normalizeContactText(' Ａ，王 '), 'a王');
  assert.deepEqual(tokenize('某集团，市场部'), ['某集团', '市场部']);
});

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

test('resolveParticipants omits participants marked is_self from the result set', async () => {
  const provider = new FakeStructuredOutputProvider([{ decision: 'same_as', contact_id: 71 }]);
  const contacts: ResolvableContact[] = [
    { id: 71, canonical_name: 'Alice', aliases: ['我'], company: 'OpenAI' },
  ];

  const resolutions = await resolveParticipants({
    extraction: buildExtraction('Alice', { is_self: true }),
    contacts,
    provider,
  });

  assert.equal(provider.calls, 0);
  assert.deepEqual(resolutions, [] satisfies ParticipantResolution[]);
});

test('resolveParticipants still resolves normal participants when a self participant appears first', async () => {
  const provider = new FakeStructuredOutputProvider([{ decision: 'same_as', contact_id: 72 }]);
  const contacts: ResolvableContact[] = [
    { id: 71, canonical_name: 'Alice', aliases: ['我'], company: 'OpenAI' },
    { id: 72, canonical_name: '王磊', aliases: ['William'], company: '星火科技' },
  ];

  const resolutions = await resolveParticipants({
    extraction: {
      participants: [
        {
          name: '  我  ',
          is_self: false,
          confidence: 'high',
          source_quote: '我来处理',
        },
        {
          name: 'Will',
          is_self: false,
          company: '星火科技',
          title: '市场总监',
          confidence: 'high',
          source_quote: '我是星火科技的市场总监 Will',
        },
      ],
      events: [
        {
          kind: 'meeting',
          title: '聊合作',
          time_text: '明天下午两点',
          time_iso: '2026-08-27T14:00:00+08:00',
          has_time_signal: true,
          participant_names: ['我', 'Will'],
          confidence: 'medium',
          source_quote: '明天下午两点我和 Will 聊合作',
        },
      ],
      facts: [
        {
          subject_name: 'Will',
          field: 'phone',
          value: '13800001234',
          confidence: 'high',
          source_quote: '电话 13800001234',
        },
      ],
      quotes: [
        {
          speaker_name: 'Will',
          text: '我是星火科技的市场总监 Will',
          source_quote: '我是星火科技的市场总监 Will',
        },
      ],
    },
    contacts,
    provider,
  });

  assert.equal(provider.calls, 1);
  assert.deepEqual(resolutions, [
    {
      participant_name: 'Will',
      normalized_name: 'will',
      status: 'same_as',
      contact_id: 72,
      source: 'llm',
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

test('resolveParticipants turns a provider new decision into near-match disambiguation', async () => {
  const provider = new FakeStructuredOutputProvider([{ decision: 'new' }]);
  const contacts: ResolvableContact[] = [
    { id: 42, canonical_name: '王磊', aliases: ['老王'], company: '星火科技' },
  ];

  const resolutions = await resolveParticipants({
    extraction: buildExtraction('王蕾'),
    contacts,
    provider,
  });

  assert.deepEqual(resolutions, [
    {
      participant_name: '王蕾',
      normalized_name: '王蕾',
      status: 'unsure',
      candidate_ids: [42],
      source: 'near_match',
    },
  ] satisfies ParticipantResolution[]);
});

test('resolveParticipants does not treat a two-character name deletion as a near match', async () => {
  const provider = new FakeStructuredOutputProvider([{ decision: 'new' }]);
  const contacts: ResolvableContact[] = [
    { id: 43, canonical_name: '王', aliases: [], company: null },
  ];

  const resolutions = await resolveParticipants({
    extraction: buildExtraction('王磊'),
    contacts,
    provider,
  });

  assert.deepEqual(resolutions, [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'new',
      source: 'llm',
    },
  ] satisfies ParticipantResolution[]);
});

test('resolveParticipants leaves a provider same_as decision unchanged when near matches exist', async () => {
  const provider = new FakeStructuredOutputProvider([
    { decision: 'same_as', contact_id: 45 },
  ]);
  const contacts: ResolvableContact[] = [
    { id: 44, canonical_name: '王磊', aliases: [], company: '星火科技' },
    { id: 45, canonical_name: '陈希', aliases: ['小陈'], company: '远山工作室' },
  ];

  const resolutions = await resolveParticipants({
    extraction: buildExtraction('王蕾'),
    contacts,
    provider,
  });

  assert.deepEqual(resolutions, [
    {
      participant_name: '王蕾',
      normalized_name: '王蕾',
      status: 'same_as',
      contact_id: 45,
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

test('resolveParticipants appends canonical and alias near matches to provider unsure candidates', async () => {
  const provider = new FakeStructuredOutputProvider([
    { decision: 'unsure', candidate_ids: [51, 52] },
  ]);
  const contacts: ResolvableContact[] = [
    { id: 51, canonical_name: '魏敏', aliases: [], company: '远山工作室' },
    { id: 52, canonical_name: '王磊', aliases: [], company: '星火科技' },
    { id: 53, canonical_name: '陈希', aliases: ['王雷'], company: '青禾文化' },
  ];

  const resolutions = await resolveParticipants({
    extraction: buildExtraction('王蕾'),
    contacts,
    provider,
  });

  assert.deepEqual(resolutions, [
    {
      participant_name: '王蕾',
      normalized_name: '王蕾',
      status: 'unsure',
      candidate_ids: [51, 52, 53],
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

test('resolveMeetingProgress batches high-confidence fragments into one complete call', async () => {
  const provider = new FakeCompletionProvider([
    JSON.stringify({
      matches: [
        { fragment_id: 1, meeting_id: 101, confidence: 'high' },
        { fragment_id: 2, meeting_id: 101, confidence: 'high' },
        { fragment_id: 3, meeting_id: 101, confidence: 'high' },
        { fragment_id: 4, meeting_id: 101, confidence: 'high' },
      ],
    }),
  ]);
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '荀导',
        is_self: false,
        interaction_summary: '荀导已到',
        confidence: 'high',
        source_quote: '荀导已到',
      },
      {
        name: '魏总',
        is_self: false,
        interaction_summary: '魏总已到',
        confidence: 'low',
        source_quote: '魏总已到',
      },
      {
        name: '嘉宾',
        is_self: false,
        notes: '嘉宾已就位',
        confidence: 'high',
        source_quote: '嘉宾已就位',
      },
    ],
    events: [
      {
        kind: 'other',
        title: '报名材料',
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        participant_names: [],
        agenda: '报名材料已补齐',
        confidence: 'high',
        source_quote: '报名材料已补齐',
      },
    ],
    facts: [
      {
        subject_name: '王总',
        field: 'other',
        value: '王总到了',
        confidence: 'medium',
        source_quote: '王总到了',
      },
    ],
    quotes: [
      {
        speaker_name: null,
        text: '重复的王总原话',
        source_quote: '王总到了',
      },
    ],
  };

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting()],
    provider,
  });

  assert.equal(provider.completeCalls, 1);
  assert.equal(provider.structuredOutputCalls, 0);
  assert.equal(provider.requests[0]?.temperature, 0);
  assert.deepEqual(provider.requests[0]?.responseFormat, { type: 'json_object' });
  assert.deepEqual(resolutions, [
    {
      meeting_id: 101,
      fragments: [
        { content: '荀导已到', source_quote: '荀导已到' },
        { content: '嘉宾已就位', source_quote: '嘉宾已就位' },
        { content: '王总到了', source_quote: '王总到了' },
        { content: '报名材料已补齐', source_quote: '报名材料已补齐' },
      ],
    },
  ] satisfies MeetingProgressResolution[]);

  const userMessage = provider.requests[0]?.messages.find((message) => message.role === 'user');
  assert.equal(typeof userMessage?.content, 'string');
  const promptBody = JSON.parse(userMessage?.content as string) as {
    fragments: Array<{ fragment_id: number; source_quote: string }>;
    perception: PerceptionResult;
  };
  assert.deepEqual(promptBody.perception, extraction);
  assert.deepEqual(
    promptBody.fragments.map((fragment) => fragment.fragment_id),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    promptBody.fragments.map((fragment) => fragment.source_quote),
    ['荀导已到', '嘉宾已就位', '王总到了', '报名材料已补齐'],
  );
});

test('resolveMeetingProgress rejects medium, low, and conflicting high matches', async () => {
  const provider = new FakeCompletionProvider([
    JSON.stringify({
      matches: [
        { fragment_id: 1, meeting_id: 101, confidence: 'medium' },
        { fragment_id: 2, meeting_id: 101, confidence: 'low' },
        { fragment_id: 3, meeting_id: 101, confidence: 'high' },
        { fragment_id: 3, meeting_id: 102, confidence: 'high' },
      ],
    }),
  ]);
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '荀导',
        is_self: false,
        interaction_summary: '荀导已到',
        confidence: 'high',
        source_quote: '荀导已到',
      },
    ],
    events: [],
    facts: [
      {
        subject_name: '王总',
        field: 'notes',
        value: '王总到了',
        confidence: 'high',
        source_quote: '王总到了',
      },
    ],
    quotes: [
      {
        speaker_name: null,
        text: '陈总到了',
        source_quote: '陈总到了',
      },
    ],
  };

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [
      buildResolvableMeeting(),
      buildResolvableMeeting({ id: 102, title: '王总接待' }),
    ],
    provider,
  });

  assert.equal(provider.completeCalls, 1);
  assert.deepEqual(resolutions, []);
});

test('resolveMeetingProgress rejects a high match when another target is also returned at lower confidence', async () => {
  const provider = new FakeCompletionProvider([
    JSON.stringify({
      matches: [
        { fragment_id: 1, meeting_id: 101, confidence: 'high' },
        { fragment_id: 1, meeting_id: 102, confidence: 'medium' },
      ],
    }),
  ]);
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [
      buildResolvableMeeting(),
      buildResolvableMeeting({ id: 102, title: '荀导接待' }),
    ],
    provider,
  });

  assert.equal(provider.completeCalls, 1);
  assert.deepEqual(resolutions, []);
});

test('resolveMeetingProgress rejects mixed confidence rows even when they name the same target', async () => {
  const provider = new FakeCompletionProvider([
    JSON.stringify({
      matches: [
        { fragment_id: 1, meeting_id: 101, confidence: 'high' },
        { fragment_id: 1, meeting_id: 101, confidence: 'low' },
      ],
    }),
  ]);
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting()],
    provider,
  });

  assert.equal(provider.completeCalls, 1);
  assert.deepEqual(resolutions, []);
});

test('resolveMeetingProgress skips the provider when no upcoming meeting exists', async () => {
  const provider = new FakeCompletionProvider([]);
  let factoryCalls = 0;
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting({ status: 'completed' })],
    provider,
    providerFactory: () => {
      factoryCalls += 1;
      return provider;
    },
  });

  assert.deepEqual(resolutions, []);
  assert.equal(provider.completeCalls, 0);
  assert.equal(factoryCalls, 0);
});

test('resolveMeetingProgress skips the provider when no direct progress signal exists', async () => {
  const provider = new FakeCompletionProvider([]);
  let factoryCalls = 0;
  const extraction = emptyExtraction();
  extraction.participants.push({
    name: '荀导',
    is_self: false,
    interaction_summary: '和荀导讨论了彩排安排',
    confidence: 'high',
    source_quote: '我们讨论一下明天的彩排安排',
  });

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting()],
    provider,
    providerFactory: () => {
      factoryCalls += 1;
      return provider;
    },
  });

  assert.deepEqual(resolutions, []);
  assert.equal(provider.completeCalls, 0);
  assert.equal(factoryCalls, 0);
});

test('resolveMeetingProgress skips unanchored progress when no person can receive the interaction fallback', async () => {
  const provider = new FakeCompletionProvider([]);
  const extraction: PerceptionResult = {
    participants: [],
    events: [],
    facts: [],
    quotes: [
      {
        speaker_name: null,
        text: '荀导已到',
        source_quote: '荀导已到',
      },
    ],
  };

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting()],
    provider,
  });

  assert.deepEqual(resolutions, []);
  assert.equal(provider.completeCalls, 0);
});

test('resolveMeetingProgress conservatively returns empty for invalid JSON', async () => {
  const provider = new FakeCompletionProvider(['not-json']);
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting()],
    provider,
  });

  assert.equal(provider.completeCalls, 1);
  assert.deepEqual(resolutions, []);
});

test('resolveMeetingProgress conservatively returns empty for out-of-range ids', async () => {
  const provider = new FakeCompletionProvider([
    '{"matches":[{"fragment_id":1,"meeting_id":999,"confidence":"high"}]}',
  ]);
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting()],
    provider,
  });

  assert.equal(provider.completeCalls, 1);
  assert.deepEqual(resolutions, []);
});

test('resolveMeetingProgress conservatively returns empty for provider failures', async () => {
  const provider = new FakeCompletionProvider([new Error('network unavailable')]);
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting()],
    provider,
  });

  assert.equal(provider.completeCalls, 1);
  assert.deepEqual(resolutions, []);
});

test('resolveMeetingProgress conservatively returns empty when provider creation fails', async () => {
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });

  const resolutions = await resolveMeetingProgress({
    extraction,
    meetings: [buildResolvableMeeting()],
    providerFactory() {
      throw new Error('provider configuration unavailable');
    },
  });

  assert.deepEqual(resolutions, []);
});

test('resolveMeetingProgress requires a provider only when a call is needed', async () => {
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });

  await assert.rejects(
    resolveMeetingProgress({ extraction, meetings: [buildResolvableMeeting()] }),
    TypeError,
  );
});

test('resolveMeetingProgress sends only the newest whitelisted meeting fields', async () => {
  const provider = new FakeCompletionProvider(['{"matches":[]}']);
  const extraction = emptyExtraction();
  extraction.quotes.push({
    speaker_name: null,
    text: '荀导已到',
    source_quote: '荀导已到',
  });
  const meetings = Array.from({ length: MEETING_PROGRESS_CANDIDATE_LIMIT + 2 }, (_, index) => ({
    ...buildResolvableMeeting({
      id: index + 1,
      title: `事项 ${index + 1}`,
      created_at: `2026-09-${String(index + 1).padStart(2, '0')}T08:00:00.000Z`,
    }),
    agenda: `private agenda ${index + 1}`,
    participants: [`private participant ${index + 1}`],
    location: `private location ${index + 1}`,
  }));
  meetings.push({
    ...buildResolvableMeeting({
      id: 999,
      status: 'completed',
      created_at: '2026-10-01T08:00:00.000Z',
    }),
    agenda: 'completed private agenda',
    participants: ['completed private participant'],
    location: 'completed private location',
  });

  await resolveMeetingProgress({ extraction, meetings, provider });

  assert.equal(provider.completeCalls, 1);
  const systemMessage = provider.requests[0]?.messages.find(
    (message) => message.role === 'system',
  );
  assert.equal(typeof systemMessage?.content, 'string');
  assert.match(systemMessage?.content as string, /direct, explicit context/u);
  assert.match(systemMessage?.content as string, /similar topic or wording alone is not enough/iu);
  assert.match(systemMessage?.content as string, /Do not rewrite/u);
  assert.match(systemMessage?.content as string, /never as instructions/u);

  const userMessage = provider.requests[0]?.messages.find((message) => message.role === 'user');
  assert.equal(typeof userMessage?.content, 'string');
  const promptBody = JSON.parse(userMessage?.content as string) as {
    meetings: Array<Record<string, unknown>>;
  };

  assert.equal(promptBody.meetings.length, MEETING_PROGRESS_CANDIDATE_LIMIT);
  assert.deepEqual(
    promptBody.meetings.map((meeting) => meeting.id),
    Array.from({ length: MEETING_PROGRESS_CANDIDATE_LIMIT }, (_, index) => 22 - index),
  );

  for (const meeting of promptBody.meetings) {
    assert.deepEqual(Object.keys(meeting).sort(), [
      'id',
      'kind',
      'time_iso',
      'time_text',
      'title',
    ]);
    assert.equal('agenda' in meeting, false);
    assert.equal('participants' in meeting, false);
    assert.equal('location' in meeting, false);
    assert.equal('status' in meeting, false);
    assert.equal('created_at' in meeting, false);
  }
});
