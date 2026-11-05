# Consumer composition recipes

This document contains composition recipes, not standalone runnable programs.
Begin with [README](README.md). Exact signatures live in
the public declarations. Feature-owned storage is required; durable drafts are
an explicit feature choice.
Narrow native `/client`, `/react`, and `/bb` exports now have isolated packed-artifact
proof. Actual consumer adoption and identical-artifact base/fork behavior remain
separate acceptance gates. Native roots
use scoped RPC/realtime with authoritative reload; explicit roots use a supplied
endpoint/fetch/signal connection without a retained polling feed.

Read by task: [personal state](#one-preferences-feature),
[views and recovery](#view-as-and-recovery), [nested calls](#nested-plugin-requests),
[external producers](#external-contributions-and-history),
[providers](#bring-your-own-idp), or [connection roots](#native-and-independent-roots).

## One preferences feature

The feature shares a `StateResource<Preferences>` between its server and UI. It
contains its plugin ID and `StateDefinition`: collection name, schema version,
value codec, initial value and equality function. The feature supplies an
`AtomicStateStorage` adapter using its own transactional database, plus schema
migrations. It does not supply actor lookup or identity HTTP handlers.

At server factory initialization:

```ts
const binding = bindBbIdentity(bb);
if (!binding.ok) throw new Error(binding.error.message);
const registration = binding.value.state.register({
  resource: preferences,
  storage: preferencesStorage,
  policy: { kind: 'self-only' },
  readPolicy: { kind: 'collaborators' },
});
// Handle registration errors during factory startup; binding owns route cleanup.
```

The binding constructs `StateService` with its instance and commit validator,
registers versioned routes, decodes inputs and resolves each request's actual
actor. It derives the subject from the requested address, applies the feature's
write policy, and checks actor/session/subject expectations. `readPolicy` can
allow collaborator previews while `policy` keeps writes self-only; omitting
`readPolicy` uses `policy` for both. Client read-only UI does not grant authority. The storage adapter
executes the supplied synchronous validator inside the record/receipt transaction.
State publication follows commit. A present `already-initialized` winner also
publishes its recorded version, so feature-owned legacy import inside initialization
can notify peers without changing the durable outcome to `saved`. This requires the documented same-process
boundary; no atomic distributed validation is promised.

In the native plugin React surface, `useBbIdentityConnection()` owns the public SDK
`useRpc`, `useRealtime`, and `useRealtimeConnectionState` inputs. Its paired
`useBbIdentityClient()` may be `null` during committed acquisition. Keep
`BbIdentity.Provider` mounted with that nullable client and use its `fallback`
for pending UI. A null client suspends children while preserving the mounted
Provider's retirement and failure owner. A child `BbIdentity.Context` owns the
view. If the feature needs durable recovery, keep its DraftStorage adapter above
this replaceable Context so its object identity survives client/view replacement.
Every state resource borrows that same client connection; the feature supplies
no endpoint or second feed. The feature owns a conflict policy.

Inside the Context:

```ts
const state = useIdentityStateBinding({
  resource: preferences,
  recordId: 'preferences',
  target: 'viewed-subject',
  editPolicy: 'actor-only',
  initializeEmpty: true,
  onConflict: reviewPreferenceConflict,
  onUnpersistedDraft: retainDraftForRecovery,
});
```

The hook constructs addresses from the live instance, resource and subject;
supplies actor/session assertions and controller incarnation; registers guards;
and handles reconnect, invalidation and cleanup. It subscribes to state changes
so `getSnapshot()` is renderable without another subscription. `edit(next)` and
`flush()` are the ordinary update path. `reviewPreferenceConflict` is feature
logic returning a merge, accept-remote or needs-review decision.
For an irrecoverable work product, pass `drafts: preferenceDrafts` and make
`retainDraftForRecovery` the feature's last-resort recoverable UI/storage path
when that store fails. For a cheap preference, omit `drafts`: its unsaved edit
is intentionally in-session only. Neither choice resolves identity.

### State-controller lifetime and recovery

`createIdentityState` has terminal detach/dispose semantics: it cancels owned
work immediately, fences late completions, and cannot be started again after
dispose. A closing flush is bounded to 30 seconds; preservation detaches before
any fallible checkpoint wait so a failed checkpoint leaves the draft available.
An indeterminate operation remains the exact submitted mutation until its
receipt is reconciled. The controller creates no new operation while that result
is uncertain.

`retryLimit` applies only to explicit same-operation receipt lookup during that
bounded flush/recovery path; `0` forbids those retries. It is not a license to
resubmit a new mutation. The default conflict callback policy is applied, not
merely reported: a feature's rebase or accept-remote decision changes the
controller state, while needs-review retains the conflict token for an explicit
feature decision. These guarantees do not make merge or storage semantics
package-owned.

On upstream, the same path uses the reserved default owner and hidden view-as
controls. A configured IdP outage suspends edits; it never initializes a new
default-owner record.

## View-as and recovery

Feature-owned controls call Context view actions to change a view's subject.
Cole remains the actor while Alice is selected. `target: 'actor'` instead keeps
personal preferences tied to Cole regardless of selection. The server policy
remains decisive for the feature's edit behavior; a browser prop cannot change
it. Use the public `IdentityViewPicker` and `IdentityViewStatus` inside that same
Context; `IdentityAvatar` and `IdentityLabel` render supplied normalized profiles.
The feature still owns its product-specific conflict and retry UI.

Capture `state.currentOwnerSession()` when presenting a conflict/recovery UI.
For a blocked conflict snapshot, retain `snapshot.conflict.token` together with
that non-null controller token. Call `recoveryCandidates(ownerSession)`, then
`recover(ownerSession, chosenCheckpoint)` or
`discardRecovery(ownerSession, chosenCheckpoint)` for explicit user-requested
removal, or
`resolveConflict(ownerSession, conflictToken, decision)`. The binding checks both
tokens before work and after awaits; a stale UI action cannot resolve either a
replacement controller or a later conflict in the same controller. `checkpoint(token)` acknowledges
durable preservation, while ordinary edit success does not promise crash recovery.

Recovery candidates are bounded to 20 for the current address and actual actor.
Previous incarnations of the same actor may recover; another actor's draft or
a different schema requires an explicit feature import. This rule avoids
accidental re-authorship, without introducing private information access.
The draft store belongs to the feature/surface owner and must outlive Context.
No package timer silently deletes unresolved drafts. Conditional removal uses
the checkpoint revision, including `discardRecovery`; a stale list therefore
cannot erase a newer draft. Store capacity failures are explicit. A feature may
offer deliberate retention/removal policy.

When opted in, preservation runs after unconditional detach, including when
identity or the network has become unavailable. A draft backend must not require
opening a new person request just to retain that snapshot. Server SQLite remains
authoritative for committed feature state. Local draft bytes are untrusted
recovery input and never authorize a server write. Storage failures must reach
`onUnpersistedDraft`; no automatic expiry or silent deletion follows.

The internal provider-root preservation owner tracks pending work across child
binding replacement, partitioned by the actual draft-storage object and full
resource/actor/schema scope. Recovery waits for matching work while other roots
remain independent. It owns neither views nor draft payloads, and disposing it
does not cancel a write already started. React Provider integration and
controlled-browser held-write tests exist. Failed persistence remains
a feature-owned presentation/retry obligation, and this mechanism does not
promise recovery after the whole provider or browser dies before a checkpoint.

An explicit user decision to discard and switch calls
`view.select(selection, {pendingEdits: 'discard'})` (or the equivalent actions
hook). That choice applies only to this transition. All guards approve before
destructive finalization. Actor changes cannot be vetoed: writes detach first,
then preservation runs. Recovering an uncertain operation reconciles its exact
original mutation; changing owner/session does not authorize resubmission under
another actor. Discard cannot undo a previously accepted write.

## Nested plugin requests

Wrap ntfy's interactive handler with `binding.rpc.register`. Obtain
`invocation.person()`, handling errors, then use `person.callPlugin` with the
Notifications method, payload and output codec for registration-begin and
registration-complete. The temporary registration capability remains an ordinary
business payload. Notifications owns expiry, single consumption, destination
ownership and replay results; ntfy owns credential persistence and recovery
after a lost completion response.

On the enhanced host, `/bb` discovers `experimental_p6rIdentity` and installs
the exact `handler` returned by `bindInvocation({ routeClass, handler })` through
native registration. The returned registration is generation-bound; each admitted
dispatch receives a fresh, opaque scope out of band after normal authentication
and schema validation. No serialized actor field or locally constructed scope
establishes identity. `forwardRpc(scope, destination, input)` fences the original
scope and destination generation before and after work. Unified
`accept({ source: scope | external, input })` prevents external work from
masquerading as a person scope. Missing binding fails explicitly.

On upstream, `/bb` creates a classified singleton scope and uses
`UpstreamDriver.forward` through the ordinary SDK. It checks before dispatch;
it cannot propagate trusted origin or interlock destination commits with the
original request. This limitation must remain visible in capabilities.

## External contributions and history

Agent Connect verifies its connection credential, captures its stable external
subject and presentation, and durably stores the exact `SendInput` plus
`ExternalAuthorInput` under one operation ID before calling `sendExternal`.
Subject, presentation, mode, thread and content are all part of immutable
operation identity. Credential rotation does not rewrite a pending operation.
Revoking the independent Agent Connect credential prevents new sends; receipt
lookup may reconcile previously accepted work without resubmitting it. Namespace comes from the
registered sending plugin, never from a caller-supplied person key.

Handle submitted/rejected/indeterminate separately. Use `lookupOperation` to
reconcile uncertainty; unknown lookup never justifies a replacement ID.
The public binding forwards the existing `/server` history reader.
`binding.server.history.contributions` maps native message/event IDs or explicit
references to normalized authorship. It receives `{ cursor, limit }` with every
query after the first and reports `traversal: 'continued'` until the exact query
snapshot is exhausted. `server.history.attempts` follows an operation or
contribution into bounded, execution-time provenance snapshots. Pending, partial,
unavailable and incomplete traversal remain explicit. Repeat identical text is
never a correlation key. Agent Connect retains observation timeouts, locks and
native stream reading; identity does not become an agent-call orchestration engine.

Upstream may yield unavailable mapping and partial/native submission evidence.
An adapter cannot manufacture exact correlation or transactional deduplication
from the selected baseline. Runtime compatibility tests must preserve native
messages/provider sessions while verifying additive fork provenance.

## Retained participants

Use the shared binding, including for background evidence reads:

```ts
const participants = await binding.background(invocation =>
  binding.endpoint.participants(invocation, { threadId, limit: 100 }),
);
// Preserve coverage, nextCursor and revision. Follow nextCursor with the same
// thread and limit; on conflict restart the query rather than mixing pages.
```

On enhanced hosts `/bb` requires public `threads.facetParticipants` and
`threads.events.list`. Missing required methods return `unsupported`; a source
outage returns `unavailable`. It never delegates to the obsolete host
`protocol.participants` implementation. Direct low-level `/host` adapters do
not own SDK reads and report participant history unsupported. Portable hosts
without the enhanced identity extension retain their documented singleton
identity/state behavior and unsupported participant history.

The reader exhausts paged native facet membership and retained
`client/turn/requested` snapshots in ascending native sequence through an initial
latest-request cutoff. It reuses the native-source actor decoder, preserves exact
canonical member keys and full stored identity/presentation, and accumulates
recorded author, editor and mentioned roles. Machines remain machines. No live
provider lookup, generation admission, text inference or display-name matching
occurs. Native mentions retain their old provider source without re-resolution.
Facet-only records have neither full identity nor roles, so they cannot fabricate
an author. Known native snapshots remain useful when facets or contribution
history have partial coverage; an unexplained native member is retained with
partial coverage.

Participants sort globally by their highest recorded role: author, then editor,
then mentioned. Within that role they sort by its first retained occurrence. This order is independent of facet order and an earlier
mention of a later author or editor. Roles deduplicate in author/editor/mentioned order.
Presentation uses the latest snapshot encountered in that ordered source
traversal. This is historical evidence, not a current-directory profile.

The same reader enriches requests through public `server.history.contributions`
when native authors are absent/null/asserted, or when any external or otherwise
unexplained facet member needs contribution evidence. In the latter case it
examines every retained request because facets provide no request correlation;
it does not guess which native author accompanied an external editor. Every
contribution continuation is followed within the read budget, preserving external
and person author/editor snapshots. A stored external person assertion is retained
even when its human key is absent from facets; that mismatch lowers coverage. Contribution mentions without any full
presentation snapshot remain an explicit coverage gap. Native-only threads whose
members are already explained make no per-prompt history probes. Those reads
remain `partial-history`: skipping an independent contribution source does not
prove that source exhausted. Pending/missing/unavailable contribution evidence
also leaves known native participants present with partial coverage. Malformed
snapshots and contradictory identity fields fail clearly.

Each list call makes one bounded traversal, with no retries, background tasks,
polling or cache. Bounds are 64 native event pages of 100 requests, 64 facet pages
of 100 members, 256 entries per native actor/mention array, 16,384 contribution
page reads of up to 200 items, and 8 MiB of retained attribution evidence. Exceeding
a bound returns `limit-exceeded`, never a falsely complete truncated page. Preview
queries accept up to 64 threads and use the same reader; `hasMore` describes
participant pagination separately from source coverage.

The public ports provide no atomic revision spanning facets, events and
contributions. A final latest-request check downgrades coverage on observed append
or rewind while preserving known authors; it does not trigger a full reread or
retry. `complete-history` requires all selected retained source sets exhausted,
all facet members explained by full role snapshots, no missing authorship and no
observed concurrent change. It describes retained evidence, not deleted history
or transactional snapshot isolation. Independent source changes that leave no
public revision witness cannot be detected atomically.

Output revisions hash the exact normalized evidence, membership, cutoff,
coverage and projection. Continuations bind thread, instance, limit, cutoff,
offset and revision, and recompute that bounded projection on each page. Changed
evidence returns `conflict`; a busy thread still yields its known authors on a
fresh query. Appends beyond the cutoff are excluded from the current traversal.
An append that changes observed membership or coverage invalidates continuation;
there is no promise of a frozen server snapshot across calls. The invocation
signal and binding disposal abort in-flight reads and prevent subsequent work,
even when a supplied port ignores its cancellation signal.

The public `/bb` regression uses synthetic structural SDK ports, including
129 retained requests with Cole only in native snapshots and no contributions,
405 requests/205 facet members, independent machine/editor/mention actors,
external history pagination, malformed sources, append/rewind, cursor invalidation
and cancellation. Its measured call count is five SDK reads and zero history
reads for the native-only 129-request case. A mixed 129-request fixture records
five SDK reads plus 129 sequential contribution reads; cancellation stops further
probes. Public events transfer full request payloads even though the reader retains
only attribution fields. Synthetic fixture byte/latency measurements do not bound
real prompt transfer cost or establish live performance. This establishes package composition
and bounded calls, not a live-host latency or deployment claim.

## Bring your own IdP

The operator selects one boundary plugin with `ProviderBoundaryConfigurationV1`
in host configuration. It names accepted ingress IDs, selected header/cookie
credential fields, resolver timeout and maximum session age. The provider owns
trusted issuer/audience settings, verification keys and directory acquisition.
Host request authority and ingress provenance are separate from unverified
credential bytes in `ProviderEvidenceV1`. An ingress ID is host-established;
a request header cannot assert it. Proxy deployment must enforce its trust
boundary. Core has no Tailscale/Pomerium-specific verifier.

The provider calls `binding.registerProvider(provider)` during factory setup,
before any user identity resolves. The returned `ProviderRegistrationV1` supplies
normalized `person(issuer, subject)`, an opaque generation, a read-only configuration
snapshot and lifecycle events; it is not a request lease. Host structural/config
readiness is mandatory. Optional `provider.validateReadiness` checks only the
candidate configuration/resources with a deadline and signal; it receives neither
request evidence nor credentials and cannot resolve a person. Only the enhanced
host activates it after successful plugin activation. Failure retains prior
resources and cleans up the candidate. Retirement is generation-checked, so stale
disposal or invalidation cannot affect a replacement; registration disposal removes
only that current registration. Canonical keys remain stable across generations for
the same issuer/subject; undeclared issuers are rejected.

For Tailscale, selected evidence includes the needed Serve fields and an
established ingress identity. For a gateway with signed assertions, it includes
the selected assertion bytes and request facts. Provider verification returns
issuer, subject and presentation. Host bounds resolver work and ignores late results. Provider evidence freshness
may inform enrichment, but does not expire accepted invocation attribution or
reject ordinary operations. Rejected, unavailable and not-applicable results
remain distinguishable and fall back to a stable machine in this deployment.

Directory search and lookup are independently optional. Resolution presentation
supplies the current actor even with neither callback. Current-self profile
lookup can use that session snapshot; other missing capabilities return
unsupported. Provider lookup/search results carry snapshot revisions; cursors
are generation/snapshot-scoped and stale cursors fail explicitly. Provider
refresh publishes directory invalidation only after swapping a usable snapshot.
Provider invalidation refreshes enrichment state. It must not revoke accepted
attribution or require fresh person evidence for ordinary work; request
cancellation and plugin disposal retain their separate lifecycle meaning.

## Native and independent roots

For a native React root, `useBbIdentityConnection()` receives its inputs from
public SDK hooks: `useRpc`, `useRealtime`, and `useRealtimeConnectionState` at
core snapshot `960255b98ce3dccdcb5754eb67a7f989236602a1`. It uses the plugin's
scoped RPC methods and realtime channel, then calls authoritative bootstrap/load
after a reconnect. Realtime invalidates; it never supplies a state replacement.

`PluginContentScriptContext` supplies an explicit plugin identity/generation and
abort signal but no imperative native RPC client. Its owner constructs
`createIdentityFetchConnection({ endpoint, fetch, signal: context.signal })`,
then `createIdentityClient({ connection })`, starts it once, and disposes that
one connection once with the content script. `createStateTransport({ connection,
resource })` borrows it for every resource. Each independently mounted Context
has its own view. Sharing a module singleton is never required.

The endpoint is the owning plugin's HTTP base URL, ending with `/`, for example
`new URL('/api/v1/plugins/' + encodeURIComponent(pluginId) + '/http/', location.origin)`.
Use the configured BB base URL when the deployment has a path prefix. Host HTTP
authentication applies; clients use existing credentials and no actor header.
The following reserved logical operations define the HTTP request/response
mapping. The public `bindBbIdentity` automatically registers their native RPC
equivalents. A fetch consumer explicitly registers the corresponding handlers
through `binding.http.route`, calling `binding.endpoint` with the issued invocation.
Feature HTTP routes retain their existing paths and DTOs. The binding owns
response completion/cancellation; no browser actor header supplies authority.

| POST route | JSON input | JSON response |
| --- | --- | --- |
| `bb-identity/v1/bootstrap` | `{}` | `Result<ServerSession>` |
| `bb-identity/v1/selfProfile` | `{}` | `Result<IdentityProfile>` |
| `bb-identity/v1/search` | `DirectoryQuery` | `Directory.search` result |
| `bb-identity/v1/profiles` | `ProfileQuery` | `Directory.getMany` result |
| `bb-identity/v1/participants` | `ParticipantQuery` | participant page result |
| `bb-identity/v1/participantPreviews` | `ParticipantPreviewQuery` | preview result |
| `bb-identity/v1/state/load` | `StateReadRequest` | `Result<StateRead<T>>` |
| `bb-identity/v1/state/save` | `StateMutation<T>` | `Result<StateSave<T>>` |
| `bb-identity/v1/state/reconcile` | `StateLookupRequest` | `Result<OperationLookup<StateOutcome<T>>>` |

For native scoped RPC, the slash-separated HTTP paths are logical connection
operation names, not literal BB RPC method names. The public state bridge
maps `bb-identity/v1/state/load`, `/save`, and `/reconcile` to
`bb-identity.v1.state.load`, `.save`, and `.reconcile`, respectively. A native
connection applies this explicit mapping; a fetch connection retains the HTTP
paths above. Core RPC method validation does not permit slashes. Native state
registration is included in the published `/bb` binding and has connected
SQLite rollback/retry witnesses.

State routes dispatch only to registered resources, selected by address
collection, and reject foreign instance/plugin IDs. They use the resource codec
on requests and responses. Expected session assertions are checked for reads
and writes. Reconciliation is an evidence read: a current same-actor scope may
look up an old operation without reopening or resubmitting it.

The connection owns two observable health links: identity and state. A state-route
failure can suspend writes while the session remains ready; a reconnect or reset
refreshes the current actor and checks the captured owner for consistency. Each observed resource controller
independently reloads or reconciles its own address before writes resume. Native realtime carries only scoped
invalidation. Explicit fetch roots have no retained replay protocol; they
revalidate after an observed transport failure or caller lifecycle recovery.

All payloads decode from unknown. Library-owned validation errors use Result;
non-JSON HTTP/auth failures become unavailable/unauthenticated transport errors,
never empty/default data. Local AbortSignals are not serialized. The state source
slice exercises its service, transport, controller and feature-owned storage
seams; it is not evidence that a native core, provider, SDK binding, or packed
consumer has implemented this protocol. Those remain separate gates.
