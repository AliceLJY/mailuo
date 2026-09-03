import test from 'node:test';
import assert from 'node:assert/strict';

import type { PerceptionResult } from '../../../shared/core/agent/perceive.ts';
import type {
  MeetingProgressResolution,
  ParticipantResolution,
  ResolvableContact,
} from '../../../shared/core/agent/resolve.ts';
import {
  dedupeBatchOtherCards,
  proposeCards as baseProposeCards,
  proposeCardsWithRouting as baseProposeCardsWithRouting,
  type ExistingMeeting,
} from '../../../shared/core/agent/propose.ts';

const proposalNow = new Date('2026-08-27T02:00:00.000Z');

function proposeCards(
  extraction: PerceptionResult,
  resolutions?: ParticipantResolution[],
  contacts: ResolvableContact[] = [],
  now = proposalNow,
  existingMeetings: ExistingMeeting[] = [],
  meetingProgressResolutions: MeetingProgressResolution[] = [],
) {
  return baseProposeCards(
    extraction,
    resolutions,
    contacts,
    now,
    existingMeetings,
    meetingProgressResolutions,
  );
}

function proposeCardsWithRouting(
  extraction: PerceptionResult,
  resolutions?: ParticipantResolution[],
  contacts: ResolvableContact[] = [],
  now = proposalNow,
  existingMeetings: ExistingMeeting[] = [],
  meetingProgressResolutions: MeetingProgressResolution[] = [],
) {
  return baseProposeCardsWithRouting(
    extraction,
    resolutions,
    contacts,
    now,
    existingMeetings,
    meetingProgressResolutions,
  );
}

function singleParticipantExtraction(
  overrides: Partial<PerceptionResult['participants'][number]> = {},
): PerceptionResult {
  return {
    participants: [
      {
        name: '王磊',
        is_self: false,
        confidence: 'high',
        source_quote: '王磊补充了联系人资料',
        ...overrides,
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
}

test('proposeCards creates contact and meeting cards from perception output', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        company: '星火科技',
        title: '市场总监',
        confidence: 'high',
        source_quote: '我是星火科技的市场总监王磊',
      },
      {
        name: '李姐',
        is_self: false,
        aliases: ['鲍总'],
        confidence: 'medium',
        source_quote: '李姐，下周三下午 3 点来我们公司聊合作。',
      },
    ],
    events: [
      {
        kind: 'meeting',
        title: '聊合作',
        time_text: '下周三下午 3 点',
        time_iso: '2026-09-02T15:00:00+08:00',
        has_time_signal: true,
        location: '我们公司',
        participant_names: ['李姐'],
        agenda: '合作沟通',
        confidence: 'high',
        source_quote: '下周三下午 3 点来我们公司聊合作。',
      },
    ],
    facts: [
      {
        subject_name: '王磊',
        field: 'phone',
        value: '13800001234',
        confidence: 'high',
        source_quote: '电话 13800001234',
      },
      {
        subject_name: '王磊',
        field: 'wechat_id',
        value: 'wl-sh',
        confidence: 'high',
        source_quote: '微信 wl-sh',
      },
      {
        subject_name: '李姐',
        field: 'alias',
        value: '鲍总',
        confidence: 'medium',
        source_quote: '鲍总，下周三下午 3 点来我们公司聊合作。',
      },
      {
        subject_name: '李姐',
        field: 'notes',
        value: '对方主动约线下沟通',
        confidence: 'medium',
        source_quote: '来我们公司聊合作',
      },
    ],
    quotes: [
      {
        speaker_name: '王磊',
        text: '我是星火科技的市场总监王磊',
        source_quote: '我是星火科技的市场总监王磊',
      },
    ],
  };

  const cards = proposeCards(extraction);

  assert.equal(cards.length, 3);
  assert.deepEqual(cards[0], {
    type: 'create_contact',
      payload: {
        name: '王磊',
        company: '星火科技',
        title: '市场总监',
        phone: '13800001234',
        wechat_id: 'wl-sh',
      },
      confidence: 'high',
      source_quote: '我是星火科技的市场总监王磊\n\n电话 13800001234\n\n微信 wl-sh',
    });
  assert.deepEqual(cards[1], {
    type: 'create_contact',
    payload: {
      name: '李姐',
      aliases: ['鲍总'],
      notes: '对方主动约线下沟通',
    },
    confidence: 'medium',
    source_quote: '李姐，下周三下午 3 点来我们公司聊合作。\n\n来我们公司聊合作',
  });
  assert.deepEqual(cards[2], {
    type: 'create_meeting',
    payload: {
      kind: 'meeting',
      title: '聊合作',
      time_iso: '2026-09-02T15:00:00+08:00',
      time_text: '下周三下午 3 点',
      location: '我们公司',
      participants: [{ name: '李姐' }],
      agenda: '合作沟通',
    },
    confidence: 'high',
    source_quote: '下周三下午 3 点来我们公司聊合作。',
  });
});

test('proposeCards creates update_contact, meeting contact ids, and one interaction card for same_as contacts', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        company: '新公司',
        title: '市场总监',
        confidence: 'high',
        source_quote: '我上个月跳槽去了新公司',
      },
    ],
    events: [
      {
        kind: 'meeting',
        title: '喝咖啡聊合作',
        time_text: '明天下午两点',
        time_iso: '2026-08-27T14:00:00+08:00',
        has_time_signal: true,
        participant_names: ['王磊', '路人甲'],
        confidence: 'medium',
        source_quote: '明天下午两点一起喝咖啡聊合作',
      },
    ],
    facts: [
      {
        subject_name: '王磊',
        field: 'company',
        value: '新公司',
        confidence: 'high',
        source_quote: '跳槽去了新公司',
      },
    ],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 1,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 1,
      canonical_name: '王磊',
      aliases: ['老王'],
      company: '远山工作室',
      title: '市场总监',
      phone: '13800001234',
      wechat_id: 'wl-old',
      notes: '老联系人',
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);

  assert.equal(cards.length, 3);
  assert.deepEqual(cards[0], {
    type: 'update_contact',
    payload: {
      contact_id: 1,
      contact_name: '王磊',
      changes: {
        company: { old: '远山工作室', new: '新公司' },
      },
    },
    confidence: 'high',
    source_quote: '我上个月跳槽去了新公司',
  });
  assert.deepEqual(cards[1], {
    type: 'create_meeting',
    payload: {
      kind: 'meeting',
      title: '喝咖啡聊合作',
      time_iso: '2026-08-27T14:00:00+08:00',
      time_text: '明天下午两点',
      participants: [{ contact_id: 1, name: '王磊' }, { name: '路人甲' }],
    },
    confidence: 'medium',
    source_quote: '明天下午两点一起喝咖啡聊合作',
  });
  assert.deepEqual(cards[2], {
    type: 'record_interaction',
    payload: {
      contact_id: 1,
      contact_name: '王磊',
      summary: '我上个月跳槽去了新公司',
    },
    confidence: 'high',
    source_quote: '我上个月跳槽去了新公司\n\n跳槽去了新公司',
  });
});

test('proposeCards proposes an alias-only confirmed update after an LLM same_as resolution', () => {
  const extraction: PerceptionResult = {
    participants: [{
      name: '王总',
      aliases: ['王磊'],
      is_self: false,
      confidence: 'high',
      source_quote: '@王磊 王总，方案已经发你',
    }],
    events: [],
    facts: [],
    quotes: [],
  };
  const contacts: ResolvableContact[] = [{
    id: 1,
    canonical_name: '王磊',
    aliases: [],
  }];
  const resolutions: ParticipantResolution[] = [{
    participant_name: '王总',
    normalized_name: '王总',
    status: 'same_as',
    contact_id: 1,
    source: 'llm',
  }];

  assert.deepEqual(proposeCards(extraction, resolutions, contacts), [{
    type: 'update_contact',
    payload: {
      contact_id: 1,
      contact_name: '王磊',
      changes: {
        aliases: { old: null, new: '王总' },
      },
    },
    confidence: 'high',
    source_quote: '@王磊 王总，方案已经发你',
  }, {
    type: 'record_interaction',
    payload: {
      contact_id: 1,
      contact_name: '王磊',
      summary: '@王磊 王总，方案已经发你',
    },
    confidence: 'high',
    source_quote: '@王磊 王总，方案已经发你',
  }]);
});

test('proposeCards prefers participant interaction_summary for interaction payloads and keeps source_quote grounded in raw evidence', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        company: '新公司',
        interaction_summary: '聊了合作推进，对方表示下周给我明确反馈。',
        confidence: 'high',
        source_quote: '王磊说下周给我明确反馈',
      },
    ],
    events: [],
    facts: [
      {
        subject_name: '王磊',
        field: 'company',
        value: '新公司',
        confidence: 'high',
        source_quote: '我已经去了新公司',
      },
    ],
    quotes: [
      {
        speaker_name: '王磊',
        text: '下周给你明确反馈',
        source_quote: '王磊说：下周给你明确反馈',
      },
    ],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 1,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 1,
      canonical_name: '王磊',
      aliases: ['老王'],
      company: '旧公司',
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const interactionCard = cards.find((card) => card.type === 'record_interaction');

  assert.ok(interactionCard);
  assert.deepEqual(interactionCard.payload, {
    contact_id: 1,
    contact_name: '王磊',
    summary: '聊了合作推进，对方表示下周给我明确反馈。',
  });
  assert.equal(
    interactionCard.source_quote,
    '王磊说下周给我明确反馈\n\n我已经去了新公司\n\n王磊说：下周给你明确反馈',
  );
});

test('proposeCards resolves an absolute month/day with the current year and ignores a relative prefix', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [
      {
        kind: 'meeting',
        title: '复盘会',
        time_text: '明天8月26日（周三）上午9:30',
        time_iso: null,
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '明天8月26日（周三）上午9:30开复盘会',
      },
    ],
    facts: [],
    quotes: [],
  };

  assert.deepEqual(proposeCards(extraction, [], [], new Date('2026-08-29T08:00:00+08:00')), [
    {
      type: 'create_meeting',
      payload: {
        kind: 'meeting',
        title: '复盘会',
        time_iso: '2026-08-26T09:30:00+08:00',
        time_text: '明天8月26日（周三）上午9:30',
        participants: [],
      },
      confidence: 'medium',
      source_quote: '明天8月26日（周三）上午9:30开复盘会',
    },
  ]);
});

test('proposeCards keeps bare weekday labels from overriding an absolute calendar date', () => {
  const cases = [
    ['8月26日周三上午9:30', '2026-08-26T09:30:00+08:00'],
    ['8月26日星期三上午9:30', '2026-08-26T09:30:00+08:00'],
    ['8月26日礼拜三上午9:30', '2026-08-26T09:30:00+08:00'],
    ['8月26日週三上午9:30', '2026-08-26T09:30:00+08:00'],
    ['8 月 26 日 上午 9 点 30 分', '2026-08-26T09:30:00+08:00'],
    ['8月26日 16 时 30 分', '2026-08-26T16:30:00+08:00'],
    ['2025 年 8 月 26 日上午9:30', '2025-08-26T09:30:00+08:00'],
    ['2025年8月26日周三上午9:30', '2025-08-26T09:30:00+08:00'],
    ['二〇二五年八月二十六日上午九点半', '2025-08-26T09:30:00+08:00'],
    ['二零二五年8月26日上午9:30', '2025-08-26T09:30:00+08:00'],
  ] as const;

  for (const [timeText, expectedTimeIso] of cases) {
    const extraction: PerceptionResult = {
      participants: [],
      events: [
        {
          kind: 'meeting',
          title: '复盘会',
          time_text: timeText,
          time_iso: null,
          has_time_signal: true,
          participant_names: [],
          confidence: 'medium',
          source_quote: `${timeText}开复盘会`,
        },
      ],
      facts: [],
      quotes: [],
    };

    const [card] = proposeCards(
      extraction,
      [],
      [],
      new Date('2026-08-29T08:00:00+08:00'),
    );

    assert.equal(card?.type, 'create_meeting');
    assert.equal(card?.payload.time_iso, expectedTimeIso);
  }
});

test('proposeCards leaves a date-only absolute expression without an invented hour', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [
      {
        kind: 'meeting',
        title: '复盘会',
        time_text: '8月27日（周四）',
        time_iso: '2026-08-27T00:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '8月27日（周四）开复盘会',
      },
    ],
    facts: [],
    quotes: [],
  };

  const [card] = proposeCards(
    extraction,
    [],
    [],
    new Date('2026-08-29T08:00:00+08:00'),
  );

  assert.equal(card?.type, 'create_meeting');
  assert.equal(card?.payload.time_iso, null);
  assert.equal(card?.payload.time_text, '8月27日（周四）');
});

test('proposeCards leaves relative-only time_iso null when a time signal exists', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [
      {
        kind: 'meeting',
        title: '继续聊',
        time_text: '下周三下午三点',
        time_iso: null,
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '下周三下午三点继续聊',
      },
    ],
    facts: [],
    quotes: [],
  };

  assert.deepEqual(proposeCards(extraction, [], [], new Date('2026-08-29T08:00:00+08:00')), [
    {
      type: 'create_meeting',
      payload: {
        kind: 'meeting',
        title: '继续聊',
        time_iso: null,
        time_text: '下周三下午三点',
        participants: [],
      },
      confidence: 'medium',
      source_quote: '下周三下午三点继续聊',
    },
  ]);
});

test('proposeCards preserves model time_iso when legacy time_text is blank', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [
      {
        kind: 'meeting',
        title: '继续聊',
        time_text: '   ',
        time_iso: '2026-08-28T18:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '明晚继续聊',
      },
    ],
    facts: [],
    quotes: [],
  };

  assert.deepEqual(proposeCards(extraction), [
    {
      type: 'create_meeting',
      payload: {
        kind: 'meeting',
        title: '继续聊',
        time_iso: '2026-08-28T18:00:00+08:00',
        time_text: '',
        participants: [],
      },
      confidence: 'medium',
      source_quote: '明晚继续聊',
    },
  ]);
});

test('proposeCards preserves a model time_iso resolved from an absolute timestamp anchor', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [{
      kind: 'meeting',
      title: '方案评审',
      time_text: '今天下午14:30',
      time_iso: '2026-08-12T14:30:00+08:00',
      has_time_signal: true,
      participant_names: [],
      confidence: 'high',
      source_quote: '今天下午14:30开方案评审',
    }],
    facts: [],
    quotes: [],
  };

  const cards = proposeCards(
    extraction,
    [],
    [],
    new Date('2026-09-01T08:00:00+08:00'),
  );

  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card?.type, 'create_meeting');
  if (card?.type !== 'create_meeting') {
    throw new Error('expected create_meeting card');
  }
  assert.equal(card.payload.time_iso, '2026-08-12T14:30:00+08:00');
});

test('proposeCards preserves model time_iso when no absolute month/day is present', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [
      {
        kind: 'meeting',
        title: '改天聊',
        time_text: '改天',
        time_iso: '2026-08-30T09:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '改天聊',
      },
      {
        kind: 'meeting',
        title: '回头再约',
        time_text: '回头',
        time_iso: '2026-08-31T09:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '回头再约',
      },
      {
        kind: 'meeting',
        title: '超能力时间',
        time_text: '超能力',
        time_iso: '2026-09-01T09:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'low',
        source_quote: '超能力时间',
      },
      {
        kind: 'meeting',
        title: '二十五点',
        time_text: '下周三下午二十五点',
        time_iso: '2026-09-02T15:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '下周三下午二十五点见',
      },
      {
        kind: 'meeting',
        title: '多余周前缀',
        time_text: '下下下周三',
        time_iso: '2026-09-09T09:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '下下下周三见',
      },
      {
        kind: 'meeting',
        title: '方案评审',
        time_text: '第2号方案',
        time_iso: '2026-09-10T09:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'medium',
        source_quote: '先看第2号方案',
      },
    ],
    facts: [],
    quotes: [],
  };
  const cards = proposeCards(extraction);

  assert.deepEqual(
    cards.map((card) => (card.type === 'create_meeting' ? card.payload.time_iso : null)),
    [
      '2026-08-30T09:00:00+08:00',
      '2026-08-31T09:00:00+08:00',
      '2026-09-01T09:00:00+08:00',
      '2026-09-02T15:00:00+08:00',
      '2026-09-09T09:00:00+08:00',
      '2026-09-10T09:00:00+08:00',
    ],
  );
  assert.equal(cards.length, 6);
});

test('proposeCards falls back to raw quote content when interaction_summary is missing', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        aliases: ['王总'],
        company: '星火科技',
        title: '市场总监',
        phone: '13800001234',
        wechat_id: 'wang-lei',
        notes: '由本人在当前对话中提供',
        confidence: 'high',
        source_quote: '今天和王磊继续推进合作',
      },
    ],
    events: [],
    facts: [],
    quotes: [
      {
        speaker_name: '王磊',
        text: '周五前把方案发你',
        source_quote: '王磊说：周五前把方案发你',
      },
    ],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 5,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 5,
      canonical_name: '王磊',
      aliases: [],
      company: null,
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const interactionCard = cards.find((card) => card.type === 'record_interaction');

  assert.ok(interactionCard);
  assert.deepEqual(interactionCard.payload, {
    contact_id: 5,
    contact_name: '王磊',
    summary: '今天和王磊继续推进合作；周五前把方案发你',
  });
  assert.equal(
    interactionCard.source_quote,
    '今天和王磊继续推进合作\n\n王磊说：周五前把方案发你',
  );
});

test('proposeCards records interactions only for initiating or legacy participants', () => {
  const resolution: ParticipantResolution = {
    participant_name: '骆澄',
    normalized_name: '骆澄',
    status: 'same_as',
    contact_id: 15,
    source: 'exact',
  };
  const contact: ResolvableContact = {
    id: 15,
    canonical_name: '骆澄',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  };
  const baseParticipant: PerceptionResult['participants'][number] = {
    name: '骆澄',
    is_self: false,
    role: 'speaker',
    interaction_summary: '骆澄就项目安排作了说明。',
    confidence: 'high',
    source_quote: '骆澄：我来安排下一轮评审',
  };
  const extraction = (
    participant: PerceptionResult['participants'][number],
  ): PerceptionResult => ({
    participants: [participant],
    events: [],
    facts: [],
    quotes: [],
  });

  const respondCards = proposeCards(
    extraction({ ...baseParticipant, speech_act: 'respond', company: '星桥科技' }),
    [resolution],
    [contact],
  );
  const initiateCards = proposeCards(
    extraction({ ...baseParticipant, speech_act: 'initiate' }),
    [resolution],
    [contact],
  );
  const legacyCards = proposeCards(extraction(baseParticipant), [resolution], [contact]);

  assert.deepEqual(respondCards.map((card) => card.type), ['update_contact']);
  assert.deepEqual(
    respondCards[0]?.type === 'update_contact' ? respondCards[0].payload.changes : null,
    { company: { old: null, new: '星桥科技' } },
  );
  assert.equal(
    initiateCards.some((card) => card.type === 'record_interaction'),
    true,
  );
  assert.equal(
    legacyCards.some((card) => card.type === 'record_interaction'),
    true,
  );
});

test('proposeCards omits an interaction when three source messages are only acknowledgements', () => {
  const sourceQuotes = ['收到！', '收到1️⃣', '收到 👍'];
  const extraction: PerceptionResult = {
    participants: sourceQuotes.map((sourceQuote) => ({
      name: '王磊',
      is_self: false,
      role: 'speaker',
      interaction_summary: '王磊已确认收到通知。',
      confidence: 'high',
      source_quote: sourceQuote,
    })),
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = sourceQuotes.map(() => ({
    participant_name: '王磊',
    normalized_name: '王磊',
    status: 'same_as',
    contact_id: 12,
    source: 'exact',
  }));
  const contacts: ResolvableContact[] = [{
    id: 12,
    canonical_name: '王磊',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  }];

  assert.deepEqual(proposeCards(extraction, resolutions, contacts), []);
});

test('proposeCards keeps an interaction when an acknowledgement message contains substantive text', () => {
  const extraction = singleParticipantExtraction({
    role: 'speaker',
    interaction_summary: '王磊明天上午会带车牌号过去。',
    source_quote: '收到，明天上午我带车牌号过去',
  });
  const resolutions: ParticipantResolution[] = [{
    participant_name: '王磊',
    normalized_name: '王磊',
    status: 'same_as',
    contact_id: 13,
    source: 'exact',
  }];
  const contacts: ResolvableContact[] = [{
    id: 13,
    canonical_name: '王磊',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  }];
  const interactionCard = proposeCards(extraction, resolutions, contacts)
    .find((card) => card.type === 'record_interaction');

  assert.ok(interactionCard);
});

test('proposeCards keeps an interaction when mixed source evidence includes one substantive quote', () => {
  const extraction = singleParticipantExtraction({
    role: 'speaker',
    source_quote: '收到！',
  });
  extraction.quotes = [
    {
      speaker_name: '王磊',
      text: '明天上午我带车牌号过去',
      source_quote: '明天上午我带车牌号过去',
    },
  ];
  const resolutions: ParticipantResolution[] = [{
    participant_name: '王磊',
    normalized_name: '王磊',
    status: 'same_as',
    contact_id: 14,
    source: 'exact',
  }];
  const contacts: ResolvableContact[] = [{
    id: 14,
    canonical_name: '王磊',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  }];
  const interactionCard = proposeCards(extraction, resolutions, contacts)
    .find((card) => card.type === 'record_interaction');

  assert.ok(interactionCard);
  assert.equal(interactionCard.payload.summary, '收到！；明天上午我带车牌号过去');
});

test('proposeCards omits an interaction when acknowledgement evidence carries a department-plus-name prefix', () => {
  const sourceQuotes = ['集团市场部 小禾 收到', '收到'];
  const extraction: PerceptionResult = {
    participants: sourceQuotes.map((sourceQuote) => ({
      name: '小禾',
      is_self: false,
      role: 'speaker',
      interaction_summary: '小禾已确认收到通知。',
      confidence: 'high',
      source_quote: sourceQuote,
    })),
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = sourceQuotes.map(() => ({
    participant_name: '小禾',
    normalized_name: '小禾',
    status: 'same_as',
    contact_id: 101,
    source: 'exact',
  }));
  const contacts: ResolvableContact[] = [{
    id: 101,
    canonical_name: '小禾',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  }];

  assert.deepEqual(proposeCards(extraction, resolutions, contacts), []);
});

test('proposeCards omits an interaction when an acknowledgement follows a bare name prefix', () => {
  const extraction = singleParticipantExtraction({
    name: '小禾',
    role: 'speaker',
    interaction_summary: '小禾已确认收到通知。',
    source_quote: '小禾 好的收到',
  });
  const resolutions: ParticipantResolution[] = [{
    participant_name: '小禾',
    normalized_name: '小禾',
    status: 'same_as',
    contact_id: 102,
    source: 'exact',
  }];
  const contacts: ResolvableContact[] = [{
    id: 102,
    canonical_name: '小禾',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  }];

  assert.deepEqual(proposeCards(extraction, resolutions, contacts), []);
});

test('proposeCards keeps an interaction when a name-prefixed message still carries substantive content', () => {
  const sourceQuotes = ['小禾 明天上午10点开会，大家准时', '收到'];
  const extraction: PerceptionResult = {
    participants: sourceQuotes.map((sourceQuote) => ({
      name: '小禾',
      is_self: false,
      role: 'speaker',
      interaction_summary: '小禾通知了明天的会议安排。',
      confidence: 'high',
      source_quote: sourceQuote,
    })),
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = sourceQuotes.map(() => ({
    participant_name: '小禾',
    normalized_name: '小禾',
    status: 'same_as',
    contact_id: 103,
    source: 'exact',
  }));
  const contacts: ResolvableContact[] = [{
    id: 103,
    canonical_name: '小禾',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  }];
  const interactionCard = proposeCards(extraction, resolutions, contacts)
    .find((card) => card.type === 'record_interaction');

  assert.ok(interactionCard);
});

test('proposeCards strips the prefix up to the last occurrence when the participant name repeats in a fragment', () => {
  const extraction = singleParticipantExtraction({
    name: '小禾',
    role: 'speaker',
    interaction_summary: '小禾已确认收到通知。',
    source_quote: '小禾：@小禾 收到',
  });
  const resolutions: ParticipantResolution[] = [{
    participant_name: '小禾',
    normalized_name: '小禾',
    status: 'same_as',
    contact_id: 104,
    source: 'exact',
  }];
  const contacts: ResolvableContact[] = [{
    id: 104,
    canonical_name: '小禾',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  }];

  assert.deepEqual(proposeCards(extraction, resolutions, contacts), []);
});

test('proposeCards leaves ordinary acknowledgement evidence without a name prefix unaffected', () => {
  const sourceQuotes = ['收到！', '好的'];
  const extraction: PerceptionResult = {
    participants: sourceQuotes.map((sourceQuote) => ({
      name: '小禾',
      is_self: false,
      role: 'speaker',
      interaction_summary: '小禾已确认收到通知。',
      confidence: 'high',
      source_quote: sourceQuote,
    })),
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = sourceQuotes.map(() => ({
    participant_name: '小禾',
    normalized_name: '小禾',
    status: 'same_as',
    contact_id: 105,
    source: 'exact',
  }));
  const contacts: ResolvableContact[] = [{
    id: 105,
    canonical_name: '小禾',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  }];

  assert.deepEqual(proposeCards(extraction, resolutions, contacts), []);
});

test('proposeCards skips generic mentioned contacts in the no-resolution branch but keeps item names', () => {
  const genericNames = [
    '大家',
    '各位',
    '全体',
    '同事们',
    '同学们',
    '各位同事',
    '各位领导',
    '领导们',
    '全体员工',
  ];
  const extraction: PerceptionResult = {
    participants: genericNames.map((name) => ({
      name,
      is_self: false,
      role: 'mentioned',
      title: '副总',
      confidence: 'high',
      source_quote: `通知对象：${name}`,
    })),
    events: [
      {
        kind: 'other',
        title: '准备资料寄送',
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        location: '园区收发室',
        participant_names: genericNames,
        confidence: 'high',
        source_quote: '资料送到园区收发室',
      },
    ],
    facts: [],
    quotes: [],
  };
  const cards = proposeCards(extraction);
  const itemCard = cards.find((card) => card.type === 'create_meeting');

  assert.equal(cards.some((card) => card.type === 'create_contact'), false);
  assert.ok(itemCard);
  assert.deepEqual(itemCard.payload.participants, genericNames.map((name) => ({ name })));
});

test('proposeCards skips an organization-shaped mentioned contact in the resolved create branch', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '党群工作部',
        is_self: false,
        role: 'mentioned',
        company: '某集团 市场部',
        confidence: 'high',
        source_quote: '通知来自党群工作部',
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [{
    participant_name: '党群工作部',
    normalized_name: '党群工作部',
    status: 'new',
    source: 'empty_db',
  }];

  assert.deepEqual(proposeCards(extraction, resolutions), []);
});

test('proposeCards skips a fieldless mentioned name but keeps a mentioned contact with identity fields', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: 'Amy.L',
        is_self: false,
        role: 'mentioned',
        confidence: 'high',
        source_quote: '通知抄送 Amy.L',
      },
      {
        name: '王磊',
        is_self: false,
        role: 'mentioned',
        title: '副总',
        confidence: 'high',
        source_quote: '通知抄送王磊（副总）',
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: 'Amy.L',
      normalized_name: 'amy.l',
      status: 'new',
      source: 'empty_db',
    },
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'new',
      source: 'empty_db',
    },
  ];

  assert.deepEqual(proposeCards(extraction, resolutions), [
    {
      type: 'create_contact',
      payload: {
        name: '王磊',
        title: '副总',
      },
      confidence: 'high',
      source_quote: '通知抄送王磊（副总）',
    },
  ]);
});

test('proposeCards does not apply mentioned-contact filters to speakers or legacy participants', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '大家',
        is_self: false,
        role: 'speaker',
        confidence: 'high',
        source_quote: '大家说明天上午带车牌号过去',
      },
      {
        name: '党群工作部',
        is_self: false,
        confidence: 'high',
        source_quote: '党群工作部通知明天上午开会',
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '大家',
      normalized_name: '大家',
      status: 'new',
      source: 'empty_db',
    },
    {
      participant_name: '党群工作部',
      normalized_name: '党群工作部',
      status: 'new',
      source: 'empty_db',
    },
  ];
  const cards = proposeCards(extraction, resolutions);

  assert.deepEqual(
    cards
      .filter((card) => card.type === 'create_contact')
      .map((card) => card.payload.name),
    ['大家', '党群工作部'],
  );
  assert.deepEqual(
    cards
      .filter((card) => card.type === 'record_interaction')
      .map((card) => card.payload.contact_name),
    ['大家', '党群工作部'],
  );
});

test('proposeCards keeps participant and fact fields for a mentioned new contact without recording an interaction', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        role: 'mentioned',
        company: '某集团 市场部',
        confidence: 'high',
        source_quote: '参会名单：王磊（某集团 市场部）',
      },
    ],
    events: [],
    facts: [
      {
        subject_name: '王磊',
        field: 'title',
        value: '市场负责人',
        confidence: 'high',
        source_quote: '王磊（市场负责人）',
      },
    ],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'new',
      source: 'empty_db',
    },
  ];

  assert.deepEqual(proposeCards(extraction, resolutions), [
    {
      type: 'create_contact',
      payload: {
        name: '王磊',
        company: '某集团 市场部',
        title: '市场负责人',
      },
      confidence: 'high',
      source_quote: '参会名单：王磊（某集团 市场部）\n\n王磊（市场负责人）',
    },
  ]);
});

test('proposeCards keeps a fact-backed same_as update for a mentioned contact without recording an interaction', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        role: 'mentioned',
        confidence: 'high',
        source_quote: '通知抄送：王磊',
      },
    ],
    events: [],
    facts: [
      {
        subject_name: '王磊',
        field: 'title',
        value: '市场负责人',
        confidence: 'high',
        source_quote: '王磊（市场负责人）',
      },
    ],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 8,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 8,
      canonical_name: '王磊',
      aliases: [],
      company: '某集团 市场部',
      title: '市场专员',
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  assert.deepEqual(proposeCards(extraction, resolutions, contacts), [
    {
      type: 'update_contact',
      payload: {
        contact_id: 8,
        contact_name: '王磊',
        changes: {
          title: { old: '市场专员', new: '市场负责人' },
        },
      },
      confidence: 'high',
      source_quote: '通知抄送：王磊\n\n王磊（市场负责人）',
    },
  ]);
});

test('proposeCards treats a legacy participant with no role as a speaker', () => {
  const extraction = singleParticipantExtraction({
    interaction_summary: '王磊确认方案按计划推进。',
    source_quote: '王磊：方案按计划推进',
  });
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 9,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 9,
      canonical_name: '王磊',
      aliases: [],
      company: null,
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];
  const cards = proposeCards(extraction, resolutions, contacts);

  assert.deepEqual(cards.map((card) => card.type), ['record_interaction']);
  assert.equal(
    cards[0]?.type === 'record_interaction' ? cards[0].payload.summary : null,
    '王磊确认方案按计划推进。',
  );
});

const interactionLanguageScenarios = [
  {
    name: 'falls back to Chinese evidence for an English summary',
    participantSourceQuote: '王磊：项目已经推进到评审阶段',
    quoteText: '周五前给你反馈',
    quoteSourceQuote: '王磊说：周五前给你反馈',
    preferredSummary: 'We discussed project progress and next steps.',
    expectedSummary: '王磊：项目已经推进到评审阶段；周五前给你反馈',
  },
  {
    name: 'keeps a Chinese summary for Chinese evidence',
    participantSourceQuote: '王磊：项目已经推进到评审阶段',
    quoteText: '周五前给你反馈',
    quoteSourceQuote: '王磊说：周五前给你反馈',
    preferredSummary: '我们讨论了项目进度，对方会在周五前反馈。',
    expectedSummary: '我们讨论了项目进度，对方会在周五前反馈。',
  },
  {
    name: 'keeps an English summary for English evidence',
    participantSourceQuote: 'The project is ready for review.',
    quoteText: 'I will send feedback by Friday.',
    quoteSourceQuote: 'Wang Lei: I will send feedback by Friday.',
    preferredSummary: 'We discussed project progress and next steps.',
    expectedSummary: 'We discussed project progress and next steps.',
  },
] as const;

for (const scenario of interactionLanguageScenarios) {
  test(`proposeCards ${scenario.name}`, () => {
    const extraction = singleParticipantExtraction({
      role: 'speaker',
      interaction_summary: scenario.preferredSummary,
      source_quote: scenario.participantSourceQuote,
    });
    extraction.quotes = [
      {
        speaker_name: '王磊',
        text: scenario.quoteText,
        source_quote: scenario.quoteSourceQuote,
      },
    ];
    const resolutions: ParticipantResolution[] = [
      {
        participant_name: '王磊',
        normalized_name: '王磊',
        status: 'same_as',
        contact_id: 10,
        source: 'exact',
      },
    ];
    const contacts: ResolvableContact[] = [
      {
        id: 10,
        canonical_name: '王磊',
        aliases: [],
        company: null,
        title: null,
        phone: null,
        wechat_id: null,
        notes: null,
      },
    ];
    const cards = proposeCards(extraction, resolutions, contacts);
    const interactionCard = cards.find((card) => card.type === 'record_interaction');

    assert.ok(interactionCard);
    assert.equal(interactionCard.payload.summary, scenario.expectedSummary);
  });
}

test('proposeCards filters self participants out of cards and keeps self in meeting payload without contact_id', () => {
  const extraction = {
    participants: [
      {
        name: '我',
        is_self: true,
        company: 'Mailuo',
        confidence: 'high',
        source_quote: '我周五有空',
      },
      {
        name: '王磊',
        is_self: false,
        company: '星火科技',
        confidence: 'high',
        source_quote: '王磊周五来找我聊合作',
      },
    ],
    events: [
      {
        kind: 'meeting',
        title: '聊合作',
        time_text: '周五下午三点',
        time_iso: '2026-08-28T15:00:00+08:00',
        has_time_signal: true,
        participant_names: ['我', '王磊'],
        confidence: 'high',
        source_quote: '周五下午三点我和王磊聊合作',
      },
    ],
    facts: [],
    quotes: [],
  } as PerceptionResult;
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '我',
      normalized_name: '我',
      status: 'same_as',
      contact_id: 99,
      source: 'llm',
    },
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 1,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 1,
      canonical_name: '王磊',
      aliases: [],
      company: '星火科技',
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
    {
      id: 99,
      canonical_name: 'Alice',
      aliases: ['我'],
      company: null,
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);

  assert.deepEqual(cards, [
    {
      type: 'create_meeting',
      payload: {
        kind: 'meeting',
        title: '聊合作',
        time_iso: '2026-08-28T15:00:00+08:00',
        time_text: '周五下午三点',
        participants: [{ name: '我' }, { contact_id: 1, name: '王磊' }],
      },
      confidence: 'high',
      source_quote: '周五下午三点我和王磊聊合作',
    },
    {
      type: 'record_interaction',
      payload: {
        contact_id: 1,
        contact_name: '王磊',
        summary: '王磊周五来找我聊合作',
      },
      confidence: 'high',
      source_quote: '王磊周五来找我聊合作',
    },
  ]);
});

test('proposeCards adds unsure participant candidates to an item without linking by default', () => {
  const extraction = {
    participants: [
      {
        name: '荀到',
        is_self: false,
        confidence: 'medium',
        source_quote: '事项由荀到跟进',
      },
    ],
    events: [
      {
        kind: 'other',
        title: '跟进舞台方案',
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        participant_names: ['荀到'],
        confidence: 'medium',
        source_quote: '事项由荀到跟进',
      },
    ],
    facts: [],
    quotes: [],
  } satisfies PerceptionResult;
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '荀到',
      normalized_name: '荀到',
      status: 'unsure',
      candidate_ids: [-1],
      source: 'near_match',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: -1,
      canonical_name: '荀导',
      aliases: [],
      company: null,
      title: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const item = cards.find((card) => card.type === 'create_meeting');

  assert.equal(item?.type, 'create_meeting');
  if (item?.type !== 'create_meeting') {
    throw new Error('expected a create_meeting card');
  }
  assert.equal(item.payload.participants[0]?.contact_id, undefined);
  assert.deepEqual(item.payload.participants, [
    {
      name: '荀到',
      candidates: [
        { contact_id: -1, name: '荀导', company: null },
      ],
    },
  ]);

  const reorderedExtraction = {
    ...extraction,
    participants: [
      extraction.participants[0],
      {
        ...extraction.participants[0],
        source_quote: '荀到继续负责舞台方案',
      },
    ],
  } satisfies PerceptionResult;
  const reorderedCards = proposeCards(
    reorderedExtraction,
    [
      {
        participant_name: '荀到',
        normalized_name: '荀到',
        status: 'unsure',
        candidate_ids: [-1, 8],
        source: 'near_match',
      },
      {
        participant_name: '荀到',
        normalized_name: '荀到',
        status: 'unsure',
        candidate_ids: [8, -1],
        source: 'near_match',
      },
    ],
    [
      ...contacts,
      {
        id: 8,
        canonical_name: '荀老师',
        aliases: [],
        company: '某剧院',
        title: null,
      },
    ],
  );
  const reorderedItem = reorderedCards.find((card) => card.type === 'create_meeting');

  assert.equal(reorderedItem?.type, 'create_meeting');
  if (reorderedItem?.type !== 'create_meeting') {
    throw new Error('expected a create_meeting card for reordered candidates');
  }
  assert.deepEqual(reorderedItem.payload.participants[0]?.candidates, [
    { contact_id: -1, name: '荀导', company: null },
    { contact_id: 8, name: '荀老师', company: '某剧院' },
  ]);
});

test('proposeCards keeps duplicated structured facts out of notes updates for same_as contacts', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '陈昕',
        is_self: false,
        company: '翎点科技',
        confidence: 'high',
        source_quote: '我刚跳槽去了翎点科技',
      },
    ],
    events: [],
    facts: [
      {
        subject_name: '陈昕',
        field: 'other',
        value: '我刚跳槽去了翎点科技',
        confidence: 'medium',
        source_quote: '我刚跳槽去了翎点科技',
      },
      {
        subject_name: '陈昕',
        field: 'notes',
        value: '我刚跳槽去了翎点科技',
        confidence: 'medium',
        source_quote: '我刚跳槽去了翎点科技',
      },
      {
        subject_name: '陈昕',
        field: 'notes',
        value: '现在负责华东区渠道',
        confidence: 'medium',
        source_quote: '我刚跳槽去了翎点科技',
      },
    ],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '陈昕',
      normalized_name: '陈昕',
      status: 'same_as',
      contact_id: 7,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 7,
      canonical_name: '陈昕',
      aliases: [],
      company: '云沐内容',
      title: null,
      phone: null,
      wechat_id: null,
      notes: '老同事',
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const updateCard = cards.find((card) => card.type === 'update_contact');

  assert.ok(updateCard);
  assert.deepEqual(updateCard.payload, {
    contact_id: 7,
    contact_name: '陈昕',
    changes: {
      company: { old: '云沐内容', new: '翎点科技' },
      notes: { old: '老同事', new: '现在负责华东区渠道' },
    },
  });
});

test('proposeCards splits mixed participant notes and keeps only freeform tail for same_as contacts', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '陈昕',
        is_self: false,
        company: '翎点科技',
        notes: '跳槽去了翎点科技，现在负责华东区渠道',
        confidence: 'high',
        source_quote: '跳槽去了翎点科技，现在负责华东区渠道',
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '陈昕',
      normalized_name: '陈昕',
      status: 'same_as',
      contact_id: 7,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 7,
      canonical_name: '陈昕',
      aliases: [],
      company: '云沐内容',
      title: null,
      phone: null,
      wechat_id: null,
      notes: '老同事',
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const updateCard = cards.find((card) => card.type === 'update_contact');

  assert.ok(updateCard);
  assert.deepEqual(updateCard.payload, {
    contact_id: 7,
    contact_name: '陈昕',
    changes: {
      company: { old: '云沐内容', new: '翎点科技' },
      notes: { old: '老同事', new: '现在负责华东区渠道' },
    },
  });
  assert.doesNotMatch(updateCard.payload.changes.notes?.new ?? '', /翎点科技/);
});

test('proposeCards keeps deterministic freeform tail from unpunctuated mixed participant notes', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '陈昕',
        is_self: false,
        company: '翎点科技',
        notes: '翎点科技市场负责人',
        confidence: 'high',
        source_quote: '翎点科技市场负责人',
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '陈昕',
      normalized_name: '陈昕',
      status: 'same_as',
      contact_id: 7,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 7,
      canonical_name: '陈昕',
      aliases: [],
      company: '云沐内容',
      title: null,
      phone: null,
      wechat_id: null,
      notes: '老同事',
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const updateCard = cards.find((card) => card.type === 'update_contact');

  assert.ok(updateCard);
  assert.deepEqual(updateCard.payload, {
    contact_id: 7,
    contact_name: '陈昕',
    changes: {
      company: { old: '云沐内容', new: '翎点科技' },
      notes: { old: '老同事', new: '市场负责人' },
    },
  });
  assert.doesNotMatch(updateCard.payload.changes.notes?.new ?? '', /翎点科技/);
});

test('proposeCards creates no-time-signal meetings without folding event evidence into interactions', () => {
  const extraction = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        confidence: 'high',
        source_quote: '王磊说后面继续聊',
      },
    ],
    events: [
      {
        kind: 'meeting',
        title: '细聊合作',
        time_text: '等你方便',
        time_iso: null,
        has_time_signal: false,
        participant_names: ['王磊'],
        confidence: 'medium',
        source_quote: '等你方便了我们再约个时间细聊',
      },
    ],
    facts: [],
    quotes: [],
  } as PerceptionResult;
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 3,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 3,
      canonical_name: '王磊',
      aliases: [],
      company: null,
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const meetingCard = cards.find((card) => card.type === 'create_meeting');
  const interactionCard = cards.find((card) => card.type === 'record_interaction');

  assert.ok(meetingCard);
  assert.equal(meetingCard.payload.kind, 'meeting');
  assert.equal(meetingCard.payload.time_iso, null);
  assert.ok(interactionCard);
  assert.equal(interactionCard.payload.summary, '王磊说后面继续聊');
  assert.equal(interactionCard.source_quote, '王磊说后面继续聊');
  assert.doesNotMatch(interactionCard.source_quote, /等你方便了我们再约个时间细聊/u);
});

test('proposeCards normalizes blank time_iso and still creates a standalone meeting', () => {
  const extraction = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        confidence: 'high',
        source_quote: '王磊说我们改天再细聊',
      },
    ],
    events: [
      {
        kind: 'meeting',
        title: '细聊合作',
        time_text: '改天再约',
        time_iso: '   ',
        has_time_signal: false,
        participant_names: ['王磊'],
        confidence: 'medium',
        source_quote: '改天再约个时间细聊合作',
      },
    ],
    facts: [],
    quotes: [],
  } as PerceptionResult;
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 3,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 3,
      canonical_name: '王磊',
      aliases: [],
      company: null,
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const meetingCard = cards.find((card) => card.type === 'create_meeting');
  const interactionCard = cards.find((card) => card.type === 'record_interaction');

  assert.ok(meetingCard);
  assert.equal(meetingCard.payload.kind, 'meeting');
  assert.equal(meetingCard.payload.time_iso, null);
  assert.ok(interactionCard);
  assert.equal(interactionCard.payload.summary, '王磊说我们改天再细聊');
  assert.equal(interactionCard.source_quote, '王磊说我们改天再细聊');
});

test('proposeCards creates other events without duplicating them in the interaction card', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        confidence: 'high',
        source_quote: '今天继续推进方案',
      },
    ],
    events: [
      {
        kind: 'other',
        title: '发方案给你',
        time_text: '明天下午三点',
        time_iso: '2026-08-27T15:00:00+08:00',
        has_time_signal: true,
        participant_names: ['王磊'],
        confidence: 'medium',
        source_quote: '明天下午三点把方案发你',
      },
    ],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 8,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 8,
      canonical_name: '王磊',
      aliases: [],
      company: null,
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);
  const itemCard = cards.find((card) => card.type === 'create_meeting');
  const interactionCard = cards.find((card) => card.type === 'record_interaction');

  assert.ok(itemCard);
  assert.equal(itemCard.payload.kind, 'other');
  assert.equal(itemCard.payload.time_iso, '2026-08-27T15:00:00+08:00');
  assert.ok(interactionCard);
  assert.equal(interactionCard.payload.summary, '今天继续推进方案');
  assert.equal(interactionCard.source_quote, '今天继续推进方案');
  assert.doesNotMatch(interactionCard.source_quote, /明天下午三点把方案发你/u);
});

test('proposeCards creates a standalone no-time item with no participants and no interaction', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [
      {
        kind: 'other',
        title: '准备报名材料',
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        participant_names: [],
        confidence: 'medium',
        source_quote: '报名要带身份证复印件和两张照片',
      },
    ],
    facts: [],
    quotes: [],
  };

  assert.deepEqual(proposeCards(extraction, [], []), [
    {
      type: 'create_meeting',
      payload: {
        kind: 'other',
        title: '准备报名材料',
        time_iso: null,
        time_text: '',
        participants: [],
      },
      confidence: 'medium',
      source_quote: '报名要带身份证复印件和两张照片',
    },
  ]);
});

test('proposeCards preserves appointment kind and its existing scheduled-card behavior', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [
      {
        kind: 'appointment',
        title: '去医院复诊',
        time_text: '9月8日上午九点',
        time_iso: '2026-09-08T09:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'high',
        source_quote: '9月8日上午九点去医院复诊',
      },
    ],
    facts: [],
    quotes: [],
  };

  const cards = proposeCards(extraction, [], []);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, 'create_meeting');
  assert.equal(cards[0]?.type === 'create_meeting' ? cards[0].payload.kind : null, 'appointment');
});

test('proposeCards skips no-op updates and dedupes interactions by resolved contact', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '李姐',
        is_self: false,
        company: '甲公司',
        confidence: 'medium',
        source_quote: '李姐，我们继续跟进那个合作',
      },
      {
        name: '李姐',
        is_self: false,
        confidence: 'high',
        source_quote: '李姐说下周再对一下细节',
      },
    ],
    events: [],
    facts: [
      {
        subject_name: '路人甲',
        field: 'other',
        value: '不应该生成互动卡',
        confidence: 'low',
        source_quote: '路人甲旁听',
      },
    ],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '李姐',
      normalized_name: '李姐',
      status: 'same_as',
      contact_id: 2,
      source: 'exact',
    },
    {
      participant_name: '李姐',
      normalized_name: '李姐',
      status: 'same_as',
      contact_id: 2,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 2,
      canonical_name: '李姐',
      aliases: ['鲍总'],
      company: '甲公司',
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);

  assert.deepEqual(cards, [
    {
      type: 'record_interaction',
      payload: {
        contact_id: 2,
        contact_name: '李姐',
        summary: '李姐，我们继续跟进那个合作；李姐说下周再对一下细节',
      },
      confidence: 'high',
      source_quote: '李姐，我们继续跟进那个合作\n\n李姐说下周再对一下细节',
    },
  ]);
});

test('proposeCards suppresses all four redundant company/title value shapes', () => {
  const resolution: ParticipantResolution = {
    participant_name: '王磊',
    normalized_name: '王磊',
    status: 'same_as',
    contact_id: 20,
    source: 'exact',
  };
  const baseContact: ResolvableContact = {
    id: 20,
    canonical_name: '王磊',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  };
  const cases = [
    {
      label: 'normalizes punctuation and whitespace',
      contact: { ...baseContact, company: '某集团市场部' },
      participant: { company: '某集团 市场部' },
    },
    {
      label: 'suppresses a truncated value contained by the current value',
      contact: { ...baseContact, company: '某集团市场部' },
      participant: { company: '市场部' },
    },
    {
      label: 'suppresses a reordering made only from current tokens',
      contact: { ...baseContact, company: '某集团 市场部' },
      participant: { company: '市场部 某集团' },
    },
    {
      label: 'suppresses a one-character title OCR substitution',
      contact: { ...baseContact, title: '市场总监' },
      participant: { title: '市场总坚' },
    },
  ];

  for (const testCase of cases) {
    const cards = proposeCards(
      singleParticipantExtraction(testCase.participant),
      [resolution],
      [testCase.contact],
    );

    assert.equal(
      cards.some((card) => card.type === 'update_contact'),
      false,
      testCase.label,
    );
  }
});

test('proposeCards keeps longer, more specific company completions as updates', () => {
  const resolution: ParticipantResolution = {
    participant_name: '王磊',
    normalized_name: '王磊',
    status: 'same_as',
    contact_id: 21,
    source: 'exact',
  };
  const contact: ResolvableContact = {
    id: 21,
    canonical_name: '王磊',
    aliases: [],
    company: '某集团市场部',
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  };

  for (const nextCompany of ['某集团市场部组', '某集团市场部品牌组']) {
    const cards = proposeCards(
      singleParticipantExtraction({ company: nextCompany }),
      [resolution],
      [contact],
    );
    const updateCard = cards.find((card) => card.type === 'update_contact');

    assert.equal(updateCard?.type, 'update_contact', nextCompany);
    if (updateCard?.type !== 'update_contact') {
      throw new Error(`expected update_contact for ${nextCompany}`);
    }
    assert.deepEqual(updateCard.payload.changes.company, {
      old: '某集团市场部',
      new: nextCompany,
    });
  }
});

test('proposeCards keeps phone, wechat_id, and notes comparisons exact after trimming', () => {
  const resolution: ParticipantResolution = {
    participant_name: '王磊',
    normalized_name: '王磊',
    status: 'same_as',
    contact_id: 22,
    source: 'exact',
  };
  const baseContact: ResolvableContact = {
    id: 22,
    canonical_name: '王磊',
    aliases: [],
    company: null,
    title: null,
    phone: null,
    wechat_id: null,
    notes: null,
  };
  const trimmedPhoneCards = proposeCards(
    singleParticipantExtraction({ phone: '13800001234' }),
    [resolution],
    [{ ...baseContact, phone: ' 13800001234 ' }],
  );

  assert.equal(
    trimmedPhoneCards.some((card) => card.type === 'update_contact'),
    false,
  );

  const cases: Array<{
    field: 'phone' | 'wechat_id' | 'notes';
    current: string;
    next: string;
  }> = [
    { field: 'phone', current: '13800001234', next: '13800001235' },
    { field: 'wechat_id', current: 'AliceWX', next: 'aliceWX' },
    { field: 'notes', current: '重点客户', next: '重点客戶' },
  ];

  for (const testCase of cases) {
    const cards = proposeCards(
      singleParticipantExtraction({ [testCase.field]: testCase.next }),
      [resolution],
      [{ ...baseContact, [testCase.field]: testCase.current }],
    );
    const updateCard = cards.find((card) => card.type === 'update_contact');

    assert.equal(updateCard?.type, 'update_contact', testCase.field);
    if (updateCard?.type !== 'update_contact') {
      throw new Error(`expected update_contact for ${testCase.field}`);
    }
    assert.deepEqual(updateCard.payload.changes[testCase.field], {
      old: testCase.current,
      new: testCase.next,
    });
  }
});

test('proposeCards filters derived aliases on create while preserving a one-character honorific', () => {
  const cards = proposeCards(singleParticipantExtraction({
    aliases: [
      '王磊',
      '王磊集团副总',
      '集团副总王磊',
      '某集团集团副总',
      '王总',
    ],
    company: '某集团',
    title: '集团副总',
    source_quote: '王磊是某集团集团副总，大家也叫他王总',
  }));

  assert.deepEqual(cards, [
    {
      type: 'create_contact',
      payload: {
        name: '王磊',
        aliases: ['王总'],
        company: '某集团',
        title: '集团副总',
      },
      confidence: 'high',
      source_quote: '王磊是某集团集团副总，大家也叫他王总',
    },
  ]);
});

test('proposeCards filters OCR-derived aliases against proposed and library fields', () => {
  const resolution: ParticipantResolution = {
    participant_name: '王磊',
    normalized_name: '王磊',
    status: 'new',
    source: 'llm',
  };
  const contacts: ResolvableContact[] = [
    {
      id: 24,
      canonical_name: '李梅',
      aliases: [],
      company: null,
      title: '集团副总',
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];
  const cases = [
    { alias: '某集团市扬部 王磊', expectedAliases: undefined },
    { alias: '部 王磊', expectedAliases: undefined },
    { alias: '集团副总王磊', expectedAliases: undefined },
    { alias: '某集团市场部 王磊', expectedAliases: undefined },
    { alias: '王总', expectedAliases: ['王总'] },
    { alias: 'Amy王磊', expectedAliases: ['Amy王磊'] },
  ];

  for (const testCase of cases) {
    const cards = proposeCards(
      singleParticipantExtraction({
        aliases: [testCase.alias],
        company: '某集团市场部',
      }),
      [resolution],
      contacts,
    );
    const createCard = cards.find((card) => card.type === 'create_contact');

    assert.equal(createCard?.type, 'create_contact', testCase.alias);
    if (createCard?.type !== 'create_contact') {
      throw new Error(`expected create_contact for ${testCase.alias}`);
    }
    assert.deepEqual(createCard.payload.aliases, testCase.expectedAliases, testCase.alias);
  }

  const honorificCards = proposeCards(
    singleParticipantExtraction({ aliases: ['王总'] }),
    [resolution],
    [{ ...contacts[0], company: '王总', title: null }],
  );
  const honorificCreateCard = honorificCards.find((card) => card.type === 'create_contact');

  assert.equal(honorificCreateCard?.type, 'create_contact');
  if (honorificCreateCard?.type !== 'create_contact') {
    throw new Error('expected create_contact for 王总');
  }
  assert.deepEqual(honorificCreateCard.payload.aliases, ['王总']);

  const shortRemainderCards = proposeCards(
    singleParticipantExtraction({ aliases: ['副总王磊'] }),
    [resolution],
    [{ ...contacts[0], title: '总' }],
  );
  const shortRemainderCreateCard = shortRemainderCards.find(
    (card) => card.type === 'create_contact',
  );

  assert.equal(shortRemainderCreateCard?.type, 'create_contact');
  if (shortRemainderCreateCard?.type !== 'create_contact') {
    throw new Error('expected create_contact for 副总王磊');
  }
  assert.equal(shortRemainderCreateCard.payload.aliases, undefined);
});

test('proposeCards filters derived aliases on update while preserving 王总', () => {
  const extraction = singleParticipantExtraction({
    aliases: [
      '王磊集团副总',
      '集团副总王磊',
      '某集团集团副总',
      '王总',
    ],
    company: '某集团',
    title: '集团副总',
    source_quote: '王磊是某集团集团副总，大家也叫他王总',
  });
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 23,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 23,
      canonical_name: '王磊',
      aliases: [],
      company: '某集团',
      title: '集团副总',
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];
  const cards = proposeCards(extraction, resolutions, contacts);
  const updateCard = cards.find((card) => card.type === 'update_contact');

  assert.equal(updateCard?.type, 'update_contact');
  if (updateCard?.type !== 'update_contact') {
    throw new Error('expected an alias update');
  }
  assert.deepEqual(updateCard.payload.changes, {
    aliases: { old: null, new: '王总' },
  });

  const historicalShortAliasCards = proposeCards(
    singleParticipantExtraction({ aliases: ['王总'] }),
    resolutions,
    [
      { ...contacts[0], aliases: ['王'], company: null, title: null },
      {
        id: 24,
        canonical_name: '李梅',
        aliases: [],
        company: '王总',
        title: null,
        phone: null,
        wechat_id: null,
        notes: null,
      },
    ],
  );
  const historicalShortAliasCard = historicalShortAliasCards.find(
    (card) => card.type === 'update_contact',
  );

  assert.equal(historicalShortAliasCard?.type, 'update_contact');
  if (historicalShortAliasCard?.type !== 'update_contact') {
    throw new Error('expected 王总 to survive an unrelated historical short alias');
  }
  assert.deepEqual(historicalShortAliasCard.payload.changes.aliases, {
    old: '王',
    new: '王总',
  });
});

test('proposeCards keeps interaction source_quote aligned with every summary anchor, including quote source anchors', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        company: '星火科技',
        confidence: 'high',
        source_quote: '今天和王磊继续推进合作',
      },
    ],
    events: [],
    facts: [],
    quotes: [
      {
        speaker_name: '王磊',
        text: '周五前把方案发你',
        source_quote: '王磊说：周五前把方案发你',
      },
    ],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'same_as',
      contact_id: 5,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 5,
      canonical_name: '王磊',
      aliases: [],
      company: null,
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);

  assert.deepEqual(cards, [
    {
      type: 'update_contact',
      payload: {
        contact_id: 5,
        contact_name: '王磊',
        changes: {
          company: { old: null, new: '星火科技' },
        },
      },
      confidence: 'high',
      source_quote: '今天和王磊继续推进合作',
    },
    {
      type: 'record_interaction',
      payload: {
        contact_id: 5,
        contact_name: '王磊',
        summary: '今天和王磊继续推进合作；周五前把方案发你',
      },
      confidence: 'high',
      source_quote: '今天和王磊继续推进合作\n\n王磊说：周五前把方案发你',
    },
  ]);
});

test('proposeCards creates create_contact cards for new and unsure participants and links pending interactions by name', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        is_self: false,
        company: '星火科技',
        title: '市场总监',
        confidence: 'high',
        source_quote: '我是星火科技的市场总监王磊',
      },
      {
        name: '李姐',
        is_self: false,
        aliases: ['鲍总'],
        confidence: 'medium',
        source_quote: '李姐，下周找时间见面',
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王磊',
      normalized_name: '王磊',
      status: 'new',
      source: 'empty_db',
    },
    {
      participant_name: '李姐',
      normalized_name: '李姐',
      status: 'unsure',
      candidate_ids: [3, 4],
      source: 'llm',
    },
  ];
  const contacts: ResolvableContact[] = [
    { id: 3, canonical_name: '李洁', aliases: ['LJ'], company: '甲公司' },
    { id: 4, canonical_name: '李婕', aliases: ['鲍总'], company: '乙公司' },
  ];

  const cards = proposeCards(extraction, resolutions, contacts);

  assert.deepEqual(cards, [
    {
      type: 'create_contact',
      payload: {
        name: '王磊',
        company: '星火科技',
        title: '市场总监',
      },
      confidence: 'high',
      source_quote: '我是星火科技的市场总监王磊',
    },
    {
      type: 'create_contact',
      payload: {
        name: '李姐',
        aliases: ['鲍总'],
      },
      confidence: 'medium',
      source_quote: '李姐，下周找时间见面',
      disambiguation: {
        candidates: [
          { contact_id: 3, name: '李洁', company: '甲公司' },
          { contact_id: 4, name: '李婕', company: '乙公司' },
        ],
      },
    },
    {
      type: 'record_interaction',
      payload: {
        contact_name: '王磊',
        summary: '我是星火科技的市场总监王磊',
      },
      confidence: 'high',
      source_quote: '我是星火科技的市场总监王磊',
    },
    {
      type: 'record_interaction',
      payload: {
        contact_name: '李姐',
        summary: '李姐，下周找时间见面',
      },
      confidence: 'medium',
      source_quote: '李姐，下周找时间见面',
    },
  ]);
});

const storedProjectMeeting: ExistingMeeting = {
  id: 61,
  kind: 'meeting',
  title: '星桥项目阶段评审会',
  time_iso: '2026-09-08T09:30:00+08:00',
  time_text: '9月8日上午9:30',
  location: '第三会议室',
  participants: [{ contact_id: 18, name: '骆澄' }],
  agenda: '评审阶段成果',
};

function eventOnlyExtraction(
  events: PerceptionResult['events'],
): PerceptionResult {
  return {
    participants: [],
    events,
    facts: [],
    quotes: [],
  };
}

test('proposeCards turns a stored-meeting time notice into a standard agenda-append card', () => {
  const noticeSource = '通知：星桥项目阶段评审会改到下午三点';
  const { cards, noticeRouting } = proposeCardsWithRouting(
    eventOnlyExtraction([
      {
        kind: 'other',
        title: '通知星桥项目参会人时间变更',
        time_text: '9月8日下午3点',
        time_iso: '2026-09-08T15:00:00+08:00',
        has_time_signal: true,
        participant_names: ['骆澄'],
        confidence: 'high',
        source_quote: noticeSource,
      },
    ]),
    [],
    [],
    proposalNow,
    [storedProjectMeeting],
    [{
      meeting_id: storedProjectMeeting.id,
      fragments: [{
        content: '参会时间已确认',
        source_quote: noticeSource,
      }],
    }],
  );

  assert.deepEqual(cards, [
    {
      type: 'create_meeting',
      payload: {
        kind: 'meeting',
        title: storedProjectMeeting.title,
        time_iso: storedProjectMeeting.time_iso,
        time_text: storedProjectMeeting.time_text,
        location: storedProjectMeeting.location,
        participants: storedProjectMeeting.participants,
        agenda: `评审阶段成果；${noticeSource}`,
        agenda_append: noticeSource,
        duplicate_of_meeting_id: storedProjectMeeting.id,
        changes: {
          agenda: {
            old: '评审阶段成果',
            new: `评审阶段成果；${noticeSource}`,
          },
        },
      },
      confidence: 'high',
      source_quote: noticeSource,
    },
  ]);
  assert.deepEqual(noticeRouting, [{
    title: '通知星桥项目参会人时间变更',
    decision: 'stored',
    target_title: storedProjectMeeting.title,
  }]);
});

test('proposeCards matches a stored meeting by participants and an absolute date without a clock time', () => {
  const noticeSource = '提醒：9月8日评审时间另行告知';
  const cards = proposeCards(
    eventOnlyExtraction([{
      kind: 'other',
      title: '项目评审日期提醒',
      time_text: '9月8日，具体时间另行告知',
      time_iso: null,
      has_time_signal: true,
      participant_names: ['骆澄'],
      confidence: 'high',
      source_quote: noticeSource,
    }]),
    [],
    [],
    proposalNow,
    [storedProjectMeeting],
  );

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, 'create_meeting');
  if (cards[0]?.type !== 'create_meeting') {
    throw new Error('expected one stored-meeting agenda append card');
  }
  assert.equal(cards[0].payload.duplicate_of_meeting_id, storedProjectMeeting.id);
  assert.equal(cards[0].payload.agenda_append, noticeSource);
});

test('proposeCards matches a stored self participant when the notice keeps the configured nickname', () => {
  const noticeSource = '通知：会议时间调整为9月8日下午三点';
  const extraction = eventOnlyExtraction([{
    kind: 'other',
    title: '临时排期通知',
    time_text: '9月8日下午3点',
    time_iso: '2026-09-08T15:00:00+08:00',
    has_time_signal: true,
    participant_names: ['禾老师'],
    confidence: 'high',
    source_quote: noticeSource,
  }]);
  extraction.participants = [{
    name: '禾老师',
    is_self: true,
    role: 'speaker',
    speech_act: 'respond',
    confidence: 'high',
    source_quote: '收到时间调整',
  }];
  const storedSelfMeeting: ExistingMeeting = {
    ...storedProjectMeeting,
    id: 62,
    title: '秋季产品评审会',
    participants: [{ name: '我' }],
  };

  const cards = proposeCards(
    extraction,
    [],
    [],
    proposalNow,
    [storedSelfMeeting],
  );

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, 'create_meeting');
  if (cards[0]?.type !== 'create_meeting') {
    throw new Error('expected a self-matched stored-meeting agenda append card');
  }
  assert.equal(cards[0].payload.duplicate_of_meeting_id, storedSelfMeeting.id);
  assert.equal(cards[0].payload.agenda_append, noticeSource);
});

test('date-only meeting notice matching keeps the current year and honors an explicit year', () => {
  const cases = [
    {
      timeText: '8月12日，具体时间另行告知',
      meetingTimeIso: '2026-08-12T09:30:00+08:00',
    },
    {
      timeText: '2025年9月8日，具体时间另行告知',
      meetingTimeIso: '2025-09-08T09:30:00+08:00',
    },
  ] as const;

  for (const [index, fixture] of cases.entries()) {
    const existingMeeting = {
      ...storedProjectMeeting,
      id: 70 + index,
      time_iso: fixture.meetingTimeIso,
      time_text: fixture.timeText,
    };
    const sourceQuote = `提醒：${fixture.timeText}召开评审会`;
    const cards = proposeCards(
      eventOnlyExtraction([{
        kind: 'other',
        title: '项目评审日期提醒',
        time_text: fixture.timeText,
        time_iso: null,
        has_time_signal: true,
        participant_names: ['骆澄'],
        confidence: 'high',
        source_quote: sourceQuote,
      }]),
      [],
      [],
      proposalNow,
      [existingMeeting],
    );

    assert.equal(cards.length, 1);
    assert.equal(
      cards[0]?.type === 'create_meeting'
        ? cards[0].payload.duplicate_of_meeting_id
        : null,
      existingMeeting.id,
    );
  }
});

test('proposeCards merges a time notice into the agenda of its same-batch new meeting', () => {
  const noticeSource = '提醒：第三季度项目推进协调会改为线上举行';
  const { cards, noticeRouting } = proposeCardsWithRouting(
    eventOnlyExtraction([
      {
        kind: 'other',
        title: '第三季度项目推进协同会',
        time_text: '',
        time_iso: '2026-09-10T10:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        confidence: 'high',
        source_quote: noticeSource,
      },
      {
        kind: 'meeting',
        title: '第三季度项目推进协调会',
        time_text: '9月10日上午10点',
        time_iso: '2026-09-10T10:00:00+08:00',
        has_time_signal: true,
        participant_names: [],
        agenda: '复盘里程碑',
        confidence: 'high',
        source_quote: '第三季度项目推进协调会定于9月10日上午10点召开',
      },
    ]),
    [],
    [],
  );

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, 'create_meeting');
  if (cards[0]?.type !== 'create_meeting') {
    throw new Error('expected one same-batch meeting card');
  }
  assert.equal(cards[0].payload.agenda, `复盘里程碑；${noticeSource}`);
  assert.equal(cards[0].payload.agenda_append, undefined);
  assert.equal(cards[0].payload.duplicate_of_meeting_id, undefined);
  assert.equal(
    cards[0].source_quote,
    `第三季度项目推进协调会定于9月10日上午10点召开\n\n${noticeSource}`,
  );
  assert.deepEqual(noticeRouting, [{
    title: '第三季度项目推进协同会',
    decision: 'batch',
    target_title: '第三季度项目推进协调会',
  }]);
});

test('proposeCards merges a timeless notice into one same-screenshot meeting by participant overlap', () => {
  const noticeTitle = '通知海棠塔和邬导会议时间变更';
  const noticeSource = '你们通知海棠塔和邬导这个时间。';
  const meetingTitle = '海棠剧场舞台项目碰头会';
  const { cards, noticeRouting } = proposeCardsWithRouting(
    eventOnlyExtraction([
      {
        kind: 'meeting',
        title: meetingTitle,
        time_text: '明天下午',
        time_iso: null,
        has_time_signal: true,
        participant_names: ['小禾', '邬导', '海棠塔'],
        agenda: '确认舞台方案',
        confidence: 'high',
        source_quote: '明天下午开海棠剧场舞台项目碰头会。',
      },
      {
        kind: 'other',
        title: noticeTitle,
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        participant_names: ['邬导', '海棠塔'],
        confidence: 'high',
        source_quote: noticeSource,
      },
    ]),
    [],
    [],
  );

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, 'create_meeting');
  if (cards[0]?.type !== 'create_meeting') {
    throw new Error('expected one same-screenshot meeting card');
  }
  assert.equal(cards[0].payload.agenda, `确认舞台方案；${noticeSource}`);
  assert.equal(cards[0].payload.agenda_append, undefined);
  assert.deepEqual(noticeRouting, [{
    title: noticeTitle,
    decision: 'batch',
    target_title: meetingTitle,
  }]);
});

test('proposeCards drops a timeless same-screenshot notice without participant overlap', () => {
  const meetingTitle = '梧桐展厅布展碰头会';
  const noticeTitle = '通知邬导会议时间变更';
  const { cards, noticeRouting } = proposeCardsWithRouting(
    eventOnlyExtraction([
      {
        kind: 'meeting',
        title: meetingTitle,
        time_text: '明天下午',
        time_iso: null,
        has_time_signal: true,
        participant_names: ['小谷'],
        confidence: 'high',
        source_quote: '明天下午开梧桐展厅布展碰头会。',
      },
      {
        kind: 'other',
        title: noticeTitle,
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        participant_names: ['邬导'],
        confidence: 'high',
        source_quote: '请通知邬导这个时间。',
      },
    ]),
    [],
    [],
  );

  assert.deepEqual(
    cards.map((card) => card.type === 'create_meeting' ? card.payload.title : null),
    [meetingTitle],
  );
  assert.deepEqual(noticeRouting, [{
    title: noticeTitle,
    decision: 'dropped',
  }]);
});

test('proposeCards keeps the same-day gate for a timeless notice against a stored meeting', () => {
  const noticeTitle = '通知邬导会议时间变更';
  const { cards, noticeRouting } = proposeCardsWithRouting(
    eventOnlyExtraction([{
      kind: 'other',
      title: noticeTitle,
      time_text: '',
      time_iso: null,
      has_time_signal: false,
      participant_names: ['邬导'],
      confidence: 'high',
      source_quote: '请通知邬导这个时间。',
    }]),
    [],
    [],
    proposalNow,
    [{
      ...storedProjectMeeting,
      title: '梧桐展厅布展碰头会',
      participants: [{ name: '邬导' }],
    }],
  );

  assert.deepEqual(cards, []);
  assert.deepEqual(noticeRouting, [{
    title: noticeTitle,
    decision: 'dropped',
  }]);
});

test('proposeCards drops a timeless notice when two same-screenshot meetings overlap participants', () => {
  const noticeTitle = '通知邬导会议时间变更';
  const meetingTitles = ['梧桐展厅布展碰头会', '海棠剧场设备协调会'];
  const { cards, noticeRouting } = proposeCardsWithRouting(
    eventOnlyExtraction([
      ...meetingTitles.map((title) => ({
        kind: 'meeting' as const,
        title,
        time_text: '明天下午',
        time_iso: null,
        has_time_signal: true,
        participant_names: ['邬导'],
        confidence: 'high' as const,
        source_quote: `明天下午召开${title}。`,
      })),
      {
        kind: 'other',
        title: noticeTitle,
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        participant_names: ['邬导'],
        confidence: 'high',
        source_quote: '请通知邬导这个时间。',
      },
    ]),
    [],
    [],
  );

  assert.deepEqual(
    cards.map((card) => card.type === 'create_meeting' ? card.payload.title : null),
    meetingTitles,
  );
  assert.deepEqual(noticeRouting, [{
    title: noticeTitle,
    decision: 'dropped',
  }]);
});

test('proposeCards drops a meeting-time notice when no meeting can be identified', () => {
  const noticeSource = '告知：会议时间有调整，请留意后续消息';
  const cards = proposeCards(
    eventOnlyExtraction([
      {
        kind: 'other',
        title: '临时排期通知',
        time_text: '明天下午',
        time_iso: null,
        has_time_signal: true,
        participant_names: ['周岚'],
        confidence: 'medium',
        source_quote: noticeSource,
      },
    ]),
    [],
    [],
    proposalNow,
    [storedProjectMeeting],
    [{
      meeting_id: storedProjectMeeting.id,
      fragments: [{ content: '会议时间已调整', source_quote: noticeSource }],
    }],
  );

  assert.deepEqual(cards, []);
});

test('proposeCards preserves unrelated progress when dropping an unmatched special event', () => {
  const noticeSource = '告知：会议时间有调整，请留意后续消息';
  const unrelatedSource = '骆澄：评审材料已发送';
  const cards = proposeCards(
    eventOnlyExtraction([{
      kind: 'other',
      title: '临时排期通知',
      time_text: '明天下午',
      time_iso: null,
      has_time_signal: true,
      participant_names: ['周岚'],
      confidence: 'medium',
      source_quote: noticeSource,
    }]),
    [],
    [],
    proposalNow,
    [storedProjectMeeting],
    [{
      meeting_id: storedProjectMeeting.id,
      fragments: [
        { content: '会议时间已调整', source_quote: noticeSource },
        { content: '评审材料已发送', source_quote: unrelatedSource },
      ],
    }],
  );

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.type, 'create_meeting');
  if (cards[0]?.type !== 'create_meeting') {
    throw new Error('expected one retained unrelated progress card');
  }
  assert.equal(cards[0].payload.agenda_append, '评审材料已发送');
  assert.equal(cards[0].source_quote, unrelatedSource);
});

test('proposeCards drops timeless communication actions but keeps ones with time or location', () => {
  const timelessSource = '已确认';
  const { cards, noticeRouting } = proposeCardsWithRouting(
    eventOnlyExtraction([
      {
        kind: 'other',
        title: '星桥项目参会人员确认',
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        participant_names: ['骆澄'],
        confidence: 'high',
        source_quote: timelessSource,
      },
      {
        kind: 'other',
        title: '准备车辆及工作餐安排',
        time_text: '明天上午',
        time_iso: null,
        has_time_signal: true,
        participant_names: [],
        confidence: 'high',
        source_quote: '明天上午准备车辆和工作餐',
      },
      {
        kind: 'other',
        title: '场地对接',
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        location: '园区北门',
        participant_names: [],
        confidence: 'medium',
        source_quote: '在园区北门完成场地对接',
      },
    ]),
    [],
    [],
    proposalNow,
    [storedProjectMeeting],
    [{
      meeting_id: storedProjectMeeting.id,
      fragments: [{
        content: '参会人员已确认',
        source_quote: `骆澄：${timelessSource}`,
      }],
    }],
  );

  assert.deepEqual(
    cards.map((card) => card.type === 'create_meeting' ? card.payload.title : null),
    ['准备车辆及工作餐安排', '场地对接'],
  );
  assert.deepEqual(noticeRouting, [{
    title: '星桥项目参会人员确认',
    decision: 'timeless_dropped',
  }]);
});

test('batch other dedup keeps two low-similarity other items with the same normalized time', () => {
  const cards = proposeCards(eventOnlyExtraction([{
    kind: 'other',
    title: '准备来访证',
    time_text: '明天 上午',
    time_iso: null,
    has_time_signal: true,
    participant_names: ['小谷'],
    confidence: 'high',
    source_quote: '请小谷准备两张来访证。',
  }]), [], []);
  const result = dedupeBatchOtherCards(cards, [{
    card_id: 301,
    source_quote: '请邬导把舞台灯光清单发给小禾。',
    time_text: '明天上午！',
    status: 'pending',
  }]);

  assert.deepEqual(result.cards, cards);
  assert.deepEqual(result.matches, []);
});

test('batch other dedup never filters a meeting even when source and time match an other item', () => {
  const cards = proposeCards(eventOnlyExtraction([{
    kind: 'meeting',
    title: '海棠项目碰头会',
    time_text: '明天上午',
    time_iso: null,
    has_time_signal: true,
    participant_names: ['邬导'],
    confidence: 'high',
    source_quote: '明天上午和邬导碰一下海棠项目。',
  }]), [], []);
  const result = dedupeBatchOtherCards(cards, [{
    card_id: 302,
    source_quote: '明天上午和邬导碰一下海棠项目。',
    time_text: '明天 上午',
    status: 'pending',
  }]);

  assert.deepEqual(result.cards, cards);
  assert.deepEqual(result.matches, []);
});

const existingItem: ExistingMeeting = {
  id: 41,
  kind: 'other',
  title: '准备报名材料',
  time_iso: null,
  time_text: '',
  location: '一楼服务大厅',
  participants: [{ contact_id: 7, name: '王老师' }],
  agenda: '携带身份证复印件',
};

function itemExtraction(overrides: Partial<PerceptionResult['events'][number]> = {}): PerceptionResult {
  return {
    participants: [],
    events: [
      {
        kind: 'other',
        title: '准备报名材料',
        time_text: '',
        time_iso: null,
        has_time_signal: false,
        participant_names: [],
        confidence: 'high',
        source_quote: '报名还要带两张照片',
        ...overrides,
      },
    ],
    facts: [],
    quotes: [],
  };
}

test('proposeCards marks a unique same-kind normalized-title item as a duplicate and preserves unmentioned fields', () => {
  const [card] = proposeCards(
    itemExtraction({
      title: ' 准备报名材料！ ',
      agenda: '携带身份证复印件和两张照片',
    }),
    [],
    [],
    proposalNow,
    [existingItem],
  );

  assert.equal(card?.type, 'create_meeting');
  if (card?.type !== 'create_meeting') {
    throw new Error('expected a create_meeting card');
  }
  assert.equal(card.payload.duplicate_of_meeting_id, existingItem.id);
  assert.equal(card.payload.location, existingItem.location);
  assert.deepEqual(card.payload.participants, existingItem.participants);
  assert.deepEqual(card.payload.changes, {
    title: { old: '准备报名材料', new: '准备报名材料！' },
    agenda: { old: '携带身份证复印件', new: '携带身份证复印件和两张照片' },
  });
});

test('proposeCards keeps an identical retransmission as a duplicate prompt with an empty changes map', () => {
  const [card] = proposeCards(
    itemExtraction({
      location: existingItem.location ?? undefined,
      participant_names: ['王老师'],
      agenda: existingItem.agenda ?? undefined,
    }),
    [],
    [],
    proposalNow,
    [existingItem],
  );

  assert.equal(card?.type, 'create_meeting');
  if (card?.type !== 'create_meeting') {
    throw new Error('expected a create_meeting card');
  }
  assert.equal(card.payload.duplicate_of_meeting_id, existingItem.id);
  assert.deepEqual(card.payload.changes, {});
});

test('proposeCards leaves a different title as a normal new item', () => {
  const [card] = proposeCards(
    itemExtraction({ title: '提交活动预算' }),
    [],
    [],
    proposalNow,
    [existingItem],
  );

  assert.equal(card?.type, 'create_meeting');
  if (card?.type !== 'create_meeting') {
    throw new Error('expected a create_meeting card');
  }
  assert.equal(card.payload.duplicate_of_meeting_id, undefined);
  assert.equal(card.payload.changes, undefined);
});

test('proposeCards refuses a different kind or an ambiguous exact-title target', () => {
  const appointmentWithSameTitle: ExistingMeeting = {
    ...existingItem,
    id: 42,
    kind: 'appointment',
  };
  const duplicateExistingItem: ExistingMeeting = {
    ...existingItem,
    id: 43,
  };
  const [differentKindCard] = proposeCards(
    itemExtraction(),
    [],
    [],
    proposalNow,
    [appointmentWithSameTitle],
  );
  const [ambiguousCard] = proposeCards(
    itemExtraction(),
    [],
    [],
    proposalNow,
    [existingItem, duplicateExistingItem],
  );

  assert.equal(
    differentKindCard?.type === 'create_meeting'
      ? differentKindCard.payload.duplicate_of_meeting_id
      : undefined,
    undefined,
  );
  assert.equal(
    ambiguousCard?.type === 'create_meeting'
      ? ambiguousCard.payload.duplicate_of_meeting_id
      : undefined,
    undefined,
  );
});

test('proposeCards does not merge same-name participants that have different contact ids', () => {
  const extraction = itemExtraction({ participant_names: ['王老师'] });
  extraction.participants = [
    {
      name: '王老师',
      is_self: false,
      confidence: 'high',
      source_quote: '王老师也参加',
    },
  ];
  const [card] = proposeCards(
    extraction,
    [
      {
        participant_name: '王老师',
        normalized_name: '王老师',
        status: 'same_as',
        contact_id: 8,
        source: 'exact',
      },
    ],
    [
      {
        id: 8,
        canonical_name: '王老师',
        aliases: [],
        company: null,
        title: null,
        phone: null,
        wechat_id: null,
        notes: null,
      },
    ],
    proposalNow,
    [existingItem],
  );

  assert.equal(card?.type, 'create_meeting');
  if (card?.type !== 'create_meeting') {
    throw new Error('expected a create_meeting card');
  }
  assert.deepEqual(card.payload.participants, [
    { contact_id: 7, name: '王老师' },
    { contact_id: 8, name: '王老师' },
  ]);
});

test('proposeCards uses the adjustable high-similarity rule only for a unique same-day item', () => {
  const existingMeeting: ExistingMeeting = {
    id: 52,
    kind: 'meeting',
    title: '第三季度项目推进协调会',
    time_iso: '2026-09-08T09:30:00+08:00',
    time_text: '9月8日上午9:30',
    location: null,
    participants: [],
    agenda: null,
  };
  const extraction = itemExtraction({
    kind: 'meeting',
    title: '第三季度项目推进协同会',
    time_iso: '2026-09-08T10:00:00+08:00',
    time_text: '9月8日上午10点',
  });
  const [sameDayCard] = proposeCards(
    extraction,
    [],
    [],
    proposalNow,
    [existingMeeting],
  );
  const [differentDayCard] = proposeCards(
    itemExtraction({
      ...extraction.events[0],
      time_iso: '2026-09-09T10:00:00+08:00',
      time_text: '9月9日上午10点',
    }),
    [],
    [],
    proposalNow,
    [existingMeeting],
  );
  const [ambiguousSameDayCard] = proposeCards(
    extraction,
    [],
    [],
    proposalNow,
    [
      existingMeeting,
      {
        ...existingMeeting,
        id: 53,
        title: '第三季度项目推进协商会',
      },
    ],
  );

  assert.equal(
    sameDayCard?.type === 'create_meeting'
      ? sameDayCard.payload.duplicate_of_meeting_id
      : undefined,
    existingMeeting.id,
  );
  assert.equal(
    differentDayCard?.type === 'create_meeting'
      ? differentDayCard.payload.duplicate_of_meeting_id
      : undefined,
    undefined,
  );
  assert.equal(
    ambiguousSameDayCard?.type === 'create_meeting'
      ? ambiguousSameDayCard.payload.duplicate_of_meeting_id
      : undefined,
    undefined,
  );
});

test('proposeCards turns matched progress fragments into one agenda-append card and keeps the interaction fallback', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王老师',
        is_self: false,
        interaction_summary: '王老师告知荀导已经到场，报名材料也补齐了。',
        confidence: 'high',
        source_quote: '王老师：荀导已经到了，材料也补齐了',
      },
    ],
    events: [],
    facts: [],
    quotes: [],
  };
  const resolutions: ParticipantResolution[] = [
    {
      participant_name: '王老师',
      normalized_name: '王老师',
      status: 'same_as',
      contact_id: 7,
      source: 'exact',
    },
  ];
  const contacts: ResolvableContact[] = [
    {
      id: 7,
      canonical_name: '王老师',
      aliases: [],
      company: null,
      title: null,
      phone: null,
      wechat_id: null,
      notes: null,
    },
  ];
  const meetingProgressResolutions: MeetingProgressResolution[] = [
    {
      meeting_id: existingItem.id,
      fragments: [
        { content: '荀导已经到场', source_quote: '荀导已经到了' },
        { content: '报名材料已补齐', source_quote: '材料也补齐了' },
      ],
    },
  ];

  const cards = proposeCards(
    extraction,
    resolutions,
    contacts,
    proposalNow,
    [existingItem],
    meetingProgressResolutions,
  );
  const progressCard = cards.find(
    (card) => card.type === 'create_meeting' && card.payload.agenda_append != null,
  );
  const interactionCard = cards.find((card) => card.type === 'record_interaction');

  assert.ok(progressCard);
  if (progressCard.type !== 'create_meeting') {
    throw new Error('expected a create_meeting progress card');
  }
  assert.deepEqual(progressCard, {
    type: 'create_meeting',
    payload: {
      kind: existingItem.kind,
      title: existingItem.title,
      time_iso: existingItem.time_iso,
      time_text: existingItem.time_text,
      location: existingItem.location,
      participants: existingItem.participants,
      agenda: '携带身份证复印件；荀导已经到场；报名材料已补齐',
      agenda_append: '荀导已经到场；报名材料已补齐',
      duplicate_of_meeting_id: existingItem.id,
      changes: {
        agenda: {
          old: '携带身份证复印件',
          new: '携带身份证复印件；荀导已经到场；报名材料已补齐',
        },
      },
    },
    confidence: 'high',
    source_quote: '荀导已经到了\n\n材料也补齐了',
  });
  assert.ok(interactionCard);
  assert.deepEqual(interactionCard.payload, {
    contact_id: 7,
    contact_name: '王老师',
    summary: '王老师告知荀导已经到场，报名材料也补齐了。',
  });
  assert.equal(interactionCard.source_quote, '王老师：荀导已经到了，材料也补齐了');
});
