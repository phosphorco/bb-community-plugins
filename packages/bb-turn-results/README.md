# BB Turn Results

**Unreleased development source.** Package version `0.1.0`, wire protocol `1`. A local build, source conformance report, npm archive, registry release and running BB adoption are separate evidence levels. This source does not establish a released or installed feature.

Independent BB plugins identify occurrences and return bounded data; a consumer owns captions, layout, history and resources. The package owns codecs, owner-bound transport and test helpers. Suppliers keep receipts, policy and source access. It does not store results or start jobs, send messages, create shares, retry operations or install a runtime.

| Public entry | Use | Additional peers |
| --- | --- | --- |
| `@phosphorco/bb-turn-results` | DTOs, codecs, keys, evidence transitions, byte admission and exact Resolve response builder | None |
| `/events` | Pure native completed-event selection and bounded prefix windows | None |
| `/bb` | Injected public SDK registration, listed discovery, clients and navigation | None; ports are structural |
| `/testing` | Actual participant factories through the public SDK fake host | Supported SDK/testing peers |
| `/testing/react` | Actual app content script and existing CR PresentationHost | SDK/testing/app peers, React/DOM `^19.2.1`, jsdom `^27.0.0` |

Runtime dependencies are exact Zod `4.6.7` and Context Recognition `0.5.0`. After publication, consumers pin the actual reviewed registry version exactly in their authoritative manifest. No `file:`, `link:` or local tarball dependency belongs in an adopter manifest. Organization plugins update their workspace generator input; community plugins maintain their manifests and lock normally.

```ts
import { buildResolveOutput } from '@phosphorco/bb-turn-results';
import { registerTurnResultsParticipant } from '@phosphorco/bb-turn-results/bb';

// bb is the public plugin API. These functions are the supplier's production
// handlers; recognition is pure, resolve verifies its own source evidence.
registerTurnResultsParticipant(bb, {
  pluginId: 'example-images',
  capabilities: {
    revision: 'images/1',
    supplier: {
      kinds: [{ kind: 'example/image-created', namespace: 'example',
        neutralLabel: 'Image', confirmedLabel: 'Image generated',
        specificity: 'typed', memberVersion: 'image/1', equivalenceNamespaces: [] }],
      recognize: true, resolve: true, enumerate: false,
    },
  },
  recognize: recognizeImages,
  resolve: async (input, signal) => buildResolveOutput(input,
    await verifyRequestedImages(input.items, signal)),
});
```

Clients bind to a **listed plugin id**, never an advertised provider namespace. Describe negotiates versions before capabilities. Recognition receives selected native evidence with its digest. Resolve must echo complete normalized v1 identities; the builder generates exactly indexed/digested outcomes and defers entries that need a smaller batch. The caller keeps deferred debt and uses `splitDeferredIndices`; an impossible singleton is explicitly oversized and parked, never automatically repeated.

Content is separate from occurrence framing:

```ts
import { ContentBlockSchema } from '@phosphorco/bb-turn-results';

const threadCard = ContentBlockSchema.parse({
  identity: { provider: 'threads', id: 'thr_example', kind: 'thread' },
  fallback: { kind: 'card', title: 'Investigate preview routing',
    description: 'Establish the correct host and destination.',
    fields: [{ label: 'Status', value: 'Working' }] },
  navigation: { kind: 'thread', threadId: 'thr_example' },
  layout: { preferred: 'compact' },
});
```

A reference needs no fabricated originating tool event or action outcome. Hosted content uses the existing CR registration/runtime and `SourceIdentity`/`PresentationRefV1` props. A turn gallery adds occurrence captions and proof separately. Layout preferences never force expansion or bypass consumer limits. This package adds no React production entry or presentation registry; another consumer can use the compatible CR surface directly. It does not migrate Thread Brief or enumerate a referenced thread's results.

Use `runSupplierConformance` with the **actual production factory**, injected source ports, source-owned scenarios and expected observables. Missing mandatory scenarios/access observations produce a partial report, not a complete pass. `runResultPresentationConformance` mounts the actual app content script and CR host, verifies component-specific content/failure and data navigation, and records missing resource instrumentation honestly. These prove tested source behavior; package fixtures do not prove independent adopters, native windowing, live delivery, publication or released bytes.

See [CONTRACT.md](CONTRACT.md) for ownership, semantics and bounds, and [PACKAGING.md](PACKAGING.md) for entries, peers and release checks. Gallery use of no-RPC registrations and generic failure labels remains conditional on the separately reviewed CR author release; the unpublished workspace kit is not a dependency.
