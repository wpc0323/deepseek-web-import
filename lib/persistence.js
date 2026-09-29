/**
 * Session-persistence write adapter across DSH releases.
 *
 * The durable-session contract changed shape twice, and the plugin has to
 * speak whichever one the running build offers:
 *
 * - **handle era** (format v2+): `create(header)` returns a write handle whose
 *   `append(events)` / `flush()` / `close()` carry the batch, and the backend
 *   validates the header version against its own format catalog.
 * - **legacy era** (format v0/v1): `create(meta)` records metadata and
 *   `append(id, events)` writes the batch; there is no handle, no flush and no
 *   version error to learn from.
 *
 * Both eras are addressed through one small writer object, so the import path
 * never branches on the release it happens to run on.
 *
 * @module deepseek-web-import/persistence
 */
import { DEFAULT_FORMAT_VERSION, formatProfile, headerDialect, sessionHeader } from './formats.js'

/** How many format-version attempts one import may spend before giving up. */
const MAX_FORMAT_ATTEMPTS = 4

/** The header version a refusal names, or null when the failure is something else. */
export function requiredFormatVersion(error) {
  const match = /requires Session format v(\d+)/.exec(String((error && error.message) || error || ''))
  if (match === null) return null
  const version = Number(match[1])
  return Number.isSafeInteger(version) && version >= 0 ? version : null
}

/**
 * Whether one persistence service speaks the legacy (v0/v1) contract.
 * Used only to pick the first guess; the shape `create` returns decides.
 * @param {object} persistence - the `sessionPersistence` service.
 * @returns {boolean} true when the service has no handle-based surface.
 */
export function isLegacyPersistence(persistence) {
  return typeof persistence.open !== 'function' && typeof persistence.append === 'function'
}

/**
 * What this profile's own stored sessions say about the build: the format
 * version it wrote and the header dialect it used. `list()` answers with plain
 * headers in the legacy era and with `{header}` snapshots in the handle era,
 * so both shapes are read. Nothing stored is not an error: the guess then comes
 * from the service surface, and the handle era still corrects the version from
 * the backend's own refusal.
 * @param {object} persistence - the `sessionPersistence` service.
 * @returns {Promise<{version: number, dialect: 'seeded'|'seedLength'|null}>} the evidence.
 */
export async function resolveStorageEvidence(persistence) {
  const legacy = isLegacyPersistence(persistence)
  try {
    const listed = await persistence.list()
    for (const item of Array.isArray(listed) ? listed : []) {
      const header = item && item.header !== undefined ? item.header : item
      const version = header ? header.version : undefined
      if (!Number.isSafeInteger(version) || version < 0) continue
      /* The legacy era is the one that cannot self-correct: its `create` never
         validates the version and its own reader refuses anything but v0/v1, so
         a foreign version listed there is noise rather than evidence. */
      if (legacy && version > 1) continue
      return { version, dialect: headerDialect(header) }
    }
  } catch { /* listing is a hint, never a hard dependency */ }
  return { version: legacy ? 0 : DEFAULT_FORMAT_VERSION, dialect: null }
}

/**
 * The Session format version this build writes.
 * @param {object} persistence - the `sessionPersistence` service.
 * @returns {Promise<number>} the version to stamp.
 */
export async function resolveFormatVersion(persistence) {
  return (await resolveStorageEvidence(persistence)).version
}

/**
 * One open writer: versions resolved, storage claimed, events ready to stream.
 * @typedef {object} SessionWriter
 * @property {number} version - the format version being written.
 * @property {import('./formats.js').FormatProfile} profile - its shape profile.
 * @property {(events: object[]) => Promise<void>} append - write one contiguous batch.
 * @property {() => Promise<void>} finish - durability barrier for this session.
 * @property {() => Promise<void>} close - release the writer (idempotent).
 */

/**
 * Create one stored session and return the writer that fills it, adapting to
 * both the persistence contract and the format version of the running build.
 * A handle-era backend that refuses the guessed version names the one it needs;
 * that version is retried instead of failing the import.
 * @param {object} persistence - the `sessionPersistence` service.
 * @param {{id: string, createdAt: number, cwd: string}} base - identity facts.
 * @returns {Promise<SessionWriter>} the open writer.
 */
export async function openSessionWriter(persistence, base) {
  const evidence = await resolveStorageEvidence(persistence)
  let version = evidence.version
  const tried = new Set()
  let lastError = null
  /* Bounded: a service that names a fresh version on every refusal must not be
     able to make the import loop forever. */
  while (!tried.has(version) && tried.size < MAX_FORMAT_ATTEMPTS) {
    tried.add(version)
    const profile = formatProfile(version, evidence.dialect)
    let created
    try {
      created = await persistence.create(sessionHeader(profile, base))
    } catch (error) {
      const required = requiredFormatVersion(error)
      if (required === null) throw error
      lastError = error
      version = required
      continue
    }
    const handle = created !== null && typeof created === 'object' && typeof created.append === 'function' ? created : null
    if (handle !== null) {
      return {
        version,
        profile,
        append: (events) => handle.append(events),
        finish: async () => { if (typeof handle.flush === 'function') await handle.flush() },
        close: async () => { if (typeof handle.close === 'function') await handle.close() },
      }
    }
    if (typeof persistence.append === 'function') {
      return {
        version,
        profile,
        append: (events) => persistence.append(base.id, events),
        finish: async () => {},
        close: async () => {},
      }
    }
    throw new Error('sessionPersistence 既没有返回可写句柄，也没有 append 方法')
  }
  throw lastError || new Error('无法确定本版本 DSH 写入的 Session 格式版本')
}

/**
 * Write one whole imported log, closing the writer whatever happens.
 * @param {object} persistence - the `sessionPersistence` service.
 * @param {{id: string, createdAt: number, cwd: string}} base - identity facts.
 * @param {(profile: import('./formats.js').FormatProfile) => object[]} buildEvents - log builder.
 * @returns {Promise<{version: number, eventCount: number}>} what was written.
 */
/**
 * Read one stored session back through whatever reader this build exposes.
 *
 * A backend's write path stores events without validating their vocabulary, so
 * a log written with an event type this build does not know is accepted and only
 * refused later, when the user opens the session. Checking right after the write
 * turns that silent "imported, but unopenable" into a reported failure.
 * @param {object} persistence - the `sessionPersistence` service.
 * @param {string} id - the session to read back.
 * @returns {Promise<{ok: true, eventCount: number|null} | {ok: false, message: string}>} the check.
 */
export async function verifyStoredSession(persistence, id) {
  const read = async () => {
    if (typeof persistence.readFrom === 'function') {
      const raw = await persistence.readFrom(id, 0)
      return raw.events.length
    }
    if (typeof persistence.open === 'function') {
      const handle = await persistence.open(id, 'read')
      try {
        const events = await handle.read()
        return events.events.length
      } finally {
        try { await handle.close() } catch { /* the read already happened */ }
      }
    }
    return null /* no reader exposed: nothing to verify against */
  }
  let lastError = null
  /* one retry: a read that races the write's own housekeeping is not evidence */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { ok: true, eventCount: await read() }
    } catch (error) {
      lastError = error
    }
  }
  return { ok: false, message: String((lastError && lastError.message) || lastError) }
}

export async function writeStoredSession(persistence, base, buildEvents) {
  const writer = await openSessionWriter(persistence, base)
  let failure = null
  try {
    const events = buildEvents(writer.profile)
    await writer.append(events)
    await writer.finish()
    return { version: writer.version, eventCount: events.length }
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      await writer.close()
    } catch (closeError) {
      /* Releasing the writer is part of the delivery — a handle that cannot
         release its ownership leaves a stale lock behind, so a successful write
         must not report success. A write that already failed keeps its own
         error, which is the one the caller can act on. */
      if (failure === null) throw closeError
    }
  }
}

/**
 * Write one imported log and prove this build can read it back.
 * @param {object} persistence - the `sessionPersistence` service.
 * @param {{id: string, createdAt: number, cwd: string}} base - identity facts.
 * @param {(profile: import('./formats.js').FormatProfile) => object[]} buildEvents - log builder.
 * @returns {Promise<{version: number, eventCount: number}>} what was written.
 * @throws {Error} with `code: 'verify'` when the log cannot be read back.
 */
export async function writeVerifiedSession(persistence, base, buildEvents) {
  const written = await writeStoredSession(persistence, base, buildEvents)
  const check = await verifyStoredSession(persistence, base.id)
  if (!check.ok) {
    const error = new Error('会话已写入，但本版本读不回来：' + check.message)
    error.code = 'verify'
    throw error
  }
  return written
}
