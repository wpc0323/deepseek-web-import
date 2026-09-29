# 兼容矩阵与验证证据

本插件写的是 **DSH 会话日志（session log）**，而日志的**格式版本随 DSH 版本变化**：
运行中的构建写哪一代，插件就必须写哪一代的头部与事件字段。这里记录每一代差异的
证据来源，以及可复现的验证命令。

## 各代差异（对照已发布包逐条核对）

| 格式 | 由哪些版本写入 | Session 头 | `assistant/message` | `sessionPersistence` 接口 |
|------|----------------|-----------|---------------------|---------------------------|
| v0 | 0.1.1-rc.1 … 0.1.2-rc.1 | `version,id,createdAt,cwd,seedLength?`（**没有 `isSeeded`**） | 没有 `stream` 字段 | 旧式：`create(meta): Promise<void>` + `append(id, events)` |
| v1 | 未发现发布版本写入 v1 | 按 v0 建模，运行时再按证据修正¹ | 没有 `stream` | 旧式 |
| v2 | 0.1.3-alpha.2 | `…,isSeeded`（显式拒绝 `seedLength`） | `stream` 必填 | 句柄式：`create(header) → SessionHandle`、`open/flush/stat/list` |
| v3 | 0.1.5-alpha.1 … 0.1.6-alpha.2 | 同 v2 | `stream` 必填 | 句柄式 |
| v4 | 0.1.7-alpha.1+ | 同 v2，且 `delegationDepth` **必填** | `stream` 必填 | 句柄式 |

证据位置（对已发布包 `npm pack` 后查看）：

- `@deepseek-ai/dsh-session` 的 `SESSION_FORMAT_VERSION` 常量：
  - `0.1.1-rc.2` → 0，`0.1.2-alpha.5` → 0，`0.1.2-rc.1` → 0，`0.1.3-alpha.2` → 2，`0.1.5-alpha.1` → 3，`0.1.6-alpha.2` → 3，`0.1.7-alpha.1` → 4
- v0 头部：`dsh-session@0.1.1-rc.2` 的 `SessionHeader`（有 `seedLength`、无 `isSeeded`）
- v2+ 头部：`dsh-session@0.1.3-alpha.2` 的 `SessionHeader`（`isSeeded` 必填、`seedLength` 被拒绝）
- v4 头部：`dsh-session-format-v3-to-v4@0.1.7-alpha.1` 的 `assertReleasedV4Header`
  （required = `version,id,createdAt,isSeeded,delegationDepth`）
- 接口代次：`dsh-session-persistence@0.1.1-rc.2`（`create/append/list`）对比
  `@0.1.3-alpha.2`（`create → handle`、`open/flush/stat/list`）
- 事件字段：`assistant/message` 在 v0 是 `{turn,step,message,usage?,interrupted?}`，
  v2+ 是 `{turn,step,message,stream,…}`

¹ **v1 的处理方式**：没有任何已发布版本写过 v1，所以那一行是按 v0 建模的。为了让这个猜测不至于变成 bug，
插件在写入前会读**该 profile 自己已存会话**的头部字段来判断方言（有 `isSeeded` 走 v2+ 形状，有 `seedLength` 走 v0/v1 形状）。
方言只覆盖**建模的行**（v1 与未知版本）：已被发布版本验证过的行以表格为准，因为那个版本才是它自己写什么的权威；
两个标志（`isSeeded`、`stream`）一起切换，因为每个已发布代次里它们是绑定的。单测覆盖了这条路径（`headerDialect` / `resolveStorageEvidence` / `formatProfile`）。

其余插件依赖的服务（`webServer`、`credentials`、`workspaceRegistry.attachSession`）
在 v0 到 v4 之间签名一致，已逐版本核对，因此兼容层只需要处理会话持久化这一层。

## 跨代可读性（升级 DSH 后旧导入还能不能打开）

导入的日志要保持「**写入它的构建**之外、**更新版本**的构建也能读」——用户升级 DSH 之后，
旧导入会被新版按格式链迁移（v0→v1→v2→v3→v4）。这条链上有硬性约束，**同版本往返测试看不出来**：

- **首个 surface 事件之前必须已有 `step/start`**。v2→v3 迁移在第一个 `step/start` 处插入
  system 头；若日志在第一个 step 之前就出现 `user/message`/`assistant/message`/`tool/result`，
  迁移会抛出
  `format v2 surface before first step cannot acquire a system head without changing chronology`，
  该会话在新版本上**列出了但打不开**。
  因此本插件的事件顺序是 `turn/start → step/start → user/message`（与 DSH 自己的日志一致）。
- 写入 v3/v4 的日志不受这条约束影响（v3→v4 没有该规则），但顺序仍保持一致。

验证方式：`test/cross-version.mjs` 分两步跑——在旧版本目录里 `write`，在当前版本目录里 `read`；
`test/matrix.sh` 会对每个可安装的旧版本跑一遍（v0/v2/v3 写入 → v4 读取）。

## 怎么自己验证

### 1) 纯单测（不需要 DSH）

```sh
node --test test/events.test.mjs
```

覆盖：fragment 提取、思维链/正文分块、时间戳单调、事件序列连续与 turn/step 配对、
各代头部与事件形状、版本探测（两种 `list()` 返回形状）、旧式接口识别。

### 2) 真实后端联调（每个 DSH 版本跑一次）

在**哪个版本的目录**下运行，就用哪个版本自己的持久化实现：

```sh
# 当前版本（v4）
cd /usr/local/lib/node_modules/@deepseek-ai/dsh
node <repo>/test/compat.mjs --expect 4
node <repo>/test/live-import.mjs

# 旧版本（示例：v0 / v2 / v3，test/matrix.sh 会自动装好）
cd /tmp/compat/v0 && node <repo>/test/compat.mjs --expect 0
cd /tmp/compat/v2 && node <repo>/test/compat.mjs --expect 2
cd /tmp/compat/v3 && node <repo>/test/compat.mjs --expect 3
```

`compat.mjs` 把合成对话写进真实后端，再用该版本自己的读取路径读回并重建会话；
`live-import.mjs` 更进一步：直接调用插件的 host 路由（网络层替换成合成响应），
断言写入的事件数、格式版本、派生消息条数和工作区挂载。

### 3) 跨代读取（旧版本写、新版本读）

```sh
cd /tmp/compat/v0 && node <repo>/test/cross-version.mjs write /tmp/xver/v0 session-cross-v0
cd /usr/local/lib/node_modules/@deepseek-ai/dsh
node <repo>/test/cross-version.mjs read /tmp/xver/v0
# PASS read session-cross-v0: stored v4 → 21 events, 6/6 messages
```

### 4) 一键矩阵

```sh
sh test/matrix.sh
```

脚本会在 `/tmp/compat/v{0,2,3}` 里 `npm i` 对应版本的
`@deepseek-ai/dsh-base`、`dsh-session-persistence(-jsonl)`、`cordis` 等包，
然后依次跑 v0/v2/v3 与当前版本。首次运行需要联网下载这些包。

## 最近一次验证结果

```
v0  0.1.1-rc.2        PASS format v0 | stored v0 | 20 events | 6 messages | reasoning=true
v2  0.1.3-alpha.2     PASS format v2 | stored v2 | 20 events | 6 messages | reasoning=true
v3  0.1.6-alpha.2     PASS format v3 | stored v3 | 20 events | 6 messages | reasoning=true
v4  0.1.7-alpha.1        PASS format v4 | stored v4 | 20 events | 6 messages | reasoning=true
e2e 0.1.7-alpha.1        PASS live import → format v4, 20 events, 6 messages, attached=1
e2e 0.1.1-rc.2        PASS live import → format v0, 20 events, 6 messages, attached=1
e2e 0.1.3-alpha.2     PASS live import → format v2, 20 events, 6 messages, attached=1
单测                 11/11 pass
```

v1 没有发布版本写入过它（0.1.1-rc.1、0.1.2-alpha.4/5、0.1.2-rc.1 都是 v0），
因此 v1 采用与 v0 相同的形状并有单测覆盖；一旦出现写入 v1 的构建，
把它的包加进 `test/matrix.sh` 即可得到实测证据。
