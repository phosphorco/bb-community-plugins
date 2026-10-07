# Initial implementation boundaries

The Execution Steward owns the plan/ledger and all shared dependency installation,
manifests, lockfile, TypeScript/Vitest setup, app.tsx/app.css, registration/layout
tests, scripts, documentation, notices, builds and runtime integration.
Workers may run their own isolated tests/typechecks but cannot install packages,
write shared build output, reload a plugin, or alter host/core source.

The canonical plugin is `plugins/plugin-guide-for-nerds`, display name
**BB Plugin Guide for Nerds**, npm package
`@phosphorco/bb-plugin-plugin-guide-for-nerds`. Public SDK pin is **0.5.29**;
vendored controls use public BB **0.44.0** registry source at
`0baa605b32a00619c1d7e3f32be6553ebcf8244a`. Public builder emits a single bundle;
explicit `build:lazy` uses `BB_GUIDE_FORK_CLI` with the existing patch-0028
generation-serving builder/host floor. There is no upstream split-chunk claim.

`src/floating/contract.ts` freezes `GuideContentProps`, `GuideContentModule`,
`GuideSelection` and `FloatingGuideProps`. Content imports these types only.
The frame exports `FloatingGuide` from `src/floating/index.tsx`, accepts an
injected loader and never imports ProductMap. The steward injects the stable
`import('./src/guide-content')` loader in native overlay registration. Local page
selection does not navigate BB. Content defaults to `app-shell`; only section
`surfaces` exists initially. The frame owns the sole guide scroll viewport with
`data-guide-stage-viewport`; content supplies min-height/width-aware inner content.

Source worker @thread:thr_4zxh9sadbe owns only the `copy-and-rename` paths listed
in the plan: donor `src` modules, new `src/guide-content.tsx`, server.ts, local
components/lib and listed donor tests; evidence/copy. The scaffold copied all
35 tracked donor files. Adapt them in place rather than making another copy.
Preserve teaching surface IDs; rename plugin ownership in agent references.
Move plugin-reference loader from app.tsx to guide-content.tsx and add its
meaningful tests under a granted `test/annotation*.test.*` filename. Correct
outer/inner dialog checks, scoped card Escape and late clipboard cancellation
as specified by ADAPTER.md. Future transition/performance redesign stays staged.
New content tests may use the agreed types without importing the frame.

Floating worker @thread:thr_rza2zq8dup owns only `src/floating/**`,
`test/overlay*.test.*` and evidence/floating. The accepted contract may not be
silently changed; request a specific steward adjustment if an incompatibility
appears. Implement frame chrome via fixed inline styles and stable namespaced
class/data markers; root scoped CSS remains steward-owned. Provide exact CSS
requirements in the handoff if needed. Preserve nonmodal route/draft behavior,
per-open cancellation, nested keyboard precedence, focus ownership, capture
cleanup, visualViewport clamping, loading/error/retry and narrow/touch scrolling.

Run `test:fork` + `typecheck:content` or `test:overlay` + `typecheck:overlay`
for the relevant lane. These independently validate their subtree; root reruns
them before acceptance. Shared whole-plugin typecheck/build and emitted lazy
closure verification belong to `first-slice-integration` after both artifacts.
Missing future test/check instruments fail rather than passing empty suites.

Explicitly tell owner @thread:thr_pk5kwrdyjm STARTED and completion/blockers.
No polling, bb thread wait, subworkers, briefs, commits, publication, service
restart/upgrade, private SDK declarations/providers, or fork changes. Catalog
implementation requires a later explicit grant after the first live proof.
