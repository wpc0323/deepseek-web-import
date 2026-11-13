// deepseek-web-import — browser half (client plugin module).
//
// Adds a "DeepSeek Chat Import" page to the DSH Web settings panel
// (`settings.section`, id `deepseek-web-import`). It talks to the host half
// through same-origin JSON routes (`/__deepseek-web-import/*`, see
// `../lib/index.js`): save/clear the DeepSeek userToken, list the
// conversation directory, and import a chosen conversation into a chosen
// workspace as a durable DSH session.
//
// Copy is localized: every visible string comes from `MESSAGES` (Chinese and
// English), registered into the Host locale namespace when the composition
// provides `ctx.locale`, so the page follows the Host/browser language and
// falls back to English (`en` is the locale registry's own fallback). Without
// the locale service the module resolves the browser language itself.
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

    /** Locale namespace this plugin registers its dictionaries under. */
    const NS = 'deepseek-web-import';

    /**
     * Every visible string, as `key: [zh, en]`.
     *
     * One table for both languages (rather than two dictionaries) so the key
     * sets cannot drift apart; `{name}` placeholders are filled by the locale
     * registry's own `t(key, params)`.
     */
    const MESSAGES = {
      nav: ['DeepSeek 对话导入', 'DeepSeek Chat Import'],
      authSection: ['① 登录态', '① Sign-in'],
      tokenPlaceholder: [
        '粘贴 userToken（F12 → Application → Local Storage → userToken）',
        'Paste your userToken (F12 → Application → Local Storage → userToken)',
      ],
      save: ['保存', 'Save'],
      clear: ['清除', 'Clear'],
      statusLine: ['状态：{state}{note}', 'Status: {state}{note}'],
      stateConfigured: ['已配置', 'configured'],
      stateUnconfigured: ['未配置', 'not configured'],
      readonlyNote: ['（只读，可能被环境变量遮蔽）', ' (read-only; possibly shadowed by an environment variable)'],
      tokenSaved: ['Token 已保存', 'Token saved'],
      tokenSavedNormalized: ['Token 已保存（已自动提取 value 字段）', 'Token saved (the value field was extracted automatically)'],
      saveFailed: ['保存失败', 'Save failed'],
      tokenCleared: ['Token 已清除', 'Token cleared'],
      tokenClearFailed: ['Token 清除失败：{message}', 'Clearing the token failed: {message}'],
      howToNote: [
        '获取方式：浏览器登录 chat.deepseek.com → F12 → Application → Local Storage → 复制 userToken 的值，粘贴到上面并保存（插件会自动提取其中的 value 字段）。',
        'How to get it: sign in to chat.deepseek.com in your browser → F12 → Application → Local Storage → copy the userToken value, paste it above and save (the value field is extracted automatically).',
      ],
      listSection: ['② 对话目录', '② Conversation directory'],
      loadList: ['获取对话目录', 'Load conversations'],
      loadingList: ['获取中…', 'Loading…'],
      noConversations: ['没有对话', 'No conversations'],
      untitled: ['（无标题）', '(untitled)'],
      listSummary: [
        '共 {count} 条对话（仅目录，正文需点击导入）。导入后会在左侧工作区生成一个 DSH 会话。',
        '{count} conversations (directory only; the transcript is fetched on import). An import creates a DSH session in the sidebar workspace.',
      ],
      importBtn: ['导入为会话', 'Import as session'],
      importing: ['导入中…', 'Importing…'],
      imported: ['✓ 已导入会话 {sessionId}（{count} 条消息）', '✓ Imported session {sessionId} ({count} messages)'],
      importedDetail: ['（格式 v{version}，{count} 个事件）', ' (format v{version}, {count} events)'],
      notAttached: ['（未挂载到工作区：{reason}）', ' (not attached to a workspace: {reason})'],
      notAttachedUnknown: ['（未挂载到工作区，原因未知）', ' (not attached to a workspace; reason unknown)'],
      importFailed: ['✗ {message}', '✗ {message}'],
      workspaceListFailed: ['无法读取工作区列表：{message}', 'Could not read the workspace list: {message}'],
      diagnostics: ['诊断', 'Diagnostics'],
      diagShow: ['展开', 'Show'],
      diagHide: ['收起', 'Hide'],
      probePlaceholder: ['接口 URL（用于诊断）', 'API URL (diagnostics)'],
      unknownError: ['未知错误', 'Unknown error'],
      errNoToken: ['尚未保存 userToken', 'No userToken has been saved yet'],
      errTokenEmpty: ['请先粘贴 userToken', 'Paste a userToken first'],
      errApi: ['DeepSeek 接口错误 (code {code})：{msg}', 'DeepSeek API error (code {code}): {msg}'],
      errNotJson: ['响应非 JSON（可能 Token 无效或接口变更），HTTP {status}', 'Response is not JSON (the token may be invalid, or the API changed), HTTP {status}'],
      errTooLarge: ['该对话太长，超出单次导入上限', 'That conversation is too long for a single import'],
      errEmptyHistory: ['该对话没有可导入的消息', 'That conversation has no importable messages'],
      errNoWorkspace: ['未找到工作区', 'No workspace found'],
      errPersist: ['会话写入失败：{message}', 'Writing the session failed: {message}'],
      errVerify: ['会话已写入，但当前 DSH 版本无法读回：{message}', 'The session was written but this DSH build cannot read it back: {message}'],
      errTransport: ['网络请求失败：{message}', 'The network request failed: {message}'],
      errParse: ['接口返回无法解析：{message}', 'The API response could not be parsed: {message}'],
      errProbe: ['探测被拒绝：{message}', 'The probe was refused: {message}'],
      errSaveFailed: ['token 操作失败（详见 DSH 日志）', 'The token operation failed (see the DSH log)'],
      errCredentials: ['凭据服务不可用', 'The credential service is unavailable'],
      errPersistence: ['会话持久化服务不可用', 'The session-persistence service is unavailable'],
      errWorkspaceRegistry: ['工作区注册表不可用', 'The workspace registry is unavailable'],
      errSubprocess: ['子进程服务不可用', 'The subprocess service is unavailable'],
      errNodeMissing: [
        '无法启动 Node.js：本插件通过网络子进程（node）发送带 userToken 的请求，请先安装 Node.js 并确保 `node` 在 PATH 中可执行，然后重启 DSH。{detail}',
        'Could not start Node.js: the plugin sends the request (with your userToken) through a node child process, so install Node.js and make sure `node` runs from PATH, then restart DSH. {detail}',
      ],
      errHttp: ['HTTP {status}：{message}', 'HTTP {status}: {message}'],
    };

    /** One language's dictionary, in the registry's `key -> template` shape. */
    function dictFor(index) {
      const dict = {};
      for (const key of Object.keys(MESSAGES)) dict[key] = MESSAGES[key][index];
      return dict;
    }

    const DICT_ZH = dictFor(0);
    const DICT_EN = dictFor(1);

    /** Fill `{name}` placeholders; unknown placeholders stay literal. */
    function fill(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      });
    }

    /** Browser language reduced to its primary subtag (`zh-CN` -> `zh`). */
    function browserLanguage() {
      try {
        const raw = (typeof navigator !== 'undefined' && (navigator.language || (navigator.languages || [])[0])) || '';
        return String(raw).toLowerCase().split('-')[0];
      } catch (error) {
        return '';
      }
    }

    /**
     * Stand-in translator for compositions without `ctx.locale`: the browser
     * language first, then English — the same fallback the locale registry
     * applies, so behavior matches whichever way the page is served.
     */
    function t(key, params) {
      const prefer = browserLanguage() === 'zh' ? DICT_ZH : DICT_EN;
      const template = prefer[key] !== undefined ? prefer[key] : (DICT_EN[key] !== undefined ? DICT_EN[key] : undefined);
      return template === undefined ? key : fill(template, params);
    }

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

    /**
     * Localized text for one host failure.
     *
     * Known codes get their own localized copy; anything else (including a code
     * the host phrased as a sentence) falls back to the host's own message so a
     * new failure is never hidden.
     */
    function describeErr(t, r) {
      if (!r) return t('unknownError');
      const raw = r.msg !== undefined ? r.msg : (r.message !== undefined ? r.message : r.error);
      switch (r.error) {
        case 'no_token': return t('errNoToken');
        case 'api': return t('errApi', { code: r.code, msg: r.msg || '' });
        case 'not_json': return t('errNotJson', { status: r.status });
        case 'too_large': return t('errTooLarge');
        case 'empty_history': return t('errEmptyHistory');
        case 'no_workspace': return t('errNoWorkspace');
        case 'persist': return t('errPersist', { message: raw || '' });
        case 'verify': return t('errVerify', { message: raw || '' });
        case 'transport': return t('errTransport', { message: r.msg || '' });
        case 'parse': return t('errParse', { message: r.raw || '' });
        case 'save_failed': return t('errSaveFailed');
        case 'token_empty': return t('errTokenEmpty');
        case 'probe_refused': return t('errProbe', { message: r.msg || '' });
        case 'credentials_unavailable': return t('errCredentials');
        case 'persistence_unavailable': return t('errPersistence');
        case 'workspace_registry_unavailable': return t('errWorkspaceRegistry');
        case 'subprocess_unavailable': return t('errSubprocess');
        case 'node_unavailable': return t('errNodeMissing', { detail: r.msg || '' });
        default: break;
      }
      if (r.status !== undefined && r.status !== 200 && typeof r.error === 'string') {
        return t('errHttp', { status: r.status, message: r.error });
      }
      return String(raw === undefined || raw === null || raw === '' ? t('unknownError') : raw) + (r.raw ? ' —— ' + r.raw : '');
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
      const t = props.t;
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
          /* A workspace list that cannot be read disables every import control,
             so say why instead of leaving the page looking broken. */
          else setError(t('workspaceListFailed', { message: describeErr(t, w) }));
        })();
      }, []);

      /** Render one stored timestamp as a date; bad input shows nothing. */
      function formatTime(value) {
        if (!value) return '';
        try { const n = Number(value); const d = new Date(n > 100000000000 ? n : n * 1000); return d.toISOString().slice(0, 10); } catch (e) { return ''; }
      }

      async function saveToken() {
        setError(''); setNotice('');
        const r = await call('saveToken', { token: token });
        if (r && r.ok) { setNotice(r.normalized ? t('tokenSavedNormalized') : t('tokenSaved')); setStatus(await call('tokenStatus')); }
        else setError(r && r.error ? describeErr(t, r) : t('saveFailed'));
      }
      async function clearToken() {
        setError(''); setNotice('');
        const r = await call('clearToken');
        setStatus(await call('tokenStatus'));
        /* Report a refused clear rather than claiming success: the credential
           store can refuse (read-only file, foreign value). */
        if (r && r.ok) { setToken(''); setNotice(t('tokenCleared')); }
        else setError(t('tokenClearFailed', { message: describeErr(t, r) }));
      }
      async function list() {
        setLoading(true); setError(''); setSessions(null);
        if (token.trim()) {
          const s = await call('saveToken', { token: token });
          if (s && s.ok) { setStatus(await call('tokenStatus')); }
          else { setLoading(false); setError(describeErr(t, s)); return; }
        }
        const r = await call('listSessions');
        setLoading(false);
        if (r && r.ok) setSessions(r.sessions);
        else setError(describeErr(t, r));
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

      /** One-line localized outcome for an import attempt. */
      function importOutcome(res) {
        if (res.ok !== true) return t('importFailed', { message: describeErr(t, res) });
        let text = t('imported', { sessionId: res.sessionId, count: res.messageCount });
        if (res.sessionFormatVersion !== undefined) {
          text += t('importedDetail', { version: res.sessionFormatVersion, count: res.eventCount });
        }
        if (res.attached === false) {
          text += res.attachError ? t('notAttached', { reason: res.attachError }) : t('notAttachedUnknown');
        }
        return text;
      }

      function renderRow(s) {
        const wid = wsSel[s.id] || (workspaces.length ? workspaces[0].id : null);
        const res = results[s.id];
        return React.createElement('div', { className: 'dswi-row', key: s.id },
          React.createElement('div', { className: 'dswi-title', title: String(s.id) }, (s.title || t('untitled')) + (s.updatedAt ? ' (' + formatTime(s.updatedAt) + ')' : '')),
          React.createElement('select', { value: wid || '', onChange: function (e) { setWsSel(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[s.id] = e.target.value; return n; }); } },
            workspaces.map(function (w) { return React.createElement('option', { key: String(w.id), value: String(w.id) }, w.title); })
          ),
          React.createElement('button', { onClick: function () { doImport(s); }, disabled: !wid }, t('importBtn')),
          res ? React.createElement('span', { className: res.ok === true ? 'dswi-ok' : 'dswi-err' },
            res.state === 'loading' ? t('importing') : importOutcome(res)
          ) : null
        );
      }

      return React.createElement('div', { className: 'dswi' },
        React.createElement('h2', null, t('nav')),

        React.createElement('div', { className: 'dswi-card' },
          React.createElement('h3', null, t('authSection')),
          React.createElement('div', { className: 'dswi-row' },
            React.createElement('input', { type: 'password', placeholder: t('tokenPlaceholder'), value: token, onChange: function (e) { setToken(e.target.value); }, className: 'dswi-input' }),
            React.createElement('button', { onClick: saveToken }, t('save')),
            React.createElement('button', { onClick: clearToken }, t('clear'))
          ),
          status ? React.createElement('p', { className: 'dswi-status' }, t('statusLine', {
            state: status.configured ? t('stateConfigured') : t('stateUnconfigured'),
            note: status.writable ? '' : t('readonlyNote'),
          })) : null,
          notice ? React.createElement('p', { className: 'dswi-ok' }, notice) : null,
          React.createElement('p', { className: 'dswi-note' }, t('howToNote'))
        ),

        React.createElement('div', { className: 'dswi-card' },
          React.createElement('h3', null, t('listSection')),
          React.createElement('button', { onClick: list, disabled: loading }, loading ? t('loadingList') : t('loadList')),
          error ? React.createElement('p', { className: 'dswi-err' }, error) : null,
          sessions ? React.createElement('div', null,
            sessions.length === 0 ? React.createElement('p', null, t('noConversations')) :
              React.createElement('div', null,
                React.createElement('p', { className: 'dswi-note' }, t('listSummary', { count: sessions.length })),
                sessions.map(renderRow)
              )
          ) : null
        ),

        React.createElement('div', { className: 'dswi-card' },
          React.createElement('button', { onClick: function () { setShowDiag(!showDiag); } }, (showDiag ? t('diagHide') : t('diagShow')) + ' ' + t('diagnostics')),
          showDiag ? React.createElement('div', null,
            React.createElement('div', { className: 'dswi-row' },
              React.createElement('input', { placeholder: t('probePlaceholder'), value: probeUrl, onChange: function (e) { setProbeUrl(e.target.value); }, className: 'dswi-input' }),
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

      /* Prefer the Host locale registry: it owns the preference, and its own
         fallback chain ends at English, which is what an unregistered language
         (German, say) must read. Without it, resolve the browser language. */
      const locale = ctx.get('locale');
      let translate = t;
      if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(() => locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'deepseek-web-import: dictionaries');
        translate = locale.bind(NS);
      }

      const slots = ctx.get('slots');
      if (slots === undefined) return;

      /* The settings shell keeps registrant-localized labels rather than
         subscribing the locale itself, so a language switch re-registers this
         section (documented pattern; `label` stays a function as well). */
      let registered = null;
      const mount = () => {
        if (registered !== null) { registered(); registered = null; }
        registered = slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'deepseek-web-import',
          order: 30,
          label: () => translate('nav'),
        }, (props) => React.createElement(App, Object.assign({}, props, { t: translate }))));
      };

      ctx.effect(() => {
        mount();
        return () => { if (registered !== null) { registered(); registered = null; } };
      }, 'deepseek-web-import: settings section');

      /* Re-register on a language switch so labels and copy follow it; a
         composition without the event still renders in the active language. */
      if (typeof ctx.on === 'function') ctx.on('locale/change', mount);
    }

    module.exports = {
      apply,
      /* `locale` is a dependency of the copy, not an optional extra: a client
         plugin only sees a service its `inject` names, so declaring it here is
         what makes `ctx.get('locale')` resolve at all. Without it the page
         silently fell back to the browser language and ignored the Host's
         language setting. */
      inject: ['slots', 'locale'],
      /* Exposed for the offline i18n test (key parity, placeholder parity). */
      __messages: MESSAGES,
    };
    //#endregion
    return module.exports;
  },
});
