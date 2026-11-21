/**
 * The list search boxes: what a query matches, and what it must never hide.
 *
 * The filter lives inside `lib/client.js`'s component, so this file exercises
 * the same rule the component applies (case-insensitive substring over the
 * fields the row displays) rather than mounting React. Keeping the rule in one
 * place here means a change to the visible fields is a change to this test.
 *
 *   node --test test/search.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Copy of the component's `matches`: keep in step with lib/client.js. */
function matches(query, fields) {
  const needle = String(query || '').trim().toLowerCase()
  if (needle === '') return true
  for (const field of fields) {
    if (field === undefined || field === null) continue
    if (String(field).toLowerCase().includes(needle)) return true
  }
  return false
}

/** One catalog row as the list renders it: title, date, id. */
function catalogRow(title, updatedAt, id) {
  const date = updatedAt === null ? '' : new Date(updatedAt * 1000).toISOString().slice(0, 10)
  return { title, updatedAt, id, fields: [title, date, id] }
}

/** One managed row as the list renders it: title, workspace, id, created date. */
function managedRow(title, workspaceTitle, id, createdAt) {
  const date = createdAt === null ? '' : new Date(createdAt).toISOString().slice(0, 10)
  return { title, workspaceTitle, id, createdAt, fields: [title, workspaceTitle, id, date] }
}

const CATALOG = [
  catalogRow('sharp 加载失败解决', 1700000000, 'c1'),
  catalogRow('React 性能优化', 1700100000, 'c2'),
  catalogRow('Untitled chat', null, 'c3'),
]

const MANAGED = [
  managedRow('sharp 加载失败解决', 'dsh-work', 'session-a', 1700000000000),
  managedRow('React 性能优化', 'notes', 'session-b', 1700100000000),
]

test('an empty query is not a filter', () => {
  for (const row of CATALOG) assert.equal(matches('', row.fields), true)
  for (const row of CATALOG) assert.equal(matches('   ', row.fields), true)
  for (const row of MANAGED) assert.equal(matches(undefined, row.fields), true)
})

test('a query matches the title, case-insensitively', () => {
  const sharp = CATALOG.filter((row) => matches('SHARP', row.fields))
  assert.deepEqual(sharp.map((row) => row.id), ['c1'])
  const react = CATALOG.filter((row) => matches('react', row.fields))
  assert.deepEqual(react.map((row) => row.id), ['c2'])
})

test('a query matches a substring in the middle of a Chinese title', () => {
  const hits = CATALOG.filter((row) => matches('加载失败', row.fields))
  assert.deepEqual(hits.map((row) => row.id), ['c1'])
})

test('a query matches the displayed date', () => {
  const hits = CATALOG.filter((row) => matches('2023-11', row.fields))
  assert.deepEqual(hits.map((row) => row.id).sort(), ['c1', 'c2'].sort())
})

test('a managed row is findable by its workspace', () => {
  const hits = MANAGED.filter((row) => matches('notes', row.fields))
  assert.deepEqual(hits.map((row) => row.id), ['session-b'])
})

test('surrounding whitespace is ignored, and a miss returns nothing', () => {
  assert.equal(CATALOG.filter((row) => matches('  sharp  ', row.fields)).length, 1)
  assert.deepEqual(CATALOG.filter((row) => matches('no such thing', row.fields)), [])
})

test('a null date field neither matches nor throws', () => {
  const row = catalogRow('Untitled chat', null, 'c3')
  assert.equal(matches('untitled', row.fields), true)
  assert.equal(matches('1970', row.fields), false, 'a missing date is not the epoch')
})

test('filtering keeps the original order of the rows it keeps', () => {
  const rows = [
    catalogRow('b match', 1700200000, 'c9'),
    catalogRow('a other', 1700000000, 'c1'),
    catalogRow('c match', 1700100000, 'c2'),
  ]
  assert.deepEqual(rows.filter((row) => matches('match', row.fields)).map((row) => row.id), ['c9', 'c2'])
})

/* ---- collapse: a folded list still counts, and still honours the query ---- */

/**
 * The count a collapsed section reports. Mirrors what `renderManaged` and the
 * catalog card pass to `collapsedCount`: rows matching the current query, out of
 * every row. A collapsed list that ignored the query would misreport after a
 * search, which is exactly the bug this pins.
 */
function collapsedCount(rows, query) {
  return { count: rows.filter((row) => matches(query, row.fields)).length, total: rows.length }
}

test('a collapsed list reports the count without rendering rows', () => {
  assert.deepEqual(collapsedCount(CATALOG, ''), { count: 3, total: 3 })
  assert.deepEqual(collapsedCount(MANAGED, ''), { count: 2, total: 2 })
})

test('a collapsed list still honours the active query', () => {
  /* searching while folded, then folding: the count must follow the query */
  assert.deepEqual(collapsedCount(CATALOG, 'sharp'), { count: 1, total: 3 })
  assert.deepEqual(collapsedCount(MANAGED, 'notes'), { count: 1, total: 2 })
  assert.deepEqual(collapsedCount(MANAGED, 'nothing here'), { count: 0, total: 2 })
})

test('an empty list collapses to a zero count rather than a blank label', () => {
  assert.deepEqual(collapsedCount([], ''), { count: 0, total: 0 })
  assert.deepEqual(collapsedCount([], 'anything'), { count: 0, total: 0 })
})
