# @phosphorco/bb-agent-connection

Small reusable contract extracted from Agent Connect. Read [CONTRACT.md](CONTRACT.md) for ownership and uncertainty.

| Entry | Runtime |
| --- | --- |
| root | Zod DTOs, bounds, common GraphQL types, pure connection helpers |
| `/client` | Raw binary upload protocol, injected fetch/AbortSignal, bounded stream reader |
| `/bb` | Public SDK-derived native descriptor adapter, public identity types |
| `/react` | Optional React peer; passive ConnectionDetails and AttachmentList |
| `/testing` | DOM-free real-adopter upload/direct-send conformance drivers |

## Upload, then send

The feature publishes its upload URL under the existing connection/intake credential scope. Both consumers use the same headers and envelope; endpoint paths are feature-owned.

```ts
import { uploadAttachment } from '@phosphorco/bb-agent-connection/client';
const attachment = await uploadAttachment({
  endpoint: uploadUrl, fetch, signal,
  request: { operationId: 'upload-123', filename: 'capture.png',
    declaredMimeType: 'image/png', sizeBytes: bytes.byteLength,
    presentationKind: 'image' },
  bytes,
});
// Persist attachment + operationId before sending. Do not regenerate after uncertainty.
const variables = { message: 'Investigate this screenshot', mode: 'AUTO',
  operationId: 'send-123', attachments: [attachment] };
```

Agent Connect's adopter adds optional `attachments` to `cast`, `call` and `sendMessage`. The following is the target adopter query, not an already deployed endpoint claim:

```graphql
mutation Send($message: String!, $mode: SendMode! = AUTO,
              $operationId: String, $attachments: [AttachmentReferenceInput!]) {
  cast(message: $message, mode: $mode, operationId: $operationId,
       attachments: $attachments) {
    ok receipt { clientOperationId serverOperationId acceptanceStatus threadId }
  }
}
```

Existing text-only `mutation { cast(message: "Hello") { ok nickname } }` keeps its default AUTO and direct acceptance semantics. The package exports the unchanged common type fragment; owner-specific mutations and attachment GraphQL input definitions remain with Agent Connect.

Server reading:

```ts
import { uploadRequestFromHeaders, readUploadBody } from '@phosphorco/bb-agent-connection/client';
const metadata = uploadRequestFromHeaders(request.headers);
// Admission and quota acquisition are feature-owned. reservation.release must not throw.
const bytes = await readUploadBody(request.body!, metadata, { signal: request.signal,
  budget: { reserve: (count, signal) => featureBudget.reserve(count, signal) } });
// bytes are now caller-owned. Compute digest, compare immutable replay metadata AND
// bytes, retain staging, journal scope and return the documented upload envelope.
```

Native projection and acceptance:

```ts
import { resolveAttachmentInputs } from '@phosphorco/bb-agent-connection/bb';
const parts = await resolveAttachmentInputs([attachment], ownerBoundManifestResolver, signal);
// Persist exact immutable prompt input before possible dispatch. Existing identity
// gateway owns acceptance; use the feature's captured author/thread/operation IDs.
const input = [{ type: 'text' as const, text: 'Investigate', mentions: [] }, ...parts];
const result = await identity.server.sendExternal(author,
  { operationId, threadId, mode: 'auto', input }, { signal });
```

`ownerBoundManifestResolver` must check the connection/intake/project scope and exact retained digest/reference, then return the actual SDK upload result including sourceProjectId. The shared adapter owns no staging or send orchestration. Rosetta sends attachment metadata in its own report input, retaining its distinct report lifecycle receipt.

Run build before tests: `npm run build`, `npm run typecheck`, `npm test` from this package. The conformance driver must implement isConflict(error) against the adopter’s actual conflict result so a transport outage cannot pass replay-conflict proof. Root workspace installation, exact registry dependency adoption and publication belong to the integration steward.

Direct send input retains the observed legacy limit of 32,000 UTF-16 characters and rejects blank/whitespace-only text when no attachments exist. An explicitly nonempty attachment list permits attachment-only input. Message history projection has a separate cap. Image MIME must use image presentation (and localImage natively), with the 10 MiB bound enforced before reservation and again at native projection. Conformance computes SHA-256 from actual fixture bytes using WebCrypto and checks the returned digest.
