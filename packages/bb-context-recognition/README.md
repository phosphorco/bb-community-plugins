# @phosphorco/bb-context-recognition

Status: **implemented, unpublished 0.1.0.** [CONTRACT.md](CONTRACT.md) defines
wire v1. Package source conformance is checked separately from adopter, host
and live proof; no npm release is claimed.

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

Thread Brief is the first consumer; any plugin surface can consume it the same
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
