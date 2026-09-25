import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySelfNames,
  PerceptionEventSchema,
  PerceptionParticipantSchema,
  PerceptionResultSchema,
  parseStoredPerceptionResult,
  perceiveScreenshot,
  type PerceptionResult,
} from '../../../shared/core/agent/perceive.ts';
import {
  buildPerceptionSystemPrompt,
  buildPerceptionTextSystemPrompt,
} from '../../../shared/core/llm/prompts.ts';
import { OpenAICompatibleProvider } from '../../../shared/core/llm/provider.ts';

// Verbatim `participants` captured from a real Qwen run on fixtures/screenshot-1.png (fictional
// content). The model gave no confidence for the self participant.
const SCREENSHOT_1_SELF_WITHOUT_CONFIDENCE =
  '[{"name":"我","is_self":true,"role":"speaker","speech_act":"initiate","source_quote":"上次你提的联名方案，我们这边已经把方向梳理好了。"},{"name":"林岚","is_self":false,"role":"speaker","speech_act":"initiate","interaction_summary":"林岚确认了下周三下午3点的会议安排，并告知会议室已预留，公司地址为云栖路88号A座7层。","confidence":"high","source_quote":"收到，我是栖川数据的林岚，下周三下午 3 点来我们公司聊合作。"}]';

const INVALID_CONFIDENCE_MESSAGE = 'Invalid option: expected one of "high"|"medium"|"low"';

class CannedResponseProvider extends OpenAICompatibleProvider {
  calls = 0;
  private readonly responses: string[];

  constructor(responses: string[]) {
    super({
      name: 'MockProvider',
      model: 'mock-model',
      apiKeyEnv: 'MOCK_API_KEY',
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
    });
    this.responses = [...responses];
  }

  override async complete(): Promise<string> {
    this.calls += 1;
    const next = this.responses.shift();

    if (next === undefined) {
      throw new Error('No canned response available');
    }

    return next;
  }
}

function listIssues(result: { error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  return result.error?.issues.map((issue) => [issue.path.join('.'), issue.message]);
}

function extractTimeRules(prompt: string): string {
  const match = prompt.match(
    /Time extraction rules \(Asia\/Shanghai\):[\s\S]+?(?=\nA meeting or appointment)/u,
  );

  assert.ok(match);
  return match[0];
}

function extractAliasRules(prompt: string): string {
  const match = prompt.match(
    /Participant alias rules:[\s\S]+?(?=\n(?:In a chat screenshot|Each input line is marked))/u,
  );

  assert.ok(match);
  return match[0];
}

function extractParticipantRoleRules(prompt: string): string {
  const match = prompt.match(
    /Participant role rules:[\s\S]+?(?=\nCurrent datetime)/u,
  );

  assert.ok(match);
  return match[0];
}

function extractParticipantSpeechActRules(prompt: string): string {
  const match = prompt.match(
    /Participant speech-act rules:[\s\S]+?(?=\nParticipant role rules:)/u,
  );

  assert.ok(match);
  return match[0];
}

test('PerceptionParticipantSchema requires explicit is_self', () => {
  const result = PerceptionParticipantSchema.safeParse({
    name: '我',
    confidence: 'high',
    source_quote: '我来发个消息',
  });

  assert.equal(result.success, false);
  assert.equal(result.error.issues[0]?.path.join('.'), 'is_self');
});

test('PerceptionParticipantSchema accepts speaker and mentioned roles, rejects invalid roles, and does not default a missing role', () => {
  const participant = {
    name: '王磊',
    is_self: false,
    confidence: 'high',
    source_quote: '会议通知：王磊参加',
  } as const;
  const speaker = PerceptionParticipantSchema.parse({
    ...participant,
    role: 'speaker',
    interaction_summary: '王磊确认会参加会议。',
  });
  const speakerWithoutSummary = PerceptionParticipantSchema.parse({
    ...participant,
    role: 'speaker',
  });
  const mentioned = PerceptionParticipantSchema.parse({
    ...participant,
    role: 'mentioned',
  });
  const invalid = PerceptionParticipantSchema.safeParse({
    ...participant,
    role: 'observer',
  });
  const missing = PerceptionParticipantSchema.parse(participant);

  assert.equal(speaker.role, 'speaker');
  assert.equal(speakerWithoutSummary.interaction_summary, undefined);
  assert.equal(mentioned.role, 'mentioned');
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.issues[0]?.path.join('.'), 'role');
  assert.equal(missing.role, undefined);
  assert.equal(Object.hasOwn(missing, 'role'), false);
});

test('PerceptionParticipantSchema accepts initiate and respond speech acts, rejects invalid values, and preserves a missing field', () => {
  const participant = {
    name: '骆澄',
    is_self: false,
    role: 'speaker',
    confidence: 'high',
    source_quote: '我来通知一下评审时间',
  } as const;
  const initiate = PerceptionParticipantSchema.parse({
    ...participant,
    speech_act: 'initiate',
  });
  const respond = PerceptionParticipantSchema.parse({
    ...participant,
    speech_act: 'respond',
  });
  const invalid = PerceptionParticipantSchema.safeParse({
    ...participant,
    speech_act: 'observe',
  });
  const missing = PerceptionParticipantSchema.parse(participant);

  assert.equal(initiate.speech_act, 'initiate');
  assert.equal(respond.speech_act, 'respond');
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.issues[0]?.path.join('.'), 'speech_act');
  assert.equal(missing.speech_act, undefined);
  assert.equal(Object.hasOwn(missing, 'speech_act'), false);
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
  const missingResult = PerceptionParticipantSchema.safeParse({
    name: '王磊',
    is_self: false,
    confidence: 'high',
    source_quote: '王磊说下周给反馈',
  });

  assert.equal(parsed.interaction_summary, '聊了合作推进情况，对方答应下周给反馈。');
  assert.equal(blankResult.success, false);
  assert.equal(blankResult.error.issues[0]?.path.join('.'), 'interaction_summary');
  assert.equal(missingResult.success, true);
});

test('PerceptionResultSchema fills in high confidence for the captured self participant that omits it', () => {
  const participants = JSON.parse(SCREENSHOT_1_SELF_WITHOUT_CONFIDENCE);
  const result = PerceptionResultSchema.safeParse({ participants });

  assert.equal(result.success, true);
  assert.deepEqual(
    result.data.participants.map((participant) => [participant.name, participant.confidence]),
    [['我', 'high'], ['林岚', 'high']],
  );
  // Downstream code sees exactly what it would if the model had said "high" itself.
  assert.deepEqual(
    result.data,
    PerceptionResultSchema.parse({
      participants: [{ ...participants[0], confidence: 'high' }, participants[1]],
    }),
  );
});

test('PerceptionResultSchema still rejects a non-self participant without confidence at the same path', () => {
  const [self, other] = JSON.parse(SCREENSHOT_1_SELF_WITHOUT_CONFIDENCE);
  delete other.confidence;

  assert.deepEqual(listIssues(PerceptionResultSchema.safeParse({ participants: [other] })), [
    ['participants.0.confidence', INVALID_CONFIDENCE_MESSAGE],
  ]);
  assert.deepEqual(listIssues(PerceptionResultSchema.safeParse({ participants: [self, other] })), [
    ['participants.1.confidence', INVALID_CONFIDENCE_MESSAGE],
  ]);
});

test('PerceptionParticipantSchema only fills in a missing confidence, and only for is_self true', () => {
  const self = { name: '我', is_self: true, source_quote: '可以，我提前十分钟到。' };

  assert.equal(PerceptionParticipantSchema.parse(self).confidence, 'high');
  assert.equal(PerceptionParticipantSchema.parse({ ...self, confidence: 'low' }).confidence, 'low');
  assert.deepEqual(listIssues(PerceptionParticipantSchema.safeParse({ ...self, confidence: 'certain' })), [
    ['confidence', INVALID_CONFIDENCE_MESSAGE],
  ]);
  assert.deepEqual(listIssues(PerceptionParticipantSchema.safeParse({ ...self, is_self: false })), [
    ['confidence', INVALID_CONFIDENCE_MESSAGE],
  ]);
});

test('perceiveScreenshot accepts the captured screenshot-1 output on the first attempt', async () => {
  // The model repeated the same answer when retried with the validation error.
  const rawText = `{"participants":${SCREENSHOT_1_SELF_WITHOUT_CONFIDENCE}}`;
  const provider = new CannedResponseProvider([rawText, rawText]);
  const result = await perceiveScreenshot({
    image: { base64: 'iVBORw0KGgo=', mimeType: 'image/png' },
    provider,
  });

  assert.equal(provider.calls, 1);
  assert.deepEqual(
    result.participants.map((participant) => participant.confidence),
    ['high', 'high'],
  );
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

test('PerceptionEventSchema accepts a no-time standalone item', () => {
  const result = PerceptionEventSchema.parse({
    kind: 'other',
    title: '准备报名材料',
    time_text: '',
    time_iso: null,
    has_time_signal: false,
    participant_names: [],
    confidence: 'high',
    source_quote: '报名要带身份证复印件和两张照片',
  });

  assert.equal(result.kind, 'other');
  assert.equal(result.time_text, '');
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

test('visual and text perception prompts share the timestamp-anchor time rules', () => {
  const now = new Date('2026-12-27T10:15:30+08:00');
  const prompt = buildPerceptionSystemPrompt(now);
  const textPrompt = buildPerceptionTextSystemPrompt(now);

  assert.match(
    prompt,
    /Current datetime \(Asia\/Shanghai\): 2026-12-27T10:15:30\+08:00/,
  );
  assert.equal(extractTimeRules(prompt), extractTimeRules(textPrompt));
  assert.match(prompt, /An absolute date takes priority over relative words/u);
  assert.match(prompt, /absolute date has no explicit clock time.+time_iso=null/u);
  assert.match(prompt, /omit the year, use 2026/u);
  assert.match(
    prompt,
    /Timestamp-anchor exception:.+nearest preceding WeChat timestamp separator explicitly contains an absolute month and day/u,
  );
  assert.match(
    prompt,
    /timestamp "8月12日 09:30" followed by "今天下午14:30" becomes 2026-08-12T14:30:00\+08:00/u,
  );
  assert.match(
    prompt,
    /If no timestamp separator is present, or the separator itself is relative such as "昨天 09:30" or "星期二 09:30", set relative-only time_iso=null/u,
  );
  assert.match(prompt, /Preserve time_text and set has_time_signal=true/u);
  assert.doesNotMatch(prompt, /Resolve every relative date in time_iso/u);
  assert.match(prompt, /A one-sided delivery promise or task commitment such as "明天把方案发你" is not a meeting/);
  assert.match(
    prompt,
    /Explicit tasks, requirements, material checklists, and file-format instructions are kind="other" events, even when they have no time or participants\. Use a concise evidence-only title and participant_names=\[\] when no person is explicitly tied to the item\./u,
  );
  assert.match(
    textPrompt,
    /Explicit tasks, requirements, material checklists, and file-format instructions are kind="other" events, even when they have no time or participants\. Use a concise evidence-only title and participant_names=\[\] when no person is explicitly tied to the item\./u,
  );
  assert.match(
    prompt,
    /If an event contains no time wording, use time_text="", time_iso=null, and has_time_signal=false\. Do not omit the event\./u,
  );
  assert.match(
    textPrompt,
    /If an event contains no time wording, use time_text="", time_iso=null, and has_time_signal=false\. Do not omit the event\./u,
  );
  assert.match(
    prompt,
    /Any freeform descriptive text that may later feed a record_interaction summary, such as participant\.notes or facts with field="notes", should be a 1-2 sentence gist about who discussed what plus any explicit progress signal or emotion/,
  );
  assert.doesNotMatch(prompt, /kind="other" event titles/u);
  assert.doesNotMatch(textPrompt, /kind="other" event titles/u);
  for (const perceptionPrompt of [prompt, textPrompt]) {
    assert.match(
      perceptionPrompt,
      /For every participant with is_self=false and role="speaker", interaction_summary is required and must be exactly one non-empty natural-language sentence\./,
    );
    assert.match(
      perceptionPrompt,
      /A participant with role="mentioned" may omit interaction_summary\. Omit interaction_summary for the self participant\./,
    );
    assert.match(
      perceptionPrompt,
      /If the evidence contains only structured contact information and no actual interaction content, summarize the context in which that information was stated or observed\. Do not list raw lines or invent details\./,
    );
    assert.match(
      perceptionPrompt,
      /interaction_summary required only for non-self role="speaker" participants and optional for role="mentioned" participants/,
    );
    assert.doesNotMatch(
      perceptionPrompt,
      /optional interaction_summary for non-self participants only/,
    );
  }
  assert.match(
    prompt,
    /Keep source_quote verbatim from the screenshot\. The summarization rule applies only to those freeform descriptive fields, not to source_quote\./,
  );
});

test('visual and text perception prompts share the exact participant role rules', () => {
  const now = new Date('2026-12-27T10:15:30+08:00');
  const visualRules = extractParticipantRoleRules(buildPerceptionSystemPrompt(now));
  const textRules = extractParticipantRoleRules(buildPerceptionTextSystemPrompt(now));

  assert.equal(visualRules, textRules);
  assert.match(
    visualRules,
    /role="speaker" when the participant sent at least one message in this evidence/u,
  );
  assert.match(
    visualRules,
    /role="mentioned" only when the participant appears in message body text, a notification, a roster, or an @mention list and did not send any message in this evidence/u,
  );
});

test('visual and text perception prompts share the exact participant speech-act rules', () => {
  const now = new Date('2026-12-27T10:15:30+08:00');
  const visualRules = extractParticipantSpeechActRules(buildPerceptionSystemPrompt(now));
  const textRules = extractParticipantSpeechActRules(buildPerceptionTextSystemPrompt(now));

  assert.equal(visualRules, textRules);
  assert.match(visualRules, /speech_act="initiate" when the participant initiates an arrangement, notification, question, assignment, proposal, or information-sharing/u);
  assert.match(visualRules, /speech_act="respond" only when all messages from that participant merely respond/u);
  assert.match(visualRules, /Treat it as respond even when the wording is longer/u);
  assert.match(visualRules, /both initiate and respond messages, set speech_act="initiate"/u);
});

test('visual and text perception prompts share the evidence-gated participant alias rules', () => {
  const now = new Date('2026-12-27T10:15:30+08:00');
  const visualRules = extractAliasRules(buildPerceptionSystemPrompt(now));
  const textRules = extractAliasRules(buildPerceptionTextSystemPrompt(now));

  assert.equal(visualRules, textRules);
  assert.match(
    visualRules,
    /only when the supplied screenshot evidence explicitly links those names to the same person within that same input/u,
  );
  assert.match(
    visualRules,
    /A shared surname, title, @mention, or similar-looking name is not enough by itself/u,
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
  assert.equal(result.participants[1]?.role, undefined);
  assert.equal(Object.hasOwn(result.participants[1] ?? {}, 'role'), false);
  assert.equal(result.participants[1]?.speech_act, undefined);
  assert.equal(Object.hasOwn(result.participants[1] ?? {}, 'speech_act'), false);
  assert.equal(result.events[0]?.has_time_signal, false);
  assert.equal(result.events[1]?.has_time_signal, true);
});

function eventOnlyResult(participantNames: string[]): PerceptionResult {
  return {
    participants: [],
    events: [{
      kind: 'meeting',
      title: '项目周会',
      time_text: '',
      time_iso: null,
      has_time_signal: false,
      participant_names: participantNames,
      confidence: 'high',
      source_quote: '项目周会安排',
    }],
    facts: [],
    quotes: [],
  };
}

function singleSelfParticipantResult(name: string, isSelf: boolean): PerceptionResult {
  return {
    participants: [{
      name,
      is_self: isSelf,
      confidence: 'high',
      source_quote: `${name}：好的`,
    }],
    events: [],
    facts: [],
    quotes: [],
  };
}

test('applySelfNames rewrites a self-nickname hit inside event participant_names to 我 (fix12 goal 5)', () => {
  const result = applySelfNames(eventOnlyResult(['柏贝', '李菁雅']), ['李菁雅']);

  assert.deepEqual(result.events[0]?.participant_names, ['柏贝', '我']);
});

test('applySelfNames collapses multiple self-name hits within one event into a single 我 (fix12 goal 5)', () => {
  const result = applySelfNames(eventOnlyResult(['菁雅', '李菁雅']), ['菁雅', '李菁雅']);

  assert.deepEqual(result.events[0]?.participant_names, ['我']);
});

test('applySelfNames leaves event participant_names untouched when no self names are configured (fix12 goal 5)', () => {
  const result = applySelfNames(eventOnlyResult(['柏贝', '李菁雅']), []);

  assert.deepEqual(result.events[0]?.participant_names, ['柏贝', '李菁雅']);
});

test('applySelfNames still promotes a matching participant to is_self without a third argument (fix12 goal 5 regression)', () => {
  const result = applySelfNames(singleSelfParticipantResult('李菁雅', false), ['李菁雅']);

  assert.equal(result.participants[0]?.is_self, true);
});

test('applySelfNames flips a wrongly self-judged known contact back to is_self=false (fix12 goal 6)', () => {
  const result = applySelfNames(
    singleSelfParticipantResult('沈青岚', true),
    ['李菁雅'],
    new Set(['沈青岚']),
  );

  assert.equal(result.participants[0]?.is_self, false);
});

test('applySelfNames keeps is_self=true for a self-judged name that is not a known contact (fix12 goal 6)', () => {
  const result = applySelfNames(
    singleSelfParticipantResult('安闲静雅', true),
    ['李菁雅'],
    new Set(['沈青岚']),
  );

  assert.equal(result.participants[0]?.is_self, true);
});

test('applySelfNames keeps or promotes a name that is itself a registered self name even if it also matches a known contact (fix12 goal 6)', () => {
  const alreadySelf = applySelfNames(
    singleSelfParticipantResult('李菁雅', true),
    ['李菁雅'],
    new Set(['李菁雅']),
  );
  const notYetSelf = applySelfNames(
    singleSelfParticipantResult('李菁雅', false),
    ['李菁雅'],
    new Set(['李菁雅']),
  );

  assert.equal(alreadySelf.participants[0]?.is_self, true);
  assert.equal(notYetSelf.participants[0]?.is_self, true);
});

test('applySelfNames does not flip anything when knownContactNames is empty (fix12 goal 6)', () => {
  const result = applySelfNames(
    singleSelfParticipantResult('沈青岚', true),
    ['李菁雅'],
    new Set(),
  );

  assert.equal(result.participants[0]?.is_self, true);
});
