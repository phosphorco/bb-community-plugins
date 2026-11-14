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

## Native build

The current target is BB 0.49.0 and the matched fork SDK 0.6.143. Run `npm run build` from this plugin. It uses the pinned native CLI and emits native format-1 artifacts. `BB_TOOLCHAIN_CLI` may name the exact reviewed fork CLI for a source build.

The format-2 builder, checker and earlier instructions are tracked under [`__archive/artifact-format-2/`](__archive/artifact-format-2/). They are historical source outside the active build. There is no lazy-generation build mode or mutable compatibility copy.

Git installs use the host compiler after production dependency installation. Required artwork and utility packages remain production dependencies. See `THIRD_PARTY_NOTICES.md` for provenance and notices.

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
Navigation and the map canvas reach the frame edges. The responsive reference
pane owns one text gutter; selected details share it without an inset card.
Numbered markers retain edge clearance, and the end of the reference stays clear
of the resize control.
Only the active map mounts its fixtures.

