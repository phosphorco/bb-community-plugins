# Skill Analytics contract

## Current fork-free public-SDK contract (supersedes lifecycle claims)

The current Analytics Skills delivery uses only existing public BB SDK data.
The earlier runtime-lifecycle vocabulary below is historical campaign material;
it is not a source of current product claims and the plugin does not require a
fork event such as `skill/observed`.

### Exact current catalog, not a staged or historical catalog

A catalog capture may run prospectively after the public `thread.created` or
`thread.active` hook, or on an explicit refresh. These are post-transition,
BB-visible `sdk.skills.list`, `sdk.skills.getContent`, and
`sdk.skills.listFiles` reads. A capture records its trigger, time, and either
`complete` with its exact current snapshot or `failed` with an error and no
catalog. A failed capture is coverage information, never an empty catalog.

The snapshot holds the public skill ID/name/**nullable provider**/scope/plugin/path, current content
revision and UTF-8 byte footprint, exact registered paths, and `listFiles`
truncation. A `filesTruncated = true` list cannot be called complete or exact:
the capture must fail rather than manufacture complete coverage. Its content bytes (or an explicitly labelled local `bytes / 4`
estimate) are a current content-footprint estimate only. They do not prove
prompt injection, provider delivery, read, activation, instruction effect,
context occupancy, or consumption.

An exact complete snapshot is exact only at its capture time. It must never be
presented as a private launch-time staged catalog or as a historical catalog
revision for an earlier thread event. If the then-current snapshot was not
retained, the historical revision is `unknown`.

The public SDK's nullable `provider` field is retained verbatim: `"codex"` and
`null` are distinct catalog values. `null` means provider-neutral/unspecified
for that public entry; it is never silently elided, inferred, or replaced with
the thread's provider.

### Retained public thread evidence

`client/turn/requested` can prove only an exact prompt mention (including the
literal `$skill-name` form). Matching that name to a later current catalog also
keeps `historicalRevision = unknown`; it cannot prove loading or use. A correlated
`item/started` and `item/completed` pair with the same thread and command item
ID can produce a **registered-path command candidate** when its command text
lexically contains a path registered in a complete current snapshot. The row
retains the start/completion event IDs and sequences, command ID, the current
registered path, shell/joined flags, enclosing execution status/exit code, and
output byte/truncation metadata. It retains neither command nor output body.

An unmatched `item/started` remains a pending candidate with null completion
and outcome fields; a matching completion deterministically enriches that same
candidate. This is deliberately weaker than a file read. A shell-wrapped or joined command
that completed successfully still does not prove an individual read, provider
delivery, activation, instruction effect, or per-skill token consumption. A
missing matching command is incomplete or unsupported provider-access coverage,
not a `not accessed` complement. Aggregate `thread/context` and token-usage
events remain aggregate-only and are never apportioned to skills.

Replay sorts by `(threadId, seq, eventId)`. Exact duplicate events are
idempotent; an event-ID or `(threadId, seq)` conflict rejects the replay. Paths
must be absolute, NUL-free, and contained under the registered skill root; a
catalog path conflict or escape rejects the capture. The contract fixture fixes
the retained public shape of `thr_tn5pxvdf7j` seq 1 (prompt mention) and seq
32/33 (one correlated shell-wrapped, joined `commandExecution`), while asserting
the limits above.

---

## Historical lifecycle contract (not a current evidence source)

This is the Analytics projection contract for durable `SkillObservation` v1. It
does not turn an absent provider signal into use, instruction effect, loaded
content, or token consumption. The source boundary is the validated runtime
observation. The Analytics projection adds its stable source-event sequence,
observation time, and coverage epoch; it must retain the source observation ID.

## Canonical grain and identity

Every lifecycle or measurement row carries `factId`, `observationId`,
`sourceEventId`, `coverageEpochId`, `observedAtMs`, `sessionId`, `threadId`,
`providerTurnId`, `principalId`, provider/model, and the full revision tuple:
`skillId`, source kind and ID, plugin ID, SKILL.md path, catalog revision,
SKILL.md revision, and subtree revision. `providerTurnId` is required but
nullable: a session-scoped provider report is drillable without inventing a
turn. A revision is never joined by name alone.

`factId = skillfact_v1_sha256(kind + canonical-json(identity-and-grain))`.
Canonical JSON sorts object keys recursively. Runtime observation IDs and
dedupe keys remain their own v1 identities; Analytics does not replace them.
The same deterministic rule means retries do not make a second fact, while a
different event, exact revision, epoch, session, or capture time can.

## Lifecycle evidence

Rows retain one of these independent evidence kinds: `resolved`,
`active-staged`, `bridge-acknowledged`, `provider-observed`, `activated`,
`registered-skill-md-read`, or `subtree-read`. Their display precedence is in
that order (10 through 70), solely to choose a compact highest observed label.
The raw flags remain visible. Precedence is not implication: a read does not
prove activation, bridge acknowledgement does not prove provider ingestion,
and any of them does not prove instruction effect.

`status` is `supported`, `unsupported`, or `failure`; failures retain their
reason. Coverage is separately `observed`, `unsupported`, `unknown`, or
`pre-instrumentation`. The history policy is prospective-only: a session before
the first instrumented epoch is `pre-instrumentation`, not an unactivated row.
No unsupported, failed, unknown, or pre-instrumentation value is displayed as
zero.

## Measurements

There are three non-interchangeable families:

- `content-footprint`: a local, revision-scoped estimate for exactly one of
  `catalog-entry`, `body`, `reference`, or `asset`.
- `context-occupancy`: a provider-reported named context estimate. It is not a
  claim that the body or asset was read.
- `attributable-consumption`: only a future provider measurement explicitly
  attributed to this exact skill can enter this family.

All aggregates partition by family, method, provider, model, serializer and
tokenizer. A partition is never pooled with another. The v1 methods are local
content estimate, provider-reported named context estimate, and a future
attributable-consumption method. Aggregate provider usage has no skill row: it
is unassigned and cannot be apportioned. Missing bytes/tokens are `null` and
carry coverage/status; they are never coerced to 0.

## Exact query semantics

Apply UI filters to raw rows first. A time window is inclusive:
`startMs <= observedAtMs <= endMs`. Group by the full revision tuple and the
selected dimensions, retaining `factId` lists for drilldown.

For activation, the cohort is the distinct delivery unit
`(revision, coverageEpochId, providerId, sessionId, threadId)` with a supported
`active-staged` row in the window and `activationObservability = observed`.
The numerator is a cohort unit with a supported `activated` row at or after its
active staging and within the window. `activation_rate = numerator / cohort`;
it is `null` for an empty cohort. `no-activation-observed` is the complementary
set in that qualified cohort only. Units with unsupported activation are shown
in an unsupported count; unknown and pre-instrumentation units are shown in an
unknown-coverage count and do not enter either denominator.

For a numeric partition, ignore only `null` values while reporting their raw
IDs and missing count. With `n` known values, mean is `sum/n`, median is the
middle sorted value (or mean of two middles), and p95 is nearest-rank
`sorted[ceil(.95*n)-1]`. All five summary values are `null` at `n = 0`.

Every aggregate response includes the sorted contributing `factId`s and sorted
missing `factId`s. Its total is the sum of those contributing raw rows under
the exact same filters and partition; a request mixing provider, model,
serializer, tokenizer, method, or family is rejected. This is the raw-row
reconciliation rule used by dashboards and exports.
