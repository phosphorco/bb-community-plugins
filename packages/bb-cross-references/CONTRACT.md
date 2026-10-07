# Cross References, package 0.1.0 / wire v1

| Feature owns | Contract package owns | Rendering consumer owns |
| --- | --- | --- |
| Storage, migrations, keys and durable delivery | Resource DTOs, Zod bounds and canonicalization | Explicit target SDK injection and refresh schedule |
| CAS, revisions, outbox and write recovery | Fixed central RPC schemas and bounded client | Controls, layout, local policy and presentation |
| Permitted references and maximum count | Thread/URL normalization and conformance kit | Error presentation and optional dependency behavior |

This package makes Cross References v1 reusable across independently installed
plugins. It has no database, registry, lifecycle, authorization, singleton,
SDK slot hooks, retry loop or implicit write destination. Feature attachment DTOs and
storage remain feature-owned.

## Entries

Root exports existing central canonical functions/constants, resource and
projection DTOs, `normalizeProjectionCommand`, and the named v1 Zod schemas.
Root depends only on Zod and browser-safe `@noble/hashes`; SHA-256 is synchronous.
`/bb` exports `createCrossReferencesClient(sdk, targetPluginId =
"cross-references", options?)` using public server/browser SDK type imports.
`/react` provides shared controls with injected APIs; `/styles.css` their styles.
Data crosses plugin boundaries; React components never do.

`LinkedReferences` requires `ownerKey`, an explicit stable logical storage owner,
plus injected get/replace/search/thread callbacks and native navigation. Changing
ownerKey remounts its whole read/mutation/picker lifetime; late results from the
old owner are dropped. Callback objects may change without changing that logical
owner. Consumers adapt their local snapshots; the component does not call slot
hooks or central RPC. Refresh uses mount, reconnect, a changed refreshToken or the
explicit button, with no idle polling.

`/testing` exports `runCrossReferencesConformance({sdk, pluginId?, command})`.
Use an isolated active source with a nonempty target list and the adopter's
actual registered handlers. The helper drives describe, apply, duplicate
mutation, get round-trip and backlinks through the production client. It
reports source conformance, not host loading or live composition.

## Identity and digests

Identity is `{provider,keys}`; presentation never changes identity. Key names
are lexically sorted and values NFC-normalized. Identity JSON keeps exact
`{provider,keys}` property order. SHA-256 is lower-case hex over UTF-8 JSON.
Projection JSON keeps `{protocolVersion,producerPluginId,source,tombstone,targets}`
order; target order and presentation contribute to its digest. Existing Unicode
behavior, including UTF-8 replacement of a terminal high surrogate, is retained
exactly. No values are silently clipped.

Limits remain 32 keys, 512 bytes per key value, 8192 combined key/value bytes,
16384 identity bytes, 256 targets, 262144 projection bytes. Presentation limits
remain 256 label bytes, 1024 detail bytes, 2048 URL bytes and 4096 total bytes.
BB identities retain installation-local project, project/thread, and the fixed
Machine Monitor page shapes. URL identity is canonical HTTP(S), without
credentials or credential-shaped query/fragment parameters.

`normalizeThreadOrUrlReference(target)` uses these central bounds and permits
exact BB thread or safe URL resources. A supplied native presentation URL must
match `/projects/{project}/threads/{thread}` or `/threads/{thread}`. Callers own additional label and count
policy. `urlResource` serializes a URL; canonicalization validates it. Shared
picker helpers preserve Machine Monitor's reference-label messages and bounds.

`ReferenceSnapshot` (alias `AttachmentSnapshot`) is
`{revision,targets,status:{state:"synced"|"pending"|"degraded"|"blocked",
error:string|null}}`. It adapts feature storage for controls; it does not replace
Machine Monitor's wire attachment response/status.

## Fixed RPC and negotiation

`crossReferencesRpcSchemas` adds only `crossReferences.describe`: null input,
`{protocol:"cross-references",versions:[1]}` output. Its envelope tolerates extra
fields, bounds versions to 16 positive safe integers, and negotiates v1 when
advertised. No shared version raises `CrossReferencesProtocolError`. Only
transport `code:"unknown_method"` permits legacy v1 fallback; absent/disabled
peers, ordinary 404s, timeouts and malformed output fail. Describe is explicit;
clients perform no hidden listing, discovery or caching. Consumers own listing
and probing, or use the explicit central default.

Legacy methods stay `applyProjection`, `getProjection`, `listBacklinks`,
`listForwardReferences`, `checkForwardReferences`. Their strict schemas, DTOs,
identity, digest and CAS meanings are unchanged. Legacy strict outputs are a
compatibility constraint; new envelopes tolerate extension. Central registration
wraps shared schemas with existing `defineRpcContract` and supplies the fixed
describe handler. Changed wire meaning requires a new versioned method.

Every client call validates input before transport, targets the injected plugin
ID, passes abort, and enforces 1000 ms describe / 5000 ms other deadlines. Options
can lower those budgets only. Promise races enforce bounds even for transports
ignoring abort; listeners and timers are cleaned up. Decoded canonical JSON is
capped at 1048576 bytes before DTO parsing. The SDK already parses the envelope,
so raw transport byte admission remains outside this package's guarantee.

Transport errors retain their codes. `timeout` denotes deadline failure,
`incompatible_protocol` negotiation/result admission failure, and Zod errors
malformed data. Features classify these within their existing failure policy.
Clients never retry writes or attribute success after an unknown outcome.
Direct writes require a fresh read reconciled by submitted digest; durable
outbox policy remains feature-owned.

## Release and proof

Consumers pin `@phosphorco/bb-cross-references` exactly at `0.1.0`. Runtime pins
are Zod 4.3.6 and @noble/hashes 1.8.0. SDK and React are optional external peers.
Bun.build emits root, bb, react and testing with production automatic JSX,
followed by declarations and the CSS copy. Testing sibling entries stay external
so the conformance kit uses the same production module instance. Do not commit
`dist`.

Package self-tests, adopter source conformance, UI/host proof and live composition
are separate evidence levels. Rendering, dependency locks, publication and live
proof are owned by the coordinating lane.
