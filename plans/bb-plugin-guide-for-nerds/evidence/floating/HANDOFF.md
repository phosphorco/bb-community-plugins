# Floating frame implementation handoff

Worker `thr_rza2zq8dup`, released node `floating-footer-toggle`, 2026-10-06.
Ready for independent steward rerun/integration. **Native-live proof remains
pending.** Accepted adapter files and frozen source contract were not changed.

## Files and integration

Created:

- `plugins/plugin-guide-for-nerds/src/floating/index.tsx`: named `FloatingGuide`
  export; native-slot descendant returning one `createPortal` to `document.body`.
- `plugins/plugin-guide-for-nerds/src/floating/geometry.ts`: viewport-aware
  dimension-first clamping, guarded namespaced local geometry storage.
- `plugins/plugin-guide-for-nerds/test/overlay-frame.test.tsx`: 25 tests with
  injected content; no import of donor/ProductMap/content modules.
- This evidence directory: [test output](tests.txt), [typecheck output](typecheck.txt),
  [receipt and hashes](receipt.json), and this handoff.

Steward registers `FloatingGuide` via the accepted native overlay slot, passes
stable module-level loader `() => import('./src/guide-content')`, title and
`plugin-guide-for-nerds:toggle`, and dispatches that event from the native footer.
No imperative mounting function or private provider is needed. The frozen
`contract.ts` is unchanged: SHA-256
`b0e0ba093178ba64fd33307444fcf6a0a5d502703113bac6e11c3070837dcf21`.

All implementation writes were confined to `src/floating/**`,
`test/overlay*.test.*`, and evidence/floating. No donor content, app.tsx/app.css,
manifest, lock, configuration, plan, ledger, host/core, service, git HEAD,
shared dependencies, shared build output or runtime registration was edited.
No installs/builds/reloads/commits/publication/subworkers/briefs were performed.

## Implemented behavior

Closed: only the toggle/controller and bounded refs/state remain; no guide DOM,
loader calls, viewport listeners, timers, rAF or observers. A successful module
cache contains one component associated with its injected loader. Failures are
not cached. One open session owns one AbortController. Close aborts before content
unmount; retry replaces the controller. Async fulfillment and rejection must
match the current open session and uncancelled loader effect. Generation cleanup
removes the toggle listener, aborts the session, clears the cache, releases capture
and never restores focus. Pending imports cannot create an orphan portal.

Loading and import-failure/retry states are accessible. The close control receives
focus as soon as the frame opens, before content resolves. Late content does not
refocus the guide. Closing restores a connected captured invoker only when focus
was in the physical frame or fell to body; host composer focus is retained.
Footer overflow/menu sequencing remains a live integration check because the
native footer callback supplies no trigger element.

The portal root carries `data-bb-plugin-root`, owned
`data-bb-plugin="plugin-guide-for-nerds"`, `data-guide-frame`, `role="dialog"`,
`aria-modal="false"`, a labeled title and `tabIndex=-1`. There is no backdrop,
focus trap, inert subtree, second React root, document/window Escape listener or
host body overflow mutation. Bubble Escape respects `defaultPrevented`, inner
dialog/menu/listbox/`data-guide-inner-layer` boundaries and physical frame
containment. Source worker still owns card/menu Escape consumption and donor
page-arrow/pointer/clipboard fixes; this frame does not override them.

Guide selection is retained as a small mount-time seed for next open; the report
callback only accepts the live session and a bounded page ID. The frame never
navigates BB. The sole body scroll viewport carries `data-guide-stage-viewport`,
size-container semantics, independent `overflow:auto` and overscroll containment.
On content readiness it restores scrollTop clamped to available content height,
with explicit auto scroll behavior and no timer. Content unmounts on close.

Header drag and named Move/Resize controls support primary pointer capture and
arrow keys (32px step, Shift 8px). Chrome targets have 44px minimum width/height;
only gesture surfaces disable touch actions. Interactive header children do not
start a drag. Other pointer IDs/buttons and additional concurrent starts are
ignored. Pointerup/cancel/lost-capture/close/unmount dispose the gesture; capture
release is guarded and tolerates browser disposal. Lost capture for another
pointer leaves the active gesture intact. Movement updates frame geometry without
rerendering memoized injected content; content-owned layout observers can still
respond to resized DOM.

Visual viewport offset/size is preferred with window fallback. Dimensions are
constrained before x/y, so narrow/zoomed/software-keyboard-sized viewports fit.
Window resize and visualViewport resize/scroll listeners exist only while open.
Position/size persists under `plugin-guide-for-nerds:geometry:v1`; invalid JSON,
nonfinite/excessive values and denied storage are nonfatal. No persisted shared
identity setting or host state is introduced.

## Steward CSS notes

Frame geometry/chrome/body behavior is inline and usable without added CSS.
Stable classes are `.nerd-guide-frame`, `.nerd-guide-header`,
`.nerd-guide-scroll`, `.nerd-guide-chrome-button`, `.nerd-guide-resize`.
Root scoped CSS should retain visible focus (suggested `outline: 2px solid
var(--ring); outline-offset: 2px` on `.nerd-guide-chrome-button:focus-visible`)
and add native hover treatment using `var(--state-hover)`. Both tokens were
confirmed in materialized theme.css; exact palette/focus contrast is not certified.
Inline chrome backgrounds have normal specificity; a hover background override
can use `!important` or the root may request a bounded followup to move that one
style out of inline chrome. Default browser focus is currently retained.

Do not add modal/body scroll behavior or geometry/height transitions. Maintain
portal utility scope markers and vendored popup scope. Source wrapper must not
add a second full-guide vertical scroller or duplicate stage viewport. The body
reserves 44px of lower padding so its resize control does not cover the final
content row. Current frame z-index is 40; verify it sits over ordinary BB layout
and below native menus/dialogs in actual integration.

## Checks and honest limits

From `/home/ubuntu/bb/community-plugins`:

```sh
npm run test:overlay --workspace @phosphorco/bb-plugin-plugin-guide-for-nerds
npm run typecheck:overlay --workspace @phosphorco/bb-plugin-plugin-guide-for-nerds
```

Both exit **0**. Vitest 4.1.1: **25 passed**. The final rerun follows the last
implementation change; receipt.json identifies exact checked source/input hashes.
The suite covers actual FloatingGuide mounting/disposal, pending success and
rejection, close/reopen supersession, async/sync failures/retry/cache reuse,
StrictMode toggle lifetime, signal abort-before-unmount, local page retention,
focus ownership, nested/portaled/default-prevented Escape, SDK mock slot hooks,
context preservation, memoized content isolation during geometry updates, bounded
scroll restoration, viewport resize/scroll, primary pointer filtering, capture
cleanup, keyboard controls and denied/invalid geometry storage.

Tests run in jsdom with injected content. Pointer capture and visualViewport are
explicit fixtures; scroll metrics are stubbed where restoration is tested. The
public SDK harness supplies fake slot context, not the live native host providers.
These results do **not** prove physical independent scrolling, actual touch gesture
capture, software keyboard/zoom viewport behavior, native menu capture/focus,
footer overflow focus return, native CSS/themes, real chunk requests/retry, or
production performance. Earlier browser discovery returned no registered instance;
this worker did not acquire a browser or mutate runtime. All of these live gates
remain with steward first-slice integration/acceptance.

Whole-plugin typecheck/build, emitted lazy closure, source-content combined checks
and actual SDK/runtime browser behavior are steward-owned and were not run here.
The first slice must independently integrate both lanes and exercise the canonical
source/build. No plan/ledger pass or native-live acceptance is asserted by this
worker.

## Integration retry finding reported by the steward

Steward `thr_pk5kwrdyjm` reports an isolated real Chromium 153 HTTP probe:
a dynamic import first received HTTP 503; after the same URL was restored to
HTTP 200, repeating that import made only one network request in total and
failed again from the browser's cached module-map error. This is steward-reported
isolated browser evidence, not this worker's own observation or production-plugin
proof. The injected-loader test proves that the frame invokes its loader again
and does not retain a rejected promise; it does not prove browser recovery for
an identical import URL.

The frame continues to accept the unchanged injected `loadContent` contract.
The steward is resolving an explicit cache-busting content-entry loader and will
validate it against the actual emitted graph and host. Native retry acceptance
remains pending; repeating identical `import()` alone cannot certify recovery in
the reported browser. No implementation or frozen contract change accompanies
this evidence note.
