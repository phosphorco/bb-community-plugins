# @phosphorco/bb-context-recognition

Status: **0.4.0 implementation; publication pending.** [CONTRACT.md](CONTRACT.md) defines wire v1,
with an additive optional presentation reference in 0.4.0. Package source conformance is separate from adopter,
host and live proof.

A generic, consumer-neutral contract that lets independently installed BB
plugins recognize mentions in text and supply presentation data for them, in
two separate stages:

1. **Linkify** — pure, I/O-free recognition. Input: text, consumer-excluded
   ranges and a host-built context bundle (thread, environment, git remotes and
   branch, links already in the text). Output: candidates with a UTF-16 span,
   a canonical `{provider, id, kind?}` identity, confidence and provenance
   (explicit or inferred, with a short explanation).
2. **Resolve** — identities in, bounded data-only presentations out (label,
   safe href or file target, card fields, reasons). The consumer renders.

Thread Brief is the first consumer, with GitHub Review and Plan Graph as
suppliers, currently deployed on 0.3.0; the 0.4.0 hosted presentation adoption follows publication; any plugin surface can consume it the same way. It supersedes `@phosphorco/bb-brief-references`
([migration](CONTRACT.md#12-migration-from-phosphorcobb-brief-references)).

## Where to read

| You are… | Read |
|---|---|
| Reviewing the design | [Ownership](CONTRACT.md#1-ownership), [worked examples](CONTRACT.md#11-worked-examples), [design decisions](CONTRACT.md#15-design-decisions) |
| Writing a supplier (linkifier and/or resolver) | [Identities](CONTRACT.md#3-identities-spans-and-shared-types), [linkify](CONTRACT.md#5-stage-1-linkify), [resolve](CONTRACT.md#6-stage-2-resolve), [registration](CONTRACT.md#7-bb-helpers-registration-clients-stage-runners), [conformance kit](CONTRACT.md#13-conformance-kit-testing) |
| Writing a consumer | [Discovery](CONTRACT.md#4-discovery), [arbitration](CONTRACT.md#54-arbitration-consumer-pure-arbitrate), [limits](CONTRACT.md#8-limits), [performance and caching](CONTRACT.md#9-performance-and-caching) |
| Changing the contract | [Versioning](CONTRACT.md#10-versioning) |

## Public entries

| Entry | Contents |
|---|---|
| `@phosphorco/bb-context-recognition` | Zod DTOs, `LIMITS`, method names, pure `arbitrate` / `identityKey` / `negotiateVersion` |
| `@phosphorco/bb-context-recognition/bb` | `registerRecognitionSupplier`, owner-bound clients, enumeration, error classification, isolated stage runners |
| `@phosphorco/bb-context-recognition/presentation` | Generation-owned registry; no runtime dependencies |
| `@phosphorco/bb-context-recognition/react` | Lazy `PresentationHost`, crash/Suspense card fallback and owner-bound RPC client |
| `@phosphorco/bb-context-recognition/testing/react` | Mounted source conformance and fail-closed SDK import / DOM-scan check |
| `@phosphorco/bb-context-recognition/testing` | DOM-free conformance kit driving a plugin's real handlers through `createFakePluginHost` |

Consumers pin an exact registry version; plugins only, no fork changes;
identity is attribution only.

Discovery probes all eligible plugins through bounded continuation slices. Its
32-supplier cap applies to admitted ready suppliers. Consumers provide
`knownAbsent` and `previouslyReady` ID collections, invalidating absent entries
on plugin lifecycle changes, and consume `onProgress` row/route snapshots for
late enrichment. The package keeps no hidden discovery cache or polling loop.

Package 0.3.0 preserves wire v1 and the three public entries. It prefers a native
generic fallback for identical spans, tightens malformed-input conformance
probes, and coalesces discovery progress snapshots (initial, at most one per
16 ms while settling, continuation and final flushes). `onRow` still delivers
individual transitions. The complete pending inventory appears in the first
snapshot; admission remains capped at 32 ready suppliers.

Explicit Markdown destinations are consumer-selected linkify windows. The
consumer owns authored navigation, anchor children, local fragments, filesystem
frames and document-wide budgets; the package adds no destination protocol.

`npm run test` exercises emitted entries, including an `npm pack` tarball
installed in a disposable consumer with SDK 0.5.29. `npm run benchmark:discovery`
reports 500/2000-plugin source timing, row and callback counts. Neither check
establishes live BB loading or compatibility with every supported SDK version.

The clean SDK 0.5.29 testing import also requires its optional runtime peers
`better-sqlite3@12.10.0`, `cron-parser@5.5.0` and `hono@4.11.9`; the scratch
consumer installs them explicitly. Install scripts remain disabled. The packed
probe uses RPC registration only, so it does not open or test a native database.

## Hosted supplier components (0.4.0)

A ready card resolution may also carry a small `{schema, data}` presentation
reference. The card remains mandatory. The supplier registers a lazy component
from its content script, using the host's plugin id, generation and abort signal.
The consumer stamps the resolving plugin id and renders only that owner's
registration while it is in the current ready supplier set. See the accepted
[presentation contract](design/presentation-registry.md) for the frozen realm
layout, props, navigation and lifecycle.

Hosted code uses the supplied owner client and navigator, rather than slot-bound
SDK hooks. Each owner call has a five-second local deadline and the existing
64 KiB canonical-JSON response limit. It reads supplier-owned data without
settings, credentials, realtime subscriptions or polling in the consumer.
Consumers lazily import the React entry only for stamped references, mount only
visible expanded views, and enforce their own mount cap (Thread Brief: four).

A registry miss, generation replacement, disable, schema skew, decode miss or
crash renders the existing card. The scoped owner wrapper relies on BB's current
`data-bb-plugin` CSS convention and content-script stylesheet retention. This
is a documented host dependency; package tests do not prove live styles.

`/testing/react` needs React, React DOM, jsdom and SDK testing peers. Its hook
trap and full-entry scan check source composition, not sandboxing of trusted
plugins. The scan uses Bun and conservatively rejects DOM-scanning identifiers
even in comments; it rejects dynamic/default/namespace SDK app imports. React
and all DOM peers stay external and optional for non-React consumers.

SDK 0.5.29 `/testing/app` additionally requires its optional
`@testing-library/react@16.3.2` peer; the packed probe provisions it only in
scratch along with React/React DOM and jsdom.
