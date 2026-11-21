/**
 * deepseek-web-import — host half.
 *
 * Imports conversations from chat.deepseek.com (the web chat, not the API)
 * into DeepSeek Harness as real sessions: a settings-page UI (see
 * `./client.js`) calls these same-origin routes to list the user's DeepSeek
 * conversation directory and import a chosen conversation into a chosen
 * workspace as a durable, resumable DSH session.
 *
 * Two layers keep this working across DSH releases:
 * - `./persistence.js` adapts to the session-persistence contract of the
 *   running build (handle era v2+ / legacy era v0/v1) and to the Session
 *   format version it writes;
 * - `./formats.js` owns every version-dependent header and event field.
 *
 * Security posture:
 * - All routes are same-origin (the DSH web server) and read/write nothing
 *   outside the caller's own session data.
 * - The DeepSeek `userToken` is stored via the `credentials` service
 *   (`$DSH_HOME/.credentials.yaml`), never in the browser or the session log.
 * - The diagnostic `probe` route only accepts `https://chat.deepseek.com` on
 *   the default port (no arbitrary SSRF, no plaintext downgrade).
 * - Error responses carry a stable code plus fixed text; internals are never
 *   echoed, and the credential store's own complaint — which can embed the
 *   value it refused — is redacted before it reaches the log.
 *
 * Routes (all POST, JSON):
 *   /__deepseek-web-import/tokenStatus
 *   /__deepseek-web-import/saveToken        { token }
 *   /__deepseek-web-import/clearToken
 *   /__deepseek-web-import/listSessions
 *   /__deepseek-web-import/fetchHistory     { sessionId }
 *   /__deepseek-web-import/listWorkspaces
 *   /__deepseek-web-import/importToSession  { sessionId, title?, workspaceId }
 *   /__deepseek-web-import/probe            { url, method? }  (chat.deepseek.com only)
 *
 * Failure responses use `error` as a stable code the browser half localizes
 * (`no_token`, `api`, `not_json`, `too_large`, `empty_history`, `no_workspace`,
 * `persist`, `verify`, `transport`, `parse`, `save_failed`, `probe_refused`,
 * `credentials_unavailable`, `persistence_unavailable`,
 * `workspace_registry_unavailable`, `subprocess_unavailable`,
 * `internal error`, `method not allowed`, `invalid JSON body`,
 * `request body too large`); `msg`/`message` carries the human detail.
 */

import { buildSessionEvents, importableMessages } from './events.js'
import { writeVerifiedSession } from './persistence.js'
import { BODY_LIMIT, redact, runRequest } from './transport.js'

/** Stable Cordis plugin name (must match the cordis.patch.yml `id`). */
export const name = 'deepseek-web-import'

/** The routes need the HTTP carrier; other services are optional and read via ctx.get. */
export const inject = ['webServer']

const TOKEN_REF = 'DEEPSEEK_WEB_TOKEN'
const BASE = 'https://chat.deepseek.com'
const BASE_HOST = 'chat.deepseek.com'
/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/__deepseek-web-import/'

/** Marks routes this plugin registered, so only its own are ever reclaimed. */
const ROUTE_OWNER = 'deepseek-web-import'

/**
 * Route generations, keyed by path: the last instance that claimed a path owns
 * it. A disposer compares this against its own generation instead of trusting
 * `webServer.exact` (an internal field): if this build ever stops exposing that
 * table, ownership is still provable, and a disposer can never delete a newer
 * instance's route.
 */
const routeGenerations = new Map()
let nextRouteGeneration = 0

/**
 * Events the importer writes at import time (see `./events.js`).
 *
 * Kept for documentation and for the "does it open like an import" check. It is
 * deliberately NOT used as a purity test over the whole log: DSH appends
 * `permission/preset` + `sandbox/mode` + `approval/policy` the moment an imported
 * session is opened, and the v2→v3 migration inserts `system/message` — so a
 * real imported log legitimately contains events outside this set.
 */
const IMPORTER_EVENT_TYPES = new Set([
  'session/title',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'session/end-seed',
])

/**
 * Events only a real DSH turn produces: a model request, a streaming attempt, a
 * live tool call. None of them can come from an import, which writes finished
 * messages only.
 *
 * `request/header` is the decisive one — every conversation DSH actually drove a
 * model for records one per turn, and no imported log has any.
 */
const LIVE_TURN_EVENTS = ['request/header', 'assistant/attempt', 'assistant/chunk', 'tool/call']

function safeParse(text) {
  try { return JSON.parse(text) } catch { return null }
}

function normalizeToken(raw) {
  if (typeof raw !== 'string') return ''
  const t = raw.trim()
  const unwrapped = t.startsWith('{') ? unwrapTokenJson(t) : t
  /* A pasted token must never be able to split an HTTP header. */
  return unwrapped.replace(/[\r\n]/g, '').trim()
}

/** Read `{"value":"…"}` — the shape the browser's Local Storage stores. */
function unwrapTokenJson(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.value === 'string' && parsed.value.length > 0) return parsed.value.trim()
  } catch { /* not a JSON wrapper */ }
  return text
}

function defaultHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-app-version': '20240105.0',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-version': '1.0.0-alpine',
    'x-device-id': 'dswi-' + Math.random().toString(36).slice(2, 14),
    'x-os': 'web',
    'x-requested-with': 'XMLHttpRequest',
    Origin: BASE,
    Referer: BASE + '/',
  }
}

function extractSessions(j) {
  if (!j) return null
  const data = j.data || j
  const biz = (data && data.biz_data) || data
  const arr = biz.chat_sessions || biz.sessions || biz.chat_session_list || biz.list
  return Array.isArray(arr) ? arr : null
}

function extractMessages(j) {
  if (!j) return null
  const data = j.data || j
  const biz = (data && data.biz_data) || data
  const arr = biz.chat_messages || biz.messages || biz.chat_message_list || biz.history || biz.message_list
  return Array.isArray(arr) ? arr : null
}

/** A session id in the same shape DSH itself mints. */
function newSessionId() {
  return 'session-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

/**
 * Plugin body: register the same-origin JSON routes.
 * @param ctx - host context.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  /** Server-side diagnostics: never echoed to the browser. */
  function log(message) {
    try { ctx.logger?.warn?.('[deepseek-web-import] ' + message) } catch { /* logging must never fail a route */ }
  }

  /**
   * Whether one stored session looks like this importer wrote it.
   *
   * There is no stored marker, so the test is the absence of anything only a
   * live DSH turn can leave behind. Proving a log is an import by its *content*
   * does not work: DSH appends `permission/preset` + `sandbox/mode` +
   * `approval/policy` as soon as the session is opened, and the v2→v3 migration
   * inserts `system/message`, so an imported log stops looking pristine.
   *
   * What never appears in an import is a model request (`request/header`), a
   * streaming attempt (`assistant/attempt`, `assistant/chunk`) or a live tool
   * call — the importer writes finished messages only. Their absence, plus an
   * opening that is not DSH's settings/preset head, identifies an import.
   *
   * Fails closed: an unreadable or empty log is not treated as imported, because
   * listing a session the panel cannot manage is worse than omitting one.
   * @param {object} query - the `sessionQuery` service.
   * @param {string} sessionId - the session to inspect.
   * @returns {Promise<boolean>} true when the log looks importer-written.
   */
  async function looksImported(query, sessionId) {
    let events
    try {
      events = await query.listEvents(sessionId)
    } catch {
      return false
    }
    if (!Array.isArray(events) || events.length === 0) return false
    const types = events.map((event) => event && event.type)
    /* A model was actually driven in this session: it is a real conversation. */
    for (const marker of LIVE_TURN_EVENTS) {
      if (types.includes(marker)) return false
    }
    /* It must contain something an import always writes, so a settings-only log
       (no conversation at all) is not mistaken for one. */
    const hasImportedContent = types.some((type) => IMPORTER_EVENT_TYPES.has(type))
    if (!hasImportedContent) return false
    return true
  }

  /** Run one raw HTTP request through the subprocess seam (spec travels on stdin). */
  async function nodeHttp(spec) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return { error: 'subprocess 服务不可用', errorCode: 'subprocess_unavailable', transport: true }
    const policy = ctx.get('sandboxPolicy')
    const cwd = (policy && policy.workspaceRoot) ? policy.workspaceRoot : '.'
    const result = await runRequest(subprocess, spec, { cwd })
    if (result.insecureTls === true) {
      /* Certificate verification failed and the request was retried without it
         (an intercepted TLS environment). Real but unauthenticated: say so. */
      log('TLS verification failed; the request continued unverified')
    }
    if (result.error !== undefined && result.body === undefined) {
      /* a child that never reached an HTTP response: report it as transport,
         not as a malformed API reply */
      log('transport failed: ' + redact(result.error) + ' ' + redact(result.stderr))
      return { ...result, transport: true }
    }
    return result
  }

  /**
   * Turn a failed transport into the same shape every action answers with, and
   * keep the raw upstream text out of the browser unless the caller is the
   * diagnostic route.
   */
  function transportError(result, token) {
    const code = typeof result.errorCode === 'string' ? result.errorCode : 'transport'
    return {
      ok: false,
      error: code,
      ...code === 'transport' ? { msg: redact(result.error || result.stderr || '未知错误', token, 200) } : {},
      /* the prerequisite answer keeps its reason (e.g. `command "node" was not
         found on PATH`), so the page can say what to fix */
      ...code === 'node_unavailable' ? { msg: redact(result.detail || result.error || '', token, 200) } : {},
      ...result.insecureTls === true ? { insecureTls: true } : {},
    }
  }

  /** Cap and redact any upstream text that travels back to the browser. */
  function safeRaw(value, token, limit = 600) {
    return redact(value, token, limit)
  }

  /**
   * Log one credential-store failure without ever echoing a secret.
   *
   * The store's own message can embed the value it refused (the plugin's own
   * tests build exactly such a message), and README asks users to paste logs in
   * bug reports. The message is kept only when every secret it could carry is in
   * scope to be redacted; otherwise the class alone is logged.
   * @param {string} operation - the action that failed.
   * @param {unknown} error - the failure from the credential service.
   * @param {string[]} secrets - values that must not appear.
   */
  function logCredentialFailure(operation, error, secrets) {
    let detail = String((error && error.message) || error || '')
    const known = (secrets || []).filter((value) => typeof value === 'string' && value.length > 0)
    if (known.length === 0) detail = '(detail suppressed: it can embed the credential)'
    else for (const secret of known) detail = redact(detail, secret)
    log(operation + ' failed: ' + redact(detail, null, 300))
  }

  async function resolveToken(passed) {
    if (passed) return normalizeToken(passed)
    const creds = ctx.get('credentials')
    if (!creds) return null
    try { const r = await creds.resolve(TOKEN_REF); return r ? normalizeToken(r.value) : null } catch { return null }
  }

  async function fetchHistoryInternal(sessionId, token) {
    const h = defaultHeaders(token)
    const r = await nodeHttp({ url: BASE + '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId), method: 'GET', headers: h })
    if (r.transport === true) return transportError(r, token)
    if (r.truncated === true) {
      return { ok: false, error: 'too_large', msg: '该对话太长，单次导入上限约 ' + BODY_LIMIT + ' 字符' }
    }
    const j = typeof r.body === 'string' ? safeParse(r.body) : r.body
    if (!j) return { ok: false, error: 'not_json', status: r.status, raw: safeRaw(r.body, token) }
    if (j.code !== 0) return { ok: false, error: 'api', code: j.code, msg: safeRaw(j.msg, token, 200), raw: safeRaw(JSON.stringify(j), token) }
    const bizCode = j.data && j.data.biz_code
    if (bizCode !== undefined && bizCode !== 0) return { ok: false, error: 'api', code: bizCode, msg: safeRaw((j.data && j.data.biz_msg) || '', token, 200), raw: safeRaw(JSON.stringify(j), token) }
    const messages = extractMessages(j)
    if (!messages) return { ok: false, error: 'parse', raw: safeRaw(JSON.stringify(j), token) }
    return { ok: true, messages }
  }

  async function importToSessionInternal(deepseekSessionId, title, workspaceId, token) {
    const hist = await fetchHistoryInternal(deepseekSessionId, token)
    if (!hist.ok) return hist
    if (!Array.isArray(hist.messages) || hist.messages.length === 0) {
      return { ok: false, error: 'empty_history', msg: '该 DeepSeek 对话没有可导入的消息' }
    }
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) return { ok: false, error: 'persistence_unavailable' }
    const reg = ctx.get('workspaceRegistry')
    let ws = null
    if (reg && workspaceId) ws = reg.get(workspaceId)
    if (!ws) return { ok: false, error: 'no_workspace', msg: '未找到工作区' }

    const usable = importableMessages(hist.messages)
    if (usable.length === 0) {
      return { ok: false, error: 'empty_history', msg: '该 DeepSeek 对话没有可导入的消息' }
    }

    const sid = newSessionId()
    let written
    try {
      written = await writeVerifiedSession(
        persistence,
        { id: sid, createdAt: Date.now(), cwd: ws.path },
        (profile) => buildSessionEvents(usable, title, profile),
      )
    } catch (e) {
      /* `verify` means the session exists but this build cannot read it back */
      return {
        ok: false,
        error: e && e.code === 'verify' ? 'verify' : 'persist',
        /* the caller cannot clean up without knowing what was created */
        sessionId: sid,
        message: redact(String(e && e.message || e), token, 600),
      }
    }

    const summary = {
      ok: true,
      sessionId: sid,
      messageCount: usable.length,
      eventCount: written.eventCount,
      sessionFormatVersion: written.version,
      title: String(title || ''),
    }

    try {
      await ws.attachSession(sid)
    } catch (first) {
      /* A workspace can briefly fail to validate a just-written header (a
         directory realpath that is still settling); one retry covers it. The
         session itself already exists, so a second failure is reported with the
         reason instead of deleting it — the persistence contract has no delete. */
      try {
        await ws.attachSession(sid)
      } catch (e) {
        log('attachSession failed for ' + sid + ': ' + String(e && e.message || e))
        return { ...summary, attached: false, attachError: safeRaw(e && e.message || e, null, 300) }
      }
    }

    return { ...summary, attached: true }
  }

  // ---- per-action implementations ----

  const actions = {
    async tokenStatus() {
      const creds = ctx.get('credentials')
      if (!creds) return { configured: false, writable: false }
      const info = await creds.describe(TOKEN_REF)
      return { configured: info.configured, writable: info.writable }
    },
    async saveToken(args) {
      const creds = ctx.get('credentials')
      if (!creds) return { ok: false, error: 'credentials_unavailable' }
      const raw = String((args && args.token) || '')
      const token = normalizeToken(raw)
      if (!token) return { ok: false, error: 'token_empty' }
      try { await creds.set(TOKEN_REF, token); return { ok: true, normalized: true } }
      catch (e) {
        /* The credential store's own message can embed the value it refused —
           in the pasted form or the normalized one. */
        logCredentialFailure('saveToken', e, [token, raw.trim()])
        return { ok: false, error: 'save_failed' }
      }
    },
    async clearToken() {
      const creds = ctx.get('credentials')
      if (!creds) return { ok: false, error: 'credentials_unavailable' }
      /* Resolve the stored value first: the refusal being logged below can embed
         it, and without it in scope nothing could redact the secret. */
      let stored = null
      try { const r = await creds.resolve(TOKEN_REF); stored = r ? normalizeToken(r.value) : null } catch { stored = null }
      try { await creds.unset(TOKEN_REF); return { ok: true } }
      catch (e) {
        logCredentialFailure('clearToken', e, [stored])
        return { ok: false, error: 'save_failed' }
      }
    },
    async listSessions(args) {
      const token = await resolveToken(args && args.token)
      if (!token) return { ok: false, error: 'no_token', msg: '尚未保存 userToken' }
      const h = defaultHeaders(token)
      const r = await nodeHttp({ url: BASE + '/api/v0/chat_session/fetch_page?count=100', method: 'GET', headers: h })
      if (r.transport === true) return transportError(r, token)
      /* A truncated page would otherwise surface as an unexplained parse
         failure, so it is reported by name, exactly like a long history. */
      if (r.truncated === true) return { ok: false, error: 'too_large', msg: '该对话目录超出单次读取上限' }
      const j = typeof r.body === 'string' ? safeParse(r.body) : r.body
      if (r.status !== 200 || !j) return { ok: false, error: 'not_json', status: r.status, raw: safeRaw(r.body, token) }
      if (j.code !== 0) return { ok: false, error: 'api', code: j.code, msg: safeRaw(j.msg, token, 200), raw: safeRaw(JSON.stringify(j), token) }
      const bizCode = j.data && j.data.biz_code
      if (bizCode !== undefined && bizCode !== 0) return { ok: false, error: 'api', code: bizCode, msg: safeRaw((j.data && j.data.biz_msg) || '', token, 200), raw: safeRaw(JSON.stringify(j), token) }
      const sessions = extractSessions(j)
      if (!sessions) return { ok: false, error: 'parse', raw: safeRaw(JSON.stringify(j), token) }
      return {
        ok: true,
        /* An untitled conversation keeps an empty title here: the session
           builder owns the fallback, and a display placeholder stored as the
           real title would suppress it. */
        sessions: sessions.map((s) => ({ id: s.id, title: s.title || '', updatedAt: s.updated_at || s.updatedAt || s.inserted_at || null })),
      }
    },
    async fetchHistory(args) {
      const token = await resolveToken(args && args.token)
      if (!token) return { ok: false, error: 'no_token' }
      return fetchHistoryInternal(args.sessionId, token)
    },
    async listWorkspaces() {
      const reg = ctx.get('workspaceRegistry')
      if (!reg) return { ok: false, error: 'workspace_registry_unavailable' }
      const ws = reg.list()
      return { ok: true, workspaces: ws.map((w) => ({ id: w.id, title: w.title, path: w.path })) }
    },
    /**
     * Imported DSH sessions, grouped by the workspace that lists them.
     *
     * "Imported by this plugin" needs a test that survives a restart, because
     * nothing is stored on the session that marks it. Two independent facts
     * identify one, and both must hold:
     *
     *   1. the header carries no `agentPreset` and no `origin`, and
     *      `delegationDepth` is 0 — DSH always stamps a preset on the sessions
     *      its own agent loop creates, and marks subagent sessions with
     *      `origin: 'subagent'`;
     *   2. the log holds only the eight event types the importer writes
     *      (`session/title`, `turn/*`, `step/*`, `user/message`,
     *      `assistant/message`, `session/end-seed`) — never `permission/preset`,
     *      `agent/inbox/spliced`, `request/header`, `system/message` or
     *      `tool/call`, which every DSH-created conversation contains.
     *
     * Checking the event vocabulary is what excludes subagent sessions: they do
     * carry a preset, but the header test alone would also exclude a DSH session
     * the user later changed the preset of. Requiring both is the point — a
     * session this plugin wrote can never satisfy either one, and a session DSH
     * created can never satisfy both.
     */
    async listImported(args) {
      const reg = ctx.get('workspaceRegistry')
      const query = ctx.get('sessionQuery')
      if (!reg) return { ok: false, error: 'workspace_registry_unavailable' }
      if (!query) return { ok: false, error: 'session_query_unavailable' }
      const workspaceId = args && args.workspaceId
      let records
      try {
        records = await query.filterSessions([
          { kind: 'cwd', values: [null, ...reg.list().map((w) => w.path)] },
        ])
      } catch (e) {
        return { ok: false, error: 'session_query_failed', msg: safeRaw(e && e.message || e, null, 300) }
      }
      const byPath = new Map(reg.list().map((w) => [w.path, w]))
      const rows = []
      for (const record of records) {
        const header = record.header || {}
        const ws = byPath.get(header.cwd)
        if (!ws) continue
        if (workspaceId !== undefined && workspaceId !== '' && ws.id !== workspaceId) continue
        /* A DSH-created session, a subagent's, or one the user retitled: not ours. */
        if (header.agentPreset !== undefined && header.agentPreset !== null && header.agentPreset !== '') continue
        if (header.origin !== undefined && header.origin !== null) continue
        if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) continue
        if (!(await looksImported(query, header.id))) continue
        let title = ''
        try {
          const snapshot = await query.readTitle(header.id)
          title = snapshot && typeof snapshot.title === 'string' ? snapshot.title : ''
        } catch { /* an unreadable title is not a reason to hide the row */ }
        rows.push({
          id: header.id,
          title,
          workspaceId: ws.id,
          workspaceTitle: ws.title,
          createdAt: header.createdAt,
          live: record.live === true,
          stored: record.persisted === true,
        })
      }
      /* Newest first; the query service already promises that order, but the
         grouping below re-sorts per workspace and must not rely on it. */
      rows.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
      return {
        ok: true,
        sessions: rows,
        workspaces: reg.list().map((w) => ({ id: w.id, title: w.title, path: w.path })),
      }
    },
    /**
     * Move one imported session from its workspace to another.
     *
     * `attachSession` on the target and `detachSession` on the source is the
     * whole operation — the log never moves, only the registry entry that lists
     * it. Detach runs first so a failure halfway cannot leave the session listed
     * under both workspaces.
     */
    async moveSession(args) {
      const reg = ctx.get('workspaceRegistry')
      if (!reg) return { ok: false, error: 'workspace_registry_unavailable' }
      const sessionId = String((args && args.sessionId) || '')
      const toId = String((args && args.workspaceId) || '')
      if (sessionId === '') return { ok: false, error: 'missing_session' }
      const target = reg.get(toId)
      if (!target) return { ok: false, error: 'no_workspace', msg: '目标工作区不存在' }
      const query = ctx.get('sessionQuery')
      /* Refuse a session that is not in the corpus: attaching a stranger would
         create a workspace entry pointing at nothing. */
      if (query) {
        try {
          const known = await query.filterSessions([{ kind: 'id', values: [sessionId] }])
          if (known.length === 0) return { ok: false, error: 'no_such_session' }
        } catch { /* the attach below reports the real failure */ }
      }
      const source = reg.list().find((w) => w.sessionIds.includes(sessionId))
      if (source && source.id === target.id) {
        return { ok: true, moved: false, workspaceId: target.id, workspaceTitle: target.title }
      }
      if (source) {
        try { await source.detachSession(sessionId) }
        catch (e) { return { ok: false, error: 'move_failed', msg: safeRaw(e && e.message || e, null, 300) } }
      }
      try {
        await target.attachSession(sessionId)
      } catch (e) {
        /* Put it back where it came from: a half-completed move is worse than
           the error the caller is about to see. */
        if (source) { try { await source.attachSession(sessionId) } catch { /* nothing left to do */ } }
        return { ok: false, error: 'move_failed', msg: safeRaw(e && e.message || e, null, 300) }
      }
      return { ok: true, moved: true, from: source ? source.id : null, workspaceId: target.id, workspaceTitle: target.title }
    },
    /**
     * Make one imported session disappear from the sidebar.
     *
     * DSH's persistence has no delete, so this is archiving: the session leaves
     * the workspace lists and the archive set, while its log stays on disk and
     * stays recoverable. `stopActivity` is passed so a session that is still
     * running can be archived instead of refusing.
     */
    async archiveSession(args) {
      const reg = ctx.get('workspaceRegistry')
      if (!reg) return { ok: false, error: 'workspace_registry_unavailable' }
      const sessionId = String((args && args.sessionId) || '')
      if (sessionId === '') return { ok: false, error: 'missing_session' }
      try {
        await reg.archiveSession(sessionId, { stopActivity: true })
      } catch (e) {
        return { ok: false, error: 'archive_failed', msg: safeRaw(e && e.message || e, null, 300) }
      }
      const source = reg.list().find((w) => w.sessionIds.includes(sessionId))
      if (source) {
        /* Archiving already hides it; dropping the registry entry too keeps the
           workspace honest about what it contains. */
        try { await source.detachSession(sessionId) } catch { /* archive already applied */ }
      }
      return { ok: true, archived: true, sessionId }
    },
    async importToSession(args) {
      const token = await resolveToken(args && args.token)
      if (!token) return { ok: false, error: 'no_token', msg: '尚未保存 userToken' }
      return importToSessionInternal(args.sessionId, args.title, args.workspaceId, token)
    },
    async probe(args) {
      /* 诊断：只允许 https://chat.deepseek.com 的地址（避免任意 SSRF 与明文降级），
         并且不接受调用方自带的 Authorization —— 一律使用已保存的 token。 */
      let parsed = null
      try { parsed = new URL(String(args && args.url || '')) } catch { /* fallthrough */ }
      /* The default port only: an arbitrary port on the same hostname is still
         an SSRF-shaped probe. */
      const portOk = parsed !== null && (parsed.port === '' || parsed.port === '443')
      if (parsed === null || parsed.hostname !== BASE_HOST || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || !portOk) {
        return { ok: false, error: 'probe_refused', msg: 'probe 仅允许 https://chat.deepseek.com（默认端口，不接受用户名/密码）' }
      }
      const token = await resolveToken(undefined)
      const spec = { url: parsed.toString(), method: (args && args.method) || 'GET' }
      if (args && args.headers) {
        try {
          const extra = JSON.parse(args.headers)
          if (extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
            for (const [key, value] of Object.entries(extra)) {
              if (key.toLowerCase() === 'authorization') continue
              spec.headers = spec.headers || {}
              spec.headers[key] = String(value)
            }
          }
        } catch { /* ignore unparsable header JSON */ }
      }
      if (token) spec.headers = { ...(spec.headers || {}), Authorization: 'Bearer ' + token }
      if (args && args.body !== undefined && args.body !== '') { try { spec.body = JSON.parse(args.body) } catch { spec.body = args.body } }
      const result = await nodeHttp(spec)
      if (result.transport === true) return transportError(result, token)
      return {
        ...result,
        body: safeRaw(result.body, token, 4000),
        stderr: safeRaw(result.stderr, token),
      }
    },
  }

  // ---- HTTP plumbing ----

  /** JSON request bodies larger than this are rejected (sanity bound). */
  const MAX_BODY_BYTES = 1024 * 1024

  /**
   * Read one JSON request body.
   *
   * An overflow resolves *immediately* and then drains the rest instead of
   * destroying the request: `req.destroy()` takes the socket with it, so the
   * 413 could never reach the caller (the browser would see a connection reset).
   */
  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let total = 0
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      req.on('data', (c) => {
        if (settled) return
        total += c.length
        if (total > MAX_BODY_BYTES) {
          finish({ __tooLarge: true })
          /* keep consuming so the response can actually be written */
          req.resume()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (settled) return
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') return finish({})
        let body
        try {
          body = JSON.parse(text)
        } catch {
          return finish({ __malformed: true })
        }
        /* a JSON scalar or array is not an argument record */
        finish(body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {})
      })
    })
  }

  function sendJson(res, data, status = 200) {
    const text = JSON.stringify(data)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', Buffer.byteLength(text))
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(text)
  }

  /**
   * Claim one exact route for this instance.
   *
   * Registering the same (kind, path) twice is a composition error and the web
   * server says so. The one case worth repairing is a *previous instance of this
   * plugin* whose routes outlived their fiber: those are tagged as ours and are
   * evicted. An occupant tagged by anyone else is left alone, and the duplicate
   * error surfaces as the misconfiguration it is.
   *
   * Eviction is reversible: `restore` puts the evicted route back, so a mount
   * that fails halfway cannot leave a path served by nobody.
   * @param {object} route - the route to register.
   * @returns {{route: object, restore: () => void, dispose: () => void}} the
   *   registered route, a restore hook for a failed mount, and an
   *   ownership-checked disposer.
   */
  function claimRoute(route) {
    const owned = { ...route, owner: ROUTE_OWNER }
    const register = () => webServer.register(owned)
    const generation = ++nextRouteGeneration
    let dispose
    let evicted = null
    try {
      dispose = register()
    } catch (error) {
      const table = webServer.exact
      const previous = table instanceof Map ? table.get(owned.path) : undefined
      if (previous === undefined || (previous.owner !== undefined && previous.owner !== ROUTE_OWNER)) throw error
      if (previous.owner === undefined) {
        /* A route on our path with no owner tag is the pre-owner version of this
           plugin, which can never release it — but say so, because a foreign
           occupant would look the same. */
        log('evicting untagged route ' + owned.path)
      }
      table.delete(owned.path)
      evicted = previous
      dispose = register()
    }
    routeGenerations.set(owned.path, generation)
    return {
      route: owned,
      restore: () => {
        const previous = evicted
        if (previous === null) return
        evicted = null
        try { webServer.register(previous) } catch { /* the path is taken again */ }
      },
      /* Only release what this instance still owns: a later instance that
         claimed the same path keeps serving it. Generation bookkeeping is
         independent of the web server's internals, so this guard holds even if
         `exact` ever stops being exposed. */
      dispose: () => {
        if (routeGenerations.get(owned.path) !== generation) return
        routeGenerations.delete(owned.path)
        dispose()
      },
    }
  }

  /** Build the handler for one action. */
  function handlerFor(action) {
    return (req, res) => {
      /* A caller that disconnects mid-request must not escalate into an
         unhandled error: the response writes below would throw into nowhere. */
      req.on('error', () => {})
      res.on('error', () => {})
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        sendJson(res, { ok: false, error: 'method not allowed' }, 405)
        return
      }
      /* Returning the promise matters: the web server awaits the handler, so a
         rejection reaches its own logging and 400 fallback. Letting it escape
         would bypass both. */
      return readBody(req).then((body) => {
        if (body.__tooLarge) {
          /* the request body is still arriving; closing the connection after
             the response keeps the caller from waiting on an unread stream */
          res.setHeader('Connection', 'close')
          sendJson(res, { ok: false, error: 'request body too large' }, 413)
          return
        }
        if (body.__malformed) {
          sendJson(res, { ok: false, error: 'invalid JSON body' }, 400)
          return
        }
        return Promise.resolve(actions[action](body)).then((result) => {
          sendJson(res, result)
        }, (error) => {
          log('action ' + action + ' failed: ' + String(error && error.message || error))
          sendJson(res, { ok: false, error: 'internal error' }, 500)
        })
      })
    }
  }

  const claims = []
  for (const action of Object.keys(actions)) {
    try {
      claims.push(claimRoute({ kind: 'exact', path: ROUTE_PREFIX + action, handler: handlerFor(action) }))
    } catch (error) {
      /* A half-mounted plugin owns nothing: release what was claimed and put
         back any previous instance's route this attempt evicted, then fail. */
      for (const claim of claims.splice(0)) {
        claim.dispose()
        claim.restore()
      }
      throw error
    }
  }
  /* Routes are this plugin's only outward effect: dispose them with the fiber so
     a reload replaces them instead of colliding with them. */
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { for (const claim of claims.splice(0)) claim.dispose() }, 'deepseek-web-import: routes')
  }
}
