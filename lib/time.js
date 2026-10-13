/**
 * dsh-session-clock / time.js
 *
 * 时区解析与时间/时长格式化。零外部依赖，只用 Intl。
 *
 * 这里的时间戳格式刻意与宿主内置 `@deepseek-ai/dsh-time-context` 保持一致
 * （`YYYY-MM-DDTHH:mm:ss+HH:MM[IANA]`），这样同一个模型看到的两种注入不会
 * 出现格式冲突。
 */

/** 粗筛：允许 `Asia/Shanghai`、`UTC`、`Etc/GMT+8` 这类写法。 */
const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/;

/**
 * 把配置里的时区字符串规范化成 Intl 认可的 IANA 名。
 *
 * @param {unknown} input 配置值；空串 / 空值表示"用进程时区"。
 * @returns {{ok: true, timeZone: string} | {ok: false, reason: string}}
 */
export function normalizeTimeZone(input) {
  if (input === undefined || input === null || input === '') {
    try {
      return { ok: true, timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone };
    } catch {
      return { ok: false, reason: 'failed to resolve the system time zone' };
    }
  }
  if (typeof input !== 'string' || !TIME_ZONE_SHAPE.test(input)) {
    return { ok: false, reason: `invalid IANA time zone ${JSON.stringify(input)}` };
  }
  let canonical;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: input }).resolvedOptions().timeZone;
  } catch {
    return { ok: false, reason: `invalid IANA time zone ${JSON.stringify(input)}` };
  }
  return { ok: true, timeZone: canonical };
}

/**
 * 建一个该时区的时间戳 formatter。调用方负责缓存。
 *
 * @param {string} timeZone 已规范化的 IANA 名，空串走进程时区。
 */
export function createTimestampFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * 渲染 `2026-10-13T09:49:48+08:00[Asia/Shanghai]`。
 *
 * @param {number} now epoch ms
 * @param {Intl.DateTimeFormat} formatter 由 createTimestampFormatter 产出
 * @param {string} timeZone 规范化后的 IANA 名；空串则省略方括号部分
 */
export function formatTimestamp(now, formatter, timeZone) {
  const parts = {};
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
  const raw = parts.timeZoneName ?? 'GMT';
  // longOffset 给出 `GMT+08:00`，UTC 时只给 `GMT`。
  const offset = raw.replace(/^GMT$/, 'GMT+00:00').slice(3);
  const stamp = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  return timeZone ? `${stamp}[${timeZone}]` : stamp;
}

/**
 * 人性化时长：`1d 2h 3m 4s`，秒永远保留，零值项省略。
 *
 * @param {number} elapsedMs
 */
export function formatDuration(elapsedMs) {
  const total = Math.floor(Math.max(0, Number(elapsedMs) || 0) / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/** 判断一个时间字符串是否是合法的 IANA 名（用于来自浏览器的值）。 */
export function isCanonicalTimeZone(value) {
  if (typeof value !== 'string' || !TIME_ZONE_SHAPE.test(value)) return false;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone === value;
  } catch {
    return false;
  }
}
