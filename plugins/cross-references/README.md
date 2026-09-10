# Cross References

Cross References is a BB community plugin and public package for connecting
resources without requiring a central registry of resource kinds. Its v1
proving slice is deployment-local and exact-only: Machine Monitor can link to
BB threads, and each thread can show the Machine Monitor source context.
Additional providers, definitions, and contained lookups remain architectural
follow-ons, not current ingestion or public API promises.

The package's product vision, authority-free data model, architectural
constraints, and proving slice are in
[ARCHITECTURE.md](./ARCHITECTURE.md).

[IMPLEMENTATION.md](./IMPLEMENTATION.md) is the normative, executable contract
for the first exact-reference slice. The shipped Cross References backend,
Machine Monitor source adapter, bounded thread picker, and thread-header
backlink form one deployment-local, exact-only proving spine.

The spine connects the Machine Monitor page to BB threads, keeps local source
truth available when Cross References is absent, and surfaces the corresponding
Machine Monitor source context on those threads. Shared dropdowns, public
definition helpers, containment reads, and additional providers such as GitHub
remain deferred.

## Development

```sh
npm run test --workspace @phosphorco/bb-plugin-cross-references
npm run typecheck --workspace @phosphorco/bb-plugin-cross-references
npm run build --workspace @phosphorco/bb-plugin-cross-references
```
