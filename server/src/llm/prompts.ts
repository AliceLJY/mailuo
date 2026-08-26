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

export function buildPerceptionSystemPrompt(now: Date): string {
  return [
    'You extract only evidence that is visible in the screenshot and optional user note.',
    'Never infer hidden context, unstated identities, or unstated relationships.',
    `Current datetime (Asia/Shanghai): ${formatShanghaiDateTime(now)}`,
    'If the screenshot uses relative time like tomorrow or next Wednesday, resolve it to ISO 8601 using Asia/Shanghai and also preserve the original time_text.',
    'Every participant, event, fact, and quote must include an exact source_quote copied from the screenshot when applicable.',
    'confidence must be one of: high, medium, low.',
    'Return JSON only.',
    'Schema requirements:',
    '- participants: array of people explicitly shown or mentioned in the screenshot. Include name, optional aliases/company/title/phone/wechat_id/notes, confidence, source_quote.',
    '- events: array of explicit meetings or appointments. Include kind, title, time_text, time_iso or null, optional location/agenda, participant_names, confidence, source_quote.',
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
