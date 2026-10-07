# Third-party source and notices

The 35 tracked source files originate from `get-bb/bb` Plugin Guide
(`plugins/plugin-api-docs`) in the materialized source identity retained by
`plans/bb-plugin-guide-for-nerds/evidence/scaffold/source-copy.json`.
Complete upstream MIT terms are in `notices/BB-upstream-MIT.txt`.

Five controls/helpers are vendored from the public BB 0.44.0 registry at immutable
commit `0baa605b32a00619c1d7e3f32be6553ebcf8244a`: icon, switch, plugin-icon,
utils and motion. The compatibility evidence retains each registry entry and
its exact source. Local relative imports replace private monorepo aliases.
Icon forwards to the public experimental SDK component; no private icon map
or private SDK providers are copied. Complete dependency license notices are
retained under notices/. Phosphor's adaptations use the repository MIT license.

No UI Reference source/data is copied in the initial slice. Its complete notice
must accompany any later catalog borrowing.
