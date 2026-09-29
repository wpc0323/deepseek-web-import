/**
 * Session-format knowledge across DSH releases.
 *
 * A DSH build writes exactly one Session format version, and this plugin has to
 * write what that build accepts: both the header fields and the event fields a
 * build understands differ per generation. Everything version-dependent lives
 * in this file, so supporting a future v5 is one table entry plus the shape
 * deltas it introduces.
 *
 * Evidence for every row (checked against the published packages of the
 * releases named beside it, see `docs/COMPATIBILITY.md`):
 *
 * | format | released by                      | header                                        | `assistant/message` | persistence API |
 * |--------|----------------------------------|-----------------------------------------------|---------------------|-----------------|
 * | v0     | 0.1.1-rc.1 … 0.1.2-rc.1          | `version,id,createdAt,cwd,seedLength?`        | no `stream`         | legacy          |
 * | v1     | no published build found         | modeled on v0                                 | no `stream`         | legacy          |
 * | v2     | 0.1.3-alpha.2                    | `…,isSeeded` (`seedLength` rejected)          | `stream` required   | handle          |
 * | v3     | 0.1.5-alpha.1 … 0.1.6-alpha.2     | as v2                                         | `stream` required   | handle          |
 * | v4     | 0.1.7-alpha.1+                    | `…,delegationDepth` required                  | `stream` required   | handle          |
 *
 * @module deepseek-web-import/formats
 */

/** Format versions this plugin knows how to write, oldest first. */
export const KNOWN_FORMAT_VERSIONS = Object.freeze([0, 1, 2, 3, 4])

/**
 * One format profile: everything the writer must know about a generation.
 * @typedef {object} FormatProfile
 * @property {number} version - the format version to stamp.
 * @property {boolean} isSeededFlag - whether the header carries `isSeeded`
 *   (v2+); v0/v1 mark fork lineage with `seedLength` instead, which an
 *   unseeded import never writes.
 * @property {boolean} delegationDepth - whether the header carries
 *   `delegationDepth` explicitly (required by v4, accepted by v2/v3).
 * @property {boolean} assistantStream - whether `assistant/message` carries the
 *   `stream` field (v2+). The field is omitted for v0/v1 and that omission is
 *   load-bearing: the v0→v1 migration refuses a v0 log whose assistant message
 *   carries `stream` ("data has unexpected member"), which would make the
 *   artifact permanently un-migratable rather than merely unreadable by v0.
 */

/**
 * Build one profile from its feature flags.
 * @param {number} version - Session format version.
 * @param {boolean} modern - whether the generation has the v2+ shape.
 * @returns {FormatProfile} the frozen profile.
 */
function profile(version, modern) {
  return Object.freeze({
    version,
    isSeededFlag: modern,
    delegationDepth: version >= 4,
    assistantStream: modern,
  })
}

/** Profiles by format version; anything newer than v2 keeps the v2+ shape. */
const PROFILES = Object.freeze({
  0: profile(0, false),
  1: profile(1, false),
  2: profile(2, true),
  3: profile(3, true),
  4: profile(4, true),
})

/**
 * Which header dialect a stored header is written in, read from the fields the
 * build itself produced: v2+ headers carry `isSeeded`, v0/v1 headers carry the
 * fork cut as `seedLength`. This is evidence, and it is used exactly where the
 * table above is a guess (a v1 build was never published, so its row is
 * modeled on v0).
 * @param {unknown} header - one stored header, or a `{header}` snapshot.
 * @returns {'seeded'|'seedLength'|null} the observed dialect, or null.
 */
export function headerDialect(header) {
  const value = header !== null && typeof header === 'object' && header.header !== undefined ? header.header : header
  if (value === null || typeof value !== 'object') return null
  if (typeof value.isSeeded === 'boolean') return 'seeded'
  if (Number.isSafeInteger(value.seedLength)) return 'seedLength'
  return null
}

/**
 * The profile for one format version. An unknown (future) version keeps the
 * newest known shape and is corrected at runtime when the backend refuses it,
 * so a v5 build needs at most a new row above, never a rewrite.
 * @param {number} version - Session format version to write.
 * @param {'seeded'|'seedLength'|null} [dialect] - dialect observed in this
 *   profile's own stored sessions. It only overrides a *modeled* row: the row
 *   for a version whose shape was never verified (v1 today, any future version)
 *   and any version this build does not know. Rows backed by a released build
 *   win over contradicting evidence, because that build is the authority on
 *   what it writes.
 * @returns {FormatProfile} the profile to write with.
 */
export function formatProfile(version, dialect = null) {
  const known = PROFILES[version]
  const base = known ?? profile(version, version >= 2)
  /* v1 was never published: its row (and any unknown version's row) is a model */
  const modeled = known === undefined || version === 1
  if (!modeled || dialect === null) return base
  /* Both flags move together: every published generation couples them (v0/v1
     carry `seedLength` and no `stream`, v2+ carry `isSeeded` and require it), so
     flipping one alone would describe a build that cannot exist. */
  if (dialect === 'seeded') return Object.freeze({ ...base, isSeededFlag: true, assistantStream: true })
  return Object.freeze({ ...base, isSeededFlag: false, assistantStream: false })
}

/**
 * The newest format version this plugin expects a current build to write.
 * Only a first guess: the backend's own refusal names the version it needs,
 * and existing stored sessions answer first.
 */
export const DEFAULT_FORMAT_VERSION = KNOWN_FORMAT_VERSIONS[KNOWN_FORMAT_VERSIONS.length - 1]

/**
 * The Session header for one import, shaped for the target format.
 * Only fields every generation accepts are written: an unseeded import has no
 * fork lineage, so neither `seedLength` (v0/v1) nor `isSeeded: true` (v2+) is
 * ever needed.
 * @param {FormatProfile} profile - profile of the format being written.
 * @param {{id: string, createdAt: number, cwd: string}} base - identity facts.
 * @returns {object} the header to hand to `sessionPersistence.create`.
 */
export function sessionHeader(profile, base) {
  return {
    version: profile.version,
    id: base.id,
    createdAt: base.createdAt,
    cwd: base.cwd,
    ...profile.isSeededFlag ? { isSeeded: false } : {},
    ...profile.delegationDepth ? { delegationDepth: 0 } : {},
  }
}

/** Message event types whose `surfaceOp: "append"` marker every generation accepts. */
export const SURFACE_APPEND = 'append'

/**
 * Shape one assistant message event's data for the target format.
 * @param {FormatProfile} profile - profile of the format being written.
 * @param {object} data - `{turn, step, message}` built by the event writer.
 * @returns {object} event data valid for that generation.
 */
export function assistantMessageData(profile, data) {
  return profile.assistantStream ? { ...data, stream: [] } : { ...data }
}
