# BB Thread Context

Optional bounded, versioned thread descriptions between independently installed plugins. Thread Brief can supply authored Goal, Where it stands and Decisions through its owned accepted reader; Topics can use these as labelled working context while keeping exact conversation evidence and truthful fallback.

See [CONTRACT.md](CONTRACT.md) for ownership, wire, bounds, freshness and proof levels. Check registry publication and real-adopter acceptance separately; source conformance alone establishes neither. It has no file reader, React UI, database, model call or automatic polling.

```ts
import {registerThreadContextSupplier} from '@phosphorco/bb-thread-context/bb';
// Supplier owns reading, heading extraction, access and validation.
registerThreadContextSupplier(bb, ({threadId}, {signal}) => ownedReader.read(threadId, signal));
```

Consumers discover through `sdk.plugins.list()` and `threadContextDescribe`, keep one `createThreadContextClient(sdk, pluginId)` per owner, and invoke `read({threadId}, signal)`. Missing suppliers never block categorization. Do not treat these mutable authored fields as exact quotations, human testimony or independent conversational support.
