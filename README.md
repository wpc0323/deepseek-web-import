# DeepSeek Web 对话导入（DeepSeek Harness 插件）

将 [chat.deepseek.com](https://chat.deepseek.com) 网页端的**历史对话导入为 DeepSeek Harness (DSH) 的正式会话**：导入后会话出现在左侧工作区列表中，**可以打开、查看完整历史，并选择模型继续对话**。

> 本项目是一个**可安装的 DSH 插件包**（`dsh.bundle` manifest：host 半部 + web client 半部），可通过 `dsh plugin add` 安装。安装方式见下文「安装」。

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

插件声明了 `dsh.bundle`（见 `package.json`），可通过 `dsh plugin add` 安装：

```sh
dsh plugin add wpc0323/deepseek-web-import
```

> 说明：安装后**重启 DSH**，设置 → 左侧会出现 **「DeepSeek 对话导入」** 页面。仓库中的 `lib/index.js` 是 host 半部（提供同源 JSON 路由），`lib/client.js` 是 web client 半部（设置页 UI）；二者通过 `webServer` 路由 + `fetch` 通信。

---

## 使用

1. 打开 **设置 → DeepSeek 对话导入**。
2. **① 登录态**：粘贴 `userToken` → 保存。
   - 获取：浏览器登录 chat.deepseek.com → `F12` → `Application` → `Local Storage` → 复制 `userToken` 的值。
   - 插件会自动提取其中的 `value` 字段，直接复制整段即可。
3. **② 对话目录**：点「获取对话目录」→ 显示最近 100 条对话（标题 + 日期）。
4. 每条对话旁：**选择工作区** → 点「导入为会话」。
5. **导入对话后请刷新网页**，然后在左侧工作区点开新会话 → 选模型 → 继续对话。

### 示例

```text
1. 打开设置 → DeepSeek 对话导入
2. 粘贴 userToken → 保存（状态变为「已配置」）
3. 点「获取对话目录」→ 看到你的 DeepSeek 对话列表（标题 + 日期）
4. 在「sharp加载失败解决」那一行选工作区 dsh-work → 点「导入为会话」
5. 刷新网页 → 左侧工作区出现「sharp加载失败解决」→ 点开即可继续对话
```

> 导入只写持久化（`sessionPersistence`），不进入 live store，因此导入的会话可以被正常打开、续聊（不会报 `cannot prepare session while it is live`）。

---

## 会话日志损坏（corrupt session log）排查与修复

这是 **DSH 自身的恢复游标问题**（`session/end-seed` 由活动会话单独 append、重启后游标漏算导致 seq 复用），与本插件无关；插件的导入方式（整批写入）恰好避开了触发。现象、根因、修复方法见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

---

## 实现原理（简述）

- **架构**：`lib/index.js`（host 半部）用 DSH 的 `webServer` 注册同源 JSON 路由（`/__deepseek-web-import/*`）；`lib/client.js`（web client 半部）在设置页通过 `fetch` 调用这些路由——不依赖动态插件机制，`dsh plugin add` 安装后常驻。

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
- 插件通过 `dsh plugin add` 安装为 bundle 插件，安装后常驻（重启 DSH 不受影响）。

---

## 安全提醒

- 请勿在任何对话、Issue、仓库中泄露账号密码或 `userToken`。
- 如曾在聊天中贴出密码，请立即修改 DeepSeek 密码。

---

## License

[MIT](LICENSE)
