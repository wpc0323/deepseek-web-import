/**
 * The one raw HTTP request path used by the host half.
 *
 * chat.deepseek.com wants headers the DSH `web.fetch` service cannot carry, so
 * a request is performed by a short-lived `node -e` child spawned through the
 * DSH `subprocess` service. Two properties here are deliberate:
 *
 * - the request spec — which carries the user's `Authorization` header —
 *   travels on the child's **stdin**, never in argv, so it stays out of `ps`
 *   output and `/proc/<pid>/cmdline`;
 * - the child keeps at most {@link BODY_LIMIT} characters of the response and
 *   reports `truncated`, so an oversized conversation is reported as such
 *   instead of surfacing later as a JSON parse failure.
 *
 * @module deepseek-web-import/transport
 */

/**
 * Largest response body kept, in characters. CJK text is ~3 bytes per character
 * in UTF-8, so this is roughly 6 MB of a Chinese conversation — far beyond any
 * real history, and small enough to keep the escaped copy on stdout bounded.
 */
export const BODY_LIMIT = 2000000

/** Collected stdout bound: the escaped body, its JSON wrapper, and headroom. */
const STDOUT_LIMIT_BYTES = 16 * 1024 * 1024

/** Collected stderr bound: diagnostics only, never the response. */
const STDERR_LIMIT_BYTES = 1024 * 1024

/** How long a request may take before the child aborts itself. */
const REQUEST_TIMEOUT_MS = 60000

/** Grace period the spawn seam adds around that timeout. */
const SPAWN_GRACE_MS = 70000

/**
 * The child program: read one JSON spec from stdin, perform one HTTP request,
 * print one JSON result line. It never reads argv and never touches the shell.
 */
export const REQUEST_SCRIPT = [
  "const chunks = [];",
  "process.stdin.on('data', (c) => chunks.push(c));",
  "process.stdin.on('end', () => {",
  "  let spec = {};",
  "  try { spec = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { console.log(JSON.stringify({ error: 'invalid spec' })); return; }",
  "  const https = require('https');",
  "  const http = require('http');",
  "  let parsed;",
  "  try { parsed = new URL(spec.url); } catch { console.log(JSON.stringify({ error: 'invalid url' })); return; }",
  "  const lib = parsed.protocol === 'http:' ? http : https;",
  "  const body = spec.body === undefined ? null : (typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body));",
  "  const opts = { method: (spec.method || 'GET').toUpperCase(), headers: Object.assign({ 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' }, spec.headers || {}) };",
  "  if (lib === https) opts.rejectUnauthorized = false;",
  "  if (body !== null && opts.headers['Content-Type'] === undefined) opts.headers['Content-Type'] = 'application/json';",
  "  const req = lib.request(parsed, opts, (res) => {",
  "    const out = [];",
  "    res.on('data', (c) => out.push(c));",
  "    res.on('end', () => { const text = Buffer.concat(out).toString('utf8'); console.log(JSON.stringify({ status: res.statusCode, statusText: res.statusMessage || '', headers: res.headers, body: text.slice(0, __BODY_LIMIT__), truncated: text.length > __BODY_LIMIT__ })); });",
  "  });",
  "  req.on('error', (e) => { console.log(JSON.stringify({ error: String((e && e.message) || e) })); });",
  "  req.setTimeout(Number(spec.timeoutMs || __TIMEOUT_MS__), () => { req.destroy(new Error('timeout')); });",
  "  if (body !== null) req.write(body);",
  "  req.end();",
  "});",
].join('\n')
  .replaceAll('__BODY_LIMIT__', String(BODY_LIMIT))
  .replaceAll('__TIMEOUT_MS__', String(REQUEST_TIMEOUT_MS))

/**
 * Perform one raw HTTP request through the subprocess seam.
 * @param {object} subprocess - the DSH `subprocess` service.
 * @param {object} spec - `{url, method?, headers?, body?, timeoutMs?}`.
 * @param {{cwd?: string}} [options] - working directory for the child.
 * @returns {Promise<object>} `{exitCode, status?, body?, truncated?, error?, stderr}`.
 */
export async function runRequest(subprocess, spec, options = {}) {
  const handle = subprocess.spawn({
    argv: ['node', '-e', REQUEST_SCRIPT],
    cwd: options.cwd === undefined ? '.' : options.cwd,
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: STDOUT_LIMIT_BYTES },
      stderr: { maxBytes: STDERR_LIMIT_BYTES },
    },
    graceMs: SPAWN_GRACE_MS,
  })
  const stdin = handle.stdin
  if (stdin === undefined) {
    return { error: 'subprocess 未提供 stdin，无法发送请求' }
  }
  /* A child that exits early (bad request, crash) closes the pipe; its exit is
     reported through `handle.done`, so the write error itself is noise. */
  stdin.on('error', () => {})
  stdin.end(JSON.stringify(spec || {}))

  const outcome = await handle.done
  const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
  const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
  const trimmed = (out || '').trim()
  if (trimmed === '') {
    return {
      exitCode: outcome.exitCode,
      error: '子进程没有输出',
      stderr: String(err || '').slice(0, 500),
    }
  }
  let result
  try {
    result = JSON.parse(trimmed)
  } catch {
    result = { error: '子进程输出无法解析', raw: trimmed.slice(0, 500) }
  }
  return { exitCode: outcome.exitCode, ...result, stderr: err }
}

/**
 * Cap one diagnostic string and drop a secret from it, for values that may
 * travel back to the browser.
 * @param {unknown} text - the value to clean.
 * @param {string|null} [token] - the token to redact, when one is in scope.
 * @param {number} [limit] - maximum characters kept.
 * @returns {string} the cleaned, capped string.
 */
export function redact(text, token = null, limit = 600) {
  const value = text === undefined || text === null ? '' : String(text)
  const capped = value.length > limit ? value.slice(0, limit) + '…' : value
  return token ? capped.split(token).join('[token]') : capped
}
