import test from 'node:test';
import assert from 'node:assert/strict';

import type { PerceptionResult } from '../agent/perceive.ts';
import type { ParticipantResolution, ResolvableContact } from '../agent/resolve.ts';
import { proposeCards } from '../agent/propose.ts';

test('proposeCards creates contact and meeting cards from perception output', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '王磊',
        company: '星火科技',
        title: '市场总监',
        confidence: 'high',
        source_quote: '我是星火科技的市场总监王磊',
      },
      {
        name: '李姐',
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

test('proposeCards skips no-op updates and dedupes interactions by resolved contact', () => {
  const extraction: PerceptionResult = {
    participants: [
      {
        name: '李姐',
        company: '甲公司',
        confidence: 'medium',
        source_quote: '李姐，我们继续跟进那个合作',
      },
      {
        name: '李姐',
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
        company: '星火科技',
        title: '市场总监',
        confidence: 'high',
        source_quote: '我是星火科技的市场总监王磊',
      },
      {
        name: '李姐',
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
