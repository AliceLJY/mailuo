import test from 'node:test';
import assert from 'node:assert/strict';

import type { PerceptionResult } from '../agent/perceive.ts';
import type { ParticipantResolution, ResolvableContact } from '../agent/resolve.ts';
import { proposeCards as baseProposeCards } from '../agent/propose.ts';

const proposalNow = new Date('2026-08-27T02:00:00.000Z');

function proposeCards(
  extraction: PerceptionResult,
  resolutions?: ParticipantResolution[],
  contacts: ResolvableContact[] = [],
) {
  return baseProposeCards(extraction, resolutions, contacts, proposalNow);
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
      title: '喝咖啡聊合作',
      time_iso: '2026-08-28T14:00:00+08:00',
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

test('proposeCards overrides model time_iso with locally resolved time_text', () => {
  const extraction: PerceptionResult = {
    participants: [],
    events: [
      {
        kind: 'meeting',
        title: '继续聊',
        time_text: '明晚',
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
        title: '继续聊',
        time_iso: '2026-08-28T19:00:00+08:00',
        time_text: '明晚',
        participants: [],
      },
      confidence: 'medium',
      source_quote: '明晚继续聊',
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
        title: '继续聊',
        time_iso: '2026-08-28T18:00:00+08:00',
        time_text: '   ',
        participants: [],
      },
      confidence: 'medium',
      source_quote: '明晚继续聊',
    },
  ]);
});

test('proposeCards preserves model time_iso when local resolution returns null', () => {
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

test('proposeCards folds no-time-signal meetings into interactions instead of create_meeting cards', () => {
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

  assert.equal(meetingCard, undefined);
  assert.ok(interactionCard);
  assert.match(interactionCard.payload.summary, /再约个时间细聊/);
  assert.equal(
    interactionCard.source_quote,
    '王磊说后面继续聊\n\n等你方便了我们再约个时间细聊',
  );
});

test('proposeCards treats blank time_iso without time signal as interaction only', () => {
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

  assert.equal(meetingCard, undefined);
  assert.ok(interactionCard);
  assert.match(interactionCard.payload.summary, /改天再约个时间细聊合作/);
  assert.equal(
    interactionCard.source_quote,
    '王磊说我们改天再细聊\n\n改天再约个时间细聊合作',
  );
});

test('proposeCards folds eligible other events with time signals into the existing interaction card', () => {
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

  assert.deepEqual(cards, [
    {
      type: 'record_interaction',
      payload: {
        contact_id: 8,
        contact_name: '王磊',
        summary: '今天继续推进方案；明天下午三点把方案发你',
      },
      confidence: 'high',
      source_quote: '今天继续推进方案\n\n明天下午三点把方案发你',
    },
  ]);
});

test('proposeCards ignores unmatched other events instead of creating standalone interaction cards', () => {
  const extraction: PerceptionResult = {
    participants: [],
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

  assert.deepEqual(proposeCards(extraction, [], []), []);
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
