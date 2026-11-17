# @phosphorco/bb-people-accounts

The authority-free identity-association source candidate is documented in
[V2-CONTRACT.md](V2-CONTRACT.md). It uses explicit `/v2`, `/v2/bb` and
`/v2/testing` entries; the existing v1 API below remains unchanged.

Package 0.1.0 / fixed wire v1 for trusted human attribution.

Root exports schemas, 512-byte key/input bounds, alias normalization, the shared
summarizeAttribution human summary, trailers and reasons. /bb exports the
owner-bound client/registration; /testing drives real SDK handlers.

The summary owns primary/others, case-insensitive human assignees and co-authors.
It has no posting-account or credential/health policy. Consumers combine ordered
results with the same helper and choose actual credentials/default accounts.

There is no describe/negotiation path. Supplier absence fails open; malformed
installed v1 contracts throw clear fixed PeopleAccountsCallError messages.

See CONTRACT.md for ownership, exact RPCs, bounds and proof levels.
