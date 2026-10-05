# Identity library packaging contract

Implementation slice, 2026-09-05. The generated library manifest and tsconfig are
owned by `tools/workspaces-sync`; do not hand-edit either generated file.

`tools/workspaces-sync` now has separate plugin and library definitions.
`packages/bb-identity` uses the library path; it is not a BB plugin and has no
plugin manifest. Both workspace kinds remain under the existing generator.

The library is named `@phosphorco/bb-identity`, uses ESM, and has explicit
runtime/type exports for root, `/model`, `/host`, `/server`, `/state`, `/testing`,
`/bb`, `/client`, and `/react`. Integration verified the generated `/state` export, build,
typecheck, and packed isolated-consumer import (without React): it resolves
`state.d.ts` and `dist/state-runtime.js` and exposes the five documented state
factories. Client connection/view/state binding, portable server composition,
the limited BB RPC foundation and state RPC bridge are included in internal
checks. Narrow first-consumer entries are `client-entry-runtime.ts`,
`react-entry-runtime.ts`, and `bb-entry-runtime.ts`, with declarations limited
to real implemented behavior. Generated exports and isolated tarball checks now
pass, as does the same-Provider held-write browser gate. This is local artifact
evidence, not an npm release or identical-plugin base/fork deployment proof.
No wildcard exports or private host paths. Each packaged export points
to built JS plus its declaration
file. Publish built files, every transitive declaration imported by those entry
points, README and license; omit test fixtures' source, local host state,
repository research copies and generated plugin artifacts. `/testing` is built
public test support, not the package's test suite.

Generic root/host/server/state/client layers have no runtime React or BB SDK
imports. `/bb` uses public BB SDK types and an external Zod runtime dependency
to satisfy the installed SDK RPC schema port; it has no SDK runtime import.
`/react` imports external React and the public SDK app entry. React and the SDK
are optional package peers; Zod is a package-wide runtime dependency even though
generic entry graphs do not import it. `/client` and `/react` build for browsers;
server entries retain their Bun target. React remains external to UI bundles and follows
the host shim. Validate supported versions rather than inferring from the fork.

The locally installed public SDK 0.4.15 bundles React type imports into its root
`.d.ts`. Consequently `/bb` currently reaches React *types* through upstream SDK
declarations. This is not evidence of runtime React leakage. Record and test
that type dependency; do not claim all entry points compile with no React types.
The generic entry points should remain independently consumable without either
BB SDK or React. The declared binding typechecks against installed public SDK
0.4.15; exact target and minimum-supported-host behavior are separate tests.

Library checking/building must be included in workspace commands without
running `bb plugin build` on a non-plugin. Extend the generator through its
source definitions and tests, never by hand-editing package.json or tsconfig.
Community consumers depend on the actual library package/artifact, not a hidden
workspace path. Release the library dependency before selecting plugin artifacts
that reference it; retain versions and byte digests in the composition receipt.

Current reproducible commands separate three concerns:

- Normal package `typecheck` checks installed SDK contracts, including the
  library-only browser fixture; workspace build/test/typecheck include the library.
- The opt-in `browser-check` runs that fixture in real Chromium (Playwright). It
  is not part of the default `test`.
- The isolated tarball test imports all nine runtime/type entries and executes
  public testing harness constructors. This proves usable exported functions,
  not just the presence of filenames in an archive.

Required artifact checks:

1. Pack the library and install it into isolated consumers. Resolve every
   currently published export for types and ESM runtime; no source-tree or
   private-path fallback.
2. Load generic entries without React or BB SDK installed. Load `/bb` against
   each declared public SDK; test its transitive type needs separately from JS.
3. Build two independent plugins with the packed library. Verify React peers,
   explicit client/transport sharing, independent view scopes and bounded reads.
4. Run the same packaged plugin bytes on upstream singleton and the enhanced
   host, including unsupported/malformed extensions and identity outages.
5. Check the installed/loaded bytes, not merely equal source revisions. Native
   session round trips and transactional acceptance need actual host fixtures;
   package mocks cannot substitute for them.

Pack this Bun workspace with `bun pm pack`, then test the resulting tarball with
ordinary npm. Bun resolves catalog versions in the packed manifest; plain
`npm pack` leaves `catalog:` dependencies that npm cannot install. Inspect the
archive manifest and prove an actual npm install, not just unpack/import.
Pin the peer versions used by a fixture explicitly; npm may otherwise choose
newer optional peers that disagree with the package's declared React version.
