// Platform-neutral prompt builders shared by server and native runtimes.
const shanghaiTimeZone = 'Asia/Shanghai';

type ShanghaiDateParts = {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
  second: string;
};

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

function formatTwoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

function getShanghaiDateParts(now: Date): ShanghaiDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: shanghaiTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: values.get('hour') ?? '00',
    minute: values.get('minute') ?? '00',
    second: values.get('second') ?? '00',
  };
}

function formatCalendarDate(date: CalendarDate): string {
  return `${date.year}-${formatTwoDigits(date.month)}-${formatTwoDigits(date.day)}`;
}

function formatShanghaiDateTime(now: Date): string {
  const parts = getShanghaiDateParts(now);

  return `${formatCalendarDate(parts)}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function buildTimeExtractionRules(now: Date): string {
  const currentYear = getShanghaiDateParts(now).year;

  return [
    'Time extraction rules (Asia/Shanghai):',
    '- Always preserve the original scheduling expression verbatim in time_text.',
    '- If the evidence contains an absolute calendar date such as "8月27日（周四）" or "8月12日 下午16:00", use that explicit month and day in time_iso. An absolute date takes priority over relative words such as "明天" in the same expression; never replace the explicit month and day by calculating from a relative word.',
    '- If an absolute date has no explicit clock time, set time_iso=null rather than inventing a default hour. Preserve time_text and set has_time_signal=true.',
    `- If an absolute month and day omit the year, use ${currentYear}, even when that date is earlier than the current date. Never roll it into the next year.`,
    '- If the evidence contains only a relative date such as "明天", "下周三", or "今天下午", set time_iso=null. Do not calculate a calendar date from the current datetime. Preserve time_text and set has_time_signal=true.',
  ].join('\n');
}

export type EntityResolutionContactSummary = {
  id: number;
  canonical_name: string;
  aliases: string[];
  company: string | null;
};

export type InsightPromptContact = {
  id: number;
  canonical_name: string;
  aliases: string[];
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat_id: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type InsightPromptObservation = {
  id: number;
  kind: 'fact' | 'preference' | 'status_change' | 'interaction';
  content: string;
  source_quote: string | null;
  observed_at: string;
};

export type InsightPromptSummary = {
  id: number;
  kind: 'relationship_read' | 'suggested_action' | 'conversation_hook';
  content: string;
  based_on: number[];
  generated_at: string;
};

export function buildPerceptionSystemPrompt(now: Date): string {
  return [
    'You extract only evidence that is visible in the screenshot and optional user note.',
    'Never infer hidden context, unstated identities, or unstated relationships.',
    'In a chat screenshot, the device owner is the self side of the conversation: messages shown as "我" or the right-side bubbles. Mark that participant with is_self=true. Mark everyone else with is_self=false.',
    'Do not turn another person into the device owner unless the screenshot itself shows that self-side evidence.',
    `Current datetime (Asia/Shanghai): ${formatShanghaiDateTime(now)}`,
    buildTimeExtractionRules(now),
    'A meeting or appointment must be a mutually agreed time when both sides will meet, attend together, or talk on a call together.',
    'A one-sided delivery promise or task commitment such as "明天把方案发你" is not a meeting, even when it has a clear date or time. Extract it as kind="other".',
    'Explicit tasks, requirements, material checklists, and file-format instructions are kind="other" events, even when they have no time or participants. Use a concise evidence-only title and participant_names=[] when no person is explicitly tied to the item.',
    'If an event contains no time wording, use time_text="", time_iso=null, and has_time_signal=false. Do not omit the event.',
    'For event titles, stay as close as possible to the original wording and meaning. Do not invent an agenda like "讨论合作" unless the screenshot explicitly says it.',
    'Set has_time_signal=true only when the screenshot contains a concrete scheduling signal such as a date, weekday, clock time, or time period like "周二", "下周三下午", or "明晚". Set has_time_signal=false for vague phrases like "改天", "回头", or "等你方便".',
    'Every participant, event, fact, and quote must include an exact source_quote copied from the screenshot when applicable.',
    'Only include interaction_summary for participants with is_self=false. Omit interaction_summary for the self participant.',
    'For each non-self participant, interaction_summary should be a 1-2 sentence gist of what you discussed with that person, plus any explicit progress signal or emotion. Do not list raw lines or invent details.',
    'Any freeform descriptive text that may later feed a record_interaction summary, such as participant.notes or facts with field="notes", should be a 1-2 sentence gist about who discussed what plus any explicit progress signal or emotion. Do not paste or enumerate raw lines there.',
    'Keep source_quote verbatim from the screenshot. The summarization rule applies only to those freeform descriptive fields, not to source_quote.',
    'If company, title, phone, or wechat_id is explicitly stated or explicitly changed, include it in facts with the matching structured field. Do not hide structured contact data inside notes when a structured field exists.',
    'If someone says they changed companies, joined a company, or went to a company, record the new company in facts with field="company".',
    'Few-shot example: text "王磊：我上个月跳槽去了翎点科技" -> include a fact like {"subject_name":"王磊","field":"company","value":"翎点科技","source_quote":"我上个月跳槽去了翎点科技"}.',
    'confidence must be one of: high, medium, low.',
    'Return JSON only.',
    'Schema requirements:',
    '- participants: array of people explicitly shown or mentioned in the screenshot. Include name, is_self, optional aliases/company/title/phone/wechat_id/notes, optional interaction_summary for non-self participants only, confidence, source_quote.',
    '- events: array of explicit meetings, appointments, or other follow-up commitments shown in the screenshot. meeting/appointment only apply to mutually attended or call-together time points; one-sided promises belong to kind="other". Include kind, title, time_text, time_iso or null, has_time_signal, optional location/agenda, participant_names, confidence, source_quote.',
    '- facts: array of explicit facts with subject_name, field, value, confidence, source_quote.',
    '- quotes: array of notable exact quotes with speaker_name or null, text, source_quote.',
  ].join('\n');
}

export function buildPerceptionTextSystemPrompt(now: Date): string {
  return [
    'You extract only evidence that is visible in the provided OCR chat text and optional user note.',
    'Never infer hidden context, unstated identities, or unstated relationships.',
    'Each input line is marked with side=me, side=them, or side=null. side=me is the device owner and must map to is_self=true; side=them is another participant and must map to is_self=false. Use the same side markers when deciding quotes.speaker_name.',
    'The side=... marker is metadata, not recognized OCR text. Never copy a side marker into source_quote or any other evidence field.',
    'For a side=null line, determine is_self or speaker_name only from explicit text such as "我". Otherwise do not guess, and use speaker_name=null when applicable.',
    'Do not turn another person into the device owner unless a side=me marker or the provided OCR text explicitly shows that self-side evidence.',
    `Current datetime (Asia/Shanghai): ${formatShanghaiDateTime(now)}`,
    buildTimeExtractionRules(now),
    'A meeting or appointment must be a mutually agreed time when both sides will meet, attend together, or talk on a call together.',
    'A one-sided delivery promise or task commitment such as "明天把方案发你" is not a meeting, even when it has a clear date or time. Extract it as kind="other".',
    'Explicit tasks, requirements, material checklists, and file-format instructions are kind="other" events, even when they have no time or participants. Use a concise evidence-only title and participant_names=[] when no person is explicitly tied to the item.',
    'If an event contains no time wording, use time_text="", time_iso=null, and has_time_signal=false. Do not omit the event.',
    'For event titles, stay as close as possible to the original wording and meaning. Do not invent an agenda like "讨论合作" unless the provided OCR text explicitly says it.',
    'Set has_time_signal=true only when the provided OCR text contains a concrete scheduling signal such as a date, weekday, clock time, or time period like "周二", "下周三下午", or "明晚". Set has_time_signal=false for vague phrases like "改天", "回头", or "等你方便".',
    'Every participant, event, fact, and quote must include an exact source_quote copied from the provided OCR text when applicable.',
    'Only include interaction_summary for participants with is_self=false. Omit interaction_summary for the self participant.',
    'For each non-self participant, interaction_summary should be a 1-2 sentence gist of what you discussed with that person, plus any explicit progress signal or emotion. Do not list raw lines or invent details.',
    'Any freeform descriptive text that may later feed a record_interaction summary, such as participant.notes or facts with field="notes", should be a 1-2 sentence gist about who discussed what plus any explicit progress signal or emotion. Do not paste or enumerate raw lines there.',
    'Keep source_quote verbatim from the provided OCR text. The summarization rule applies only to those freeform descriptive fields, not to source_quote.',
    'If company, title, phone, or wechat_id is explicitly stated or explicitly changed, include it in facts with the matching structured field. Do not hide structured contact data inside notes when a structured field exists.',
    'If someone says they changed companies, joined a company, or went to a company, record the new company in facts with field="company".',
    'Few-shot example: text "王磊：我上个月跳槽去了翎点科技" -> include a fact like {"subject_name":"王磊","field":"company","value":"翎点科技","source_quote":"我上个月跳槽去了翎点科技"}.',
    'confidence must be one of: high, medium, low.',
    'Return JSON only.',
    'Schema requirements:',
    '- participants: array of people explicitly shown or mentioned in the provided OCR text. Include name, is_self, optional aliases/company/title/phone/wechat_id/notes, optional interaction_summary for non-self participants only, confidence, source_quote.',
    '- events: array of explicit meetings, appointments, or other follow-up commitments shown in the provided OCR text. meeting/appointment only apply to mutually attended or call-together time points; one-sided promises belong to kind="other". Include kind, title, time_text, time_iso or null, has_time_signal, optional location/agenda, participant_names, confidence, source_quote.',
    '- facts: array of explicit facts with subject_name, field, value, confidence, source_quote.',
    '- quotes: array of notable exact quotes with speaker_name or null, text, source_quote.',
  ].join('\n');
}

export function buildPerceptionUserPrompt(note?: string): string {
  const lines = [
    'Read the screenshot and extract structured evidence.',
    'Only use screenshot evidence. The optional note may clarify the user intent but does not override the screenshot.',
  ];

  if (note) {
    lines.push(`User note: ${note}`);
  }

  return lines.join('\n');
}

export function buildEntityResolutionPrompt(
  participantContext: string,
  contacts: EntityResolutionContactSummary[],
): { systemPrompt: string; userPrompt: string } {
  const contactSummaries = contacts.map((contact) => ({
    id: contact.id,
    canonical_name: contact.canonical_name,
    aliases: contact.aliases,
    company: contact.company,
  }));

  return {
    systemPrompt: [
      'You decide whether the participant in the screenshot matches an existing contact.',
      'Use only the participant context and the provided contact summaries.',
      'The only existing-contact fields you may use are id, canonical_name, aliases, and company.',
      'Do not infer hidden identities, unstated aliases, or unstated company changes.',
      'If the evidence is insufficient, choose unsure instead of guessing.',
      'Return JSON only.',
      'Schema requirements:',
      '- same_as: {"decision":"same_as","contact_id":123}.',
      '- new: {"decision":"new"}.',
      '- unsure: {"decision":"unsure","candidate_ids":[123,456]}.',
      '- Do not include null placeholders, empty arrays, or extra keys from other decisions.',
    ].join('\n'),
    userPrompt: [
      'Participant context:',
      participantContext.trim(),
      'Existing contact summaries:',
      JSON.stringify(contactSummaries, null, 2),
    ].join('\n\n'),
  };
}

export function buildInsightGenerationPrompt(input: {
  contact: InsightPromptContact;
  observations: InsightPromptObservation[];
  recentInsights: InsightPromptSummary[];
}): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: [
      'You generate grounded relationship insights for one contact.',
      'Use only the provided structured contact fields, observation timeline, and recent insight summaries.',
      'Do not infer any fact or motivation that is not directly supported by the observations.',
      'Return 1 to 3 insights when evidence supports them. If the evidence is thin, return fewer insights.',
      'Every insight must cite one or more observation IDs in based_on. If you cannot ground an insight, do not output it.',
      'Keep each insight content within 120 Chinese characters.',
      'Avoid repeating the same point already covered by the recent insight summaries unless the new observations materially change it.',
      'Return JSON only.',
      'Schema requirements:',
      '- insights: array with 1 to 3 items.',
      '- kind: "relationship_read" | "suggested_action" | "conversation_hook".',
      '- content: concise plain text.',
      '- based_on: array of observation IDs taken only from the supplied observation timeline.',
    ].join('\n'),
    userPrompt: JSON.stringify(
      {
        contact: input.contact,
        observations: input.observations,
        recent_insight_summaries: input.recentInsights,
      },
      null,
      2,
    ),
  };
}
