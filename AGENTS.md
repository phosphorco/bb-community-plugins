# Repository contract

This public monorepo contains independently released bb plugins under
`plugins/<id>`. Keep each directory, package-derived plugin ID, collection
entry, release tag prefix, and marketplace entry ID identical.

Use ordinary npm-compatible dependency versions because bb Git installs run
`npm install --omit=dev`. Runtime and build-required imports belong in
`dependencies`; types and local tooling belong in `devDependencies`.

Before handoff run `npm run test`, `npm run typecheck`, and `npm run build`.
Never commit generated `dist/` output. Preserve Agentation's upstream
attribution and complete plugin-scoped third-party notices.
