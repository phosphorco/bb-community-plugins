# Restart Resume

Restart Resume automatically continues threads that BB left in an error state
because the host daemon restarted or its active-work disconnect grace expired.
It is deliberately limited to persisted `host-daemon-restarted` interruption
events, so an ordinary provider failure or a user stop is never retried by this
plugin.

Automatic recovery is enabled by default. Each interruption is claimed in the
plugin's SQLite database and is retried after temporary send failures. The
plugin also checks the thread event log before retrying, which avoids sending a
duplicate prompt if BB accepted a request just before the plugin process went
away.

The default message is informative when a turn was interrupted and asks the
agent to report material restart effects. If the restart happened without an
open turn, the plugin sends a single `.`. The settings panel provides a
project-specific override; an empty override restores the default behavior.
On startup and after a `thread.failed` transition, the plugin collects the
most recently updated error threads, finds the newest paired host-daemon error,
and resumes only disconnected threads whose interruption event is within one
minute of that error. It then polls only its own due retry rows.

Use `bb restart-resume resume` inside a thread for a manual retry, or
`bb restart-resume status` to inspect automatic mode and durable counts.

## Development

```sh
bun test
bun run typecheck
bun run build
```
