# Contract compatibility proof — November 14, 2026

Scope: unpublished `0.2.0-dev.0` contract source, not plugin adoption or a live
mapping migration. V1 source (`src/index.ts`, `bb.ts`, `testing.ts`) is unchanged.
All new APIs use explicit `/v2` entries. V1 package/consumer pins are unchanged;
the workspace lock adds the source candidate's identity dependency and resolves
old 0.1.1 consumers separately. No credentials were acquired.

## Executed package proof

`npm ci`, `npm run test --workspace @phosphorco/bb-people-accounts` and
`npm run typecheck --workspace @phosphorco/bb-people-accounts` exercise emitted
JS/declarations with pinned Bun 1.3.14, SDK 0.6.52 and identity 0.5.0.
The package suite has 30 passing tests: all 16 existing v1 tests and 14 new v2
tests. New compile fixtures reject unbranded display-name keys and a nonexistent
v2 credential API while accepting the actual public state resource type.

The real SDK fake host dispatches the production registration and client. This
proves intended-owner RPC calls, both association directions, distinct
missing/unavailable/partial/conflict states, ambiguity without human merging,
namespace/echo/revision/cursor/size checks, supplier isolation, finite discovery,
late generation fencing, deadlines/disposal and the emitted conformance kit.
A broken reverse supplier fails conformance. V1 and v2 registration coexist on
the same host, and v2 discovery never calls the old credential port.

An ordinary isolated npm tarball installation also imports all six public
entries with registry bb-identity 0.5.0 and SDK 0.6.52, runs the descriptor/client
smoke checks and compiles the emitted branded declarations with TypeScript
5.9.3. A separate SDK 0.5.29 installation retains the old v1 imports; this is
installation/import proof, not an old-host runtime acceptance claim.

The unchanged People Accounts plugin's 29 factory/UI/CLI tests also pass with
its existing 0.1.1 dependency. Repository-wide typecheck and build commands pass.
The repository-wide test command is not green: unmodified worker tests compare
Mac `/var` versus `/private/var` paths, browser suites lack their pinned
Playwright executable, and Turn Results' gallery visibility integration fails.
Those failures are outside the changed package; no test or source was weakened
to hide them. Some unchanged plugin builds also warn about their existing SDK
pin/CLI mismatch; no running plugin artifact was promoted.

The public `createIdentityWireFake` runs the production identity binding/state
bridge with `createLinksResource` and the package codec. A captured-owner write
commits before a simulated lost response, reconciles the original operation,
and retains the same owner/value. An attempted `allowEmail` link value is
refused without changing that state. This is shared package composition using
fixture storage, not a production SQLite/reverse-index or multi-person editor
proof. A collaborator lookup using this source's synthetic wire-fake directory
returned `not-found`; that fixture does not establish collaborator switching.
The future generic-host node still owes actual actor/target-switch and index
transaction proofs; the contract does not invent an alternate identity lookup.

## Concrete legacy seam

Keep the three fixed v1 RPCs at their original `people-accounts` target and keep
old clients calling them directly. The current `PeopleAccountsSupplierPort`
already isolates roster, resolution and credential callbacks; its existing
registration projects the established wire shape and retains fixed errors.
The SDK coexistence test proves it can remain registered beside the v2 roles
without changing old consumers or putting credentials in the new contract.

During later host adoption, preserve that registration in a named legacy v1
adapter. GitHub-specific storage, token settings and policy remain there until
the GitHub feature owns the replacement and a separately commissioned protected
handoff selects one active credential owner. Adapter callbacks can use narrowly
defined feature-owned SDK RPCs after those exist; there is no general proxy or
credential forwarding added by v2. Compare roster/alias/summary behavior and
token-slot precedence before switching. Do not remove the old endpoint for
unidentified consumers or infer safe handoff from schema tests.

Slack keeps its team/user subjects and revisioned frozen message associations.
Macro keeps causal selection, explicit unattended accounts and its separate
email policy. Neither plugin is modified by this contract slice. The current
local Slack person-link suite was attempted but its organization workspace lacks
`@phosphor/bb-reference-publication`; it did not reach the tests. Real Slack
factory/adoption acceptance remains in its planned node, not a claimed result
of the generic association fixture.

## Actual Macro export probe

`tools/prove-macro-boundary.mjs` takes an explicit Git repository and full
commit. It loads only the published pure `capabilities.ts`, `contract.ts` and
`email-access.ts` from Git objects, not the incomplete local Macro folder or a
live plugin. Global fetch is disabled; inputs, account IDs and mail payloads
are synthetic. Run with Bun 1.4.4 (its runtime loader supports these virtual
module imports); the pinned 1.3.14 package suite is independent of this probe.

```sh
bun packages/bb-people-accounts/tools/prove-macro-boundary.mjs \
  --plugins-repo /path/to/bb-workspace/plugins \
  --revision c6a37818d796ed36028b2d709a7ee707b04b9c11
```

The probe passes shared mapped-account selection, a positive fresh Macro
request, eight denial variants (linked outside-Macro, grouped, expired, edited,
wrong actor after relink, wrong chat, deleted and unavailable source), bounded
transport expiry and saved mail/shared-result admission. Its output fingerprints
all loaded exports. This is a synthetic test of the existing admission seam,
not native search/mailbox access, host authorization, retained model-history
erasure, a new freshness implementation or deployment proof. Search exclusion,
Slack/GitHub real workflows and all live migrations remain unchanged and must
be exercised when those adopters are commissioned.
