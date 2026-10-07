# Verified two-perspective plan review

Perspectives run `thr_wci32jcr5t` was byte-verified on 2026-10-06. Both requested
lenses completed. Overall status is **partial** because no reviewer verified
the actual selected build/host combination, published-version pairing, emitted
assets or browser behavior. Full-file SHA-256:
`45fb67ee395158b16a2b7d89d94cf366b37f22bf1c939cadeb91e79352746f68`.
The full advisory artifact remains at `perspectives/results/thr_wci32jcr5t.md`;
this document records its dispositions, not runtime certification.

## Accepted corrections

1. **Compatibility before extraction.** Add an independently judged
   `extraction-compatibility` prerequisite identifying public SDK, actual build
   CLI, host contract, registry source, omitted-dev install closure and emitted
   format. Keep latest-stable catalog research separate. The community
   [CLI wrapper](/home/ubuntu/bb/community-plugins/tools/bb-target-cli.mjs:4) selects 0.42.0;
   [fork lazy artifact support](/home/ubuntu/bb/fork/patches/0028-feat-plugins-serve-versioned-lazy-frontend-artifacts.patch:1150)
   does not prove upstream builder/host compatibility.
2. **Native mounting context.** Add `overlay-adapter-proof`, then prefer the
   existing `experimental_appOverlay` and portal. The
   [native overlay contract](/home/ubuntu/bb/fork/build/bb/packages/plugin-sdk/src/app-contract.ts:715)
   preserves plugin/router/query contexts. The
   [donor hooks](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/app.tsx:53)
   cannot simply run under a detached content-script React root. Keep the footer
   interaction from UI Reference without copying its mounting limitation.
3. **First-slice lazy proof.** Add steward-owned `first-slice-integration`, with
   entry/static closure and cold chunk/retry/reload proof before live acceptance.
   Dynamic import syntax alone is insufficient. Respect the
   [existing fallback policy](/home/ubuntu/bb/community-plugins/plans/bb-plugin-guide-for-nerds/DESIGN.md:122) without any fork patch.
4. **Local navigation and mention ownership.** Preserve underlying route/draft
   when changing guide pages; update clipboard plugin identity and test coexistence.
   See [donor routing](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/app.tsx:95)
   and [clipboard resource identity](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/agent-reference.ts:46).
   Steward owns updated registration/layout tests, top-level entry, CSS and pins.
5. **Nested controls and cleanup.** Explicitly prove that the outer dialog
   does not disable page arrows or card dismissal; handle inner menu/card/frame
   Escape and delayed clipboard/import completion, superseded opens, focus and
   drag cancellation. See
   [donor dialog checks](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/product-map.tsx:728),
   [card Escape/timers](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/surface-card.tsx:57),
   and [reference feedback timer](/home/ubuntu/bb/community-plugins/plugins/bb-ui-reference/app.tsx:273).
6. **Source and dependency closure.** Copy tracked source-only donor files;
   retain transitive vendored controls, adaptation receipts and complete notices.
   Hash discovery is a historical observation, not extracted-package completeness.
   Honor [independent omit-dev installs](/home/ubuntu/bb/community-plugins/AGENTS.md:16) and preserve
   [upstream MIT](/home/ubuntu/bb/fork/build/bb/LICENSE:3) and
   [UI Reference MIT](/home/ubuntu/bb/community-plugins/plugins/bb-ui-reference/LICENSE:3).
7. **First-delivery order and exclusive writers.** Theme/native implementation
   now requires `verified(firstSlice)`; target research can run early. Split
   source-only scaffold from adaptation to enable disjoint extracted-content and
   floating-frame work. One steward owns shared installs, manifests, locks,
   builds, registration and final integration. Repository checks now follow
   performance proof to avoid mutating a candidate during measurements.
8. **Scrolling and proportional work.** Extend instant navigation to the
   [card's delayed smooth scroll](/home/ubuntu/bb/fork/build/bb/plugins/plugin-api-docs/src/surface-card.tsx:98).
   Retain independent later proof of active-page-only mounting, removal of hidden
   probes, disposal and measured closed baseline; removing motion alone proves
   none of those. Freeze numeric regression predicates from stable measurements.

## Disagreement and limits

One lens allowed disjoint catalog development after scaffolding; the other
recommended waiting for first-slice proof. The steward adopts the latter to
honor Cole's requested initial delivery. Catalog target research remains an
independent early lane. The lenses proposed slightly different shared-file
allocations; a single steward integration owner resolves that difference.

Native overlay support is source-supported, not live-certified. Selected
public SDK/build pairing, independent install/build closure, lazy chunk serving,
first-use keyboard/touch/focus behavior, currentness and performance remain
implementation acceptance obligations. No reviewer certified any of them.
No registered browser was found yet; the live gate must stay pending until
admitted canonical browser evidence exists.
