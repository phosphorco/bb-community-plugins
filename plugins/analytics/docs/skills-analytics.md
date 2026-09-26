# Skills Analytics: fork-free public-SDK evidence boundary

This plugin-owned Analytics view supersedes the earlier fork-dependent Skills
Analytics handoff. It changes neither `fork/` nor `fork/upstream`, consumes no
`skill/observed` event, and makes no provider-private runtime claim. The page
is reconstructible from the existing public BB plugin SDK and retained public
thread events alone.

## Exact public inputs

For a project/environment partition, the projector calls:

- `sdk.skills.list({ projectId, environmentId })` for BB-visible skill
  membership and registered `SKILL.md` path;
- `sdk.skills.listFiles({ projectId, environmentId, skillId })` for the
  bounded registered relative-file list (a truncated response fails the
  capture);
- `sdk.skills.getContent({ projectId, environmentId, skillId, path: "SKILL.md" })`
  for the current content revision and UTF-8 byte count; and
- `sdk.threads.list({ projectId, includeHidden: true, limit, offset })`,
  `sdk.threads.get({ threadId })`, and
  `sdk.threads.events.list({ threadId, order: "asc", limit, afterSeq, types })`
  for retained thread dimensions and the bounded event record.

The capture is complete only when those calls finish for its selected partition.
It is a snapshot of what BB exposes **now**, not the private catalog staged for
an earlier provider turn. A `getContent` failure for the exact public read-root
containment error preserves list/listFiles membership but records null content
revision and footprint; it never falls back to a filesystem read. Other capture
failures retain the prior copy-on-write generation and a bounded error.

## Live public proof

The retained live probe captured a complete Codex BB-visible snapshot for
`proj_t8x9yhwnvc` / `env_tqsfutmr8b`: 57 entries. Its
`bb-performant-react` entry is
`skill_9abda8e8ba47ab3ce5e3de59fcd54476b9c02ce801d3519f2a2aedcbbd30df52`,
provider `codex`, scope `provider-project`, with current `SKILL.md` revision
`9f96984c438da69afea434f07f9a32e9e47c29b488ca33f9c0b2b58de378bc0d` and
6,379 UTF-8 bytes. This revision and byte count are current-capture facts only.

The same retained thread evidence establishes an exact prompt mention at
`evt_34xvtzvafb` sequence 1, a command start at `evt_ktrynhdkme` sequence 32,
and its matching completed item at `evt_nn5dyxhzbj` sequence 33. The command
contains both registered candidates:

- `/home/ubuntu/bb/.agents/skills/bb-performant-react/SKILL.md`
- `/home/ubuntu/bb/.agents/skills/bb-performant-react/references/performance-playbook.md`

It is `shellWrapped=true` and `joinedCommand=true`, so this is deliberately
only lexical evidence that those registered paths appeared in one enclosing
command. The completed item supplies the enclosing outcome (completed, exit 0;
its retained output footprint is 17,283 bytes), not independent reads of either
file. Prompt and command rows have `historicalRevision=null`; the retained
aggregate token rows are null/unallocated to skills. The two symlinked catalog
skills `bb-deployment` and `bb-on-this-machine` have null content footprints.
No observation here proves private staged membership, provider
delivery/access/use, activation, instruction effect, individual file reads, or
per-skill token consumption.

## Query and refresh lifecycle

A complete current catalog is exact only for its captured project/environment
partition. The query selects that partition's latest complete snapshot; a
recent capture elsewhere does not make it current. Historical revisions for
prompt and command evidence are unknown rather than inferred. Missing matching
commands mean incomplete or unsupported provider-access coverage, never that a
skill was not used.

For a populated selected partition, `skillsQuery` reads the retained SQLite
generation only. It starts no stale refresh, projector work, or database work
after the RPC returns. A selected partition with no complete snapshot may await
its first bounded bootstrap. Recapture belongs instead to awaited
`thread.created` and `thread.active` lifecycle handlers, or to an awaited
manual Analytics refresh. Captures are globally serialized and duplicate
same-partition lifecycle work is coalesced. The manual refresh can still commit
the legacy tool snapshot if its bounded Skills refresh fails; last-good Skills
rows remain available.

Summary queries push time, project, environment, provider, skill, and revision
filters into SQLite. Exact aggregate counts are computed independently from the
bounded response detail: the page returns at most 100 current catalog revisions
and 200 retained evidence rows, and labels each preview with its exact N-of-M
coverage. Crossing a drilldown bound therefore truncates detail rather than
failing the summary. Storage retains the latest complete and latest failed
catalog capture per project/environment partition; superseded current-state
snapshots are pruned because they are neither historical provider-use evidence
nor required for the current-catalog result.

## Content footprint and unsupported measures

For each available current `SKILL.md` revision, the page shows UTF-8 content
bytes and an optional local `ceil(bytes / 4)` estimate. Totals, N, and mean use
unique entries in the selected latest snapshot and label the local
byte-divided-by-four method. These are current content-footprint estimates, not
context occupancy, injected content, or consumed input/output tokens. Aggregate
thread token reports remain aggregate/null and are never apportioned.

Provider-native activation, provider delivery/access/actual use, Codex
per-skill read/use attribution, individual reads inferred from shell text, and
per-skill consumed tokens are unsupported. Raw drilldown retains bounded source
event identifiers, sequences, candidates, and enclosing outcome metadata so
each displayed claim can be checked without exposing or relying on command,
prompt, or output bodies.

## Reproduction

The following bounded, read-only RPC request reproduces the selected retained
public evidence without returning prompt, command, or output bodies. It uses a
200-second capture-local window (well below the 90-day contract limit) and
prints only identifiers, outcome metadata, coverage, and footprint fields:

```sh
curl --fail --silent --show-error --max-time 10 \
  -H 'content-type: application/json' \
  --data '{"startMs":1789751200000,"endMs":1789751400000,"projectId":"proj_t8x9yhwnvc","environmentId":"env_tqsfutmr8b","providerId":"codex","skillId":"skill_9abda8e8ba47ab3ce5e3de59fcd54476b9c02ce801d3519f2a2aedcbbd30df52"}' \
  http://127.0.0.1:38886/api/v1/plugins/analytics/rpc/skillsQuery \
  | jq '.result | {coverage,currentCatalog,counts:{promptMentions:.promptMentions.count,commandCandidates:.commandCandidates.count,commandOutcomes:(.commandOutcomes|length)},selectedProbeRawRows:[.rawRows[] | select(.eventId == "evt_34xvtzvafb" or .eventId == "evt_ktrynhdkme") | {kind,eventId,eventSeq,skillId,historicalRevision,registeredPath,completedEventId,executionStatus,exitCode,outputBytes,shellWrapped,joinedCommand}]}'
```

It is a read-only plugin RPC, not a request to refresh or reconstruct a
private historical catalog. On the live proof it returned HTTP 200 in
0.038644 seconds after the stale-query repair. If the retained database has
been rotated or the current server is a different environment, it will
truthfully return the coverage/error state rather than recreate that snapshot.

From the workspace root, run the compatibility proof that includes the
post-return SQLite and detached-lifecycle negative controls, then the community
checks:

```sh
node community-plugins/plugins/analytics/test/skills/acceptance.mjs --suite fork-free-composition --negative-control core-event-dependency,false-read,false-unused,cross-partition-concurrency,repeated-active-rescan,selected-snapshot-coverage,detached-lifecycle-capture,blocking-stale-query --timeout-ms 120000 --total-timeout-ms 300000 && npm --prefix community-plugins run typecheck && npm --prefix community-plugins run test && npm --prefix community-plugins run build
```

The selected RPC live proof is evidence for this public-SDK page and its
retained rows, not a live provider delivery or file-read measurement.
