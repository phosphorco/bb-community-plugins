# Sticky Notes

Sticky Notes adds durable, shared notes directly over a bb thread. Use the
sticky-note button in the native thread composer to create one, then type,
drag, or move it below the viewport to discard it.

Layout is stored relative to the nearest horizontal and vertical edge. That
keeps notes attached to the intended side when a thread pane or window changes
size. Each note receives one of twelve fixed pastel OKLCH hues; the note is a
bounded user-content surface, while its focus and error chrome continue to use
the active bb theme.

Paste an HTTP(S) URL into a note to replace it with a numbered citation marker
such as `(1.)`, with the matching reference below the note body. Removing a
reference removes its marker and renumbers later citations in the same save.
The browser makes a short, credential-free, no-referrer attempt to obtain
an external page title; sites that disallow cross-origin metadata requests
simply show their domain. Links to threads on the current BB host resolve the
real thread title and open through BB's normal thread navigation.

Concurrent edits to different parts of a note are merged, while simultaneous
text edits to the same note use last-completed-write wins. A failed local text
save remains in the editor and is retried by the next save or blur.

The overlay currently uses a bare Composer banner as its per-pane lifecycle
anchor because the bb SDK does not yet expose a dedicated Thread workspace
overlay surface.

## Development

```sh
npm run typecheck
npm run test
npm run build
bb plugin install . --yes
```
