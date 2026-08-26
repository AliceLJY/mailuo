import test from 'node:test';
import assert from 'node:assert/strict';

import type { PerceptionResult } from '../agent/perceive.ts';
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
