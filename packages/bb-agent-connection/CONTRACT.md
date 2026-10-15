# Ownership

| Feature owner (Agent Connect / Rosetta) | Shared package | Existing bb-identity |
| --- | --- | --- |
| Credentials, connection/intake/project scope, routing | Bounded data codecs and exact common GraphQL type fragment | Attribution and external acceptance/lookup |
| Durable upload journal, digest computation, quotas, staging, retention and cleanup | Raw-body headers, injected fetch and bounded read helpers | External operation receipts and native history |
| Immutable replay reservation, byte/metadata equality, dispatch and reconciliation | Explicit native descriptor projection preserving source hints | Native deduplication capabilities and uncertainty |
| Lifecycle, connection rotation, report creation and Slack delivery | Passive connection copy and attachment metadata controls | Identity rendering policy |

This package owns no database, queue, credentials, timer, registry, media processing or lifecycle orchestration. No runtime service/discovery is introduced. Direct submission receipt is a wire DTO: SUBMITTED means submission acceptance; INDETERMINATE means uncertainty. Neither means agent completion or Slack delivery. Rosetta's report receipt stays separate.

## Binary upload v1

`POST` an owner-selected endpoint with raw bytes. Headers are produced/decoded by `/client`; protocol version is `x-bb-upload-version: 1`. Filename is URI encoded UTF-8. Required metadata: stable operation ID, basename, declared MIME, actual expected size, presentation kind. Content-Length is not authority. Server counts actual stream bytes before complete buffering, rejects oversize/truncation, computes SHA256 and returns `{protocol:'bb-agent-connection-upload',version:1,operationId,attachment}`. Successful references carry uploadId, filename, declaredMimeType, sizeBytes, server-computed sha256 and presentationKind; no path, bytes or source project may appear externally. Inputs are strict; response envelopes tolerate new fields. Attachment descriptors remain closed to avoid accidentally carrying private paths.

Features bind each operation key to its immutable owner scope, all metadata AND actual bytes/digest. `uploadIdentity` canonically encodes metadata only; it is not byte equality, a scope check or durable replay. Concurrent reservation/finality and changed-payload conflict are feature responsibilities. There is no automatic mutation retry. After response loss reconcile the same feature operation. Native SDK upload has no idempotency key.

Limits: images 10 MiB, files 25 MiB, 5 attachments, total 50 MiB per submission; basename 200 UTF-8 bytes without slash/backslash/control; MIME 127 characters; opaque upload identifiers 128 characters; response 16 KiB. HEIC/HEIF unsupported. Direct message keys retain existing arbitrary nonempty strings up to 256 characters, including null/omission for legacy clients. AUTO remains the default; no mode remapping occurs here.

`readUploadBody` requires an explicit reservation hook. Reservation occurs before reading; its release callback runs exactly once on success, error or abort after reservation succeeds. Reserve failures acquire nothing. Release must be synchronous and nonthrowing. Successful returned bytes become caller-owned: reserve/transfer retained staging separately and bound concurrency before accepting further uploads. Shared reading checks each received chunk before copying it into accumulation; upstream transport and the SDK may already hold buffers. SDK/native conversion is whole-buffer; this is not end-to-end streaming. Feature owners enforce host-wide concurrency, durable quota and retention.

## Native boundary

`/bb` derives descriptor types from the public SDK and imports identity types from public `/bb`. An explicit owner-bound resolver validates reference/digest/project scope, returns a known native upload descriptor and retains sourceProjectId. The adapter checks metadata equality and validates known fields/variants; it does not cast persisted JSON. Features must preserve the validated exact prompt snapshot before possible dispatch. Never remove sourceProjectId before native cross-project normalization. Feature journals alone do not protect native unowned attachments from seven-day cleanup; retain independent staging until acceptance/queue ownership and replay requirements are resolved.

MIME is declared, not sniffed. Image storage does not prove vision; ZIP/video file storage does not prove extraction/playback/comprehension. Transformation, data URIs and resumable uploads are deferred.

## Presentation and proof

`ConnectionDetails` is passive: explicit ownerKey, URL, instructions, clipboard client, busy/status/error. Owner/value/client changes and teardown invalidate pending completions. Successful copy clears its prior clipboard error. No polling or reset timer runs. Lifecycle actions stay with Agent Connect; Rosetta settings may use the same controls. `AttachmentList` accepts typed metadata and explicit owner-resolved HTTP(S)/blob previews; it never fetches a reference itself. Consumers own layout/theme through scoped className wrapper `.bb-agent-connection-details` and standard semantic controls.

`/testing` accepts drivers wired to real adopter routes/coordinators/stores. `runUploadConformance` is reusable by both features; `runAttachmentConformance` additionally tests Agent Connect direct receipts and legacy text. Adapt response envelopes in the driver without implementing a fake protocol. Package tests are self-tests only; adopter and live composition proof are later gates.

Direct send input retains the observed legacy limit of 32,000 UTF-16 characters and rejects blank/whitespace-only text when no attachments exist. An explicitly nonempty attachment list permits attachment-only input. Message history projection has a separate cap. Image MIME must use image presentation (and localImage natively), with the 10 MiB bound enforced before reservation and again at native projection. Conformance computes SHA-256 from actual fixture bytes using WebCrypto and checks the returned digest.
