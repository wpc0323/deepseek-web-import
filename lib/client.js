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
      searchCatalog: ['搜索对话目录（标题 / 日期）', 'Search conversations (title / date)'],
      searchManaged: ['搜索已导入会话（标题 / 工作区）', 'Search imported sessions (title / workspace)'],
      clearSearch: ['清除搜索', 'Clear search'],
      collapse: ['收起', 'Collapse'],
      expand: ['展开', 'Expand'],
      collapsedCount: ['已收起：{count} / {total} 条', 'Collapsed: {count} of {total}'],
      listSummaryFiltered: ['匹配 {count} / {total} 条对话', '{count} of {total} conversations match'],
      managedSummaryFiltered: ['匹配 {count} / {total} 个已导入会话', '{count} of {total} imported sessions match'],
      noMatches: ['没有匹配「{query}」的条目（共 {total} 条）', 'Nothing matches "{query}" (of {total} entries)'],
      importing: ['导入中…', 'Importing…'],
      imported: ['✓ 已导入会话 {sessionId}（{count} 条消息）', '✓ Imported session {sessionId} ({count} messages)'],
      importedDetail: ['（格式 v{version}，{count} 个事件）', ' (format v{version}, {count} events)'],
      notAttached: ['（未挂载到工作区：{reason}）', ' (not attached to a workspace: {reason})'],
      notAttachedUnknown: ['（未挂载到工作区，原因未知）', ' (not attached to a workspace; reason unknown)'],
      importFailed: ['✗ {message}', '✗ {message}'],
      workspaceListFailed: ['无法读取工作区列表：{message}', 'Could not read the workspace list: {message}'],
      targetWorkspace: ['导入到：', 'Import to:'],
      noWorkspaces: ['（没有工作区）', '(no workspaces)'],
      movePick: ['选择目标…', 'Pick a target…'],
      working: ['处理中…', 'Working…'],
      managedSection: ['③ 已导入的会话', '③ Imported sessions'],
      managedEmpty: ['还没有导入过会话', 'No imported sessions yet'],
      managedSummary: ['共 {count} 个已导入会话。可以移动到别的工作区，或从列表里移除（归档）。', '{count} imported sessions. Move one to another workspace, or remove it from the lists (archive).'],
      managedRefresh: ['刷新列表', 'Refresh'],
      managedWorkspace: ['所在工作区：{title}', 'Workspace: {title}'],
      moveTo: ['移动到：', 'Move to:'],
      moveBtn: ['移动', 'Move'],
      archiveOne: ['归档', 'Archive'],
      archiveConfirm: ['确定把「{title}」从工作区列表中移除吗？\n\n日志仍保留在磁盘上（可恢复），DSH 目前没有提供真正删除会话日志的接口。', 'Remove "{title}" from the workspace lists?\n\nIts log stays on disk (recoverable); DSH currently offers no API that truly deletes a session log.'],
      moveFailed: ['移动失败：{message}', 'Move failed: {message}'],
      archiveFailed: ['归档失败：{message}', 'Archive failed: {message}'],
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
      errSessionQuery: ['会话查询服务不可用', 'The session query service is unavailable'],
      errSessionQueryFailed: ['会话查询失败：{message}', 'The session query failed: {message}'],
      errMissingSession: ['缺少会话 id', 'Missing session id'],
      errNoSuchSession: ['找不到该会话', 'No such session'],
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
        case 'session_query_unavailable': return t('errSessionQuery');
        case 'session_query_failed': return t('errSessionQueryFailed', { message: r.msg || '' });
        case 'missing_session': return t('errMissingSession');
        case 'no_such_session': return t('errNoSuchSession');
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
      '.dswi-target{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--color-text-secondary,#666)}',
      '.dswi-target select{max-width:180px}',
      '.dswi-managed{border-top:1px solid var(--color-border,#eee);margin-top:8px;padding-top:8px}',
      '.dswi-managed-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--color-border,#f0f0f0)}',
      '.dswi-managed-where{font-size:11px;color:var(--color-text-secondary,#888);min-width:110px}',
      '.dswi-danger{color:#c0392b}',
      /* The search field sits beside the load button, so it takes the leftover
         width without squeezing the list controls. */
      '.dswi-search{min-width:180px}',
      /* A collapse toggle rides inline with the card title, small and quiet:
         it is a page-length control, not a primary action. */
      '.dswi-toggle{padding:2px 8px;font-size:11px;font-weight:400;border-radius:10px;background:transparent;color:var(--color-text-secondary,#777);border:1px solid var(--color-border,#ddd);cursor:pointer}',
      '.dswi-toggle:hover{background:var(--color-bg-secondary,#f5f5f5)}',
      '.dswi h3 .dswi-toggle{vertical-align:middle}',
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
      const [managed, setManaged] = React.useState(null);
      const [moveSel, setMoveSel] = React.useState({});
      const [rowBusy, setRowBusy] = React.useState({});
      const [rowMsg, setRowMsg] = React.useState({});
      const [findCatalog, setFindCatalog] = React.useState('');
      const [findManaged, setFindManaged] = React.useState('');
      /* Both lists collapse independently, and the header stays visible while
         collapsed: the point of collapsing is a short page, so the search box and
         the count must still be reachable without expanding again. */
      const [openCatalog, setOpenCatalog] = React.useState(true);
      const [openManaged, setOpenManaged] = React.useState(true);

      React.useEffect(function () {
        (async function () {
          const s = await call('tokenStatus');
          setStatus(s);
          const w = await call('listWorkspaces');
          if (w && w.ok && Array.isArray(w.workspaces)) setWorkspaces(w.workspaces);
          /* A workspace list that cannot be read disables every import control,
             so say why instead of leaving the page looking broken. */
          else setError(t('workspaceListFailed', { message: describeErr(t, w) }));
          /* The managed panel lists already-imported sessions, which needs no
             token — try it on mount so the section is not empty until asked. */
          await loadManaged();
        })();
      }, []);

      /** Render one stored timestamp as a date; bad input shows nothing. */
      function formatTime(value) {
        if (!value) return '';
        try { const n = Number(value); const d = new Date(n > 100000000000 ? n : n * 1000); return d.toISOString().slice(0, 10); } catch (e) { return ''; }
      }

      /**
       * Filter one list by a case-insensitive substring of its visible text.
       *
       * Matching runs over the fields the row actually displays (title, date,
       * and the workspace for managed rows) so a search never hides a row for a
       * reason the user cannot see. An empty query is not a filter.
       */
      function matches(query, fields) {
        const needle = String(query || '').trim().toLowerCase();
        if (needle === '') return true;
        for (const field of fields) {
          if (field === undefined || field === null) continue;
          if (String(field).toLowerCase().includes(needle)) return true;
        }
        return false;
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
        /* A successful import changes the managed panel below it. */
        if (r && r.ok) loadManaged();
      }

      /** Reload the imported-session list (no token needed). */
      async function loadManaged() {
        const r = await call('listImported', {});
        if (r && r.ok && Array.isArray(r.sessions)) setManaged(r);
        else setManaged({ sessions: [], workspaces: workspaces, error: describeErr(t, r) });
      }

      /** Mark one managed row busy and remember its outcome line. */
      function setRow(id, patch) {
        setRowBusy(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[id] = patch.busy; return n; });
        if (patch.message !== undefined) setRowMsg(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[id] = patch.message; return n; });
      }

      /** Move one imported session to another workspace. */
      async function doMove(row) {
        const target = moveSel[row.id];
        if (!target || target === row.workspaceId) return;
        setRow(row.id, { busy: true, message: '' });
        const r = await call('moveSession', { sessionId: row.id, workspaceId: target });
        if (r && r.ok) {
          setRow(row.id, { busy: false, message: '' });
          setMoveSel(function (p) { const n = {}; for (const k in p) n[k] = p[k]; delete n[row.id]; return n; });
          await loadManaged();
        } else {
          setRow(row.id, { busy: false, message: t('moveFailed', { message: describeErr(t, r) }) });
        }
      }

      /** Archive one imported session (hides it; the log stays on disk). */
      async function doArchive(row) {
        const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(t('archiveConfirm', { title: row.title || row.id }))
          : true;
        if (!ok) return;
        setRow(row.id, { busy: true, message: '' });
        const r = await call('archiveSession', { sessionId: row.id });
        if (r && r.ok) {
          setRow(row.id, { busy: false, message: '' });
          await loadManaged();
        } else {
          setRow(row.id, { busy: false, message: t('archiveFailed', { message: describeErr(t, r) }) });
        }
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
          /* The picker is labelled rather than bare: an unlabelled select next
             to "Import as session" reads as part of the conversation row instead
             of as the import target. */
          React.createElement('label', { className: 'dswi-target' },
            t('targetWorkspace'),
            React.createElement('select', {
              value: wid || '',
              disabled: workspaces.length === 0,
              onChange: function (e) { setWsSel(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[s.id] = e.target.value; return n; }); },
            },
              workspaces.length === 0
                ? React.createElement('option', { value: '' }, t('noWorkspaces'))
                : null,
              workspaces.map(function (w) { return React.createElement('option', { key: String(w.id), value: String(w.id) }, w.title); })
            )
          ),
          React.createElement('button', { onClick: function () { doImport(s); }, disabled: !wid }, t('importBtn')),
          res ? React.createElement('span', { className: res.ok === true ? 'dswi-ok' : 'dswi-err' },
            res.state === 'loading' ? t('importing') : importOutcome(res)
          ) : null
        );
      }

      /** One imported session: where it lives, where it can move, and removal. */
      function renderManagedRow(row) {
        const busy = rowBusy[row.id] === true;
        const target = moveSel[row.id] || '';
        /* Every workspace except the one the session already lives in: moving to
           itself is a no-op the backend refuses to call a move. */
        const others = workspaces.filter(function (w) { return String(w.id) !== String(row.workspaceId); });
        return React.createElement('div', { className: 'dswi-managed-row', key: String(row.id) },
          React.createElement('div', { className: 'dswi-title', title: String(row.id) }, row.title || t('untitled')),
          React.createElement('span', { className: 'dswi-managed-where' }, t('managedWorkspace', { title: row.workspaceTitle })),
          React.createElement('label', { className: 'dswi-target' },
            t('moveTo'),
            React.createElement('select', {
              value: target,
              disabled: busy || others.length === 0,
              onChange: function (e) { setMoveSel(function (p) { const n = {}; for (const k in p) n[k] = p[k]; n[row.id] = e.target.value; return n; }); },
            },
              React.createElement('option', { value: '' }, t('movePick')),
              others.map(function (w) { return React.createElement('option', { key: String(w.id), value: String(w.id) }, w.title); })
            )
          ),
          React.createElement('button', { onClick: function () { doMove(row); }, disabled: busy || !target }, busy ? t('working') : t('moveBtn')),
          React.createElement('button', { className: 'dswi-danger', onClick: function () { doArchive(row); }, disabled: busy }, t('archiveOne')),
          rowMsg[row.id] ? React.createElement('span', { className: 'dswi-err' }, rowMsg[row.id]) : null
        );
      }

      /** The third card: everything already imported, with move and archive. */
      function renderManaged() {
        const all = managed && Array.isArray(managed.sessions) ? managed.sessions : [];
        const rows = all.filter(function (row) {
          return matches(findManaged, [row.title, row.workspaceTitle, row.id, formatTime(row.createdAt)]);
        });
        return React.createElement('div', { className: 'dswi-card' },
          React.createElement('h3', null,
            t('managedSection'),
            ' ',
            React.createElement('button', {
              className: 'dswi-toggle',
              onClick: function () { setOpenManaged(!openManaged); },
              title: openManaged ? t('collapse') : t('expand'),
              'aria-expanded': openManaged ? 'true' : 'false',
            }, (openManaged ? '▾ ' : '▸ ') + (openManaged ? t('collapse') : t('expand')))
          ),
          React.createElement('div', { className: 'dswi-row' },
            React.createElement('input', {
              type: 'search',
              className: 'dswi-input dswi-search',
              placeholder: t('searchManaged'),
              value: findManaged,
              onChange: function (e) { setFindManaged(e.target.value); },
            }),
            findManaged.trim() !== ''
              ? React.createElement('button', { onClick: function () { setFindManaged(''); } }, t('clearSearch'))
              : null,
            React.createElement('button', { onClick: loadManaged }, t('managedRefresh'))
          ),
          managed && managed.error ? React.createElement('p', { className: 'dswi-err' }, managed.error) : null,
          /* Collapsed still reports the count: a collapsed section that says
             nothing looks broken rather than folded. */
          !openManaged
            ? React.createElement('p', { className: 'dswi-note' },
                t('collapsedCount', { count: rows.length, total: all.length }))
            : all.length === 0
              ? React.createElement('p', { className: 'dswi-note' }, managed && managed.error ? '' : t('managedEmpty'))
              : rows.length === 0
                ? React.createElement('p', { className: 'dswi-note' }, t('noMatches', { query: findManaged.trim(), total: all.length }))
                : React.createElement('div', { className: 'dswi-managed' },
                    React.createElement('p', { className: 'dswi-note' }, findManaged.trim() === ''
                      ? t('managedSummary', { count: rows.length })
                      : t('managedSummaryFiltered', { count: rows.length, total: all.length })),
                    rows.map(renderManagedRow)
                  )
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
          React.createElement('h3', null,
            t('listSection'),
            ' ',
            React.createElement('button', {
              className: 'dswi-toggle',
              onClick: function () { setOpenCatalog(!openCatalog); },
              title: openCatalog ? t('collapse') : t('expand'),
              'aria-expanded': openCatalog ? 'true' : 'false',
            }, (openCatalog ? '▾ ' : '▸ ') + (openCatalog ? t('collapse') : t('expand')))
          ),
          React.createElement('div', { className: 'dswi-row' },
            React.createElement('button', { onClick: list, disabled: loading }, loading ? t('loadingList') : t('loadList')),
            sessions && sessions.length > 0
              ? React.createElement('input', {
                  type: 'search',
                  className: 'dswi-input dswi-search',
                  placeholder: t('searchCatalog'),
                  value: findCatalog,
                  onChange: function (e) { setFindCatalog(e.target.value); },
                })
              : null,
            findCatalog.trim() !== '' && sessions
              ? React.createElement('button', { onClick: function () { setFindCatalog(''); } }, t('clearSearch'))
              : null
          ),
          error ? React.createElement('p', { className: 'dswi-err' }, error) : null,
          !openCatalog
            ? (sessions
                ? React.createElement('p', { className: 'dswi-note' }, t('collapsedCount', {
                    count: sessions.filter(function (s) { return matches(findCatalog, [s.title, formatTime(s.updatedAt), s.id]); }).length,
                    total: sessions.length,
                  }))
                : null)
            : (sessions ? React.createElement('div', null,
                sessions.length === 0 ? React.createElement('p', null, t('noConversations')) :
                  (function () {
                    const shown = sessions.filter(function (s) {
                      return matches(findCatalog, [s.title, formatTime(s.updatedAt), s.id]);
                    });
                    if (shown.length === 0) {
                      return React.createElement('p', { className: 'dswi-note' },
                        t('noMatches', { query: findCatalog.trim(), total: sessions.length }));
                    }
                    return React.createElement('div', null,
                      React.createElement('p', { className: 'dswi-note' }, findCatalog.trim() === ''
                        ? t('listSummary', { count: shown.length })
                        : t('listSummaryFiltered', { count: shown.length, total: sessions.length })),
                      shown.map(renderRow)
                    );
                  })()
              ) : null)
        ),

        renderManaged(),

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
