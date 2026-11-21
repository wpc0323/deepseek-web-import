# DeepSeek Web Chat Import

**English** | [中文](README.zh.md)

Import [chat.deepseek.com](https://chat.deepseek.com) conversations into DeepSeek Harness as sessions you can keep chatting in.

---

## Screenshots

![The DeepSeek Chat Import settings page](docs/screenshots/settings.png)

---

## Features

- Settings page with a conversation directory and one-click import
- Each conversation goes to the workspace you pick
- Imported sessions keep the DeepSeek title and can be continued with any model
- **Imported sessions** panel: move a session to another workspace, or archive it
- Search and collapse for both lists
- English and Chinese UI, following the DSH language
- Works across DSH Session formats v0–v4

---

## Important

Refresh the page after importing. The sidebar picks up the new session on refresh.

---

## Install

Requires `node` on PATH.

```sh
dsh plugin add deepseek-web-import
```

Install from the repository instead:

```sh
dsh plugin add wpc0323/deepseek-web-import
```

Restart DSH. The page appears under Settings.

---

## Usage

1. Open **Settings → DeepSeek Chat Import**.
2. Paste your `userToken` and save.
   Get it from chat.deepseek.com: F12 → Application → Local Storage → `userToken`.
3. Click **Load conversations**.
4. Pick a workspace for a conversation, then click **Import as session**.
5. Refresh the page, then open the session from the sidebar.

Imports write to session persistence only, never to the live store, so the session opens and continues normally.

---

## Imported sessions

The third card lists every session this plugin imported, with its workspace.

- **Move**: pick a target workspace. A failed move puts the session back where it was.
- **Archive**: removes the session from the workspace lists. The log stays on disk. DSH has no API that deletes a session log.

A session leaves this panel once you continue the conversation in it, because it is then an ordinary DSH session.

---

## Session will not open

Two failures and their fixes are documented in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

Repair an old import that no longer opens:

```sh
node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions --apply
```

---

## Compatibility

| DSH version | Session format |
|---|---|
| 0.1.0-rc.7 – 0.1.2-rc.1 | v0 |
| 0.1.3-alpha.2 | v2 |
| 0.1.5-alpha.1 – 0.1.6-alpha.2 | v3 |
| 0.1.7-alpha.1+ | v4 |

Evidence and verification steps: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

---

## Known limitations

- Uses DeepSeek's unofficial web API, which can change without notice.
- Password sign-in is blocked by DeepSeek bot protection. Use a `userToken`.
- The directory returns the newest 100 conversations. DeepSeek provides no cursor for older ones.
- `userToken` expires after hours to days. Save a fresh one when it stops working.
- Web search steps and interrupted-message status are not imported.
- Importing the same conversation twice creates two sessions. DSH cannot delete sessions, so archive the duplicate.

---

## Security

Never share your password or `userToken` in a conversation, issue, or repository. Change your DeepSeek password if you have posted it anywhere.

---

## License

MIT
