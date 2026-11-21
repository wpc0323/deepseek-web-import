/**
 * Host-half route tests with a fully faked DSH context: no DSH install and no
 * network needed, so CI can run them next to the pure unit tests.
 *
 * The fake web server copies dsh-host-webserver's real contract: registering a
 * duplicate (kind, path) throws, and the disposer it returns deletes by path.
 *
 *   node --test test/host-routes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { buildSessionEvents } from '../lib/events.js'
import { formatProfile } from '../lib/formats.js'

const HISTORY = [
  { message_id: 1, role: 'USER', inserted_at: 1700000000, fragments: [{ id: 1, type: 'REQUEST', content: 'hello' }] },
  { message_id: 2, role: 'ASSISTANT', inserted_at: 1700000001, fragments: [{ id: 2, type: 'RESPONSE', content: 'hi there' }] },
]

/** One raw DeepSeek API response wrapping the given messages. */
function deepseekResponse(messages) {
  return JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { chat_session_id: 'c1', chat_messages: messages } } })
}

/** A web server shaped like dsh-host-webserver: duplicates throw, disposers delete by path. */
function makeServer() {
  const exact = new Map()
  return {
    exact,
    register(route) {
      if (exact.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
      exact.set(route.path, route)
      return () => { exact.delete(route.path) }
    },
  }
}

/**
 * Build a plugin context whose transport, store and workspace are all fakes.
 * @param {object} [options] - overrides for the individual fakes.
 * @returns {{ctx: object, calls: object, server: object, logs: string[]}} the
 *   context, recorded interactions, the fake web server, and every line the
 *   plugin wrote to `ctx.logger.warn`.
 */
function harness(options = {}) {
  const server = options.server ?? makeServer()
  const calls = { created: [], appended: [], attached: [], specs: [], closed: 0, detached: [], archived: [] }
  const logs = []
  const transport = options.transport ?? (() => ({ status: 200, body: deepseekResponse(HISTORY) }))
  const persistence = options.persistence ?? {
    async create(header) {
      calls.created.push(header)
      return {
        async append(events) { calls.appended.push({ id: header.id, events }); calls.written = events },
        async flush() {},
        async close() { calls.closed += 1 },
      }
    },
    /* the import verifies what it wrote with whatever reader the build exposes */
    async readFrom() { return { meta: { version: 4, id: 'session-x' }, events: calls.written ?? [] } },
  }
  /* One instance per service: routes registered by apply() must land in the
     same table the test reads back from, and the spec must arrive on stdin.
     `options.subprocess` replaces the whole seam (e.g. a host whose `node`
     cannot be resolved). */
  const subprocess = options.subprocess ?? {
    async resolveExecutable() { return '/usr/bin/node' },
    spawn() {
      const result = transport()
      return {
        stdin: { on() {}, end(text) { calls.specs.push(JSON.parse(text)) } },
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: JSON.stringify(result) }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  }
  const credentials = {
    resolve: async () => ((options.token ?? 'token').length > 0 ? { value: options.token ?? 'token' } : undefined),
    describe: async () => ({ configured: (options.token ?? 'token').length > 0, writable: true }),
    set: options.credentialsSet ?? (async () => {}),
    unset: options.credentialsUnset ?? (async () => {}),
  }
  /* `options.workspaces` supplies a richer registry for the move/archive tests:
     each entry is {id, title, path, sessionIds}. Without it, the single default
     workspace keeps every earlier test unchanged. */
  const workspaceList = options.workspaces ?? [{ id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: [] }]
  const workspaceRegistry = {
    list: () => workspaceList.map((w) => ({
      ...w,
      sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
      detachSession: async (sid) => { calls.detached.push(sid); w.sessionIds = (w.sessionIds || []).filter((id) => id !== sid) },
    })),
    get: (id) => {
      const found = workspaceList.find((w) => w.id === id)
      if (found === undefined) return undefined
      return {
        ...found,
        attachSession: options.attach ?? (async (sid) => { calls.attached.push(sid); found.sessionIds = [...(found.sessionIds || []), sid] }),
        detachSession: async (sid) => { calls.detached.push(sid); found.sessionIds = (found.sessionIds || []).filter((x) => x !== sid) },
      }
    },
    archiveSession: options.archiveSession ?? (async (sid) => { calls.archived.push(sid) }),
  }
  const services = {
    webServer: server,
    credentials,
    subprocess,
    workspaceRegistry,
    sessionPersistence: persistence,
    sandboxPolicy: { workspaceRoot: '/tmp' },
  }
  if (options.sessionQuery !== undefined) services.sessionQuery = options.sessionQuery
  /* A composition missing a service is a supported state (every needle is read
     through ctx.get), so tests need to be able to leave one out. */
  for (const name of options.omit ?? []) delete services[name]
  const effects = options.effects ?? []
  const ctx = {
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') effects.push(dispose); return () => {} },
    get: (name) => services[name],
    logger: { warn: (message) => logs.push(String(message)) },
  }
  apply(ctx)
  return { ctx, calls, server, logs }
}

/** Call one registered route handler with a JSON body. */
function post(server, path, body, options = {}) {
  const route = server.exact.get(path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  return new Promise((resolve) => {
    let dataCb = null
    const req = {
      method: options.method ?? 'POST',
      on(ev, cb) {
        if (ev === 'data') dataCb = cb
        if (ev === 'end') {
          setImmediate(() => {
            if (dataCb) dataCb(Buffer.from(options.raw !== undefined ? options.raw : JSON.stringify(body ?? {})))
            cb()
          })
        }
        return this
      },
      /* a real IncomingMessage has both, and readBody calls resume() to drain
         an oversized request instead of destroying the socket */
      resume() {},
      destroy() {},
    }
    const headers = {}
    const res = {
      statusCode: 0,
      setHeader(key, value) { headers[key] = value },
      /* a real ServerResponse is an EventEmitter and the handler subscribes to
         'error' on it, so the fake has to accept listeners too */
      on() { return this },
      end(text) { resolve({ status: this.statusCode, json: JSON.parse(text), headers }) },
    }
    route.handler(req, res)
  })
}

test('every route is registered exactly once', () => {
  const { server } = harness()
  assert.equal(server.exact.size, 11)
})

test('a successful import writes one batch and attaches the session', async () => {
  const { calls, server } = harness()
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', title: 'T', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.equal(result.json.messageCount, 2)
  assert.equal(result.json.attached, true)
  assert.equal(result.json.sessionFormatVersion, 4, 'newest known format by default')
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].version, 4)
  assert.equal(calls.created[0].isSeeded, false)
  assert.equal(calls.appended.length, 1)
  assert.equal(calls.closed, 1, 'the write handle is always released')
  assert.deepEqual(calls.attached, [result.json.sessionId])
  assert.equal(calls.specs.length, 1, 'the history request went out')
  assert.match(calls.specs[0].url, /history_messages/)
  assert.match(calls.specs[0].headers.Authorization, /^Bearer /)
})

test('a refused format version is retried with the version the backend names', async () => {
  const seen = []
  const { server } = harness({
    persistence: {
      async create(header) {
        seen.push(header.version)
        if (header.version !== 2) throw new Error('encodeCurrent requires Session format v2')
        return { async append() {}, async flush() {}, async close() {} }
      },
    },
  })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.equal(result.json.sessionFormatVersion, 2)
  assert.deepEqual(seen, [4, 2], 'the stale guess is corrected, not surfaced')
})

test('a legacy service is driven through create(meta) + append(id, events)', async () => {
  const created = []
  const appended = []
  const stamp = Date.now()
  const { server } = harness({
    persistence: {
      async create(meta) { created.push(meta) },
      async append(id, events) { appended.push({ id, events }) },
      async list() { return [{ version: 0, id: 'older-session', createdAt: stamp }] },
    },
  })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.equal(result.json.sessionFormatVersion, 0, 'the stored session told us the era')
  assert.equal(created.length, 1)
  assert.equal(created[0].version, 0)
  assert.ok(!('isSeeded' in created[0]), 'v0 headers carry no isSeeded')
  assert.equal(appended.length, 1)
  assert.deepEqual(appended[0].events, buildSessionEvents(HISTORY, undefined, formatProfile(0)))
})

test('an oversized history is reported instead of a JSON parse failure', async () => {
  const { server } = harness({ transport: () => ({ status: 200, body: '{"code":0,"data":', truncated: true }) })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'too_large')
  assert.match(result.json.msg, /太长/)
})

test('a transport failure is reported as such, not as a malformed reply', async () => {
  const { server } = harness({ transport: () => ({ error: 'getaddrinfo ENOTFOUND chat.deepseek.com', stderr: 'boom' }) })
  const result = await post(server, '/__deepseek-web-import/listSessions', {})
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'transport')
  /* the host no longer prefixes a sentence: `error` is the code the browser
     localizes and `msg` carries the redacted upstream reason */
  assert.match(result.json.msg, /ENOTFOUND/)
})

test('a host without Node.js is told so instead of "internal error"', async () => {
  const { server } = harness({
    subprocess: {
      async resolveExecutable() { throw new Error('subprocess-local: command "node" was not found on PATH') },
      spawn() { throw new Error('spawn must not be reached when resolution fails') },
    },
  })
  const result = await post(server, '/__deepseek-web-import/listSessions', {})
  assert.equal(result.json.ok, false)
  /* issue #5: a missing prerequisite used to surface as an opaque 500 */
  assert.equal(result.json.error, 'node_unavailable')
  assert.match(result.json.msg, /not found on PATH/)
})

test('an upstream error never echoes the token back to the page', async () => {
  const secret = 'token'
  const { server } = harness({
    transport: () => ({ status: 200, body: JSON.stringify({ code: 40003, msg: `invalid token: ${secret}`, data: {} }) }),
  })
  const result = await post(server, '/__deepseek-web-import/listSessions', {})
  assert.equal(result.json.error, 'api')
  assert.ok(!JSON.stringify(result.json).includes(`invalid token: ${secret}`), 'the token is redacted')
  assert.match(JSON.stringify(result.json), /\[token\]/)
})

test('a conversation with no representable turns is refused', async () => {
  const { calls, server } = harness({
    transport: () => ({ status: 200, body: deepseekResponse([{ message_id: 1, role: 'SYSTEM', fragments: [{ type: 'REQUEST', content: 'note' }] }]) }),
  })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'empty_history')
  assert.equal(calls.created.length, 0, 'nothing is stored for an empty import')
})

test('an unknown workspace is refused before anything is written', async () => {
  const { calls, server } = harness()
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'nope' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'no_workspace')
  assert.equal(calls.specs.length, 1, 'the history was fetched first')
  assert.equal(calls.created.length, 0)
})

test('a missing token is reported without touching the network', async () => {
  const { calls, server } = harness({ token: '' })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'no_token')
  assert.equal(calls.specs.length, 0)
})

test('a DeepSeek API error is passed through with its code', async () => {
  const { server } = harness({ transport: () => ({ status: 200, body: JSON.stringify({ code: 40003, msg: 'token expired', data: {} }) }) })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'api')
  assert.equal(result.json.code, 40003)
})

test('a credential store failure never echoes the store message', async () => {
  const { server } = harness({
    credentialsSet: async () => { throw new Error('credentials-local: invalid value=sk-secret-token-xyz') },
  })
  const result = await post(server, '/__deepseek-web-import/saveToken', { token: 'sk-secret-token-xyz' })
  assert.equal(result.json.ok, false)
  assert.ok(!JSON.stringify(result.json).includes('sk-secret-token-xyz'), 'no secret reaches the page')
  /* the store's complaint is replaced by a stable code the client localizes;
     the raw text stays in the log (see the log-redaction test below) */
  assert.equal(result.json.error, 'save_failed')
})

test('an attach failure is retried, then reported', async () => {
  let attempts = 0
  const { server } = harness({ attach: async () => { attempts += 1; throw new Error('cwd does not resolve') } })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, true)
  assert.equal(result.json.attached, false)
  assert.equal(attempts, 2, 'one retry before giving up')
  assert.match(result.json.attachError, /cwd/)
})

test('the probe route refuses anything outside https://chat.deepseek.com', async () => {
  const { calls, server } = harness()
  for (const url of [
    'https://example.com/steal',
    'http://chat.deepseek.com/api/v0/x',
    'https://chat.deepseek.com.evil.test/x',
    'https://user:pass@chat.deepseek.com/x',
  ]) {
    const blocked = await post(server, '/__deepseek-web-import/probe', { url })
    assert.equal(blocked.json.ok, false, url)
  }
  assert.equal(calls.specs.length, 0, 'no SSRF attempt is made')

  const allowed = await post(server, '/__deepseek-web-import/probe', { url: 'https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=1' })
  assert.equal(allowed.status, 200)
  assert.equal(calls.specs.length, 1)
})

test('the probe route ignores a caller-supplied Authorization header', async () => {
  const { calls, server } = harness()
  await post(server, '/__deepseek-web-import/probe', {
    url: 'https://chat.deepseek.com/api/v0/users/current',
    method: 'DELETE',
    headers: JSON.stringify({ Authorization: 'Bearer attacker-token', 'x-extra': 'kept' }),
  })
  assert.equal(calls.specs.length, 1)
  assert.equal(calls.specs[0].headers.Authorization, 'Bearer token', 'the stored token is used')
  assert.equal(calls.specs[0].headers['x-extra'], 'kept')
})

test('a non-POST request is rejected with an Allow header', async () => {
  const { server } = harness()
  const response = await post(server, '/__deepseek-web-import/tokenStatus', undefined, { method: 'GET' })
  assert.equal(response.status, 405)
  assert.equal(response.headers.Allow, 'POST')
})

test('a malformed JSON body is a 400, a JSON scalar an empty argument record', async () => {
  const { server } = harness()
  const malformed = await post(server, '/__deepseek-web-import/tokenStatus', undefined, { raw: '{"broken' })
  assert.equal(malformed.status, 400)
  assert.match(malformed.json.error, /invalid JSON/)
  const scalar = await post(server, '/__deepseek-web-import/tokenStatus', undefined, { raw: 'null' })
  assert.equal(scalar.status, 200)
  assert.deepEqual(scalar.json, { configured: true, writable: true })
})

test('an oversized request body is answered with 413 instead of hanging', async () => {
  const { server } = harness()
  const route = server.exact.get('/__deepseek-web-import/saveToken')
  const response = await new Promise((resolve) => {
    const req = {
      method: 'POST',
      on(ev, cb) {
        if (ev === 'data') setImmediate(() => cb(Buffer.alloc(2 * 1024 * 1024, 0x61)))
        if (ev === 'end') setImmediate(cb)
        return this
      },
      /* the overflow path drains the request instead of destroying it */
      resume() {},
      destroy() {},
    }
    const res = {
      statusCode: 0,
      setHeader() {},
      on() { return this },
      end(text) { resolve({ status: this.statusCode, json: JSON.parse(text) }) },
    }
    route.handler(req, res)
  })
  assert.equal(response.status, 413)
  assert.equal(response.json.error, 'request body too large')
})

test('a writer that cannot release ownership fails the import', async () => {
  const { server } = harness({
    persistence: {
      async create() {
        return {
          async append() {},
          async flush() {},
          async close() { throw new Error('session lock could not be released') },
        }
      },
    },
  })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false, 'a stale lock must not be reported as success')
  assert.equal(result.json.error, 'persist')
  assert.match(result.json.message, /lock/)
})

test('a failed write keeps its own error even when the writer also fails to close', async () => {
  const { server } = harness({
    persistence: {
      async create() {
        return {
          async append() { throw new Error('append exploded') },
          async flush() {},
          async close() { throw new Error('close exploded') },
        }
      },
    },
  })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.error, 'persist')
  assert.match(result.json.message, /append exploded/)
})

test('a session this build cannot read back is reported, not reported as success', async () => {
  const { calls, server } = harness({
    persistence: {
      async create(header) {
        calls.created.push(header)
        return { async append() {}, async flush() {}, async close() {} }
      },
      async readFrom() { throw new Error('contains event type "future/event" unknown to this harness') },
    },
  })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'verify')
  assert.match(result.json.message, /读不回来/)
  assert.equal(calls.attached.length, 0, 'an unreadable session is not attached to a workspace')
})

test('the read-back tolerates one transient failure', async () => {
  let attempts = 0
  const { server } = harness({
    persistence: {
      async create(header) {
        return { async append() {}, async flush() {}, async close() {} }
      },
      async readFrom() {
        attempts += 1
        if (attempts === 1) throw new Error('token revision moved')
        return { meta: { version: 4, id: 'session-x' }, events: [{}] }
      },
    },
  })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.equal(attempts, 2)
})

test('a write failure surfaces the backend message', async () => {
  const { server } = harness({ persistence: { async create() { throw new Error('disk is full') } } })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'persist')
  assert.match(result.json.message, /disk is full/)
})

test('token status reflects the credential store', async () => {
  const configured = harness({ token: 'abc' })
  assert.deepEqual((await post(configured.server, '/__deepseek-web-import/tokenStatus', {})).json, { configured: true, writable: true })
  const empty = harness({ token: '' })
  assert.deepEqual((await post(empty.server, '/__deepseek-web-import/tokenStatus', {})).json, { configured: false, writable: true })
})

test('a second mount keeps serving after the old fiber disposes', () => {
  const server = makeServer()
  const first = []
  harness({ server, effects: first })
  assert.equal(server.exact.size, 11)
  const second = []
  harness({ server, effects: second })
  assert.equal(server.exact.size, 11, 'the new instance reclaimed the routes')
  const before = server.exact.get('/__deepseek-web-import/probe')
  for (const dispose of first) dispose()
  assert.equal(server.exact.size, 11, 'the old instance must not remove the new routes')
  assert.equal(server.exact.get('/__deepseek-web-import/probe'), before)
  for (const dispose of second) dispose()
  assert.equal(server.exact.size, 0, 'the current instance releases its own routes')
})

test('a route owned by someone else is left alone and the mount fails loudly', () => {
  const server = makeServer()
  const path = '/__deepseek-web-import/probe'
  server.exact.set(path, { kind: 'exact', path, handler() {}, owner: 'another-plugin' })
  const effects = []
  assert.throws(() => harness({ server, effects }), /duplicate exact route/)
  assert.equal(server.exact.get(path).owner, 'another-plugin')
  assert.equal(server.exact.size, 1, 'nothing half-mounted is left behind')
  assert.equal(effects.length, 0)
})

test('a mount that fails midway leaves no routes behind', () => {
  const server = makeServer()
  let calls = 0
  const original = server.register.bind(server)
  server.register = (route) => {
    calls += 1
    if (calls === 3) throw new Error('boom')
    return original(route)
  }
  assert.throws(() => harness({ server }), /boom/)
  assert.equal(server.exact.size, 0, 'the two already-claimed routes were released')
})

test('an untagged occupant of our path is treated as an earlier instance', () => {
  const server = makeServer()
  const path = '/__deepseek-web-import/probe'
  server.exact.set(path, { kind: 'exact', path, handler() {} })
  harness({ server })
  assert.equal(server.exact.size, 11)
  assert.equal(server.exact.get(path).owner, 'deepseek-web-import')
})

// ---- stable error codes and answer shapes ----

test('a truncated conversation directory is reported by name, like a long history', async () => {
  // a truncated page would otherwise surface as an unexplained parse failure
  const { server } = harness({ transport: () => ({ status: 200, body: '{"code":0,"data":', truncated: true }) })
  const result = await post(server, '/__deepseek-web-import/listSessions', {})
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'too_large')
})

test('an untitled conversation keeps an empty title for the session builder', async () => {
  // the display placeholder belongs to the browser half; storing it as the real
  // title would suppress the builder's own fallback
  const { server } = harness({
    transport: () => ({
      status: 200,
      body: JSON.stringify({
        code: 0,
        data: { biz_code: 0, biz_data: { chat_sessions: [{ id: 'c1', title: '' }, { id: 'c2' }, { id: 'c3', title: 'named', updated_at: 1700000000 }] } },
      }),
    }),
  })
  const result = await post(server, '/__deepseek-web-import/listSessions', {})
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.sessions.map((s) => s.title), ['', '', 'named'])
  assert.equal(result.json.sessions[2].updatedAt, 1700000000)
})

test('a credential store failure is a stable code, and the secret reaches neither the page nor the log', async () => {
  const secret = 'sk-secret-token-xyz'
  const { server, logs } = harness({
    credentialsSet: async () => { throw new Error('credentials-local: invalid value=' + secret) },
  })
  const result = await post(server, '/__deepseek-web-import/saveToken', { token: secret })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'save_failed')
  assert.ok(!JSON.stringify(result.json).includes(secret), 'no secret reaches the page')
  assert.equal(logs.length, 1, 'the failure is diagnosed once')
  assert.match(logs[0], /saveToken failed/)
  assert.ok(!logs[0].includes(secret), 'no secret reaches the log either')
  assert.match(logs[0], /\[token\]/, 'the log keeps a redacted trace')
})

test('a blank token is refused before the store is touched', async () => {
  let writes = 0
  const { server } = harness({ credentialsSet: async () => { writes += 1 } })
  const result = await post(server, '/__deepseek-web-import/saveToken', { token: '   ' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'token_empty')
  assert.equal(writes, 0)
})

test('a refused clear is reported as a failure, not as success', async () => {
  // the credential store can refuse a clear (read-only file, foreign value)
  const { server, logs } = harness({ credentialsUnset: async () => { throw new Error('read-only credential store') } })
  const result = await post(server, '/__deepseek-web-import/clearToken', {})
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'save_failed')
  assert.ok(logs.some((line) => line.includes('clearToken failed')), logs.join('\n'))
})

test('a missing service is answered with its stable code, never with an internal sentence', async () => {
  const noCredentials = harness({ omit: ['credentials'] })
  assert.equal((await post(noCredentials.server, '/__deepseek-web-import/saveToken', { token: 'x' })).json.error, 'credentials_unavailable')
  assert.equal((await post(noCredentials.server, '/__deepseek-web-import/clearToken', {})).json.error, 'credentials_unavailable')
  assert.deepEqual((await post(noCredentials.server, '/__deepseek-web-import/tokenStatus', {})).json, { configured: false, writable: false })

  const noRegistry = harness({ omit: ['workspaceRegistry'] })
  assert.equal((await post(noRegistry.server, '/__deepseek-web-import/listWorkspaces', {})).json.error, 'workspace_registry_unavailable')

  const noSubprocess = harness({ omit: ['subprocess'] })
  const transport = await post(noSubprocess.server, '/__deepseek-web-import/listSessions', {})
  assert.equal(transport.json.error, 'subprocess_unavailable')
  assert.ok(!JSON.stringify(transport.json).includes('服务不可用'), 'the internal sentence is not echoed')
})

test('an import without a persistence service writes nothing', async () => {
  const { calls, server } = harness({ omit: ['sessionPersistence'] })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'persistence_unavailable', 'a missing service answers with its stable code')
  assert.equal(calls.created.length, 0)
  assert.equal(calls.appended.length, 0)
})

test('the probe route refuses a non-default port on the allowed host', async () => {
  const { calls, server } = harness()
  const refused = await post(server, '/__deepseek-web-import/probe', { url: 'https://chat.deepseek.com:8443/x' })
  assert.equal(refused.json.ok, false)
  assert.equal(refused.json.error, 'probe_refused')
  assert.equal(calls.specs.length, 0, 'a foreign port is refused before any request leaves the process')

  const allowed = await post(server, '/__deepseek-web-import/probe', { url: 'https://chat.deepseek.com:443/api/v0/users/current' })
  assert.equal(allowed.status, 200)
  assert.equal(calls.specs.length, 1, 'the default port (explicit or implicit) is allowed')
})

test('a failed write names the session it created so the caller can clean up', async () => {
  const { server } = harness({ persistence: { async create() { throw new Error('disk is full') } } })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'persist')
  assert.match(result.json.sessionId, /^session-/)
  assert.match(result.json.message, /disk is full/)
})

test('an unreadable session reports its id as well', async () => {
  const { server } = harness({
    persistence: {
      async create() { return { async append() {}, async flush() {}, async close() {} } },
      async readFrom() { throw new Error('unknown event type') },
    },
  })
  const result = await post(server, '/__deepseek-web-import/importToSession', { sessionId: 'c1', workspaceId: 'ws-1' })
  assert.equal(result.json.error, 'verify')
  assert.match(result.json.sessionId, /^session-/)
})

// ---- route ownership: eviction is reversible, release is generation-checked ----

/* Eviction is reversible: `claimRoute`'s restore hook exists so that a mount
 * which fails after evicting a previous instance's route cannot leave the path
 * served by nobody. The route that was evicted has to come back — with its own
 * handler — while the half-mounted instance still releases what it claimed. */
test('a mount that fails after evicting an earlier route puts that route back', () => {
  const server = makeServer()
  const path = '/__deepseek-web-import/tokenStatus'
  const oldRoute = { kind: 'exact', path, handler() {}, owner: 'deepseek-web-import' }
  server.exact.set(path, oldRoute)
  /* the first route is claimed (duplicate refusal → eviction → reclaim) and the
     second one fails, so the rollback runs while a route this attempt already
     evicted is still missing from the table */
  const original = server.register.bind(server)
  const registered = []
  server.register = (route) => {
    registered.push(route === null || route === undefined ? null : route.path)
    if (route === null || route === undefined) throw new TypeError('webserver: a route is required')
    if (route.path === '/__deepseek-web-import/saveToken') throw new Error('mount exploded')
    return original(route)
  }
  assert.throws(() => harness({ server }), /mount exploded/)

  /* the eviction really happened: refusal first, then the reclaim */
  assert.deepEqual(registered.slice(0, 2), [path, path])
  assert.deepEqual(registered.at(-1), path, 'restore() re-registers the route it evicted')
  assert.equal(server.exact.get(path), oldRoute, 'the evicted route is back, not lost')
  assert.equal(server.exact.size, 1, 'the half-mounted instance released its own route')
  assert.equal(typeof server.exact.get(path).handler, 'function', 'the restored path is still served')
})

test('disposing an instance twice is a harmless no-op', () => {
  const server = makeServer()
  const first = []
  const second = []
  harness({ server, effects: first })
  harness({ server, effects: second })
  const current = server.exact.get('/__deepseek-web-import/probe')
  for (const dispose of first) dispose()
  for (const dispose of first) dispose()
  assert.equal(server.exact.size, 11, 'a stale disposer deletes nothing')
  assert.equal(server.exact.get('/__deepseek-web-import/probe'), current)
})

test('evicting an untagged occupant is logged, a tagged one is not', () => {
  const untaggedPath = '/__deepseek-web-import/probe'
  const untaggedServer = makeServer()
  untaggedServer.exact.set(untaggedPath, { kind: 'exact', path: untaggedPath, handler() {} })
  const untagged = harness({ server: untaggedServer })
  assert.ok(
    untagged.logs.some((line) => line.includes('evicting untagged route ' + untaggedPath)),
    untagged.logs.join('\n'),
  )
  assert.equal(untaggedServer.exact.size, 11)

  /* our own previous instance is expected, so it is evicted silently */
  const taggedServer = makeServer()
  taggedServer.exact.set(untaggedPath, { kind: 'exact', path: untaggedPath, handler() {}, owner: 'deepseek-web-import' })
  const tagged = harness({ server: taggedServer })
  assert.ok(!tagged.logs.some((line) => line.includes('evicting untagged')), tagged.logs.join('\n'))
  assert.equal(taggedServer.exact.size, 11)
})

/* ---- imported-session management: list, move, archive ---- */

/** A query service double over a fixed corpus, with titles by id. */
function fakeQuery(records, titles = {}, events = {}) {
  return {
    async filterSessions(filters) {
      const byCwd = filters.find((f) => f.kind === 'cwd')
      const byId = filters.find((f) => f.kind === 'id')
      return records.filter((r) => {
        if (byId) return byId.values.includes(r.header.id)
        if (byCwd) return byCwd.values.includes(r.header.cwd)
        return true
      })
    },
    async readTitle(id) {
      return titles[id] === undefined ? undefined : { title: titles[id], eventSeq: 0, updatedAt: 0 }
    },
    /* The event vocabulary decides whether a session looks importer-written. */
    async listEvents(id) {
      const types = events[id]
      if (types === undefined) throw new Error('no log for ' + id)
      return types.map((type, seq) => ({ sessionId: id, seq, type, time: seq, surface: 'current' }))
    },
  }
}

/** The eight event types the importer writes, in a plausible order. */
const IMPORTED_EVENTS = ['session/title', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'session/end-seed']

test('listImported groups stored sessions by the workspace that owns their cwd', async () => {
  const query = fakeQuery(
    [
      { header: { id: 'session-a', cwd: '/tmp/ws', createdAt: 100 }, live: false, persisted: true },
      { header: { id: 'session-b', cwd: '/tmp/other', createdAt: 200 }, live: false, persisted: true },
      { header: { id: 'session-c', cwd: '/not/a/workspace', createdAt: 300 }, live: false, persisted: true },
    ],
    { 'session-a': 'imported one', 'session-b': 'imported two' },
    { 'session-a': IMPORTED_EVENTS, 'session-b': IMPORTED_EVENTS, 'session-c': IMPORTED_EVENTS },
  )
  const { server } = harness({
    sessionQuery: query,
    workspaces: [
      { id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: ['session-a'] },
      { id: 'ws-2', title: 'other', path: '/tmp/other', sessionIds: ['session-b'] },
    ],
  })
  const result = await post(server, '/__deepseek-web-import/listImported', {})
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  /* newest first, and the session whose cwd belongs to no workspace is skipped */
  assert.deepEqual(result.json.sessions.map((row) => row.id), ['session-b', 'session-a'])
  assert.equal(result.json.sessions[0].workspaceTitle, 'other')
  assert.equal(result.json.sessions[1].title, 'imported one')
  assert.equal(result.json.workspaces.length, 2)
})

test('listImported can be narrowed to one workspace', async () => {
  const query = fakeQuery([
    { header: { id: 'session-a', cwd: '/tmp/ws', createdAt: 100 }, live: false, persisted: true },
    { header: { id: 'session-b', cwd: '/tmp/other', createdAt: 200 }, live: false, persisted: true },
  ], {}, { 'session-a': IMPORTED_EVENTS, 'session-b': IMPORTED_EVENTS })
  const { server } = harness({
    sessionQuery: query,
    workspaces: [
      { id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: ['session-a'] },
      { id: 'ws-2', title: 'other', path: '/tmp/other', sessionIds: ['session-b'] },
    ],
  })
  const result = await post(server, '/__deepseek-web-import/listImported', { workspaceId: 'ws-2' })
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.sessions.map((row) => row.id), ['session-b'])
})

test('moveSession detaches from the source and attaches to the target', async () => {
  const query = fakeQuery([{ header: { id: 'session-a', cwd: '/tmp/ws', createdAt: 1 }, live: false, persisted: true }], {}, { 'session-a': IMPORTED_EVENTS })
  const { server, calls } = harness({
    sessionQuery: query,
    workspaces: [
      { id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: ['session-a'] },
      { id: 'ws-2', title: 'other', path: '/tmp/other', sessionIds: [] },
    ],
  })
  const result = await post(server, '/__deepseek-web-import/moveSession', { sessionId: 'session-a', workspaceId: 'ws-2' })
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.equal(result.json.moved, true)
  assert.equal(result.json.from, 'ws-1')
  assert.equal(result.json.workspaceId, 'ws-2')
  assert.deepEqual(calls.detached, ['session-a'])
  assert.deepEqual(calls.attached, ['session-a'])
})

test('moveSession refuses an unknown target or session, and is a no-op in place', async () => {
  const query = fakeQuery([{ header: { id: 'session-a', cwd: '/tmp/ws', createdAt: 1 }, live: false, persisted: true }], {}, { 'session-a': IMPORTED_EVENTS })
  const workspaces = [
    { id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: ['session-a'] },
    { id: 'ws-2', title: 'other', path: '/tmp/other', sessionIds: [] },
  ]
  const { server, calls } = harness({ sessionQuery: query, workspaces })

  const unknownTarget = await post(server, '/__deepseek-web-import/moveSession', { sessionId: 'session-a', workspaceId: 'ws-404' })
  assert.equal(unknownTarget.json.ok, false)
  assert.equal(unknownTarget.json.error, 'no_workspace')

  const unknownSession = await post(server, '/__deepseek-web-import/moveSession', { sessionId: 'session-404', workspaceId: 'ws-2' })
  assert.equal(unknownSession.json.ok, false)
  assert.equal(unknownSession.json.error, 'no_such_session')

  /* already there: nothing moves, and no registry write happens */
  const inPlace = await post(server, '/__deepseek-web-import/moveSession', { sessionId: 'session-a', workspaceId: 'ws-1' })
  assert.equal(inPlace.json.ok, true)
  assert.equal(inPlace.json.moved, false)
  assert.deepEqual(calls.detached, [])
  assert.deepEqual(calls.attached, [])
})

test('a failed attach puts the session back in its original workspace', async () => {
  const query = fakeQuery([{ header: { id: 'session-a', cwd: '/tmp/ws', createdAt: 1 }, live: false, persisted: true }], {}, { 'session-a': IMPORTED_EVENTS })
  const workspaces = [
    { id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: ['session-a'] },
    { id: 'ws-2', title: 'other', path: '/tmp/other', sessionIds: [] },
  ]
  /* `attach` is handed to BOTH the registry.get() target and the list() entries
     below, so it must decide by workspace id, not by call order: the target
     refuses once, the source accepts the rollback. */
  const refused = []
  const reattached = []
  const attach = async function (sid) {
    if (this.workspaceId === 'ws-2') { refused.push(sid); throw new Error('target refused') }
    if (this.workspaceId === 'ws-1') reattached.push(sid)
  }
  const harnessed = harness({ sessionQuery: query, workspaces, attach })
  /* The plugin reads the source from `list()` and the target from `get()`, so tag
     each returned entity with its id for the stub above. */
  const registry = harnessed.ctx.get('workspaceRegistry')
  const originalList = registry.list
  const originalGet = registry.get
  registry.list = () => originalList().map((w) => ({ ...w, attachSession: attach.bind({ workspaceId: w.id }) }))
  registry.get = (id) => {
    const found = originalGet(id)
    return found === undefined ? undefined : { ...found, attachSession: attach.bind({ workspaceId: id }) }
  }

  const result = await post(harnessed.server, '/__deepseek-web-import/moveSession', { sessionId: 'session-a', workspaceId: 'ws-2' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'move_failed')
  assert.deepEqual(refused, ['session-a'], 'the target refused the attach')
  assert.ok(harnessed.calls.detached.includes('session-a'), 'detached from the source before attaching')
  assert.deepEqual(reattached, ['session-a'], 'rollback re-attached to the source')
})

test('archiveSession archives and drops the registry entry', async () => {
  const { server, calls } = harness({
    workspaces: [{ id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: ['session-a'] }],
  })
  const result = await post(server, '/__deepseek-web-import/archiveSession', { sessionId: 'session-a' })
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.equal(result.json.archived, true)
  assert.deepEqual(calls.archived, ['session-a'])
  assert.deepEqual(calls.detached, ['session-a'])
})

test('archiveSession reports a refusal instead of claiming success', async () => {
  const { server } = harness({
    workspaces: [{ id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: ['session-a'] }],
    archiveSession: async () => { throw new Error('still running') },
  })
  const result = await post(server, '/__deepseek-web-import/archiveSession', { sessionId: 'session-a' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'archive_failed')
  assert.match(result.json.msg, /still running/)
})

test('listImported excludes DSH sessions, subagents, and anything it cannot read', async () => {
  /* One of each kind that must NOT be listed, next to one that must. */
  const query = fakeQuery(
    [
      /* an imported session: no preset, no origin, never drove a model */
      { header: { id: 'imported', cwd: '/tmp/ws', createdAt: 500 }, live: false, persisted: true },
      /* a DSH conversation: preset + a real model request */
      { header: { id: 'dsh-chat', cwd: '/tmp/ws', createdAt: 400, agentPreset: 'standard' }, live: false, persisted: true },
      /* a subagent session: origin + delegation depth */
      { header: { id: 'subagent', cwd: '/tmp/ws', createdAt: 300, agentPreset: 'cordis', origin: 'subagent', delegationDepth: 1 }, live: false, persisted: true },
      /* an imported header the user later kept chatting in: request/header appears */
      { header: { id: 'continued', cwd: '/tmp/ws', createdAt: 200 }, live: false, persisted: true },
      /* an imported header whose log this build cannot read at all */
      { header: { id: 'unreadable', cwd: '/tmp/ws', createdAt: 100 }, live: false, persisted: true },
      /* a settings-only log with no conversation: not an import */
      { header: { id: 'settings-only', cwd: '/tmp/ws', createdAt: 50 }, live: false, persisted: true },
    ],
    { imported: 'from web', 'dsh-chat': 'a real chat', subagent: 'a subagent', continued: 'kept chatting', unreadable: 'gone', 'settings-only': 'nothing' },
    {
      imported: IMPORTED_EVENTS,
      'dsh-chat': ['permission/preset', 'sandbox/mode', 'request/header', ...IMPORTED_EVENTS],
      subagent: ['permission/preset', 'agent/inbox/spliced', ...IMPORTED_EVENTS],
      continued: [...IMPORTED_EVENTS, 'request/header', 'system/message'],
      'settings-only': ['permission/preset', 'sandbox/mode', 'approval/policy'],
      /* `unreadable` deliberately has no entry: listEvents throws */
    },
  )
  const { server } = harness({
    sessionQuery: query,
    workspaces: [{ id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: [] }],
  })
  const result = await post(server, '/__deepseek-web-import/listImported', {})
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.deepEqual(result.json.sessions.map((row) => row.id), ['imported'])
})

test('an imported log that gained DSH settings events is still an import', async () => {
  /* DSH appends permission/preset + sandbox/mode + approval/policy whenever the
     session is opened, so the presence of those must not hide an import. */
  const query = fakeQuery(
    [{ header: { id: 'opened', cwd: '/tmp/ws', createdAt: 1 }, live: false, persisted: true }],
    { opened: 'still an import' },
    { opened: [...IMPORTED_EVENTS, 'permission/preset', 'sandbox/mode', 'approval/policy', 'system/message'] },
  )
  const { server } = harness({
    sessionQuery: query,
    workspaces: [{ id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: [] }],
  })
  const result = await post(server, '/__deepseek-web-import/listImported', {})
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.sessions.map((row) => row.id), ['opened'])
})

test('a session whose log holds a real model turn is not imported', async () => {
  for (const marker of ['request/header', 'assistant/attempt', 'assistant/chunk', 'tool/call']) {
    const query = fakeQuery(
      [{ header: { id: 'live', cwd: '/tmp/ws', createdAt: 1 }, live: false, persisted: true }],
      { live: 'real turn' },
      { live: [...IMPORTED_EVENTS, marker] },
    )
    const { server } = harness({
      sessionQuery: query,
      workspaces: [{ id: 'ws-1', title: 'ws', path: '/tmp/ws', sessionIds: [] }],
    })
    const result = await post(server, '/__deepseek-web-import/listImported', {})
    assert.deepEqual(result.json.sessions, [], marker + ' should exclude the session')
  }
})

test('the management routes need their services and a session id', async () => {
  const noQuery = harness({ omit: ['sessionQuery'] })
  const listed = await post(noQuery.server, '/__deepseek-web-import/listImported', {})
  assert.equal(listed.json.error, 'session_query_unavailable')

  const noRegistry = harness({ omit: ['workspaceRegistry'] })
  const moved = await post(noRegistry.server, '/__deepseek-web-import/moveSession', { sessionId: 'x', workspaceId: 'y' })
  assert.equal(moved.json.error, 'workspace_registry_unavailable')

  const { server } = harness()
  const missing = await post(server, '/__deepseek-web-import/archiveSession', {})
  assert.equal(missing.json.error, 'missing_session')
})
