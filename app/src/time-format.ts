// Friendly rendering of a meeting's confirmed ISO time for the review screen. Fix15's
// real-machine evidence: `time_iso` is a full "2026-08-26T00:00:00+08:00" string shown
// verbatim in a single-line field, so the visible tail ("...00:00+08:00") looks unrelated
// to the correct date underneath it and gets rejected as "wrong" when it isn't.
//
// Deliberately avoids Intl/timeZone lookups: Asia/Shanghai has had a fixed UTC+8 offset
// with no DST since 1991, so shifting the UTC instant by a constant 8 hours and reading
// the UTC-labelled fields back off the shifted Date gives the correct Shanghai wall-clock
// date/time with zero ICU/timezone-database dependency.
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const TIME_OF_DAY_WORDS = ["上午", "中午", "下午", "晚上", "早上"];

export function formatConfirmTime(
  timeIso: string | null,
  timeText: string,
): string | null {
  if (!timeIso) {
    return null;
  }

  const parsed = new Date(timeIso);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const shanghai = new Date(parsed.getTime() + SHANGHAI_OFFSET_MS);
  const month = shanghai.getUTCMonth() + 1;
  const day = shanghai.getUTCDate();
  const weekdayLabel = WEEKDAY_LABELS[shanghai.getUTCDay()];
  const hour = shanghai.getUTCHours();
  const minute = shanghai.getUTCMinutes();
  const datePart = `${month}月${day}日（${weekdayLabel}）`;

  if (hour === 0 && minute === 0) {
    const timeOfDayWord = TIME_OF_DAY_WORDS.find((word) => timeText.includes(word));
    return timeOfDayWord ? `${datePart}${timeOfDayWord}` : datePart;
  }

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${datePart}${hh}:${mm}`;
}
