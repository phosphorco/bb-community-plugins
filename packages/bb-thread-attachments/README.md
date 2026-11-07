# @phosphorco/bb-thread-attachments

Shared attachment facts and atomic family operations for independent BB thread
presentations. Version 0.1.1 implements wire v1. See [CONTRACT.md](CONTRACT.md)
for ownership, bounds, identity, incomplete coverage and unknown-write semantics.

```ts
import { createThreadAttachmentsClient } from '@phosphorco/bb-thread-attachments/bb';
const client = createThreadAttachmentsClient(sdk, authorityPluginId);
if (await client.describe()) {
  // Once per explicit active-thread/visibility change, outside rendering:
  await client.assess({ version: 1, threadIds: [threadIds[0]] });
  const observed = await client.observe({ version: 1, threadId: threadIds[0] });
  const facts = await client.read({ version: 1, threadIds });
  const family = await client.family({ version: 1, threadId: threadIds[0] });
  // Render your own presentation; only complete durable families can be moved.
}
```

Assessment is a bounded, explicit durable priority wake (1..4 IDs), with no
history I/O or fact overwrites on that RPC path. Reads/family never queue work.
Lost scheduling responses have unknown outcome and are not automatically retried;
a later explicit view wake deduplicates pending work. `client.whenIdle(signal?)`
locally observes raw transport settlement without RPCs, timers or retries. A
consumer may wait with its lifetime signal before submitting a retained latest
intent that was rejected as busy/not-dispatched; it must never replay a
previously dispatched unknown assessment.

`observe` is one event-backed read with a 2500ms supplier wait budget and
separate two-slot supplier admission. It returns the current one-thread read
snapshot on relevant completion or wait expiry; that snapshot may remain
unknown. A queued assessment acknowledgement does not establish completion.
There is no observe history I/O, write, assessment enqueue, retry or polling.
Retain a separate bounded observation client if hydration/scheduling must remain
independent of its raw transport slot.

The root depends only on Zod; `/bb` uses injected SDK methods without a runtime
SDK import. `/testing` requires the optional SDK peer and supplies
`runThreadAttachmentsSupplierConformance({pluginId,register,cases})`. Adopters
register actual production handlers and provide ordered `{name,run(client)}`
behavioral witnesses, independent of any sidebar renderer.

Identity-aware authorities use `threadAttachmentsRpcContract` and
`createThreadAttachmentsSupplierHandlers<ActualInvocation>(adapter)` through
identity's server registration. `context.rpcContext` is the actual invocation;
the authority owns actor authorization, durable policy and recognition.

Attachment creation and new detach suppression require native eligibility.
Explicit removal of an existing attached edge can repair a now ineligible,
archived, deleted or unavailable member: the authority validates the actual
actor and revision, rechecks the edge transactionally and retains its prior
fact/native status in an immutable operation-keyed audit. Repair never marks
the native thread eligible or permits a new attachment.

Run `npm run build`, `npm test`, and `npm run typecheck` in this package. Tests
consume emitted entries, so build first. Package tests and adopter conformance
are source evidence. Release uses the reviewed source revision and ordinary
`bb-thread-attachments/v0.1.1` tag workflow. Verify registry version, artifact
integrity and provenance before exact `0.1.1` adoption; verify live service
behavior separately.
