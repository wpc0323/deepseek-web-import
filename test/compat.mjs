/**
 * Compatibility harness: write one imported conversation through the *ambient*
 * build's real session-persistence backend, then read it back through that
 * build's own reader.
 *
 * Run it from a directory where the DSH packages resolve — the DSH install
 * itself, or a scratch project holding one older release:
 *
 *   cd /usr/local/lib/node_modules/@deepseek-ai/dsh && node <repo>/test/compat.mjs --expect 4
 *   cd /tmp/compat/v0 && node <repo>/test/compat.mjs --expect 0
 *
 * Options:
 *   --expect <n>    assert the format version the adapter picked
 *   --title <text>  conversation title to import
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSessionEvents } from '../lib/events.js'
import { writeStoredSession } from '../lib/persistence.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

/** Resolve one DSH package from the ambient project (cwd), then import it. */
async function ambient(name) {
  const require = createRequire(join(process.cwd(), 'package.json'))
  return await import(pathToFileURL(require.resolve(name)).href)
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1]
}

const expected = arg('expect', undefined)
const title = arg('title', 'Compat fixture conversation')
const root = join(repoRoot, '.compat-store')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const { Context } = await ambient('@deepseek-ai/cordis')
const Jsonl = (await ambient('@deepseek-ai/dsh-session-persistence-jsonl')).default
const sessionPackage = await ambient('@deepseek-ai/dsh-session')

const ctx = new Context()
/**
 * Older releases (format v0/v1) bind the persistence coordinator to the live
 * session store at construction; a stub with no live sessions is enough for a
 * write/read round trip. Newer backends do not need it, so it is only added
 * when constructing without it fails — on a fresh context, because the failed
 * attempt already claimed the `sessionPersistence` service name.
 */
function newPersistence(context) {
  return new Jsonl(context, { root })
}
let persistence
try {
  persistence = newPersistence(ctx)
} catch {
  const retry = new Context()
  retry.provide('sessions', {
    list: () => [],
    get: () => undefined,
    prepare: async () => { throw new Error('compat harness has no live session store') },
  })
  persistence = newPersistence(retry)
}
const messages = JSON.parse(readFileSync(join(here, 'fixtures', 'history.json'), 'utf8'))
const id = 'session-compat-fixture'

function report(ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${detail}`)
  process.exitCode = ok ? 0 : 1
}

const base = { id, createdAt: Date.now(), cwd: join(repoRoot, 'workspace') }
mkdirSync(base.cwd, { recursive: true })

let written
try {
  written = await writeStoredSession(persistence, base, (profile) => buildSessionEvents(messages, title, profile))
} catch (error) {
  report(false, `write failed: ${error && error.message}`)
  process.exit(1)
}

// --- read back through the ambient build's own reader ---
let header
let events
try {
  if (typeof persistence.readFrom === 'function') {
    // legacy era (v0/v1): detached raw read, no live-store coordination
    const raw = await persistence.readFrom(id, 0)
    header = raw.meta
    events = raw.events
  } else {
    const handle = await persistence.open(id, 'read')
    const read = await handle.read()
    header = handle.header
    events = read.events
    await handle.close()
  }
} catch (error) {
  report(false, `read-back failed: ${error && error.message}`)
  process.exit(1)
}

// --- derive the conversation the way the harness does ---
let derived = []
try {
  const Session = sessionPackage.Session
  const session = Session.create
    ? Session.create(id, events, header, 0)
    : Session.fromRestore(id, events, header, 0, 'detached')
  derived = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
} catch (error) {
  report(false, `session reconstruction failed: ${error && error.message}`)
  process.exit(1)
}

const text = (message, type) => message.content.filter((b) => b.type === type).map((b) => b.text).join(' ')
let detail = [
  `format v${written.version}`,
  `stored v${header.version}`,
  `${events.length} events`,
  `${derived.length} messages`,
  `first=${JSON.stringify(text(derived[0] || { content: [] }, 'text').slice(0, 40))}`,
  `reasoning=${derived.some((m) => text(m, 'reasoning').length > 0)}`,
].join(' | ')

// one derived message per imported message: every DeepSeek message becomes
// exactly one DSH message (an unfinished answer keeps a placeholder text block)
let ok = header.version === written.version
  && events.length === written.eventCount
  && derived.length === messages.length
  && derived.some((m) => text(m, 'reasoning').length > 0)
  && derived[derived.length - 1].content.some((b) => b.type === 'text' && b.text.length > 0)
if (expected !== undefined && Number(expected) !== written.version) ok = false
if (expected !== undefined) detail += ` | expected v${expected}`
report(ok, detail)
