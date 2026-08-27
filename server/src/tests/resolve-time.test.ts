import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveChineseTime } from '../agent/resolve-time.ts';

const proposalNow = new Date('2026-08-27T02:00:00.000Z');
const crossDayNow = new Date('2026-08-26T16:30:00.000Z');

test('resolveChineseTime handles relative-day phrases without filtering explicit dates by now', () => {
  assert.equal(resolveChineseTime('今天', proposalNow), '2026-08-27T09:00:00+08:00');
  assert.equal(resolveChineseTime('今日', proposalNow), '2026-08-27T09:00:00+08:00');
  assert.equal(resolveChineseTime('今晚', proposalNow), '2026-08-27T19:00:00+08:00');
  assert.equal(resolveChineseTime('明天', proposalNow), '2026-08-28T09:00:00+08:00');
  assert.equal(resolveChineseTime('明日', proposalNow), '2026-08-28T09:00:00+08:00');
  assert.equal(resolveChineseTime('明晚', proposalNow), '2026-08-28T19:00:00+08:00');
  assert.equal(resolveChineseTime('后天', proposalNow), '2026-08-29T09:00:00+08:00');
  assert.equal(resolveChineseTime('大后天', proposalNow), '2026-08-30T09:00:00+08:00');
  assert.equal(resolveChineseTime('今天上午', proposalNow), '2026-08-27T09:00:00+08:00');
  assert.equal(resolveChineseTime('今天凌晨1点', proposalNow), '2026-08-27T01:00:00+08:00');
});

test('resolveChineseTime handles week phrases with bare-week future bias only on the date', () => {
  assert.equal(resolveChineseTime('本周三', proposalNow), '2026-08-26T09:00:00+08:00');
  assert.equal(resolveChineseTime('这周四上午', proposalNow), '2026-08-27T09:00:00+08:00');
  assert.equal(resolveChineseTime('本周日', proposalNow), '2026-08-30T09:00:00+08:00');
  assert.equal(resolveChineseTime('这周末', proposalNow), '2026-08-30T09:00:00+08:00');
  assert.equal(resolveChineseTime('周三', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('周日', proposalNow), '2026-08-30T09:00:00+08:00');
  assert.equal(resolveChineseTime('星期三', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('下周三', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('下星期三', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('下周日', proposalNow), '2026-09-06T09:00:00+08:00');
  assert.equal(resolveChineseTime('下周末', proposalNow), '2026-09-06T09:00:00+08:00');
  assert.equal(resolveChineseTime('下星期天', proposalNow), '2026-09-06T09:00:00+08:00');
  assert.equal(resolveChineseTime('下下周一', proposalNow), '2026-09-07T09:00:00+08:00');
  assert.equal(resolveChineseTime('下下周末', proposalNow), '2026-09-13T09:00:00+08:00');
});

test('resolveChineseTime rejects malformed weekday prefixes without breaking natural sentences', () => {
  assert.equal(resolveChineseTime('下下下周三', proposalNow), null);
  assert.equal(resolveChineseTime('下下下周一', proposalNow), null);
  assert.equal(resolveChineseTime('下下下周日', proposalNow), null);
  assert.equal(resolveChineseTime('下下下周末', proposalNow), null);
  assert.equal(resolveChineseTime('本本周三', proposalNow), null);
  assert.equal(resolveChineseTime('这这周日', proposalNow), null);
  assert.equal(resolveChineseTime('我们下下周三下午三点见', proposalNow), '2026-09-09T15:00:00+08:00');
  assert.equal(resolveChineseTime('约在本周三下午三点见', proposalNow), '2026-08-26T15:00:00+08:00');
});

test('resolveChineseTime handles month-day and bare day-of-month phrases', () => {
  assert.equal(resolveChineseTime('9月2号上午', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('9月2日晚上8点', proposalNow), '2026-09-02T20:00:00+08:00');
  assert.equal(resolveChineseTime('8月27号上午', proposalNow), '2026-08-27T09:00:00+08:00');
  assert.equal(resolveChineseTime('1月2号上午', proposalNow), '2027-01-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('2号', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('27号上午', proposalNow), '2026-08-27T09:00:00+08:00');
  assert.equal(resolveChineseTime('2号上午', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('1月2号下午3点', proposalNow), '2027-01-02T15:00:00+08:00');
});

test('resolveChineseTime handles default periods, 点时半分, and digit variants', () => {
  assert.equal(resolveChineseTime('今天早上', proposalNow), '2026-08-27T09:00:00+08:00');
  assert.equal(resolveChineseTime('今天上午', proposalNow), '2026-08-27T09:00:00+08:00');
  assert.equal(resolveChineseTime('今天中午', proposalNow), '2026-08-27T12:00:00+08:00');
  assert.equal(resolveChineseTime('今天下午', proposalNow), '2026-08-27T15:00:00+08:00');
  assert.equal(resolveChineseTime('今天傍晚', proposalNow), '2026-08-27T19:00:00+08:00');
  assert.equal(resolveChineseTime('今天晚上', proposalNow), '2026-08-27T19:00:00+08:00');
  assert.equal(resolveChineseTime('今晚12点', proposalNow), '2026-08-28T00:00:00+08:00');
  assert.equal(resolveChineseTime('今天晚上12点', proposalNow), '2026-08-28T00:00:00+08:00');
  assert.equal(resolveChineseTime('明晚12点', proposalNow), '2026-08-29T00:00:00+08:00');
  assert.equal(resolveChineseTime('晚上12点', proposalNow), '2026-08-28T00:00:00+08:00');
  assert.equal(resolveChineseTime('下午12点', proposalNow), '2026-08-27T12:00:00+08:00');
  assert.equal(resolveChineseTime('中午12点', proposalNow), '2026-08-27T12:00:00+08:00');
  assert.equal(resolveChineseTime('上午12点', proposalNow), '2026-08-27T00:00:00+08:00');
  assert.equal(resolveChineseTime('凌晨12点', proposalNow), '2026-08-27T00:00:00+08:00');
  assert.equal(resolveChineseTime('下周三下午3点', proposalNow), '2026-09-02T15:00:00+08:00');
  assert.equal(resolveChineseTime('下周三下午3时', proposalNow), '2026-09-02T15:00:00+08:00');
  assert.equal(resolveChineseTime('下周三下午3点半', proposalNow), '2026-09-02T15:30:00+08:00');
  assert.equal(resolveChineseTime('下周三下午三点十五分', proposalNow), '2026-09-02T15:15:00+08:00');
  assert.equal(resolveChineseTime('９月２号下午３点半', proposalNow), '2026-09-02T15:30:00+08:00');
});

test('resolveChineseTime blocks weekday false positives and keeps intended weekday+time phrases', () => {
  assert.equal(resolveChineseTime('星期三点', proposalNow), null);
  assert.equal(resolveChineseTime('下周三点半', proposalNow), null);
  assert.equal(resolveChineseTime('星期三下午3点', proposalNow), '2026-09-02T15:00:00+08:00');
  assert.equal(resolveChineseTime('周三3点', proposalNow), '2026-09-02T03:00:00+08:00');
});

test('resolveChineseTime defaults pure dates to 09:00 and respects Shanghai date boundaries from UTC', () => {
  assert.equal(resolveChineseTime('下周三', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('9月2号', proposalNow), '2026-09-02T09:00:00+08:00');
  assert.equal(resolveChineseTime('今天凌晨1点', crossDayNow), '2026-08-27T01:00:00+08:00');
  assert.equal(resolveChineseTime('明天上午', crossDayNow), '2026-08-28T09:00:00+08:00');
});

test('resolveChineseTime returns null for vague, unsupported, and invalid expressions', () => {
  assert.equal(resolveChineseTime('改天', proposalNow), null);
  assert.equal(resolveChineseTime('回头', proposalNow), null);
  assert.equal(resolveChineseTime('超能力', proposalNow), null);
  assert.equal(resolveChineseTime('第2号方案', proposalNow), null);
  assert.equal(resolveChineseTime('1月2号线', proposalNow), null);
  assert.equal(resolveChineseTime('产品第2周三复盘', proposalNow), null);
  assert.equal(resolveChineseTime('第3周日发布', proposalNow), null);
  assert.equal(resolveChineseTime('2月30号下午三点', proposalNow), null);
  assert.equal(resolveChineseTime('下周三下午二十五点', proposalNow), null);
  assert.equal(resolveChineseTime('', proposalNow), null);
});
