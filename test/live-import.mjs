/**
 * Offline end-to-end test of the host half: the real routes, the real
 * persistence backend of the ambient build, and a canned DeepSeek response.
 *
 * Run it from a directory where the DSH packages resolve:
 *
 *   cd /usr/local/lib/node_modules/@deepseek-ai/dsh && node <repo>/test/live-import.mjs
 *
 * The harness stubs only the network (`subprocess`) and the credential store;
 * everything below the routes — event building, format adaptation, persistence
 * writes, workspace attachment — is the shipped code.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

async function ambient(name) {
  const require = createRequire(join(process.cwd(), 'package.json'))
  return await import(pathToFileURL(require.resolve(name)).href)
}

const scratch = join(repoRoot, '.live-import')
rmSync(scratch, { recursive: true, force: true })
const storeRoot = join(scratch, 'sessions')
const workspace = join(scratch, 'workspace')
mkdirSync(storeRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })

const { Context } = await ambient('@deepseek-ai/cordis')
const Jsonl = (await ambient('@deepseek-ai/dsh-session-persistence-jsonl')).default
const { Session } = await ambient('@deepseek-ai/dsh-session')

const ctx = new Context()
let persistence
try {
  persistence = new Jsonl(ctx, { root: storeRoot })
} catch {
  const retry = new Context()
  retry.provide('sessions', { list: () => [], get: () => undefined, prepare: async () => { throw new Error('no live store') } })
  persistence = new Jsonl(retry, { root: storeRoot })
}

/** The canned DeepSeek history response, in the shape the internal API returns. */
const messages = JSON.parse(readFileSync(join(here, 'fixtures', 'history.json'), 'utf8'))
const rawBody = JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { chat_session_id: 'fixture', chat_messages: messages } } })

const routes = new Map()
const attached = []
const pluginCtx = {
  effect(factory) { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
  get(name) {
    if (name === 'webServer') return { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } }
    if (name === 'credentials') {
      return {
        resolve: async () => ({ value: 'fixture-token' }),
        describe: async () => ({ configured: true, writable: true }),
        set: async () => {}, unset: async () => {},
      }
    }
    if (name === 'subprocess') {
      return {
        spawn: () => ({
          /* the transport writes the request spec on stdin, never in argv */
          stdin: { on() {}, end() {} },
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom: () => ({ text: JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: rawBody }) }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }),
      }
    }
    if (name === 'workspaceRegistry') {
      return {
        list: () => [{ id: 'ws-1', title: 'fixture workspace', path: workspace }],
        get: (id) => (id === 'ws-1' ? { id, title: 'fixture workspace', path: workspace, attachSession: async (sid) => { attached.push(sid) } } : undefined),
      }
    }
    if (name === 'sessionPersistence') return persistence
    if (name === 'sandboxPolicy') return { workspaceRoot: workspace }
    return undefined
  },
}

const plugin = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href)
plugin.apply(pluginCtx)

/** Call one registered route with a JSON body (no HTTP server involved). */
function post(path, body) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route not registered: ${path}`)
  return new Promise((resolve) => {
    let dataCb = null
    const req = {
      method: 'POST',
      on(ev, cb) {
        if (ev === 'data') dataCb = cb
        if (ev === 'end') setImmediate(() => { dataCb(Buffer.from(JSON.stringify(body))); cb() })
        return this
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { resolve({ status: this.statusCode, json: JSON.parse(text) }) },
    }
    handler(req, res)
  })
}

function fail(detail) {
  console.log(`FAIL ${detail}`)
  process.exit(1)
}

const imported = await post('/__deepseek-web-import/importToSession', { sessionId: 'fixture', title: 'Fixture conversation', workspaceId: 'ws-1' })
if (!imported.json.ok) fail(`import failed: ${JSON.stringify(imported.json)}`)
const { sessionId, sessionFormatVersion, eventCount } = imported.json

// read back the way the ambient build allows: legacy builds expose a detached
// `readFrom`, handle-era builds an owned read handle
let header
let events
if (typeof persistence.readFrom === 'function') {
  const raw = await persistence.readFrom(sessionId, 0)
  header = raw.meta
  events = raw.events
} else {
  const handle = await persistence.open(sessionId, 'read')
  const read = await handle.read()
  header = handle.header
  events = read.events
  await handle.close()
}
const session = Session.create(sessionId, events, header, 0)
const derived = session.deriveMessages()

const ok = header.version === sessionFormatVersion
  && events.length === eventCount
  && derived.length === messages.length
  && attached.includes(sessionId)
  && derived.some((m) => m.content.some((b) => b.type === 'reasoning'))

console.log(`${ok ? 'PASS' : 'FAIL'} live import → format v${sessionFormatVersion}, ${eventCount} events, ${derived.length} messages, attached=${attached.length}`)
process.exitCode = ok ? 0 : 1
