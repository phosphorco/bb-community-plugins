# Model dispatch snapshot API

Status: proposal

## Verdict

BB should expose an experimental, immutable snapshot of the context BB
dispatched toward a model provider for a particular conversation point. This
would let a plugin add an **Inspect model context** message action and show the
input, instructions, tools, skills, and execution settings that applied to that
request.

The API should describe this as a **BB dispatch snapshot**, not the raw model
request. Provider runtimes such as Codex, Claude Code, Pi, and ACP agents may
retain conversation state, compact history, or add provider-owned context that
BB cannot observe.

## Concrete need

The conversation timeline shows user and assistant messages, but it does not
show the complete context BB assembled for the agent. That hidden context can
include:

- BB's standard instructions;
- user and workspace `AGENTS.md` instructions;
- plugin-contributed instructions;
- agent-only mention context;
- selected skills and dynamic tools;
- model, reasoning, permission, and service-tier settings.

A message action can open a native right-panel inspector. The UI surface already
exists; the missing capability is a trustworthy historical data source.

BB core must own the historical snapshot because only the host sees the final
resolved combination of inputs, instructions, tools, skills, execution options,
and provider-session state. A plugin can read the visible timeline, but
reconstructing the rest later would be incomplete and could reflect files or
configuration that changed after the turn ran.

## Concrete example

1. A user sends “Why did you choose this database?” with a workspace
   `AGENTS.md`, a plugin-provided documentation mention, and two dynamic tools
   active.
2. The assistant recommends SQLite.
3. The user selects **Inspect model context** on that assistant message.
4. A right-panel inspector shows the exact user and agent-only inputs BB
   dispatched, the resolved instruction text, the two advertised tool
   definitions, selected skill metadata, and the model/reasoning/permission
   settings.
5. The inspector labels the result **BB dispatch snapshot** and explains that
   provider-owned retained history is outside the snapshot's fidelity.
6. Editing `AGENTS.md` afterward does not change the recorded snapshot for the
   completed turn.

Success is observable when the inspector shows the historical values from the
dispatch rather than newly resolved values from the current workspace.

## Current limitation

BB persists the requested input and execution settings in the thread event
stream, but it does not preserve the complete resolved runtime context as a
queryable historical value. The missing boundary is visible in this current and
intended flow:

```text
current

composer/send
  -> resolve input, instructions, tools, skills, and execution settings
  -> construct thread.start / turn.submit
  -> host daemon
  -> provider adapter
  -> provider runtime

persisted: client/turn/requested input and execution settings


intended

composer/send
  -> resolve complete BB dispatch context
  -> construct thread.start / turn.submit
  |-> persist a sanitized immutable snapshot
  `-> host daemon -> provider adapter -> provider runtime

message source sequence
  -> request/turn lookup
  -> persisted snapshot
  -> experimental SDK API
  -> plugin inspector panel
```

Recomputing the context when the inspector opens would not be historical truth:
instructions, plugin configuration, skills, tools, and workspace files may have
changed since the turn ran. The snapshot must therefore be captured on the
dispatch path.

## Recommended design

Following BB's policy for new plugin APIs, the method should remain
experimental until its fidelity, privacy, retention, and compatibility
semantics have been audited.

```ts
interface ThreadModelDispatchSnapshotArgs {
  threadId: string;
  sourceSeqEnd: number;
}

type ThreadModelDispatchSnapshotResult =
  | {
      status: "captured";
      snapshot: ThreadModelDispatchSnapshot;
    }
  | {
      status: "unavailable";
      reason:
        | "predates-capture"
        | "not-dispatched"
        | "unsupported-anchor";
    };

interface ThreadModelDispatchSnapshot {
  requestId: string;
  capturedAt: number;
  provider: {
    id: string;
    model: string;
    sessionMode: "new" | "resume" | "live";
  };
  input: PromptInput[];
  instructions: {
    mode: "append" | "replace";
    text: string;
  };
  tools: ModelToolDescription[];
  skills: ModelSkillDescription[];
  execution: RecordedThreadExecutionOptions;
  fidelity: "bb-dispatch";
}

interface ThreadsArea {
  experimental_modelDispatchSnapshot(
    args: ThreadModelDispatchSnapshotArgs,
  ): Promise<ThreadModelDispatchSnapshotResult>;
}
```

Accepting `sourceSeqEnd` lets a message action use the narrow message reference
it already receives. The server owns resolving that anchor to the corresponding
request or turn; internal request IDs do not need to leak into timeline UI
contracts.

## Ownership, trust, and lifecycle

The server owns assembly and persistence. The host daemon and provider adapters
continue to own host-local execution and provider translation. Plugins receive
only the sanitized result through the ordinary thread authorization boundary.

Snapshot capture follows the lifecycle of actual dispatch attempts:

- capture immediately before a `thread.start` or `turn.submit` command is sent;
- associate the snapshot with the existing client request ID;
- retain the same snapshot whether the provider accepts or rejects the request;
- cascade-delete it when its thread is deleted;
- return an explicit unavailable reason for turns that predate capture; and
- do not recompute or mutate it after plugin reloads, instruction edits,
  environment changes, compaction, or provider restarts.

## Important implementation requirements

### Persistence and capture boundary

Use a dedicated table rather than adding a large payload to the general thread
event stream:

```text
model_dispatch_snapshots
|- thread_id
|- request_id
|- source_event_sequence
|- command_kind
|- captured_at
`- snapshot_json
```

The canonical capture point is immediately before BB dispatches a
`thread.start` or `turn.submit` host command. At that point the server has the
resolved input, runtime instructions, dynamic tools, injected skill sources,
provider identity, and execution options.

Persist a purpose-built projection rather than the entire host command. Full
commands may contain absolute host paths, ACP launch environment values, or
other data that should not be sent to a plugin frontend.

Snapshots should be associated with the existing client request ID. Recording
an attempted dispatch is useful even when the provider later rejects it; the
result can separately expose the request's eventual accepted or failed status.

### Fidelity boundary

The snapshot can truthfully show:

- visible and agent-only inputs;
- resolved plugin mention context;
- BB, user, workspace, tool, and plugin instructions;
- advertised dynamic tool definitions;
- selected skill metadata;
- model, reasoning, permission, and service-tier settings;
- whether BB started, resumed, or reused a provider session.

It cannot universally show:

- provider-maintained conversation history after compaction;
- memory or instructions added internally by a provider runtime;
- the final HTTP request made by that runtime to its model service;
- provider-side transformations after BB emits its command.

A later daemon-level API could optionally capture the sanitized provider command
produced by each adapter. That would require a host-daemon protocol version bump
and should report a separate `provider-command` fidelity. It still must not be
called the raw model request.

### Security and retention

The response may contain hidden instructions, file-derived content, tool
schemas, and mention context. The implementation should:

- use the existing thread/project authorization boundary;
- exclude credentials, environment variables, and unneeded absolute paths;
- return structured fields so the UI can disclose sensitive sections
  progressively;
- define a snapshot size limit and explicit truncation metadata;
- cascade-delete snapshots with their thread;
- avoid logging snapshot bodies.

BB plugins are trusted server-side code, but exposing a snapshot through a
plugin panel moves it into the browser and therefore still deserves a narrow,
sanitized contract.

## Suggested initial scope

V1 should capture the sanitized server-owned dispatch projection, expose it by
thread and message source sequence, provide an equivalent CLI read command, and
support a click-to-open message inspector. It does not need daemon-side adapter
capture.

### User experience

The companion plugin can remain small:

```text
messageAction: Inspect model context
  -> open thread panel
  -> call experimental_modelDispatchSnapshot
  -> render Input / Instructions / Tools / Skills / Execution
```

Click-to-open is preferable to a hover-only interaction because the content is
large, selectable, and needs a keyboard-accessible disclosure model. A hover
tooltip could later show a small summary such as model, token estimate, and
instruction/tool counts.

### Likely BB implementation surfaces

1. Define snapshot schemas in the domain/server contract.
2. Add the snapshot table and targeted request-ID/anchor queries.
3. Capture sanitized snapshots at the live host-command dispatch boundary.
4. Add a thread route that resolves `sourceSeqEnd` and returns the snapshot.
5. Add `experimental_modelDispatchSnapshot` to the SDK and bundled types.
6. Add the required `api_to_audit.md` entry.
7. Add an equivalent `bb thread` CLI command for agent access.
8. Cover new threads, warm turns, steering, queued messages, retries,
   reprovisioning, history replacement, edits, and rate-limit continuation.
9. Build the message-action inspector as a separate plugin change.

Likely public implementation areas include:

- `packages/domain` for snapshot value schemas;
- `packages/db` for persistence and targeted lookup;
- `apps/server/src/services/threads/thread-runtime-config.ts` for the resolved
  instruction/tool/skill source data;
- `apps/server/src/services/threads/thread-commands.ts` for construction of the
  dispatch projection;
- `apps/server/src/services/hosts/live-command.ts` for the final server-owned
  dispatch boundary;
- `packages/server-contract` and the thread routes for the HTTP contract;
- `packages/sdk/src/areas/threads.ts` for the SDK method;
- `packages/plugin-sdk` for the experimental plugin-facing surface; and
- the BB CLI thread commands for equivalent agent access.

### Effort

A server-owned `bb-dispatch` snapshot is medium-sized work: approximately two
to four focused engineering days, or about a week including migration, CLI and
SDK parity, generated declarations, privacy review, and hardened tests.

Capturing provider-adapter commands is a larger follow-up. Capturing literal
model-service HTTP requests would require provider-specific proxying or runtime
instrumentation and is not a suitable promise for a generic BB API.

## Deferred or non-goals

- Turn execution and provider session behavior do not change.
- The timeline remains the visible conversation projection.
- Existing turns created before snapshot capture return `predates-capture`.
- V1 does not restart sessions to obtain fresher instructions.
- V1 does not claim to reconstruct provider-owned history.
- V1 does not expose credentials or arbitrary host-command payloads.

A later daemon-level API may capture a sanitized provider-adapter command with
separate `provider-command` fidelity. Capturing literal model-service HTTP
requests is provider-specific and is not a generic BB API promise.

## Acceptance criteria

- Given a newly dispatched turn, querying by its thread ID and a message's
  `sourceSeqEnd` returns the one immutable snapshot associated with that
  request.
- The snapshot includes visible and agent-only inputs, resolved instruction
  text and mode, advertised dynamic tool definitions, selected skill metadata,
  provider/model/session mode, and recorded execution settings.
- Editing workspace instructions or reloading a contributing plugin after the
  turn does not alter the returned snapshot.
- A provider rejection retains the attempted snapshot and exposes failure
  separately from snapshot availability.
- A turn created before capture was introduced returns
  `{ status: "unavailable", reason: "predates-capture" }`.
- A caller without access to the thread cannot retrieve its snapshot.
- Snapshot responses and logs contain no ACP environment credentials or other
  launch secrets; sensitive absolute paths are omitted unless a documented
  field requires them.
- Deleting a thread deletes its snapshots.
- Snapshot capture does not restart or reconfigure a provider session and does
  not change normal turn output.
- The feature is available through both the SDK and a `bb thread` CLI command.
- Tests cover new sessions, warm sessions, steering, queued sends, retries,
  reprovisioning, edits/history replacement, and rate-limit continuation.

## References

- [Thread runtime configuration assembly](https://github.com/get-bb/bb/blob/main/apps/server/src/services/threads/thread-runtime-config.ts)
- [`thread.start` and `turn.submit` command construction](https://github.com/get-bb/bb/blob/main/apps/server/src/services/threads/thread-commands.ts)
- [Live host-command dispatch boundary](https://github.com/get-bb/bb/blob/main/apps/server/src/services/hosts/live-command.ts)
- [Persisted thread request event contract](https://github.com/get-bb/bb/blob/main/packages/domain/src/thread-events.ts)
- [Host daemon command schemas](https://github.com/get-bb/bb/blob/main/packages/host-daemon-contract/src/commands.ts)
- [Thread SDK area](https://github.com/get-bb/bb/blob/main/packages/sdk/src/areas/threads.ts)
- [Built-in Side Chat message-action example](https://github.com/get-bb/bb/blob/main/plugins/side-chat/app.tsx)
