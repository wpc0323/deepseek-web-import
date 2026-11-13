# Changelog

## 0.2.2 (2026-11-13)

### 修复

- **界面语言没跟随 DSH 设置**（多语言在 0.2.0 引入，但一直不生效）：客户端插件只能使用它自己 `inject` 里声明的服务，
  而我们的 `module.exports.inject` 只写了 `'slots'`，于是 `ctx.get('locale')` 恒为 `undefined`，界面一直回落到
  浏览器语言（中文），即使 DSH 外壳已经切成英文。现在 `inject` 声明 `['slots', 'locale']`，并在
  `package.json` 的 `dsh.client.inject` 里声明 `@deepseek-ai/dsh-client-locale`，保证语言服务先于本插件加载。
- 新增两条测试锁住该约束：`inject` 必须包含 `locale`；`apply()` 在 locale 服务存在时确实走宿主语言
  （用假 locale/slots/document 验证分区标签取英文而非浏览器语言）。

## Unreleased

### 插件市场展示（文档与素材，无运行时改动）

- 新增 `screenshots.json`（仓库根目录、`package.json` 旁边）与 `docs/screenshots/settings.png`：这是 awesome-dsh-plugin
  catalog 的新约定——作者把截图放在自己仓库里，catalog 的 `probe-screenshots.mjs` 下一次构建自动读取，**不需要给
  catalog 仓库提 PR**。中英 README 增加「界面预览 / Screenshots」段。
- 说明下载量的来源：catalog 的 `downloads` 字段来自 npm 的 30 天滚动下载量，只有发布到 npm 的插件才有；
  本包暂未发布，所以市场卡片上没有数字。
- **已发布到 npm**（`deepseek-web-import@0.2.1`）：`npmjs.com` 的 metadata 里 `repository` 指回本仓库，
  满足 catalog `probe-npm.mjs` 的关联判定；中英 README 的安装段因此补上 `dsh plugin add deepseek-web-import`。
  catalog 下一次 probe 会建立 npm 映射，下载量要等 npm 有统计后（实际安装后 T+1）才会出现。

### 修复历史遗留会话（文档与工具，无运行时改动）

- 新增 `tools/fix-surface-before-step.mjs`：修复 0.1.0 版本导入、在升级到 v3+ DSH 后打不开的会话。
  这些日志写成 `turn/start → user/message → step/start`，而 DSH 的 v2→v3 迁移要求首个 `step/start` 之前
  不能有 surface 事件。工具默认干跑（只报告），`--apply` 先备份再原地修复（只把开头的 surface 事件挪到
  首个 `step/start` 之后、只交换该窗口内 `seq` 值，`seq0` 行原样保留），`--verify` 再用真实
  `@deepseek-ai/dsh-session-persistence-jsonl` 逐个复开验证。0.2.x 导入的会话不受影响。
- `docs/TROUBLESHOOTING.md` 新增该故障的现象、根因、影响范围与两条修复路径；中英 README 指向该节。
- 新增 `test/repair-tool.test.mjs`（10 个用例）覆盖重排、`seq` 窗口交换、`seq0` 行不被改动、幂等与磁盘往返；
  CI 的语法检查覆盖 `tools/*.mjs`。

## 0.2.1 (2026-10-20)

### 修复

- **缺少 Node.js 时不再报 `internal error`**（issue #5）：请求通过 `node` 子进程发送，机器上没有 Node.js 时子进程根本起不来，
  而这条失败原先只能被路由报成 500 `internal error`。现在发请求前先用 `subprocess.resolveExecutable('node')` 解析可执行文件，
  spawn 抛错、子进程因 `ENOENT` 直接退出也都归为同一类失败，统一返回稳定的 `node_unavailable`，并保留底层原因
  （如 `command "node" was not found on PATH`）。
- 设置页对该错误给出中英文明示：「无法启动 Node.js：本插件通过网络子进程（node）发送带 userToken 的请求，
  请先安装 Node.js 并确保 `node` 在 PATH 中可执行，然后重启 DSH」，不再是没头没尾的失败。
- README（中/英）在「安装」处补充前置条件：需要可用的 Node.js（PATH 可解析）。

## 0.2.0 (2026-10-14)

### 第二轮：i18n 与审阅修正

#### 新增

- **界面多语言**（issue #1）：设置页全部文案（标题、说明、状态、错误、按钮、诊断）改为词典表 `key → [zh, en]`，
  注册进宿主 locale 命名空间（`ctx.locale`），跟随 DSH/浏览器语言；未注册的语言回落到英文；宿主没有 locale
  服务时按浏览器语言自行判断。切换语言时重新注册设置页，标签与内容即时更新。
- 失败响应统一携带**稳定错误码**（`save_failed`/`probe_refused`/`credentials_unavailable`/`persistence_unavailable`/
  `workspace_registry_unavailable`/`subprocess_unavailable`/`token_empty` 等），由前端本地化；未知 code 仍显示后端原文。
- 失败响应新增 `sessionId`：写入失败时也能知道创建了哪个会话（持久化接口没有删除，便于人工清理）。
- `test/i18n.test.mjs` 与真实 `node:http` 的请求体/方法用例（413、400、405）；单测总数 95（`npm test` 现在自动跑全部 `test/*.test.mjs`，CI 同步）。
- README 按 DSH 生态约定拆成**英文主文件** `README.md` + 中文 `README.zh.md`（两份都有语言切换行，均随插件包一起分发）。

#### 修复

- **413 现在真的能送达**：请求体超限时原先 `req.destroy()` 会连带销毁 socket，浏览器看到的是连接重置而非 413；
  改为排空请求体后回 413（`Connection: close`）。原来的测试把 `req.destroy()` 伪造成空函数，因此测不出真实行为。
- **路由处理器返回 promise**：`handlerFor` 之前返回 `undefined`，路由内的 rejection 无法进入 DSH 的错误日志与 400 兜底，
  而是变成 unhandled rejection；同时给 req/res 挂 `error` 监听（调用方中途断开不再升级为未处理异常）。
- **凭据服务的报错在写入日志前抹掉 token**：该报错可能内嵌被拒绝的值，而 README 恰恰鼓励贴日志报障。
- **probe 收紧到默认端口**：`https://chat.deepseek.com:8443/…` 之前会放行，现在只接受默认端口（或省略端口）。
- **目录接口检查截断**：响应被截断时返回 `too_large`，不再表现为「响应非 JSON（可能 Token 无效）」。
- **标题兜底恢复**：目录侧不再把无标题会话写成 `(无标题)`（前端另有本地化显示），否则会挤掉 `dsh-session-title` 的兜底标题。
- **版本首猜取已存会话的最大版本**：`list()` 不保证顺序，而同一 profile 可能同时存在多代会话（v0 与 v4 混存是真实情况），
  按列表第一条猜会猜错并白白浪费一次拒绝重试。
- **拒绝文案多模式匹配**：除 `requires Session format vN` 外，同时匹配 `header version must be N`、`reads only vN`、
  `format version must be N`（大小写不敏感），避免换一个构建就退化成硬失败。
- **只有思维链的回答也补正文块**：判断条件从「有没有块」改为「有没有 text 块」——思考中被中断的回答此前会渲染成空回合。
- **传输层流式限流**：字符上限只是事后切片，子进程仍会整体缓冲响应；现在同时设字节上限（6MB），超限即停止读取并报 `too_large`。
- **TLS 先校验、只在证书错误时降级**：原先对每个携带 userToken 的请求都无条件 `rejectUnauthorized: false`；
  现在先正常校验，仅在证书类错误时重试一次并标记 `insecureTls`（日志留痕），不再是静默的全量降级。
- **路由归属改为代际记账**：释放权判定不再依赖 `webServer.exact` 这一内部字段（未来改名也不会 fail-open 误删新实例路由）；
  驱逐旧实例路由时留日志；挂载中途失败时把已驱逐的旧路由**恢复**（此前会留下无人服务的路径且无任何报错）。
- 文档数字修正（单测数量、"21 events"、v0/v3/v4 版本区间），并补「已知限制」：检索步骤与消息状态不保留、重复导入会生成两个会话。

### 首轮：Session 格式 v0–v4

修复导入链路，并按运行中的 DSH 版本自适应写入 Session 格式 v0–v4。

#### 修复

- 会话头版本原先写死为 `0`，在 0.1.5-alpha.1+（v3）与 0.1.7-alpha.1+（v4）上导入直接失败（`encodeCurrent requires Session format v3`）；
  现在先从已存会话读取版本，再按后端拒绝时报出的版本自动重试。
- 持久化接口按代次自动选择：v0/v1 的服务级 `create(meta)` + `append(id, events)`，v2+ 的句柄式 `create(header)` + `append/flush/close`。
- 消息正文取自 `fragments`（`REQUEST`/`RESPONSE`/`THINK`）而不是空的 `content` 字段；思维链导入为 `reasoning` 块，时间取 `inserted_at`（缺失/乱序/离谱时按缺失处理，不会把 2023 年的对话标到导入时刻）。
- **事件顺序**：`turn/start → step/start → user/message`。v2→v3 迁移在第一个 `step/start` 处插入 system 头，
  因此「首个 step 之前有 surface 事件」的 v0/v2 日志会被 v3+ 构建拒绝 —— 在旧版本导入的会话升级后会打不开。
- **写入后读回校验**：后端写入不校验事件词表，读不回来时不再报成功（返回 `verify` 失败）。
- 超长对话不再被静默截断成「响应非 JSON（可能 Token 无效）」，而是返回明确的 `too_large`；请求体超限返回 413、非法 JSON 返回 400。
- 路由注册可重入并在 fiber 销毁时释放：只回收本插件上一实例的路由，旧实例销毁不会误删新实例的路由，挂载中途失败会释放已注册的路由；插件重载不再报 `webserver: duplicate exact route`。
- 非 `USER`/`ASSISTANT` 行不再被拼成助手回复；没有可翻译回合时返回 `empty_history`，不写入空会话；只有附件的消息写明确说明。
- 标题按 `dsh-session-title` 的语义归一（去转义/控制字符、折成一行、UTF-8 字节上限）。
- 安全性：请求 spec（含 `Authorization`）改走子进程 stdin（不再出现在 `ps`/`/proc`）；`probe` 只允许 `https://chat.deepseek.com` 且忽略调用方自带的 `Authorization`；上游原文截断并把 token 抹成 `[token]`；凭据服务报错只进日志。

#### 新增

- `test/`：59 个单测（翻译层 + 传输层 + 8 条路由及其错误路径）、真实后端兼容矩阵（v0/v2/v3/v4）、
  跨代读取测试（旧版本写、新版本读）与离线端到端导入测试。- `docs/COMPATIBILITY.md`：各代差异的证据、跨代迁移约束与验证命令。
- `.github/workflows/ci.yml`：push/PR 跑单测，手动触发跑完整矩阵。

## 0.1.0 (2026-08-17)

- Initial release as an installable DSH plugin bundle (`dsh.bundle` + `dsh.client`).
- Settings-page UI ("DeepSeek 对话导入"): paste `userToken`, list the chat.deepseek.com conversation directory (title + date, most recent 100), and import a chosen conversation into a chosen workspace as a durable, resumable DSH session.
- Imported sessions: DeepSeek title preserved, openable and resumable in DSH (does not enter the live store, so it can be resumed and continued).
- Empty-conversation guard and attach-failure reporting (`attached: false` instead of a false "import failed").
- Same-origin JSON routes served by the host half; the browser half calls them with `fetch`.
- Diagnostic route restricted to chat.deepseek.com URLs.
