# dsh-session-clock

> **给 DeepSeek Harness 的「会话时钟」插件**——按会话授时，并给出跨轮、跨会话的空闲间隔。
> 定位是宿主内置 [`@deepseek-ai/dsh-time-context`](https://www.npmjs.com/package/@deepseek-ai/dsh-time-context) 的**补充插件**，不是替代品。

![status](https://img.shields.io/badge/DEEPSEEK%20HARNESS-plugin-4B6BFB) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

---

## 一句话说明

DSH 内置的 `time-context` 已经很擅长「告诉模型现在几点、距上一条消息过了多久」。
本插件**不重复它**，只补三件它结构上做不到的事：

| 能力 | `dsh-time-context`（内置） | `dsh-session-clock`（本插件） |
| --- | --- | --- |
| 当前时间戳 | ✅ 每轮首步 | ➖ 不重复（`full` 模式下才复刻） |
| 浏览器时区 | ✅ | ➖ 不重复 |
| 距上一条模型可见消息多久 | ✅ | ➖ 不重复 |
| **只给「指定会话」授时** | ❌ 对所有 agent 一视同仁 | ✅ `sessions` / `exceptSessions` 白名单 |
| **`/正则/`、`*` 通配匹配会话** | ❌ | ✅ |
| **跨会话指针**（任何会话上次活跃多久前） | ❌ 不感知会话边界 | ✅ |
| **距上一次「用户主动说话」多久** | ❌ 只算模型可见消息 | ✅ 排除定时/主动/工具触发的轮次 |
| **重启后间隔依然成立** | ⚠️ 依赖会话内事件 | ✅ 持久化到 `$DSH_HOME/session-clock/activity.json` |
| agent 主动查询（`session_clock` 工具） | ❌ | ✅ |
| HTTP 状态观测面 | ❌ | ✅ |

---

## 为什么需要它

DSH 内置的 `@deepseek-ai/dsh-time-context` 每个 turn 的首步都会注入一条三行消息：

```
Time sampled while preparing turn 8, step 1: 2026-10-13T10:14:10+08:00[Asia/Shanghai]
Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: 2h 15m 3s.
```

**第三行在每轮第一步其实已经等于「距上次对话过去多久」**——因为 step 1 执行时本轮的
`user/message` 还没提交，基线落在上一轮最后一条模型可见消息上。这一点本插件承认并且
不去动它（这也是本插件默认 `mode: supplement` 的原因）。

但它有两个结构性缺口：

1. **它是全局的。** 所有 agent、所有会话一视同仁，没法做到「只给这几个会话授时」。
   在 QQ 群、定时任务、子代理混跑的场景里，token 花在了不需要的会话上。
2. **它感知不到会话边界。** 它知道「距上一条消息」，但不知道「距**别的**会话上次活跃」，
   也不知道「用户上次**主动**开口是多久前」（定时唤醒、主动搭话也会产生模型可见消息，
   把这条基线冲掉）。

本插件就补这两点。注入格式刻意沿用与 `time-context` 完全一致的时间戳/时长写法
（`2026-10-13T10:14:10+08:00[Asia/Shanghai]`、`1d 2h 3m 4s`），两条注入放在一起不打架。

---

## 功能详解

### 1. 按会话授时

```yaml
sessions: ['onebot-*', 'session-*']      # 白名单，支持 * 通配与 /正则/
exceptSessions: ['/^onebot-group-.*$/']  # 黑名单，优先级高于白名单
```

- `'*'`（默认）等于全部会话。
- `'onebot-*'` 匹配所有 QQ 通道会话；`'/^session-36f4.*/'` 走正则。
- 非法正则自动退化为字面量匹配，不会让插件崩掉。

### 2. 跨轮与跨会话间隔

每条注入一行，形如：

```
Session clock for onebot-group-2000000002-mv40ioj5: previous user message 3d 4h 12m 9s ago; any session last active 12m 3s ago (session-36f403a5-...), turn 42.
```

- `previous user message ... ago`：距**上一次用户主动发言**（不含注入消息、不含定时唤醒）。
- `any session last active ... ago`：跨会话指针——任何一个被跟踪的会话上次动过是多久前，
  括号里是那个会话 id。用来回答「我是不是刚在另一个窗口问过你」。
- `turn 42`：本会话累计轮次数。
- 各子句可用 `includeUserGap` / `includeGlobalIdle` / `includeTurnCount` 逐个关掉。

### 3. 持久化

状态写到 `$DSH_HOME/session-clock/activity.json`（默认 `~/.dsh/session-clock/activity.json`）。

DSH 重启后内存里的会话对象是新的，但文件里的间隔基线还在，所以「距上次对话多久」
在重启后依然算得对——这是内置插件做不到的。写盘是**延迟合并 + 原子替换**
（tmp 文件 → `renameSync`），不会因为断电留下半个 JSON。

### 4. agent 可主动查询

注册了一个 `session_clock` 工具：

| action | 作用 |
| --- | --- |
| `now` | 本会话（或 `session_id` 指定）当前时间 + 各类空闲时长 |
| `list` | 最近活跃的会话及空闲时长（`limit` 控制条数） |

模型可以直接回答「我多久没来了」，而不必依赖注入。

### 5. HTTP 观测面

只在 **loopback**（`127.x.x.x` / `localhost` / `::1` / `*.localhost`）可访问，非本机一律 403：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/session-clock` | 当前状态（enabled / mode / 计数 / 上次决策原因） |
| GET | `/session-clock/list` | 已跟踪会话及空闲时长 |
| GET | `/session-clock/logs` | 环形日志缓冲（最近 300 条） |
| POST | `/session-clock/toggle` | 开/关注入 |
| POST | `/session-clock/flush` | 立即落盘 |
| POST | `/session-clock/forget` | 忘掉某个会话（body `{"session": "<id>"}`） |

`/session-clock` 里的 `lastDecision` 会告诉你**上一次为什么没注入**（例如
`mode=supplement 只在首步注入`）——这个插件每轮只补一条，错过首步就整轮静默，
没有这个字段会很难区分「没轮到」和「坏了」。

---

## 安装

```bash
dsh plugin --profile <你的profile> add link:/绝对路径/dsh-session-clock
```

或者从 npm/GitHub 装（若已发布）：

```bash
dsh plugin --profile <你的profile> add dsh-session-clock
```

装好后重启一次 DSH 生效（profile 清单变了，宿主的内置 HMR 会自动 reconcile，
但首次装载建议重启确认）。用 `/session-clock` 看状态。

### 与 time-context 共存

**默认就是共存模式。** 不要动 profile patch 里的 `time-context` 条目——
它在 `dsh-base` 与 `dsh-experimental-schedule-bundle` 里都有引用，插第二份会导致
每个 turn 首步注入两条逐字相同的消息（这是 DSH 已知的坑，profile patch 的注释里有记录）。

如果你想**用本插件整体替代** `time-context`：

1. 在 profile 的 `cordis.patch.yml` 里把 `- id: time-context` 加 `disabled: true`；
2. 本插件配 `mode: full`。

`full` 模式会完整复刻那三行 + 本插件自己的一行。

---

## 配置项

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: session-clock
  name: dsh-session-clock
  config:
    mode: supplement
    timeZone: Asia/Shanghai
    sessions: ['*']
    refreshIntervalMs: 60000
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `'supplement'` | `supplement` = 只补增量；`append` = 额外给「距上一轮结束多久」；`full` = 复刻 time-context 三行 |
| `timeZone` | `''`（进程时区） | IANA 时区；非法值会让插件停用并在状态里报错 |
| `refreshIntervalMs` | `60000` | 同一会话两次注入的最小间隔（ms）；`0` = 不节流 |
| `sessions` | `['*']` | 授时会话白名单，支持 `*` 与 `/regex/` |
| `exceptSessions` | `[]` | 会话黑名单，优先级高于白名单 |
| `stateFile` | `''` | 状态文件路径，默认 `$DSH_HOME/session-clock/activity.json` |
| `minGapSeconds` | `0` | 空闲不足这么多秒就不注入（避免刚说完话又报一次） |
| `includeUserGap` | `true` | 输出「距上次用户主动发言」子句 |
| `includeGlobalIdle` | `true` | 输出跨会话指针子句 |
| `includeIdleSinceTurnEnd` | `true` | 输出「距上一轮结束」（`supplement` 模式下不生效） |
| `includeSessionId` | `true` | 注入行里带会话 id |
| `includeTurnCount` | `true` | 注入行里带轮次计数 |
| `skipSubagents` | `true` | 跳过 `origin === 'subagent'` 的会话（数量多、生命周期短，省 token） |
| `logInjection` | `true` | 每次注入写一条宿主日志 |
| `traceDecisions` | `false` | 每次跳过也写日志（排查用） |
| `quiet` | `false` | 关闭常规 info 日志 |

---

## 已知限制

- **只在每轮首步注入。** `supplement` / `append` 模式一轮一条，因为时间戳与逐步语义
  已经由 `time-context` 承担。需要每步都报请用 `mode: full`。
- **整秒精度。** 沿用 `1d 2h 3m 4s` 的写法，不带毫秒。
- **`refreshIntervalMs` 是节流而非保证。** 它只压制「距上次注入太近」的情况。
- **跨会话指针只覆盖被本插件跟踪过的会话。** 全新会话第一次出现前不在表里。
- **`previous user message` 依赖注入消息把自身 `source.kind` 标成 `session-clock`。**
  若其它插件也往历史里塞 user 角色消息且不标来源，会被计入。
- **未做客户端（浏览器）侧任何东西。** 纯宿主插件。

---

## ⚠️ 自用免责声明

**这个插件是给自己用的小工具，按「现状」提供，不附带任何保证。**

- 作者不是 DSH / DeepSeek 官方，本插件与官方**没有关系**，也不被官方背书。
- 代码主要围绕**作者自己的一个 profile** 打磨（Windows + 国内时区 +
  QQ 通道 + 一堆第三方插件混跑），其它环境的兼容性没有验证过。
- 它读取会话事件、写一个 JSON 状态文件、注册一个工具和几个 HTTP 路由。
  虽然都有失败兜底，但**不要**在有合规要求的生产环境上不经审查地部署。
- 依赖 DSH 的**内部未公开接口**：`ctx.loader` 的结构、`session/event` 与
  `agent/pre-step` 的载荷形状、`ctx.sessions` / `ctx.webServer` / `ctx.tools`。
  这些不是稳定 API，DSH 升级后**随时可能坏**。
- 使用风险自负。因使用本插件造成的任何直接或间接损失，作者不承担责任。

如果你只是想让模型知道现在几点，**先去用内置的 `time-context`**——
它由官方维护，比这个插件可靠。本插件解决的是它覆盖不到的那一小块。

---

## 开发

```
lib/
  index.js   # 主实现：事件订阅、注入决策、HTTP 观测面、工具注册
  store.js   # 持久化：延迟合并写 + 原子替换 + 条数裁剪
  time.js    # 时区校验、时间戳格式化、时长格式化
cordis.patch.yml
```

- 零运行时依赖（只用 `node:` 内置模块）。对 `@deepseek-ai/dsh-llm` 的
  `createUserMessage` 走**受控动态 import**，拿不到就退化为本地等价实现
  （`deepFreeze` + `randomUUID`）——因为 DSH 的包解析路径随环境变化，静态 import
  失败会让整个插件被静默跳过。
- 时长与时间戳格式与 `time-context` 逐字对齐，方便两条注入并存：

```
lib/time.js     formatDuration(93784000) === '1d 2h 3m 4s'
lib/time.js     formatTimestamp(now, fmt, 'Asia/Shanghai') === '2026-10-13T09:52:39+08:00[Asia/Shanghai]'
```

本地热改的话，配合 [`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader)
可以改完即生效、无需重启。

---

## License

MIT © 2026 xfgil
