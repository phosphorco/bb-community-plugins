# Copy-and-rename adaptation receipt

Worker `thr_4zxh9sadbe`; sole integration/plan owner `thr_pk5kwrdyjm`.
Released implementation was performed in the steward's existing canonical
`plugins/plugin-guide-for-nerds` scaffold. No second donor tree was copied.
This is a source/content acceptance result, not a live-plugin acceptance result.

## Delivered content boundary

`src/guide-content.tsx` default-exports `GuideContent(GuideContentProps)` and
imports the frozen `src/floating/contract.ts` **as types only**. The frame API was
not changed. Donor `PluginReference`, `loadPluginReferences`, mounted lookup,
first-party installed/catalog merge, icon rendering and plugin-detail links moved
from the donor app into this content module. An installed plugin still overrides
its catalog reference, and failure of either source leaves the other usable.

Lookup starts in the content mount effect. A mount-owned AbortController follows
`sessionSignal`; cleanup aborts requests and removes the signal listener. Both
signals guard state commits after asynchronous completion. Already-aborted
sessions make no SDK request. Small map state remains local to the open content.
The retained harness verifies zero BB navigation calls for local guide selection.

Selection takes a mount-time page seed, accepts authored desktop/mobile pane IDs,
falls back to `app-shell` for invalid stored values, and reports
`{section:'surfaces',pageId}` through `onSelectionChange`. No guide route or
`toPluginPanel` is read/called. Plugin-detail links remain real links; their
navigation is distinct from choosing the guide page.

The content adds `data-guide-content` and width/min-height/padding only, with no
second `data-guide-stage-viewport` or whole-guide vertical scrollbar. The frame
owns that scroll viewport and its size-container behavior. The steward should
retain the viewport's container-size context/`--guide-stage-gap` styling for donor
fixture sizing. Main registration and stylesheet integration are steward-owned.

## Annotation correctness and clipboard lifecycle

`lib/guide-interaction.ts` distinguishes the outer `data-guide-frame` dialog from
inner dialogs, menus, listboxes and `data-guide-inner-layer`; editable controls
suppress map arrows. ProductMap keeps its arrow handler inside the map. It honors
prevented events and session abort, allowing normal page arrows inside the outer
nonmodal dialog. Card pointer dismissal attaches only to the owned frame/root and
allows map-background dismissal while retaining card, annotation-trigger,
display-mode and inner-popup interactions. Host-composer pointer events stay
outside this DOM scope.

The card's global window Escape listener was removed. SurfaceCard handles Escape
from card descendants; the content root also handles it when focus remains on
an originating map control. Both consume selected-card Escape with preventDefault
and stopPropagation. Inner layers or previously prevented events take precedence;
unhandled Escape continues to the frame. The teaching command-palette fixture now
marks its inner layer and consumes Escape to close its own demo palette before
card/frame handling. Its action/outcome/restoration demonstration is preserved.

SurfaceCard gates copy result commits **and timer creation** by mounted lifetime,
surface epoch, request serial and frame session. Pending state is guarded
synchronously, so repeated activation cannot start concurrent same-card requests.
Surface changes/unmount/abort invalidate old requests and clear feedback timers;
current failures are caught, displayed and retryable. Retrying replaces the old
feedback timer. Its donor 350ms smooth-scroll delay remains for the later motion
lane, but is cancelled/guarded on close/unmount and session abort.

`copyPluginSurfaceAgentReference(surface, sessionSignal?)` checks abort before
starting a write and after completion/rejection; a closed-session failure cannot
start an editing-command fallback. Rich/plain representations remain complete.
The editing-command path removes its temporary textarea/copy listener and restores
a connected previously focused element only if the temporary textarea owned focus.
An already-started OS clipboard write cannot be physically aborted; this lane
suppresses its obsolete UI completion and fallback rather than claiming otherwise.

## Independent ownership and full preservation

Copied rich mention resources now carry `pluginId: 'plugin-guide-for-nerds'`.
The `surface:<authored-id>` item IDs and teaching surface IDs remain unchanged;
the host scopes the registered provider to the owning plugin. Server registration
retains a provider and full resolver, with the visible label **BB Plugin Guide for
Nerds**. Tests resolve every authored surface through that registration, reject
unknown IDs, and check the copied resource does not name the original guide.
Context remains three lines with canonical SDK symbols/authoring guidance; its
first line identifies the new guide. Plain text, rich pill serialization and all
other surface copy remain intact.

All 35 tracked donor inputs still exist in the scaffold. `check-copy.mjs` checks
this presence and verifies byte-unchanged authored surfaces, both complete JSON
manifests, icon artwork, standalone scaffold-script implementation/declarations,
annotation/escaping/icon/scroll/example helpers. The changed JSX preserves the
complete teaching fixture/map/card content. Original donor behavioral suites are
retained and passing. All five local public 0.44 registry vendors remain unchanged;
no private providers, SDK declarations, copied host icon map or second React
runtime were added. Scaffold's complete notices and public pins were untouched.

`adaptation-receipt.json` lists each of this worker's 13 source/test edits with
pre-adaptation donor hash where applicable, current SHA-256 and bytes, plus
unchanged source/vendor hashes and the frozen contract hash. `adaptation.diff`
records exact changes against the donor sources (new files against an empty
baseline). Root-owned app.tsx/app.css/package/lock/config/test setup/scripts/README/
notices/plan/ledger and the parallel floating subtree were not edited by this lane.

## Verification and handoff

Run from `/home/ubuntu/bb/community-plugins`:

```sh
npm run test:fork --workspace @phosphorco/bb-plugin-plugin-guide-for-nerds
npm run typecheck:content --workspace @phosphorco/bb-plugin-plugin-guide-for-nerds
node plans/bb-plugin-guide-for-nerds/evidence/copy/check-copy.mjs
```

All exit **0**. `test:fork`: **15 files / 100 tests pass**, including original
copy/escape/surface/scaffold, card/example, desktop/mobile fixture behavior and
new content lifecycle, local-selection, nested-keyboard, clipboard-race and
independent-resolver tests. `typecheck:content` checks the actual content/server/
local-controls subtree against installed public SDK 0.5.29 without importing the
parallel frame implementation. Logs are retained in this directory.

Additionally, the changed/new test files pass scoped TypeScript checking using
an owned thread-storage config extending the canonical tsconfig and explicit
installed Node type roots. That check does not alter shared tooling/config.
`copy-tests-config.json` retains its configuration for reproduction; its includes
are absolute paths to the granted tests and its only extra compiler setting is
installed `typeRoots`. Run `node_modules/.bin/tsc --noEmit -p
plans/bb-plugin-guide-for-nerds/evidence/copy/copy-tests-config.json` from the
community root. The log records exit 0.

New focused coverage transfers the meaningful donor app loader assertions to
`test/annotation-plugin-references.test.ts`. The donor app.test.tsx is still
steward-owned and should remove obsolete loader exports/nav-panel assumptions
when the native entry is integrated. No dependency install, shared/canonical build,
plugin runtime install/reload, service/core/HEAD change, subworker, brief,
commit/push or publication occurred.

Remaining integration/live gates: root registration and CSS with the actual
frame; complete whole-plugin typecheck/build; generation/chunk delivery and
retry/reload cancellation; physical focus/keyboard/touch/scroll behavior,
underlying route/composer state, light/dark/custom theme and original-guide
co-installation/real mention resolution. DOM/harness fixtures do not certify
those native host behaviors. Page transitions, hidden probes and active-only
loading/performance work remain intentionally in their later released lanes.
