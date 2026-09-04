import assert from "node:assert/strict";
import test from "node:test";

import { formatConfirmTime } from "../time-format";

test("a midnight time_iso with a time-of-day word in time_text shows the date and that word", () => {
  assert.equal(
    formatConfirmTime("2026-08-26T00:00:00+08:00", "明天上午"),
    "8月26日（周三）上午",
  );
});

test("a time_iso with a real clock time shows the date and HH:MM", () => {
  assert.equal(
    formatConfirmTime("2026-08-28T10:30:00+08:00", "下周五上午十点半"),
    "8月28日（周五）10:30",
  );
});

test("a null time_iso formats to null", () => {
  assert.equal(formatConfirmTime(null, "改天"), null);
});

test("an unparsable time_iso formats to null", () => {
  assert.equal(formatConfirmTime("not-a-real-date", "改天"), null);
});

test("a midnight time_iso without any time-of-day word shows only the date", () => {
  assert.equal(
    formatConfirmTime("2026-08-26T00:00:00+08:00", "下周三"),
    "8月26日（周三）",
  );
});
