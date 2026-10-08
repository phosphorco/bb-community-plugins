# Packaging

`npm run build` (or `bun run build`) emits root, `/bb`, `/presentation`, `/react`, `/testing` and `/testing/react` with the
exact Bun 1.3.14 development dependency through `Bun.build`, browser ESM,
`minify:false`, and an explicit production define. Zod, React, React DOM, jsdom and all SDK entries
remain external. Every sibling public entry stays external too, so production
and kit imports use the same schemas and module instances. Declaration files
come from `tsc --project tsconfig.declarations.json`. No SDK declarations or
source aliases are copied into the package.

Root has only Zod at runtime. `/bb` injects the public SDK and has no SDK
runtime import. `/testing` uses the optional SDK's DOM-free testing entry;
consumers of the kit install `@get-bb/plugin-sdk >=0.5.29 <0.6`. Development pins
0.5.29. React (^19), React DOM (^19) and jsdom (^27) are optional peers; only the
React/test entries import them. `/presentation` has no runtime imports.

`npm run test` rebuilds all entries and declarations, then runs tests against
emitted public entries and strictly typechecks a public-entry consumer. Shared
version, arbitration and all four contract worked-example fixtures ship as raw
JSON under `fixtures/` and as values exported by `/testing`.

The canonical-JSON UTF-8 result cap runs before contract DTO decoding. The SDK
has already decoded its transport JSON at that boundary; this package cannot
limit raw transport admission. Registration deadline signals are local to the
supplier call, and consumer aborts fence local results without claiming remote
cancellation propagation.

Discovery requires one explicit owner per consumer (`createRecognitionDiscoveryOwner`).
Dispose it on release. To chain stages under the shared six-second budget,
create `overallDeadline = performance.now() + LIMITS.overallMs` once and pass it
in both runners' `budgets`. Consumers own triggers, retries, caching, native
built-ins and presentation. The package schedules no retries or polling.

This step does not publish the package, tag a release, adopt it in plugins or
reload BB. Package source conformance is not host or live proof. Generated
`dist/` output is never committed.

For the 0.4.0 boundary, ordinary emitted-entry tests also invoke
`tools/packed-consumer.mjs`: `npm pack`, install the tarball and exact optional
SDK 0.5.29 with `--ignore-scripts --no-audit --no-fund` into a temporary consumer,
import all six public entries and run registration conformance. Scratch and
its npm cache are removed in `finally`, including failure. The canonical
workspace dependencies and lock are not modified. This needs a coordinated
check window and registry access for dependencies; it is source packaging
proof, not live host proof or proof of the full peer range.

`npm run benchmark:discovery` uses emitted entries and reports sample elapsed
time, describe calls, onRow transitions, onProgress callbacks and total snapshot
rows for 500/2000 ready and absent targets. It makes no universal performance
claim. Run build/tests/benchmark/pack only under the steward's check window.

The clean SDK 0.5.29 testing import also requires its optional runtime peers
`better-sqlite3@12.10.0`, `cron-parser@5.5.0` and `hono@4.11.9`; the scratch
consumer installs them explicitly. Install scripts remain disabled. The packed
probe uses RPC registration only, so it does not open or test a native database.

The hosted scan bundles the complete supplier entry graph with Bun and keeps SDK/React external. Bun is needed by the testing scan, not by production registry or host code. Native realm copies, local owner aborts, fallback isolation and source hook checks do not establish real BB stylesheet/loading behavior.

0.4.1 adds optional consumer retry keys and commit confirmation for hosted
renderer recovery. Rejected lazy imports can reload on the next consumer attempt;
successful imports remain shared. Consumers still own retries and visibility
lifetimes; the package adds no timers or background work.

SDK 0.5.29 `/testing/app` additionally requires its optional
`@testing-library/react@16.3.2` peer; the packed probe provisions it only in
scratch along with React/React DOM and jsdom.

The packed probe additionally compiles actual SDK client assignments and mounts
failure → same-revision recovery from the installed tarball. It always tests
SDK 0.5.29. With the canonical selected 0.6.29 artifact present (or an explicit
`BB_CONTEXT_RECOGNITION_SDK` path), it repeats the probe for that SDK; the receipt
records the matrix actually exercised. SDK 0.6.29 is not available on npm, and
the current CI artifact receipt predates it, so CI currently exercises 0.5.29.
Local selected-artifact proof supports the widened `^0.5.29 || ^0.6.29` peer range.
