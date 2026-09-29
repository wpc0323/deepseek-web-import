/**
 * Unit tests for the pure translation layers — no DSH install required.
 *
 *   node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EMPTY_PROMPT_NOTE,
  MAX_TITLE_BYTES,
  buildSessionEvents,
  fragmentText,
  importableMessages,
  isImportableMessage,
  messageBlocks,
  messageTime,
  normalizeTitle,
} from '../lib/events.js'
import {
  DEFAULT_FORMAT_VERSION,
  KNOWN_FORMAT_VERSIONS,
  assistantMessageData,
  formatProfile,
  headerDialect,
  sessionHeader,
} from '../lib/formats.js'
import {
  isLegacyPersistence,
  requiredFormatVersion,
  resolveFormatVersion,
  resolveStorageEvidence,
} from '../lib/persistence.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'history.json'), 'utf8'))

test('fragment extraction reads the DeepSeek fragment vocabulary', () => {
  const assistant = fixture[1]
  assert.equal(fragmentText(assistant, new Set(['RESPONSE'])), 'Open the sidebar menu and choose Export.')
  assert.equal(fragmentText(assistant, new Set(['THINK'])), 'The user wants to export a conversation.')
  assert.equal(fragmentText(assistant, new Set(['TOOL_OPEN'])), '')
  assert.equal(fragmentText({ fragments: null }, new Set(['RESPONSE'])), '')
})

test('message blocks keep reasoning and answer apart', () => {
  const user = messageBlocks(fixture[0], 'user')
  assert.deepEqual(user, [{ type: 'text', text: 'How do I export my chat history?' }])
  const assistant = messageBlocks(fixture[1], 'assistant')
  assert.deepEqual(assistant.map((b) => b.type), ['reasoning', 'text'])
  const unfinished = messageBlocks(fixture[5], 'assistant')
  assert.equal(unfinished.length, 1)
  assert.ok(unfinished[0].text.length > 0, 'an unfinished answer still carries a note')
})

test('legacy flat content is still readable', () => {
  assert.equal(
    messageBlocks({ content: [{ type: 'text', text: 'legacy' }] }, 'user')[0].text,
    'legacy',
  )
})

test('timestamps come from inserted_at and are non-decreasing', () => {
  assert.equal(messageTime({ inserted_at: 1700000000 }, 0), 1700000000000)
  assert.equal(messageTime({}, 42), 42)
  const events = buildSessionEvents(fixture, 'title', formatProfile(4))
  const times = events.map((event) => event.time)
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
})

test('the imported log keeps the conversation\'s own timeline', () => {
  // regression: seeding the cursor with Date.now() clamped every message of an
  // older conversation to the import moment
  const events = buildSessionEvents(fixture, 'title', formatProfile(4))
  const expected = fixture.map((message) => Math.round(message.inserted_at * 1000))
  const emitted = events
    .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    .map((event) => event.time)
  assert.deepEqual(emitted, expected)
  assert.equal(events[0].time, expected[0], 'the log starts when the conversation started')
  assert.ok(events.every((event) => event.time < Date.now()), 'no event is stamped "now"')
})

test('an untimed first message cannot drag the timeline to the import moment', () => {
  // regression: the fallback used Date.now() as the floor, so a leading message
  // without inserted_at clamped every later real timestamp up to "now"
  const messages = [
    { role: 'USER', inserted_at: null, fragments: [{ type: 'REQUEST', content: 'no stamp' }] },
    { role: 'ASSISTANT', inserted_at: 1700000005.5, fragments: [{ type: 'RESPONSE', content: 'from 2023' }] },
  ]
  const events = buildSessionEvents(messages, 'title', formatProfile(4))
  assert.ok(events.every((event) => event.time < Date.now() - 86400000), 'no event is stamped at import time')
  const assistant = events.find((event) => event.type === 'assistant/message')
  assert.equal(assistant.time, 1700000005500, 'the real answer time survives')
  assert.equal(events[0].time, assistant.time, 'the log starts at the earliest known stamp')
})

test('a conversation with no usable timestamp at all still writes valid times', () => {
  const messages = [
    { role: 'USER', inserted_at: 'garbage', fragments: [{ type: 'REQUEST', content: 'a' }] },
    { role: 'ASSISTANT', inserted_at: 0, fragments: [{ type: 'RESPONSE', content: 'b' }] },
  ]
  const events = buildSessionEvents(messages, 'title', formatProfile(4))
  const times = events.map((event) => event.time)
  assert.ok(times.every((time) => Number.isSafeInteger(time) && time >= 0))
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
})

test('missing or inverted timestamps stay valid and ordered', () => {
  const messy = [
    { role: 'USER', inserted_at: 1700000000, fragments: [{ type: 'REQUEST', content: 'one' }] },
    { role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: 'no timestamp' }] },
    { role: 'USER', inserted_at: 1600000000, fragments: [{ type: 'REQUEST', content: 'older than the previous one' }] },
    { role: 'ASSISTANT', inserted_at: 'garbage', fragments: [{ type: 'RESPONSE', content: 'still fine' }] },
  ]
  const events = buildSessionEvents(messy, 'title', formatProfile(4))
  const times = events.map((event) => event.time)
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
  assert.ok(times.every((time) => Number.isSafeInteger(time) && time >= 0))
  // the message without a timestamp inherits the previous one instead of jumping to now
  const assistant = events.find((event) => event.type === 'assistant/message')
  assert.equal(assistant.time, 1700000000000)
})

test('the event log is a dense, balanced turn/step bracket', () => {
  const events = buildSessionEvents(fixture, 'title', formatProfile(4))
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index))
  assert.equal(events[0].type, 'session/title')
  assert.equal(events[events.length - 1].type, 'session/end-seed')
  assert.deepEqual(events[events.length - 1].data, {})
  // a surface event may never precede the first step/start of its turn: a v3+
  // build cannot migrate such a v0/v2 log (no place for the system head)
  const surfaceTypes = new Set(['user/message', 'assistant/message', 'tool/result'])
  let seenStep = false
  for (const event of events) {
    if (event.type === 'step/start') seenStep = true
    if (surfaceTypes.has(event.type)) assert.ok(seenStep, `surface event at seq ${event.seq} has no open step`)
  }
  const opens = events.filter((event) => event.type === 'turn/start').length
  const closes = events.filter((event) => event.type === 'turn/end').length
  assert.equal(opens, closes)
  assert.equal(opens, 3, 'three human turns in the fixture')
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      assert.equal(event.surfaceOp, 'append')
    }
  }
})

test('format profiles shape headers and messages per generation', () => {
  const base = { id: 'session-x', createdAt: 1, cwd: '/tmp/ws' }
  assert.deepEqual(sessionHeader(formatProfile(0), base), { version: 0, id: 'session-x', createdAt: 1, cwd: '/tmp/ws' })
  assert.deepEqual(sessionHeader(formatProfile(1), base), { version: 1, id: 'session-x', createdAt: 1, cwd: '/tmp/ws' })
  assert.equal(sessionHeader(formatProfile(3), base).isSeeded, false)
  assert.equal(sessionHeader(formatProfile(3), base).delegationDepth, undefined)
  assert.equal(sessionHeader(formatProfile(4), base).delegationDepth, 0)
  // v0/v1 have no `stream` field on assistant messages; v2+ require it
  assert.equal('stream' in assistantMessageData(formatProfile(0), { turn: 1 }), false)
  assert.equal('stream' in assistantMessageData(formatProfile(1), { turn: 1 }), false)
  assert.deepEqual(assistantMessageData(formatProfile(4), { turn: 1 }).stream, [])
  // an unknown future version keeps the newest shape and its own number
  assert.equal(formatProfile(9).version, 9)
  assert.equal(formatProfile(9).assistantStream, true)
  assert.equal(formatProfile(9).delegationDepth, true)
})

test('every known format version is writable', () => {
  for (const version of KNOWN_FORMAT_VERSIONS) {
    const events = buildSessionEvents(fixture, 'title', formatProfile(version))
    assert.ok(events.length > 0, `v${version} produced events`)
  }
  assert.equal(DEFAULT_FORMAT_VERSION, KNOWN_FORMAT_VERSIONS[KNOWN_FORMAT_VERSIONS.length - 1])
})

test('a format refusal names the version to retry with', () => {
  assert.equal(requiredFormatVersion(new Error('encodeCurrent requires Session format v4')), 4)
  assert.equal(requiredFormatVersion(new Error('something else')), null)
})

test('version resolution reads both listing shapes', async () => {
  assert.equal(await resolveFormatVersion({ list: async () => [{ header: { version: 4 } }] }), 4)
  assert.equal(await resolveFormatVersion({ list: async () => [{ version: 0, id: 'a' }] }), 0)
  assert.equal(await resolveFormatVersion({ list: async () => { throw new Error('nope') } }), DEFAULT_FORMAT_VERSION)
  // a legacy-shaped service with nothing stored defaults to the v0 era
  assert.equal(await resolveFormatVersion({ list: async () => [], append: async () => {} }), 0)
})

test('legacy persistence is recognised by its surface', () => {
  assert.equal(isLegacyPersistence({ append: async () => {}, create: async () => {} }), true)
  assert.equal(isLegacyPersistence({ open: async () => {}, create: async () => {} }), false)
})

test('unimportable messages are recognisable', () => {
  assert.equal(isImportableMessage(fixture[0]), true)
  assert.equal(isImportableMessage({ role: 'ASSISTANT', fragments: [] }), true, 'placeholder keeps the turn')
  assert.equal(isImportableMessage({ role: 'SYSTEM' }), false, 'a system row is not a turn')
  assert.equal(isImportableMessage({}), false)
})

test('only conversation roles reach the log', () => {
  const mixed = [
    { role: 'SYSTEM', inserted_at: 1700000000, fragments: [{ type: 'REQUEST', content: 'note' }] },
    { role: 'USER', inserted_at: 1700000001, fragments: [{ type: 'REQUEST', content: 'hi' }] },
    { role: 'TOOL', inserted_at: 1700000002, fragments: [] },
    { role: 'ASSISTANT', inserted_at: 1700000003, fragments: [{ type: 'RESPONSE', content: 'hello' }] },
  ]
  assert.equal(importableMessages(mixed).length, 2)
  const events = buildSessionEvents(importableMessages(mixed), 'title', formatProfile(4))
  const messages = events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
  const roleOf = (event) => event.data.role ?? event.data.message.role
  assert.deepEqual(messages.map(roleOf), ['user', 'assistant'])
  assert.equal(messages[0].data.content[0].text, 'hi')
  // exactly one turn, opened by the human message
  assert.equal(events.filter((event) => event.type === 'turn/start').length, 1)
})

test('an attachment-only prompt keeps an explicit note instead of empty text', () => {
  const blocks = messageBlocks({ role: 'USER', fragments: [{ type: 'REQUEST', content: '   ' }] }, 'user')
  assert.deepEqual(blocks, [{ type: 'text', text: EMPTY_PROMPT_NOTE }])
  const events = buildSessionEvents([{ role: 'USER', inserted_at: 1700000000, fragments: [] }], 'title', formatProfile(4))
  const user = events.find((event) => event.type === 'user/message')
  assert.equal(user.data.content[0].text, EMPTY_PROMPT_NOTE)
})

test('the stored header dialect overrides the modeled row', () => {
  // v1 was never published, so its row is modeled on v0; a build that stored
  // `isSeeded` headers must still get `isSeeded`
  assert.equal(headerDialect({ version: 1, isSeeded: false }), 'seeded')
  assert.equal(headerDialect({ version: 0, seedLength: 3 }), 'seedLength')
  assert.equal(headerDialect({ header: { version: 4, isSeeded: false } }), 'seeded')
  assert.equal(headerDialect({ version: 0 }), null)
  assert.equal(formatProfile(1).isSeededFlag, false, 'the modeled row')
  assert.equal(formatProfile(1, 'seeded').isSeededFlag, true, 'evidence wins')
  // the two flags are coupled in every published generation
  assert.equal(formatProfile(1, 'seeded').assistantStream, true)
  assert.equal(formatProfile(1, 'seedLength').assistantStream, false)
  const base = { id: 'session-x', createdAt: 1, cwd: '/tmp/ws' }
  assert.ok('isSeeded' in sessionHeader(formatProfile(1, 'seeded'), base))
  assert.ok(!('isSeeded' in sessionHeader(formatProfile(1, 'seedLength'), base)))
  // a row backed by a released build wins over contradicting evidence: the
  // build is the authority on what it writes
  assert.equal(formatProfile(4, 'seedLength').isSeededFlag, true)
  assert.equal(formatProfile(0, 'seeded').isSeededFlag, false)
  assert.equal(formatProfile(2, 'seedLength').isSeededFlag, true)
  // an unknown future version is modeled, so evidence applies there too
  assert.equal(formatProfile(9, 'seedLength').isSeededFlag, false)
  assert.equal(formatProfile(9, 'seeded').isSeededFlag, true)
  assert.equal(formatProfile(9, 'seeded').assistantStream, true)
})

test('storage evidence accepts both listing shapes', async () => {
  assert.deepEqual(await resolveStorageEvidence({ list: async () => [{ header: { version: 4, isSeeded: false } }] }), { version: 4, dialect: 'seeded' })
  assert.deepEqual(await resolveStorageEvidence({ list: async () => [{ version: 0, id: 'a', seedLength: 0 }] }), { version: 0, dialect: 'seedLength' })
  assert.deepEqual(await resolveStorageEvidence({ list: async () => [], append: async () => {} }), { version: 0, dialect: null })
  assert.deepEqual(await resolveStorageEvidence({ list: async () => { throw new Error('boom') } }), { version: DEFAULT_FORMAT_VERSION, dialect: null })
})

test('a legacy listing cannot claim a modern format version', async () => {
  // the legacy era never wrote v2+, and its own reader refuses a foreign version
  const legacy = { append: async () => {}, create: async () => {}, list: async () => [{ version: 3, id: 'odd' }] }
  assert.deepEqual(await resolveStorageEvidence(legacy), { version: 0, dialect: null })
  const handleEra = { open: async () => {}, create: async () => {}, list: async () => [{ header: { version: 3, isSeeded: false } }] }
  assert.deepEqual(await resolveStorageEvidence(handleEra), { version: 3, dialect: 'seeded' })
})

test('a blank DeepSeek title falls back to a named default', () => {
  const titleOf = (events) => events.find((event) => event.type === 'session/title').data.title
  assert.equal(titleOf(buildSessionEvents(fixture, '   ', formatProfile(4))), 'DeepSeek 导入对话')
  assert.equal(titleOf(buildSessionEvents(fixture, undefined, formatProfile(4))), 'DeepSeek 导入对话')
  assert.equal(titleOf(buildSessionEvents(fixture, '  real title  ', formatProfile(4))), 'real title')
})

test('odd but legal history shapes still produce one valid log', () => {
  const cases = {
    'assistant first': [{ role: 'ASSISTANT', inserted_at: 1700000000, fragments: [{ type: 'RESPONSE', content: 'a' }] }],
    'two users in a row': [
      { role: 'USER', inserted_at: 1700000000, fragments: [{ type: 'REQUEST', content: 'q1' }] },
      { role: 'USER', inserted_at: 1700000001, fragments: [{ type: 'REQUEST', content: 'q2' }] },
    ],
    'two assistants in a row': [
      { role: 'USER', inserted_at: 1700000000, fragments: [{ type: 'REQUEST', content: 'q' }] },
      { role: 'ASSISTANT', inserted_at: 1700000001, fragments: [{ type: 'RESPONSE', content: 'a1' }] },
      { role: 'ASSISTANT', inserted_at: 1700000002, fragments: [{ type: 'RESPONSE', content: 'a2' }] },
    ],
    'unanswered tail': [
      { role: 'USER', inserted_at: 1700000000, fragments: [{ type: 'REQUEST', content: 'q' }] },
      { role: 'ASSISTANT', inserted_at: 1700000001, fragments: [{ type: 'RESPONSE', content: 'a' }] },
      { role: 'USER', inserted_at: 1700000002, fragments: [{ type: 'REQUEST', content: 'never answered' }] },
    ],
    'nothing at all': [],
    'only dropped rows': [null, 'x', 42, { role: 'SYSTEM' }],
  }
  for (const [name, messages] of Object.entries(cases)) {
    const events = buildSessionEvents(messages, name, formatProfile(4))
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index), name)
    const times = events.map((event) => event.time)
    assert.deepEqual(times, [...times].sort((a, b) => a - b), name)
    assert.ok(times.every((time) => Number.isSafeInteger(time) && time >= 0), name)
    assert.equal(events[0].type, 'session/title', name)
    assert.equal(events[events.length - 1].type, 'session/end-seed', name)
    // every opened step is closed unless the history itself ends unanswered
    const opens = events.filter((event) => event.type === 'step/start').length
    const closes = events.filter((event) => event.type === 'step/end').length
    // a history ending on a human prompt keeps its last turn open on purpose:
    // DSH appends the interrupted closer itself when the session is next opened
    const lastRole = String(messages.filter((m) => m && (m.role === 'USER' || m.role === 'ASSISTANT')).at(-1)?.role ?? '').toLowerCase()
    assert.equal(closes, lastRole === 'user' ? opens - 1 : opens, name)
  }
})

test('fragment content that is not a string is still read', () => {
  assert.equal(fragmentText({ fragments: [{ type: 'REQUEST', content: 42 }] }, new Set(['REQUEST'])), '42')
  assert.equal(fragmentText({ fragments: [{ type: 'RESPONSE', content: { text: 'object text' } }] }, new Set(['RESPONSE'])), 'object text')
  assert.equal(fragmentText({ fragments: [{ type: 'request', content: 'lower case type' }] }, new Set(['REQUEST'])), 'lower case type')
  assert.equal(fragmentText({ fragments: 7 }, new Set(['REQUEST'])), '')
  assert.equal(fragmentText({ fragments: [null, { type: 'REQUEST', content: null }] }, new Set(['REQUEST'])), '')
  const blocks = messageBlocks({ role: 'USER', fragments: [{ type: 'REQUEST', content: 42 }] }, 'user')
  assert.deepEqual(blocks, [{ type: 'text', text: '42' }])
})

test('absurd timestamps are treated as absent, not as year 55000', () => {
  const now = Date.now()
  assert.equal(messageTime({ inserted_at: -5 }, undefined), undefined)
  assert.equal(messageTime({ inserted_at: Number.NaN }, undefined), undefined)
  assert.equal(messageTime({ inserted_at: Number.POSITIVE_INFINITY }, undefined), undefined)
  assert.equal(messageTime({ inserted_at: 1700000000000 }, undefined), undefined, 'already in milliseconds')
  assert.equal(messageTime({ inserted_at: 1e15 }, undefined), undefined)
  assert.equal(messageTime({ inserted_at: 1700000000 }, undefined), 1700000000000)
  const skewed = messageTime({ inserted_at: (now + 3600000) / 1000 }, undefined)
  assert.ok(Math.abs(skewed - (now + 3600000)) <= 1000, 'clock skew within a day is kept')
  const events = buildSessionEvents([
    { role: 'USER', inserted_at: 1700000000, fragments: [{ type: 'REQUEST', content: 'a' }] },
    { role: 'ASSISTANT', inserted_at: 1e15, fragments: [{ type: 'RESPONSE', content: 'b' }] },
  ], 'title', formatProfile(4))
  assert.ok(events.every((event) => event.time < now + 86400000), 'no nonsense stamp reaches the log')
})

test('the stored title is a normalized one-liner within its byte budget', () => {
  const titleOf = (value) => buildSessionEvents(fixture, value, formatProfile(4))
    .find((event) => event.type === 'session/title').data.title
  assert.equal(titleOf('line1\nline2'), 'line1 line2')
  assert.equal(titleOf('esc\u001b[31mred\u001b[0m'), 'escred')
  assert.equal(titleOf('  spaced   out  '), 'spaced out')
  assert.equal(titleOf(''), 'DeepSeek 导入对话')
  assert.equal(titleOf(undefined), 'DeepSeek 导入对话')
  assert.equal(titleOf({ nope: true }), '[object Object]')
  const long = titleOf('中文标题'.repeat(200))
  assert.ok(Buffer.byteLength(long, 'utf8') <= MAX_TITLE_BYTES, 'byte budget respected')
  assert.equal(normalizeTitle('a\u0000b\u202Ec'), 'abc', 'controls and directional marks are stripped')
})
