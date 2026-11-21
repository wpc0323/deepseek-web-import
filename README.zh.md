# DeepSeek Web 对话导入

[English](README.md) | **中文**

把 [chat.deepseek.com](https://chat.deepseek.com) 的网页端对话导入 DeepSeek Harness，导入后可以继续对话。

---

## 界面预览

![「DeepSeek 对话导入」设置页](docs/screenshots/settings.png)

---

## 功能

- 设置页提供对话目录，一键导入
- 每条对话可选导入到哪个工作区
- 导入的会话保留 DeepSeek 原标题，可选模型继续对话
- **已导入的会话**面板：移动到别的工作区，或归档
- 两个列表都支持搜索与折叠
- 中英界面，跟随 DSH 语言设置
- 适配 DSH Session 格式 v0–v4

---

## 重要提示

导入后刷新页面，左侧工作区才会显示新会话。

---

## 安装

需要 PATH 中可执行的 `node`。

```sh
dsh plugin add deepseek-web-import
```

或从仓库安装：

```sh
dsh plugin add wpc0323/deepseek-web-import
```

安装后重启 DSH，设置页即可看到入口。

---

## 使用

1. 打开 **设置 → DeepSeek 对话导入**。
2. 粘贴 `userToken` 并保存。
   获取方式：登录 chat.deepseek.com → F12 → Application → Local Storage → `userToken`。
3. 点 **获取对话目录**。
4. 为目标对话选择工作区，点 **导入为会话**。
5. 刷新页面，从左侧打开该会话。

导入只写会话持久化，不进入 live store，因此会话可以正常打开与继续对话。

---

## 已导入的会话

第三张卡片列出本插件导入的所有会话及其所在工作区。

- **移动**：选择目标工作区。移动失败会放回原工作区。
- **归档**：从工作区列表移除，日志仍保留在磁盘。DSH 没有删除会话日志的接口。

在会话中继续对话后，它会离开此面板，因为此时它已是普通 DSH 会话。

---

## 会话打不开

两种故障与修复方法见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

修复打不开的旧导入会话：

```sh
node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions --apply
```

---

## 兼容性

| DSH 版本 | Session 格式 |
|---|---|
| 0.1.0-rc.7 – 0.1.2-rc.1 | v0 |
| 0.1.3-alpha.2 | v2 |
| 0.1.5-alpha.1 – 0.1.6-alpha.2 | v3 |
| 0.1.7-alpha.1+ | v4 |

证据与验证步骤见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

---

## 已知限制

- 依赖 DeepSeek 非官方网页接口，可能随改版失效。
- 密码登录会被人机验证拦截，需使用 `userToken`。
- 目录只返回最近 100 条对话，DeepSeek 未提供更早对话的游标。
- `userToken` 数小时到数天后过期，失效时重新保存。
- 联网检索步骤与被中断消息的状态不会导入。
- 同一对话重复导入会生成两个会话，DSH 无法删除会话，请归档多余的那个。

---

## 安全提醒

请勿在对话、Issue 或仓库中泄露密码或 `userToken`。曾在任何地方贴出密码的，请立即修改 DeepSeek 密码。

---

## License

MIT
