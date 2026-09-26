# Shared snapshot supply

Only a trusted platform collector may call the injected `TrustedAnalyticsDeltaSource`.
Analytics definitions, query execution, Skills projections, viewers, and browser tabs read
the same immutable `analytics-snapshot-v1` artifact and never receive an SDK, operational
database path/handle, host RPC, callback, filesystem, or network capability.

The host primitive is `readDelta({ dataset, sourceScope, cursor, limit, maxResponseBytes,
signal })`. `dataset` is a fixed platform allowlist (`tool-execution-v1` or
`skill-observation-v1`), not a feature selector. The producer validates scope from trusted
identity admission, emits a stable `(journalSequence,eventId)` order, enforces the requested
row and byte cap before transfer, and returns an opaque exclusive cursor. Upserts replace one
durable event ID; deletes remove that same ID. It must retain tombstones and cursor history long
enough for bounded outage/reset recovery.

Every page names one immutable `sourceGeneration` and frozen `resetWatermark`. A cursor-expired
or generation-reset response is a typed failure: the collector records an explicit durable reset
request, preserves the last good artifact/cursor, and rejects ordinary collection until rebuild
is separately admitted. Rebuild starts from an empty fact map at the trusted reset cursor; it
publishes only after one complete bounded build, atomically clears the matching reset request,
and can therefore never mix an old epoch into the replacement. A failed or cancelled rebuild
leaves both the reset request and last-good artifact intact. `sourceComplete` applies only to
`retainedAfterMs`; seven-day fast-path coverage is complete only when that retained interval and
earliest fact both cover the requested seven-day cutoff.

The provider enforces aggregate request/page/row/byte/time/snapshot/retention caps, one
non-queued admission slot, copy-on-write cursor plus generation publication, and explicit
artifact leases. Before publication it counts distinct pinned generations and their bytes plus
the candidate. If either hard allowance would be exceeded, collection is deferred with
`retention-blocked`; it neither expires leases nor deletes a live generation. There is no lease
TTL or orphan reaper: only a host-qualified worker-exit confirmation may call release. Failure
or cancellation preserves the last good cursor/artifact.

This TypeScript provider is an injectable adapter and test seam, not proof of OS process/data
isolation. A production host must supply the producer-side bounds, trusted scope admission, and
the execution envelope/worker-exit proof before it may claim qualified snapshot isolation.
