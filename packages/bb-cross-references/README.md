# @phosphorco/bb-cross-references

Cross References v1 resources, browser-safe synchronous canonical hashes,
wire schemas, explicit SDK clients and shared reference controls. Each feature
owns its storage, delivery and attachment policy.

```ts
import { threadResource } from "@phosphorco/bb-cross-references";
import { createCrossReferencesClient } from "@phosphorco/bb-cross-references/bb";

const reference = threadResource("proj_example", "thr_example", { label: "Investigation" });
const client = createCrossReferencesClient(sdk, "cross-references");
await client.describe();
const backlinks = await client.listBacklinks({
  target: { provider: reference.provider, keys: reference.keys },
});
```

Optional UI: `/react`; stylesheet: `/styles.css`. Controls receive injected APIs.

```tsx
import { LinkedReferences } from "@phosphorco/bb-cross-references/react";
import "@phosphorco/bb-cross-references/styles.css";

<LinkedReferences ownerKey="my-plugin:settings" api={localReferencesApi}
  navigateThread={navigate.toThread} connection={connection} refreshToken={revision} />;
```

The API implements `get`, `replace(revision,targets)`, `search(query)`, and
`thread(threadId)` over your own storage. Change ownerKey when switching storage
owners. The editor preserves local CAS, refreshes after uncertain writes without
resending them, debounces thread search, and shows escaped delivery diagnostics.
It performs no central graph calls or idle polling.
The snapshot DTO is `ReferenceSnapshot`, also exported as `AttachmentSnapshot`.

Use `/testing`'s `runCrossReferencesConformance({sdk, pluginId?, command})` with
an isolated fixture and the adopter's real registered handlers. It drives
client apply/get/backlinks acceptance and reports source conformance.

Run `npm run build`, `npm run test`, `npm run typecheck` in the workspace.
See [CONTRACT.md](./CONTRACT.md) for exports, bounds, wire compatibility,
legacy describe fallback and proof limitations.

Package 0.2.0 exports `recognitionIdentity` and `recognitionIdentityRecord` for
recognition-backed consumers. Thread verification stays with the consumer;
typed opaque IDs use a bounded SHA-256 identity and a separate raw mapping.
See the [contract](CONTRACT.md#recognition-identity-adapter-package-020-wire-v1-unchanged).

Verified native files use `verifiedFileIdentity` and `verifiedFileIdentityRecord`
with `VerifiedFileTargetSchema`; the generic adapter rejects unverified `bb.file`.
Workspace owner is environment ID; storage owner is the owning thread ID.
Full frame/path survives separately from the bounded hashed graph key and
original lexical source IDs remain occurrence provenance. See the contract for
exact canonical tuple/path rules; consumers own bounded existence/containment.

### Stored mention evidence, V2

The 0.3.0 contract reservation adds pure evidence schemas and the explicit
`createCrossReferencesV2Client(sdk, pluginId)` in `/bb`. Call `describe()` and use
`listMentions({version:2,query:{kind:'resource',target,relation:'self'}})` or literal
`{kind:'authored-url',href}`. `resolveLookup({version:2,text,mode:'recognize'})`
normalizes pasted PR URLs through shared recognition/pure labelled codec without
fetching cards or writing claims. `githubLookup` is the shared explicit GitHub
URL codec; issue/unknown-number input cannot silently become PR authority.

Pages carry bounded original-location evidence, exact counts for retained active
claims, clipping/cap/legacy/unknown-URL coverage and semantic cursors. Conditional
not-modified includes current coverage. Existing V1 clients stay unchanged. See
CONTRACT.md for strict inputs, tolerant bounded outputs, direct-query/time limits,
no-word-cut behavior and read-only conformance. Package source tests and private
emission are distinct from a published registry consumer or live host proof.

The unreleased0.4 producer additions are exported through existing root, `/bb`
and `/testing` entries. Use `createCrossReferencesProducerClient` for complete
Brief graph/evidence replacement and status/readback, and
`runCrossReferencesProducerConformance` against an adopter's real registered
handlers. `runBriefNavigationConformance` requires an actual accepted-reader
fixture; it never supplies a fake freshness proof. Explicitly compile
`test/public-producer-types.mts`; ordinary test discovery does not compile it.
`tools/packed-producer-consumer.mjs` checks actual independent installed native
ESM imports and physical roots; resolver fixtures are not package/registry proof.
See CONTRACT.md for display withholding, bounds, revision fencing and the still
separate TB raw-reader/public navigation adoption duties.
