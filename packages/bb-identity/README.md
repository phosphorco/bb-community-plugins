# @phosphorco/bb-identity — portable plugin identity and state

> Policy update — 2026-09-09: the approved [Identities and multiplayer ADR](../../../docs/adrs/2026-09-identities-and-multiplayer.md)
> governs this trusted shared deployment. Use verified people when available,
> applicable carried attribution next, and a stable machine actor otherwise;
> missing or failed person verification must not block ordinary operations.
> Never relabel fallback as a verified person or redirect pending personal-state
> writes to another owner. Independent access checks and data validation remain.
> Earlier rejection requirements below are superseded; versioned API descriptions
> and test receipts remain historical evidence, not proof of ADR implementation.


Plugin authors use this package for request identity, view-as, personal state,
external contributions and provenance on both single-user BB and the enhanced
fork. Public `/bb`, `/client`, and `/react` entries are generated and have packed
consumer tests. `/bb` provides native RPC/state and request-scoped HTTP registration;
`/react` exposes its declared hooks and Provider/Context.

Start with the [progressive authoring skill](../../../.agents/skills/bb-identity/SKILL.md),
then the relevant [consumer recipe](CONSUMERS.md), and [PACKAGING.md](PACKAGING.md) for
build/host verification. Existing exports and green local tests do not imply
that real provider composition, every feature workflow, or identical-artifact
base/fork deployment has passed. Historical design/review sections below explain
decisions; the closure ledger owns current completion claims.

The [master plan](../../../fork/plans/bb-fork-master-plan.md) governs the design.
All collaborators have equal information access. The package separates actor,
viewed subject and operation target without adding permission tiers. Prompt
Stacks, notification policy, sidebar models, bulk execution and a generic
migration engine are outside this package.

## Start here: the problem and the review standard

This package lets a plugin author build one useful feature for ordinary
single-user BB and collaborative BB. The feature should not know whether its
current person came from Tailscale, another IdP, or the upstream default user.
The fork provides host-owned identity facts and authored operations; this
package supplies adapters and reusable server/state/UI mechanics; feature
plugins keep their own product logic and storage.

Two different plugin authors must be served:

- **Feature authors** bind BB once, use request identity and view-as primitives,
  and supply their feature schema, persistence and conflict policy. They should
  not implement identity discovery, request forwarding, session invalidation or
  React identity lifecycle machinery themselves.
- **IdP authors** supply verification and optional directory integration for
  their own issuer(s). They should not patch the feature plugins, invent BB's
  canonical keys, or depend on a hard-coded Tailnet provider name.

Reviewers should begin with this README, follow the entry-point map, then trace
complete consumer workflows through the declarations and the actual public BB
SDK. The intended behavior below is a requirement to challenge, not evidence
that the declared functions can implement it. Prior review dispositions record
proposed fixes, not implementation acceptance. Typechecks do not prove feasibility.

A sufficient public API has a closed path: identify every supplied input, its
source, the callable operation, the result, the next consumer, and the owner of
cleanup/recovery. If the path requires an undeclared bridge, direct fork fields,
private SDK access, a type assertion hiding incompatibility, or substantial
identity glue in a feature, identify that as a gap. Also call out public types
and responsibilities an ordinary author should never have to understand.

Feature authors should use the task-specific consumer recipe and its public
declarations. Adapter reviewers additionally inspect `/host`; test and release
owners use `/testing` and [PACKAGING.md](PACKAGING.md). The
[master plan](../../../fork/plans/bb-fork-master-plan.md) supplies constraints and history, not hidden
API definitions needed to use the package.

## Review history

The design evolved through several reviews and SDK snapshots. For historical
assumptions, see the archived review disposition. Current contracts live in declarations
and recipes; plugin authors do not need the old review sequence to use
this package. Exact target SDK verification is an explicit generated job, separate
from ordinary installed-peer checks.

## Current implementation direction

Core supplies attribution and invocation lifecycle context separately from
package composition, including a persisted storage-scoped
`experimental_p6rIdentity.instanceId`. Identity forgery resistance is explicitly
not a supported guarantee in this trusted deployment. The package rejects mismatched instance facts
and owns target/state validation; features still own atomic storage, schemas,
conflict decisions and legacy-owner mappings.

The internal [portable server binding](bb-binding-runtime.ts) composes normalized
invocations, endpoint/state registration and cleanup. The headless
[client-state binding](client-state-binding-runtime.ts) owns controller/view
lifetime and draft recovery while borrowing its client and connection. Both are
exposed through the bounded public entries below. Their isolated packed-artifact
and mounted-browser checks pass; actual consumer adoption and identical-plugin
base/fork proof remain separate gates.

The internal [RPC foundation](bb-runtime.ts) preserves native bound handlers and
owns their exact registration cleanup. The internal [state RPC bridge](state-rpc-runtime.ts)
uses it to dispatch registered resources, validate actor/session/address, and
revalidate request plus resource lifetime inside the feature transaction.
These are implementation components of the eventual bind-once surface, not new
public requirements for feature authors. HTTP paths map explicitly to legal
dotted native RPC methods; see [the wire contract](CONSUMERS.md).

Keep the first real-consumer goals visible: Thread Progress for personal state
and view-as, Agent Connect for external contribution acceptance, then
Notifications as a third consumer. Offline fixtures establish specific safety
properties but do not replace those migrations or the master plan's
upstream → fork → upstream → fork authored-session compatibility proof.

## Entry points

| Import suffix | Runtime/declaration status | Responsibility |
| --- | --- | --- |
| root | Runtime: [index-runtime.ts](index-runtime.ts); declarations: [index.d.ts](index.d.ts), [model.d.ts](model.d.ts) | Portable keys, profiles, errors, codecs, provenance, receipt evidence and DTOs |
| `/bb` | Packaged runtime: [bb-entry-runtime.ts](bb-entry-runtime.ts); narrow declarations: [bb.d.ts](bb.d.ts) | `bindBbIdentity(bb)` returning `Result`; native RPC/state/server/endpoint/provider/tool/background composition and HTTP response lifetimes. |
| `/host` | Runtime: [host-runtime.ts](host-runtime.ts); declarations: [host.d.ts](host.d.ts) | Structural optional host protocol and package-owned normalization; integration/test ports |
| `/server` | Runtime: [server-runtime.ts](server-runtime.ts); declarations: [server.d.ts](server.d.ts) | Request actions, read/write targets, live commit validator and client endpoint |
| `/state` | Runtime: [state-runtime.ts](state-runtime.ts); declarations: [state.d.ts](state.d.ts) | Feature storage, immutable operations, drafts, conflicts and synchronization; packaged core/service/transport/controller with isolated-consumer proof |
| `/client` | Packaged browser runtime: [client-entry-runtime.ts](client-entry-runtime.ts); declarations: [client.d.ts](client.d.ts) | Headless one-root connection, freshness, views, directory search and state/view binding; no React or BB SDK import |
| `/react` | Packaged browser runtime: [react-entry-runtime.ts](react-entry-runtime.ts); declarations: [react.d.ts](react.d.ts) | Provider/Context, native connection/client hooks, state/view/recovery hooks, shared avatar/label/picker/status controls |
| `/testing` | Runtime: [testing-runtime.ts](testing-runtime.ts); declarations: [testing.d.ts](testing.d.ts) | Layer harnesses (adapter, connection, state storage, clock), the `createIdentityWireFake` app/client fake and the `defineStateStorageConformance` suite; see [Testing kit](#testing-kit) |

External sends have an explicit rendering ownership choice at binding
construction. `bindBbIdentity(bb)` defaults to `externalMessageRendering: "host"`:
the binding adds one escaped sender envelope around the supplied prompt before
portable or enhanced acceptance, while the external author subject remains
structured provenance. A producer that already owns its sender envelope and
`<attached>` context opts in with:

```ts
const identity = bindBbIdentity(bb, { externalMessageRendering: "producer" });
```

Producer mode preserves the supplied prompt and still registers the external
source for provenance. This is a construction-time option, not per-send wire or
author metadata, and no mode is inferred by inspecting prompt text. Retries of
operation IDs reserved before a rendering upgrade retain the host's existing
idempotency/uncertainty contract; this binding has no durable cross-version
marker to identify the old rendering.

On an enhanced host, producer mode also requires the optional
`experimental_useProducerMessageRendering(): void` identity-protocol capability.
The binding enables that plugin-generation-scoped SDK rendering policy once at
construction and returns a compatibility error when an older enhanced host does
not provide it. Capability-absent portable upstream does not need this hook.

The package's public SDK binding imports `@get-bb/plugin-sdk`; generic layers
import neither that SDK nor React. Feature authors supply `bb`, not an
`UpstreamDriver`. Low-level ports remain for the binding implementation and tests.
Core implements a structural protocol without importing this package or its
private brands. Provider-directory callbacks return issuer/subject records;
the package normalizes references and composes directory behavior.

## Testing kit

`/testing` is source conformance for consumers' own tests, not native host
proof. Two additions let a plugin prove its integration from its own tree:

- `createIdentityWireFake({ host, mode, resource, policy? })` is a wire-level
  identity server for client and app tests. Pass a fresh SDK fake host
  (`createFakePluginHost` from `@get-bb/plugin-sdk/testing`). The fake runs the
  production `bindBbIdentity` binding, endpoint and state bridge on it, with
  state in `createStateStorageHarness`, so bootstrap, directory and
  `bb-identity.v1.state.*` answers come from the real server code under host RPC
  semantics. `rpc` is a handler map for SDK `testing/app`
  `renderSlot(…, { rpc })`; forward `onRealtime` publications to the slot's
  `emitRealtime`. `mode: 'single-user'` uses the upstream singleton path;
  `'multi-user'` adds `switchActor`, `addPerson` and `personKey`. Controls:
  `failNextLoads`, `loseNextSaveResponse`, `holdLoads`, `holdSaves`,
  `invalidateExternally`; observations: `calls`, `saveInputs`, `committed`.
  The SDK app-hook host itself is the SDK's job (`testing/app`), not this package's.
- `defineStateStorageConformance({ test, open, address, values })` registers the
  `AtomicStateStorage` contract checks against a feature's real storage: stable
  empty versions, one initialize winner, unchanged and conflict outcomes,
  immutable address-scoped operation ids with exact replay, expiry tombstones,
  commit-time rejection that leaves no record or outcome (inside the
  transaction when `insideCommit` is supplied), and restart durability through
  `reopen`. A check you cannot run is recorded with `skip: { restart: reason }`;
  a skip is a visible gap, never a pass.

```ts
import { test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { defineStateStorageConformance } from '@phosphorco/bb-identity/testing';
import { createFeatureStorage, featureAddress } from '../storage.ts';

defineStateStorageConformance({
  test, values: [{ theme: 'dark' }, { theme: 'light' }], address: featureAddress,
  open: ({ now }) => {
    const db = new Database(':memory:');
    return { storage: createFeatureStorage({ db, now }), insideCommit: () => db.inTransaction, close: () => db.close() };
  },
  skip: { restart: 'in-memory database' },
});
```

## Bring your own identity provider

The public authoring entry is `bindBbIdentity(bb)`, with one explicit
factory-time Result unwrap before `binding.registerProvider(provider)`.
`IdentityProvider`, `ProviderEvidenceV1`, `ProviderDirectoryRecord`, and
`ProviderRegistrationV1` are exported as types from `/bb`; their declarations
live in [host.d.ts](host.d.ts). This is a pluggable contract, not a fixed
dependency on the existing Identity Boundaries plugin.

| Author supplies | Package/host supplies | Required behavior |
| --- | --- | --- |
| Declared issuer IDs and plugin-owned configuration | Registration in the selected boundary's plugin lifecycle | Registration can run before any person is resolved; no login/bootstrap cycle |
| `resolve(evidence)` returning issuer, stable subject and presentation, or an explicit non-success result | Trusted ingress facts, cancellation and a bounded deadline | Preserve not-applicable, rejected and unavailable; no false single-user fallback |
| Optional paged `directory` and bounded `lookup` callbacks returning issuer/subject records | Canonical key construction and normalized directory/profile access | Feature plugins do not learn the provider's RPC shape or namespace |
| Candidate-local readiness plus provider refresh/disposal integration | Generation-scoped registration and replacement semantics | Readiness cannot resolve a person; failed reload retains the active provider; stale disposal cannot remove a replacement |

The deployment selects one boundary plugin; that plugin may route among several
issuers. This draft does not introduce arbitrary priority competition between
several simultaneously active boundary plugins. A resolver-only provider is a
valid intended case: current request identity still works, while unavailable
directory features are reported explicitly. Search and lookup remain independently
optional; self presentation comes from the resolved session.

The existing Tailscale-backed Identity Boundaries implementation is one concrete
consumer. A second review scenario must use a different IdP—for example a plugin
verifying identity supplied by an OIDC-aware trusted gateway. Verification,
issuer configuration and credential management remain the provider's work.
The review must identify exactly how required evidence reaches `resolve`, which
facts BB establishes, and any missing registration/configuration contract. Draft 3 replaces generic attributes with a versioned evidence envelope,
operator-selected credential fields and host-established ingress facts.
[The IdP recipe](CONSUMERS.md#bring-your-own-idp) states lifecycle and evidence ownership.

On ordinary BB without the required identity boundary, provider registration
returns an explicit unsupported result. Feature plugins still run with the
default user. Building a new login UI, token issuer or authentication product is
not implicitly added by the BYO-IdP interface. If a provider needs additional
host evidence or lifecycle support, identify the smallest generic missing
operation rather than placing that provider's implementation in core.

## Consumer feasibility walkthroughs for perspectives

Use only declared public operations for the package side of each walkthrough.
Small compile-only consumer sketches are useful; do not implement the package
or rewrite plugin source to make a walkthrough pass.

| Consumer task | Walkthrough must reach | Source to inspect |
| --- | --- | --- |
| A new plugin stores one person's preferences | Server bind → client bootstrap → UI context → ordinary read/write → same behavior for upstream's default user | [binding](bb.d.ts), [state](state.d.ts), [Thread Progress](../../plugins/thread-progress/server.ts) |
| View Alice's state while Cole is acting | View switch → target selection → explicit write policy → actor/session change with dirty edits → recoverable outcome | [client](client.d.ts), [React](react.d.ts), [Progress UI](../../plugins/thread-progress/components/progress-inbox.tsx) |
| Link a phone through another plugin | ntfy handler → request-bound Notifications call → correct owner/actor → completion or expiry on both hosts | [ntfy](../../plugins/ntfy/server.ts), [Notifications](../../plugins/notifications/server.ts), [server](server.d.ts) |
| Accept an external contribution | Credential check → external send → receipt/uncertainty → read normalized author data and correlate the accepted work | [Agent Connect send](../../plugins/agent-connect/server.ts), [reader](../../plugins/agent-connect/message-api.ts), [correlation](../../plugins/agent-connect/call-events.ts) |
| Bring a different IdP | Register without a resolved user → inspect evidence → resolve issuer/subject → canonical reference → optional directory → refresh/reload/dispose | [provider interface](host.d.ts), [current provider](../../plugins/identity-boundaries/lib/provider.ts) |
| Reuse across separately bundled plugins | Published imports → independent React roots → explicit shared data access without shared view state → unsubscribe/reload | [packaging](PACKAGING.md), [Agentation root](../../plugins/agentation/lib/toolbar.ts) |

For each task, distinguish ordinary plugin business/storage code from identity
infrastructure the package promises to supply. Report whether it is expressible
now, needs a declaration change, needs a generic enhanced-host operation, or
cannot meet the stated guarantee on the selected upstream baseline. Include an
author-comprehension verdict: can someone starting here discover and correctly
use the intended path without reading our conversation?

## Consumer composition

Server factories call `bindBbIdentity(bb)` and handle its Result. The binding owns its adapter,
endpoint and request wrappers and registers cleanup through `bb.onDispose`.
Its `rpc.register` takes the normal public SDK contract plus handler descriptors
that declare interactive, background or external operation intent. That intent
cannot override stronger host-provided origin facts. Use `http.route(method, path, {origin, handle}, options)` for existing HTTP APIs.
Interactive routes use local host authentication; external routes authenticate
their feature credential before effects. The invocation remains live until the
response body completes or cancels, and plugin disposal aborts it.

The binding reserves versioned identity and state routes inside its own plugin
namespace. `useBbIdentityConnection()` consumes the public native scoped RPC,
realtime and connection-state hooks; `useBbIdentityClient()` owns a client over
that one connection. Neither uses `BbContext` to guess a route. Headless and
content-script roots instead call `createIdentityFetchConnection` with an explicit
endpoint, fetch and root signal, then create one client and any number of borrowed
state transports from that connection. The complete source and cleanup recipes
are in [CONSUMERS.md](CONSUMERS.md).

The package supplies `IdentityViewPicker`, `IdentityViewStatus`, `IdentityAvatar`
and `IdentityLabel`. The picker/status borrow the enclosing Context; avatar and
label render supplied normalized presentation without fetching. Features render
their product-specific conflict and retry UI from view snapshots/actions:

```tsx
<BbIdentity.Provider client={identityClient}>
  <BbIdentity.Context>
    <IdentityViewPicker labels={{
      trigger: 'View as', self: 'My settings', viewingFallback: 'Another person',
      dialog: 'Choose a person', search: 'Search people', noResults: 'No people found',
      searchUnavailable: 'People search is unavailable',
    }} />
    <IdentityViewStatus labels={{ viewing: 'Viewing another person', returnSelf: 'Return to my settings' }} />
    {/* Feature-owned state, conflict and recovery controls. */}
  </BbIdentity.Context>
</BbIdentity.Provider>
```

A manually created client is owned by its caller; Provider borrows it. Keep the
Provider mounted when a native client is temporarily null: its optional fallback
replaces children while the Provider retains pending preservation and failure
ownership. Keep feature draft storage above replaceable Context children. Context
owns a view it creates, or borrows an explicitly injected view. Missing Provider
is a setup error, never single-user fallback. Separate plugins may share an
explicit compatible client transport while retaining independent views; no
cross-bundle React singleton is assumed.

`useIdentityStateBinding` returns `null` while committed acquisition is pending,
then connects that default Context to the headless
`bindIdentityState`: identity changes, guard registration, controller ownership,
reconnect and immediate detach live in the package. Features provide a shared state resource, storage and conflict policy; a
custom controller factory remains a low-level option. The packaged state HTTP
adapter handles repeated routing, decoding and publication. Recovery commands
remain reachable through the binding and reject stale controller tokens. View
guards participate in the same transition lifetime; `/bb.http.route` supplies
request-bound server HTTP handlers. Feature-specific conflict/retry UI remains
feature-owned. See the public declarations for required component props and
method arguments.

## Core semantics

**Actor and target.** Cole viewing Alice remains Cole. Read target requests need
no write expectations. A write requires a write-intent target, actual actor and
server session stamp, plus the expected subject. Authored sends also require
actor/session expectations. They are stale-intent assertions, not credentials.
A plugin can explicitly allow collaborator edits while recording the actual
editor. Merely switching perspective never changes authorship.

**Freshness.** Server session DTOs include instance, actor, mode, capabilities
and a stamp. The stamp rotates on actor/provider discontinuity, including
A→B→A, while ordinary bootstrap refresh keeps the same continuity stamp.
Reconnect suspends writes until revalidation; it may reuse a stamp only if the
host proves continuity. Client load/transition generations fence stale results.
Owner-session IDs separately distinguish local controller incarnations.

**Default owner.** Without identity support, bindings use one reserved `local`
storage namespace and default identity, equal across plugin IDs and recreated
clients. This namespace is scoped by the backing host store, not a globally
unique person. Explicit configuration can select another stable namespace.
Hostname, browser ID, package instance and a random ID per plugin are not
sources of ownership. Merging several host stores or toggling identities needs
an explicit feature mapping. Malformed/unsupported extensions and removed or
unavailable providers never become capability absence.

**Provider lifecycle.** One selected boundary plugin may route its declared
issuers internally. `ProviderRegistrationV1` exposes an opaque generation,
its immutable non-secret configuration snapshot and normalized `person`; it is not a
request lease. Each invocation gets a fresh core-only active-provider lease with
its own signal. The host's structural/configuration readiness is mandatory;
optional provider-local readiness receives its staged generation, configuration, deadline and signal but
never request evidence or credentials. The enhanced host publishes the complete
registry/routing generation before any synchronous callback or abort observation,
then atomically swaps a ready candidate. It retains the predecessor on every
candidate or activation failure and generation-checks retirement. Registration
disposal removes only its still-current registration, never the plugin generation.
Resolver deadlines and late results discard person evidence. The target shared-host
policy uses carried or stable machine attribution so ordinary operations continue. Provider-owned signing-key refresh
does not blanket-invalidate sessions; it explicitly signals an authentication
discontinuity when verified facts warrant it. Directory search and lookup remain
independently optional and report unsupported when absent. These enhanced-host
guarantees must not silently reuse an operator or person namespace on provider
failure. The pending machine fallback is an explicit actor and storage subject,
not a claim that the enhanced capability is absent.

The enhanced raw host protocol returns `ForkProviderRegistration`, whose successful
`person` values are wire/plain-string shaped. The adapter validates and brands that
result before returning public `ProviderRegistrationV1` from `/bb`; provider authors
never receive `Wire`. This keeps core independently constructible without leaking a
package-private key brand across the raw boundary.

**Acceptance.** Upstream supports a check immediately before dispatch and native
submission evidence; the adapter cannot interlock with its internal transaction.
An upstream receipt therefore has no invented acceptance timestamp or contribution
IDs and retains whatever native delivery/queue/turn IDs were actually returned.
The fork checks the live handle in durable acceptance and can return structured
receipts. An operation is scoped to instance/plugin and bound to its immutable
payload, including the external author snapshot for external sends. Enhanced receipts have explicit retention. Reconciliation can read a
receipt after its request context is no longer live without resubmitting the operation.
Unknown/retained-outcome lookup never becomes proof that an earlier operation cannot
still commit.

**Nested calls.** `PersonRequest.callPlugin` forwards the live request through
an enhanced host-bound path. On upstream it uses the one-user convention with
ordinary SDK calls, without claiming transport-origin or transactional lifetime
guarantees unavailable there. Background wrappers establish explicit non-person
work. This distinction is declared, not hidden behind an actor-key payload.
The exact target SDK binding and unwrapped third-party call behavior remain
integration proofs; independent route credentials remain separate from attribution.

**Provenance.** Ordered attempt input groups refer to original contributions,
interaction resolutions and generated context. Known provenance contains every
referenced contribution snapshot as of that attempt; later edits cannot change
it. Partial/unknown provenance is explicit. Participants aggregate roles across
retained visible durable history, including external authors and mentioned-only
people. Queue-only drafts are not participants. Pages and previews report
coverage. Profile snapshots for mentions need no invented authorship evidence.

## State and transition semantics

- The server captures target facts and lifecycle signal for `CommitValidator`.
  `createStateService` receives that validator explicitly. It validates write
  intent, actual actor/session, subject, instance/plugin/collection/record and
  schema inside the synchronous local storage transaction, immediately before
  mutation, with no await through commit. This boundary is same-process only;
  a remote storage/host process needs a separately proven protocol.
- Deduplication precedes CAS. Same operation and payload replays the original
  outcome; changed payload under that ID is invalid. Receipts and records commit
  atomically. An old receipt cannot regress the client's newer acknowledged state.
- `OperationLookup` separates final, pending, absent-final and unknown/expired.
  Even absent-final permits only the same immutable operation; it does not permit
  replacing an uncertain operation with a new ID while the old one could arrive.
- Draft checkpoints hold original acknowledged base, latest desired value and
  generation, and the entire exact in-flight mutation. Checkpoint before dispatch.
  New local edits never replace that submitted payload. Draft keys include the
  controller incarnation; conditional deletion cannot erase a newer checkpoint.
- Conflict policy handles every remote divergence while dirty, including loads,
  reconnect and epoch changes. The original base, local desired value and remote
  record are exposed with a conflict token scoped to the controller incarnation.
  A later divergence supersedes that token even before the controller changes.
  Acknowledgments apply only to their submitted generation. CAS alone cannot
  compensate for implicitly rebasing an old document.
- Initialization has its own mutation kind. A competing initializer's record
  wins; defaults never automatically rebase. Empty versions are stable; resetting
  or recreating a record changes epoch. Unchanged results require matching schema.
- Mandatory identity invalidation immediately stops edits, timers and stale
  dispatch. Cleanup is unconditional; draft persistence is fallible and separate.
  Unpersisted intent reaches a recovery callback. Discard cannot recall accepted
  writes. Flush retries are bounded. Optimistic edit success does not promise
  crash durability: only completed checkpoints do, including before dispatch.
- Voluntary transitions first inspect all guards without destructive changes,
  then prepare/flush/persist, then commit the selection synchronously after a
  freshness check. A failed or superseded transition cannot partially discard
  another editor's draft. Completed saves are not rolled back. Post-selection
  draft cleanup is conditional and cannot delete newer intent.
- Default voluntary policy is block with an explanation. During outage, the
  last-ready view may remain visibly stale/read-only while edits are suspended.
  Controls provide loading, empty, error, retry and blocked feedback; focus stays
  on failure and is restored when a successful reset removes the banner.
- Migrations remain feature-adapter obligations: scope mappings to the feature,
  compare source/destination versions atomically, reject unresolved collisions,
  and share mapping policy between import and runtime legacy reads. Unused
  `MigrationPlan`/`InteractionProvenance`/conformance-report exports were removed.

## Verification and remaining evidence

The archived review disposition records all seven panel results.
[Consumer paths](CONSUMERS.md) cover preferences, recovery, nested requests,
external reads/correlation, BYO IdP and independent roots through public declarations. The
[packaging contract](PACKAGING.md) specifies library generation and artifact
checks without editing generated manifests.

From the plugins repository:

```sh
node_modules/.bin/tsc --noEmit --strict --skipLibCheck false \
  --module nodenext --moduleResolution nodenext --target es2023 \
  --lib es2023,dom --types react \
  packages/bb-identity/*.d.ts packages/bb-identity/type-tests/*.test-d.ts
```

Compile-only assertions check ordinary read ergonomics, read/write separation,
public SDK binding, raw structural handle construction and signal-free query
DTOs. Runtime tests cover extension absence/outage classification, raw-to-public
provider normalization and readiness, scoped/external acceptance, and final
lookup decoding. Later conformance must use a packed artifact with two
independently bundled UI consumers and real upstream→fork→upstream→fork
sessions. Preserve native content, provider references and upstream grouped-edit
restrictions in that proof.
