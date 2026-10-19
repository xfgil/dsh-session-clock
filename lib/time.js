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
 * 兜底时区：一切「检测不到」的情况都落到北京时间，而不是 UTC 或「去问用户」。
 *
 * 2026-10-19 用户要求：「检测不到时区直接按标准北京时间来」。理由是这个实例只服务
 * 一个人（国内、Asia/Shanghai），把「时区不明」抛给模型只会让它反复问、或者干脆
 * 不敢说时间；而机器时区一旦被设成 UTC（服务器、容器、改过区域设置的 Windows），
 * 进程时区就不再等于用户真实所在地，跟着它走反而会系统性偏 8 小时。
 */
export const FALLBACK_TIME_ZONE = 'Asia/Shanghai';

/**
 * 把配置里的时区字符串规范化成 Intl 认可的 IANA 名。
 *
 * 空串 / 空值表示「用进程时区」；**进程时区拿不到、或配置值非法时不再停摆**，
 * 直接落到 `fallbackZone`（默认北京时间）并回报 `isFallback: true`，由调用方
 * 记一条 warn。理由见下面 FALLBACK_TIME_ZONE 的注释。
 *
 * @param {unknown} input 配置值
 * @param {string} [fallbackZone] 检测失败时的兜底时区
 * @returns {{ok: true, timeZone: string, isFallback: boolean, reason: string|null}}
 */
export function normalizeTimeZone(input, fallbackZone = FALLBACK_TIME_ZONE) {
  const fallback = () => {
    let zone = fallbackZone;
    try {
      zone = new Intl.DateTimeFormat('en-US', { timeZone: fallbackZone }).resolvedOptions().timeZone;
    } catch {
      zone = 'UTC';
    }
    return { ok: true, timeZone: zone, isFallback: true };
  };

  if (input === undefined || input === null || input === '') {
    try {
      const detected = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      // 进程时区解析成 UTC 也算「没检测到」——本插件的场景是个人国内使用时区，
      // 走到 UTC 基本是容器 / 服务器 / 装系统时没选区域，跟着它走会系统性偏 8 小时。
      if (typeof detected === 'string' && detected !== '' && !isUtcLike(detected)) {
        return { ok: true, timeZone: detected, isFallback: false, reason: null };
      }
    } catch {
      /* 落到下面的兜底 */
    }
    return { ...fallback(), reason: 'system time zone unavailable or UTC-like' };
  }
  if (typeof input !== 'string' || !TIME_ZONE_SHAPE.test(input)) {
    return { ...fallback(), reason: `invalid IANA time zone ${JSON.stringify(input)}` };
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: input }).resolvedOptions().timeZone;
    return { ok: true, timeZone: canonical, isFallback: false, reason: null };
  } catch {
    return { ...fallback(), reason: `invalid IANA time zone ${JSON.stringify(input)}` };
  }
}

/** `UTC` / `Etc/UTC` / `Etc/GMT` / `GMT` / `Etc/Universal` 这些一律当成「没检测到」。 */
export function isUtcLike(timeZone) {
  if (typeof timeZone !== 'string') return false;
  const zone = timeZone.trim();
  return zone === 'UTC' || zone === 'GMT' || /^Etc\/(UTC|UCT|GMT|Universal|Zulu)$/i.test(zone) || /^Etc\/GMT(\+0|-0)?$/i.test(zone);
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

/**
 * 浏览器报上来的时区是否可用：既要合法，也不能是 UTC 一类的「等于没报」。
 *
 * 浏览器在系统区域没设、或用户手动把时区改成 UTC 时报的就是 `UTC`；跟着它算
 * 会让时间整体偏 8 小时，所以这类值一律当成「没检测到」，走兜底时区。
 */
export function isUsableClientTimeZone(value) {
  return isCanonicalTimeZone(value) && !isUtcLike(value);
}
