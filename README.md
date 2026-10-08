<div align="center">

# Phosphor plugins for bb

**Open-source extensions for [bb](https://getbb.app).**

</div>

| Plugin | Purpose |
|---|---|
| [Figma](plugins/figma/) | Manage shared Figma connections, cached figmog reads and the official MCP tools for design edits. |
| [Compact display](plugins/compact-display/) | Reduce prompt editor height and spacing with the plugin enable switch. |
| [Message Timings Nerd](plugins/message-timings-nerd/) | Send times, agent turnaround, and waits between replies. |
| [Cross References](plugins/cross-references/) | Connect and discover related resources through authority-free multipart identities. |
| [Machine Monitor](plugins/machine-monitor/) | Monitor the deployment machine and keep exact BB thread context attached locally and discoverable from those threads. |
| [Agentation → Mentions](plugins/agentation-mentions/) | Based on Agentation by Scott Sunarto; adds native mentions, queued delivery, and verified identity tags. |
| [Perspectives](plugins/perspectives/) | Consult independent expert agents and synthesize evidence across caller-selected lenses. |
| [Sticky Notes](plugins/sticky-notes/) | Leave shared, movable notes directly on bb threads. |
| [BB UI Reference](plugins/bb-ui-reference/) | Explore BB's plugin surfaces and active semantic theme palette. |
| [BB Plugin Guide for Nerds](plugins/plugin-guide-for-nerds/) | Open the complete Plugin Guide as a floating companion (in development). |
| [Analytics](plugins/analytics/) | Explore fast, code-authored dashboards for agent tool reliability and performance. |
| [Restart Resume](plugins/restart-resume/) | Resume threads left interrupted by a host daemon restart, with project-specific recovery messages. |
| [Attach Text Snippets](plugins/attach-text-snippets/) | Paste long text into durable thread files and attach compact references to conversations. |

## Packages

Shared libraries for bb integrations, published to npm:

| Package | Purpose |
|---|---|
| [`@phosphorco/bb-identity`](packages/bb-identity/) | Portable identity, provenance, and state contracts for BB integrations. |
| [`@phosphorco/bb-provider-settings`](packages/bb-provider-settings/) | Explicit owner-bound provider role settings. |
| [`@phosphorco/bb-cross-references`](packages/bb-cross-references/) | Reference contracts, explicit clients, and a reusable linked-reference editor. |

Plugins in this repository depend on their exact released versions; npm
workspaces link them to the local `packages/` sources during development.

## Install directly

Each plugin is published independently to npm by its prefixed release tag:

```sh
bb plugin install npm:@phosphorco/bb-plugin-cross-references@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-machine-monitor@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-agentation-mentions@^0.2.0
bb plugin install npm:@phosphorco/bb-plugin-perspectives@^0.3.0
bb plugin install npm:@phosphorco/bb-plugin-sticky-notes@^0.1.2
bb plugin install npm:@phosphorco/bb-plugin-bb-ui-reference@^0.1.2
bb plugin install npm:@phosphorco/bb-plugin-analytics@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-restart-resume@^0.1.0
bb plugin install npm:@phosphorco/bb-plugin-attach-text-snippets@^0.1.0
```

The plugins are also submitted to the BB Community marketplace for installation from bb.

## Release

Push an immutable `<plugin-id>/vX.Y.Z` tag whose version matches that plugin's
manifest. Shared libraries use `<name>/v<version>` tags:
`bb-identity/v0.1.0` and `bb-provider-settings/v0.1.0` for their initial releases.
GitHub Actions tests, typechecks, builds, inspects, and publishes only the tagged
workspace. Library releases include npm provenance.

To verify an existing tagged release without publishing, dispatch `publish.yml`,
select the plugin or library, and set `dry_run` to `true`. The workflow runs the
same checks, prints `dry run: <workspace>`, and uploads
`release-receipt-<name>` with the dry-run flag, workspace, source path, commit SHA,
and target name. The publish step is skipped; tag pushes publish normally.

Bootstrap each package's first release with a temporary repository `NPM_TOKEN`.
Then configure its npm trusted publisher for the `phosphorco` organization,
`bb-community-plugins` repository, and `publish.yml` workflow, and delete the
token. Subsequent releases use GitHub OIDC; the workflow retains the token
fallback for first releases.

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
