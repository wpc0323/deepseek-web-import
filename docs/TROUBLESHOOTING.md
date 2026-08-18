# Troubleshooting

## "corrupt session log: seq gap in committed region" after restart

Symptom: after restarting DSH, a session fails to load / resume with

```
Error: corrupt session log: seq gap in committed region at line N (expected X, got Y)
```

This is a **DSH recovery-cursor issue, not this plugin's fault**. Two conditions
together trigger it:

1. `session/end-seed` was committed by a **live session** as a **separate append
   batch** (DSH's own agent loop does this when creating/resuming a session whose
   seed tail is not already an end-seed marker);
2. on the next startup, DSH's recovery cursor does not count that batch, so the
   first post-resume write reuses the end-seed's seq → duplicate seq → the
   committed region is truncated at the duplicate and everything after it becomes
   unreadable.

This plugin imports sessions by writing the whole seed (title + messages +
`session/end-seed`) in **one** `sessionPersistence.append` batch, so an import
itself does not trigger the bug. However, once you **open an imported session and
keep chatting**, subsequent writes go through DSH's live-session machinery again,
so the same DSH bug can affect any session — imported or not.

Workaround: manually repair the affected `~/.dsh/sessions/**/session.jsonl.zstd`
by removing the duplicate line (the separately-committed `session/end-seed` whose
seq was reused), restoring contiguous seqs, and re-encoding the zstd frame. Take
a backup first. Keep `agent/inbox/spliced` insert/remove pairs intact.

This was also reported upstream at
https://github.com/deepseek-ai/deepseek-harness/discussions/2817.
