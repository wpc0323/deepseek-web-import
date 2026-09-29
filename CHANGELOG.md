# Changelog

## Unreleased

修复导入链路，并按运行中的 DSH 版本自适应写入 Session 格式 v0–v4。

### 修复

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

### 新增

- `test/`：59 个单测（翻译层 + 传输层 + 8 条路由及其错误路径）、真实后端兼容矩阵（v0/v2/v3/v4）、
  跨代读取测试（旧版本写、新版本读）与离线端到端导入测试。
- `docs/COMPATIBILITY.md`：各代差异的证据、跨代迁移约束与验证命令。
- `.github/workflows/ci.yml`：push/PR 跑单测，手动触发跑完整矩阵。

## 0.1.0 (2026-08-17)

- Initial release as an installable DSH plugin bundle (`dsh.bundle` + `dsh.client`).
- Settings-page UI ("DeepSeek 对话导入"): paste `userToken`, list the chat.deepseek.com conversation directory (title + date, most recent 100), and import a chosen conversation into a chosen workspace as a durable, resumable DSH session.
- Imported sessions: DeepSeek title preserved, openable and resumable in DSH (does not enter the live store, so it can be resumed and continued).
- Empty-conversation guard and attach-failure reporting (`attached: false` instead of a false "import failed").
- Same-origin JSON routes served by the host half; the browser half calls them with `fetch`.
- Diagnostic route restricted to chat.deepseek.com URLs.
