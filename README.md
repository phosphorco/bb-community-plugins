<div align="center">

# Phosphor plugins for bb

**Open-source extensions for [bb](https://getbb.app).**

</div>

| Plugin | Purpose |
|---|---|
| [Agentation](plugins/agentation/) | Turn visual feedback on any bb surface into structured annotations an agent can act on and resolve. |
| [Perspectives](plugins/perspectives/) | Consult independent expert agents and synthesize evidence across caller-selected lenses. |
| [Sticky Notes](plugins/sticky-notes/) | Leave shared, movable notes directly on bb threads. |
| [BB UI Reference](plugins/bb-ui-reference/) | Explore BB's plugin surfaces and active semantic theme palette. |

## Install directly

Each plugin is published independently to npm by its prefixed release tag:

```sh
bb plugin install npm:@phosphorco/bb-plugin-agentation@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-perspectives@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-sticky-notes@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-bb-ui-reference@^0.1.0
```

The plugins are also submitted to the BB Community marketplace for installation from bb.

## Release

Push an immutable `<plugin-id>/vX.Y.Z` tag whose version matches that plugin's
manifest. GitHub Actions tests, typechecks, builds, inspects, and publishes only
the tagged workspace. The first release uses the repository's `NPM_TOKEN`;
after trusted publishing is configured for each npm package, releases use OIDC
with automatic npm provenance.

## Develop

```sh
npm install
npm run test
npm run typecheck
npm run build
```

Install a development checkout by name:

```sh
bb plugin install path:. --plugin agentation --yes
```

## Licensing and provenance

Phosphor-authored plugins are MIT licensed. Agentation preserves its upstream
attribution and plugin-scoped third-party notices, including the PolyForm
Shield 1.0.0 terms of its `agentation` dependency. See each plugin directory
for its exact license and notices.
