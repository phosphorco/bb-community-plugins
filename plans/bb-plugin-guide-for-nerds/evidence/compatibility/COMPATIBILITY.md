# Extraction compatibility receipt

Owner: Execution Steward `thr_pk5kwrdyjm`. Worker: `thr_4zxh9sadbe`.
Observed 2026-10-06. This receipt establishes build/source compatibility;
**no fixture was installed or loaded as a plugin and no native browser behavior
was observed**. The later source-adaptation lane remains unreleased.

## Recommendation

Pin ordinary public **`@get-bb/plugin-sdk: "0.5.29"` in devDependencies** for
this plugin. Its required app and testing contracts are published, with registry
integrity verified against the downloaded tarball. Use BB release **0.44.0**
registry controls at immutable upstream commit
`0baa605b32a00619c1d7e3f32be6553ebcf8244a`. No fork SDK tarball, private workspace
package, copied SDK declarations, TypeScript SDK aliases or sibling repins are
needed.

Select a **plugin-specific public `bb-app@0.44.0` builder** for the independent
single-file baseline. The collection's default `bb-app-target@npm:bb-app@0.42.0`
cannot compile this donor: it exits 1 for missing `useSdk` and
`experimental_Icon`, even with SDK 0.5.29 installed. An SDK pin alone does not
change the builder's runtime export manifest.

For the campaign's initial real network-lazy delivery on the existing admitted
machine, select the **existing canonical Phosphor CLI explicitly**, and declare
that the lazy build requires **both the patch-0028 builder and generation-serving
host** (or an independently proven equivalent). This machine already has that
capability; no host upgrade or fork change is requested. **Upstream BB
`>=0.44.0` is not a sufficient description of this floor.** A public single-file
build remains functionally usable but cannot satisfy the network-lazy acceptance
predicate. The steward must make that build selection explicit before the
scaffold and first-slice integration, rather than accidentally inheriting
`BB_CLI` or claiming public chunk support.

Alternatively, upstream delivery can use plugin-owned HTTP routes and separately
built deferred modules, described below. That fallback needs implementation and
its own fixture/live proof; this receipt does not certify it.

## Published SDK evidence

Exact npm metadata, tarball integrity/SHA-256 and upstream gitHead are retained in
[package-provenance.json](package-provenance.json) and `registry/`.
[sdk-facts.json](sdk-facts.json) records full published declaration/runtime file
hashes, symbol lines and excerpts. These are research evidence, not declarations
installed into the new plugin.

| Public SDK inspected | `useSdk` | `experimental_Icon` | app overlay | testing/app |
| --- | --- | --- | --- | --- |
| 0.4.47 | absent | absent | present | present |
| 0.5.29 | present | present | present | present |
| 0.6.15 (catalog target, retained source inspected) | present | present | present | present |
| 0.6.23 (independently latest SDK) | present | present | present | present |

This is a checked-version matrix, not a claim that 0.5.29 introduced every API.
The 0.5.29 app declaration has `experimental_appOverlay` at line 18638,
`experimental_Icon` at 19912 and `useSdk` at 19956. Its `testing/app` declaration
has `installTestPluginRuntime`, `loadPluginApp` and `renderSlot`; the retained
fixture executes installation and slot capture successfully. `renderSlot` was
inspected but not exercised by this worker. Footer registration uses
`{ id, title, icon, run }`, not the experimental unified-footer item's
`{ label, onActivate }` shape. The fixture's typecheck checks the public contracts.

Primary package sources:
[SDK 0.5.29 metadata](https://registry.npmjs.org/@get-bb%2Fplugin-sdk/0.5.29),
[SDK package at matching release commit](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-sdk/package.json),
[SDK app contract](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-sdk/src/app-contract.ts).
SDK 0.5.29 and bb-app 0.44.0 share the same published gitHead.

The catalog worker's dated research at **2026-10-06 20:55 UTC** identifies newest
published stable **bb-app 0.45.0 paired with SDK 0.6.15**, both gitHead
`129f621771a3e275773992db648316966ac207cf`. This worker read that retained
[REPORT.md](../../catalog-target/REPORT.md) and
[release-receipt.json](../../catalog-target/release-receipt.json), checked both
shipped builtin Plugin Guide app/server metadata files for the 0.45.0/0.6.15 pair,
and inspected SDK 0.6.15's required public declarations. Reference file hashes
are recorded under `catalogTargetResearch` in the pinned contract. Primary
[BB release](https://github.com/get-bb/bb/releases/tag/desktop-v0.45.0),
[BB package](https://registry.npmjs.org/bb-app/0.45.0),
[matching SDK package](https://registry.npmjs.org/@get-bb%2fplugin-sdk/0.6.15), and
[release SDK manifest](https://github.com/get-bb/bb/blob/129f621771a3e275773992db648316966ac207cf/packages/plugin-sdk/package.json)
identify this pairing. Independently latest **SDK 0.6.23** instead has gitHead
`985a267f363f9339472ae3175f49b73efb6f3329`; it is not the SDK matching BB 0.45.0.

This is preliminary retained research, **not acceptance of the catalog node or
fixture/runtime certification of the 0.45.0 pair**. The initial deployed-host
SDK 0.5.29/public baseline builder 0.44.0 and existing fork-lazy choice remain
unchanged. Catalog descriptions can target 0.45.0/0.6.15 while current-host
runtime/build compatibility stays explicitly separate.

## Actual build CLI and artifact contract

The ordinary `bb` on this host resolves to
`/home/ubuntu/bb/fork/build/bb/packages/bb-app/host-daemon/dist/bb`, version 0.44.0.
The community [wrapper](/home/ubuntu/bb/community-plugins/tools/bb-target-cli.mjs:4)
selects `node_modules/bb-app-target/dist/bb.js` and deletes `BB_CLI`.
The public npm `dist/bb.js` launcher otherwise honors `BB_CLI` and launches
`host-daemon/dist/bb`; the actual public 0.44.0 plugin implementation is
`host-daemon/dist/bb-chunks/plugin-R4ESEAVQ.js`. These files and their SHA-256s are
recorded in [pinned-contract.json](pinned-contract.json). Registry CLI tests
explicitly unset `BB_CLI`, use their own `BB_DATA_DIR`, and never call a host start,
plugin install, reload or canonical output build.

A bare extracted bb-app tarball is not an npm installation. Public 0.44.0 needs
its declared `npm@11.16.0` dependency to fetch the pinned toolchain. The fixture
provides that dependency in isolated scratch storage, rather than installing the
whole application or touching the shared collection. Toolchain versions for both
public builders are esbuild 0.28.1 and Tailwind/node/oxide 4.3.0.

| Builder and host contract | Fixture result | Frontend format | Lazy transfer |
| --- | --- | --- | --- |
| public bb-app 0.42.0 | exit 1, two missing exports | no successful app | unavailable for required donor imports |
| public bb-app 0.44.0 | exit 0, full vendored closure | format 1: `dist/app.js`, `app.css`, `app.meta.json` | lazy marker is inside initial app.js; dynamic import becomes a Promise/init thunk |
| existing canonical Phosphor 0.44.0 CLI | exit 0 after omit-dev | format 2: `dist/app.meta.json` + `.bb-artifacts/<generation>/app.js`, CSS and chunks | emitted static closure excludes lazy payload; network requests unobserved |

The public build also emits `server.js`, `server.js.map`, `server.meta.json` and
an ESM package marker. App metadata stamps the **builder's** SDK 0.5.29,
BB 0.44.0, plugin/version/SDK-major and artifact format 1. The fork stamps format
2 and an explicit generation/files/size/hash/content-type manifest.

[check-output.mjs](check-output.mjs) verifies every fork file hash and import
reference, recursively follows static imports, and requires the payload marker
only in a dynamically imported file. [output-contract.json](output-contract.json)
records the results: public app.js 8,221 bytes; fork entry 5,194 bytes plus a
1,197-byte shared static chunk; deferred lazy chunk 1,681 bytes. CSS is still eager
(15,787 bytes in the fork fixture). These are fixture artifact sizes, not guide
performance measurements. `output-fork/` preserves the raw output after building
into a previously flat scratch dist; its root-level old app.js/app.css are stale
and are **not** the metadata-selected format-2 generation. The verifier reads
only the selected generation. Fresh recheck output starts with an empty dist.

Primary build sources:
[public 0.44 app builder, outfile/no splitting](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-build/src/build-plugin-app.ts#L430),
[public runtime shims](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-build/src/runtime-shims.mjs),
[public toolchain pins](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-build/src/toolchain.ts#L23),
[public asset routes](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/apps/server/src/routes/plugins.ts#L528).
Exact public source excerpts are retained under `published-excerpts/`; 0.42.0
excerpts were extracted from that npm tarball's server sourcemap, and 0.44.0 files
were fetched from its immutable upstream gitHead.

Current fork capability is source-supported at
[app builder](/home/ubuntu/bb/fork/build/bb/packages/plugin-build/src/build-plugin-app.ts:491),
[generation route](/home/ubuntu/bb/fork/build/bb/apps/server/src/routes/plugins.ts:522),
[artifact metadata](/home/ubuntu/bb/fork/build/bb/packages/plugin-build/src/plugin-artifact-meta.ts:21),
and [patch 0028](/home/ubuntu/bb/fork/patches/0028-feat-plugins-serve-versioned-lazy-frontend-artifacts.patch).
Materialized commit `6a0f73a8fec9e6d578d89da2ee1bc9a9a8e697eb`, result tree
`006c86feb52ca604f23b4d422562d635500306ad`, fork commit
`4d9b909690dcc3ae7df03d8432b08b7142f0a8f5` and upstream commit
`9c9bae7f36a237c7e1b96de3d4c2186d13967686` define the inspected source floor.
The CLI/build/route/patch hashes are in the pinned contract.

## Complete control and install closure

Vendor the five version-matched registry items retained in
`published-excerpts/0.44.0/packages/plugin-registry/r/`:

| Source used by donor | Independent target | Transitive closure |
| --- | --- | --- |
| `@/components/ui/icon` | registry `components/ui/icon.tsx` | SDK `experimental_Icon`; IconName becomes public string |
| `@/components/ui/switch` | registry `components/ui/switch.tsx` | host React, `lib/utils.ts`, `components/ui/motion.ts` |
| `@/components/ui/plugin-icon` | registry `components/ui/plugin-icon.tsx` | host React, icon, utils; includes PluginBrandIcon and mask |
| `@/lib/utils` | registry `lib/utils.ts` | clsx, tailwind-merge |
| shared motion | registry `components/ui/motion.ts` | no npm imports |
| donor `HugeiconsIcon` and per-icon modules | ordinary packages | @hugeicons/react + @hugeicons/core-free-icons; React peer |

The immutable registry item paths are
[icon](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-registry/r/icon.json),
[switch](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-registry/r/switch.json),
[plugin-icon](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-registry/r/plugin-icon.json),
[utils](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-registry/r/utils.json),
and [motion](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-registry/r/motion.json).
The fixture imports and builds all five. Do not copy the host's private giant
icon map or install the unpublished `@bb/shared-ui` workspace dependency.

Scaffold dependencies tested: `@hugeicons/core-free-icons: 4.3.4`,
`@hugeicons/react: 1.1.6`, `clsx: 2.1.1`, `tailwind-merge: 3.5.0`.
Keeping all four ordinary registry imports in dependencies satisfies the child
repository's build-required dependency rule. clsx/tailwind-merge are replaced
by host shims at build time, so their executed versions come from the host;
keep within its supported majors 2/3. React/react-dom/JSX runtime are also shims,
never a second bundled React. Hugeicons' actual artwork/component code bundles
from these installed packages. No Radix, framer-motion, motion npm package,
class-variance-authority or @bb/shared-ui dependency is required by this closure.
The registry `motion` item is a local constants file.

Tested devDependencies are in fixture/package.json and its exact lock. They
include SDK 0.5.29, React/types 19, TypeScript 5.9.3 and @testing-library/react
16.3.2. For donor test adaptation, retain meaningful Vitest tests/config and add
an appropriate exact Vitest development pin (donor uses 4.1.1); the complete donor
suite has **not** been adapted or run. The steward owns the shared installation.

`npm ci --omit=dev` followed by public 0.44 and fork builds all exit 0. SDK is
absent from disk after omit-dev; server's SDK import is type-only and the app
import is a host shim. Hugeicons' React peer causes npm to retain React 19.2.1 on
disk, which does not mean React is bundled. [omit-dev-tree.json](omit-dev-tree.json)
retains the actual installed production closure. The current Git installer uses
`npm install --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund`
([source](/home/ubuntu/bb/fork/build/bb/apps/server/src/services/plugins/git-plugin-dependencies.ts:8));
those exact flags followed by a public build also exit 0. Therefore an independent
Git install must not rely on a prepare/postinstall script or dev-only artwork.
BB performs its own build; do not make runtime builds depend on the collection's
relative `../../tools` script being present in an extracted Git package.

## Source-only extraction and native boundary

[donor-inputs.json](donor-inputs.json) lists all **35 tracked donor files** with
hashes, plus 34 ignored/generated paths excluded from source-only copying.
Copy tracked maps/cards/wireframes/icons/agent-reference source, useful scaffold
scripts and meaningful tests without dropping teaching surfaces. Adapt package,
TS/test configuration and private import assumptions. Exclude `.turbo`,
`.bundled-runtime`, dist output, caches and node_modules. Discovery's recursive
hash list included runtime/log files; it is not the extraction file allowlist.

`bb plugin source plugin-api-docs --json` confirms `builtin:plugin-api-docs`
([native-source.json](native-source.json)). Native overlay source wraps content
in [PluginSlotMount](/home/ubuntu/bb/fork/build/bb/apps/app/src/components/plugin/PluginAppOverlays.tsx:15),
which provides plugin ownership/context within the existing host React tree.
The donor uses `useSdk` and route navigation in app.tsx; detached roots cannot
be assumed equivalent. The separately owned overlay-adapter action proves the
portal lifecycle and local-selection boundary. This worker has not live-tested
router/query hooks, dialog focus, cancellation, original-plugin coexistence or
mention resource resolution.

Retain complete upstream Michael Yong MIT from `notices/BB-upstream-MIT.txt` and
full control attribution/provenance. MIT package notices for Hugeicons, clsx,
tailwind-merge and the React peer are retained in `notices/`. Do not replace them
with just a license name. Local adaptations must record their own source map
without changing the original teaching surface IDs.

## Smallest plugin-local upstream lazy fallback (proposal)

Public 0.44's core asset route serves app.js/app.css, not arbitrary chunks.
Its public `bb.http.route` API can serve plugin-owned JavaScript/CSS at exact
`/api/v1/plugins/<id>/http/<path>` routes. Source:
[public backend contract](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/packages/plugin-sdk/src/backend-contract.ts),
[current contract](/home/ubuntu/bb/fork/build/bb/packages/plugin-sdk/src/backend-contract.ts:839),
and an existing asset-serving example in
[UI Reference](/home/ubuntu/bb/community-plugins/plugins/bb-ui-reference/server.ts:22).

A plugin-local build script can build a small registered controller and one or
more deferred content entries **using the public BB builder's runtime shims**,
retain the deferred ESM under plugin-owned assets, and serve a finite
hash/version-addressed allowlist through these public routes. A variable dynamic
import of the route URL can load a content module exporting the guide component;
render it inside the native overlay/portal. Keep required CSS in main app.css or
load its independently served version explicitly. This avoids implementing new
host machinery or copying private runtime shims. Since Git installs skip scripts,
shipping prebuilt deferred assets or an explicitly supported build step is also
required; relying only on prepare is insufficient.

This is a feasible source-supported direction, **not a fixture-tested delivery
fallback**. Exact multi-entry build packaging, relative/static imports, shared
React identity, local-route authentication, server-origin resolution, MIME/CSP,
reload generations, retry/disposal and actual browser requests must be proven
before claiming it works on an upstream deployment. It is more work than using
the existing patch-0028 capability floor on this machine.

## Reproduction, retained artifacts and remaining gates

Run without any shared installation:

```sh
BB_GUIDE_FORK_CLI=/home/ubuntu/bb/fork/build/bb/packages/bb-app/host-daemon/dist/bb \
  bash plans/bb-plugin-guide-for-nerds/evidence/compatibility/run-probe.sh \
  "$BB_THREAD_STORAGE/compatibility-recheck"
```

Use a new owned output directory. Omit `BB_GUIDE_FORK_CLI` for public-only tests.
The script downloads integrity-checked packages, installs the locked scratch
fixture, runs harness/typecheck, expects public 0.42's exit 1, builds public
0.44, repeats after omit-dev and Git-install flags, optionally builds the explicit
fork fixture and verifies metadata/import closure. It retains logs/source/output
receipts and retires its exact scratch installation, toolchain and npm cache on
success, failure or cancellation. An independent re-run by this worker exited 0;
see [recheck.log](recheck.log). Initial scratch was separately retired after the
receipt was captured. No large installed tree is retained in this evidence.

[FILES.json](FILES.json) lists exact retained files, bytes and SHA-256s;
[pinned-contract.json](pinned-contract.json) is the concise machine-readable
contract/provenance and command exit summary. The retained public/fork outputs
are **never-installed proof artifacts**, not committed plugin dist releases.
No shared npm install/ci, plugin source edit, manifest/lock edit outside the
fixture, ledger/plan change, commit, push, live plugin build/reload, host upgrade
or fork change occurred.

Remaining gates: steward's explicit public-baseline versus existing fork-lazy
build selection; adapter and scaffold acceptance; full donor adaptation/tests;
canonical plugin cold requests and generation serving; native browser lifecycle,
authentication and coexistence. No unavailable live evidence has been labeled
fixture proof. None of these authorizes this worker to start the reserved
copy-and-rename node.
