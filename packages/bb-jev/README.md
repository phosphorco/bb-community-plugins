# @phosphorco/bb-jev

Versioned shared JEV transport without exporting credentials. The connection owner keeps its key and durable operation journal; consumers keep their own policy, budgets and evaluation ledgers.

- Root: strict request/additive result schemas, JSON bounds and fingerprints.
- `/bb`: owner registration and an explicit-owner client with one lookup after unknown submit, no write retry.
- `/testing`: anchored immutable-operation conformance for real adopter handlers.

See [CONTRACT.md](CONTRACT.md) for exact methods, limits, ownership and uncertainty semantics. Version0.1.0-alpha.1 is a prerelease; source checks do not establish registry or live adoption.
