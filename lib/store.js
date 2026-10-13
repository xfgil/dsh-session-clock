/**
 * dsh-session-clock / store.js
 *
 * 「上次活跃时间」的持久化。宿主没有常规运行日志、也没有跨会话的内存状态，
 * 而"距上次会话过去多久"必须在 DS H 重启后依然成立，所以这里自己落盘一个
 * 小 JSON：{ version, sessions: { [sessionId]: { lastUserAt, lastSeenAt, createdAt } } }。
 *
 * 写入策略：合并后的延迟写 + 临时文件 rename（原子替换），避免频繁 IO 与半截文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const VERSION = 1;
/** 只保留最近这么多条会话记录，防止文件无限增长。 */
const MAX_RECORDS = 5000;

/**
 * 解析默认的状态文件位置。优先 DSH_HOME，其次 ~/.dsh。
 *
 * @param {string} [override] 配置里的 stateFile，为空则用默认值
 */
export function defaultStateFile(override) {
  if (typeof override === 'string' && override.trim() !== '') return override;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'session-clock', 'activity.json');
}

/**
 * 打开一个延迟写的记录表。
 *
 * @param {object} options
 * @param {string} options.file 状态文件绝对路径
 * @param {(level: string, message: string, extra?: unknown) => void} options.log
 * @param {number} [options.flushMs] 合并写窗口
 */
export function openStore({ file, log, flushMs = 1500 }) {
  /** @type {Map<string, Record<string, unknown>>} */
  const records = new Map();
  /** 跨会话的全局指针（当前只有 lastActivityAt）。 */
  let globals = {};
  let dirty = false;
  let timer = null;
  let closed = false;

  function load() {
    try {
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.global && typeof parsed.global === 'object') globals = { ...parsed.global };
      const sessions = parsed.sessions;
      if (!sessions || typeof sessions !== 'object') return;
      for (const [id, value] of Object.entries(sessions)) {
        if (!value || typeof value !== 'object') continue;
        // 逐字段规整，但**不丢弃**订阅里写进去的键（previousUserAt / lastTurnEndAt /
        // turns / idleBaseline）——早期版本只保留四个字段，导致重启后间隔退化。
        records.set(id, {
          lastUserAt: numberOrNull(value.lastUserAt),
          previousUserAt: numberOrNull(value.previousUserAt),
          lastSeenAt: numberOrNull(value.lastSeenAt),
          lastTurnEndAt: numberOrNull(value.lastTurnEndAt),
          idleBaseline: numberOrNull(value.idleBaseline),
          turns: numberOrNull(value.turns) ?? 0,
          createdAt: numberOrNull(value.createdAt),
          cwd: typeof value.cwd === 'string' ? value.cwd : null,
        });
      }
    } catch (error) {
      log('warn', `状态文件读取失败（按空表继续）：${describe(error)}`);
    }
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty || closed) return;
    dirty = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const payload = { version: VERSION, savedAt: Date.now(), global: globals, sessions: Object.fromEntries(records) };
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      log('warn', `状态文件写入失败：${describe(error)}`);
    }
  }

  function schedule() {
    dirty = true;
    if (closed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function prune() {
    if (records.size <= MAX_RECORDS) return;
    const sorted = [...records.entries()].sort(
      (left, right) => (right[1].lastSeenAt ?? right[1].lastUserAt ?? 0) - (left[1].lastSeenAt ?? left[1].lastUserAt ?? 0),
    );
    records.clear();
    for (const [id, value] of sorted.slice(0, MAX_RECORDS)) records.set(id, value);
  }

  load();

  return {
    file,
    get size() {
      return records.size;
    },
    get(id) {
      return records.get(id);
    },
    /** 读全局指针（跨会话共享的那几个值）。 */
    getGlobal() {
      return globals;
    },
    /** 合并写全局指针。 */
    setGlobal(patch) {
      if (closed) return globals;
      globals = { ...globals, ...patch };
      schedule();
      return globals;
    },
    /** 覆盖写一条记录。 */
    set(id, patch) {
      if (closed) return undefined;
      const next = { ...(records.get(id) ?? {}), ...patch };
      records.set(id, next);
      prune();
      schedule();
      return next;
    },
    entries() {
      return records.entries();
    },
    flush,
    close() {
      if (closed) return;
      flush();
      closed = true;
      try {
        const tmp = `${file}.tmp`;
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* 清理临时文件失败不影响退出 */
      }
    },
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
