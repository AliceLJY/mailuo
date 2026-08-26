function formatShanghaiDateTime(now: Date): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return formatter.format(now).replace(' ', 'T') + '+08:00';
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
    'If the screenshot uses relative time like tomorrow or next Wednesday, resolve it to ISO 8601 using Asia/Shanghai and also preserve the original time_text.',
    'Set has_time_signal=true only when the screenshot contains a concrete scheduling signal such as a date, weekday, clock time, or time period like "周二", "下周三下午", or "明晚". Set has_time_signal=false for vague phrases like "改天", "回头", or "等你方便".',
    'Every participant, event, fact, and quote must include an exact source_quote copied from the screenshot when applicable.',
    'If company, title, phone, or wechat_id is explicitly stated or explicitly changed, include it in facts with the matching structured field. Do not hide structured contact data inside notes when a structured field exists.',
    'If someone says they changed companies, joined a company, or went to a company, record the new company in facts with field="company".',
    'Few-shot example: text "王磊：我上个月跳槽去了翎点科技" -> include a fact like {"subject_name":"王磊","field":"company","value":"翎点科技","source_quote":"我上个月跳槽去了翎点科技"}.',
    'confidence must be one of: high, medium, low.',
    'Return JSON only.',
    'Schema requirements:',
    '- participants: array of people explicitly shown or mentioned in the screenshot. Include name, is_self, optional aliases/company/title/phone/wechat_id/notes, confidence, source_quote.',
    '- events: array of explicit meetings or appointments. Include kind, title, time_text, time_iso or null, has_time_signal, optional location/agenda, participant_names, confidence, source_quote.',
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
