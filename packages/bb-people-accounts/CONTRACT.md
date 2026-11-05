# @phosphorco/bb-people-accounts — package 0.1.0 / wire v1

Trusted attribution convenience: names are accepted as given. No caller checks,
permission tiers, identity proof or audit machinery.

## Ownership

| Supplier | Contract | Consumer |
| --- | --- | --- |
| Roster, matching, secret slots, token diagnostics, settings | DTOs, bounds, fixed v1 RPCs, client, human summary, conformance kit | Discovery, combined batch order, actual credential selection/fallback, GitHub writes |

Root exports are Zod-only. /bb injects the public SDK; /testing drives real
registered handlers through the production client.

## Entries and matching

Roster entries have opaque personKey, displayName, aliases (emails, nicknames,
handles), nullable human githubLogin, nullable botLogin, nullable committer.
Unique exact personKey matches take priority. Otherwise normalize aliases
with trim/NFC/lower-case and strip one leading @. Ambiguous inputs never pick.

Keys and inputs both permit 512 UTF-8 bytes. Keys retain exact spelling.
Other aliases allow 320 bytes each, 32 per kind. Requests contain up to 16
inputs and 32 participant labels (128 bytes each). Roster limit 256;
ambiguity limit 8 candidates; display/committer names 128 bytes; emails 254;
messages 512; reasons 2048; responses 262144; tokens 1024 printable ASCII bytes
without whitespace. GitHub login grammar is 1–39 alphanumerics/single inner hyphens.

Public roster rows carry advisory credential health: missing/configured/ok/
failing, actsAs, expiry, checkedAt, message, optional advertised scopes (null
means unknown). PersonSummaryV1 contains personKey/displayName/githubLogin/
botLogin/committer, with no token or credential state. Own slot state and
effective supplier details belong to the supplier's local settings RPC.

## One human summary

summarizeAttribution(results, participants?) returns primary (first resolved),
others (distinct later people), skipped, assignees, coAuthors, fallbackReason.
Dedup people by exact key, human logins case-insensitively preserving first
spelling, and co-author emails case-insensitively. Keep all results ordered.

No postAs, credential availability, health gate or default account decision
exists in this summary. Reasons describe unnamed/unresolved/ambiguous inputs
and optional participants, with bounded clauses. Resolved people with no bot
or token remain normal humans in the summary.

Supplier computes its response summary. Client decodes and returns it without
recomputing. A consumer combining batches calls this same shared function once
on combined ordered results and owns actual credential/account fallback.

## Fixed v1 RPCs

| Method | Input | Output |
| --- | --- | --- |
| peopleAccountsV1Resolve | {version:1,inputs,participants?} | {version:1,results,attribution} |
| peopleAccountsV1Roster | {version:1} | {version:1,entries} |
| peopleAccountsV1Credential | {version:1,botLogin} | available with token, or unavailable: no-credential/unknown-account |

No describe, version negotiation or compatibility adapter. Registration uses
these exact methods with discoverable metadata. Inputs are strict; output
decoders strip additive fields. Helpers project public fields and fixed errors,
so extra supplier fields and raw port errors never leak tokens. Reads do not
check GitHub or write configuration.

Credential RPC is a trusted backend convention: use the token for the GitHub
call and never log/render/persist/return it. No caller gates. Lookup is
case-insensitive; replies echo requested login spelling. Missing/malformed
tokens are unavailable. Stale/failing health is advisory.

## Client errors and lifecycle

createPeopleAccountsClient(sdk,pluginId?,{callMs?}) calls v1 directly. It validates
inputs before transport, checks ordered input echoes, bounds responses, and
races cancellation/deadline even if the transport ignores abort. callMs can
only lower the 5000 ms maximum.

resolveAttributionFailOpen preserves source/results/attribution. Absent/disabled
suppliers and transport outages yield empty human summaries with reasons.
Malformed installed outputs, unknown methods or invalid wire schemas THROW
PeopleAccountsCallError(kind malformed), with fixed secret-free messages and no
raw transport cause. Consumers may surface that message. Invalid caller input
fails validation before transport.

## Verification

The conformance kit drives actual registered SDK handlers and checks raw
token-free replies, alias forms, ordered results/humans, ambiguity, missing
credentials and strict inputs. Package tests additionally prove 512-byte
boundaries, case-insensitive login dedup, direct dispatch, malformed installed
errors, redaction and noncooperating transport deadlines/cancellation.

Consume exact npm version 0.1.0, never file/link/workspace/tarball substitutes.
Package checks and source conformance are not live host proof.
