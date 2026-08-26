import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PerceptionEventSchema,
  PerceptionParticipantSchema,
  parseStoredPerceptionResult,
} from '../agent/perceive.ts';

test('PerceptionParticipantSchema requires explicit is_self', () => {
  const result = PerceptionParticipantSchema.safeParse({
    name: '我',
    confidence: 'high',
    source_quote: '我来发个消息',
  });

  assert.equal(result.success, false);
  assert.equal(result.error.issues[0]?.path.join('.'), 'is_self');
});

test('PerceptionEventSchema rejects relative text in time_iso', () => {
  const result = PerceptionEventSchema.safeParse({
    kind: 'meeting',
    title: '聊合作',
    time_text: '明天下午三点',
    time_iso: '明天下午三点',
    has_time_signal: true,
    participant_names: ['李姐'],
    confidence: 'high',
    source_quote: '明天下午三点来我们公司聊合作',
  });

  assert.equal(result.success, false);
  assert.match(result.error.issues[0]?.message ?? '', /Invalid ISO datetime/);
});

test('PerceptionEventSchema accepts ISO datetimes with timezone offsets', () => {
  const result = PerceptionEventSchema.parse({
    kind: 'meeting',
    title: '聊合作',
    time_text: '下周三下午三点',
    time_iso: '2026-09-02T15:00:00+08:00',
    has_time_signal: true,
    participant_names: ['李姐'],
    confidence: 'high',
    source_quote: '下周三下午三点来我们公司聊合作',
  });

  assert.equal(result.time_iso, '2026-09-02T15:00:00+08:00');
});

test('PerceptionEventSchema requires explicit has_time_signal', () => {
  const result = PerceptionEventSchema.safeParse({
    kind: 'meeting',
    title: '改天聊',
    time_text: '改天',
    time_iso: null,
    participant_names: ['李姐'],
    confidence: 'medium',
    source_quote: '改天聊',
  });

  assert.equal(result.success, false);
  assert.equal(result.error.issues[0]?.path.join('.'), 'has_time_signal');
});

test('parseStoredPerceptionResult restores legacy missing booleans without dropping aliases or notes', () => {
  const result = parseStoredPerceptionResult({
    participants: [
      {
        name: ' 我 ',
        aliases: ['Alice'],
        notes: '更喜欢语音',
        confidence: 'high',
        source_quote: '我更喜欢语音',
      },
      {
        name: '王磊',
        aliases: ['老王'],
        confidence: 'medium',
        source_quote: '我叫王磊，也有人叫我老王',
      },
    ],
    events: [
      {
        kind: 'meeting',
        title: '改天聊',
        time_text: '改天',
        time_iso: null,
        participant_names: ['我', '王磊'],
        confidence: 'medium',
        source_quote: '改天聊',
      },
      {
        kind: 'meeting',
        title: '聊合作',
        time_text: '下周三下午三点',
        time_iso: '2026-09-02T15:00:00+08:00',
        participant_names: ['王磊'],
        confidence: 'high',
        source_quote: '下周三下午三点聊合作',
      },
    ],
    facts: [],
    quotes: [],
  });

  assert.ok(result);
  assert.equal(result.participants[0]?.is_self, true);
  assert.equal(result.participants[0]?.aliases?.[0], 'Alice');
  assert.equal(result.participants[0]?.notes, '更喜欢语音');
  assert.equal(result.participants[1]?.is_self, false);
  assert.equal(result.events[0]?.has_time_signal, false);
  assert.equal(result.events[1]?.has_time_signal, true);
});
