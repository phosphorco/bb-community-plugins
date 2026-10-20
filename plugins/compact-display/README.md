# Compact display

Enable **Compact display** in BB's Plugins settings to keep thread conversations
and their composers within a centered responsive column, constrain wide Markdown tables
to that column with horizontal scrolling, and reduce the prompt editor's maximum
height and spacing. Narrow panes and mobile screens still shrink to fit. The
column maximum includes its padding. Disable the plugin to restore BB's defaults.

| Available thread-container width | Column maximum |
| --- | --- |
| Below 1080px | 760px |
| 1080–1439px | 1080px |
| 1440px and above | 1440px |

The named `bb-compact-thread` inline-size container measures each thread window,
so sidebars and split panes count against the available space. Both conversation
and composer use the same breakpoints, without viewport listeners or observers.

This is the shared home for our CSS overrides of native BB UI. Keep these rules
in the single stylesheet in `app.ts`, with their DOM dependencies and interactions
documented together. Styles for UI owned by other plugins remain with those plugins.

The plugin mounts one inline stylesheet through the public content-script SDK
and removes it when disabled, unloaded, or reloaded. It has no custom settings,
database access, RPC calls, network requests, subscriptions, observers, or timers.
Only BB's normal plugin bundle loading and enable/disable persistence are needed.
CSS applies automatically to new threads, composers, and viewport changes.

The override dependencies are:

| Rule | BB DOM dependency | Interaction |
| --- | --- | --- |
| Thread/composer maximum | `data-thread-window` and the `max-w-[760px]` class | Establishes a named inline-size container and caps both native columns at 760/1080/1440px together; excludes home/settings and uncapped embedded panels. |
| Table containment | `data-thread-window` and inline `--md-table-breakout-max` | Overrides BB's measured breakout limit on the wrapper itself; the native inner table keeps horizontal scrolling. |
| Composer spacing | `data-promptbox-action-row` | Reduces action-row padding for all composers. |
| Composer height | `data-promptbox-editor-scroll` | Limits editor height relative to the viewport and reduces top padding. |

BB already caps ordinary thread columns at 760px. The table rule closes its
intentional wider-table exception. The separate native `--md-content-w` value
controls table minimum sizing, not the thread maximum; it is left intact.
If BB changes these attributes, classes, or table layout, update this plugin;
no fork patch is needed. Check a wide table, a narrow split pane, mobile, a new
thread, composer expansion, and disabling/re-enabling the plugin after updates.

Install from the canonical workspace:

```sh
bb plugin install path:/home/ubuntu/bb/community-plugins/plugins/compact-display --yes
```

The `npm run build`, `npm run dev`, and `npm run typecheck` commands are for
development inside this repository: they use its pinned CLI and shared TypeScript
configuration. To build a standalone source package, use `bb plugin build <path>`
with a compatible BB CLI. Published packages include the built `dist/` assets.
