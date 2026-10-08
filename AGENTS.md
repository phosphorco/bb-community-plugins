# Repository contract

This public monorepo contains independently released bb plugins under
`plugins/<id>`. Keep each directory, package-derived plugin ID, collection
entry, release tag prefix, and marketplace entry ID identical.

Shared libraries live under `packages/<name>` and are published to npm as
`@phosphorco/<name>` (`bb-identity`, `bb-provider-settings`). `packages/*` is
the first npm workspace, so the libraries build before the plugins that
consume their `dist/`. Plugins depend on an exact registry version, which npm
links to the local workspace; never use `file:`, `link:` or tarball
specifiers. The packages build and test with Bun through their exact `bun`
devDependency. Keep their `exports` and peer ranges stable within a version;
a changed public contract needs a new version.

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

## Recoverable errors

Plugin error UI must describe the current failure. Automatically clear an error
when a successful read, authoritative snapshot, or confirmed operation resolves
that same failure, including recovery with unchanged content. Do not require
manual dismissal or a page reload. Keep the last good content during outages.
Starting a retry or reconnecting alone is not proof of recovery; unrelated
success must not clear a failed write or an unknown operation outcome.

Use existing subscriptions and reconnect signals to observe recovery. Where a
read needs retries, share them within the mounted resource, bound their rate,
pause while hidden, and cancel on teardown. Do not automatically replay writes.
Cover failure → automatic recovery and stale-response/teardown behavior in tests.
