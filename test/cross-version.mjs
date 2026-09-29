/**
 * Cross-generation read test.
 *
 * A session imported on an older DSH build must still open after the user
 * upgrades: the older build writes its own format, and the newer build migrates
 * it on read. That migration has requirements the same-version round trip in
 * `compat.mjs` cannot see — most notably that no surface event may precede the
 * first `step/start` of its turn, because a v2→v3 migration inserts the system
 * head exactly there and refuses the log otherwise.
 *
 * Run it from two different installations:
 *
 *   # with an older DSH on the path (the writer)
 *   cd /tmp/compat/v0 && node <repo>/test/cross-version.mjs write <root> <sessionId>
 *   # with the current DSH (the reader)
 *   cd /usr/local/lib/node_modules/@deepseek-ai/dsh && node <repo>/test/cross-version.mjs read <root>
 *
 * `test/matrix.sh` does exactly that for every era it can install.
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

/** Build the persistence service of the ambient build over one store root. */
async function store(root) {
  const { Context } = await ambient('@deepseek-ai/cordis')
  const Jsonl = (await ambient('@deepseek-ai/dsh-session-persistence-jsonl')).default
  const ctx = new Context()
  try {
    return new Jsonl(ctx, { root })
  } catch {
    /* v0-era backends bind to the live session store at construction */
    const retry = new Context()
    retry.provide('sessions', { list: () => [], get: () => undefined })
    return new Jsonl(retry, { root })
  }
}

const [mode, root, id] = process.argv.slice(2)
if (mode === undefined || root === undefined) {
  console.error('usage: cross-version.mjs write <root> <sessionId> | cross-version.mjs read <root>')
  process.exit(2)
}

const messages = JSON.parse(readFileSync(join(here, 'fixtures', 'history.json'), 'utf8'))

if (mode === 'write') {
  if (id === undefined) {
    console.error('write needs a session id')
    process.exit(2)
  }
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const persistence = await store(root)
  const written = await writeStoredSession(
    persistence,
    { id, createdAt: Date.now(), cwd: repoRoot },
    (profile) => buildSessionEvents(messages, 'cross-version fixture', profile),
  )
  console.log(`WROTE ${id} format v${written.version} ${written.eventCount} events`)
  process.exit(0)
}

if (mode === 'read') {
  const persistence = await store(root)
  const { Session } = await ambient('@deepseek-ai/dsh-session')
  const listed = await persistence.list()
  if (listed.length === 0) {
    console.log(`FAIL no session found under ${root}`)
    process.exit(1)
  }
  let failures = 0
  for (const entry of listed) {
    const header = entry.header ?? entry
    try {
      const handle = await persistence.open(header.id, 'read')
      const read = await handle.read()
      const session = Session.create(header.id, read.events, handle.header, 0)
      const derived = session.deriveMessages()
      await handle.close()
      const ok = derived.length === messages.length
      if (!ok) failures += 1
      console.log(`${ok ? 'PASS' : 'FAIL'} read ${header.id}: stored v${header.version} → ${read.events.length} events, ${derived.length}/${messages.length} messages`)
    } catch (error) {
      failures += 1
      console.log(`FAIL read ${header.id}: ${error && error.message}`)
    }
  }
  process.exit(failures === 0 ? 0 : 1)
}

console.error(`unknown mode: ${mode}`)
process.exit(2)
