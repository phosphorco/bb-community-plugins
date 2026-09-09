<div align="center">

# Phosphor plugins for bb

**Open-source extensions for [bb](https://getbb.app).**

</div>

| Plugin | Purpose |
|---|---|
| [Message Timings Nerd](plugins/message-timings-nerd/) | Send times, agent turnaround, and waits between replies. |
| [Cross References](plugins/cross-references/) | Connect and discover related resources through authority-free multipart identities. |
| [Machine Monitor](plugins/machine-monitor/) | Monitor the deployment machine and keep exact BB thread context attached locally and discoverable from those threads. |
| [Agentation → Mentions](plugins/agentation-mentions/) | Based on Agentation by Scott Sunarto; adds native mentions, queued delivery, and verified identity tags. |
| [Perspectives](plugins/perspectives/) | Consult independent expert agents and synthesize evidence across caller-selected lenses. |
| [Sticky Notes](plugins/sticky-notes/) | Leave shared, movable notes directly on bb threads. |
| [BB UI Reference](plugins/bb-ui-reference/) | Explore BB's plugin surfaces and active semantic theme palette. |
| [Analytics](plugins/analytics/) | Explore fast, code-authored dashboards for agent tool reliability and performance. |
| [Restart Resume](plugins/restart-resume/) | Resume threads left interrupted by a host daemon restart, with project-specific recovery messages. |

## Install directly

Each plugin is published independently to npm by its prefixed release tag:

```sh
bb plugin install npm:@phosphorco/bb-plugin-cross-references@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-machine-monitor@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-agentation-mentions@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-perspectives@^0.2.0
bb plugin install npm:@phosphorco/bb-plugin-sticky-notes@^0.1.1
bb plugin install npm:@phosphorco/bb-plugin-bb-ui-reference@^0.1.1
bb plugin install npm:@phosphorco/bb-plugin-analytics@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-restart-resume@^0.1.0
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
bb plugin install path:. --plugin agentation-mentions --yes
```

## Licensing and provenance

Phosphor-authored plugins are MIT licensed. Agentation preserves its upstream
attribution and plugin-scoped third-party notices, including the PolyForm
Shield 1.0.0 terms of its vendored `agentation` dependency. See each plugin directory
for its exact license and notices.
