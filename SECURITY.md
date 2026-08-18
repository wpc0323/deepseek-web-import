# Security

- The DeepSeek `userToken` is stored only via the DSH `credentials` service
  (`$DSH_HOME/.credentials.yaml`). It is never written to the browser, the
  session log, or any file in this repository.
- All plugin routes are same-origin JSON routes served by the DSH web server;
  nothing here accepts cross-origin input.
- The diagnostic `probe` route only accepts `chat.deepseek.com` URLs, so it
  cannot be used as an arbitrary SSRF vector.
- This plugin talks to DeepSeek's **unofficial web-chat internal API**
  (`chat.deepseek.com`). It is reverse-engineered and may change; it is not
  covered by DeepSeek's official API terms. Use at your own risk, and do not
  paste passwords or tokens into chat or issues.
- If you ever shared a DeepSeek password in a chat or issue, change it.
