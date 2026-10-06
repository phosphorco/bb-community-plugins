# Packaging

`npm run build` (or `bun run build`) emits root, `/bb` and `/testing` with the
exact Bun 1.3.14 development dependency through `Bun.build`, browser ESM,
`minify:false`, and an explicit production define. Zod and all SDK entries
remain external. Every sibling public entry stays external too, so production
and kit imports use the same schemas and module instances. Declaration files
come from `tsc --project tsconfig.declarations.json`. No SDK declarations or
source aliases are copied into the package.

Root has only Zod at runtime. `/bb` injects the public SDK and has no SDK
runtime import. `/testing` uses the optional SDK's DOM-free testing entry;
consumers of the kit install `@get-bb/plugin-sdk >=0.5.29 <0.6`. Development pins
0.5.29. React, React DOM and DOM emulators are not package dependencies.

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
