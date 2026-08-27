type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

type TimeParts = {
  hour: number;
  minute: number;
};

type ParsedTime = TimeParts & {
  dayOffset: number;
};

type ShanghaiDateTimeParts = CalendarDate &
  TimeParts & {
    weekday: number;
  };

type Period = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening';

const shanghaiOffsetHours = 8;
const shanghaiOffsetMilliseconds = shanghaiOffsetHours * 60 * 60 * 1000;
const chineseDigitMap: Record<string, number> = {
  '0': 0,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '〇': 0,
  '零': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
};
const weekdayMap: Record<string, number> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 0,
  '一': 1,
  '二': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '日': 0,
  '天': 0,
  '末': 0,
};
const chineseNumberCharacterPattern = /[0-9〇零一二两三四五六七八九十]/u;
const timeContinuationPattern =
  /^(?:凌晨|早上|早晨|清晨|上午|中午|下午|晚上|今晚|明晚|傍晚|晚间|夜里|[0-9〇零一二两三四五六七八九十]{1,4}(?::\d{1,2})?|[0-9〇零一二两三四五六七八九十]{1,4}(?:点|时))/u;
const dateTailBoundaryPattern = /^[,，.。!！?？:：;；、)）\]】}"”'’]/u;

function normalizeTimeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/礼拜/gu, '星期')
    .replace(/週/gu, '周');
}

function getShanghaiDateTimeParts(now: Date): ShanghaiDateTimeParts {
  const shifted = new Date(now.getTime() + shanghaiOffsetMilliseconds);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

function parseChineseNumber(token: string): number | null {
  if (!token) {
    return null;
  }

  if (/^\d+$/u.test(token)) {
    return Number.parseInt(token, 10);
  }

  let total = 0;
  let current = 0;

  for (const character of token) {
    if (character === '十') {
      total += (current || 1) * 10;
      current = 0;
      continue;
    }

    const digit = chineseDigitMap[character];

    if (digit == null) {
      return null;
    }

    current = current * 10 + digit;
  }

  return total + current;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function toEpochMilliseconds(date: CalendarDate, time: TimeParts): number {
  return Date.UTC(date.year, date.month - 1, date.day, time.hour - shanghaiOffsetHours, time.minute, 0);
}

function compareCalendarDate(left: CalendarDate, right: CalendarDate): number {
  if (left.year !== right.year) {
    return left.year - right.year;
  }

  if (left.month !== right.month) {
    return left.month - right.month;
  }

  return left.day - right.day;
}

function addDays(date: CalendarDate, deltaDays: number): CalendarDate {
  const nextDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  nextDate.setUTCDate(nextDate.getUTCDate() + deltaDays);

  return {
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
  };
}

function formatIso(date: CalendarDate, time: TimeParts): string {
  const pad = (value: number) => value.toString().padStart(2, '0');

  return `${date.year.toString().padStart(4, '0')}-${pad(date.month)}-${pad(date.day)}T${pad(time.hour)}:${pad(time.minute)}:00+08:00`;
}

function toMondayBasedWeekday(weekday: number): number {
  return weekday === 0 ? 7 : weekday;
}

function getWeekdayDelta(
  currentWeekday: number,
  targetWeekday: number,
  weekOffset: number,
  isBare: boolean,
): number {
  const current = toMondayBasedWeekday(currentWeekday);
  const target = toMondayBasedWeekday(targetWeekday);

  if (isBare) {
    return (target - current + 7) % 7;
  }

  return target - current + weekOffset * 7;
}

function detectPeriod(text: string): Period | null {
  if (text.includes('凌晨')) {
    return 'dawn';
  }

  if (text.includes('早上') || text.includes('早晨') || text.includes('清晨') || text.includes('上午')) {
    return 'morning';
  }

  if (text.includes('中午')) {
    return 'noon';
  }

  if (text.includes('下午')) {
    return 'afternoon';
  }

  if (
    text.includes('晚上') ||
    text.includes('今晚') ||
    text.includes('明晚') ||
    text.includes('傍晚') ||
    text.includes('晚间') ||
    text.includes('夜里')
  ) {
    return 'evening';
  }

  return null;
}

function applyPeriod(hour: number, period: Period): ParsedTime | null {
  if (hour < 0 || hour > 23) {
    return null;
  }

  if (period === 'dawn' || period === 'morning') {
    if (hour > 12) {
      return null;
    }

    return {
      hour: hour === 12 ? 0 : hour,
      minute: 0,
      dayOffset: 0,
    };
  }

  if (period === 'noon') {
    if (hour > 12) {
      return null;
    }

    if (hour >= 1 && hour <= 10) {
      return {
        hour: hour + 12,
        minute: 0,
        dayOffset: 0,
      };
    }

    return {
      hour: hour === 0 ? 12 : hour,
      minute: 0,
      dayOffset: 0,
    };
  }

  if (period === 'afternoon') {
    if (hour === 0 || hour > 23) {
      return null;
    }

    return {
      hour: hour <= 11 ? hour + 12 : hour,
      minute: 0,
      dayOffset: 0,
    };
  }

  if (hour === 12) {
    return { hour: 0, minute: 0, dayOffset: 1 };
  }

  if (hour === 0 || hour > 23) {
    return null;
  }

  return {
    hour: hour <= 11 ? hour + 12 : hour,
    minute: 0,
    dayOffset: 0,
  };
}

function parseTime(text: string): ParsedTime | null {
  const period = detectPeriod(text);
  const colonMatch = text.match(/(\d{1,2}):(\d{1,2})/u);

  if (colonMatch) {
    const hour = Number.parseInt(colonMatch[1], 10);
    const minute = Number.parseInt(colonMatch[2], 10);
    const adjustedTime = period ? applyPeriod(hour, period) : { hour, minute, dayOffset: 0 };

    if (adjustedTime == null || minute < 0 || minute > 59) {
      return null;
    }

    return { ...adjustedTime, minute };
  }

  const clockPattern =
    /([0-9〇零一二两三四五六七八九十]{1,4})(?:点|时)(?:(半)|([0-9〇零一二两三四五六七八九十]{1,4})分?)?/gu;
  let sawClockCandidate = false;

  for (const clockMatch of text.matchAll(clockPattern)) {
    const matchIndex = clockMatch.index ?? 0;
    const weekdayPrefix =
      text[matchIndex - 1] === '周' || text.slice(Math.max(0, matchIndex - 2), matchIndex) === '星期';
    const hourToken =
      weekdayPrefix && clockMatch[1].length > 1 ? clockMatch[1].slice(1) : clockMatch[1];

    if (weekdayPrefix && clockMatch[1].length === 1) {
      continue;
    }

    sawClockCandidate = true;
    const parsedHour = parseChineseNumber(hourToken);
    const parsedMinute = clockMatch[2] ? 30 : parseChineseNumber(clockMatch[3] ?? '0');

    if (parsedHour == null || parsedMinute == null) {
      continue;
    }

    const adjustedTime = period
      ? applyPeriod(parsedHour, period)
      : { hour: parsedHour, minute: parsedMinute, dayOffset: 0 };

    if (adjustedTime == null || parsedMinute < 0 || parsedMinute > 59) {
      continue;
    }

    return { ...adjustedTime, minute: parsedMinute };
  }

  if (sawClockCandidate) {
    return null;
  }

  if (period === 'dawn') {
    return { hour: 1, minute: 0, dayOffset: 0 };
  }

  if (period === 'morning') {
    return { hour: 9, minute: 0, dayOffset: 0 };
  }

  if (period === 'noon') {
    return { hour: 12, minute: 0, dayOffset: 0 };
  }

  if (period === 'afternoon') {
    return { hour: 15, minute: 0, dayOffset: 0 };
  }

  if (period === 'evening') {
    return { hour: 19, minute: 0, dayOffset: 0 };
  }

  return null;
}

function pickAbsoluteMonthDay(
  month: number,
  day: number,
  current: CalendarDate,
): CalendarDate | null {
  for (let year = current.year; year <= current.year + 8; year += 1) {
    if (!isValidDate(year, month, day)) {
      continue;
    }

    const candidate = { year, month, day };

    if (compareCalendarDate(candidate, current) >= 0) {
      return candidate;
    }
  }

  return null;
}

function pickNearestFutureDayOfMonth(
  day: number,
  current: CalendarDate,
): CalendarDate | null {
  for (let monthOffset = 0; monthOffset < 24; monthOffset += 1) {
    const monthIndex = current.month - 1 + monthOffset;
    const year = current.year + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;

    if (!isValidDate(year, month, day)) {
      continue;
    }

    const candidate = { year, month, day };

    if (compareCalendarDate(candidate, current) >= 0) {
      return candidate;
    }
  }

  return null;
}

function parseRelativeDay(text: string): number | null {
  if (text.includes('大后天')) {
    return 3;
  }

  if (text.includes('后天')) {
    return 2;
  }

  if (text.includes('明天') || text.includes('明日') || text.includes('明晚')) {
    return 1;
  }

  if (text.includes('今天') || text.includes('今日') || text.includes('今晚')) {
    return 0;
  }

  return null;
}

function hasOrdinalLeadBoundary(text: string, matchIndex: number): boolean {
  if (matchIndex <= 0) {
    return true;
  }

  const previousCharacter = text[matchIndex - 1];

  return previousCharacter !== '第' && !chineseNumberCharacterPattern.test(previousCharacter);
}

function hasDateTailBoundary(text: string, endIndex: number): boolean {
  if (endIndex >= text.length) {
    return true;
  }

  const rest = text.slice(endIndex);

  return dateTailBoundaryPattern.test(rest) || timeContinuationPattern.test(rest);
}

function hasWeekdayMatchBoundary(text: string, matchIndex: number): boolean {
  if (!hasOrdinalLeadBoundary(text, matchIndex)) {
    return false;
  }

  if (matchIndex <= 0) {
    return true;
  }

  const previousCharacter = text[matchIndex - 1];

  if (previousCharacter === '下' || previousCharacter === '这' || previousCharacter === '本' || previousCharacter === '周') {
    return false;
  }

  return text.slice(Math.max(0, matchIndex - 2), matchIndex) !== '星期';
}

function parseWeekday(text: string): { weekday: number; weekOffset: number; isBare: boolean } | null {
  const weekdayPattern =
    /(?:(下下|下|这|本)?(?:周|星期))([一二三四五六日天末1234567])(?![点时])/gu;

  for (const match of text.matchAll(weekdayPattern)) {
    const matchIndex = match.index ?? 0;

    if (!hasWeekdayMatchBoundary(text, matchIndex)) {
      continue;
    }

    const weekday = weekdayMap[match[2]];

    if (weekday == null) {
      continue;
    }

    return {
      weekday,
      weekOffset: match[1] === '下下' ? 2 : match[1] === '下' ? 1 : 0,
      isBare: !match[1],
    };
  }

  return null;
}

function parseCalendarDate(
  text: string,
  now: Date,
  time: ParsedTime,
  allowTimeOnlyFallback: boolean,
): CalendarDate | null {
  const current = getShanghaiDateTimeParts(now);
  const monthDayPattern =
    /(?:(\d+|[〇零一二两三四五六七八九十]{1,4})月)?(\d+|[〇零一二两三四五六七八九十]{1,4})(?:日|号)/gu;

  for (const monthDayMatch of text.matchAll(monthDayPattern)) {
    const matchIndex = monthDayMatch.index ?? 0;
    const matchText = monthDayMatch[0];

    if (!hasOrdinalLeadBoundary(text, matchIndex) || !hasDateTailBoundary(text, matchIndex + matchText.length)) {
      continue;
    }

    const month = monthDayMatch[1] ? parseChineseNumber(monthDayMatch[1]) : null;
    const day = parseChineseNumber(monthDayMatch[2]);

    if (day == null) {
      return null;
    }

    if (month != null) {
      return month >= 1 && month <= 12 ? pickAbsoluteMonthDay(month, day, current) : null;
    }

    return pickNearestFutureDayOfMonth(day, current);
  }

  const relativeDay = parseRelativeDay(text);

  if (relativeDay != null) {
    return addDays(current, relativeDay);
  }

  const weekday = parseWeekday(text);

  if (weekday) {
    const deltaDays = getWeekdayDelta(
      current.weekday,
      weekday.weekday,
      weekday.weekOffset,
      weekday.isBare,
    );
    return addDays(current, deltaDays);
  }

  if (!allowTimeOnlyFallback) {
    return null;
  }

  const candidate = { year: current.year, month: current.month, day: current.day };
  const explicitPeriod = detectPeriod(text);

  if (explicitPeriod) {
    return candidate;
  }

  const candidateWithCarry = addDays(candidate, time.dayOffset);

  if (toEpochMilliseconds(candidateWithCarry, time) > now.getTime()) {
    return candidate;
  }

  return addDays(candidate, 1);
}

function combineDateAndTime(
  date: CalendarDate,
  time: ParsedTime,
): { date: CalendarDate; time: TimeParts } | null {
  const combinedDate = addDays(date, time.dayOffset);

  if (
    !isValidDate(combinedDate.year, combinedDate.month, combinedDate.day) ||
    time.hour < 0 ||
    time.hour > 23 ||
    time.minute < 0 ||
    time.minute > 59
  ) {
    return null;
  }

  return {
    date: combinedDate,
    time: {
      hour: time.hour,
      minute: time.minute,
    },
  };
}

export function resolveChineseTime(timeText: string, now: Date): string | null {
  const normalized = normalizeTimeText(timeText);

  if (!normalized) {
    return null;
  }

  const parsedTime = parseTime(normalized);

  if (!parsedTime && /[:点时]/u.test(normalized)) {
    return null;
  }

  const time = parsedTime ?? { hour: 9, minute: 0, dayOffset: 0 };
  const date = parseCalendarDate(normalized, now, time, parsedTime != null);

  if (!date) {
    return null;
  }

  const combined = combineDateAndTime(date, time);

  if (!combined) {
    return null;
  }

  return formatIso(combined.date, combined.time);
}
