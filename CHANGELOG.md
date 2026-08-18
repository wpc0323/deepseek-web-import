# Changelog

## 0.1.0 (2026-08-17)

- Initial release as an installable DSH plugin bundle (`dsh.bundle` + `dsh.client`).
- Settings-page UI ("DeepSeek 对话导入"): paste `userToken`, list the chat.deepseek.com conversation directory (title + date, most recent 100), and import a chosen conversation into a chosen workspace as a durable, resumable DSH session.
- Imported sessions: DeepSeek title preserved, openable and resumable in DSH (does not enter the live store, so it can be resumed and continued).
- Empty-conversation guard and attach-failure reporting (`attached: false` instead of a false "import failed").
- Same-origin JSON routes served by the host half; the browser half calls them with `fetch`.
- Diagnostic route restricted to chat.deepseek.com URLs.
