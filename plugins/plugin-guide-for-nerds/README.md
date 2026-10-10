# BB Plugin Guide for Nerds

The complete BB Plugin Guide, adapted as a floating companion opened from a
native footer action. Open **Toggle BB Plugin Guide for Nerds** in the sidebar
footer. Drag the header to move it, use the corner control to resize, or focus
the Move/Resize buttons and use arrow keys (Shift makes smaller steps).
Close with the header button, the footer toggle, or Escape inside the guide.
Your current BB page stays in place; the last guide page is retained on reopen.
When the action is hidden in **More footer actions**, focus transfers after that
menu closes and returns to More when the guide closes. This fallback uses the
existing host trigger ID `sidebar-footer-more`; no host change is required.

The independent public type target is SDK **0.5.29**, paired with public
`bb-app@0.44.0`. `npm run build` selects that exact public CLI and clears ambient
`BB_CLI`; it emits a single frontend bundle. The published compiler artifacts
run from a temporary tool directory that resolves this plugin's exact SDK;
this prevents a hoisted compiler from using another workspace's older SDK.
Source and output stay in place, and the temporary tools are retired afterward.
BB Git installs build through their
host compiler after `npm install --omit=dev`, without requiring this development
CLI or prepare scripts. Required artwork/utility packages are production dependencies.

`npm run build:lazy` requires an explicit absolute `BB_GUIDE_FORK_CLI` and the
exact `BB_GUIDE_EXPECTED_BUILD_BB` / `BB_GUIDE_EXPECTED_BUILD_SDK` compiler pair.
It succeeds only after manifest hashes, lazy import closure and retry-factory
validation pass. Deferred
network delivery requires a proven builder **and** generation-serving host, such
as the existing Phosphor patch-0028 composition. A version range alone does not
express that capability. No upstream split-chunk support is claimed. On this
workspace use `/home/ubuntu/bb/fork/build/bb/packages/bb-app/host-daemon/dist/bb`.
The latest catalog research target is separately BB 0.45.0/SDK 0.6.15; this does
not repin the initial implementation or upgrade the host.

Tests and typechecks use public SDK packages, local vendored registry source,
and local paths. See THIRD_PARTY_NOTICES.md for complete provenance and notices.

The initial slice preserves all seven desktop guide pages and their cards,
plugin examples and rich Copy for agent references. Theme/Native UI catalogs and
the measured performance pass are planned increments. Surface markers now
use distinct theme colors matched to a numbered reference list. Full names,
locations and API anchors are shown in the right column; hovering or focusing a
marker highlights its row, and vice versa. Selecting either opens details and
an AI-ready reference note in that column; Close restores the screen summary
and list. At narrow widths the reference stacks below the map. The large visible
window title is removed; Move and Close share the top navigation line while
the accessible dialog name remains.
Page changes, card layout and scrolling are instant.
Only the active map mounts its fixtures.

The selected lazy build keeps the frame in the initial JavaScript closure and
loads guide content on first open. CSS is currently eager. Failed content-entry
requests retry with a fresh query on the same plugin generation; the build check
rejects an unsupported compiled factory or deferred static dependency graph.
This recovery relies on the exact verified format-2 builder shape and is scoped
to the guide entry, not arbitrary nested module failures.

When checking artifacts from a newer explicitly selected host compiler, name its
exact pair with `BB_GUIDE_EXPECTED_BUILD_BB` and `BB_GUIDE_EXPECTED_BUILD_SDK`.
For the current local BB 0.45.0 / SDK 0.6.29 builder:

```sh
BB_GUIDE_FORK_CLI=/home/ubuntu/bb/fork/build/bb/packages/bb-app/host-daemon/dist/bb \
BB_GUIDE_EXPECTED_BUILD_BB=0.45.0 BB_GUIDE_EXPECTED_BUILD_SDK=0.6.29 npm run build:lazy
```

The public development build/type target remains BB 0.44.0 / SDK 0.5.29.
