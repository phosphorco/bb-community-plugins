# Agentation → Mentions

**Based on Agentation by Scott Sunarto.** This derivative starts from
[`@smsunarto/bb-plugin-agentation` 0.2.2](https://github.com/smsunarto/bb-plugins/tree/8bc27b91333e2228607b137d09b195d90e6aecfa/plugins/agentation)
at exact revision `8bc27b91333e2228607b137d09b195d90e6aecfa`. Scott's canonical
**Agentation** marketplace listing is the maintained visual-annotation plugin.
This separately named package preserves that behavior and adds a bb-native
delivery workflow; `agentation-mentions` is a namespace distinction, not a
claim that this is an unrelated product.

The original MIT license, the modified `agentation@3.0.2` PolyForm Shield
license, the vendor patch, and complete third-party notices ship with this
plugin.

## What the derivative adds

- A composer action attaches staged annotations as a native bb mention. The
  mention resolves the current annotation bodies as plain provider context; native prompt assembly wraps it once in `<attached>` when the prompt is submitted.
- `bb agentation-mentions send --queue` uses bb's durable queued-message API;
  omitting `--queue` sends immediately.
- At annotation admission, the plugin uses the public bb-identity request
  boundary to capture the request-bound actor's presentation, identity, and
  evidence as an immutable historical snapshot. Delivery preserves the original comment as the producer-authored body, adds a
  minimal per-author sender frame, and keeps derived selector/reply history in an
  agent-only `<attached>` block. Captured-author snapshots remain in the durable
  annotation and dispatch history for provenance. Legacy `authorIdentityId`
  fields are preserved as unresolved historical data; they do not impersonate
  that person or turn a later queued send into a native
  person-authored contribution. When no person can be resolved, the stable
  machine actor is captured and labeled explicitly. This plugin opts into the
  shared binding's `externalMessageRendering: "producer"` mode so the host does
  not add a second envelope.
- Every agent tool and CLI surface uses the distinct `agentation_mentions_*`
  / `bb agentation-mentions` identity, so it can coexist with canonical
  Agentation without tool or command collisions.

Everything else remains recognizably Agentation: a toolbar overlays bb and
plugin surfaces, captures AFS 1.1 annotations with bb route/plugin context,
stores them in the plugin database, exposes a review panel, updates open
windows in real time, and lets agents acknowledge, reply, resolve, or dismiss
feedback.

## Install

```sh
bb plugin install npm:@phosphorco/bb-plugin-agentation-mentions@^0.1.0
```

From this repository:

```sh
npm ci
npm run build --workspace @phosphorco/bb-plugin-agentation-mentions
bb plugin install path:. --plugin agentation-mentions --yes
```

## Use it

1. Open the toolbar at the bottom-right of bb, select an element, and write the
   feedback. The annotation records its DOM selector, available React/source
   path, bb route, and owning plugin.
2. In a thread composer, use the Agentation → Mentions action to insert the
   staged batch, then submit or queue the prompt normally. Deleting the mention
   leaves the annotations staged.
3. An agent reads the supplied batch with the `agentation_mentions_*` tools and
   resolves each item after fixing it. The marker disappears from open windows.

The review panel retains cross-page history and reply threads. Staged feedback
can also be assigned from the CLI:

```text
bb agentation-mentions pending [--plugin <id>] [--json]
bb agentation-mentions staged [--json]
bb agentation-mentions send [--queue] <threadId> [annotationId…]
bb agentation-mentions restage <annotationId>
bb agentation-mentions sessions
bb agentation-mentions show <annotationId>
bb agentation-mentions acknowledge <annotationId>
bb agentation-mentions resolve <annotationId> [summary…]
bb agentation-mentions dismiss <annotationId> <reason…>
bb agentation-mentions reply <annotationId> <message…>
bb agentation-mentions toolbar [on|off]
```

## Data, network, and authority

- Annotation bodies, routing, replies (with their own accepted author
  snapshots), and retention state are stored locally in this plugin's bb database/KV namespace.
- The toolbar and review panel use bb's plugin RPC, realtime, and same-origin
  event stream. The plugin contacts no third-party service of its own. Retrieved annotation context is attached
  explicitly; it is never expanded into hidden mentions or a second sender. The
  former captured-author mention provider was not emitted by this toolbar; old
  encoded author references are not re-resolved as sender text.
- Delivery mutates only the target bb thread: immediate mode sends a prompt;
  queue mode adds a queued prompt. Captured attribution is source-labelled
  provenance, not native accepted authorship. Older rows retain their exact
  legacy identity ID but are shown as unresolved unless an explicit, separately
  verified recovery path is introduced; the plugin never rewrites them to the
  current actor.
- Agent tools can change annotation status and replies. They do not edit source
  code themselves; the calling agent's normal permissions govern any fix.

Resolved annotations are retained for seven days by default. Toolbar visibility
is live state and can be changed with `bb agentation-mentions toolbar on|off`.

## Artwork

The rich in-plugin logo and marketplace icon are Cole-approved AM02-A. The
package preserves the generated 1254px RGB source and the verified RGB24
nearest-neighbor 16/24/32px derivatives byte-for-byte under `assets/`.

## Develop

```sh
bb plugin dev plugins/agentation-mentions
npm run test --workspace @phosphorco/bb-plugin-agentation-mentions
npm run typecheck --workspace @phosphorco/bb-plugin-agentation-mentions
```

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[vendor/README.md](vendor/README.md) for the canonical reduction and React 19
component-detection patch.
