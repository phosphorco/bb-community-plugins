# People Accounts v2: identity associations

Source candidate `0.2.0-dev.0`; wire v2. Unpublished and unadopted. The existing
root, `/bb` and `/testing` exports and fixed v1 RPCs retain their GitHub-oriented
behavior. New consumers explicitly import `/v2`, `/v2/bb` or `/v2/testing`.

## Ownership

The package owns DTOs, a pure link codec/resource descriptor, bounded injected
clients, registration/discovery and an adopter conformance kit. Suppliers own
their public native identity metadata, canonical subjects and access to sources.
The People Accounts host will own link storage/indexes and editing; none is
implemented here. Consumers keep causal actor/account/default selection.

There is no credential method, link-write RPC, implicit identity merge, actor
resolver, email grant, service-specific role or native account action in v2.
Names are presentation, never automatic links. Two people can have associations
with the same external account without becoming one person.

## Model and entries

`ExternalLocator` is the `pluginId`/`subject` projection of `bb-identity`'s
external `IdentityReference`; it does not invent a normalized identity key.
Subjects are opaque and must include their source context as defined by the
supplier. `personKeyV2Schema` delegates directly to `identityKeyCodec`; plugin
IDs delegate to `idCodec('plugin')`. Keys are never re-encoded or inferred.

`LinksRecord` is `{links:[{id,identity:{pluginId,subject}}]}`. The owner/person is
the existing identity `StateAddress.owner`, not a second editable value inside
the payload. IDs and external locators are unique within one person's record.
Neither uniqueness restriction applies across different people.

`createLinksResource(pluginId)` returns a pure `StateResource<LinksRecord>` for
collection `people-account-links-v2`, schema 1, with `linksCodec` and empty
initial value. It opens no connection, writes nothing and registers no routes.
An adopter supplies transactional `AtomicStateStorage` and uses the existing
identity binding's state registration/controller/reconciliation. The future
host must update its reverse index and receipts in the same transaction.

| Entry | Exports |
| --- | --- |
| `/v2` | Model/input/output schemas, `rpcResultV2Schema`, negotiation, `LIMITS_V2`, `METHODS_V2`, resource descriptor/codec and locator comparison. Shared identity runtime comes from `bb-identity/model`; no SDK/React runtime. |
| `/v2/bb` | `registerPeopleAccountsV2`, `createPeopleAccountsV2Client`, `createPeopleAccountsDiscovery`, `PeopleAccountsV2Error` and port types. SDK supplied explicitly; no cross-plugin imports or singleton. |
| `/v2/testing` | `runPeopleAccountsV2Conformance` over an adopter's real SDK handlers and seeded identities/associations. It imports the emitted sibling entry rather than bundling another client instance. |

V2 is checked with SDK 0.6.52 and bb-identity 0.5.0. The legacy package peer
range is retained for v1; this is not v2 acceptance on every older SDK host.

## Wire

`peopleAccountsDescribe(null)` is the only unwrapped reply:
`{protocol:'bb-people-accounts',versions:[2],capabilities:{identities,links}}`.
Describe tolerates input; capabilities are decoded only for a negotiated v2.
Legacy-only suppliers may have no describe method. `[1]` is incompatible for
v2 without attempting to decode its capabilities; old v1 clients still call
their fixed methods directly. No implicit adapter is installed.

Other v2 RPC replies use `{ok:true,value:PAYLOAD}` or
`{ok:false,error:{kind}}`, exported through `rpcResultV2Schema`. Fixed error
data survives SDK transports that discard custom Error subclasses. Kinds are
`absent`, `unavailable`, `incompatible`, `limit-exceeded`, `timeout`, `cancelled`
and `disposed`. Native port exceptions are not copied into replies.
The production client unwraps replies and throws a fixed `PeopleAccountsV2Error`.

| RPC / client method | Strict input (all include `version:2` on wire) | Success payload |
| --- | --- | --- |
| `peopleAccountsV2IdentitiesList` / `list` | `query,limit,cursor?,revision?` | `version,status:'page',query,revision,items,nextCursor,coverage`; or `status:'conflict'|'unavailable',query`. |
| `peopleAccountsV2IdentitiesGet` / `get` | `subjects` | Ordered `results` echo each subject, including duplicates: found with `value`, missing or unavailable. |
| `peopleAccountsV2LinksGet` / `links` | `personKeys` | Ordered results echo each person key: found with state `version` and `links`, missing or unavailable. |
| `peopleAccountsV2LinksFind` / `find` | `identity,limit,cursor?,revision?` | Page with exact identity, index revision, `{personKey,id}` links, cursor and coverage; or exact identity with conflict/unavailable. |

An identity value is `{identity:{pluginId,subject},presentation:{displayName,handle}}`.
Outputs tolerate additions and project documented fields; inputs and stored
link values are strict. There are no arbitrary metadata bags. `coverage` is
`complete` or `partial`; completeness of a full traversal requires complete
coverage **and** a null continuation. Missing/unavailable/conflict are distinct.

Continuations require the original revision, passed back to the supplier. It
must bind query/locator/revision/offset and return conflict on change. Clients
reject changed revision, incorrect echoes/owners, repeated cursors, empty pages
with continuation, duplicates and excess results. A schema cannot prove a
supplier's snapshot or index implementation; adopter conformance and host tests
must check it. An unknown discriminant is incompatible, not empty/missing.

## Bounds and lifecycle

External subjects/cursors are at most 2048 UTF-8 bytes; display text 128, query
and handle 320; controls are refused. Keys use the shared codec's actual bounds.
Batch reads take 1–64 inputs; pages hold 1–50 requested items. Per-person links
are at most 128 and 192 KiB JSON. Every RPC result is capped at 256 KiB before
stripping/decoding; RPC JSON was already parsed, so this is not a raw allocation
cap. Oversized batches fail rather than silently losing rows.

Clients own one explicit RPC target and a call budget at most 5 seconds. They
validate before transport, bound cancellation even when SDK ignores abort, and
never retry. Registration performs no eager supplier reads, registers only its
advertised roles and owns a disposal signal; supplier handlers have their own
five-second deadline. No fresh requests enter a disposed registration.

Discovery owns a generation per view. `start` lists once, excludes explicit
IDs, and orders eligible running/degraded targets by previously-ready then ID.
`pass.next()` probes up to four concurrently under two-second per-describe and
five-second slice bounds. Repeat `next()` while `hasMore`; it drains that one
inventory, not a poll. All targets remain visible even beyond 32 admitted ready
suppliers; `omittedCount` and each `admitted` flag disclose the limit. A new
pass or disposal aborts old work and fences late notifications. An observer
receives only changed rows; no global registry/cache, background timer or
hidden refresh loop exists.

The package does not interpret any account subject, select a primary person or
turn a shared link into permission. In particular, a Macro link cannot supply
fresh source/request facts to Macro's separate email admission or saved-result
gate. Host storage/UI and all Slack/GitHub/Macro migrations remain future work.
