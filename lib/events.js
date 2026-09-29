/**
 * DeepSeek web history → DSH session events.
 *
 * Pure translation, no services: chat.deepseek.com keeps a message's text in
 * `fragments` (`REQUEST` = the human prompt, `RESPONSE` = the answer, `THINK` =
 * the reasoning, `TOOL_SEARCH`/`TOOL_OPEN` = web-search steps), and DSH keeps a
 * session as an append-only event log. This module turns the first into the
 * second for the format generation the running build writes.
 *
 * @module deepseek-web-import/events
 */
import { assistantMessageData, SURFACE_APPEND } from './formats.js'

/** Fragment types carrying text, grouped by the role that owns them. */
const USER_TEXT_FRAGMENTS = new Set(['REQUEST'])
const ASSISTANT_ANSWER_FRAGMENTS = new Set(['RESPONSE'])
const ASSISTANT_THINKING_FRAGMENTS = new Set(['THINK'])

/** Appended when a generation produced no text at all, so no turn looks empty. */
export const EMPTY_ANSWER_NOTE = '（这条回复在 DeepSeek 网页端没有正文）'

/** Appended when a human turn carried no text (e.g. an attachment-only message). */
export const EMPTY_PROMPT_NOTE = '（这条消息在 DeepSeek 网页端只有附件，没有文字）'

/** The two roles a DeepSeek conversation carries and DSH can represent. */
export const IMPORTABLE_ROLES = Object.freeze(['user', 'assistant'])

/**
 * UTF-8 byte budget for the stored title, matching the session-title service's
 * default and this deployment's configured `maxTitleBytes`.
 */
export const MAX_TITLE_BYTES = 80

/* Title cleaning parity with `dsh-session-title`'s `normalizeSessionTitle`:
   terminal escapes, invisible controls and line breaks must not survive into a
   one-line title, and the result must fit a byte budget. */
const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/gu
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
const ESC_SEQUENCE = /\u001B[@-_]/gu
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/**
 * Normalize one untrusted conversation title into a terminal-safe one-liner.
 * @param {unknown} input - the DeepSeek conversation title.
 * @param {number} [maxBytes] - UTF-8 byte budget.
 * @returns {string} the normalized title, possibly empty.
 */
export function normalizeTitle(input, maxBytes = MAX_TITLE_BYTES) {
  const text = String(input === undefined || input === null ? '' : input)
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let used = 0
  let output = ''
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output.trimEnd()
}

/**
 * Concatenate the `content` of one message's fragments of the wanted types.
 * @param {object} message - one DeepSeek history message.
 * @param {Set<string>} wanted - fragment type names to keep, upper case.
 * @returns {string} the joined text, empty when nothing matches.
 */
export function fragmentText(message, wanted) {
  const fragments = message && Array.isArray(message.fragments) ? message.fragments : null
  if (fragments === null) return ''
  return fragments
    .filter((f) => f && f.content !== undefined && f.content !== null && wanted.has(String(f.type || '').toUpperCase()))
    .map((f) => (typeof f.content === 'string' ? f.content : legacyText(f.content)).trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * Flatten a legacy `content` field, accepted as a fallback for responses that
 * carry text outside `fragments`.
 * @param {unknown} content - raw `content` value of one message.
 * @returns {string} the flattened text.
 */
export function legacyText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block.text === 'string') return block.text
      if (block && typeof block.content === 'string') return block.content
      return ''
    }).join('\n')
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (typeof content.content === 'string') return content.content
  }
  return String(content)
}

/** Earliest stamp accepted: 2001-09-09, well before any DeepSeek conversation. */
const MIN_STAMP_MS = 1000000000000

/** Latest stamp accepted: one day ahead, to tolerate clock skew. */
const MAX_STAMP_AHEAD_MS = 86400000

/**
 * One message's wall-clock time in epoch milliseconds, when the API reported a
 * usable one. `inserted_at` is seconds since the epoch; a value that cannot be
 * one (negative, NaN, already in milliseconds, absurdly far out) is treated as
 * absent so it cannot put a 2023 conversation in the year 55000.
 * @param {object} message - one DeepSeek history message.
 * @param {number|undefined} fallback - value to use when the stamp is unusable.
 * @returns {number|undefined} epoch milliseconds.
 */
export function messageTime(message, fallback) {
  const seconds = message ? Number(message.inserted_at) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback
  const millis = Math.round(seconds * 1000)
  if (!Number.isSafeInteger(millis)) return fallback
  if (millis < MIN_STAMP_MS || millis > Date.now() + MAX_STAMP_AHEAD_MS) return fallback
  return millis
}

/**
 * Read one DeepSeek history message into DSH content blocks.
 * @param {object} message - one DeepSeek history message.
 * @param {string} role - lower-cased role.
 * @returns {object[]} DSH content blocks (`text`, and `reasoning` for answers).
 */
export function messageBlocks(message, role) {
  if (role === 'user') {
    const text = fragmentText(message, USER_TEXT_FRAGMENTS) || legacyText(message.content)
    /* An attachment-only prompt has no text; an empty user turn would reach the
       model as an empty message, so it keeps an explicit note instead. */
    return [{ type: 'text', text: text.trim().length > 0 ? text : EMPTY_PROMPT_NOTE }]
  }
  const reasoning = fragmentText(message, ASSISTANT_THINKING_FRAGMENTS)
  const answer = fragmentText(message, ASSISTANT_ANSWER_FRAGMENTS) || legacyText(message.content)
  const blocks = []
  if (reasoning.length > 0) blocks.push({ type: 'reasoning', text: reasoning })
  if (answer.length > 0) blocks.push({ type: 'text', text: answer })
  if (blocks.length === 0) blocks.push({ type: 'text', text: EMPTY_ANSWER_NOTE })
  return blocks
}

/**
 * Whether one DeepSeek message is a turn DSH can represent.
 * @param {object} message - one DeepSeek history message.
 * @returns {boolean} true for the two conversation roles.
 */
export function isImportableMessage(message) {
  const role = String((message && message.role) || '').toLowerCase()
  return IMPORTABLE_ROLES.includes(role)
}

/**
 * Keep only the messages the import can represent. Anything else (a system
 * note, a tool row, a malformed entry) is dropped rather than fabricated into
 * an assistant turn.
 * @param {unknown} messages - raw history messages.
 * @returns {object[]} the importable messages, order preserved.
 */
export function importableMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter(isImportableMessage)
}

/**
 * Translate one DeepSeek conversation into a legal DSH session log:
 * `turn/start → user/message → step/start → assistant/message → step/end →
 * turn/end`, surface events carrying `surfaceOp: "append"`, with a leading
 * `session/title` and the closing `session/end-seed` marker that classifies
 * everything before it as imported (seed) history.
 *
 * Every step opens before the surface event it carries (`turn/start →
 * step/start → user/message`), which is both DSH's own order and a migration
 * requirement: a v3+ build refuses a v0/v2 log whose first surface event
 * precedes its first `step/start`.
 *
 * A history that ends with an unanswered human prompt keeps that last turn open,
 * exactly as an interrupted live turn does: DSH's own resume and cold-read paths
 * append the missing `step/end` + `turn/end {reason:{kind:'interrupted'}}` when
 * the session is next opened, so the stored log stays honest about what the
 * conversation contained.
 * @param {object[]} messages - DeepSeek history messages, oldest first.
 * @param {string} title - the DeepSeek conversation title.
 * @param {import('./formats.js').FormatProfile} profile - format being written.
 * @returns {object[]} contiguous events from seq 0.
 */
export function buildSessionEvents(messages, title, profile) {
  const events = []
  const list = Array.isArray(messages) ? messages : []
  let seq = 0
  let turn = 0
  let openStep = false
  /**
   * Emitted times follow the conversation's own `inserted_at` values and stay
   * non-decreasing. `lastTime` starts at 0, never at "now": an imported
   * conversation is normally *older* than the import, and seeding the cursor
   * with the import moment would clamp its whole timeline to it.
   *
   * The fallback for an event whose own stamp is unusable is the conversation's
   * earliest known stamp — not `Date.now()` — so a leading message without
   * `inserted_at` cannot drag the rest of the timeline to the present either.
   * Only a conversation with no usable stamp at all falls back to "now".
   */
  const stamps = list
    .map((message) => messageTime(message, undefined))
    .filter((time) => Number.isSafeInteger(time) && time >= 0)
  const base = stamps.length > 0 ? stamps.reduce((earliest, time) => (time < earliest ? time : earliest)) : Date.now()
  let lastTime = 0
  const push = (type, data, surfaceOp, time) => {
    const wanted = Number.isSafeInteger(time) && time >= 0 ? time : (lastTime || base)
    const at = Math.max(wanted, lastTime)
    lastTime = at
    const event = { type, seq, time: at, data }
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    events.push(event)
    seq += 1
  }
  /* A title event carries normalized non-empty text: a blank, multi-line or
     escape-laden DeepSeek title would otherwise surface verbatim. */
  const cleanTitle = normalizeTitle(title)
  push('session/title', { title: cleanTitle.length > 0 ? cleanTitle : 'DeepSeek 导入对话', messageSeqs: [], source: { kind: 'user' } }, undefined, messageTime(list[0], undefined))
  list.forEach((source) => {
    const message = source && typeof source === 'object' ? source : {}
    const role = String(message.role || '').toLowerCase()
    if (!IMPORTABLE_ROLES.includes(role)) return
    const blocks = messageBlocks(message, role)
    const time = messageTime(message, undefined)
    if (role === 'user') {
      if (openStep) {
        push('step/end', { turn, step: 1 }, undefined, time)
        push('turn/end', { turn, reason: { kind: 'completed' } }, undefined, time)
        openStep = false
      }
      turn += 1
      push('turn/start', { turn }, undefined, time)
      /* The step opens *before* the message it carries. DSH's own logs do the
         same, and a v0/v2-shaped log with a surface event before the first
         `step/start` cannot be migrated by a v3+ build at all — it has nowhere
         to acquire the system head the newer format expects, so an import made
         on an old build would become unreadable after an upgrade. */
      push('step/start', { turn, step: 1 }, undefined, time)
      push('user/message', { id: 'msg-' + turn + '-u', role: 'user', content: blocks, source: { kind: 'user' } }, SURFACE_APPEND, time)
      openStep = true
    } else {
      if (!openStep) {
        turn += 1
        push('turn/start', { turn }, undefined, time)
        push('step/start', { turn, step: 1 }, undefined, time)
        openStep = true
      }
      push('assistant/message', assistantMessageData(profile, {
        turn,
        step: 1,
        message: {
          id: 'msg-' + turn + '-a',
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider: 'deepseek', model: String((message && message.model) || '') || 'deepseek-chat' },
        },
      }), SURFACE_APPEND, time)
      push('step/end', { turn, step: 1 }, undefined, time)
      push('turn/end', { turn, reason: { kind: 'completed' } }, undefined, time)
      openStep = false
    }
  })
  push('session/end-seed', {})
  return events
}
