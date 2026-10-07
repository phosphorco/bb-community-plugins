# Initial floating guide integration

Execution Steward, 2026-10-06. Implementation is canonical at
`community-plugins/plugins/plugin-guide-for-nerds`; the local path is installed
and enabled as **BB Plugin Guide for Nerds**. The original Plugin Guide and BB
UI Reference remain installed/running. This is the first requirement; later
catalog, instant-navigation and measured-performance work stays in the plan.

## Independent implementation acceptance

The copy worker's complete donor adaptation passed 15 files/100 tests and content
typecheck; the frame worker passed 25 overlay tests and overlay typecheck. The
steward integrated native `experimental_appOverlay` and `sidebarFooterAction`,
scoped CSS, and the deferred content loader. Integration independently passes
10 tests, whole-plugin typecheck, independent public build, selected lazy build
and parsed manifest/import graph. The workbench ledger retains actual results.
No fork source change, SDK declaration alias or second React root was introduced.

Exact public development pair: SDK0.5.29 and bb-app0.44.0. The first full community
build exposed the compiler's `import.meta.resolve` finding hoisted SDK0.4.15.
Invoking its binary directly did not correct that module-resolution boundary.
The final helper stages only the published compiler artifacts in temporary tool
storage with ordinary npm SDK resolution to this plugin's pinned package. It
builds source/output in place, validates versions, and retires scratch on normal,
failure and handled cancellation paths. Other workspace SDK pins stay intact.
Retained failed logs precede the passing isolated and full-community reruns.

`community-checks.json` records frozen npm11.16 install, complete tests and
typecheck passing; full build initially failed on the new plugin, then the full
build rerun passed after this correction. Final integration reran both builds.
The complete isolated omit-dev install/build also passes with no installed SDK
(`omit-dev-receipt.json`). npm10's retained arborist failure was an independent
tooling error; npm11 matches the pinned public CLI dependency.

## Emitted assets and retry

`app.meta.final.json`, `lazy-build-proof-final.json` and `source-hashes.json`
identify the selected generation and source. Initial static JavaScript is
12,839 bytes; the guide entry is deferred. CSS remains eager (120,988 bytes).
The checker verifies every manifest byte/hash, parses static/dynamic imports,
proves dataset markers absent from the closed closure, and rejects unproven
transitive deferred dependencies. Negative fixtures reject format1, a lost guide
entry, cross-generation imports and altered artifact bytes.

Chromium caches failed module URLs. The retry loader reflects its own compiled
literal content factory and appends a distinct query to an allowlisted same-
origin/plugin/generation content URL. It uses no eval or host-private runtime.
The checker rejects an unsupported factory shape. Actual native 503 then Retry
passes with `bb-guide-retry=1`; this is scoped entry recovery, not a claim about
arbitrary transitive imports or future catalog chunks.

## Native proof and limits

Fresh public Playwright/Chromium153 contexts exercised canonical BB at loopback;
no imported credentials or personal browser profile. Evidence JSON, scripts and
screenshots retain the actual outcomes:

- Seven desktop pages and48 distinct card interactions; native arrows, card
  background dismissal and inner palette/card/frame Escape precedence.
- Footer opens one nonmodal portal; close restores its invoker, selection is
  retained, and the underlying route/composer draft remain. Host composer Escape
  leaves the guide open. Chrome uses44px controls; mouse/keyboard drag and resize,
  mobile viewport reclamping, independent scrolling and touch close work.
- Native rich/plain clipboard has the new owner; the native mention provider is
  registered. Resolver semantics are covered by the meaningful donor/server
  tests. No agent turn was submitted solely to exercise host mention resolution.
- Closed startup has no guide DOM/content request; cold open requests the actual
  deferred leaf. Late import after close creates no orphan; native generation
  reload during pending import disposes the old frame and retains one listener.
  Delayed clipboard completion after close creates no reset timer/DOM/focus work.
  A pending open closed and superseded by a second open mounts only one frame;
  late content preserves focus explicitly placed on the native footer control.
- The final generation smoke checks actual asset URLs, inherited theme variable
  changes in an ephemeral document, and simultaneous BB UI Reference/Nerd Guide
  coexistence. Operator theme preferences were untouched.

The initial abrupt one-step raw CDP touch drag lost the browser click on the next
close tap. The read-only frame worker reproduced this in bare HTML without BB,
React or SDK, including without preventDefault; a paced native gesture repaired
both bare and canonical witnesses. The steward independently reran the paced
sequence and FIRST tap detached the guide, with no source or synthetic-click
workaround. Retained controls and failures are in `touch-diagnosis/`.
Physical touch hardware, all actual theme selections, and production performance
metrics remain unobserved. Donor transitions/hidden previews remain intentionally
for the first slice; their removal is later planned work.

Workspace composition check reports independently advanced organization/community
HEADs differing from gitlinks (`workspace-check.txt`). Source work is preserved;
no gitlinks were promoted, child commits moved, package published, or service
restarted. This local plugin proof is not workspace promotion acceptance.
