# Packaging

`bun run build` emits every public entry (`.`, `./bb`, `./react`, `./testing`,
`./testing/react`) through the public Bun.build API with the automatic JSX
runtime, `development:false`, `minify:false` and an explicit production
`NODE_ENV` define, then emits declarations with `tsc --project
tsconfig.declarations.json`. The workspace generator supplies the entries,
targets and externals; React, React DOM, jsdom and the SDK are never bundled.
Testing-kit entries import sibling public entries as externals, so a consumer's
kit and production imports share one module instance.

`bun run test` rebuilds, then runs the package's own public-entry, protocol,
controls and conformance-kit tests against the emitted entries. Consumer
integration is tested in each adopting plugin, not here. The historical
packed-archive, reproducibility, consumer-registry and host-receipt tooling was
retired; its evidence is preserved outside the package.
