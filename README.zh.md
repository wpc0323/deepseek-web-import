# DeepSeek Web 对话导入（DeepSeek Harness 插件）

[English](README.md) | **中文**

将 [chat.deepseek.com](https://chat.deepseek.com) 网页端的**历史对话导入为 DeepSeek Harness (DSH) 的正式会话**：导入后会话出现在左侧工作区列表中，**可以打开、查看完整历史，并选择模型继续对话**。

> 本项目是一个**可安装的 DSH 插件包**（`dsh.bundle` manifest：host 半部 + web client 半部），可通过 `dsh plugin add` 安装。安装方式见下文「安装」。

---

## 界面预览

![「DeepSeek 对话导入」设置页：登录态、对话目录，以及折叠的诊断区](docs/screenshots/settings.png)

---

## ✨ 功能

- 设置面板新增 **「DeepSeek 对话导入」** 页面
- 粘贴 `userToken` 后一键拉取**对话目录**（仅显示标题 + 日期，不展开正文），目录带**搜索框**（标题/日期）与**收起/展开**按钮
- 每条对话可选**目标工作区**（下拉框明确标注「导入到：」），一键**导入为 DSH 会话**
- **③ 已导入的会话**面板：列出所有已导入的会话及其所在工作区，带**搜索框**（标题/工作区）与**收起/展开**按钮，可以
  - **移动**到另一个工作区（`attachSession` + `detachSession`，会话日志不搬家，只改工作区登记）
  - **归档**移出列表（DSH 持久化没有删除接口，归档后日志仍在磁盘、可恢复；有二次确认）
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

**前置条件**：机器上需要有能在 PATH 中执行的 `node`（Node.js）。插件的网络请求放在一个 `node` 子进程里发送（DSH 的 `web.fetch` 带不了自定义 Header）；没有 Node.js 时设置页会直接提示「无法启动 Node.js」及原因，而不是让目录加载莫名失败。

插件声明了 `dsh.bundle`（见 `package.json`），可通过 `dsh plugin add` 安装：

```sh
dsh plugin add deepseek-web-import        # 已发布到 npm
# 或者直接从仓库安装：
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

## 会话打不开 / 日志损坏的排查与修复

见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)，其中记录了两种情况：

- **`corrupt session log: seq gap …`**：DSH 自身的恢复游标问题（`session/end-seed` 由活动会话单独 append、重启后游标漏算导致 seq 复用），与本插件无关；插件的导入方式（整批写入）恰好避开了触发。
- **`format v2 surface before first step …`**（旧版本导入的会话在升级 DSH 后打不开）：插件 0.1.0 写入的事件顺序是 `turn/start → user/message → step/start`，而 DSH 的 v2→v3 迁移要求首个 `step/start` 之前不能有 surface 事件。0.2.x 起已按正确顺序写入，**新导入不受影响**；已经写坏的旧日志可用仓库自带工具修复：

  ```sh
  node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions          # 先干跑，看哪些要修
  node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions --apply  # 备份后原地修复
  ```

---

## 兼容性（DSH Session 格式 v0–v4）

DSH 每个版本写入一种会话格式（v0…v4），插件按运行中的版本自适应，实测矩阵：

| DSH 版本 | Session 格式 | 状态 |
|----------|--------------|------|
| 0.1.0-rc.7 – 0.1.2-rc.1 | v0 | ✅ 真实后端实测 |
| （未发布） | v1 | ✅ 按 v0 建模 + 运行时方言证据 |
| 0.1.3-alpha.2 | v2 | ✅ 真实后端实测 |
| 0.1.5-alpha.1 – 0.1.6-alpha.2 | v3 | ✅ 真实后端实测 |
| 0.1.7-alpha.1+（含桌面版 0.2.0-rc.2） | v4 | ✅ 真实后端实测 |

验证方式与证据出处见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)；`npm test` 跑单测，`sh test/matrix.sh` 跑完整矩阵。

## 实现原理（简述）

- **架构**：`lib/index.js`（host 半部）用 DSH 的 `webServer` 注册同源 JSON 路由（`/__deepseek-web-import/*`）；`lib/client.js`（web client 半部）在设置页通过 `fetch` 调用这些路由——不依赖动态插件机制，`dsh plugin add` 安装后常驻。

- **接口**（DeepSeek 网页端非官方内部 API，已从官方 JS 包逆向确认）：
  - 会话目录：`GET /api/v0/chat_session/fetch_page?count=100`
  - 对话历史：`GET /api/v0/chat/history_messages?chat_session_id=<uuid>`
- **导入为会话**：把历史消息转换成合法 DSH 会话事件（`turn/start → user/message → step/start → assistant/message → step/end → turn/end`，surface 事件带 `surfaceOp: "append"`，含 `session/title` 与 `session/end-seed`），**只写持久化**（v0/v1 走 `create(meta)` + `append(id, events)`，v2+ 走 `create(header)` 返回的写句柄），再 `workspace.attachSession` 挂载到所选工作区 —— **不进入 live store**，因此可以被正常打开/对话。历史以「未回答的用户提问」结尾时保留未闭合的 turn，DSH 打开会话时会自行补 `interrupted` 收尾。
- **正文与思维链**：DeepSeek 的正文在 `fragments`（`REQUEST`/`RESPONSE`/`THINK`），用户提问取 `REQUEST`，助手回答取 `RESPONSE` 作正文、`THINK` 作 `reasoning` 块；事件时间取消息的 `inserted_at`。
- **网络层**：`web.fetch` 无法携带自定义 Header，插件通过 `subprocess` 起 Node 发送带 `Authorization: Bearer` 的请求；请求 spec（含该 Header）走子进程 **stdin**，不出现在 `ps`/`/proc`。响应**先校验证书**，只有在证书类错误（被中间人/杀软 TLS 拦截的环境）时才重试一次不校验并标记 `insecureTls`（DSH 日志会记一行，诊断区可看到），不会静默降级。子进程对流式读到的响应同时设字符上限（约 2M 字符）与字节上限（6MB），超限即停止读取并报 `too_large`，不会把大响应整个缓冲进内存。
- **界面语言**：设置页文案注册到宿主 locale 命名空间（`ctx.locale`），跟随 DSH/浏览器语言，未注册的语言（如德语）回落到英文；宿主没有 locale 服务时按浏览器语言自行判断。
- **Token 存储**：使用 DSH `credentials` 服务（`$DSH_HOME/.credentials.yaml`），不写入会话/设置文档。

---

## 已知限制

- 依赖 DeepSeek **非官方内部接口**，可能随其网页改版失效（失效时用「诊断」区查看原始响应）。
- 密码登录会被 DeepSeek 的**人机验证（AWS WAF）**拦截，必须使用 `userToken` 方式。
- 对话目录一次最多拉取 **100 条**：实测 `fetch_page` 响应仅含 `chat_sessions` + `has_more`，无可用游标字段（`cursor`/`lte_cursor` 参数均不生效），超过 100 条时只返回最新 100 条。
- `userToken` 有时效（约数小时~数天），失效后重新复制保存即可。
- 插件通过 `dsh plugin add` 安装为 bundle 插件，安装后常驻（重启 DSH 不受影响）。
- 联网检索步骤（`TOOL_SEARCH`/`TOOL_OPEN` fragment）与消息状态（如生成中被中断的 `INCOMPLETE`）不会保留：网页搜索在 DSH 里没有对应事件，导入时只取正文与思维链；被中断的回答只保留已有的正文/思维链内容。
- 同一段 DeepSeek 对话重复导入会生成**两个** DSH 会话（插件不记录「DeepSeek 对话 id → DSH 会话 id」映射），DSH 的持久化接口也不提供删除，重复导入后需要自行在工作区里归档。

---

- 单次导入的响应上限约 **2M 字符**（超长对话返回 `too_large`，而不是静默截断）。
- 只有附件、没有文字的消息会导入为一句明确说明；`SYSTEM`/`TOOL` 等非对话角色会被忽略。
- 导入按 `history_messages` 返回的单条主线顺序进行（不解析 `parent_id` 分支）：若 DeepSeek 针对「编辑/重新生成」返回兄弟分支，会被当作先后两轮导入。

## 安全提醒

- 请勿在任何对话、Issue、仓库中泄露账号密码或 `userToken`。
- 如曾在聊天中贴出密码，请立即修改 DeepSeek 密码。

---

## License

[MIT](LICENSE)
