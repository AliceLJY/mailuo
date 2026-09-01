import test from 'node:test';
import assert from 'node:assert/strict';

import type { PerceptionResult } from '../../../shared/core/agent/perceive.ts';
import type {
  MeetingProgressResolution,
  ParticipantResolution,
  ResolvableContact,
} from '../../../shared/core/agent/resolve.ts';
import {
  proposeCards as baseProposeCards,
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
      company: '旧公司',
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
        company: { old: '旧公司', new: '新公司' },
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
      summary: '我上个月跳槽去了新公司；公司 新公司；职位 市场总监',
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
      summary: '@王磊 王总，方案已经发你；别名 王磊',
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

test('proposeCards falls back to legacy interaction summary assembly when interaction_summary is missing', () => {
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
  const interactionCard = cards.find((card) => card.type === 'record_interaction');

  assert.ok(interactionCard);
  assert.deepEqual(interactionCard.payload, {
    contact_id: 5,
    contact_name: '王磊',
    summary: '今天和王磊继续推进合作；周五前把方案发你；公司 星火科技',
  });
  assert.equal(
    interactionCard.source_quote,
    '今天和王磊继续推进合作\n\n王磊说：周五前把方案发你',
  );
});

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
        summary: '王磊周五来找我聊合作；公司 星火科技',
      },
      confidence: 'high',
      source_quote: '王磊周五来找我聊合作',
    },
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
        summary: '李姐，我们继续跟进那个合作；李姐说下周再对一下细节；公司 甲公司',
      },
      confidence: 'high',
      source_quote: '李姐，我们继续跟进那个合作\n\n李姐说下周再对一下细节',
    },
  ]);
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
        summary: '今天和王磊继续推进合作；周五前把方案发你；公司 星火科技',
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
        summary: '我是星火科技的市场总监王磊；公司 星火科技；职位 市场总监',
      },
      confidence: 'high',
      source_quote: '我是星火科技的市场总监王磊',
    },
    {
      type: 'record_interaction',
      payload: {
        contact_name: '李姐',
        summary: '李姐，下周找时间见面；别名 鲍总',
      },
      confidence: 'medium',
      source_quote: '李姐，下周找时间见面',
    },
  ]);
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
