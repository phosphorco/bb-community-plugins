# @phosphorco/bb-people-accounts — package 0.1.0-attribution.0 / wire v1

People Accounts routes a piece of work (a pull request, a commit) to the people
it is done for: which bot account opens it, which humans it is assigned to, and
which Co-Authored-By trailers it carries. A supplier plugin (`people-accounts`)
keeps a roster of people; consumers (GitHub Review, commit tooling) ask it to
resolve names and, on the server, fetch the chosen bot's token.

This is a high-trust convenience. Explicit input is trusted attribution: an
agent may name the wrong person, and that is acceptable. The only safety
mechanism is the narrow scope of each bot token, which the operator controls.

This package is not a store, a matcher, a registry, a permission system, an
audit log or a verification step. It does not check who is calling, does not
prove a named person asked for anything, and does not choose a default account.

## 1. Ownership

| Supplier plugin owns | Contract package owns | Consumer owns |
| --- | --- | --- |
| Roster storage, settings, migrations | DTOs, Zod codecs, `LIMITS` | When to resolve, and for which names |
| Bot tokens (secret settings) and token health checks | Fixed RPC names, describe envelope, negotiation | Its default account when nobody resolves |
| Alias matching policy beyond `normalizeAliasKey` | `summarizeAttribution`, reason and trailer formatters | Preview digests, PR bodies, explicit naming of primary/others |
| Which entries exist, and their credential state | Owner-bound client, register helper, fail-open wrapper | Using the token, and never logging or rendering it |
| | Conformance kit | Per-call failure presentation |

## 2. Entries

| Entry | Runtime | Exports |
| --- | --- | --- |
| `.` | Zod only | DTO schemas and types, `LIMITS`, `RPC_METHODS`, `negotiateVersion`, `normalizeAliasKey`, `personSummaryOf`, `summarizeAttribution`, `unavailableReason`, `unavailableAttribution`, `coAuthorTrailers`, `utf8ByteLength` |
| `./bb` | type-only SDK imports; injected `sdk`/`bb` | `createPeopleAccountsClient`, `resolveAttributionFailOpen`, `registerPeopleAccountsSupplier`, `classifyCallError`, `PeopleAccountsCallError` |
| `./testing` | DOM-free | `runPeopleAccountsConformance`, `sdkFromFakeHost`, `createFixtureSupplierPort`, `rosterEntryFixture`, `healthFixture` |

There is no `/react` entry: the roster editor and token diagnostics are the
supplier's own settings page, and consumers render plain text.

## 3. DTOs

Inputs are strict (unknown fields rejected). Outputs tolerate added fields and
strip them on decode, so additive supplier responses work and nothing unknown
is forwarded. The register helper also projects supplier values to known fields
before they reach the wire, so anything else a supplier keeps on its objects
(a token, storage metadata) is never emitted.

- **`RosterEntryV1`** (strict): `personKey` (a bb-identity `IdentityKey`,
  carried opaquely, ≤512 chars, no control characters), `displayName`,
  `aliases {emails[], nicknames[], handles[]}`, `githubLogin` (the human's own
  login) or null, `botLogin` or null, `committer {name, email}` or null.
- **`RosterRowV1`**: an entry plus `credential {state, actsAs, expiresAt,
  checkedAt, message, scopes?}`. `state` is `missing | configured | ok |
  failing`. `scopes` is diagnostic only: the scopes GitHub advertised, `null`
  when it advertises none (fine-grained tokens), absent when unchecked.
  Resolution never depends on scopes or on `actsAs` matching `botLogin`. A row
  never carries a token.
- **`PersonSummaryV1`**: `personKey, displayName, githubLogin, botLogin,
  committer, credentialState`.
- **`ResolutionV1`**, one per input, in request order, `input` echoed exactly:
  `resolved {person, matchedBy}` | `not-found` | `ambiguous {candidates (2–8)}`.
  `matchedBy` is `email | nickname | handle | github-login | bot-login |
  person-key | committer-email | display-name`.
- **`AttributionV1`**: `primary {input, person} | null`, `others[]`,
  `skipped[]` (every non-resolved result), `postAs` (bot login or null),
  `assignees[]` (human GitHub logins), `coAuthors[]`, `fallbackReason` (plain
  text or null).

Identifiers: GitHub logins follow GitHub's user grammar (1–39 alphanumerics or
single inner hyphens). Emails are bounded, contain one `@` and no whitespace,
angle brackets, commas, semicolons or quotes. Committer names exclude `<`/`>`
so trailers stay well-formed.

## 4. Attribution rule

`summarizeAttribution(results, participants?)` is pure and deterministic:

1. The **first resolved input** in request order is `primary`; its bot account
   posts.
2. Later resolved people are `others`, in order. A person named twice keeps
   their first mention; `results` themselves keep every input.
3. `assignees` are the `githubLogin`s of all resolved people, deduplicated.
   `coAuthors` are their committers, deduplicated by email.
4. **Ambiguous inputs never pick** a candidate; they are skipped.
5. `postAs` is the primary's `botLogin` unless it is null or its credential
   state is `missing`. A primary without a bot or token does **not** pass the
   posting account to the next person: `postAs` is null and the consumer uses
   its default account.
6. `fallbackReason` is set whenever anything defaulted or was skipped: no
   names, nobody resolved, primary without a bot or token, or any skipped
   input. It names each skipped input with its status (ambiguous inputs list
   candidate names) and, when the request carried `participants`, ends with
   "Thread participants seen: …" ("none" for an empty list). Each clause has
   its own byte budget (outcome 384, skipped 1024, participants 512; names
   clipped to 96 bytes, at most 8 per list then "and N more"), so participants
   always survive long or multibyte skipped names; the whole reason is ≤2048
   bytes.

Consumers name the primary and others explicitly in previews and PR bodies;
that wording belongs to the consumer.

Credential health is advisory, never a resolution gate: `credentialState:
"failing"` still yields `postAs`, because health checks can be stale. Before
any create attempt, a consumer fetches the current credential and prepares the
account; if the token is missing or unusable at that point it falls back to
its default account with a reason, keeping `primary`, `others` and
`assignees` unchanged. Once a create request may have reached GitHub, the
consumer keeps its existing unknown-outcome behavior and never blindly creates
again under the default account.

## 5. Bounds (`LIMITS`)

16 inputs × 320 bytes; 32 participants × 128 bytes; 256 roster entries; 32
aliases per kind × 320 bytes; display name 128 bytes; committer name 128 bytes;
email 254 bytes; 8 ambiguous candidates; message 512 bytes; 64 scopes × 128 bytes; reason 2048 bytes;
token 1024 printable ASCII bytes; 16 describe versions; 262144 decoded response
bytes per call; describe 1000 ms; other calls 5000 ms.

## 6. RPC protocol

| Method | Input | Output |
| --- | --- | --- |
| `peopleAccountsDescribe` | `null` (strict) | `{protocol: "bb-people-accounts", versions: number[]}` |
| `peopleAccountsV1Resolve` | `{version: 1, inputs: string[], participants?: string[]}` | `{version: 1, results: ResolutionV1[], attribution: AttributionV1}` |
| `peopleAccountsV1Roster` | `{version: 1}` | `{version: 1, entries: RosterRowV1[]}` |
| `peopleAccountsV1Credential` | `{version: 1, botLogin}` | `{status: "available", botLogin, token}` \| `{status: "unavailable", botLogin, reason: "no-credential" \| "unknown-account"}` |

Describe is parsed tolerantly; `negotiateVersion` selects v1 when advertised
and returns `incompatible` (`schema` or `version`) otherwise. Changed meaning
requires a new method name. Methods register with
`experimental_discoverable: true` as inert metadata.

Read paths never write: resolve and roster do not read tokens or run checks.
There are no write methods in v1; roster editing is the supplier's settings
page, so the unknown-outcome rule does not apply.

## 7. Credential operation

`peopleAccountsV1Credential` is a **trusted backend integration by documented
convention**: a consumer's plugin server calls it with
`bb.sdk.plugins.callRpc` after resolving, uses the token for the one GitHub
call, and does not log, render, persist or return it. App, CLI and agent
surfaces do not call it. There are deliberately no caller checks, allowlists or
tiers; the token's narrow operator-chosen scope is the only control.

The helper looks the login up in the roster case-insensitively, asks the port
for the roster's spelling, and echoes the **requested** login in its answer.
An unknown login is `unknown-account`; a missing or malformed stored token is
`no-credential`. Public outputs (describe, resolve, roster) and every error the
client raises are secret-free: `PeopleAccountsCallError` carries only a kind
and a fixed message and does not retain the transport error as `cause`.

## 8. Client

`createPeopleAccountsClient(sdk, pluginId = "people-accounts", {callMs?,
describeMs?})` validates input before transport, targets the injected plugin,
passes an abort signal, and enforces deadlines with a race even against
transports that ignore abort. Budgets may only be lowered. Decoded results are
capped at `LIMITS.responseBytes` then parsed. `resolve` rejects results that do
not echo every input in order and **recomputes** attribution from the decoded
results and the request's participants instead of trusting the supplier's
summary. `credential` rejects an answer for a different login. No retries,
caching, listing or singleton.

`resolveAttributionFailOpen(client, request)` describes then resolves and never
throws for supplier failures: it returns `{source: "unavailable", error,
attribution}` with nobody resolved and the reason "People accounts were
unavailable (<kind>), so authorship defaulted to the default account. Named: …
Thread participants seen: …". Invalid request input still throws before any
call (a caller bug, not a supplier state).

### Error classification

| Transport shape | Kind |
| --- | --- |
| `AbortError` / caller signal | `cancelled` |
| deadline, `TimeoutError`, `code: "timeout"` | `timeout` |
| `code: "unknown_method"` | `unknown-method` |
| `code: "plugin_not_found" \| "unknown_plugin"`, other 404 | `absent` |
| `code: "plugin_disabled" \| "plugin_not_running"`, 503 | `disabled` |
| `code: "invalid_input" \| "invalid_output"`, failed negotiation | `incompatible` |
| over byte cap, contract mismatch, echo mismatch, `ZodError` | `malformed` |
| anything else | `failed` |

## 9. Supplier registration

`registerPeopleAccountsSupplier(bb, port)` registers all four methods over:

```ts
interface PeopleAccountsSupplierPort {
  listRoster(): RosterRowV1[] | Promise<…>;          // no writes, no token checks
  resolve(input: string): ResolutionOutcomeV1 | Promise<…>; // ambiguous never picks
  credential(botLogin: string): string | null | Promise<…>;
}
```

The helper echoes inputs, projects every value to known fields, computes
attribution with `summarizeAttribution`, and answers describe with `[1]`.
Any port or codec failure inside a handler is replaced by a fixed message
("<method>: the people-accounts supplier failed") with no cause, so a port
error's text never becomes an RPC error body.
`normalizeAliasKey` (trim, NFC, lower-case, strip one leading `@`) is the
minimum comparison every supplier must honour; the conformance kit checks it.

## 10. Discovery — not applicable

There is one central supplier with a fixed default plugin id, like Cross
References. Consumers call it explicitly; there is no `plugins.list()` pass,
probe lanes, overall budget or generation token. Zero suppliers is handled by
`resolveAttributionFailOpen` (`absent` / `disabled`), which yields a complete
default-account experience with a reason. If several suppliers ever exist,
discovery must be added in a new package version.

## 11. Checklist items that do not apply

- Recognition/linkify stages, provenance basis, arbitration: no text
  recognition; inputs are explicit names.
- Safe link/target types, Markdown sanitization: no links or Markdown are
  supplied; reasons are plain text.
- Hosted components and presentation registry: no React.
- Writes, fingerprints, unknown-outcome reconciliation: no write methods.
- Caller identity and authorization: intentionally absent (§7).

## 12. Conformance kit

`runPeopleAccountsConformance({host, entry, token?, botLoginWithoutToken?,
ambiguous?, unknownInput?, pluginId?})` drives an adopter's **real registered
handlers** in a `createFakePluginHost` through the production client
(`sdkFromFakeHost` dispatches as a plugin caller). It checks: describe
negotiates v1; the seeded entry is in the roster and no output contains the
token, checked on the raw handler replies (describe, roster, resolve, including
error bodies) before the client strips unknown fields; every alias, login, committer email and person key resolves, including
upper-case emails, `@handle` and padded nicknames, with duplicates collapsed;
an unknown name is not-found, is skipped in the reason with participants, and
an empty request fails open; an ambiguous input never picks (when supplied);
the credential call returns the seeded token, `unknown-account` and
`no-credential` (when supplied); resolve rejects unknown input fields. The
result is labelled `source-conformance`.

`createFixtureSupplierPort(rows, tokens)` is a reference in-memory port for
consumer tests; its exact-match policy is not the supplier's.

## 13. Release and proof

Consumers pin `@phosphorco/bb-people-accounts` exactly at
`0.1.0-attribution.0`; never `file:`, `link:` or workspace specifiers. Zod is a
dependency; the SDK is an optional peer imported only as types. Bun.build emits
root, bb and testing; the testing entry imports its siblings as externals so
the kit and production share one module instance. `dist/` is not committed.

| Level | This package has it? |
| --- | --- |
| Package tests on emitted entries | Yes (`bun run test`) |
| Adopter conformance | Not yet: `people-accounts` plugin |
| Host/consumer tests | Not yet: GitHub Review |
| Live machine proof | Not yet |
