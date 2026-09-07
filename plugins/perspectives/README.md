# bb-plugin-perspectives

Adds two native tools to bb agents:

- `help` accepts a question and context, generates the expert prompt in a separate hidden planner, and asks one hidden helper for a concise read-only answer. It is synchronous: the answer is the tool result.
- `gather_perspectives` accepts 3-7 caller-supplied lenses—specific aspects or analytical angles such as `"v8 performance characteristics"`, `"big-O complexity"`, and `"duplicate work"`—generates a bespoke expert prompt for each lens, launches the panel concurrently, and synthesizes every usable complete or partial outcome. It is asynchronous: the tool call returns a launch receipt immediately, the panel keeps working in the background, and the synthesized result is delivered to the calling thread as a later message beginning `Perspectives panel result` (or `Perspectives panel failed`).

One `help` call creates a hidden planner and one hidden expert. One
`gather_perspectives` call creates one hidden planner, 3-7 concurrent hidden
workers, and one hidden synthesis thread; a malformed planner response can
consume one bounded retry. Each thread is a model invocation and carries the
cost and provider limits of its resolved execution tuple.

## Execution settings

Settings expose separate phase tuples:

| Setting group | Applied to |
|---|---|
| Planner provider/model/reasoning/permission | Prompt planner and final synthesis |
| Worker provider/model/reasoning/permission | `help` expert and every panel worker |

Blank provider/model values and `inherit` selectors are explicit defaults. If
the provider is unchanged, they copy the caller's resolved tuple. If a different
provider is configured and model remains blank, Perspectives uses that
provider's declared default model; the model's default reasoning is used unless
reasoning is configured. Permission inheritance keeps the caller's permission
mode. The plugin resolves and validates both phase tuples against the caller's
environment host before it creates any hidden thread. An unavailable provider,
model, reasoning level, permission mode, or host ceiling returns a configuration
error with no partially launched panel.

Every spawn records the resolved fields as explicit inputs so bb does not
re-derive a different model mid-panel. Settings affect later calls immediately;
they do not mutate existing hidden threads.

Workers, planners, and synthesis are instructed to perform read-only advisory
work and not mutate files or external systems. bb 0.39 has no `read-only`
permission mode, so that instruction is a policy, not a technical sandbox: the
configured/inherited permission setting remains the thread's real authority
envelope and should be chosen accordingly. The plugin itself stores no result
data and contacts no external service, but the selected model/provider and its
available tools may perform network or read-only source inspection.

The panel does not stop when a majority finishes. Each worker gets the full
panel phase. Unfinished workers receive a late wrap-up request, then their
final or partial output is recovered at the phase boundary. One failed worker
or launch does not cancel productive peers. Synthesis is still attempted when
only partial evidence is available; if synthesis itself cannot finish, the
later delivery contains its partial synthesis (if any) plus the bounded raw
perspective outputs instead of discarding them.

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

## Run lifetime and budgets

`gather_perspectives` does not hold its tool call open while the panel runs.
The bb dynamic-tool path keeps one HTTP round-trip open per tool call with no
abort or timeout of its own, so a long synchronous call couples the panel's
lifetime to a fragile transport and holds the caller's turn — and its provider
session — hostage for the duration. Instead the tool returns a launch receipt
within seconds and the pipeline continues detached inside the plugin host,
governed by its own run budgets rather than the request's lifetime:

- planner: 15 seconds total, including one retry;
- panel: unfinished workers are asked to wrap up after 20 minutes of
  continuous work;
- hard cap: 25 minutes for the whole run, enforced by a run-wide abort that
  stops every remaining agent;
- synthesis: 90 seconds, reserved inside the hard cap so partial evidence is
  still synthesized;
- every `threads.spawn` is raced against a 60-second timeout so one hung RPC
  cannot stall the run.

These are phase boundaries, not a quorum policy. A timed-out worker's partial
output remains evidence, its status is disclosed to the synthesizer, and the
synthesis phase is reserved rather than skipped. Whatever happens — including
the hard cap firing or an unexpected pipeline failure — the run ends with one
delivery message to the calling thread, sent with `mode: "auto"` so it steers
an active turn or starts a new one. If that single delivery attempt itself
fails, the plugin logs the transport failure; it does not send a second,
misleading panel-failure message after the result may already have arrived.

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

All plugin-owned threads reuse one snapshot of the caller's project and
environment plus the prevalidated phase tuple described above. They are hidden root threads,
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
- `engines.bbPluginSdk` — supported plugin SDK floor (`>=0.4.8` here).

The rich in-plugin logo and marketplace icon are Cole-approved PE02-A. The
package preserves the generated 1254px RGB source and the verified RGB24
nearest-neighbor 16/24/32px derivatives byte-for-byte under `assets/`.

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

This plugin imports the published `@get-bb/plugin-sdk` package (and its
`/app` entry when it has a frontend). Its exact SDK development dependency
provides the editor and `tsc` declarations; do not add a plugin-local SDK
declaration copy or a TypeScript path alias. The package pin records the
SDK contract used for development checks. Ask BB to write plugins for you: the
`bb-plugin-authoring` skill documents the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
