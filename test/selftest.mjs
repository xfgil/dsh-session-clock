/**
 * dsh-session-clock / test/selftest.mjs
 *
 * 零依赖自测：只测纯函数（时区解析 / 时间格式化 / 时长格式化）与
 * 「检测不到时区就落到北京时间」这条 2026-10-19 加的策略。
 *
 *   node test/selftest.mjs
 */

import {
  FALLBACK_TIME_ZONE,
  createTimestampFormatter,
  formatDuration,
  formatTimestamp,
  isCanonicalTimeZone,
  isUsableClientTimeZone,
  isUtcLike,
  normalizeTimeZone,
} from '../lib/time.js';

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✘ ${label}\n      期望 ${e}\n      实际 ${a}`);
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

// ---------------------------------------------------------------- 兜底时区

section('兜底时区：检测不到就是北京时间');

eq(FALLBACK_TIME_ZONE, 'Asia/Shanghai', 'FALLBACK_TIME_ZONE 是 Asia/Shanghai');

for (const [input, label] of [
  [undefined, 'undefined'],
  [null, 'null'],
  ['', '空串'],
]) {
  const zone = normalizeTimeZone(input);
  eq(zone.ok, true, `${label} 不再让插件停用`);
  eq(zone.isFallback, false, `${label} 在本机（Asia/Shanghai）算检测成功而非兜底`);
  eq(zone.timeZone, 'Asia/Shanghai', `${label} 得到 Asia/Shanghai`);
}

// 模拟「进程时区是 UTC」——容器 / 服务器 / 装系统没选区域的常见形态。
// 用 TZ 无法在这个进程内改（Intl 已缓存），所以直接测 isUtcLike 判据。
section('UTC 一律当成「没检测到」');

for (const z of ['UTC', 'GMT', 'Etc/UTC', 'Etc/UCT', 'Etc/GMT', 'Etc/GMT+0', 'Etc/GMT-0', 'Etc/Universal', 'Etc/Zulu']) {
  eq(isUtcLike(z), true, `isUtcLike(${z}) = true`);
  eq(isUsableClientTimeZone(z) && z === 'Asia/Shanghai', false, `${z} 不能当浏览器时区用`);
}
for (const z of ['Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Europe/London']) {
  eq(isUtcLike(z), false, `isUtcLike(${z}) = false`);
}

section('非法配置值也兜底，不停摆');

for (const bad of ['Mars/Base', 'not a zone', 'Asia/Nowhere', 42, {}]) {
  const zone = normalizeTimeZone(bad);
  eq(zone.ok, true, `${JSON.stringify(bad)} 不停用插件`);
  eq(zone.isFallback, true, `${JSON.stringify(bad)} 标记为兜底`);
  eq(zone.timeZone, 'Asia/Shanghai', `${JSON.stringify(bad)} 落到北京时间`);
  ok(typeof zone.reason === 'string' && zone.reason.length > 0, `${JSON.stringify(bad)} 带失败原因`);
}

section('显式配置优先于兜底');

eq(normalizeTimeZone('Asia/Tokyo').timeZone, 'Asia/Tokyo', 'Asia/Tokyo 原样生效');
eq(normalizeTimeZone('Asia/Tokyo').isFallback, false, 'Asia/Tokyo 不算兜底');
eq(normalizeTimeZone('Asia/shanghai').timeZone, 'Asia/Shanghai', '大小写不规范会被 Intl 规范化');
eq(normalizeTimeZone('UTC').timeZone, 'UTC', '显式写 UTC 时尊重配置（只把「检测不到」当 UTC）');
eq(normalizeTimeZone('UTC').isFallback, false, '显式 UTC 不是兜底');

section('自定义兜底时区');

eq(normalizeTimeZone('Mars/Base', 'Asia/Tokyo').timeZone, 'Asia/Tokyo', '可传入别的兜底值');
eq(normalizeTimeZone('Mars/Base', 'Also/Bogus').timeZone, 'UTC', '兜底值本身非法时最后退到 UTC');

// ---------------------------------------------------------------- 浏览器时区

section('浏览器时区：UTC 视为没报');

eq(isUsableClientTimeZone('Asia/Shanghai'), true, 'Asia/Shanghai 可用');
eq(isUsableClientTimeZone('UTC'), false, 'UTC 不当作有效浏览器时区');
eq(isUsableClientTimeZone(''), false, '空串不可用');
eq(isUsableClientTimeZone(undefined), false, 'undefined 不可用');
eq(isUsableClientTimeZone('Mars/Base'), false, '非法值不可用');
eq(isCanonicalTimeZone('Asia/Shanghai'), true, 'Asia/Shanghai 是规范 IANA 名');

// ---------------------------------------------------------------- 格式化

section('时间戳格式');

const shanghai = createTimestampFormatter('Asia/Shanghai');
// 2026-10-19T20:07:29+08:00 === 2026-10-19T12:07:29Z
const sample = Date.parse('2026-10-19T12:07:29Z');
eq(formatTimestamp(sample, shanghai, 'Asia/Shanghai'), '2026-10-19T20:07:29+08:00[Asia/Shanghai]', '带方括号的 IANA 名');
eq(formatTimestamp(sample, shanghai, ''), '2026-10-19T20:07:29+08:00', '空时区时省略方括号');

const utcFormatter = createTimestampFormatter('UTC');
eq(formatTimestamp(sample, utcFormatter, 'UTC'), '2026-10-19T12:07:29+00:00[UTC]', 'UTC 偏移渲染成 +00:00');

section('时长格式');

eq(formatDuration(0), '0s', '0 毫秒');
eq(formatDuration(1000), '1s', '1 秒');
eq(formatDuration(90_000), '1m 30s', '1 分 30 秒');
eq(formatDuration(3_661_000), '1h 1m 1s', '1 小时 1 分 1 秒');
eq(formatDuration(90_061_000), '1d 1h 1m 1s', '1 天 1 小时 1 分 1 秒');
eq(formatDuration(-5000), '0s', '负数夹到 0');
eq(formatDuration('abc'), '0s', '非数字夹到 0');

// ----------------------------------------------------------------

console.log(`\n${'='.repeat(56)}`);
console.log(`pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
