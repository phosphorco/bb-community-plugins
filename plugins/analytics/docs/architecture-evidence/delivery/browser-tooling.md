# Browser-verification tooling source receipt

Status: source-ready plus bounded tooling smoke PASS, 2026-09-09. This receipt
covers the Analytics manifest, source-owned tooling smoke, and this document.
The parent completed one bounded tool-readiness run; this receipt does not
create the production browser binding or establish UI, performance, packaging,
or host acceptance.

## Direct tool selection

The Analytics manifest now directly pins these test-only tools:

| Package | Exact version | Source use |
| --- | --- | --- |
| `@playwright/test` | `1.63.0` | Future test-owned UI binding; imports `chromium`. |
| `vite` | `8.2.2` | Future local fixture server; imports `createServer`. |
| `@get-bb/plugin-sdk` | `0.4.15` | Existing controlled fixture's public SDK testing/app seam. |
| `vitest` | `4.1.11` | Existing DOM component test and `vitest/config` import. |
| `jsdom` | `26.1.0` | Existing component test environment only. |
| `@testing-library/react` | `16.3.3` | Required runtime closure for the public SDK testing/app export. |

These are direct `devDependencies`, not runtime dependencies. Existing
`zod`, React, ECharts, DuckDB runtime, and other package dependencies remain
unchanged. The authored `files` list and existing package scripts remain
unchanged; no pretend acceptance script was added. Analytics does not add a
`bb-identity` dependency or a feature-local identity workaround.

The direct SDK pin is not sufficient by itself for a clean fixture. The
resolved `@get-bb/plugin-sdk@0.4.15` export
`./testing/app -> ./dist/testing/app.js` has a static import at
`dist/testing/app.js:11`:

```js
import { act, render } from "@testing-library/react";
```

The SDK package metadata marks that peer optional, but the installed public
runtime imports it. Therefore Analytics directly pins
`@testing-library/react@16.3.3`, matching the current community lock and
installed package identity. That package declares nonoptional peer
`@testing-library/dom: ^10.0.0`; the current lock and installed tree resolve it
to `@testing-library/dom@10.4.1`. Analytics does not directly import
`@testing-library/dom`, so it is intentionally not a direct manifest
dependency. The parent PASS receipt confirms this six-direct-tool plus peer
closure.

The parent checked exact npm registry metadata and integrity data. The parent
lock receipt records the six direct tools and the lock-reproducible
`@testing-library/dom@10.4.1` peer without changing the root manifest; this
source lane did not edit `community-plugins/package-lock.json`.

## Source-to-tool map

### Existing component-only fixture

`test/architecture/browser/ui/execution-backed-ui.fixture.tsx` imports
`installTestPluginRuntime`, `renderSlot`, and `RenderedSlot` from the public
`@get-bb/plugin-sdk/testing/app` export. `mountExecutionBackedDashboard()` calls
`installTestPluginRuntime()` before its dynamic `import("../../../../app.tsx")`,
then mounts the ordinary test wrapper through the actual public `renderSlot`.
This is the installed public SDK testing seam with a controlled execution
client; it is not a production registration or a browser-server binding.

`test/architecture/browser/ui/vitest.config.ts` imports `defineConfig` from
`vitest/config`, selects `jsdom`, and includes the component test. The test
also declares `// @vitest-environment jsdom`. This evidence remains
component-only: it does not prove Chromium, Vite serving, real browser
navigation, or the production router.

### Future browser binding, deliberately absent here

The future test-owned UI binding is expected at the existing router target
`test/architecture/browser/bindings/ui.mjs`. It will import:

```js
import { chromium } from "@playwright/test";
import { createServer } from "vite";
```

That binding is not created by this receipt. The current production router
still points the `ui` suite at that missing module, so the production browser
binding is absent and the UI browser route remains blocked/nonpassing.

When the UI owner implements it, Vite must serve an explicit local fixture
root with explicit source-controlled aliases. It must bind only to loopback
(`127.0.0.1`) on an ephemeral port (`0`), discover the resolved URL, and use
the fixture's local modules and controlled transport. It must not start the
normal BB server or use a live SDK/service as the fixture authority. Browser,
context/page, Vite server, and temporary resources must be closed in
`finally`; the binding must report observed close/exit and must not leave
children or listeners behind.

The future Vite config must retain these exact SDK aliases:

```js
resolve: {
  alias: [
    { find: "@bb/plugin-sdk/app", replacement: "@get-bb/plugin-sdk/app" },
    { find: "@bb/plugin-sdk", replacement: "@get-bb/plugin-sdk" },
  ],
},
```

The resolved SDK provenance is the community workspace's
`node_modules/@get-bb/plugin-sdk` package at `0.4.15`, using its public
`./app` and `./testing/app` exports and recording both resolved realpaths; it
is not a source-relative `@bb` import, sibling plugin installation, or ambient
shim. The current lock records the registry artifact
`https://registry.npmjs.org/@get-bb/plugin-sdk/-/plugin-sdk-0.4.15.tgz` with
integrity
`sha512-Fvupo7ncvwxbbgeBWu3xz8rtiRg54RXuZY2tqAdeVQ9i5R8wO1+FGCcBiqEnwxUv7iEaJIkHBFOjpcaar9sr/w==`;
the parent’s four-entry semantic before/after lock diff leaves the root
manifest unmodified.

The real browser fixture also needs to exercise the current public compiler's
actual update decisions. Its component topology currently uses the one-series
identity `series-${visualization.id}`. The existing synthetic two-series
removal case is invalid for that public compiler and is a later UI-owner
repair, not browser-tooling evidence.

## Browser binary policy

Later Analytics browser setup must use the driver resolved by the community
workspace and set:

```text
PLAYWRIGHT_BROWSERS_PATH=0
```

This makes Chromium package-local to the resolved Playwright installation.
The parent recorded the actual resolved `playwright-core` package path and the
exact `browsers.json` revision/provenance before the run. If the package-local
Chromium binary is absent, the browser run is blocked; it must not silently
fall back.

The policy forbids importing a driver or browser from a sibling plugin's
`node_modules`, a global driver/browser cache, an unrelated workspace, or an
operator machine cache. Do not use `--with-deps`: it would mutate machine
packages beyond this bounded source/tooling task. The completed parent receipt
below is package-local only-shell plus ffmpeg installation, with no full Chrome
or system-dependency claim.

The parent installed the package-local only-shell target: Chromium
`153.0.8010.12`, revision `1243`, plus ffmpeg revision `1011`, under the
community-resolved `playwright-core/.local-browsers` location. Full Chrome is
intentionally absent. The bounded install used no removals, no system
dependencies, and no `--with-deps`; the package-local artifacts are distinct
from any upstream/full-Chrome packaging. The parent recorded the resulting
`playwright-core/browsers.json` SHA-256 as
`545d52f8382c391e605562c330e9c1c534a16045898203037a49bb8bd769a946` and the post-install
community lock as SHA-256
`b9e6e457006eb060990fc62e9eb2a39be6577ca35a7502f6b27b6afc0b3c6423`.

The six direct tools and the nonoptional `@testing-library/dom@10.4.1` peer
are lock-reproducible. The parent’s before/after semantic lock review found a
four-entry delta and an unmodified root manifest. The direct package artifacts
were checked against exact registry metadata/integrity; the package-local
browser result does not claim a full Chrome executable or machine-level setup.

## Source-owned tooling smoke

`test/architecture/browser/tooling-smoke.mjs` is a tool-readiness smoke only.
With no arguments, its parent branch invokes the existing
`runSupervisedNode` with exactly the named `--child` branch, a fixed 45-second
deadline, and a 16-KiB output cap. Arbitrary shell or command arguments are
rejected. The child sets `PLAYWRIGHT_BROWSERS_PATH=0` before dynamically
importing `@playwright/test`, resolves the Analytics manifest, community-owned
package/export paths, and `playwright-core/browsers.json`, and reports missing
packages or package-local browser artifacts as explicit nonzero `blocked`
results. Package metadata is found by a bounded nearest-ancestor lookup from
each resolved public package entry, validating its name, exact version, and
community `node_modules` realpath. An export restriction or malformed/present
package is a nonzero `fail`, not a missing-package `blocked`; present import or
launch defects are nonzero `fail` results.

The child creates one exact `mkdtemp`-owned directory and gives it to Vite as
`cacheDir`; it removes only that exact directory in `finally`. It then creates
a real Vite server with `configFile: false`, `envFile: false`, Analytics as its
root, the exact source-owned SDK aliases below, loopback `127.0.0.1`,
ephemeral port `0`, `watch: null`, HMR disabled, and no normal BB server. Its
fixed virtual fixture imports React, `@bb/plugin-sdk/app`, and
`@bb/plugin-sdk/testing/app`; it records function/module types, emits a small
schema-valid observation, and creates one deterministic DOM marker. Playwright
loads that marker from the served ES module and rejects any non-loopback page
request. This proves pinned package resolution, Vite transformation, aliases,
and browser launch only; it does not mount Analytics, use ECharts or DuckDB,
read data, use a live SDK/service, or prove UI semantics.

The smoke's bounded run used `envFile: false` as part of its explicit Vite
options and emitted only the known 72-byte nonfatal deprecation warning that
Vite recommends `envDir: false`. No scope fix or rerun was made for that
warning. A future UI binding should use `envDir: false`.

The smoke uses only public Playwright lifecycle APIs. It records the actual
`browserServer.process().spawnfile` and `pid`, browser version, and the
explicit `{ headless: true, host: "127.0.0.1", port: 0 }` launch with no
`executablePath` override. It validates the WebSocket endpoint host/port and
the spawnfile realpath inside the selected package-local
`chromium_headless_shell-1243` directory. On SIGTERM, the signal handler
immediately requests public `browserServer.kill()` (including the
launch-in-flight case) before the idempotent cleanup awaits any page,
context, browser-connection, or Vite graceful close. This prioritizes browser
termination before potentially slow graceful cleanup. Acquisition
fences stop new resources after a signal, and the authoritative `finally`
cleanup waits for those in-flight acquisitions before closing them. Playwright's
default `launchServer()` signal handling remains enabled. Normal success may
close gracefully, while every path waits for and records observed browser
process exit and close events. External-request, page-error, module-response,
local-browser-entry, and protocol observations are bounded; the parent accepts
exactly one child receipt with the expected kind/version and rejects missing,
malformed, or duplicate receipts. The receipt records browser-server close,
Vite listening false, tracked socket cleanup, exact temporary-directory
removal, and cleanup errors; closure is never claimed without the
corresponding observation. The successful smoke exercised normal cleanup;
signal/cancellation fault injection was not run and is not claimed by this
receipt. No private Playwright internals, report adapter,
shared-cache clearing, or fallback directory is used.

The parent ran the exact source smoke command once:

```sh
node community-plugins/plugins/analytics/test/architecture/browser/tooling-smoke.mjs
```

The parent supervisor reported exit `0`, both close and exit observed, no
termination reason, `5,938` bytes of stdout, and `72` bytes of stderr, using
the fixed 45-second deadline, 16-KiB output cap, and 1,000-ms kill/close grace
periods. The
actual browser was Chromium `153.0.8010.12`, PID `1798858`, with observed
`spawnfile` and realpath inside:
`/home/ubuntu/bb/community-plugins/node_modules/playwright-core/.local-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.
Its process exited with code `0`, with both exit and close observed. Vite bound
to `127.0.0.1:37383`; the browser WebSocket endpoint was
`127.0.0.1:41223`. The served module returned HTTP `200`, the marker observed
React and public SDK functions, and there were no external requests or page
errors. Cleanup observed page, context, browser connection, browser server,
and Vite closure true, five connections and zero open sockets, no errors, and
removed the exact cache directory
`/tmp/bb-analytics-tooling-smoke-WZkMWN`. The parent postcheck confirmed the
PID and ports were gone and the temporary directory was absent.

The source file used for this smoke has SHA-256
`da2fc60f808d05883fcf1356107e498df54407fe40369fa1890c1f4b4477ebbd`.

## Bounded runner and provenance

Later browser runs go through the existing
`test/architecture/acceptance.mjs` and
`test/architecture/browser/supervised-node.mjs` boundary. That supervisor is
the owner of the child deadline, bounded stdout/stderr capture, process-group
termination, grace periods, and close/exit observation. A browser binding must
not bypass it or create an unbounded detached process.

The completed parent receipt records:

- Node `22.21.1` compatibility, the exact command, community workspace cwd,
  and relevant environment including `PLAYWRIGHT_BROWSERS_PATH=0`;
- the resolved Analytics package/driver path, package versions and registry
  integrity, the installed `playwright-core` `browsers.json` revision, and
  the package-local Chromium path;
- setup and smoke stdout/stderr under the supervisor's byte cap, exit/close
  outcome, deadline/termination reason, and exact source hashes;
- cleanup confirmation for the browser context/page, browser process, Vite
  server, exact temporary fixture/cache directory, and supervisor child
  process group.

The package-local browser artifacts may remain as the explicitly recorded
dependency result. Temporary fixture and run directories must be removed by
the owning bounded operation, and cleanup must run on success, failure,
timeout, and cancellation. This receipt records the completed tooling result,
not production UI or host acceptance.

## Parent lock receipt

The parent’s lock-only command used the resolved npm 10.9.4 CLI under the
60-second/16-KiB supervisor (Node 22.21.1):

```sh
cd /home/ubuntu/bb/community-plugins
node /home/ubuntu/.local/share/mise/installs/node/22.21.1/lib/node_modules/npm/bin/npm-cli.js install --package-lock-only --ignore-scripts --no-audit --no-fund --workspace=@phosphorco/bb-plugin-analytics --loglevel=error --fetch-retries=0 --fetch-timeout=15000
```

The resulting lock is SHA-256
`b9e6e457006eb060990fc62e9eb2a39be6577ca35a7502f6b27b6afc0b3c6423`. The
before/after semantic lock review found a four-entry delta and an unmodified
root manifest. The six direct tools and the required
`@testing-library/dom@10.4.1` peer are included; no dependency substitution
was used.

The separately supervised install added the three Playwright packages,
removed none, and reified one unchanged-version Apache Arrow 17.0.0 package.
The latter was an upstream packaging omission: Arrow declares
`bin/arrow2csv.cjs`, while its locked registry archive contains `.js`/`.mjs`
entries instead. The parent verified the archive's locked SHA-512 and compared
all 1,007 files (5,308,201 bytes) before and after installation: no mismatched
or extra package files, excluding separately managed nested dependencies.
No bin shim or package-source workaround was added. This Arrow issue is
unrelated to the deliberate only-shell rather than full-Chrome selection.

The browser installation was separately bounded to 90 seconds/16 KiB:

```sh
cd /home/ubuntu/bb/community-plugins
PLAYWRIGHT_BROWSERS_PATH=0 PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=30000 node node_modules/playwright/cli.js install --only-shell --no-progress --no-remove chromium
```

It exited 0 with close/exit observed, 688 stdout bytes and no stderr. It did
not install system dependencies, remove other browser caches, or launch a
browser; the later smoke above performed the one actual launch.

## Receipt hashes

- Analytics `package.json`: SHA-256
  `4ab744e2c1f1cdb059ea1c11320df51e09d8bdc46e705c9b69832cd4a3787a09`.
- `playwright-core/browsers.json`: SHA-256
  `545d52f8382c391e605562c330e9c1c534a16045898203037a49bb8bd769a946`.
- Source smoke: SHA-256
  `da2fc60f808d05883fcf1356107e498df54407fe40369fa1890c1f4b4477ebbd`.

## Unresolved acceptance obligations

The bounded tooling artifact and parent smoke evidence are ready for the
`browser-verification-tooling` node's independent reviewer judgment. That
node does not require the future production UI binding. These separate
`execution-backed-ui` and integration obligations remain open:

1. A later UI-owner implementation of the missing binding with loopback
   ephemeral Vite serving, explicit fixture root/aliases, real public
   `renderSlot` setup where applicable, and no normal-server/live-SDK path.
2. UI-owner repair of the synthetic two-series case and a real browser proof
   of the public compiler's one-series update decisions.
3. The existing acceptance supervisor and production router must report the
   actual binding outcome; controlled jsdom positives or a missing binding
   cannot be relabeled as production UI acceptance.
