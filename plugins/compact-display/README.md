# Compact display

Enable **Compact display** in BB's Plugins settings to keep thread conversations
and their composers within a centered responsive column and reduce the prompt editor's maximum
height and spacing. The height cap respects BB's corrected shell height when a
keyboard shrinks the visible area, as well as the native editor's available-height
budget. Long drafts scroll inside the editor. Narrow panes and mobile screens still shrink to fit. The
column maximum includes its padding. To restore BB's defaults, select **Default**
in Appearance and disable the plugin.

In **Settings → Plugins → Compact display**, **Hide update-ready notifications**
is on by default. Turn it off to show the sidebar's update-ready link again.
Changes apply immediately; the Updates settings page remains available either way.
Like BB's other plugin settings, this preference is shared by the deployment.
Active update progress stays visible. If the initial settings read is unavailable,
notifications stay visible until settings load; later read failures retain the last
applied preference.

On touch devices or viewports below 768px, typing controls use at least 16px
text before and during focus, including plugin forms mounted later. This covers
text inputs, textareas, selects, and contenteditable editors throughout the app,
and preserves larger inherited font sizes. Non-typing inputs are excluded.
The rule does not disable pinch zoom or change the native composer expansion.

| Available thread-container width | Column maximum |
| --- | --- |
| Below 1080px | 760px |
| 1080–1439px | 1080px |
| 1440px and above | 1440px |

The named `bb-compact-thread` inline-size container measures each thread window,
so sidebars and split panes count against the available space. Both conversation
and composer use the same breakpoints, without viewport listeners or observers.

This is the shared home for our CSS overrides of native BB UI. Keep these rules
in `app.ts` and the shared `thread-width.css`, with their DOM dependencies and interactions
documented together. Styles for UI owned by other plugins remain with those plugins.

Thread width is in `thread-width.css`, imported by the app so BB owns its stylesheet
load and removal on disable/reload. The same file is a public native appearance
theme: **Default + wide thread columns**. Selecting it in Settings → Appearance
keeps the Default palette and code themes, and allows BB's existing appearance
cache to apply the pane-responsive widths before app rendering on subsequent
loads of that client. No plugin script, timer or observer restores it.

Appearance is shared by this deployment. The theme ID is
`plugin:compact-display:wide-default`. Selecting another palette also selects
another theme: its early widths require a matching wide variant; Compact's app
stylesheet still supplies the later fallback. A new client, cleared or denied
local storage, and the first load before appearance has been confirmed can still
start at native width. This is a returning-client improvement, not a universal
first-paint guarantee. If Compact is disabled while its theme is selected, native
appearance resolves the unavailable theme to Default on its next configuration
read; cached CSS can precede that read. Select Default explicitly when retiring
the wide layout.

The plugin mounts its other overrides in one inline stylesheet through the public
content-script SDK and removes it when disabled, unloaded, or reloaded. BB owns the boolean setting's
control and persistence; one app-wide component uses the SDK settings hook to
apply its value to the stylesheet through a document attribute. It retains the
last applied preference if settings are temporarily unavailable and removes the attribute
on unload. There are no custom RPC handlers, database access, observers, or timers.
CSS applies automatically to new threads, composers, sidebar links, and viewport changes.

The override dependencies are:

| Rule | BB DOM dependency | Interaction |
| --- | --- | --- |
| Update-ready notification | `[data-sidebar="sidebar"]` links to `/settings/update` or `/settings/updates` with `data-testid="sidebar-updates-badge-*"`; progress uses `[data-icon="Loading"]` | Hides ready notification badges after settings load; keeps running-update progress, Updates navigation, and the settings page available. Older UI without the badge marker is not covered. |
| Thread/composer maximum | `data-thread-window` and the `max-w-[760px]` class | Establishes a named inline-size container and caps both native columns at 760/1080/1440px together; excludes home/settings and uncapped embedded panels. |
| Composer spacing | `data-promptbox-action-row` | Reduces action-row padding for all composers. |
| Composer height | `data-promptbox-editor-scroll`, `--bb-shell-height`, and `--composer-editor-available-height` | Caps height at the smaller of 30dvh minus 3rem, 30% of the corrected shell height minus 3rem, and BB's available editor height. Falls back to viewport units when no corrected height exists. Reduces top padding. |
| Mobile typing size | Native `input`, `textarea`, `select`, and editable `contenteditable` attributes in the app document | Enforces a 16px floor with `!important` against compact field utilities; applies to coarse pointers in any orientation or widths below 768px. Does not enter iframe documents or shadow roots. |

Tables and figures retain BB's native breakout sizing and can extend beyond the
text column. Compact display does not override the native table breakout limit.
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

### Mobile browser check

`tools/mobile-inputs.mjs` checks the installed plugin in a live BB UI, saves
composer screenshots and geometry before/after a touch tap, a synthesized touch
scroll attempt, and wheel scrolling, audits
visible typing controls on thread/settings routes, and checks late-mounted
small-font control fixtures. It compares the loaded stylesheet with a local
browser-only disabled-sheet control; it never disables the live plugin globally
or submits a message. Desktop and touch landscape cases are included.
Choose a thread without a full Thread Brief overlay covering its composer.
Set `BB_RELOAD_CHECK=1` to reload Compact display once during the phone case
and verify that exactly one stylesheet remains mounted. An unchanged bundle
may retain its existing stylesheet.

Install Playwright Core in a scratch directory and provide its module and a
Chromium executable, a BB UI URL, an existing thread, and an evidence directory:

```sh
npm install --prefix /tmp/bb-mobile-probe playwright-core@1.58.2
PLAYWRIGHT_MODULE=/tmp/bb-mobile-probe/node_modules/playwright-core/index.mjs \
CHROME_EXECUTABLE=/path/to/chrome \
BB_URL=http://127.0.0.1:38888 BB_TEST_THREAD=thr_example \
BB_EVIDENCE_DIR=/tmp/mobile-input-evidence \
node plugins/compact-display/tools/mobile-inputs.mjs
```

Chromium touch emulation verifies computed CSS and layout, not iOS WebView's
keyboard, automatic focus zoom, or visual-viewport panning. Confirm those on
an actual iPhone WebView; a smaller Playwright viewport is not a native keyboard.

With the same environment variables, run `tools/keyboard-viewport.mjs` for the
long-draft regression. It types a disposable 30-line draft in an ephemeral browser
context (BB stores drafts in that context's localStorage), never submits it, and
models visible heights of 500, 380, 300, and 250px while layout height stays 844px.
The loaded CSS must keep the composer in the modeled visible band and preserve an
80px native available-height constraint. A browser-only control restoring the old
`30dvh` cap must reproduce clipping at 300/250px. The probe also records a separate
simulated zoom case; it does not assert that keyboard zoom/panning is fixed.

Run browsers and expensive checks on `b2-hel`, not the BB service machine or
`b1-hel`. Keep remote source snapshots as verification inputs, with hashes checked
against canonical sources. Live plugin loading remains from the canonical path.
