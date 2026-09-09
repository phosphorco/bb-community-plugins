---
name: agentation-mentions
description: Read and act on visual feedback captured by Agentation → Mentions, the Scott Sunarto Agentation derivative that delivers annotations through bb mentions, queueing, structured author snapshots, and sender envelopes. Use when the user refers to its annotation batch, asks to address visual feedback, or requests watch mode.
---

# Agentation → Mentions

Based on Agentation by Scott Sunarto. The human points at part of the bb
interface and writes what should change. Each
annotation carries the bb route, the owning plugin id when the element was drawn
by a plugin, the DOM selector, and — for React trees — the component path. Your
job is to turn that into a code change and close the loop.

Annotations first enter a shared staging area. A prompt action shows the live
staged count and lets the human add that batch as a native mention. The mention
returns current annotation context as plain content; native mention resolution
wraps it once as an explicit `<attached>` block when the prompt is sent. Insertion
and resolution do not consume or assign the
annotations. The capture route is source context, not a delivery target. Each
dispatched annotation keeps its original comment as the sender body; selectors,
route metadata, prior replies, and other derived context belong in `<attached>`.
Replies are separate sender messages and retain their own captured authors.
Unknown or legacy authors stay unknown; legacy `authorIdentityId` values are
preserved as historical data but are not re-resolved as sender text. Never
create a hidden mention or merge different authors into one envelope.

## The loop

1. Read the assigned feedback:
   - If the human's message contains an Agentation annotation batch, treat it
     as the complete assignment. Work only on its listed annotation IDs and do
     not call `agentation_mentions_get_all_pending`.
   - Otherwise, call `agentation_mentions_get_all_pending` before searching the code;
     the annotation already tells you where to look.
2. `agentation_mentions_acknowledge` — for each item you are taking on, so the human sees
   you picked it up.
3. Find the code, make the change.
4. `agentation_mentions_resolve` with a one-line summary of what you changed. The marker
   disappears from every open bb window.

Use `agentation_mentions_dismiss` with a reason when you decide against a change, and
`agentation_mentions_reply` when you need a decision before you can act. Never resolve an
annotation you did not actually fix — dismiss it or ask.

## Locating the code

The `Where` line is the fastest route to the source.

| `Where` says      | The code lives in                         |
| ----------------- | ----------------------------------------- |
| `plugin \`<id>\`` | that plugin's `app.tsx` and `components/` |
| `bb app shell`    | the bb app itself, not this workspace     |

`Selector` is a live DOM path — grep it for class names and element structure.
`React` is the component path; the last segment is usually the component to
open. `Source` is a file path when the toolbar could recover one.

An annotation on the bb app shell is only actionable inside a bb checkout. If the
workspace is not one, say so and reply on the annotation rather than guessing.

## Reading the fields

- `intent` — `fix` is a defect, `change` is a preference, `question` wants an
  answer not a diff, `approve` is praise. Answer a `question` with
  `agentation_mentions_reply`.
- `severity` — `blocking` first, then `important`, then `suggestion`.
- `Layout request` — a `placement` annotation asks for a new component in that
  spot; a `rearrange` annotation asks for a different section order.

## Watch mode

When the human asks for watch mode or hands-free mode:

1. Call `agentation_mentions_watch_annotations`. It blocks until new annotations appear,
   then returns the batch.
2. Acknowledge, fix, and resolve each one.
3. Call it again. Keep looping until the human stops you.

A timeout is not a stop signal — call it again. Report what you changed between
batches so the human can follow along without reading the diff.

## Shell equivalent

Every tool has a CLI form for environments where the shell is easier:

```sh
bb agentation-mentions pending [--plugin <id>] [--json]
bb agentation-mentions staged [--json]
bb agentation-mentions send [--queue] <threadId> [annotationId…]
bb agentation-mentions restage <annotationId>
bb agentation-mentions show <annotationId>
bb agentation-mentions resolve <annotationId> fixed the wrapping
bb agentation-mentions dismiss <annotationId> intentional, matches the design system
bb agentation-mentions reply <annotationId> should this be 24px or 16px?
bb agentation-mentions toolbar off
```

## Boundaries

- Do not clear or delete annotations. Removing feedback is the human's call;
  resolve or dismiss instead.
- Do not change unrelated code because you were in the file. One annotation, one
  focused change.
- Do not disable the toolbar unless asked.
