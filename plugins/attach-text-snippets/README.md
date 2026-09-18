# Attach Text Snippets

Attach Text Snippets adds **Attach text snippet** to the native composer `+`
menu on existing threads. It turns pasted text into a durable `.txt` file under
the thread's `attach-text-snippets/` storage directory and inserts a compact
mention into the draft.

The pasted body is not expanded in the composer, visible conversation, or the
mention provider's hidden context. At send time the agent receives only the
exact durable file path and an instruction to read it when relevant. The agent
can pass the same artifact onward with the native Markdown file link included
in that context. Previously created snippets also appear in the `@` mention
menu for the thread.

This is a compact transport mechanism, not a secret store. Anyone or any agent
with access to the thread's durable storage can open the file. Snippets are
limited to 1 MB and use create-only writes with private host file permissions.
If a snippet file is later deleted, BB blocks sending its stale mention with a
visible error instead of passing a dead path to the agent.

When its thread is deleted, the plugin removes its exact thread-storage
subdirectory. Failed cleanup remains recorded and is retried when the plugin
next starts. Uninstalling the plugin itself intentionally leaves durable files
and metadata in place; uninstall retention is controlled by BB rather than by
an uninstall hook.

New-thread composers are intentionally excluded because no durable thread
storage root exists until BB creates the thread.

## Development

```sh
npm run typecheck
npm run test
npm run build
bb plugin install path:. --plugin attach-text-snippets --yes
```
