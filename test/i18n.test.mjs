/**
 * Browser-half dictionaries, loaded offline through a stubbed module loader.
 *
 * `lib/client.js` is a DSH bundle: its top-level statement calls
 * `window.__ModuleLoader__.load(...)`, so the stub has to be installed *before*
 * the module is evaluated — hence the dynamic `import()` instead of a static
 * one. No DSH install, no browser and no network are involved.
 *
 *   node --test test/i18n.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Minimal `react` stand-in: the module only reaches for these while rendering. */
const REACT = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

let loaded = null

/**
 * Import the bundle once (ESM caches it, so the loader fires exactly once) and
 * hand back both the captured registration and the module's own exports.
 * @returns {Promise<{registration: object, exports: object}>} the capture.
 */
async function loadClient() {
  if (loaded !== null) return loaded
  let registration = null
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (captured) => { registration = captured } } }
  try {
    await import('../lib/client.js')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.ok(registration !== null, 'the bundle registered itself with __ModuleLoader__')
  loaded = {
    registration,
    exports: registration.factory((specifier) => {
      if (specifier === 'react') return REACT
      throw new Error('unexpected require: ' + specifier)
    }),
  }
  return loaded
}

/** The `{name}` placeholders one template carries, as a sorted set. */
function placeholders(template) {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort()
}

test('the bundle registers under its own id and hands back a plugin', async () => {
  const { registration, exports } = await loadClient()
  assert.equal(registration.id, 'deepseek-web-import')
  assert.equal(typeof registration.factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(exports.__messages !== null && typeof exports.__messages === 'object', '__messages is exposed for this test')
})

test('locale is declared as a dependency, or the page ignores the Host language', async () => {
  const { exports } = await loadClient()
  /* A client plugin only sees the services its own `inject` names. Leaving
     `locale` out made `ctx.get('locale')` return undefined, so the page fell
     back to the browser language while the rest of the GUI followed the Host
     setting — the bug this asserts against. */
  assert.ok(
    Array.isArray(exports.inject) && exports.inject.includes('locale'),
    'inject must name "locale": ' + JSON.stringify(exports.inject),
  )
  assert.ok(exports.inject.includes('slots'), 'the settings section still needs the slot registry')
})

test('every message is a non-empty pair of zh and en strings', async () => {
  const { exports } = await loadClient()
  const messages = exports.__messages
  const keys = Object.keys(messages)
  assert.ok(keys.length >= 40, `the table looks complete (${keys.length} keys)`)
  for (const key of keys) {
    assert.ok(Array.isArray(messages[key]), `${key} is an array`)
    assert.equal(messages[key].length, 2, `${key} carries exactly two languages`)
    for (const [index, language] of [[0, 'zh'], [1, 'en']]) {
      assert.equal(typeof messages[key][index], 'string', `${key}/${language} is a string`)
      assert.ok(messages[key][index].trim().length > 0, `${key}/${language} is not blank`)
    }
  }
})

test('both languages of a key carry the same placeholders', async () => {
  const { exports } = await loadClient()
  for (const [key, [zh, en]] of Object.entries(exports.__messages)) {
    assert.deepEqual(placeholders(zh), placeholders(en), `${key} placeholder parity`)
  }
})

test('a key that fills a parameter is declared in both languages', async () => {
  const { exports } = await loadClient()
  const messages = exports.__messages
  /* the ones the page interpolates: a missing placeholder would render a
     sentence with a hole in it, in one language only */
  for (const key of ['statusLine', 'tokenClearFailed', 'listSummary', 'imported', 'importedDetail', 'errApi', 'errNotJson', 'errPersist']) {
    assert.ok(placeholders(messages[key][0]).length > 0, `${key} takes a parameter`)
  }
})

test('every failure code the host answers with has a localized message', async () => {
  const { exports } = await loadClient()
  const messages = exports.__messages
  /* the code → key mapping the browser half's describeErr switches on: a code
     without a key falls through to the host's raw text, which is the one thing
     the refactor removed */
  const localized = {
    save_failed: 'errSaveFailed',
    probe_refused: 'errProbe',
    credentials_unavailable: 'errCredentials',
    persistence_unavailable: 'errPersistence',
    workspace_registry_unavailable: 'errWorkspaceRegistry',
    subprocess_unavailable: 'errSubprocess',
    node_unavailable: 'errNodeMissing',
    too_large: 'errTooLarge',
    empty_history: 'errEmptyHistory',
    no_workspace: 'errNoWorkspace',
    no_token: 'errNoToken',
    token_empty: 'errNoToken',
    verify: 'errVerify',
    persist: 'errPersist',
    api: 'errApi',
    not_json: 'errNotJson',
    transport: 'errTransport',
    parse: 'errParse',
  }
  for (const [code, key] of Object.entries(localized)) {
    assert.ok(messages[key] !== undefined, `${code} → ${key} is missing from the table`)
    assert.ok(messages[key][0].trim().length > 0 && messages[key][1].trim().length > 0, key)
  }
  /* the two codes whose meaning is carried entirely by the dictionary */
  assert.ok(messages.errCredentials[1].length > 0)
  assert.ok(messages.errSubprocess[1].length > 0)
})

test('apply() binds the Host dictionary when the locale service is present', async () => {
  const { exports } = await loadClient()
  const registered = []
  let boundNamespace = null
  const slotLabel = []
  const locale = {
    register(namespace, dicts) { registered.push({ namespace, dicts }); return () => {} },
    bind(namespace) {
      boundNamespace = namespace
      /* stand in for the Host chain: the English half of every pair */
      return (key) => (exports.__messages[key] ? exports.__messages[key][1] : key)
    },
  }
  const slots = {
    inject: (_name, factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
    register: (options) => { slotLabel.push(options.label); return () => {} },
  }
  const dispose = []
  const ctx = {
    get: (name) => (name === 'locale' ? locale : name === 'slots' ? slots : undefined),
    effect: (factory) => { const off = factory(); if (typeof off === 'function') dispose.push(off); return () => {} },
    on: () => () => {},
  }
  /* apply() injects the stylesheet first, so it needs a minimal document */
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: () => ({ textContent: '', parentNode: null }),
    head: { appendChild: () => {} },
  }
  try {
    exports.apply(ctx)
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }

  assert.equal(registered.length, 1, 'the dictionaries are registered once')
  assert.deepEqual(Object.keys(registered[0].dicts).sort(), ['en', 'zh'])
  assert.equal(boundNamespace, registered[0].namespace, 'translation goes through the same namespace')
  assert.equal(typeof slotLabel[0], 'function')
  /* the section label follows the Host language, not the browser */
  assert.equal(slotLabel[0](), 'DeepSeek Chat Import')
})
