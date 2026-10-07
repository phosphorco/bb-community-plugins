# Catalog target research receipt

Observed **2026-10-06 20:55 UTC**. The newest published stable target was **BB 0.45.0**, npm published 2026-10-02T22:19:04.050Z. GitHub's stable `desktop-v0.45.0` release was published 2026-10-02T22:14:01Z. Both identify **129f621771a3e275773992db648316966ac207cf**. `npm/bb-app-metadata.json` retains all dist-tags and version publication times; `npm/github-release.json` retains the non-prerelease release evidence.

Use **SDK 0.6.15 with bb-app 0.45.0's bundled `bb plugin build` CLI** for the latest catalog target. Source `packages/plugin-sdk/package.json`, published SDK npm `gitHead`, and published BB npm `gitHead` agree at the release revision. Stronger artifact evidence: `published/bb-app-0.45.0/server/dist/builtin-plugins/plugin-api-docs/dist/app.meta.json` and `server.meta.json` explicitly record sdkVersion 0.6.15, builtWith.bbVersion 0.45.0, and builtWith.pluginSdkVersion 0.6.15. Every retained builtin artifact metadata file matches this pair. Downloaded npm tarball bytes were verified against npm SHA-512 integrity (see `release-receipt.json`). SDK 0.6.23 has a different gitHead, 985a267f363f9339472ae3175f49b73efb6f3329: it is independently latest, not this BB release's SDK. SLSA attestation envelopes are retained but their signatures were not independently cryptographically verified.

Primary public inputs:

* [BB stable release](https://github.com/get-bb/bb/releases/tag/desktop-v0.45.0), [versioned BB npm metadata](https://registry.npmjs.org/bb-app/0.45.0), [versioned SDK npm metadata](https://registry.npmjs.org/@get-bb%2fplugin-sdk/0.6.15).
* [Release SDK manifest](https://github.com/get-bb/bb/blob/129f621771a3e275773992db648316966ac207cf/packages/plugin-sdk/package.json), [public app facade](https://github.com/get-bb/bb/blob/129f621771a3e275773992db648316966ac207cf/packages/plugin-sdk/src/app.ts), and retained app-contract.ts plus published app.js/bundled public declarations.
* [Theme bridge](https://github.com/get-bb/bb/blob/129f621771a3e275773992db648316966ac207cf/apps/app/src/components/ui/theme.css), [builder theme extraction](https://github.com/get-bb/bb/blob/129f621771a3e275773992db648316966ac207cf/packages/plugin-build/scripts/generate-plugin-theme.mjs). The builder extracts top-level `@theme` blocks; palette roots and media overrides stay host owned.
* [Complete registry index](https://github.com/get-bb/bb/blob/129f621771a3e275773992db648316966ac207cf/packages/plugin-registry/r/index.json), retained every indexed JSON with embedded source/file hashes, dependencies and target paths. The release's scaffold constructs `@bb` URL using `desktop-v0.45.0`; for exact immutable snippets use `https://raw.githubusercontent.com/get-bb/bb/129f621771a3e275773992db648316966ac207cf/packages/plugin-registry/r/{name}.json` in components.json and `npx shadcn add @bb/<name>`.

Normalized complete inputs:

| Inventory | Count | Classification |
| --- | ---: | --- |
| theme-inventory.json | 77 | 56 semantic color bridge declarations; 21 font/radius/shadow/typography declarations |
| host-inventory.json | 14 | SDK-owned renderable experiences, exact experimental flags |
| registry-inventory.json | 78 | 62 renderable source entries; 16 nonvisual helpers |
| app-value-exports.json | 46 | Host renderables plus hooks/definition functions, never treat hooks as controls |

Renderable host exports: ThreadChat, Markdown, ThreadTitle, UrlLink; experimental_Icon, experimental_ProviderIcon, experimental_FileLink, experimental_NewThreadComposer, experimental_ProviderModelPicker, experimental_PermissionModePicker, experimental_BranchPicker, experimental_SourceCode, experimental_Diff, experimental_SidebarNavigationIcon. Normalization verifies the component-forwarder set against the published SDK app.js and that release host implementation supplies every component.

Nonvisual registry entries: activity-row-styles, chrome-style-tokens, coarse-pointer-sizing, coarse-pointer-visibility, menu-item-hover, motion, overlay-trigger, portal-scope, question-form-host, question-form-state, resource-route-label, use-browser-dimming-modal, use-compact-viewport, use-media-query, use-pointer-coarse, utils. Some contain context providers alongside helpers; none is itself a visible host-owned experience. The registry's `registry:ui` type alone does not prove renderability.

## Donor and teaching differences

The steward's earlier source receipt records deployed BB 0.44.0/materialized SDK 0.5.29. Compare retained **immutable upstream 9c9bae7f36a237c7e1b96de3d4c2186d13967686**, not a runtime filesystem scan, with the release target. Published SDK 0.5.29 metadata identifies SDK publication gitHead 0baa605b32a00619c1d7e3f32be6553ebcf8244a; the donor upstream commit is a separate identity. No fork patch mentions the inventoried theme.css, SDK app facade, host app implementation or registry r paths (read-only rg check). This is source-contract evidence; no live theme availability/rendering was measured.

`comparison.json` shows no added/removed theme bridge declarations or renderable host export names and no registry name additions/removals. **No target color is newer-host-only relative to this deployed upstream source contract**. Host props/behavior may still differ; unchanged names do not certify signature or behavioral compatibility. Nonvisual SDK API `useComposers` appears in target facade and is absent from deployed upstream facade.

Ten registry entries have changed embedded content: chrome-style-tokens, context-menu, dialog, dropdown-menu, popover, question-form, resource-row, responsive-overlay, select, workflow-progress. Their unchanged names must not hide source drift. The release registry is appropriate for documenting the release; using those sources on BB 0.44.0 remains subject to the steward's compatibility proof. Do not globally repin sibling plugins or recommend upgrading the host as part of this action.

Current teaching source `teaching/ui-reference.ts` omits **--version-upgrade** and **--brand-discord** from its 54-color fallback. It teaches 9 host entries but `experimental_UrlLink` is invalid for both SDK 0.4.47 and the release; use `UrlLink` without an experimental marker. It omits ThreadTitle and four experimental host exports: BranchPicker, Icon, ProviderIcon, SidebarNavigationIcon (plus the valid UrlLink replacement). Exact names are in comparison.json. Its 44 registry targets exist, but it omits 34 entries including all 16 explicitly classified helpers. It does not teach the 21 non-color bridge declarations. Dynamic runtime discovery may expose missing colors, but fallback data alone is incomplete. No changes to UI Reference were made.

## Reproduction and limits

From the workspace root:

```sh
python3 community-plugins/plans/bb-plugin-guide-for-nerds/catalog-target/normalize.py
python3 community-plugins/plans/bb-plugin-guide-for-nerds/catalog-target/verify-snapshots.py
```

`SNAPSHOTS.json` maps every retained file to SHA-256 and origin. `SHA256SUMS` verifies every file except the manifests themselves. Archive snapshots contain exact public release/package bytes; extracted source subsets are research, not a checkout, build dependency, or alternate runtime. `acquire.py` documents initial network acquisition; reproduction of comparison/verification is fully offline. Network `latest` observations are dated moving metadata, distinct from immutable version tarballs and source commit. Read `CONTRACTS.md` for later independent worker data exports and failing-mutation acceptance suggestions.

No pairing blocker remains for 0.45.0/0.6.15. Runtime availability, complete typed-prop compatibility on 0.44.0, independent build/install closure, live browser/theme proof, and the first-requirement gate remain outside this bounded research action. Catalog implementation remains unauthorized until the steward follows up after first-requirement proof. Root steward alone judges land/verification. No plugin/manifest/lockfile/plan/ledger/runtime/HEAD changes, installs/builds, commits, brief, or subworkers were performed.
