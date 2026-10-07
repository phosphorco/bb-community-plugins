# @phosphorco/bb-context-recognition

Status: **0.3.0 source candidate; release pending.** Published 0.2.0 is the
previous package boundary. [CONTRACT.md](CONTRACT.md)
defines unchanged wire v1. Package source conformance is separate from adopter,
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

Thread Brief is the first source adopter, with GitHub Review and Plan Graph
as supplier adopters of 0.2.0. Their move to 0.3.0 follows package acceptance
and publication; any plugin surface can consume it the same
way. It supersedes `@phosphorco/bb-brief-references`
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
