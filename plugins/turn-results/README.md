# Turn results

Turn results keeps independently supplied results beside their originating
conversation turn, including when the work section is collapsed. The timeline is
the collection surface. Meaningful results from a turn appear together without
paging or history controls; routine command/address observations remain indexed
and leave no shelf.
There is no composer customization/banner or separate Results panel/action.

The current source increment includes automatic pane-scoped placement, generated
image media through the independent turn-result-images source, and data cards
for the shared result protocol. Historical outcome evidence, current artifact
availability, coverage and source freshness are separate. Missing or pruned
native history does not erase a previously indexed occurrence.

## Integration status

Its public dependencies are published exact versions:
`@phosphorco/bb-turn-results@0.1.0` and
`@phosphorco/bb-context-recognition@0.5.1`. Canonical leaf verification uses their
registry archives, independently compared with the reviewed release artifacts.
Source conformance, released-library integration and live native behavior have
separate verification receipts; a successful build alone proves none of them.

No generated dist is committed. Build using the canonical BB workspace CLI,
whose SDK base is 0.6.52, rather than the unrelated npm-installed upstream CLI.
The selected fork SDK has an explicit development suffix.

### Reproduce the installed development inputs

From `/home/ubuntu/bb/community-plugins`, run `npm ci`, then these ordinary leaf
installs. Root workspace installation alone links local contract packages;
these leaf steps select the published registry packages without changing the
maintained manifests or root lock:

```sh
npm install --prefix plugins/turn-results --workspaces=false --include=dev \
  --ignore-scripts --package-lock=false --no-save --no-audit --no-fund \
  --registry=https://registry.npmjs.org \
  /home/ubuntu/bb/sdk-artifacts/get-bb-plugin-sdk-0.6.52+phosphor.975e38f02f1a.sdk.12eb78c20820.tgz
npm install --prefix plugins/turn-result-images --workspaces=false --include=dev \
  --ignore-scripts --package-lock=false --no-save --no-audit --no-fund \
  --registry=https://registry.npmjs.org \
  /home/ubuntu/bb/sdk-artifacts/get-bb-plugin-sdk-0.6.52+phosphor.975e38f02f1a.sdk.12eb78c20820.tgz
npm rebuild --prefix plugins/turn-result-images/node_modules/better-sqlite3 \
  --workspaces=false
npm rebuild --prefix plugins/turn-result-images/node_modules/bun \
  --workspaces=false
```

Use Node 22.21.1 for the selected community SQLite binding. The explicit SDK
archive is the workspace-selected development artifact, SHA-256
`f9bca05575191c8e9be5bf8d641755dbea95cd00853869e9e472b428c366d5ae`.
Contract dependencies keep their exact registry declarations. Repeating root
`npm ci` removes leaf inputs, so repeat both leaf steps afterward.

Install development peers together. In particular, the public SDK app harness,
`@testing-library/react`, React and React DOM must resolve one React instance.
A production-only leaf install can omit the selected development SDK and harness
while optional peers install an upstream SDK or a separate React copy. Package
version equality alone does not establish module identity. Compare the actual
SDK entries and contract files, then run the declared tests and typecheck before
building. This procedure does not reload a running plugin.

The release workflows provision the public fork compiler at commit
`3976be61002511a61ca07f0969ff5838772ed5c0`, verify its materialized tree
`5789e7b1c5405f4bd85b372bc6827716dec8f7a9`, and prepare only the CLI tool.
They start no BB runtime. The ordinary npm launcher forwards builds to that
compiler; the release check requires SDK 0.6.52 metadata and verifies the format
2 frontend generation's files and hashes. SDK installation alone cannot make
an older npm CLI emit the selected artifact format. A successful actual CI run
and reviewed final plugin archive are still release gates.

Gallery owns discovery, scheduling, layout, native row attachment, captions,
navigation, sparse observation storage and resource budgets. Suppliers own
recognition and verified facts. The host never imports another plugin's source.
The original probe helpers remain historical test evidence, not production
image-specific routing or a hard-coded results list. Only the sparse public-row
anchor types are included from that directory in the published package.

Current bounded resources include 128 admitted view leases, 128 queued historical
read units, 64 inactive turn models, and two shared active read lanes with at most
one read per thread. A demanded historical slice reads at most four public
100-segment pages, yielding through shared lanes. One automatic second slice may
continue the same issued snapshot chain for the same live target; the chain stops
at eight pages,1,000 sparse rows or1MiB. No history controls or idle walks are added.
A single Open validates a new latest chain within five seconds and the original
eight-timeline/two-retained-read budget, including any restart. Supplier
work also uses the shared lanes and finite continuation budgets. Native source
slices select at most 32 completions; atomic applications admit at most eight
candidates/resolutions. Media retains at most 64 entries, two active operations
and 32 MiB of verified image blobs. One bounded turn collection follows at most
eight actually issued pages, admitting up to64 rows within256KiB including
row-to-issued-cursor bindings, inside the existing16MiB aggregate budget. A lane
collects once and performs its finite owner slice; one queued follow-up observes
committed facts while yielding to other demands. Failures retain the last usable
turn. No per-card read or hidden all-history walk is performed. Actual capacity
may show a quiet limitation beside meaningful results. Empty/routine-only turns
have no frame, loading/error strip or reserved space. Plain data cards use1x1,
images2x2, and custom presentations their supplied spans. Unresolved guesses are
never cached; resolved geometry follows its source revision. SQLite bounds
and transaction/eviction accounting live in gallery/index.ts and its actual
SQLite tests. Capacity, incomplete coverage and evicted history are explicit.

Optional supplier-owned custom cards use the released CR presentation host.
One window admits at most 64 requests and four occupied custom hosts, including
one dialog and hosts still retiring. Revocation fences callbacks immediately;
credit is released only after committed cleanup or actual owned-root disposal.
A cleanup watchdog reports stalled capacity without reusing it. Data, captions
and native Open remain consumer-owned fallbacks. This does not promise arbitrary
asynchronous or GPU cleanup by an uncooperative contributor.

An app-generation resource owner preserves verified image blobs through native
row/root remounts and pane resize. Source-issued preview URLs are ephemeral and
never enter durable observations; the fetched PNG is independently hashed before
local Blob publication. Native file navigation uses the source's explicit host.
Historical origin remains unknown unless the source recorded it.

A public per-header bridge supplies the actual thread id and that surface's
committed native navigation callbacks. It proves a unique local thread window
from its own DOM ancestry; ambiguous/foreign scopes refuse. Its own empty header
wrapper is hidden from layout and accessibility. No global thread-id lookup or
private React context supplies pane ownership. Native history remains a bounded proof input; missing boundaries never invent
a completed turn, history invitation or collection. One concise event caption
accompanies content, and only meaningful file/URL destinations offer Open.
Source clocks/provenance remain in facts without permanent diagnostic footers.

## Verification limits

Source tests cover registered suppliers and real SQLite, retained history,
bounded owner/claim continuation, public timeline invalidation, and actual React
presentation teardown. They do not establish a host's current file availability,
remote reachability or native behavior at every scale. Native scroll, focus,
pane/window changes, varied contributor results and remote preview need separate
live verification against the actual served frontend generation.
