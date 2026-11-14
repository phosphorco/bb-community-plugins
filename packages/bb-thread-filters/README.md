# @phosphorco/bb-thread-filters

A shared, versioned thread attribute contract for independently installed BB plugins. Register with `registerThreadAttributeSupplier` from `/bb`: one dimension definition supplies its filter choices, matching and display values together. Consumers use `createThreadFilterClient`, keyed by the listed supplier plugin ID, to build filters and columns from the same catalog.

Suppliers advertise dimensions, page/search opaque choices, evaluate selected choices, and read column values for at most200 requested threads and16 dimensions per call. Values are data-only labels/opaque IDs with known, partial, unknown or not-applicable evidence. Consumers render ordinary controls and cells, fetching values only for selected columns on their result page. Topic matching, Inbox lifecycle semantics, storage and personal data remain with their owners.

`createThreadAttributeHandlers` and `threadAttributeRpcContract` provide the same combined registration for identity-bound handlers. `/testing` exports `checkThreadAttributeSupplier` and the existing filter conformance helper. `boundAttributeValues` retains a positive prefix with explicit partial/unknown coverage when a display response exceeds the byte budget.

Package0.2.0 retains the three original filtering methods and legacy `registerThreadFilterSupplier`. `describeAttributes` negotiates the additive `valueVersions:[1]` capability; old suppliers remain filterable and cannot be mistaken for suppliers of column values. New registrations require both behaviors. No React dependency or supplier UI is transmitted.

See [CONTRACT.md](CONTRACT.md) for limits, coverage, identity and lifecycle behavior. The first suppliers are Inbox Sidebar Nerd (owner/state) and Topic Maps (topics); Thread Manager is the first host.

## Title tags

The dependency-free `@phosphorco/bb-thread-filters/tags` entry provides
`normalizeTag`, `normalizeTags`, `readTags`, `hasTag`, `addTag`, `removeTag`,
`toggleTag`, `setTags`, and `stripTags`. The title is the source of truth;
no registry, storage, RPC or UI is involved.

```ts
import { toggleTag } from '@phosphorco/bb-thread-filters/tags';
toggleTag('Fix #one #two', 'one'); // 'Fix #two'
toggleTag('Fix #two', 'one');      // 'Fix #two #one'
```

Tags are complete whitespace-delimited `#name` tokens. Names allow Unicode
letters, numbers and combining marks, `_` and `-`, up to 64 UTF-16 units after
NFC and locale-independent lowercase normalization; numeric-only names are
not tags. Unsupported tokens such as `#foo.bar`, `#c++`, `##one`, and `#123`
remain literal text. A leading `#` is optional for helper arguments.

Reads deduplicate in first-occurrence order. Add-existing, remove-absent and
unchanged ordered replacement return the original title exactly. Surviving
source tokens retain spelling and position; new tags append. Removal deletes
all matching occurrences and adjacent separators only. `setTags` retains the
longest prefix of the desired order obtainable from existing tags, removes the
others and appends the rest. It never parses groups, rewrites colons/URLs, or
collapses unrelated whitespace. `stripTags` removes recognized tokens without
normalizing the remaining text.

Suggestions, draft sessions, concurrency checks and saves stay with callers.
This entry does not add a tag attribute supplier or change the wire protocol.
