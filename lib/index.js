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
 * - The diagnostic `probe` route only accepts chat.deepseek.com URLs (no
 *   arbitrary SSRF).
 * - Error responses use fixed text; internals are never echoed.
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

/** Fixed message for a credential-store failure: store errors can embed values. */
const SAVE_FAILED = 'token 操作失败（详见 DSH 日志）'

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

  /** Run one raw HTTP request through the subprocess seam (spec travels on stdin). */
  async function nodeHttp(spec) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return { error: 'subprocess 服务不可用' }
    const policy = ctx.get('sandboxPolicy')
    const cwd = (policy && policy.workspaceRoot) ? policy.workspaceRoot : '.'
    const result = await runRequest(subprocess, spec, { cwd })
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
    return {
      ok: false,
      error: 'transport',
      msg: '网络请求失败：' + redact(result.error || result.stderr || '未知错误', token, 200),
    }
  }

  /** Cap and redact any upstream text that travels back to the browser. */
  function safeRaw(value, token, limit = 600) {
    return redact(value, token, limit)
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
    if (!persistence) return { ok: false, error: 'sessionPersistence 服务不可用' }
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
      return { ok: false, error: e && e.code === 'verify' ? 'verify' : 'persist', message: String(e && e.message || e) }
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
      if (!creds) return { ok: false, error: 'credentials 服务不可用' }
      const token = normalizeToken(String((args && args.token) || ''))
      if (!token) return { ok: false, error: 'token 为空（或解析失败）' }
      try { await creds.set(TOKEN_REF, token); return { ok: true, normalized: true } }
      catch (e) {
        /* the credential store's own message can embed the value it refused */
        log('saveToken failed: ' + String(e && e.message || e))
        return { ok: false, error: SAVE_FAILED }
      }
    },
    async clearToken() {
      const creds = ctx.get('credentials')
      if (!creds) return { ok: false, error: 'credentials 服务不可用' }
      try { await creds.unset(TOKEN_REF); return { ok: true } }
      catch (e) {
        log('clearToken failed: ' + String(e && e.message || e))
        return { ok: false, error: SAVE_FAILED }
      }
    },
    async listSessions(args) {
      const token = await resolveToken(args && args.token)
      if (!token) return { ok: false, error: 'no_token', msg: '尚未保存 userToken' }
      const h = defaultHeaders(token)
      const r = await nodeHttp({ url: BASE + '/api/v0/chat_session/fetch_page?count=100', method: 'GET', headers: h })
      if (r.transport === true) return transportError(r, token)
      const j = typeof r.body === 'string' ? safeParse(r.body) : r.body
      if (r.status !== 200 || !j) return { ok: false, error: 'not_json', status: r.status, raw: safeRaw(r.body, token) }
      if (j.code !== 0) return { ok: false, error: 'api', code: j.code, msg: safeRaw(j.msg, token, 200), raw: safeRaw(JSON.stringify(j), token) }
      const bizCode = j.data && j.data.biz_code
      if (bizCode !== undefined && bizCode !== 0) return { ok: false, error: 'api', code: bizCode, msg: safeRaw((j.data && j.data.biz_msg) || '', token, 200), raw: safeRaw(JSON.stringify(j), token) }
      const sessions = extractSessions(j)
      if (!sessions) return { ok: false, error: 'parse', raw: safeRaw(JSON.stringify(j), token) }
      return {
        ok: true,
        sessions: sessions.map((s) => ({ id: s.id, title: s.title || '(无标题)', updatedAt: s.updated_at || s.updatedAt || s.inserted_at || null })),
      }
    },
    async fetchHistory(args) {
      const token = await resolveToken(args && args.token)
      if (!token) return { ok: false, error: 'no_token' }
      return fetchHistoryInternal(args.sessionId, token)
    },
    async listWorkspaces() {
      const reg = ctx.get('workspaceRegistry')
      if (!reg) return { ok: false, error: 'workspaceRegistry 不可用' }
      const ws = reg.list()
      return { ok: true, workspaces: ws.map((w) => ({ id: w.id, title: w.title, path: w.path })) }
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
      if (parsed === null || parsed.hostname !== BASE_HOST || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
        return { ok: false, error: 'probe 仅允许 https://chat.deepseek.com 的地址（不接受用户名/密码）' }
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
   * An overflow resolves *immediately*: a destroyed request never emits `end`,
   * so waiting for it would leave the response unsent and the browser with a
   * connection reset instead of a 413.
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
          req.destroy()
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
   * @param {object} route - the route to register.
   * @returns {{route: object, dispose: () => void}} the registered route and an
   *   ownership-checked disposer.
   */
  function claimRoute(route) {
    const owned = { ...route, owner: ROUTE_OWNER }
    const register = () => webServer.register(owned)
    let dispose
    try {
      dispose = register()
    } catch (error) {
      const table = webServer.exact
      const previous = table instanceof Map ? table.get(owned.path) : undefined
      if (previous === undefined || (previous.owner !== undefined && previous.owner !== ROUTE_OWNER)) throw error
      table.delete(owned.path)
      dispose = register()
    }
    return {
      route: owned,
      /* Only release what this instance still owns: a later instance that
         claimed the same path keeps serving it. */
      dispose: () => {
        const table = webServer.exact
        if (table instanceof Map && table.get(owned.path) !== owned) return
        dispose()
      },
    }
  }

  /** Build the handler for one action. */
  function handlerFor(action) {
    return (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        sendJson(res, { ok: false, error: 'method not allowed' }, 405)
        return
      }
      readBody(req).then((body) => {
        if (body.__tooLarge) {
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
      /* a half-mounted plugin owns nothing: release what was claimed, then fail */
      for (const claim of claims.splice(0)) claim.dispose()
      throw error
    }
  }
  /* Routes are this plugin's only outward effect: dispose them with the fiber so
     a reload replaces them instead of colliding with them. */
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { for (const claim of claims.splice(0)) claim.dispose() }, 'deepseek-web-import: routes')
  }
}
