import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PerceptionEventSchema,
  PerceptionParticipantSchema,
  parseStoredPerceptionResult,
} from '../../../shared/core/agent/perceive.ts';
import { buildPerceptionSystemPrompt } from '../../../shared/core/llm/prompts.ts';

test('PerceptionParticipantSchema requires explicit is_self', () => {
  const result = PerceptionParticipantSchema.safeParse({
    name: '我',
    confidence: 'high',
    source_quote: '我来发个消息',
  });

  assert.equal(result.success, false);
  assert.equal(result.error.issues[0]?.path.join('.'), 'is_self');
});

test('PerceptionParticipantSchema trims non-empty interaction_summary and rejects blank values', () => {
  const parsed = PerceptionParticipantSchema.parse({
    name: '王磊',
    is_self: false,
    interaction_summary: '  聊了合作推进情况，对方答应下周给反馈。  ',
    confidence: 'high',
    source_quote: '王磊说下周给反馈',
  });
  const blankResult = PerceptionParticipantSchema.safeParse({
    name: '王磊',
    is_self: false,
    interaction_summary: '   ',
    confidence: 'high',
    source_quote: '王磊说下周给反馈',
  });

  assert.equal(parsed.interaction_summary, '聊了合作推进情况，对方答应下周给反馈。');
  assert.equal(blankResult.success, false);
  assert.equal(blankResult.error.issues[0]?.path.join('.'), 'interaction_summary');
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

test('buildPerceptionSystemPrompt injects a 14-day Shanghai calendar lookup table for relative dates', () => {
  const prompt = buildPerceptionSystemPrompt(new Date('2026-12-27T10:15:30+08:00'));
  const calendarLines = prompt.match(/^\d{4}-\d{2}-\d{2} = .+$/gm) ?? [];

  assert.match(
    prompt,
    /Current datetime \(Asia\/Shanghai\): 2026-12-27T10:15:30\+08:00/,
  );
  assert.equal(calendarLines.length, 14);
  assert.deepEqual(calendarLines[0], '2026-12-27 = 星期日（今天）');
  assert.deepEqual(calendarLines[1], '2026-12-28 = 星期一（明天、下周一）');
  assert.ok(calendarLines.includes('2026-12-30 = 星期三（下周三）'));
  assert.ok(calendarLines.includes('2027-01-01 = 星期五（下周五）'));
  assert.match(prompt, /Resolve every relative date in time_iso by selecting the matching YYYY-MM-DD from the table below/);
  assert.match(prompt, /Do not calculate weekdays or dates yourself/);
  assert.match(prompt, /A one-sided delivery promise or task commitment such as "明天把方案发你" is not a meeting/);
  assert.match(
    prompt,
    /Any freeform descriptive text that may later feed a record_interaction summary, such as participant\.notes, facts with field="notes", or kind="other" event titles, should be a 1-2 sentence gist about who discussed what plus any explicit progress signal or emotion/,
  );
  assert.match(
    prompt,
    /Only include interaction_summary for participants with is_self=false\. Omit interaction_summary for the self participant\./,
  );
  assert.match(
    prompt,
    /For each non-self participant, interaction_summary should be a 1-2 sentence gist of what you discussed with that person, plus any explicit progress signal or emotion\. Do not list raw lines or invent details\./,
  );
  assert.match(
    prompt,
    /Keep source_quote verbatim from the screenshot\. The summarization rule applies only to those freeform descriptive fields, not to source_quote\./,
  );
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
