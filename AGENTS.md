# Repository contract

This public monorepo contains independently released bb plugins under
`plugins/<id>`. Keep each directory, package-derived plugin ID, collection
entry, release tag prefix, and marketplace entry ID identical.

Use ordinary npm-compatible dependency versions because bb Git installs run
`npm install --omit=dev`. Runtime and build-required imports belong in
`dependencies`; types and local tooling belong in `devDependencies`.

Import SDK types through the public `@get-bb/plugin-sdk` package and declare an
exact development dependency per plugin. Keep older supported targets explicit;
do not copy SDK declarations into `types/` or add SDK TypeScript path aliases.
Manifests and TypeScript configurations are maintained in this repository; the
organization repository's workspace generator does not own these files.
After changing a pin, regenerate the npm lock, run `npm ci`, and use a matching
SDK CLI for the build. `bb plugin types` explicitly changes a package pin and is
not part of a routine build check.

Before handoff run `npm run test`, `npm run typecheck`, and `npm run build`.
Never commit generated `dist/` output. Preserve Agentation's upstream
attribution and complete plugin-scoped third-party notices.
