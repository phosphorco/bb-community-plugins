# bb-plugin-perspectives

Adds two native tools to bb agents:

- `help` accepts a question and context, generates the expert prompt in a separate hidden planner, and asks one hidden helper for a concise read-only answer.
- `gather_perspectives` accepts 3-7 caller-supplied lenses—specific aspects or analytical angles such as `"v8 performance characteristics"`, `"big-O complexity"`, and `"duplicate work"`—generates a bespoke expert prompt for each lens, launches the panel concurrently, and synthesizes every usable complete or partial outcome.

The panel does not stop when a majority finishes. Each worker gets the full
panel phase. Unfinished workers receive a late wrap-up request, then their
final or partial output is recovered at the phase boundary. One failed worker
or launch does not cancel productive peers. Synthesis is still attempted when
only partial evidence is available; if synthesis itself cannot finish, the
tool returns its partial synthesis (if any) plus the bounded raw perspective
outputs instead of discarding them.

Only the final-result thread is referenced in a successful tool response:
the synthesis thread for `gather_perspectives`, or the expert thread for
`help`. Planner and worker threads remain hidden and directly addressable for
internal diagnosis, but are not enumerated to the calling agent. If no final
result thread could be created, the fallback answer contains no internal
thread references.

Every worker is instructed to cite material factual claims inline from primary
evidence it actually inspected, using clickable file-and-line links for local
repository evidence and direct Markdown links for web or documentation
sources. Workers distinguish supplied context and inference from independently
verified facts. The synthesizer preserves and deduplicates those citations,
does not invent missing citations, and reports unsupported claims as evidence
gaps.

## Transport compatibility

The current bb dynamic-tool path waits for one HTTP response from the plugin
and applies a 300,000 ms response-body timeout. Because a synchronous tool call
does not emit a body until it returns, that behaves like a five-minute
end-to-end ceiling even though it is implemented as a transport timeout.

The plugin stays inside that ceiling with separate compatibility budgets:

- planner: 15 seconds total, including one retry;
- concurrent panel: 205 seconds, with wrap-up requested when 45 seconds remain;
- synthesis: 50 seconds;
- unallocated host forwarding, transport, and serialization margin: about 30 seconds.

These are phase boundaries, not a quorum policy. A timed-out worker's partial
output remains evidence, its status is disclosed to the synthesizer, and the
synthesis phase is reserved rather than skipped.

The long-term bb-core direction should remove the transport connection as the
owner of a tool's lifetime. A durable long-running tool operation could return
an operation ID immediately, publish progress or heartbeats, survive client
reconnection, retain partial output, and expose explicit cancellation. Making
the existing body timeout configurable or larger would be a useful smaller
core fix, but it would only move the ceiling and would not make long-running
tools durable.

Example:

```json
{
  "question": "Where is the performance work in this implementation?",
  "context": "Focus on behavior that matters under production load.",
  "lenses": [
    "v8 performance characteristics",
    "big-O complexity",
    "duplicate work"
  ]
}
```

All plugin-owned threads reuse a single snapshot of the caller's project,
environment, provider, and execution options. They are hidden root threads,
not children or forks, so they neither inherit the caller's provider
conversation nor report every completion and blocker into it. BB's current
`parentThreadId` contract is agent delegation: setting it at spawn reports
child outcomes, while setting it later queues a visible ownership-change
message. The plugin therefore does not use parent metadata as a silent grouping
mechanism.

Instead, the final-result thread contains the internal native `@thread`
references as inspectability metadata in its prompt, while its answer is
instructed not to repeat them. The calling agent receives only the final-result
thread reference. As a defense against prompt noncompliance, known planner and
worker thread tokens are also removed from the public result before that final
reference is appended. This gives one progressive-disclosure path to the planner
and evidence threads without injecting the whole pipeline into the caller.
The threads remain hidden from the sidebar and are explicitly instructed not
to modify state. The plugin tools are excluded from these threads to prevent
recursive panels.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required); optional `bb.app` for a frontend.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — supported plugin SDK range (scaffold: `^0.4.1`).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` (and, with `bb.app`, `app.js` /
`app.css` / `app.meta.json`). Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Install

From this directory:

```
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload perspectives
```

## Types & API reference

`types/bb-plugin-sdk.d.ts` (and `types/bb-plugin-sdk-app.d.ts` for the
frontend) are the full, bundled BB plugin API — `tsconfig.json` maps
`@bb/plugin-sdk` to them, so your editor and `tsc` see real types with no extra
install. They are readable declarations: open them for an exact signature.

The SDK surface grows with every BB release, and these are a copy. Refresh
them from the BB you are running:

```
bb plugin types          # rewrite types/ from this BB
bb plugin types --check  # CI: fail when they are out of date
```

`bb plugin build` and `bb plugin dev` refresh them for you. Ask BB to write
plugins for you: the `bb-plugin-authoring` skill documents the whole surface
with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
