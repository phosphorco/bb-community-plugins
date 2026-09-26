# Offline emitted artifact witness

Status: source/build witness only. This is not a browser cold-boot measurement
or evidence that the disabled Analytics plugin is live.

On 2026-09-22, a disposable replay of fork patch
`0028-feat-plugins-serve-versioned-lazy-frontend-artifacts.patch` produced the
following Analytics generation from the current source entry:

```
generation e7edf82041c444e8973f0f3b7c937b86
app.js                                      1,190 B
chunks/analytics-panel-JLKONELK.js         62,186 B
chunks/browser-engine-L5JARPZE.js         234,573 B
chunks/echarts-figure-XNVPTP2U.js           7,353 B
chunks/chunk-DZ5DMSSV.js                  548,834 B
chunks/chunk-MUVHO573.js                  338,042 B
```

The v2 manifest lists every JavaScript and CSS artifact with a generation,
byte count, SHA-256, and declared content type. The generated `app.js` entry
contains only registration, route fallback, and a generation-pinned dynamic
import of the Analytics surface. A case-insensitive scan of that entry found no
`echarts`, `duckdb`, `mermaid`, `browser-engine`, `skills-dashboard`,
`analytics-export`, or `compileECharts` token. The build emits no legacy
`dist/app.js` or `dist/app.css`, so an artifact-v1 server cannot silently serve
a v2 entry whose chunks it does not understand.

The exact disposable replay steps were:

```sh
replay_root="$(mktemp -d /tmp/bb-lazy-artifact-v2.XXXXXX)"
fork/scripts/materialize "$replay_root/bb"
pnpm --dir "$replay_root/bb" install --frozen-lockfile
pnpm --dir "$replay_root/bb" exec turbo run build:runtime --filter=@get-bb/plugin-sdk
cp -a community-plugins/plugins/analytics "$replay_root/analytics-plugin"
cd "$replay_root/analytics-plugin"
"$replay_root/bb/node_modules/.bin/tsx" "$replay_root/bb/packages/plugin-build/src/cli.ts" prepare-bundled
```

The copy uses the community dependency tree only for offline resolution; it
does not modify the source plugin or a materialized BB runtime. Exact chunk
names and generations vary on each build. The durable focused checks are the
Analytics lazy-boundary source test, the fork builder v2 test, and the server
plugin-artifact route test. A coordinated cold-browser/network acceptance run
is still required before any Analytics activation.
