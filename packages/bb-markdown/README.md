# @phosphorco/bb-markdown

Read-only, source-framed Markdown for first-party BB plugin UI. This library owns
one server grammar, bounded prepared data and one shared React default. It does
not depend on Thread Brief's product runtime, publish messages or create graph
edges. Version 0.1.0 is the first source candidate; registry release and runtime
activation require their own reviewed delivery approval.

## Adopt the default

Declare the exact registry version, register the backend once per plugin factory,
and mount one provider at the narrow surface. Leaves provide their actual text
producer, never the viewing thread:

```ts
import { registerMarkdown } from '@phosphorco/bb-markdown/bb';
export default function plugin(bb) {
  registerMarkdown(bb, { consumer: { pluginId: 'your-plugin' } });
}
```

```tsx
import { Markdown, MarkdownProvider } from '@phosphorco/bb-markdown/react';
<MarkdownProvider>
  <Markdown content={message.text} intent="prose" layout="compact"
    source={{ kind: 'thread-message', instance: 'local',
      threadId: message.threadId, messageId: message.id,
      revision: String(message.sequence) }} />
</MarkdownProvider>
```

`MarkdownSource` is required and validated at runtime. A selected passage uses
its real source thread and a stable producer passage key/revision; it need not
pretend to be a stored message ID. Foreign or unknown text uses
`{kind:'detached', producer, sourceKey, revision, origin:'foreign'|'unknown'}`.
There is no viewer default, dummy thread or ambient repository inference.
Source props are assertions, not permission or a verified file frame. The
backend correlates direct SDK thread/environment metadata and rejects wrong,
deleted or unavailable identity data. Hidden is a sidebar fact: explicitly
referenced, readable hidden threads may receive inline title links. It never
enumerates hidden threads or reads target contents.

The provider's default transport uses the hosting plugin's local versioned RPC
methods. An injected `transport` is available for conformance/embedding; it must
return the same decoded prepared models. Compact/full changes presentation only.
One mounted provider shares visible demand; leaves do not discover suppliers,
start polling loops or build independent registries.

## Rendering and source safety

The root entry contains codecs/data only. `/server` uses unified + remark-parse,
GFM and math, then remark-rehype, rehype-raw and rehype-sanitize to produce the
version-1 bounded tree. `/react` renders that tree with fixed attributes and
explicit SDK UrlLink/FileLink targets. `/bb` is plugin-local registration.
`/testing/source-gate` is Node-only source tooling. The browser runtime imports
neither the grammar, Node tooling nor supplier discovery.

Exact original source is retained separately. Cold/unavailable-base rendering is
immediate readable literal text, never a blank/spinner alone. Valid base
formatting does not wait for suppliers. Missing source metadata still permits a
safe formatted tree: individual local links/images remain inert, while safe
external references may enrich. Unsafe inline/HTML code stays code text without
an href, draggable link, tab stop or context-menu action. It cannot route through
the viewer. Verified source-contained links retain explicit environment/path and
line-range targets. Safe authored external links retain labels and exact URL
query/fragment/route semantics. Code, HTML, authored links and images are excluded
from recognition, with no nested excerpt/card enrichment.

Only generated bounded code/Mermaid/math leaves and verified source-contained
images delegate to native SDK Markdown. Generated fences cannot be closed by
code content; math values containing unsafe dollar delimiters fall back to code.
The image delegate receives the actual validated image target, source thread and
root. There is no invalid document sentinel or event-capture claim of inertness.
Flow containers preserve accessible paragraph/heading/emphasis semantics where
native leaf wrappers would otherwise create invalid nested paragraphs.

Supported structure includes headings, GFM nested lists/quotes/tables/tasks,
inline/code blocks, sanitized HTML and explicit links/images. Current limits:

- Parse at most 262,144 UTF-16 units; larger input remains exact readable text.
- Trees: 8,192 nodes, depth 32, 2 MiB serialized UTF-8.
- Optional recognition: one whole-source window up to 65,536 UTF-16 units; larger
  sources keep formatted base with a partial-coverage diagnostic.
- Requests: 16 per batch, aggregate 1 Mi UTF-16 units. Browser: two batch flights,
  256 retained keys and 4 Mi retained key/content characters. Server: four SDK
  reads, 64 admitted operations, bounded source/metadata/resolution LRUs.

Unique resolver ownership and conservative conflicting-claim handling apply.
Unavailable, contested, malformed or over-budget metadata leaves literal tokens.
Qualified references and whole explicit URLs are eligible; URL interiors and
incidental `#N` repository inference are not. The installed recognition contract
is exactly 0.4.1; this library introduces no supplier protocol change.

Known syntax limits are explicit: selected-file source frames and HTML
video/source media are follow-ons (readable children/fallback retained). Verified
local images inside authored links retain alternative text to avoid nested
interactive controls. Unsupported local filename delimiters `:%?#` remain inert
rather than invoke native path truncation; normal space/bracket image paths are
source-framed. A paragraph containing raw HTML is conservatively excluded from
optional reference recruitment. Unsupported math dollar forms remain code.
Native cold math currently has inherited invalid ancestry before lazy typesetting;
our adapter adds no extra invalid interaction/ancestry. Completed KaTeX,
Mermaid SVG layout and production visual/latency parity are separate evidence.

## Lifecycle and verification

The TanStack Store owner retains pending enrichment during selection/focus and
applies it after range intersection clears, including selections whose endpoints
are outside a leaf. Offscreen completions are retained for visibility/remount.
Document visibility, unmount, StrictMode, source revision and reconnect fence
late results. Shared reconnect/manual retry invalidates the plugin-local read
caches; no per-row retry timers or automatic write replay. Local cancellation
fences results; it does not prove remote work stopped.

`npm run build`, `npm test` and `npm run typecheck` exercise the package.
`npm run test:packed-consumer` installs an actual archive with registry SDK
0.6.52/recognition 0.4.1 peers and checks public types, entries, server behavior
and browser closure. Before activation, `BB_SOURCE_LOADER_ROOT=/path/to/exact/bb
npm run verify:pilots` additionally requires fresh emissions and the native/strict
source oracles. Set `BB_NATIVE_HOST_ROOT` if the exact host is elsewhere. These
explicit oracles require the exact materialized BB source/toolchain and installed
host dependencies; they do not execute plugin factories or emitted server modules.
Hosted CI provisions the selected SDK artifact but currently lacks that full host
and compiler tree, so normal CI does not claim those explicit oracles pass.
A canonical bundle build alone is insufficient. Before any pilot activation,
require fresh emissions, both actual strict source graphs and the negative
escaping-import control, real pilot handler/screen tests and independent review.
Host-oracle/source call ceilings are not production layout or latency measures.

## Controlled-source enforcement

`node tools/check-sources.mjs --root org=/path/to/org --root community=/path/to/community`
checks first-party production UI and active served templates. Ordinary repository
checks invoke the same gate. It rejects raw SDK Markdown imports, aliases,
reexports, namespace/static dynamic/CJS accesses, known local parser/render/HTML
sinks, missing source/intent at known shared callsites, and executable relative
imports into excluded test/fixture/research sources. It follows a bounded relative
module graph; generated output, dependencies, bare/computed module resolution,
arbitrary JavaScript and native BB/timeline/third-party code are outside this
static guarantee.

`tools/markdown-debt.json` records exact reviewed path/rule/subtree hash/count and
intent. Existing prose bypasses are counted migration debt, not permanent optouts.
Shared grammar/native policy modules are additionally exact-hash fenced. New,
changed or expanded bypasses fail; there is no wildcard plugin exemption or
arbitrary `recognize=false`/literal reason. Explicit technical exceptions cover
safe Mermaid delegation, fixed SVG, parser-only extraction and the historical
Codex iframe. First adopters are LatestAgentMessage and BTW source/draft anchors.
Notifications, Future Threads, Topics provenance, Thread Peek's DOM adapter and
Brief's precompiled-model adoption remain inventoried follow-ons.

Install through an exact published registry version. Temporary local linkage is
only development proof, never a committed `file:`, `link:` or tarball dependency
or an alternate plugin source. Packed-consumer tests establish emitted portability;
they do not establish registry publication, live adoption or external delivery.
