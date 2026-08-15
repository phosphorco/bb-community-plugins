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

Each plugin is released independently from this monorepo:

```sh
bb plugin install git:https://github.com/phosphorco/bb-community-plugins.git@^0.1.0 --plugin agentation --tag-prefix agentation/
bb plugin install git:https://github.com/phosphorco/bb-community-plugins.git@^0.1.0 --plugin perspectives --tag-prefix perspectives/
bb plugin install git:https://github.com/phosphorco/bb-community-plugins.git@^0.1.0 --plugin sticky-notes --tag-prefix sticky-notes/
bb plugin install git:https://github.com/phosphorco/bb-community-plugins.git@^0.1.0 --plugin bb-ui-reference --tag-prefix bb-ui-reference/
```

The plugins are also submitted to the BB Community marketplace for installation from bb.

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
