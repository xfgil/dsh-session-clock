# dsh-session-clock

> **A "session clock" plugin for DeepSeek Harness** — per-session time injection plus durable idle-gap tracking.
> A **companion** to the built-in [`@deepseek-ai/dsh-time-context`](https://www.npmjs.com/package/@deepseek-ai/dsh-time-context), not a replacement.

English | [中文](README.md)

![status](https://img.shields.io/badge/DEEPSEEK%20HARNESS-plugin-4B6BFB) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

| |
|---|
| [`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) — edit plugin source without restarting |
| **`dsh-session-clock`** — per-session clock and idle gaps (this repo) |
| [`dsh-onebot-guard`](https://github.com/xfgil/dsh-onebot-guard) — QQ channel outbound gate |

---

## In one sentence

DSH's built-in `time-context` already tells the model what time it is and how long
since the last message. This plugin **does not duplicate that**; it fills three
things `time-context` structurally cannot do.

| Capability | `dsh-time-context` (built-in) | `dsh-session-clock` (this plugin) |
| --- | --- | --- |
| Current timestamp | ✅ every first step | ➖ not duplicated (`full` mode only) |
| Browser time zone | ✅ | ➖ not duplicated |
| Elapsed since last model-visible message | ✅ | ➖ not duplicated |
| **Inject only for chosen sessions** | ❌ applies to every agent equally | ✅ `sessions` / `exceptSessions` allowlists |
| **Glob / regex session matching** | ❌ | ✅ `*` and `/regex/` |
| **Cross-session pointer** | ❌ unaware of session boundaries | ✅ |
| **Gap since the user *last spoke*** | ❌ counts model-visible messages | ✅ ignores scheduled/proactive/tool turns |
| **Survives a restart** | ⚠️ in-session events only | ✅ persisted to `$DSH_HOME/session-clock/activity.json` |
| Agent-queryable tool (`session_clock`) | ❌ | ✅ |
| HTTP status surface | ❌ | ✅ |

---

## Why it exists

The built-in `@deepseek-ai/dsh-time-context` injects a three-line message at the
first step of every turn:

```
Time sampled while preparing turn 8, step 1: 2026-10-13T10:14:10+08:00[Asia/Shanghai]
Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: 2h 15m 3s.
```

**That third line, at step 1, is already equivalent to "how long since the last
conversation."** At step 1 the current turn's `user/message` has not been committed
yet, so the baseline lands on the last model-visible message of the previous turn.
This plugin acknowledges that and leaves it alone — which is why the default is
`mode: supplement`.

But there are two structural gaps:

1. **It is global.** Every agent and every session is treated the same; there is no
   way to say "clock only these sessions." When QQ group chats, scheduled tasks, and
   subagents all run together, tokens get spent on sessions that don't need it.
2. **It cannot see session boundaries.** It knows "since the last message," but not
   "since *another* session was last active," nor "since the user *last spoke*" —
   scheduled wake-ups and proactive messages also produce model-visible messages and
   overwrite that baseline.

This plugin fills exactly those two gaps. Its injection format deliberately matches
`time-context` byte-for-byte (`2026-10-13T10:14:10+08:00[Asia/Shanghai]`, `1d 2h 3m 4s`),
so the two injections coexist without conflict.

---

## Features

### 1. Per-session clock injection

```yaml
sessions: ['onebot-*', 'session-*']      # allowlist: globs and /regex/
exceptSessions: ['/^onebot-group-.*$/']  # denylist, takes precedence
```

- `'*'` (default) means every session.
- `'onebot-*'` matches all QQ-channel sessions; `'/^session-36f4.*/'` is a regex.
- An invalid regex silently degrades to a literal match instead of crashing the plugin.

### 2. Cross-turn and cross-session gaps

One line per injection, e.g.:

```
Session clock for onebot-group-2000000002-mv40ioj5: previous user message 3d 4h 12m 9s ago; any session last active 12m 3s ago (session-36f403a5-...), turn 42.
```

- `previous user message ... ago` — since the user *last spoke* (excludes injected
  messages and scheduled wake-ups).
- `any session last active ... ago` — the cross-session pointer; the parenthesised id
  is which session. Answers "did I just ask you this in another window?"
- `turn 42` — cumulative turn count for this session.
- Clauses can be disabled individually with `includeUserGap` / `includeGlobalIdle` /
  `includeTurnCount`.

### 3. Persistence

State lives at `$DSH_HOME/session-clock/activity.json` (default
`~/.dsh/session-clock/activity.json`).

After a DSH restart the in-memory session objects are new, but the baselines are still
on disk, so "how long since we last talked" remains correct. Writes are
**debounced + atomically replaced** (tmp file → `renameSync`), so a power cut cannot
leave half a JSON file behind.

### 4. Agent-queryable tool

A `session_clock` tool is registered:

| action | Purpose |
| --- | --- |
| `now` | Current time + idle durations for this session (or `session_id`) |
| `list` | Most recently active sessions with idle durations (`limit` caps the count) |

The model can answer "how long have I been away" directly instead of waiting for an
injection.

### 5. HTTP status surface

**Loopback only** (`127.x.x.x` / `localhost` / `::1` / `*.localhost`); anything else
gets a 403:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/session-clock` | Status (enabled / mode / counters / last skip reason) |
| GET | `/session-clock/list` | Tracked sessions with idle durations |
| GET | `/session-clock/logs` | Ring buffer of the last 300 log lines |
| POST | `/session-clock/toggle` | Enable / disable injection |
| POST | `/session-clock/flush` | Force a write to disk |
| POST | `/session-clock/forget` | Drop a session (body `{"session": "<id>"}`) |

`lastDecision` in `/session-clock` tells you **why the last injection was skipped**
(e.g. `mode=supplement 只在首步注入`) — this plugin fires once per turn, so missing
step 1 means a whole silent turn; without that field it is hard to tell "not my turn"
from "broken."

---

## Requirements

### Prerequisite plugin

| Plugin | Version | Notes |
|---|---|---|
| [`@deepseek-ai/dsh-time-context`](https://www.npmjs.com/package/@deepseek-ai/dsh-time-context) | **0.2.0-rc.2** | Built into the host. **Must exist, but do not modify it** — the default `supplement` mode coexists with it (see "Coexisting with time-context") |

`time-context` ships with the `@deepseek-ai/dsh-base` bundle; you do not install it
separately. This plugin does **not** import it — it only complements, at the semantic
level, dimensions that `time-context` structurally cannot express.

> Note: `dsh-experimental-schedule-bundle` also pulls in the same `dsh-time-context`.
> Keep a **single mount point** in your profile patch — a second copy makes every turn's
> first step inject two byte-identical messages.

### DSH host

| Item | Version |
|---|---|
| DSH | **0.2.0-rc.2** (this plugin's development and test baseline) |
| Electron | 44.0.0 |
| Node (embedded in host) | 24.18.1 |
| V8 | 15.2 |
| Cordis | 4.0.4 |

### Host services and interfaces used

| Dependency | Required | Notes |
|---|---|---|
| `ctx.sessions` | ✅ | `inject = ['sessions']`. Gets the current session and reads its event stream |
| `ctx.sessions.snapshotEvents()` | ✅ | Rebuilds the "how long since the last conversation" baseline |
| `ctx.on('session/event')` | ✅ | Tracks the `time` field of every message |
| `createUserMessage` from `@deepseek-ai/dsh-llm` | ⭕ optional | **Guarded dynamic import**: `try { ... } catch { undefined }`; falls back to a local `deepFreeze({ id: randomUUID(), role: 'user', ... })` equivalent |
| `webServer` | ⭕ optional | Without it the plugin still injects, you just get no HTTP surface |
| `ctx.reflect.provide('sessionClock')` | ⭕ optional | Wrapped in try/catch; a host lacking this service is fine |

**Zero runtime dependencies**: only `node:crypto` / `node:fs` / `node:path` / `node:url`,
plus the bundled `./time.js` and `./store.js`.

### State file

```
$DSH_HOME/session-clock/activity.json     # default; falls back to ~/.dsh when DSH_HOME is unset
```

- Atomic write (tmp + `renameSync`), shape `{ version: 1, sessions: {...}, global: {...} }`
- `MAX_RECORDS = 5000`; when exceeded, the oldest by `lastSeenAt` are pruned
- Deleting this file clears every recorded gap (intervals restart from zero after a restart)

---

## Install

```bash
dsh plugin --profile <your-profile> add link:/absolute/path/dsh-session-clock
```

Or from npm/GitHub if published:

```bash
dsh plugin --profile <your-profile> add dsh-session-clock
```

No restart is **usually** needed: the host's built-in HMR notices the profile manifest
change and reconciles automatically. Check `/session-clock` — `enabled: true` with
`ready: true` means it loaded. If the status route 404s, that reconcile did not take,
so restart DSH once.

### Coexisting with time-context

**The default already coexists.** Do not touch the `time-context` entry in your
profile patch — it is referenced by both `dsh-base` and
`dsh-experimental-schedule-bundle`, and inserting a second copy makes every turn's
first step inject two byte-identical messages (a known DSH pitfall; it is documented
in the profile patch comments).

If you want this plugin to **fully replace** `time-context`:

1. Add `disabled: true` to `- id: time-context` in your profile's `cordis.patch.yml`;
2. Set this plugin to `mode: full`.

`full` mode reproduces those three lines plus this plugin's own line.

---

## Configuration

In your profile's `cordis.patch.yml`:

```yaml
- id: session-clock
  name: dsh-session-clock
  config:
    mode: supplement
    timeZone: Asia/Shanghai
    sessions: ['*']
    refreshIntervalMs: 60000
```

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `mode` | `'supplement'` | `supplement` = increments only; `append` = also emit "since previous turn ended"; `full` = reproduce time-context's three lines |
| `timeZone` | `''` (process zone) | IANA zone; an invalid value disables the plugin and reports it in status |
| `refreshIntervalMs` | `60000` | Minimum ms between injections for one session; `0` disables throttling |
| `sessions` | `['*']` | Clock allowlist, supports `*` and `/regex/` |
| `exceptSessions` | `[]` | Session denylist, takes precedence over the allowlist |
| `stateFile` | `''` | State path, defaults to `$DSH_HOME/session-clock/activity.json` |
| `minGapSeconds` | `0` | Skip injection when the gap is shorter than this many seconds |
| `includeUserGap` | `true` | Emit the "since the user last spoke" clause |
| `includeGlobalIdle` | `true` | Emit the cross-session pointer clause |
| `includeIdleSinceTurnEnd` | `true` | Emit "since the previous turn ended" (no effect in `supplement`) |
| `includeSessionId` | `true` | Include the session id in the line |
| `includeTurnCount` | `true` | Include the turn counter in the line |
| `skipSubagents` | `true` | Skip `origin === 'subagent'` sessions (many, short-lived; saves tokens) |
| `logInjection` | `true` | Log each injection |
| `traceDecisions` | `false` | Also log every skip (for debugging) |
| `quiet` | `false` | Silence routine info logs |

---

## Known limitations

- **First step only.** `supplement` / `append` emit once per turn, because the
  timestamp and per-step semantics are already handled by `time-context`. Use
  `mode: full` if you want a line every step.
- **Whole-second precision.** Follows the `1d 2h 3m 4s` style; no milliseconds.
- **`refreshIntervalMs` throttles, it does not guarantee.** It only suppresses
  injections that are too close together.
- **The cross-session pointer only covers sessions this plugin has seen.** A brand-new
  session is not in the table until its first appearance.
- **`previous user message` relies on this plugin tagging its own `source.kind` as
  `session-clock`.** Any other plugin that pushes `user`-role messages without tagging
  their origin will be counted.
- **Nothing client-side.** Host-only plugin.

---

## ⚠️ Disclaimer (personal use)

**This is a personal tool, provided "as is", with no warranty of any kind.**

- The author is not affiliated with DSH / DeepSeek. This plugin is **not** official and
  is not endorsed by them.
- It was built and tuned against **one specific profile** (Windows, a Chinese time
  zone, a QQ channel, and a pile of third-party plugins running together). Other
  environments have not been verified.
- It reads session events, writes one JSON state file, and registers one tool plus a
  few HTTP routes. All have failure fallbacks, but **do not** deploy it in a
  compliance-bound production environment without review.
- It depends on DSH's **internal, undocumented interfaces**: the shape of
  `ctx.loader`, the `session/event` and `agent/pre-step` payloads, and
  `ctx.sessions` / `ctx.webServer` / `ctx.tools`. These are not stable APIs and
  **may break at any time** when DSH is upgraded.
- Use at your own risk. The author accepts no liability for any direct or indirect
  damage arising from the use of this plugin.

If all you want is for the model to know the current time, **use the built-in
`time-context` first** — it is maintained officially and is more reliable than this
plugin. This plugin only covers the small corner it does not reach.

---

## Development

```
lib/
  index.js   # main: event subscriptions, injection decisions, HTTP surface, tool
  store.js   # persistence: debounced merge-write, atomic replace, record trimming
  time.js    # time-zone validation, timestamp formatting, duration formatting
cordis.patch.yml
```

- Zero runtime dependencies (`node:` builtins only). `createUserMessage` from
  `@deepseek-ai/dsh-llm` is loaded via a **guarded dynamic import**, falling back to a
  local equivalent (`deepFreeze` + `randomUUID`) — DSH's package resolution varies by
  environment, and a failed static import silently skips the whole plugin.
- Duration and timestamp formats match `time-context` byte-for-byte so both injections
  can coexist:

```
lib/time.js     formatDuration(93784000) === '1d 2h 3m 4s'
lib/time.js     formatTimestamp(now, fmt, 'Asia/Shanghai') === '2026-10-13T09:52:39+08:00[Asia/Shanghai]'
```

For live edits while developing, pair it with
[`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) to apply changes
without restarting.

---

## License

MIT © 2026 xfgil
