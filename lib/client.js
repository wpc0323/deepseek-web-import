// deepseek-web-import — browser half (client plugin module).
//
// Adds a "DeepSeek 对话导入" page to the DSH Web settings panel
// (`settings.section`, id `deepseek-web-import`). It talks to the host half
// through same-origin JSON routes (`/__deepseek-web-import/*`, see
// `../lib/index.js`): save/clear the DeepSeek userToken, list the
// conversation directory, and import a chosen conversation into a chosen
// workspace as a durable DSH session.
//
// Client plugin entry: exports a Cordis plugin (`apply` + `inject`); the
// loader wrapper (`window.__ModuleLoader__.load`) resolves `react` through the
// module table and calls `apply` once the `slots` service is available.
window.__ModuleLoader__.load({
  id: 'deepseek-web-import',
  factory: (require) => {
    var module = { exports: {} };
    module.exports;
    //#region lib/client.js
    const React = require('react');

    /** Call one host route and parse its JSON response. */
    function call(method, args) {
      return fetch('/__deepseek-web-import/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      }).then((res) => res.json()).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    const CSS = [
      '.dswi{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}',
      '.dswi-card{border:1px solid var(--color-border,#e2e2e2);border-radius:8px;padding:12px 14px}',
      '.dswi-row{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}',
      '.dswi-input{flex:1;min-width:200px;padding:6px 8px;border-radius:6px;border:1px solid var(--color-border,#ccc)}',
      '.dswi-title{flex:1;min-width:200px}',
      '.dswi-note{color:var(--color-text-secondary,#888);margin:4px 0}',
      '.dswi-err{color:#c0392b}',
      '.dswi-ok{color:#1e8e3e}',
      '.dswi-pre{white-space:pre-wrap;word-break:break-all;background:var(--color-bg-secondary,#f5f5f5);padding:8px;border-radius:6px;max-height:300px;overflow:auto;font-size:11px}',
      '.dswi h3{margin:0 0 8px}',
      '.dswi button{padding:6px 10px;border-radius:6px;border:1px solid #ccc;cursor:pointer;background:var(--color-bg,#fff);color:var(--color-text,#222)}',
      '.dswi select{padding:6px;border-radius:6px;border:1px solid #ccc;max-width:200px}',
    ].join('');

    function App(props) {
      const [token, setToken] = React.useState('');
      const [status, setStatus] = React.useState(null);
      const [sessions, setSessions] = React.useState(null);
      const [workspaces, setWorkspaces] = React.useState([]);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [results, setResults] = React.useState({});
      const [wsSel, setWsSel] = React.useState({});
      const [showDiag, setShowDiag] = React.useState(false);
      const [probeUrl, setProbeUrl] = React.useState('');
      const [probeOut, setProbeOut] = React.useState('');

      React.useEffect(function () {
        (async function () {
          const s = await call('tokenStatus');
          setStatus(s);
          const w = await call('listWorkspaces');
          if (w && w.ok && Array.isArray(w.workspaces)) setWorkspaces(w.workspaces);
        })();
      }, []);

      function describeErr(r) {
        if (!r) return '未知错误';
        if (r.error === 'no_token') return '尚未保存 userToken';
        if (r.error === 'api') return 'DeepSeek 接口错误 (code ' + r.code + '): ' + (r.msg || '');
        if (r.error === 'not_json') return '响应非 JSON（可能 Token 无效或接口变更），HTTP ' + r.status;
        return String(r.msg || r.message || r.error || '') + (r.raw ? ' —— ' + r.raw : '');
      }

      function formatTime(t) {
        if (!t) return '';
        try { const n = Number(t); const d = new Date(n > 100000000000 ? n : n * 1000); return d.toISOString().slice(0, 10); } catch (e) { return ''; }
      }

      async function saveToken() {
        setError(''); setNotice('');
        const r = await call('saveToken', { token: token });
        if (r && r.ok) { setNotice(r.normalized ? 'Token 已保存（已自动提取 value 字段）' : 'Token 已保存'); setStatus(await call('tokenStatus')); }
        else setError((r && r.error) || '保存失败');
      }
      async function clearToken() {
        await call('clearToken');
        setToken(''); setNotice('Token 已清除'); setStatus(await call('tokenStatus'));
      }
      async function list() {
        setLoading(true); setError(''); setSessions(null);
        if (token.trim()) {
          const s = await call('saveToken', { token: token });
          if (s && s.ok) { setStatus(await call('tokenStatus')); }
          else { setLoading(false); setError((s && s.error) || 'Token 保存失败'); return; }
        }
        const r = await call('listSessions');
        setLoading(false);
        if (r && r.ok) setSessions(r.sessions);
        else setError(describeErr(r));
      }
      async function doImport(s) {
        const wid = wsSel[s.id] || (workspaces.length ? workspaces[0].id : null);
        setResults(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[s.id] = { state: 'loading' }; return n; });
        const r = await call('importToSession', { sessionId: s.id, title: s.title, workspaceId: wid });
        setResults(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[s.id] = r; return n; });
      }
      async function runProbe() {
        setProbeOut('');
        const r = await call('probe', { url: probeUrl, method: 'GET' });
        setProbeOut(JSON.stringify(r, null, 2));
      }

      function renderRow(s) {
        const wid = wsSel[s.id] || (workspaces.length ? workspaces[0].id : null);
        const res = results[s.id];
        return React.createElement('div', { className: 'dswi-row', key: s.id },
          React.createElement('div', { className: 'dswi-title', title: String(s.id) }, s.title + (s.updatedAt ? ' (' + formatTime(s.updatedAt) + ')' : '')),
          React.createElement('select', { value: wid || '', onChange: function (e) { setWsSel(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[s.id] = e.target.value; return n; }); } },
            workspaces.map(function (w) { return React.createElement('option', { key: String(w.id), value: String(w.id) }, w.title); })
          ),
          React.createElement('button', { onClick: function () { doImport(s); }, disabled: !wid }, '导入为会话'),
          res ? React.createElement('span', { className: res.ok ? 'dswi-ok' : 'dswi-err' },
            res.state === 'loading' ? '导入中…' : (res.ok ? ('✓ 已导入会话 ' + res.sessionId + '（' + res.messageCount + ' 条消息）' + (res.attached === false ? '（未挂载到工作区）' : '')) : ('✗ ' + describeErr(res)))
          ) : null
        );
      }

      return React.createElement('div', { className: 'dswi' },
        React.createElement('h2', null, 'DeepSeek Web 对话导入'),

        React.createElement('div', { className: 'dswi-card' },
          React.createElement('h3', null, '① 登录态'),
          React.createElement('div', { className: 'dswi-row' },
            React.createElement('input', { type: 'password', placeholder: '粘贴 userToken（F12 → Application → Local Storage → userToken）', value: token, onChange: function (e) { setToken(e.target.value); }, className: 'dswi-input' }),
            React.createElement('button', { onClick: saveToken }, '保存'),
            React.createElement('button', { onClick: clearToken }, '清除')
          ),
          status ? React.createElement('p', { className: 'dswi-status' }, '状态：' + (status.configured ? '已配置' : '未配置') + (status.writable ? '' : '（只读，可能被环境变量遮蔽）')) : null,
          notice ? React.createElement('p', { className: 'dswi-ok' }, notice) : null,
          React.createElement('p', { className: 'dswi-note' }, '获取方式：浏览器登录 chat.deepseek.com → F12 → Application → Local Storage → 复制 userToken 的值，粘贴到上面并保存（插件会自动提取其中的 value 字段）。')
        ),

        React.createElement('div', { className: 'dswi-card' },
          React.createElement('h3', null, '② 对话目录'),
          React.createElement('button', { onClick: list, disabled: loading }, loading ? '获取中…' : '获取对话目录'),
          error ? React.createElement('p', { className: 'dswi-err' }, error) : null,
          sessions ? React.createElement('div', null,
            sessions.length === 0 ? React.createElement('p', null, '没有对话') :
              React.createElement('div', null,
                React.createElement('p', { className: 'dswi-note' }, '共 ' + sessions.length + ' 条对话（仅目录，正文需点击导入）。导入后会在左侧工作区生成一个 DSH 会话。'),
                sessions.map(renderRow)
              )
          ) : null
        ),

        React.createElement('div', { className: 'dswi-card' },
          React.createElement('button', { onClick: function () { setShowDiag(!showDiag); } }, (showDiag ? '收起' : '展开') + ' 诊断'),
          showDiag ? React.createElement('div', null,
            React.createElement('div', { className: 'dswi-row' },
              React.createElement('input', { placeholder: '接口 URL（用于诊断）', value: probeUrl, onChange: function (e) { setProbeUrl(e.target.value); }, className: 'dswi-input' }),
              React.createElement('button', { onClick: runProbe }, 'GET')
            ),
            probeOut ? React.createElement('pre', { className: 'dswi-pre' }, probeOut) : null
          ) : null
        )
      );
    }

    function apply(ctx) {
      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
        return () => {
          if (styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl);
        };
      }, 'deepseek-web-import: styles');

      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'deepseek-web-import',
        order: 30,
        label: 'DeepSeek 对话导入',
      }, (props) => React.createElement(App, props))), 'deepseek-web-import: settings section');
    }

    module.exports = {
      apply,
      inject: ['slots'],
    };
    //#endregion
    return module.exports;
  },
});
