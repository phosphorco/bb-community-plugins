# @phosphorco/bb-people-accounts

People Accounts v1: roster DTOs, per-name resolution, deterministic
attribution (posting bot, assignees, Co-Authored-By), a fixed RPC protocol, an
owner-bound client and a conformance kit. The `people-accounts` plugin owns
the roster, tokens and matching; consumers own their default account and
wording. Explicit names are trusted attribution; nothing here verifies callers.

```ts
import { coAuthorTrailers } from "@phosphorco/bb-people-accounts";
import { createPeopleAccountsClient, resolveAttributionFailOpen } from "@phosphorco/bb-people-accounts/bb";

const client = createPeopleAccountsClient(bb.sdk);
const { attribution } = await resolveAttributionFailOpen(client, { inputs: ["flo"], participants });
if (attribution.postAs) {
  // Server only: never log or render the token.
  const credential = await client.credential(attribution.postAs);
}
// attribution.assignees, coAuthorTrailers(attribution), attribution.fallbackReason
```

Suppliers: `registerPeopleAccountsSupplier(bb, port)` from `/bb`; prove it
with `runPeopleAccountsConformance` from `/testing`. See [CONTRACT.md](CONTRACT.md).
