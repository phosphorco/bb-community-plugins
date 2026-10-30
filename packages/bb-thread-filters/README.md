# @phosphorco/bb-thread-filters

A shared, versioned filter contribution contract for independently installed BB plugins. Register with `registerThreadFilterSupplier` from `/bb`. Consume with `createThreadFilterClient`, keyed by the listed supplier plugin ID.

Suppliers advertise dimensions, page/search opaque choices, and evaluate selected choices against at most 200 requested threads. Consumers render ordinary controls and intersect conditions. Topic matching, Inbox lifecycle semantics, storage and personal data remain with their owners.

See [CONTRACT.md](CONTRACT.md) for limits, coverage, identity and lifecycle behavior. The first suppliers are Inbox Sidebar Nerd (owner/state) and Topic Maps (topics); Thread Manager is the first host.
