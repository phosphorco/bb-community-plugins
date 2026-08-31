# BB UI Reference

BB UI Reference is a movable companion for comparing BB's UI surface map and
semantic palette with the real application. Click the question-mark button in the
**Footer action** surface to open or close it, then drag its title bar anywhere
in the window.

![BB UI Reference overlay showing the plugin surface map and semantic color palette](assets/bb-ui-reference.png)

The frame contains:

- independently framed views of the researched BB plugin UI surface map, fitted
  without clipping, with its classification legend always visible;
- named tabs in the draggable title bar for jumping among its four sections;
- a Native UI catalog that names BB's host-owned SDK experiences and the
  version-matched registry components available to plugin authors;
- a small, two-tone SVG mini-drawing for every Native UI catalog entry;
- a compact, vertically scrollable list of every color in BB's public plugin
  theme bridge, grouped by purpose and explained with short usage guidance;
- visual demonstrations of fill, text, border, and focus-ring roles without
  exposing computed color values;
- click-to-copy semantic token names.

It does not inspect, classify, highlight, or intercept the real BB interface.
The image is bundled from `assets/bb-plugin-ui-surfaces.svg`; its matching trees
in `AGENTS.md` and the pinned SDK declarations remain the text-first contract.

The Native UI catalog separates host-owned experiences (`ThreadChat`, `Markdown`,
and experimental composer, picker, code, diff, and link exports) from the BB
component registry. Registry entries are added with `npx shadcn add @bb/<name>`
and copied into the plugin's `components/ui/` directory, where the plugin owns
the source. Each entry's mini-drawing is decorative and uses the active BB
semantic palette.

## Develop

```sh
bb plugin install ./plugins/bb-ui-reference --yes
bb plugin dev ./plugins/bb-ui-reference
```

## Verify

```sh
npm run typecheck --workspace @phosphorco/bb-plugin-bb-ui-reference
npm run test --workspace @phosphorco/bb-plugin-bb-ui-reference
npm run build --workspace @phosphorco/bb-plugin-bb-ui-reference
```
