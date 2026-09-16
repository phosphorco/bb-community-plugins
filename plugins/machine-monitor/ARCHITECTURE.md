# Machine Monitor fleet timeline architecture

## Scope and rollout boundary

`fleet-contract.ts`, `host-contract.ts`, and the fleet schemas exported from
`rpc-contract.ts` define the durable fleet/timeline wire boundary. The
coordinator, fleet store, query service, registered browser RPCs, and
selected-machine UI implement collection and timelines for the local BB server
and authenticated enrolled hosts.

`fleetOverview` and `machineTimeline` are registered independently alongside
the legacy `health`, `snapshot`, thread-search, and attachment RPC methods.
The separation keeps the legacy methods compatible while the fleet read model
evolves.

The typed timeline event lane is a tested internal extension seam only. Its
schema, durable reader, chart renderer, and synthetic end-to-end proof are
implemented, but no production event producer or producer-facing write RPC is
enabled. A production producer must remain disabled until a server-owned
admission and ingestion policy enforces quota, event retention, bounded
timestamps and durations, explicit overflow/cursor behavior, and exact BB
project/thread validation. The typed lane alone is not that policy.

## Static machine context

`machineInventory` is an independent, identity-free host RPC and a separate
coordinator lane. It is deliberately not embedded in the 30-second core
payload: the coordinator waits for operational telemetry's first memory pass,
then collects context after a reconnect and at most every 24 hours. Its one
latest snapshot is durably stored per server-bound machine identity. A
canonical profile digest prevents ordinary refresh time/session changes from
churning the machine generation; a changed profile publishes an `inventory`
invalidation after the SQLite transaction commits. A selected browser machine
reads this committed profile from the server—never from a daemon RPC.

The contract describes the daemon-visible environment: OS/kernel/architecture,
logical CPU model/speed, nullable observed Linux topology, visible/usable RAM,
bounded disk summaries, and bounded Linux `md` status. WSL is labeled
`guest-visible`; unknown platforms do no inventory probes; Darwin uses only the
portable Node baseline and a partial root-volume fact until a bounded native
adapter exists. Location is an explicit unavailable fact rather than a network
or cloud-metadata probe. The schema prohibits hardware identifiers and raw
paths by construction: no serial, MAC, WWN, UUID, mount path, IP address, raw
system report, or arbitrary command output is stored or rendered. Linux md
facts never imply the absence of hardware RAID, LVM, or ZFS.

## Identity and collection provenance

There are exactly two machine identity shapes:

```text
{ source: "local-bb-server", machineId: "local-bb-server" }
{ source: "enrolled-host",    machineId: <authenticated BB host ID> }
```

The server chooses the second form from `bb.sdk.hosts.list` and the explicit
target of its host RPC. A host worker can report its display name, platform,
capabilities, session, sequence, and measurements, but all host response
schemas are strict and omit `machine` / `machineId`. The coordinator binds the
identity with `bindCollectionToMachine`; a host cannot redirect storage by
claiming an ID in its response.

Each stored collection envelope records:

```text
machine + collectorSessionId + sequence
hostObservedAtMs
serverSentAtMs + serverReceivedAtMs
normalizedAtMs + clockUncertaintyMs
metric observations
```

`normalizedAtMs` is the server's timeline choice. The server send/receive
pair and bounded uncertainty retain enough provenance to explain and safely
render clock skew without rewriting raw host observations.

## Trusted metrics

The catalog is fixed in source. Every metric has a stable ID, label, unit,
gauge/counter semantics, min/average/max/last/count aggregation policy,
availability class, and one closed rendering hint (`line`, `area`, `step`, or
`hidden`). Collection data is a unique, bounded array of those known IDs;
arbitrary metric names and raw renderer/ECharts options are rejected at the
boundary. Unsupported or skipped work is represented explicitly as a bounded
availability state and reason, rather than as a misleading zero.

## Deterministic read model

A machine timeline request contains a version, machine identity, time range,
and the caller's known `{ dataRevision, settingsRevision }`
generation (or `null` before its first result). A cache key is a stable tuple
of all four values. Results state the current generation, range, range-start
alignment, bucket width/count, and complete/partial/empty coverage metadata.

Every timeline result also has a required, bounded `timeNormalization` summary.
It identifies one closed basis: `remote-server-request-midpoint` for an
enrolled host, or `local-observation` / `legacy-local-observation` for the BB
server's current or migrated rows. It records the sample count, exact raw
host-observed first/last timestamps, normalized first/last timestamps, and the
maximum clock uncertainty. Empty timelines contain zero samples and null time
facts; non-empty timelines contain all facts. Local bases report zero
uncertainty. Only normalized endpoints must be within the requested range and
they exactly agree with coverage; raw endpoints intentionally may be far
outside it when a remote clock is skewed.

Each returned metric series contains exactly the stated number of contiguous
buckets, capped at 720. A bucket always provides `min`, `average`, `max`,
`last`, and `count`; an empty bucket uses null statistics. Sparse loss is
disclosed separately through typed, range-bounded gaps rather than bridged in
the chart. Every coalesced gap is returned: the contract allows exactly the
catalog-size × 720 worst case (currently 7,920), rather than silently slicing
after an arbitrary display-sized limit. A `retention` gap is emitted only when
the query source has retained-bound evidence for that interval; a connected
never-sampled machine and a future empty range are `no-samples`. The query
service will select the width deterministically from the requested range and
retained source grain.

The event lane is a separate result from metric series, capped at 200 events.
It has an exact returned count, total count, and truncation flag, is ordered by
normalized start time then producer/event identity, and rejects duplicates.
An event has a versioned producer ID plus event ID, an instant or interval,
closed category/status values, typed bounded provenance, and an optional exact
`{ projectId, threadId }` BB reference. Instants must be inside the requested
range. Intervals may retain their exact start/end outside it only when they
overlap the range; wholly non-overlapping intervals are rejected. No opaque
event payload reaches the UI. Future unknown categories or versions must be
mapped to the closed `unknown` vocabulary or rejected and disclosed; they are
not treated as chart instructions.

## Fleet overview and attachments

`fleetOverview` is bounded to 256 lightweight machine summaries and carries
connection/freshness, latest metrics, capabilities, warnings, error state, and
per-machine generation. It contains no historical arrays. `machineTimeline`
is the independent, bounded detail contract keyed by machine, range, and
generation; a UI selection never needs to use an overview response as hidden
timeline data. The overview performs one indexed latest-collection lookup per
retained machine and joins only that collection's catalog metrics; it never
ranks or returns a machine's retained metric history. It is recomputed for
each read because `generatedAtMs` and fresh/stale state are clock-derived;
only generation-keyed timeline detail is cached.

Manual Linked threads remain one existing attachment snapshot under
`{ scope: "fleet", snapshot }`. That state is neither machine-scoped nor a
timeline event: attachments keep their existing optimistic delivery and
revision behavior, while event provenance is immutable measurement history.
