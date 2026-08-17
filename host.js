// DeepSeek Web 对话导入 —— Host 半部（动态 Cordis 插件）
// 用法：把本文件内容作为 cordis_define 的 code.host 传入（与 client.js 配对）。
return {
  apply(ctx) {
    const TOKEN_REF = 'DEEPSEEK_WEB_TOKEN';
    const BASE = 'https://chat.deepseek.com';

    const NODE = [
      "const spec = JSON.parse(process.argv[1] || '{}');",
      "const https = require('https');",
      "const http = require('http');",
      "const parsed = new URL(spec.url);",
      "const lib = parsed.protocol === 'http:' ? http : https;",
      "const body = spec.body === undefined ? null : (typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body));",
      "const opts = { method: (spec.method || 'GET').toUpperCase(), headers: Object.assign({ 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' }, spec.headers || {}) };",
      "if (lib === https) opts.rejectUnauthorized = false;",
      "if (body !== null && opts.headers['Content-Type'] === undefined) opts.headers['Content-Type'] = 'application/json';",
      "const req = lib.request(parsed, opts, (res) => {",
      "  const chunks = [];",
      "  res.on('data', (c) => chunks.push(c));",
      "  res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); console.log(JSON.stringify({ status: res.statusCode, statusText: res.statusMessage || '', headers: res.headers, body: text.slice(0, 500000) })); });",
      "});",
      "req.on('error', (e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); });",
      "req.setTimeout(Number(spec.timeoutMs || 60000), () => { req.destroy(new Error('timeout')); });",
      "if (body !== null) req.write(body);",
      "req.end();"
    ].join('\n');

    async function nodeHttp(spec) {
      const subprocess = ctx.get('subprocess');
      if (subprocess === undefined) return { error: 'subprocess unavailable' };
      const policy = ctx.get('sandboxPolicy');
      const cwd = (policy && policy.workspaceRoot) ? policy.workspaceRoot : '.';
      const handle = subprocess.spawn({
        argv: ['node', '-e', NODE, JSON.stringify(spec || {})],
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 20 * 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
        graceMs: 70000,
      });
      const outcome = await handle.done;
      const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '';
      const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '';
      const trimmed = (out || '').trim();
      let result = {};
      try { result = JSON.parse(trimmed); } catch (e) { result = { raw: trimmed }; }
      return { exitCode: outcome.exitCode, ...result, stderr: err };
    }

    function safeParse(text) { try { return JSON.parse(text); } catch (e) { return null; } }

    function normalizeToken(raw) {
      if (typeof raw !== 'string') return '';
      const t = raw.trim();
      if (t.startsWith('{')) {
        try {
          const j = JSON.parse(t);
          if (j && typeof j.value === 'string' && j.value.length > 0) return j.value.trim();
        } catch (e) {}
      }
      return t;
    }

    function defaultHeaders(token) {
      return {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-app-version': '20240105.0',
        'x-client-locale': 'zh_CN',
        'x-client-platform': 'web',
        'x-client-version': '1.0.0-alpine',
        'x-device-id': 'dswi-' + Math.random().toString(36).slice(2, 14),
        'x-os': 'web',
        'x-requested-with': 'XMLHttpRequest',
        'Origin': BASE,
        'Referer': BASE + '/'
      };
    }

    async function resolveToken(passed) {
      if (passed) return normalizeToken(passed);
      const creds = ctx.get('credentials');
      if (!creds) return null;
      try { const r = await creds.resolve(TOKEN_REF); return r ? normalizeToken(r.value) : null; } catch (e) { return null; }
    }

    function extractText(content) {
      if (content === null || content === undefined) return '';
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map(function (b) {
          if (typeof b === 'string') return b;
          if (b && typeof b.text === 'string') return b.text;
          if (b && typeof b.content === 'string') return b.content;
          return '';
        }).join('\n');
      }
      if (typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
        if (typeof content.content === 'string') return content.content;
      }
      return String(content);
    }

    function extractSessions(j) {
      if (!j) return null;
      const data = j.data || j;
      const biz = (data && data.biz_data) || data;
      const arr = biz.chat_sessions || biz.sessions || biz.chat_session_list || biz.list;
      return Array.isArray(arr) ? arr : null;
    }

    function extractMessages(j) {
      if (!j) return null;
      const data = j.data || j;
      const biz = (data && data.biz_data) || data;
      const arr = biz.chat_messages || biz.messages || biz.chat_message_list || biz.history || biz.message_list;
      return Array.isArray(arr) ? arr : null;
    }

    function buildSessionEvents(messages, title) {
      const events = [];
      let seq = 0;
      let turn = 0;
      let openStep = false;
      const base = Date.now();
      function push(type, data, surfaceOp) {
        const ev = { type: type, seq: seq, time: base + seq, data: data };
        if (surfaceOp !== undefined) ev.surfaceOp = surfaceOp;
        events.push(ev);
        seq += 1;
      }
      push('session/title', { title: String(title || 'DeepSeek 导入对话'), messageSeqs: [], source: { kind: 'user' } });
      (messages || []).forEach(function (m) {
        const role = String(m.role || '').toLowerCase();
        const text = extractText(m.content);
        if (role === 'user') {
          if (openStep) {
            push('step/end', { turn: turn, step: 1 });
            push('turn/end', { turn: turn, reason: { kind: 'completed' } });
            openStep = false;
          }
          turn += 1;
          push('turn/start', { turn: turn });
          push('user/message', { id: 'msg-' + turn + '-u', role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'user' } }, 'append');
          push('step/start', { turn: turn, step: 1 });
          openStep = true;
        } else {
          if (!openStep) {
            turn += 1;
            push('turn/start', { turn: turn });
            push('step/start', { turn: turn, step: 1 });
            openStep = true;
          }
          push('assistant/message', { turn: turn, step: 1, message: { id: 'msg-' + turn + '-a', role: 'assistant', content: [{ type: 'text', text: text }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } } }, 'append');
          push('step/end', { turn: turn, step: 1 });
          push('turn/end', { turn: turn, reason: { kind: 'completed' } });
          openStep = false;
        }
      });
      push('session/end-seed', {});
      return events;
    }

    async function fetchHistoryInternal(sessionId, token) {
      const h = defaultHeaders(token);
      const r = await nodeHttp({ url: BASE + '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId), method: 'GET', headers: h });
      const j = typeof r.body === 'string' ? safeParse(r.body) : r.body;
      if (!j) return { ok: false, error: 'not_json', status: r.status, raw: String(r.body).slice(0, 1200) };
      if (j.code !== 0) return { ok: false, error: 'api', code: j.code, msg: j.msg, raw: JSON.stringify(j).slice(0, 1200) };
      const bizCode = j.data && j.data.biz_code;
      if (bizCode !== undefined && bizCode !== 0) return { ok: false, error: 'api', code: bizCode, msg: (j.data && j.data.biz_msg) || '', raw: JSON.stringify(j).slice(0, 1200) };
      const messages = extractMessages(j);
      if (!messages) return { ok: false, error: 'parse', raw: JSON.stringify(j).slice(0, 2000) };
      return { ok: true, messages: messages };
    }

    async function importToSessionInternal(deepseekSessionId, title, workspaceId, token) {
      const hist = await fetchHistoryInternal(deepseekSessionId, token);
      if (!hist.ok) return hist;
      // 空对话拦截：不要为一个没有消息的对话创建空会话
      if (!Array.isArray(hist.messages) || hist.messages.length === 0) {
        return { ok: false, error: 'empty_history', msg: '该 DeepSeek 对话没有可导入的消息' };
      }
      const persistence = ctx.get('sessionPersistence');
      if (!persistence) return { ok: false, error: 'sessionPersistence 服务不可用' };
      const reg = ctx.get('workspaceRegistry');
      let ws = null;
      if (reg && workspaceId) { ws = reg.get(workspaceId); }
      if (!ws) return { ok: false, error: 'no_workspace', msg: '未找到工作区' };

      const events = buildSessionEvents(hist.messages, title);
      const sid = 'session-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      const meta = { version: 0, id: sid, createdAt: Date.now(), cwd: ws.path };

      try {
        await persistence.create(meta);
        await persistence.append(sid, events);
      } catch (e) {
        return { ok: false, error: 'persist', message: String(e && e.message || e) };
      }

      try {
        await ws.attachSession(sid);
      } catch (e) {
        // 会话文件已写入磁盘（可从会话列表找回），只是未挂载到工作区——不误报为导入失败
        return { ok: true, sessionId: sid, messageCount: hist.messages.length, title: String(title || ''), attached: false, attachError: String(e && e.message || e) };
      }

      return { ok: true, sessionId: sid, messageCount: hist.messages.length, title: String(title || ''), attached: true };
    }

    harness.handle('tokenStatus', async () => {
      const creds = ctx.get('credentials');
      if (!creds) return { configured: false, writable: false };
      const info = await creds.describe(TOKEN_REF);
      return { configured: info.configured, writable: info.writable };
    });

    harness.handle('saveToken', async (args) => {
      const creds = ctx.get('credentials');
      if (!creds) return { ok: false, error: 'credentials 服务不可用' };
      const token = normalizeToken(String((args && args.token) || ''));
      if (!token) return { ok: false, error: 'token 为空（或解析失败）' };
      try { await creds.set(TOKEN_REF, token); return { ok: true, normalized: true }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });

    harness.handle('clearToken', async () => {
      const creds = ctx.get('credentials');
      if (!creds) return { ok: false, error: 'credentials 服务不可用' };
      try { await creds.unset(TOKEN_REF); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    });

    harness.handle('listSessions', async (args) => {
      const token = await resolveToken(args && args.token);
      if (!token) return { ok: false, error: 'no_token', msg: '尚未保存 userToken' };
      const h = defaultHeaders(token);
      const r = await nodeHttp({ url: BASE + '/api/v0/chat_session/fetch_page?count=100', method: 'GET', headers: h });
      const j = typeof r.body === 'string' ? safeParse(r.body) : r.body;
      if (r.status !== 200 || !j) return { ok: false, error: 'not_json', status: r.status, raw: String(r.body).slice(0, 1200) };
      if (j.code !== 0) return { ok: false, error: 'api', code: j.code, msg: j.msg, raw: JSON.stringify(j).slice(0, 1200) };
      const bizCode = j.data && j.data.biz_code;
      if (bizCode !== undefined && bizCode !== 0) return { ok: false, error: 'api', code: bizCode, msg: (j.data && j.data.biz_msg) || '', raw: JSON.stringify(j).slice(0, 1200) };
      const sessions = extractSessions(j);
      if (!sessions) return { ok: false, error: 'parse', raw: JSON.stringify(j).slice(0, 2000) };
      return { ok: true, sessions: sessions.map(function (s) { return { id: s.id, title: s.title || '(无标题)', updatedAt: s.updated_at || s.updatedAt || s.inserted_at || null }; }) };
    });

    harness.handle('fetchHistory', async (args) => {
      const token = await resolveToken(args && args.token);
      if (!token) return { ok: false, error: 'no_token' };
      return fetchHistoryInternal(args.sessionId, token);
    });

    harness.handle('listWorkspaces', async () => {
      const reg = ctx.get('workspaceRegistry');
      if (!reg) return { ok: false, error: 'workspaceRegistry 不可用' };
      const ws = reg.list();
      return { ok: true, workspaces: ws.map(function (w) { return { id: w.id, title: w.title, path: w.path }; }) };
    });

    harness.handle('importToSession', async (args) => {
      const token = await resolveToken(args && args.token);
      if (!token) return { ok: false, error: 'no_token', msg: '尚未保存 userToken' };
      return importToSessionInternal(args.sessionId, args.title, args.workspaceId, token);
    });

    harness.handle('probe', async (args) => {
      const spec = { url: args && args.url, method: (args && args.method) || 'GET' };
      if (args && args.headers) { try { spec.headers = JSON.parse(args.headers); } catch (e) {} }
      if (args && args.body !== undefined && args.body !== '') { try { spec.body = JSON.parse(args.body); } catch (e) { spec.body = args.body; } }
      return nodeHttp(spec);
    });
  }
};
