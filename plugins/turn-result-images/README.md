# Turn result images

An independent native-image occurrence supplier using the public turn-results contract. Its exact public `@phosphorco/bb-turn-results@0.1.0` dependency is published; canonical leaf verification compares the installed registry files with the reviewed archive. See the gallery README for the ordinary registry/development-SDK install and native-binding procedure. This dependency verification does not establish complete plugin or live acceptance.

Recognition uses only the bounded completed native image event, exact saved-path site and original selected digest. Resolution independently checks complete provider PNG bytes against an explicit-host file read, preserving unknown historical origin separately from verified current location. It considers one current host candidate for an unbound artifact and never moves an existing binding to another host.

Sparse source observations retain original identity, generation time/proof and verified materialization facts through native output pruning and restart. Missing files affect current availability; they do not retract generation. No image bytes, prompts or transcript are stored. Storage and source requests are bounded; expired/evicted source facts remain explicit limitations. There is no startup thread scan, detached indexing, polling or resend behavior.

The production factory registers the private `turnResultImagesV1Media` RPC in addition to the shared data protocol. The strict request is `{version:1, identity:ResultIdentity}`; callers cannot supply a host or path. It requires the complete original retained identity and verified materialization, then rehashes the same explicit-host file before requesting a native preview lease. It never falls back to native history or a different current host. Media requests do not write the store or extend its retention.

The exact response is one of:

```ts
{ version: 1, state: 'ready',
  lease: { targetFingerprint, leaseGeneration, baseUrl, url, expiresAtMs, resolvedAt },
  image: { mimeType: 'image/png', width, height, sizeBytes, sha256 } }
{ version: 1, state: 'unavailable', reason }
```

`targetFingerprint` is lowercase SHA-256 of canonical JSON `{target,sha256}`, using the stored host file target and independently verified provider digest. `leaseGeneration` is a fresh UUID per successful operation. URLs are origin-relative native `/api/v1/file-previews/<id>/<encoded-basename>` URLs; neither URL nor lease generation is an artifact identity or durable fact. The consumer owns its structural output codec and correlates the fingerprint with its admitted file route and hash. No cross-plugin source import or presentation registry is needed for an ordinary image.

Canonical input/output bounds are 8,192/16,384 bytes, including unknown fields before schema decoding. Image admission is at most 8 MiB decoded, 32,768 per dimension and 16,777,216 pixels. Every file recheck, hash and preview creation shares one 1,300 ms source deadline. Media and resolve share two source request slots. Native leases request 120 seconds; expired, over-TTL or malformed responses are unavailable. There is no source lease cache, polling, automatic renewal or retry. Source disposal and deadline abort/fence local continuation even if an SDK call ignores cancellation. The public RPC context has no caller signal, so caller cancellation only fences the caller; source deadline/disposal remain independently enforced. An already created native lease cannot be revoked through the public SDK and expires under its TTL.

The gallery owns two media requests per window, at most 64 retained resource records, shared visible leases/Blob URLs, visibility and reference-count cleanup, one renewal within 30 seconds of expiry, and one load-failure refresh per generation followed by manual retry. A lease is a verified-file observation before creation, not an immutable snapshot of future GET bytes; the consumer must bound and hash the actual fetched bytes and validate decoded dimensions. A successful lease alone does not clear an image-load error.

The source tests exercise the actual server factory, public SDK fake host and real SQLite, including pruned-output reload, fixed-target hashing, bad lease responses, source capacity/deadline/disposal and unchanged durable rows. Exact original-PNG production-handler proof, independently reviewed complete adoption, published dependency adoption and live gallery composition remain required. Existing native probe evidence is separate from these source tests.

Run checks from the community repository with its declared Bun1.3.14. SQLite persistence/composition cases use Node and the actual public better-sqlite3-compatible handle, since that native addon is unsupported by the test Bun version. This is disclosed test routing, not a claim that Bun loads the addon. BB owns the production database handle and its disposal.
