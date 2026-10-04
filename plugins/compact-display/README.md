# Compact display

Enable **Compact display** in BB's Plugins settings to reduce the prompt editor's
maximum height and spacing. Disable the plugin to restore BB's defaults.

The plugin mounts one inline stylesheet through the public content-script SDK
and removes it when disabled, unloaded, or reloaded. It has no custom settings,
database access, RPC calls, network requests, subscriptions, observers, or timers.
Only BB's normal plugin bundle loading and enable/disable persistence are needed.
CSS applies automatically to new composers and viewport changes.

The selectors depend on BB's `data-promptbox-action-row` and
`data-promptbox-editor-scroll` DOM attributes. If BB changes those attributes,
update this plugin; no fork patch is needed.

Install from the canonical workspace:

```sh
bb plugin install path:/home/ubuntu/bb/community-plugins/plugins/compact-display --yes
```

The `npm run build`, `npm run dev`, and `npm run typecheck` commands are for
development inside this repository: they use its pinned CLI and shared TypeScript
configuration. To build a standalone source package, use `bb plugin build <path>`
with a compatible BB CLI. Published packages include the built `dist/` assets.
