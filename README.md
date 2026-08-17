# DeepSeek Web 对话导入（DeepSeek Harness 插件）

将 [chat.deepseek.com](https://chat.deepseek.com) 网页端的**历史对话导入为 DeepSeek Harness (DSH) 的正式会话**：导入后会话出现在左侧工作区列表中，**可以打开、查看完整历史，并选择模型继续对话**。

> 本项目是 DSH 的**动态 Cordis 插件**（Host + Client 双半部），不是 npm 包。加载方式见下文「安装」。

---

## ✨ 功能

- 设置面板新增 **「DeepSeek 对话导入」** 页面
- 粘贴 `userToken` 后一键拉取**对话目录**（仅显示标题 + 日期，不展开正文）
- 每条对话可选**目标工作区**，一键**导入为 DSH 会话**
- 导入的会话：
  - 显示 DeepSeek 里的原标题
  - 可在其中**选模型继续对话**（走 DSH 正常 resume 路径，不会报 `cannot prepare session while it is live`）
  - 持久化在 `~/.dsh/sessions/<工作区>/` 下，重启 DSH 后仍在
- 自动提取 `userToken` 中的 `value` 字段（兼容 `{"value":"...","__version":"0"}` 格式）
- 内置「诊断」区，接口变更时可直接 GET 原始响应排查

---

## ⚠️ 重要提示

> **导入对话后请刷新网页**（F5），左侧工作区才会立即显示新导入的会话。
>
> 若不刷新，新会话可能要到下次会话列表刷新/重连后才出现。

---

## 安装

这是一个 **动态 Cordis 插件**（运行在当前 DSH 进程内，定义+激活即可用）。安装步骤：

1. 打开一个 DSH **cordis** 会话，把下面这段提示词发给 agent：

   > 请读取本仓库根目录的 `host.js` 和 `client.js`，分别作为 `code.host` 和 `code.client`，调用 `cordis_define`（`plugin.kind: "new"`，`idPrefix: "dswi"`）定义插件，然后 `cordis_run` 激活它。如果有 Client 审批请求，请批准。

2. 批准后，设置 → 左侧会出现 **「DeepSeek 对话导入」** 页面。

> 说明：动态插件在 DSH 进程重启后需要重新加载（重复上面一步即可）。

---

## 使用

1. 打开 **设置 → DeepSeek 对话导入**。
2. **① 登录态**：粘贴 `userToken` → 保存。
   - 获取：浏览器登录 chat.deepseek.com → `F12` → `Application` → `Local Storage` → 复制 `userToken` 的值。
   - 插件会自动提取其中的 `value` 字段，直接复制整段即可。
3. **② 对话目录**：点「获取对话目录」→ 显示最近 100 条对话（标题 + 日期）。
4. 每条对话旁：**选择工作区** → 点「导入为会话」。
5. **导入对话后请刷新网页**，然后在左侧工作区点开新会话 → 选模型 → 继续对话。

---

## 会话日志损坏（corrupt session log）排查与修复

现象：重启 DSH 后某个会话报

```
Error: corrupt session log: seq gap in committed region at line N (expected X, got Y)
```

（历史加载失败 / resume 失败 / 无法选模型，都是同一个根因。）

**根因**：DSH 的 JSONL 会话日志要求事件 `seq` 从 0 连续递增。触发条件需要**两条同时成立**：
1. `session/end-seed` 由**活动会话（live session）**作为**单独一次 append** 写入日志（DSH 自身的 agent 循环在会话收尾时会这么做）；
2. 下次启动时 DSH 的恢复游标**漏算了这条 end-seed**，于是新写入的第一批事件**复用已提交的 seq**，造成重复 → 提交区截断 → 后面的事件全部读不出来。

**这与本插件无关，而且插件的写法恰好避开了触发**：插件导入的会话把标题 + 全部消息 + `session/end-seed` 作为**同一批** `sessionPersistence.append` 一次性写入持久层，**不经过**活动会话的单独 append，因此「导入 + 重启」不会触发该 bug（已实测：所有导入的会话体检全部 OK，损坏的只有 DSH 自己创建的活动会话）。

> ⚠️ 注意：若你**打开导入的会话继续对话**，后续写入改由 DSH 的活动会话机制负责，就回到与普通会话相同的 DSH bug 风险——这仍是 DSH 自身问题（普通会话同样可能中招），与本插件无关。

**修复**：把重复的那一行（与上一条 seq 相同的事件）删掉即可。删除前先备份
`~/.dsh/sessions/**/session.jsonl.zstd`；删除后要保证 seq 连续，并避免破坏
`agent/inbox/spliced` 的插入/移除配对。本仓库不附带修复脚本（仅保留插件本体）。

---

## 实现原理（简述）

- **接口**（DeepSeek 网页端非官方内部 API，已从官方 JS 包逆向确认）：
  - 会话目录：`GET /api/v0/chat_session/fetch_page?count=100`
  - 对话历史：`GET /api/v0/chat/history_messages?chat_session_id=<uuid>`
- **导入为会话**：把历史消息转换成合法 DSH 会话事件（`turn/start → user/message → step/start → assistant/message → step/end → turn/end`，surface 事件带 `surfaceOp: "append"`，含 `session/title` 与 `session/end-seed`），通过 `sessionPersistence.create + append` **只写持久化**，再 `workspace.attachSession` 挂载到所选工作区 —— **不进入 live store**，因此可以被正常打开/对话。
- **网络层**：`web.fetch` 无法携带自定义 Header，插件通过 `subprocess` 起 Node 发送带 `Authorization: Bearer` 的请求；请求启用了 `rejectUnauthorized: false`（本机 TLS 证书校验失败的环境限制）。
- **Token 存储**：使用 DSH `credentials` 服务（`$DSH_HOME/.credentials.yaml`），不写入会话/设置文档。

---

## 已知限制

- 依赖 DeepSeek **非官方内部接口**，可能随其网页改版失效（失效时用「诊断」区查看原始响应）。
- 密码登录会被 DeepSeek 的**人机验证（AWS WAF）**拦截，必须使用 `userToken` 方式。
- 对话目录一次最多拉取 **100 条**：实测 `fetch_page` 响应仅含 `chat_sessions` + `has_more`，无可用游标字段（`cursor`/`lte_cursor` 参数均不生效），超过 100 条时只返回最新 100 条。
- `userToken` 有时效（约数小时~数天），失效后重新复制保存即可。
- 动态插件仅在当前进程内运行；**重启 DSH 后需重新加载**（按「安装」步骤重复一次）。

---

## 安全提醒

- 请勿在任何对话、Issue、仓库中泄露账号密码或 `userToken`。
- 如曾在聊天中贴出密码，请立即修改 DeepSeek 密码。

---

## License

[MIT](LICENSE)
