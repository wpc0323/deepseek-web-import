/**
 * Transport tests: the child program really performs one HTTP request, reads
 * its spec from stdin, and never puts the spec (which carries the token) into
 * argv. No DSH install required — the child runs under plain `node`.
 *
 *   node --test test/transport.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { BODY_LIMIT, REQUEST_SCRIPT, redact, runRequest } from '../lib/transport.js'

/** Start one local HTTP server; returns its port and a stop function. */
async function serve(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, stop: () => new Promise((resolve) => server.close(resolve)) }
}

/** Run the child exactly as the subprocess seam does: argv carries no spec. */
function runChild(spec, argvExtra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', REQUEST_SCRIPT, ...argvExtra], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stdin.end(JSON.stringify(spec))
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), argv: child.spawnargs }))
  })
}

test('the child performs the request described on stdin', async () => {
  const seen = {}
  const { port, stop } = await serve((req, res) => {
    seen.method = req.method
    seen.url = req.url
    seen.auth = req.headers.authorization
    seen.custom = req.headers['x-fixture-header']
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.body = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"code":0,"msg":"ok"}')
    })
  })
  try {
    const spec = {
      url: `http://127.0.0.1:${port}/api/v0/chat/history_messages?chat_session_id=abc`,
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token-value', 'x-fixture-header': 'yes' },
      body: { hello: 'world' },
    }
    const result = await runChild(spec)
    assert.equal(result.code, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.status, 200)
    assert.equal(parsed.body, '{"code":0,"msg":"ok"}')
    assert.equal(parsed.truncated, false)
    assert.deepEqual(seen, {
      method: 'POST',
      url: '/api/v0/chat/history_messages?chat_session_id=abc',
      auth: 'Bearer secret-token-value',
      custom: 'yes',
      body: '{"hello":"world"}',
    })
    assert.ok(!result.argv.some((arg) => arg.includes('secret-token-value')), 'the token never reaches argv')
  } finally {
    await stop()
  }
})

test('a response over the limit is reported as truncated, not as a parse failure', async () => {
  const { port, stop } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('x'.repeat(BODY_LIMIT + 10))
  })
  try {
    const parsed = JSON.parse((await runChild({ url: `http://127.0.0.1:${port}/big` })).stdout)
    assert.equal(parsed.truncated, true)
    assert.equal(parsed.body.length, BODY_LIMIT)
  } finally {
    await stop()
  }
})

test('transport failures are reported as errors, not as bodies', async () => {
  const dead = await serve(() => {})
  const port = dead.port
  await dead.stop()
  const parsed = JSON.parse((await runChild({ url: `http://127.0.0.1:${port}/gone` })).stdout)
  assert.equal(typeof parsed.error, 'string')
  assert.equal(parsed.body, undefined)
})

test('a malformed spec is rejected without touching the network', async () => {
  const parsed = JSON.parse((await runChild({ url: 'not a url' })).stdout)
  assert.equal(parsed.error, 'invalid url')
})

test('runRequest sends the spec on stdin and reports a missing pipe', async () => {
  const sent = []
  const handle = {
    stdin: { on() {}, end(text) { sent.push(text) } },
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text: JSON.stringify({ status: 200, body: '{}', truncated: false }) }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  }
  let spawnSpec
  const subprocess = { spawn: (spec) => { spawnSpec = spec; return handle } }
  const result = await runRequest(subprocess, { url: 'https://chat.deepseek.com/x' }, { cwd: '/tmp' })
  assert.equal(result.status, 200)
  assert.equal(spawnSpec.cwd, '/tmp')
  assert.equal(spawnSpec.stdio.stdin, 'pipe')
  assert.ok(!spawnSpec.argv.some((arg) => String(arg).includes('chat.deepseek.com')), 'argv carries no spec')
  assert.deepEqual(sent, ['{"url":"https://chat.deepseek.com/x"}'])
  assert.ok(spawnSpec.stdio.stdout.maxBytes >= BODY_LIMIT, 'stdout can hold the escaped body')

  const withoutPipe = await runRequest({ spawn: () => ({ done: Promise.resolve({ exitCode: 0 }) }) }, {})
  assert.match(withoutPipe.error, /stdin/)

  const noOutput = await runRequest({
    spawn: () => ({
      stdin: { on() {}, end() {} },
      done: Promise.resolve({ exitCode: 1 }),
      collected: { stdout: { readFrom: () => ({ text: '  ' }) }, stderr: { readFrom: () => ({ text: 'boom' }) } },
    }),
  }, {})
  assert.match(noOutput.error, /没有输出/)
})

test('redact caps and hides the token', () => {
  assert.equal(redact('token abcdef here', 'abcdef'), 'token [token] here')
  assert.equal(redact('x'.repeat(20), null, 5), 'xxxxx…')
  assert.equal(redact(null), '')
})
