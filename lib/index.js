/**
 * dsh-session-clock / index.js
 *
 * 宿主内置的 `@deepseek-ai/dsh-time-context` 已经在每轮第一步注入「当前时间 /
 * 浏览器时区 / 距上一条模型可见消息多久」。实测（QQ 群会话 2680 条事件、
 * 81 次注入）确认：**`Elapsed since the preceding model-visible message` 在
 * step 1 时语义上就等于「距上次对话过去多久」**——step 1 执行时本轮的
 * user/message 尚未提交，基线落在上一轮最后一条模型可见消息上。
 *
 * 所以本插件**不重复那一维**。它补的是 time-context 结构上给不出的三件事：
 *
 *   1. **按会话开关**——`sessions` / `exceptSessions` 决定给哪些会话授时
 *      （支持 `*` 通配与 `/regex/`），内置插件对所有 agent 一视同仁；
 *   2. **跨会话指针**——「任何会话上次活跃是多久前」，内置插件不感知会话边界；
 *   3. **上一次「用户主动说话」的间隔**——排除定时/主动/工具触发的轮次。
 *
 * 另有持久化（`$DSH_HOME/session-clock/activity.json`，DSH 重启后间隔依然成立）、
 * agent 可主动查询的 `session_clock` 工具、以及 HTTP 观测面。
 *
 * `mode` 决定注入内容：
 *   - `supplement`（默认）只补上述增量，与 time-context 并存不打架；
 *   - `append` 额外给「距上一轮结束多久」，用于没装 time-context 的场景；
 *   - `full` 完整复刻 time-context 三行 + 本插件一行，用来整体接管它。
 */

import { randomUUID } from 'node:crypto';
import { createTimestampFormatter, formatDuration, formatTimestamp, isCanonicalTimeZone, normalizeTimeZone } from './time.js';
import { defaultStateFile, openStore } from './store.js';

/**
 * 宿主把 `@deepseek-ai/dsh-*` 暴露给 asar 内部的包，但 profile 层第三方插件
 * 的解析路径里不保证有它们（本机 profile 的 node_modules\@deepseek-ai 下只有
 * cosmokit 与 schemastery）。所以照 dsh-onebot-qq 的做法：受控动态加载 +
 * 本地兜底，缺了就退化成等价的手写消息，不让插件因为一个 import 直接死掉。
 */
let createUserMessage;
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'));
} catch {
  createUserMessage = undefined;
}

export const name = 'session-clock';

/**
 * 需要 `sessions` 才能把 agent 映射回会话（以及给 HTTP 接口做列表）。
 * `tools` / `webServer` 是可选能力，用 ctx.inject 局部等待。
 */
export const inject = ['sessions'];

/** 注入消息的 source.kind，同时也是幂等判据。 */
const INJECT_KIND = 'session-clock';

/**
 * 三种注入模式。
 *
 *   `supplement`（默认）——**只补 time-context 给不出的那一维**。
 *      host 内置的 `@deepseek-ai/dsh-time-context` 每轮第一步注入的
 *      `Elapsed since the preceding model-visible message` 在语义上已经等于
 *      「距上次对话过去多久」（step 1 时上一轮的 user/message 尚未提交，
 *      基线落在上一轮最后一条模型可见消息上）。所以本模式**不重复**时间戳、
 *      不重复「距上一轮结束」，只给：跨会话指针 + 本会话上一条用户消息间隔。
 *
 *   `append` —— 只补一行「距上一轮结束多久」，不重复时间戳。留给没有装
 *      time-context、或不想要完整三行的场景。
 *
 *   `full` —— time-context 的完整三行 + 本插件一行，用来整体替代 time-context
 *      （在 profile patch 里把 time-context 停用后使用）。
 */
const MODES = ['supplement', 'append', 'full'];

const DEFAULTS = {
  enabled: true,
  mode: 'supplement',
  timeZone: '',
  refreshIntervalMs: 60000,
  sessions: ['*'],
  exceptSessions: [],
  stateFile: '',
  minGapSeconds: 0,
  includeSessionId: true,
  includeTurnCount: true,
  includeGlobalIdle: true,
  includeUserGap: true,
  includeIdleSinceTurnEnd: true,
  logInjection: true,
  skipSubagents: true,
  quiet: false,
};

/** 注入去重表上限，防止长时间运行后内存增长。 */
const DEDUP_LIMIT = 512;
/** 回溯扫描历史的窗口（事件条数）。 */
const SCAN_WINDOW = 800;

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  const logger = ctx.logger ?? ctx.root?.logger;
  const logBuffer = [];
  const state = {
    enabled: cfg.enabled !== false,
    ready: false,
    tracked: 0,
    injected: 0,
    skipped: 0,
    lastInjectionAt: null,
    lastInjectionSession: null,
    lastError: null,
    since: Date.now(),
  };

  function log(level, message, extra) {
    const line = { t: Date.now(), level, message, ...(extra === undefined ? {} : { extra: stringifyExtra(extra) }) };
    logBuffer.push(line);
    if (logBuffer.length > 300) logBuffer.splice(0, logBuffer.length - 300);
    if (level === 'error') state.lastError = `${new Date(line.t).toISOString()} ${message}`;
    try {
      if (level === 'error') logger?.error?.(`[${name}] ${message}`);
      else if (level === 'warn') logger?.warn?.(`[${name}] ${message}`);
      else if (!cfg.quiet) logger?.info?.(`[${name}] ${message}`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  // ---- 时区 -------------------------------------------------------------

  const zone = normalizeTimeZone(cfg.timeZone);
  if (!zone.ok) {
    log('error', `时区配置无效（${zone.reason}），插件停用`);
    state.enabled = false;
  }
  const formatters = new Map();
  function formatterFor(timeZone) {
    const key = timeZone || '';
    let formatter = formatters.get(key);
    if (formatter === undefined) {
      formatter = createTimestampFormatter(key);
      formatters.set(key, formatter);
    }
    return formatter;
  }
  const fallbackZone = zone.ok ? zone.timeZone : 'UTC';

  // ---- 会话筛选 ---------------------------------------------------------

  const includes = compileAll(cfg.sessions, ['*']);
  const excludes = compileAll(cfg.exceptSessions, []);

  /** 注入行的开关，装配一次即可。 */
  const flags = {
    idle: cfg.includeIdleSinceTurnEnd !== false,
    userGap: cfg.includeUserGap !== false,
    global: cfg.includeGlobalIdle !== false,
  };

  function matches(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    for (const test of excludes) if (test(sessionId)) return false;
    for (const test of includes) if (test(sessionId)) return true;
    return false;
  }

  // ---- 持久化 -----------------------------------------------------------

  const storeFile = defaultStateFile(cfg.stateFile);
  const store = openStore({ file: storeFile, log });
  state.stateFile = storeFile;
  state.tracked = store.size;

  // ---- 内存记录 ---------------------------------------------------------

  /**
   * @type {Map<string, {lastUserAt:number|null, previousUserAt:number|null, activityAt:number|null,
   *   lastTurnEndAt:number|null, lastTurnInjectedAt:number|null, hydrated:boolean,
   *   lastInjectionAt:number|null, turns:number, createdAt:number|null, cwd:string|null}>}
   */
  const memory = new Map();
  const dedup = new Map();

  function recordFor(session, sessionId) {
    let rec = memory.get(sessionId);
    if (rec === undefined) {
      const saved = store.get(sessionId) ?? {};
      rec = {
        lastUserAt: num(saved.lastUserAt),
        previousUserAt: num(saved.previousUserAt),
        activityAt: num(saved.lastSeenAt),
        lastTurnEndAt: num(saved.lastTurnEndAt),
        lastTurnInjectedAt: null,
        lastInjectionAt: null,
        hydrated: false,
        turns: num(saved.turns) ?? 0,
        createdAt: session?.header?.createdAt ?? num(saved.createdAt),
        cwd: session?.header?.cwd ?? (typeof saved.cwd === 'string' ? saved.cwd : null),
      };
      memory.set(sessionId, rec);
    }
    if (!rec.hydrated && session !== undefined) {
      hydrate(rec, session);
      rec.hydrated = true;
    }
    return rec;
  }

  function persist(sessionId, rec) {
    store.set(sessionId, {
      lastUserAt: rec.lastUserAt,
      previousUserAt: rec.previousUserAt,
      lastSeenAt: rec.activityAt,
      lastTurnEndAt: rec.lastTurnEndAt,
      turns: rec.turns,
      createdAt: rec.createdAt,
      cwd: rec.cwd,
    });
    state.tracked = memory.size;
  }
  /**
   * 从会话日志回溯，恢复「上一次用户消息」「上一轮结束」两个基线。
   * DSH 重启后会话会被恢复，这一步让间隔在重启后依然正确。
   */
  function hydrate(rec, session) {
    let events;
    try {
      const end = session.seq;
      const start = Math.max(0, end - SCAN_WINDOW);
      events = session.snapshotEvents(start, end);
    } catch (error) {
      log('warn', '回溯会话历史失败（本轮按空基线处理）', error);
      return;
    }
    if (!Array.isArray(events) || events.length === 0) return;

    let lastUserAt = null;
    let previousUserAt = null;
    let lastTurnStartIdx = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'turn/start') {
        lastTurnStartIdx = index;
        break;
      }
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'user/message') continue;
      if (isOwn(event)) continue;
      if (lastUserAt === null) lastUserAt = event.time;
      else {
        previousUserAt = event.time;
        break;
      }
    }

    // 「上一轮结束」= 距上次对话过去的起点。两种情形：
    //   1) 最后一次 turn/start 之后已经出现 turn/end → 上一轮已收尾，用它；
    //   2) 否则本轮正在进行 → 本轮 turn/start 之前的最后一次活动就是上一轮的结束点。
    // 这与 live 路径里 `turn/start` 时快照 activityAt 的语义一致。
    let lastTurnEndAt = null;
    if (lastTurnStartIdx !== -1) {
      for (let index = events.length - 1; index > lastTurnStartIdx; index -= 1) {
        if (events[index]?.type === 'turn/end') {
          lastTurnEndAt = events[index].time;
          break;
        }
      }
    }
    if (lastTurnEndAt === null) {
      const before = lastTurnStartIdx === -1 ? events.length - 1 : lastTurnStartIdx - 1;
      for (let index = before; index >= 0; index -= 1) {
        const at = events[index]?.time;
        if (typeof at === 'number') {
          lastTurnEndAt = at;
          break;
        }
      }
    }

    rec.lastUserAt = lastUserAt ?? rec.lastUserAt;
    rec.previousUserAt = previousUserAt ?? rec.previousUserAt;
    rec.activityAt = events[events.length - 1]?.time ?? rec.activityAt;
    rec.lastTurnEndAt = lastTurnEndAt ?? rec.lastTurnEndAt;
    if (rec.turns === 0) {
      let turns = 0;
      for (const event of events) if (event?.type === 'turn/start') turns += 1;
      rec.turns = turns;
    }
  }

  // ---- 事件订阅 ---------------------------------------------------------

  const root = ctx.root ?? ctx;

  ctx.effect(() => {
    const off = root.on(
      'session/event',
      (session, event) => {
        try {
          onSessionEvent(session, event);
        } catch (error) {
          log('warn', '处理会话事件失败', error);
        }
      },
      { global: true },
    );
    return () => {
      try {
        off?.();
      } catch {
        /* dispose 失败无害 */
      }
    };
  }, `${name}: session feed`);

  function onSessionEvent(session, event) {
    if (!session || !event) return;
    const sessionId = session.id;
    if (typeof sessionId !== 'string') return;
    const rec = recordFor(session, sessionId);
    const type = event.type;

    if (type === 'turn/start') {
      // 快照「本轮开始前的最后一次活动」，这就是上一轮的结束点。
      if (rec.activityAt !== null && rec.activityAt !== undefined) rec.lastTurnEndAt = rec.activityAt;
      rec.turns += 1;
      rec.lastTurnInjectedAt = null;
    } else if (type === 'user/message') {
      if (!isOwn(event)) {
        rec.previousUserAt = rec.lastUserAt ?? rec.previousUserAt;
        rec.lastUserAt = event.time;
      }
    }

    rec.activityAt = event.time;
    if (rec.createdAt === null) rec.createdAt = session.header?.createdAt ?? null;
    if (rec.cwd === null) rec.cwd = session.header?.cwd ?? null;
    persist(sessionId, rec);

    // 跨会话指针：谁最后动过。用来回答「距上次（任意）会话过去多久」。
    const global = store.getGlobal();
    const knownAt = num(global?.lastActivityAt);
    if (knownAt === null || event.time >= knownAt) {
      store.setGlobal({ lastActivityAt: event.time, lastActivitySession: sessionId });
    }
  }

  // ---- 注入 -------------------------------------------------------------

  ctx.effect(() => {
    const off = root.on(
      'agent/pre-step',
      async (payload, next) => {
        const decision = await next();
        if (!state.enabled) return decision;
        try {
          if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision;
          return injectInto(payload, decision);
        } catch (error) {
          log('warn', '生成注入消息失败（本轮跳过）', error);
          return decision;
        }
      },
      { global: true, prepend: true },
    );
    return () => {
      try {
        off?.();
      } catch {
        /* 同上 */
      }
    };
  }, `${name}: pre-step`);

  /**
   * 记录一次「本步没注入」的原因再放行原决策。
   *
   * 之所以要留痕：本插件只在**每轮首步**补一条，错过 step 1 后就整轮无声无息。
   * 没有这条记录时，`injected` 停在 0 无法区分「没轮到」和「逻辑坏了」。
   */
  function skip(turn, step, sessionId, reason, decision) {
    state.lastDecision = { at: Date.now(), action: 'skip', reason, sessionId, turn, step };
    if (cfg.traceDecisions === true) log('info', `跳过 turn ${turn} step ${step}：${reason}`);
    return decision;
  }

  function injectInto(payload, decision) {
    const { agent, turn, step } = payload;
    const session = resolveSession(agent);
    if (session === undefined) {
      state.skipped += 1;
      return skip(turn, step, null, '没有可解析的会话', decision);
    }
    const sessionId = session.id;
    if (!matches(sessionId)) {
      state.skipped += 1;
      return skip(turn, step, sessionId, '不在 sessions 白名单内', decision);
    }
    if (cfg.skipSubagents !== false && session.header?.origin === 'subagent') {
      // subagent 会话数量多、生命周期短，授时收益低而 token 成本实打实。
      state.skipped += 1;
      return skip(turn, step, sessionId, 'subagent 会话', decision);
    }

    const mode = MODES.includes(cfg.mode) ? cfg.mode : DEFAULTS.mode;

    const key = `${sessionId}#${turn}#${step}`;
    if (dedup.has(key)) return skip(turn, step, sessionId, '本步已注入过（去重）', decision);

    const rec = recordFor(session, sessionId);
    const now = Date.now();

    // 只有 full 模式需要出现在每个 step（它要复刻 time-context 的逐步语义）；
    // supplement / append 都只在一轮的首步补一条，避免时间戳重复注入。
    if (mode !== 'full' && step !== 1) {
      state.skipped += 1;
      return skip(turn, step, sessionId, `mode=${mode} 只在首步注入`, decision);
    }

    const refreshIntervalMs = toCount(cfg.refreshIntervalMs) ?? DEFAULTS.refreshIntervalMs;
    const lastInjection = mode === 'append' ? rec.lastInjectionAt : rec.lastTurnInjectedAt;
    if (refreshIntervalMs > 0 && lastInjection !== null && now >= lastInjection && now - lastInjection < refreshIntervalMs) {
      state.skipped += 1;
      return skip(turn, step, sessionId, `距上次注入不足 ${refreshIntervalMs}ms`, decision);
    }

    const minGap = toCount(cfg.minGapSeconds) ?? 0;
    const idleMs = rec.lastTurnEndAt === null ? null : Math.max(0, now - rec.lastTurnEndAt);
    if (minGap > 0 && idleMs !== null && idleMs < minGap * 1000) {
      state.skipped += 1;
      return skip(turn, step, sessionId, `空闲不足 ${minGap}s`, decision);
    }

    const timeZone = timeZoneFor(payload, session);
    const formatter = formatterFor(timeZone);
    const lines = [];

    // full：完整复刻 time-context 的三行，用来整体接管它。
    if (mode === 'full') {
      const baseline = step === 1 ? rec.lastTurnEndAt ?? undefined : rec.lastTurnInjectedAt ?? undefined;
      const baselineLabel = step === 1 ? 'model-visible message' : 'step context';
      lines.push(`Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}`);
      lines.push(renderBrowserZone(payload));
      lines.push(`Elapsed since the preceding ${baselineLabel}: ${baseline === undefined ? 'unavailable' : formatDuration(now - baseline)}`);
    }

    const clock = renderClockLine(mode, sessionId, rec, now);
    if (clock !== null) lines.push(clock);

    // 一句话都没有就别注入——空消息只会污染历史、白占 token。
    if (lines.length === 0) {
      state.skipped += 1;
      return decision;
    }
    const text = lines.join('\n');

    dedup.set(key, now);
    if (dedup.size > DEDUP_LIMIT) {
      const oldest = [...dedup.entries()].sort((left, right) => left[1] - right[1]).slice(0, Math.ceil(DEDUP_LIMIT / 4));
      for (const [stale] of oldest) dedup.delete(stale);
    }

    if (step === 1) rec.lastInjectionAt = now;
    rec.lastTurnInjectedAt = now;
    state.injected += 1;
    state.lastInjectionAt = now;
    state.lastInjectionSession = sessionId;
    if (cfg.logInjection !== false) {
      log('info', `已为会话 ${sessionId} 注入时间（turn ${turn} step ${step}）`);
    }

    return {
      ...decision,
      messages: [...(decision.messages ?? []), buildMessage(text)],
    };
  }

  /**
   * 本插件的核心增量。
   *
   * ⚠️ 「距上一轮结束多久」这一维**已经由宿主内置的 time-context 覆盖**：
   * 它在每轮第一步注入的 `Elapsed since the preceding model-visible message`
   * 在语义上就等于跨轮空闲（step 1 执行时本轮的 user/message 尚未提交，
   * 基线落在上一轮最后一条模型可见消息上）。实测证据：QQ 群会话
   * seq 18 assistant/message 00:03:21 → seq 27 注入 00:08:00 报 `4m 39s`。
   *
   * 所以三种模式的分工是：
   *   - supplement：**不碰**那一维，只给 time-context 结构上给不出的两件事
   *     （上一次「用户主动说话」的间隔、跨会话指针）；
   *   - append：没有 time-context 时的兜底，给「距上一轮结束多久」；
   *   - full：完整复刻 time-context 三行 + 本插件一行，用来整体接管。
   */
  function renderClockLine(mode, sessionId, rec, now) {
    const idle = rec.lastTurnEndAt === null || rec.lastTurnEndAt === undefined
      ? null
      : Math.max(0, now - rec.lastTurnEndAt);
    const userGap = rec.previousUserAt === null || rec.previousUserAt === undefined
      ? null
      : Math.max(0, now - rec.previousUserAt);

    const clauses = [];
    if (mode !== 'supplement' && flags.idle) {
      clauses.push(`previous turn ended ${idle === null ? 'unavailable' : `${formatDuration(idle)} ago`}`);
    }
    if (flags.userGap) {
      clauses.push(`previous user message ${userGap === null ? 'unavailable' : `${formatDuration(userGap)} ago`}`);
    }
    if (flags.global) {
      const global = store.getGlobal();
      const otherAt = num(global?.lastActivityAt);
      const otherSession = typeof global?.lastActivitySession === 'string' ? global.lastActivitySession : null;
      if (otherAt !== null && now >= otherAt && otherSession !== sessionId) {
        const label = cfg.includeSessionId === false ? '' : ` (${otherSession})`;
        clauses.push(`any session last active ${formatDuration(now - otherAt)} ago${label}`);
      }
    }

    if (clauses.length === 0) return null;

    const head = cfg.includeSessionId === false ? 'Session clock' : `Session clock for ${sessionId}`;
    const turns = cfg.includeTurnCount === false || rec.turns <= 0 ? '' : `, turn ${rec.turns}`;
    return `${head}: ${clauses.join('; ')}${turns}.`;
  }

  function resolveSession(agent) {
    if (agent === undefined || agent === null) return undefined;
    if (agent.session !== undefined && agent.session !== null) return agent.session;
    const id = agent.id;
    if (typeof id === 'string') {
      try {
        return ctx.sessions?.get?.(id);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  function timeZoneFor(payload, session) {
    for (const message of payload?.messages ?? []) {
      const source = message?.source;
      if (source?.kind === 'user' && typeof source.clientTimeZone === 'string' && isCanonicalTimeZone(source.clientTimeZone)) {
        return source.clientTimeZone;
      }
    }
    return zone.ok ? zone.timeZone : fallbackZone || undefined;
  }

  function renderBrowserZone(payload) {
    const found = new Set();
    for (const message of payload?.messages ?? []) {
      const source = message?.source;
      if (source?.kind === 'user' && typeof source.clientTimeZone === 'string' && isCanonicalTimeZone(source.clientTimeZone)) {
        found.add(source.clientTimeZone);
      }
    }
    if (found.size === 0) {
      return 'Browser time zone for this request: unavailable. Ask the user to clarify. Interpret otherwise-unqualified dates and times in the authoritative zone above.';
    }
    if (found.size === 1) {
      const [only] = found;
      return `Browser time zone for this request: ${only}. Interpret otherwise-unqualified dates and times in this zone.`;
    }
    return `Browser time zone for this request: mixed ${JSON.stringify([...found])}. Ask the user to clarify. Interpret otherwise-unqualified dates and times in the authoritative zone above.`;
  }

  function buildMessage(text) {
    const input = {
      content: [{ type: 'text', text }],
      source: { kind: INJECT_KIND, form: 'snapshot', sections: [{ name: INJECT_KIND, text }] },
    };
    if (typeof createUserMessage === 'function') {
      try {
        return createUserMessage(input);
      } catch (error) {
        log('warn', 'createUserMessage 失败，改用本地兜底消息', error);
      }
    }
    return deepFreeze({
      id: randomUUID(),
      role: 'user',
      content: structuredClone(input.content),
      source: structuredClone(input.source),
    });
  }

  // ---- HTTP 观测面 ------------------------------------------------------

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: `/${name}`,
          handler: async (request, response) => {
            const reject = rejectNonLocal(request, response);
            if (reject) return reject();
            try {
              await handleHttp(request, response);
            } catch (error) {
              sendJson(response, 500, { ok: false, error: describe(error) });
            }
          },
        }),
      `${name}: http`,
    );
  });

  async function handleHttp(request, response) {
    const method = (request.method ?? 'GET').toUpperCase();
    const path = stripQuery(request.url ?? '/').slice(name.length + 1) || '/';

    if (method === 'GET' || method === 'HEAD') {
      if (path === '/' || path === '') return sendJson(response, 200, snapshot());
      if (path === '/list') return sendJson(response, 200, { ok: true, sessions: sessionList() });
      if (path === '/logs') return sendJson(response, 200, { ok: true, logs: logBuffer.slice(-80) });
      return sendJson(response, 404, { ok: false, error: `unknown path ${path}` });
    }

    if (method === 'POST') {
      const body = await readJson(request);
      if (path === '/toggle') {
        state.enabled = body?.enabled === undefined ? !state.enabled : body.enabled === true;
        log('info', `插件${state.enabled ? '启用' : '停用'}`);
        return sendJson(response, 200, { ok: true, enabled: state.enabled });
      }
      if (path === '/flush') {
        store.flush();
        return sendJson(response, 200, { ok: true, stateFile: storeFile });
      }
      if (path === '/forget') {
        const id = typeof body?.session === 'string' ? body.session : undefined;
        if (id === undefined) return sendJson(response, 400, { ok: false, error: 'body.session is required' });
        memory.delete(id);
        store.set(id, { lastUserAt: null, previousUserAt: null, lastSeenAt: null, lastTurnEndAt: null });
        store.flush();
        return sendJson(response, 200, { ok: true, forgotten: id });
      }
      return sendJson(response, 404, { ok: false, error: `unknown path ${path}` });
    }

    return sendJson(response, 405, { ok: false, error: `method ${method} is not allowed` });
  }

  function snapshot() {
    return {
      ok: true,
      name,
      version: '0.1.0',
      enabled: state.enabled,
      ready: state.ready,
      mode: cfg.mode === 'full' ? 'full' : cfg.mode === 'append' ? 'append' : 'supplement',
      timeZone: zone.ok ? zone.timeZone : null,
      timeZoneError: zone.ok ? null : zone.reason,
      sessionsPatterns: includes.map(String),
      exceptPatterns: excludes.map(String),
      tracked: memory.size,
      injected: state.injected,
      skipped: state.skipped,
      lastInjectionAt: state.lastInjectionAt,
      lastInjectionSession: state.lastInjectionSession,
      lastError: state.lastError,
      lastDecision: state.lastDecision ?? null,
      uptimeMs: Date.now() - state.since,
      stateFile: storeFile,
      global: store.getGlobal(),
      endpoints: { status: `/${name}`, list: `/${name}/list`, logs: `/${name}/logs`, toggle: `/${name}/toggle`, flush: `/${name}/flush`, forget: `/${name}/forget` },
    };
  }

  function sessionList() {
    const now = Date.now();
    const rows = [];
    for (const [sessionId, rec] of memory.entries()) {
      rows.push({
        sessionId,
        matched: matches(sessionId),
        idleMs: rec.activityAt === null || rec.activityAt === undefined ? null : now - rec.activityAt,
        idleSinceTurnEndMs: rec.lastTurnEndAt === null || rec.lastTurnEndAt === undefined ? null : now - rec.lastTurnEndAt,
        sinceUserMessageMs: rec.lastUserAt === null || rec.lastUserAt === undefined ? null : now - rec.lastUserAt,
        turns: rec.turns,
        createdAt: rec.createdAt,
        cwd: rec.cwd,
        lastInjectionAt: rec.lastInjectionAt,
      });
    }
    for (const [sessionId, saved] of store.entries()) {
      if (memory.has(sessionId)) continue;
      rows.push({
        sessionId,
        matched: matches(sessionId),
        idleMs: typeof saved.lastSeenAt === 'number' ? now - saved.lastSeenAt : null,
        idleSinceTurnEndMs: typeof saved.lastTurnEndAt === 'number' ? now - saved.lastTurnEndAt : null,
        sinceUserMessageMs: typeof saved.lastUserAt === 'number' ? now - saved.lastUserAt : null,
        turns: saved.turns ?? 0,
        createdAt: saved.createdAt ?? null,
        cwd: saved.cwd ?? null,
        lastInjectionAt: null,
        persisted: true,
      });
    }
    rows.sort((left, right) => (left.idleMs ?? Infinity) - (right.idleMs ?? Infinity));
    return rows.slice(0, 100);
  }

  // ---- 工具（让 agent 自己问「多久没聊了」）-----------------------------

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'session_clock',
          description:
            '查询会话时钟：本会话（或指定会话）当前时间、距上次对话过去多久、以及已跟踪的会话列表。用于回答「我多久没来了」这类问题。',
          parameters: {
            action: {
              type: 'string',
              enum: ['now', 'list'],
              required: true,
              description: 'now = 当前时间与本会话空闲时长；list = 最近活跃的会话及其空闲时长。',
            },
            session_id: {
              type: 'string',
              required: false,
              description: 'action=now 时可选，指定要查询的会话 id；省略则用当前会话。',
            },
            limit: {
              type: 'number',
              required: false,
              description: 'action=list 时返回的条数上限，默认 20。',
            },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [
              { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
            ],
          },
          isConcurrencySafe: () => true,
          execute: async (args, exec) => {
            const action = args?.action === 'list' ? 'list' : 'now';
            if (action === 'list') {
              const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
              return sessionList()
                .slice(0, limit)
                .map((row) => ({
                  session: row.sessionId,
                  idle: row.idleMs === null ? 'unavailable' : formatDuration(row.idleMs),
                  idleSinceTurnEnd: row.idleSinceTurnEndMs === null ? 'unavailable' : formatDuration(row.idleSinceTurnEndMs),
                  turnEndedAt: row.idleSinceTurnEndMs === null ? null : new Date(Date.now() - row.idleSinceTurnEndMs).toISOString(),
                  turns: row.turns,
                  matched: row.matched,
                }));
            }
            const sessionId = typeof args?.session_id === 'string' && args.session_id !== ''
              ? args.session_id
              : typeof exec?.agent?.session?.id === 'string'
                ? exec.agent.session.id
                : undefined;
            if (sessionId === undefined) return { error: 'no session in scope; pass session_id explicitly' };
            const live = resolveSession(exec?.agent);
            const session = live?.id === sessionId ? live : ctx.sessions?.get?.(sessionId);
            const rec = session === undefined ? undefined : recordFor(session, sessionId);
            const saved = rec ?? (() => {
              const raw = store.get(sessionId);
              if (raw === undefined) return undefined;
              return {
                lastUserAt: num(raw.lastUserAt),
                previousUserAt: num(raw.previousUserAt),
                activityAt: num(raw.lastSeenAt),
                lastTurnEndAt: num(raw.lastTurnEndAt),
                lastInjectionAt: null,
                turns: num(raw.turns) ?? 0,
                createdAt: num(raw.createdAt),
                cwd: raw.cwd ?? null,
              };
            })();
            if (saved === undefined) return { session: sessionId, known: false, note: '该会话还没有被记录过' };
            const now = Date.now();
            const globalAt = num(store.getGlobal()?.lastActivityAt);
            return {
              session: sessionId,
              known: true,
              now: formatTimestamp(now, formatterFor(fallbackZone), fallbackZone),
              idleSinceTurnEnd: saved.lastTurnEndAt === null ? 'unavailable' : formatDuration(Math.max(0, now - saved.lastTurnEndAt)),
              sincePreviousUserMessage: saved.previousUserAt === null ? 'unavailable' : formatDuration(Math.max(0, now - saved.previousUserAt)),
              sinceAnySession: globalAt === null ? 'unavailable' : formatDuration(Math.max(0, now - globalAt)),
              turns: saved.turns,
              matched: matches(sessionId),
            };
          },
        }),
      `${name}: tool`,
    );
  });

  // ---- 对外服务 ---------------------------------------------------------

  try {
    ctx.reflect.provide(
      'sessionClock',
      {
        reload: () => ({ ok: true, note: 'session-clock 不需要重载，改配置即可' }),
        status: () => snapshot(),
        list: () => sessionList(),
        flush: () => {
          store.flush();
          return storeFile;
        },
        matches,
      },
      () => true,
    );
  } catch {
    /* provide 失败不致命 */
  }
  state.provide = true;

  // ---- 收尾 -------------------------------------------------------------

  ctx.effect(() => {
    const timer = setInterval(() => {
      store.flush();
      state.tracked = memory.size;
    }, 30000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      clearInterval(timer);
    };
  }, `${name}: flush timer`);

  ctx.effect(() => () => {
    try {
      store.close();
    } catch (error) {
      logger?.warn?.(`[${name}] 关闭状态文件失败：${describe(error)}`);
    }
  }, `${name}: store`);

  state.ready = true;
  log('info', `会话时钟已启用：时区 ${zone.ok ? zone.timeZone : '不可用'}，授时会话 ${includes.map(String).join(', ')}，状态文件 ${storeFile}`);
}

// ---- 辅助 -------------------------------------------------------------

function isOwn(event) {
  return event?.data?.source?.kind === INJECT_KIND;
}

function compileAll(value, fallback) {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? fallback : [value];
  const tests = [];
  for (const item of raw) {
    if (item === undefined || item === null) continue;
    const pattern = String(item).trim();
    if (pattern === '') continue;
    tests.push(compilePattern(pattern));
  }
  if (tests.length === 0 && fallback.length > 0) for (const item of fallback) tests.push(compilePattern(String(item)));
  return tests;
}

function compilePattern(pattern) {
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      const test = (id) => re.test(id);
      test.toString = () => pattern;
      return test;
    } catch {
      /* 非法正则退化为字面量匹配 */
    }
  }
  if (!pattern.includes('*')) {
    const test = (id) => id === pattern;
    test.toString = () => pattern;
    return test;
  }
  const source = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`;
  const re = new RegExp(source);
  const test = (id) => re.test(id);
  test.toString = () => pattern;
  return test;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toCount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function stripQuery(url) {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function rejectNonLocal(request, response) {
  const host = request.headers?.host ?? '';
  const hostname = String(host).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (isLoopback(hostname)) return undefined;
  return () => sendJson(response, 403, { ok: false, error: 'loopback only' });
}

function isLoopback(hostname) {
  if (hostname === '' || hostname === 'localhost' || hostname === '::1') return true;
  if (hostname.endsWith('.localhost')) return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) return false;
  return [match[1], match[2], match[3]].every((part) => Number(part) <= 255);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // 请求体不是合法 JSON：当作「没有参数」处理，让调用方走默认分支。
    return undefined;
  }
}

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function stringifyExtra(value) {
  if (value instanceof Error) return describe(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
