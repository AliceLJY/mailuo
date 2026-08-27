const shanghaiTimeZone = 'Asia/Shanghai';
const weekdayLabels = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const weekdayShortLabels = ['日', '一', '二', '三', '四', '五', '六'];

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

function toUtcCalendarDate(date: CalendarDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

function addCalendarDays(date: CalendarDate, deltaDays: number): CalendarDate {
  const nextDate = toUtcCalendarDate(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + deltaDays);

  return {
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
  };
}

function formatCalendarDate(date: CalendarDate): string {
  return `${date.year}-${formatTwoDigits(date.month)}-${formatTwoDigits(date.day)}`;
}

function getWeekdayIndex(date: CalendarDate): number {
  return toUtcCalendarDate(date).getUTCDay();
}

function getWeekStart(date: CalendarDate): CalendarDate {
  const weekdayIndex = getWeekdayIndex(date);
  const mondayBasedWeekday = (weekdayIndex + 6) % 7;

  return addCalendarDays(date, -mondayBasedWeekday);
}

function getRelativeWeekLabel(date: CalendarDate, today: CalendarDate): string | null {
  const weekdayIndex = getWeekdayIndex(date);

  if (weekdayIndex === 0 || weekdayIndex === 6) {
    return null;
  }

  const weekStart = getWeekStart(date);
  const todayWeekStart = getWeekStart(today);
  const weekDeltaDays =
    (toUtcCalendarDate(weekStart).getTime() - toUtcCalendarDate(todayWeekStart).getTime()) /
    (24 * 60 * 60 * 1000);
  const weekdayShortLabel = weekdayShortLabels[weekdayIndex];

  if (weekDeltaDays === 0) {
    return `本周${weekdayShortLabel}`;
  }

  if (weekDeltaDays === 7) {
    return `下周${weekdayShortLabel}`;
  }

  return null;
}

function formatCalendarLookupLine(date: CalendarDate, today: CalendarDate, offsetDays: number): string {
  const weekdayIndex = getWeekdayIndex(date);
  const labels: string[] = [];

  if (offsetDays === 0) {
    labels.push('今天');
  } else if (offsetDays === 1) {
    labels.push('明天');
  }

  const relativeWeekLabel = getRelativeWeekLabel(date, today);

  if (relativeWeekLabel) {
    labels.push(relativeWeekLabel);
  }

  const suffix = labels.length > 0 ? `（${labels.join('、')}）` : '';

  return `${formatCalendarDate(date)} = ${weekdayLabels[weekdayIndex]}${suffix}`;
}

function formatShanghaiDateTime(now: Date): string {
  const parts = getShanghaiDateParts(now);

  return `${formatCalendarDate(parts)}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function buildShanghaiCalendarAnchor(now: Date): string {
  const today = getShanghaiDateParts(now);
  const todayDate: CalendarDate = {
    year: today.year,
    month: today.month,
    day: today.day,
  };
  const lookupLines = Array.from({ length: 14 }, (_, offsetDays) =>
    formatCalendarLookupLine(addCalendarDays(todayDate, offsetDays), todayDate, offsetDays),
  );

  return [
    'Calendar anchor (Asia/Shanghai):',
    'Resolve every relative date in time_iso by selecting the matching YYYY-MM-DD from the table below.',
    'Do not calculate weekdays or dates yourself.',
    'The date part of every time_iso must be one of these 14 dates:',
    ...lookupLines,
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
    buildShanghaiCalendarAnchor(now),
    'If the screenshot uses relative time like tomorrow or next Wednesday, resolve it to ISO 8601 using Asia/Shanghai, select the date from the calendar table above instead of doing your own weekday math, and also preserve the original time_text.',
    'A meeting or appointment must be a mutually agreed time when both sides will meet, attend together, or talk on a call together.',
    'A one-sided delivery promise or task commitment such as "明天把方案发你" is not a meeting, even when it has a clear date or time. Extract it as kind="other".',
    'For event titles, stay as close as possible to the original wording and meaning. Do not invent an agenda like "讨论合作" unless the screenshot explicitly says it.',
    'Set has_time_signal=true only when the screenshot contains a concrete scheduling signal such as a date, weekday, clock time, or time period like "周二", "下周三下午", or "明晚". Set has_time_signal=false for vague phrases like "改天", "回头", or "等你方便".',
    'Every participant, event, fact, and quote must include an exact source_quote copied from the screenshot when applicable.',
    'Only include interaction_summary for participants with is_self=false. Omit interaction_summary for the self participant.',
    'For each non-self participant, interaction_summary should be a 1-2 sentence gist of what you discussed with that person, plus any explicit progress signal or emotion. Do not list raw lines or invent details.',
    'Any freeform descriptive text that may later feed a record_interaction summary, such as participant.notes, facts with field="notes", or kind="other" event titles, should be a 1-2 sentence gist about who discussed what plus any explicit progress signal or emotion. Do not paste or enumerate raw lines there.',
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
