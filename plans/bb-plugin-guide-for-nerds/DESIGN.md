# BB Plugin Guide for Nerds

The destination is the complete Plugin Guide in a movable companion above the
current BB page, opened and closed from the **Footer action**, with theme and
Native UI catalogs, instant page changes, and content loaded only when needed.

The executable [Pkl plan](../bb-plugin-guide-for-nerds.plan.pkl) owns the work;
its sibling ledger owns observations and decisions. This document explains
scope and acceptance, rather than maintaining a second progress checklist.

## First delivery

Copy the full `fork/build/bb/plugins/plugin-api-docs` into
`community-plugins/plugins/plugin-guide-for-nerds`. Its visible name is exactly
**BB Plugin Guide for Nerds**, package name
`@phosphorco/bb-plugin-plugin-guide-for-nerds`, and package-derived plugin ID
`plugin-guide-for-nerds`. Keep all maps, cards, wireframe fixtures, icons,
agent-reference behavior, useful scripts, and meaningful tests. Record source
revision/file hashes and retain Michael Yong's complete MIT notice.

Adapt the copy into an independent plugin. Its upstream `workspace:*` imports,
`@bb/shared-ui`, and `@/components` aliases refer to the BB monorepo; copying
them unchanged would not create a buildable community plugin. Use the exact
public SDK and version-matched registry source for reusable controls, with
ordinary declared dependencies and a matching build CLI. Import BB's React
runtime through its supported build mechanism; do not bundle a second React.
Keep the compatibility target explicit rather than globally repinning siblings.

Rename every self-reference that could collide: plugin/panel identities,
server mention resources, routes, event names, browser storage keys, owned
DOM IDs, and CSS prefixes. A copied `Copy for agent` mention must resolve
through the new plugin even when the original is installed. Preserve surface
IDs that identify teaching material. Preserve upstream tests that assert
behavior; adapt tests with assumptions about internal BB paths and obsolete
page layout rather than inventing copied SDK declarations.

Use BB UI Reference's interaction pattern: a native
`app.slots.sidebarFooterAction` toggles one nonmodal panel. Use the existing
`app.slots.experimental_appOverlay` and a React portal to preserve plugin,
router, query and SDK contexts for the copied guide. A detached content-script
root does not preserve the donor's hooks. Verify the selected public SDK/build
and this mounting path before extracting the independent package. No BB fork
capability is missing. The guide does not navigate away
from the current page, shade/block the whole app, intercept the underlying
composer, or annotate the real interface.

The panel has a draggable title bar, close action, independent scrolling,
accessible name, viewport clamping, and usable narrow/touch layout. Opening
with the keyboard moves focus into the guide; closing restores the invoking
control when appropriate. Escape must respect an inner open menu first. Keep
the last selected map and scroll/position where appropriate using namespaced
local UI state; these are not shared per-person settings. Do not copy UI
Reference's eager hidden DOM construction or stylesheet walk on plugin startup.
A lightweight trigger/controller and first-open dynamic import establish the
loading boundary immediately. Close/reload while an import is pending must
not create an orphan panel. Loading, failure, and retry are usable states.

The first milestone is a concrete demonstration of this renamed floating guide
and its footer toggle. Future catalog sections and motion/performance changes
must not prevent that independently reviewable result.
First-slice acceptance includes emitted entry/static closure and actual cold
chunk delivery, import retry and reload cancellation. Local guide selection
does not call the donor's plugin-route navigation. Scope dialog checks to
inner controls so the outer panel does not suppress arrows/card dismissal;
use inner-menu/card/frame Escape precedence and per-open cancellation for
imports, clipboard completion, feedback timers and pointer capture.

The two-perspective [review dispositions](evidence/plan-review/REVIEW.md)
explain the revised compatibility/adapter prerequisites and source-only
scaffold. The steward owns metadata, dependency installation, top-level entry,
CSS, registration tests and serialized builds. After scaffold acceptance,
workers can adapt copied content and implement the floating frame on disjoint
files. Catalog implementation waits for first-slice proof; immutable target
research can run independently. Full repository checks follow performance
proof, so measurements cannot race a shared install/build.

## Catalogs and version policy

“Both catalogs” means the theme-variable dataset and the Native UI dataset
inside the new guide. BB UI Reference is the teaching/design donor; this grant
does not require replacing it or changing its behavior. Neither plugin imports
the other's private modules or requires the other to be installed. Copy the
small data/illustration resources with attribution; a shared public contract
package is unnecessary for two plugin-local documentation datasets.

Resolve newest **published stable BB** at execution time, then capture its
matching SDK, build CLI, public theme bridge, renderable host exports and
registry entries with immutable revision/file hashes. Do not equate the
independently newest SDK with the SDK shipped by a BB release. Keep the current
deployed BB contract separately and accurately label entries that require a
newer host. Do not upgrade BB or move the pinned upstream tree for this task.
Only use source snapshots as research/proof inputs, never as another deployment
checkout or a hidden runtime source.

On 2026-10-06, discovery found deployed BB **0.44.0** and materialized SDK
**0.5.29**. The npm `latest` tags independently reported BB **0.45.0** and
SDK **0.6.23**; their compatibility pairing is still to be resolved by
`catalog-target-snapshot`. The community collection's target build CLI is
**0.42.0**, and UI Reference pins SDK **0.4.47**. These differences are reasons
for an explicit target snapshot, not permission to update the running service.
See [source evidence](sources.json).

Theme entries show the exact `--variable` and corresponding utility, semantic
purpose, and live fill/text/border/focus demonstration. Copy the variable name,
not a computed color. Read public semantic tokens; do not enumerate arbitrary
app internals or silently invent values for tokens absent from the host. A
newest-source fallback must be distinguishable from runtime availability.
If stylesheet discovery remains useful, perform it once on opening the theme
section and tolerate cross-origin stylesheets; do no idle scans or polling.

Native UI entries distinguish **host-owned SDK experiences** from **registry
components copied into the plugin**. Include correct import/install snippets,
experimental/version markers, concise guidance and palette-aware decorative
illustrations. A catalog describes controls; it does not eagerly import/mount
every listed control. Cover the complete target inventory, explicitly classifying
nonvisual registry helpers instead of pretending each is a renderable component.

Build-time comparison against retained source snapshots proves additions,
removals, changed imports and descriptions, missing entries, duplicates, and
version markers. Its negative fixture must reject a missing token, invalid
host export, or removed registry target; a fixed expected count alone cannot
prove currentness. Keep both catalogs tied to the same BB release receipt.

## Instant navigation and loading

The donor's `src/product-map.tsx` uses a horizontal carousel that mounts every
slide, translates it over 300 ms, interpolates stage/fixture heights, and sets
a 350 ms transition timer. Hidden slides still exist in the DOM and can own
measurement infrastructure. These are source findings, not measured latency
claims.

Change navigation to direct selected-page rendering with immediate layout.
Remove page transform/height interpolation and transition-only timers,
including fixture scaling and mobile card-flow paths. Preserve navigation,
annotation selection, desktop/mobile examples, keyboard/swipe behavior and
scrolling. Ordinary hover/copy feedback does not need a global animation ban.
Warm pages show instantly; a genuinely cold content import can show a small
loading state without introducing artificial transition waits.

Make module boundaries match how content is consumed: footer/controller first,
guide frame/content on open, section content on selection. Confirm what the
selected `bb plugin build` actually emits: dynamic import syntax alone does not
prove deferred network transfer when a bundler inlines it. Use supported asset
loading if chunk splitting is unavailable; retain the proof and never patch BB
core merely to obtain a preferable bundler arrangement.

Mount only the selected map/section. Remove hidden all-card measurement probes
where active-content sizing suffices, measure only active fixtures, share
plugin/catalog lookups within the open guide, and cancel obsolete requests.
Keep small selection/scroll state and fetched module caches bounded; closed
content must release its DOM, observers, listeners, feedback timers, and
ongoing work. One footer/controller listener is the expected closed baseline.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| Full copy with independent name and identity | Donor manifest/hashes and notices; adapted upstream tests; build/typecheck; original and fork co-installed; new mention context resolves correctly. |
| Floating panel with footer toggle | Overlay lifecycle tests plus canonical browser evidence: toggle, close/reopen, drag/clamp/resize, keyboard/focus, touch/narrow layout, unchanged underlying draft and route, inner-menu Escape precedence, disposal. |
| Theme variables | Target-bridge set comparison with failing mutations; variable-copy behavior and demonstrations in light, dark and a materially distinct palette; absent-token labeling. |
| Native UI catalog | Target SDK/registry comparison with failing mutations; correct host/vendor and experimental/version classification; copy/import/install behavior and illustrations. |
| Most recent catalogs | One dated immutable release receipt and complete inventory comparisons; deployed-host compatibility labels; no claim that a moving main branch is the published release. |
| Instant switching | Behavioral navigation tests and production observation of zero page transform/height animation or transition delay, including mobile/desktop and cold-import fallback. |
| Lazy content and performance | Emitted entry/asset closure, requests and DOM before/after open, active-page-only mounts, disposal/late-import tests, and alternating production baseline/candidate measurements. |
| Combined result | Required community `npm ci`, test, typecheck and build; exact final canonical plugin source/build and live interaction/theme/coexistence proof. |

The plan names future focused npm scripts as acceptance instruments to implement
in the new package; they do not exist yet and no implementation check is green.
The steward's package scaffold wires these script entries, which must reject
missing test inputs, and owns their dependency installation.
Catalog actions own their respective comparison scripts; `check:catalogs`
runs both against the shared immutable target. First-slice integration owns the
initial emitted-asset checker; the performance pass extends it. Both run after
a fresh build so an older artifact cannot satisfy them. Narrow write grants
keep these instruments owned by their producers.
Mechanical oracles run from `/home/ubuntu/bb/community-plugins` using
`workbench plan verify ... --cwd /home/ubuntu/bb/community-plugins`.

Freeze performance fixtures, source/build/browser revision, viewport/DPR,
theme/pointer/cache mode, and scenario before the pass. Measure closed idle,
cold first open, warm reopen, page/section switching, drag/resize and repeated
close/reload. Retain raw traces and request/DOM/resource counts. Set regression
predicates after observing stable control noise; then use alternating
control/candidate production runs. Keep optional profiling attribution in a
separate lane and disclose unavailable metrics. Accessibility, first interaction
and failure behavior remain acceptance conditions even if a benchmark improves.

## Working boundaries

Implementation source belongs in the community child repository in this
workspace. The fork is read-only donor/research input. Preserve existing dirty
workspace and organization-plugin changes. Plans and immutable evidence live
alongside the work; no second checkout, alternate runtime, runtime credentials,
or generated `dist/` belongs in a commit.

Local integration proof must use the canonical plugin path on an admitted
runtime, record `bb plugin source`, and preserve unrelated plugin settings and
drafts. This graph does not authorize BB upgrades, service restarts, normal-host
deployment, marketplace posts, npm release tags, or workspace gitlink promotion.
Source delivery and any later publication follow the child and parent contracts;
finish the reviewable implementation/evidence before any additional approval
that is actually required. No operator decision blocks the initial copy/overlay.
