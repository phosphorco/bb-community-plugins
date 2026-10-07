# Overlay adapter proposal

Produced by bounded worker `thr_rza2zq8dup` for steward `thr_pk5kwrdyjm`,
2026-10-06. **Ready for steward adjudication and contract freeze. Native-live
proof is pending.** No plugin implementation, registration, manifest, lock,
plan/ledger, runtime, fork or shared dependency installation was changed.

## Mounting decision and primary evidence

Use one `experimental_appOverlay` registration with a stable React component,
one native `sidebarFooterAction`, and `createPortal` from that native component.
Do not copy UI Reference's content-script mounting or build a detached root.
The frame/content stay descendants in the host's React tree while the portal
places their DOM in `document.body`. The plugin owns nonmodal positioning,
visibility and keyboard behavior; BB owns its slot boundary and contexts.

* [SDK source contract](/home/ubuntu/bb/fork/build/bb/packages/plugin-sdk/src/app-contract.ts:715)
  explicitly says the ordinary boundary retains plugin, router, query and
  realtime contexts through a portal. [Slot methods](/home/ubuntu/bb/fork/build/bb/packages/plugin-sdk/src/app-contract.ts:2049)
  register the overlay; [native footer contract](/home/ubuntu/bb/fork/build/bb/packages/plugin-sdk/src/app-contract.ts:953)
  supplies label/icon/run and only `openSettings()` in its run context.
* Published `@get-bb/plugin-sdk@0.5.29`, gitHead
  `0baa605b32a00619c1d7e3f32be6553ebcf8244a`, independently confirms these
  declarations: [exact registry metadata](https://registry.npmjs.org/@get-bb%2fplugin-sdk/0.5.29).
  [Receipt](public-sdk.json) verifies the pinned tarball SHA-512 integrity and
  full declaration SHA-256. [Numbered excerpts](public-sdk-excerpts.txt) retain
  the relevant public declaration lines. No private or copied SDK types form
  a plugin dependency; the type probe resolves the actual public package in a
  temporary fixture without aliases or shared installation.
* [Host overlay mount](/home/ubuntu/bb/fork/build/bb/apps/app/src/components/plugin/PluginAppOverlays.tsx:8)
  uses `PluginSlotMount`, null crash fallback and a generation-sensitive key.
  [Boundary](/home/ubuntu/bb/fork/build/bb/apps/app/src/components/plugin/PluginSlotMount.tsx:179)
  retains parent providers, adds `PluginContext`, CSS and route-anchor delegation.
  [Host root](/home/ubuntu/bb/fork/build/bb/apps/app/src/main.tsx:39) supplies
  QueryClient/BrowserRouter; [AppLayout](/home/ubuntu/bb/fork/build/bb/apps/app/src/components/layout/AppLayout.tsx:814)
  mounts overlays outside layout regions. [SDK hooks](/home/ubuntu/bb/fork/build/bb/apps/app/src/lib/plugin-sdk-hooks.ts:294)
  use plugin/query context; navigation also uses router hooks. Missing plugin
  context [throws](/home/ubuntu/bb/fork/build/bb/apps/app/src/components/plugin/plugin-context.ts:13).
  Realtime uses the existing host manager, rather than a plugin-owned socket.
* Existing [host overlay tests](/home/ubuntu/bb/fork/build/bb/apps/app/src/components/plugin/PluginAppOverlays.test.tsx:160)
  exercise portaled settings/RPC/navigation in mock host providers, and
  [layout tests](/home/ubuntu/bb/fork/build/bb/apps/app/src/components/layout/AppLayout.test.tsx:537)
  exercise portaled tooltips. These were inspected, **not run by this worker**.
* CSS/DOM context is distinct from React context. The native wrapper is not a
  DOM ancestor of the portal. Give the owned portal root
  `data-bb-plugin-root="" data-bb-plugin="plugin-guide-for-nerds"` to match the
  [build utility scope](/home/ubuntu/bb/fork/build/bb/packages/plugin-build/src/scope-plugin-utilities.ts:16).
  This also bounds donor pointer dismissal. Registry popup components must retain
  their vendored portal scope behavior ([donor helper](/home/ubuntu/bb/fork/build/bb/packages/shared-ui/src/lib/portal-scope.ts:3));
  never import that private host helper. Steward/source worker verify the selected
  registry source and emitted CSS. Theme/scoped portal behavior remains a live gate.

Important input discrepancy: the community root currently resolves SDK **0.4.15**.
The materialized SDK package/source says **0.5.29**, but its existing generated
`bundled-types/bb-plugin-sdk-app.d.ts` lacks overlay symbols. These files are not
an adequate overlay type oracle. Public 0.5.29 declarations and runtime source
agree. Compatibility worker/steward must select the actual package/build pin;
this worker neither regenerated fork artifacts nor repinned anything.

Materialized result tree: `006c86feb52ca604f23b4d422562d635500306ad`.
Fork HEAD: `4d9b909690dcc3ae7df03d8432b08b7142f0a8f5`.
Donor guide source: `fork/build/bb/plugins/plugin-api-docs`; UI Reference source:
`community-plugins/plugins/bb-ui-reference`. See [source hashes](source-evidence.json).

## Proposed contract and exclusive wiring

[contract.ts](contract.ts) is the exact proposed type contract. Steward freezes
and copies it into `src/floating/contract.ts` during scaffold; source imports it
with `import type`. Floating worker owns its implementation files subsequently.

* `FloatingGuide({ loadContent, toggleEvent, title, initialSelection? })` owns
  one controller, open session, portal frame, retained small selection/position/
  scroll state and failure UI. It imports no ProductMap, donor module or content.
* Injected stable `loadContent(): Promise<{ default: ComponentType<GuideContentProps> }>`
  supplies the default exported `GuideContent`. Steward defines a module-level
  loader `() => import('./src/guide-content')` in `app.tsx`. Lazy artifact serving
  and actual deferred transfer belong to compatibility/first-slice integration.
* Content gets `initialSelection`, `onSelectionChange` and `sessionSignal`.
  `initialSelection` is a mount-time seed, avoiding a new controlled ProductMap
  API in the first slice. Its page callback reports local changes for next open;
  the frame retains the last value without remounting current content. Content
  never reads the host plugin route or calls `toPluginPanel` for guide selection.
  Source worker can keep installed-plugin SDK lookups/icons in GuideContent.
* Initial section is exactly `'surfaces'`; future catalog integration may extend
  the union under steward ownership. Page IDs remain donor teaching IDs and
  invalid stored IDs fall back to `app-shell`. Card selection remains ephemeral.
* [wiring.tsx](wiring.tsx) proves public slot and injected component signatures.
  It declares the injected implementations: it is **not an executable plugin**.
  Registration IDs: `floating-guide`, `guide-toggle`; event:
  `plugin-guide-for-nerds:toggle`. No event payload, global store or private
  provider is needed. Capture `document.activeElement` synchronously in the
  toggle listener; the native action supplies no DOM target/input modality.
  Focus the close control on open for both keyboard and pointer activation.
  Host footer overflow/menu focus sequencing needs live verification.

Steward owns `app.tsx`, `app.css`, registration/layout tests, metadata and builds.
Floating worker's later lane is only `src/floating/**` and `test/overlay*.test.*`.
Source worker owns `src/guide-content.tsx` and the donor content modules. No
floating grant was exercised here; it requires explicit steward followup.

## Keyboard/card fixes required in the source lane

The original [arrows](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/product-map.tsx:728)
return whenever `closest('[role="dialog"]')` succeeds. Wrapping them in a
nonmodal outer dialog makes that true for every map control. The original
[pointer dismissal](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/product-map.tsx:785)
has the same defect. The retained probe reproduces both, with the donor source
predicate checked before the DOM assertion.

1. Give the frame `role="dialog"`, `aria-modal="false"`, an accessible title,
   `tabIndex=-1`, close button, and a plugin-owned `data-guide-frame` marker.
   No backdrop, focus trap, inert host subtree, full-screen pointer layer, or
   scroll lock. Do not use a modal Dialog primitive to construct the frame.
2. Source arrow handlers inspect default prevention, editable/select controls,
   and **inner** dialogs/menus relative to the outer frame (prototype
   `innerLayer`). Their event listeners remain on the map, so composer arrows
   are unaffected. Preserve existing annotation links/display-mode exceptions.
3. Card pointer dismissal checks the actual open card/inner layer boundary and
   owned guide root, permitting clicks on the map. Ignore nested popup controls;
   do not dismiss because of interaction in the underlying composer. Source
   worker must apply this to mobile and desktop cards.
4. Remove the [window card Escape listener](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/surface-card.tsx:87).
   It currently dismisses cards even when Escape originates in the composer.
   Content root handles an open card first, including when focus stays on the
   originating map control. Card dismissal prevents default and stops propagation.
   Card element Escape handles focus within the card the same way; neither
   handler closes the frame in the same event.
5. Menus/inner dialogs carry `data-guide-inner-layer` on portaled content.
   Frame uses bubble-phase scoped `onKeyDown`: first respect default prevention,
   then skip inner layers; only unconsumed Escape from inside the frame closes it.
   A popup portaled outside the physical frame is not a frame-close target.
   Preserve vendored menu dismissal. Inspected installed Radix dismissable-layer
   listens in document capture and prevents default before dismissing its highest
   layer; the probe also models this ordering. **Actual selected vendored menu
   behavior is not certified by that model.** No frame document/window Escape
   listener or capture listener may preempt menu/card/composer behavior.

Source lane also owns the [late clipboard bug](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/surface-card.tsx:66):
cleanup can run before clipboard completion, and completion then creates a fresh
2-second timer. A live/unmounted guard, surface/request epoch and frame session
signal must all be checked before updating state **or creating the timer**.
Cancel existing timers on surface changes/unmount/abort; remove signal listeners.
Catch rejection and expose failure only for the current request. The probe runs
the actual donor callback body and shows a timer being created after cleanup;
proposal probes prevent it on close, new open, card unmount and surface change.
Namespaced Copy-for-agent ownership is the source adapter's responsibility.

Later navigation worker owns removal of 350ms stage/carousel/fixture motion,
[delayed card smooth scroll](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/surface-card.tsx:98)
and hidden slide/card probes. Initial source adaptation must still scope/clean up
card scrolling and keyboard handling; do not postpone correctness until that lane.

## Frame lifecycle, layout and interaction contract

Closed controller: one toggle listener, small refs/state; return null and do not
call the loader. No hidden content/guide DOM, subscriptions, layout observers,
resize listener or idle timers. Do not interpret fixture tests as measured idle
performance. Open creates a fresh AbortController and serial; retry replaces the
attempt/session and invalidates pending work. Close aborts immediately before
unmount, clears timers/listeners/rAF/observers, releases pointer capture, and
invalidates focus work. Native generation replacement unmounts the controller;
its disposal invalidates every outstanding completion. An import cannot actually
be aborted: gate fulfillment and rejection by generation/open serial/signal.
Keep only successful bounded module caching; clear rejected loader promises so
retry invokes the loader again. Browser transient failure retry remains a live gate.

Opening focuses the already-present frame close/loading control, rather than
waiting for content to load. Late content fulfillment must not steal focus from
the composer. Close returns focus to a connected invoker only when focus was
still owned by the guide or fell to body during removal. Capture ownership before
removal. If the user moved focus to the host, leave it there. Reload disposal
must not autofocus an unrelated control. No focus trap is introduced.

For drag: header only, primary pointer/left mouse button, skip interactive
children using `closest('button,a,input,select,textarea,[contenteditable]')`.
Apply `touch-action:none` only to the header; retain touch scrolling in content.
Store pointer ID, pointer start and frame geometry; capture that pointer; ignore
others. Release/reset on pointerup, pointercancel, lostpointercapture, close and
unmount; guard `hasPointerCapture`. Do not turn a cancelled drag into a click.
Use effects/refs rather than a second root/runtime. Any move rAF is cancelled on
close; saved small geometry is namespaced and storage errors are nonfatal.

Constrain width/height to viewport BEFORE clamping x/y; a 960px frame cannot be
made usable on a 320px screen by changing position alone. Include visualViewport
width/height/offset for touch zoom/software keyboard, with window fallback.
Subscribe to viewport resize/scroll only while open and reclamp; cap size before
positioning. The geometry probe includes narrow, offset and degenerate viewports.
CSS contract for steward: fixed frame with a header and `minmax(0,1fr)` body,
maximum available viewport size; scroll body `min-height:0; overflow:auto;
overscroll-behavior:contain`. No body/html scroll mutation. Keep frame chrome
stationary while guide content scrolls. Place `data-guide-stage-viewport` and
size-container behavior on the one owned scroll viewport; source wrapper must
not add a competing whole-guide vertical scroller. Page-list horizontal scrolling
and card-local scrolling remain independent. Preserve body scrollTop across
close/reopen when appropriate; apply it after layout without smooth movement.

## Reproducible evidence and coverage limits

Run from workspace root:

```sh
python3 community-plugins/plans/bb-plugin-guide-for-nerds/evidence/adapter/verify.py
```

The driver downloads only the pinned public SDK tarball, verifies exact integrity,
extracts to a unique non-runtime `/tmp` fixture, symlinks existing test-only React/
Zod/Testing Library/type dependencies, and deletes scratch on success/failure.
No `npm install`, canonical package build, service action or runtime reload occurs.
The standalone model suite can run without network:

```sh
node --test community-plugins/plans/bb-plugin-guide-for-nerds/evidence/adapter/probe.test.mjs
```

| Instrument | Result | Proves / limits |
| --- | --- | --- |
| `./bin/status` before changes | complete; preserved dirty work | Workspace/fork/plugin source identity; not runtime behavior. |
| Public 0.5.29 tarball/declarations | SHA-512 integrity verified | Exact published slot/hooks declarations. Root installed 0.4.15 is not used as oracle. |
| Isolated `tsc --noEmit --strict ...` | exit 0 | Injected contract/slot signatures against actual package. `skipLibCheck` skips SDK internals; no frame implementation is type-proven. |
| [Focused model/DOM/React probe](probe-output.txt) | 14 tests pass | Donor predicates and actual extracted callback defects; proposed scoping/cancellation/focus/capture-release/geometry; React portal sentinel inheritance. No host providers or actual touch/layout physics. |
| [Public SDK harness](sdk-harness-output.txt) | 1 test passes | Actual .5.29 SDK registration and portaled hooks use the harness slot environment; mock local page change logs zero navigation; fixture route/draft retained; portal disposal. Harness fakes do not certify native host providers/network. |
| Host tests/source inspection | source support only | Source anchors, generation/crash semantics and existing host test intent. No host test execution asserted. |
| `bb browser instances --host host_chtdmruc4g --json` | `{"instances":[]}` | No admitted browser available at discovery. Native-live gate unavailable/pending. No browser acquisition, runtime reload or second deployment attempted. |
| Scrolling/touch/open-focus/menu/viewport/browser chunk delivery | pending | Layout/CSS and models are proposed; independent physical scrolling, pointer capture dispatch, touch gestures, focus return through footer overflow and cold/retry requests need canonical browser proof. |

Full repository install/test/typecheck/build checks are intentionally not run
under this worker's grant. The steward owns those after scaffold/integration.
No native-live requirement is marked passed, and no plan/ledger status is changed.

Recommendation: accept the narrow content/frame signatures, native mounting
choice and source-lane correctness edits; freeze them before scaffold dispatch.
Release implementation only by explicit followup, then keep first-slice acceptance
pending until canonical browser proof observes the real plugin/source/build.
