# Thread context V1

Status: V1 source candidate; package publication and real-adopter acceptance are separate. Package `@phosphorco/bb-thread-context@0.1.0`; wire `bb.thread-context`, version 1.

This optional data source supplies bounded authored thread descriptions. It does not recognize references, summarize conversations, authorize users, read arbitrary files, classify topics or provide exact conversational support. Existing context-recognition remains a recognition/presentation contract.

| Supplier owns | Package owns | Consumer owns |
| --- | --- | --- |
| Thread routing, source access, accepted source/read barrier, heading policy, freshness and completeness | Strict requests, additive bounded results, negotiation, fixed methods, owner-bound adapter and conformance | Listed discovery, overall budget/ranking, optional fallback, freezing at observation time and safe rendering |

## Wire

`threadContextDescribe(null)` returns `{protocol:"bb.thread-context", versions:[1]}`. Server accepts future describe input; envelope is additive. `[1,2]` negotiates1; `[2]` or `[]` does not. Unknown protocols/malformed versions do not negotiate.

`threadContextReadV1({threadId})` accepts no other field, path, identity or capability. Thread IDs are nonempty, control-free and at most512 code units. Response echoes the exact requested ID; cross-thread results are refused.

Ready contains `source` and `fields`, with no raw document, private root, filesystem handle or arbitrary URL. Source has `document:"brief"`, opaque accepted raw-source `revision` (1..256 code units), `observedAt` (when that source was validated/observed), nullable source `modifiedAt`, `readBasis:validated-read|accepted-cache` and `completeness:complete|partial`. All times are nonnegative safe integer Unix milliseconds. Cache replay must keep its ORIGINAL observation time; serving a cached DTO is not validation. Modification time is not freshness. Completeness describes accepted source capture, separately from field truncation.

Fields are `goal`, `whereItStands`, `decisions`. Each has `state:present|missing`, plain authored `text`, `truncated`, and nullable heading label. Each text is at most4096 UTF-8 bytes; fields are not generated summaries or synthesized quotes. Missing fields have empty text, false truncation and null heading. A missing heading is not a read failure. A reference is only the echoed native thread + logical brief document + optional heading label; it promises no raw-file line/offset. Never expose private storage paths. Supplier owns extraction from its accepted model, including exclusion of question answers, code/generated cards/drafts. It must not silently substitute another workspace source after a storage error.

Unavailable has `reason:missing|source-error|too-large|timeout|unsupported|busy|other`. No arbitrary error text. Future reason strings decode to `other`; unknown states/bases/completeness remain incompatible. Every evolving output object allows additional fields; consumers must copy only the named fields they use and never render/store arbitrary extras. Inputs remain strict.

## Bounds and lifetime

`LIMITS`: response canonical JSON16384 UTF-8 bytes, describe2048; client describe1s/read2.5s; supplier own read2s; at most2 actual raw supplier reads at once. Size admission occurs BEFORE result DTO decode. SDK transport is already parsed: this does not bound raw transport bytes or pre-parse allocation. Field and response limits apply jointly; suppliers truncate fields honestly to fit, or return too-large.

A client retains one raw RPC admission until the actual SDK promise settles, even after local cancellation/timeout. Keep ONE client per listed source for the consumer lifetime, not one per retry/read. Supplier registration independently retains its2 raw admissions until actual handler settlement. Abort requests are not proof of remote cancellation. Late answers are discarded; there is no automatic retry, polling, global registry, database or presentation.

Consumers call `sdk.plugins.list()` once per discovery trigger (explicit work/refresh/reconnect), consider only listed running/degraded plugins, and call the conventional describe through owner-bound clients. They own a bounded total deadline/concurrency/number of sources and must report omitted discovery rather than claiming absence. One owner failure cannot discard healthy owners. Never choose conflicting suppliers by enumeration order: retain identities and use explicit documented selection/priority. Zero suppliers is a usable exact-message fallback. Do not fan out on every row/viewer render or keep extra document sockets.

## Trust and use

Identity is attribution only. Supplier returns data safe for all users of the deployment and enforces its source access. Consumer input cannot choose a file destination. Brief is mutable agent-maintained working context, not human testimony, actual user messages, verified edits or conversational proof. Preserve source revision/time/basis/completeness and per-field omissions. Any freeze says OBSERVED AT INGRESS, not what the brief said at the conversation boundary. No Brief/path-only mention may independently create verified topic support or person credit. Exact conversational candidates remain bound to original source ranges. Existing native missing-history/attachment caveats remain; complete provided fields never upgrades them.

## Entries and proof

Root uses Zod only; `/bb` uses injected SDK objects with type-only SDK import; `/testing` imports public sibling entries and SDK testing. No React. Package tests cover schemas, owner routing, actual-handler conformance, malformed/oversized/cross-thread responses, deadlines and held slots. Supplier adopters must run the kit on REAL production registration and meaningful ready/unavailable witnesses, and review source/read policy. Consumer tests cover discovery isolation, optional absence, stale results and evidence separation. These are source proofs. A real loaded supplier/read plus provenance/fallback UI is separate live acceptance; no model call is required to inspect fields.
