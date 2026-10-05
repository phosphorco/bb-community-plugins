# Offline provider fixtures

> Policy update — 2026-09-09: the approved [Identities and multiplayer ADR](../../../../docs/adrs/2026-09-identities-and-multiplayer.md)
> governs this trusted shared deployment. Use verified people when available,
> applicable carried attribution next, and a stable machine actor otherwise;
> missing or failed person verification must not block ordinary operations.
> Never relabel fallback as a verified person or redirect pending personal-state
> writes to another owner. Independent access checks and data validation remain.
> Earlier rejection requirements below are superseded; versioned API descriptions
> and test receipts remain historical evidence, not proof of ADR implementation.


These are dependency-free Node modules, not a plugin, package manifest, or
packed-artifact proof. They exercise the public `IdentityProvider` shape in the
declaration design with locally generated RSA fixture keys and injected clocks.

- `resolver-only-provider.mjs` exports `createResolverOnlyProvider`. It has no
  directory or readiness hook; resolved session presentation remains available.
- `signed-assertion-provider.mjs` exports `createFixtureKeyPair`,
  `signFixtureAssertion`, and `createSignedAssertionProvider`. Verification and
  key refresh are provider-local and test supplied; no network or production
  credential is used. These optional examples determine whether a provider can
  supply a person label; rejection falls back to machine attribution in this
  deployment. They do not establish permission to use BB or tamper-proof history.
- `provider-fixtures.test.mjs` checks resolver-only behavior, signed assertion
  validation, issuer isolation, provider-local token expiry, local key refresh,
  and declining person enrichment for malformed/untrusted assertions.
- `consumer-adapters.mjs` exports `writePreferences` and
  `createExternalContributionAdapter`. They exercise the public request/server
  shape without importing live plugins: a viewed subject stays separate from
  the actual actor, and verified external input binds an immutable operation.
- `consumer-adapters.test.mjs` verifies those consumer paths and recovery after
  a lost completion response.

Run with `node --test packages/bb-identity/examples/provider-fixtures.test.mjs`
or `node --test packages/bb-identity/examples/consumer-adapters.test.mjs` from
the `plugins` repository. Future proof tests may import the named exports by
package-relative source path; these examples are not packed-artifact evidence.


## External prompt rendering

The public BB binding owns the generic external sender frame by default:

```js
const identity = bindBbIdentity(bb); // externalMessageRendering: "host"
```

A producer that has already assembled one sender envelope and its derived
`<attached>` context must opt into producer ownership at construction:

```js
const identity = bindBbIdentity(bb, { externalMessageRendering: "producer" });
```

This choice is explicit and typed; the binding never searches prompt text for
markers. Both modes call the same external acceptance path, retain structured
subject/presentation provenance, and preserve the supplied original body.
Producer-owned context must keep captured authors separate for each message or
reply; retrieved annotation history belongs in `<attached>`, not a second
sender frame. The current consumer audit found no other owned producer that
needs this option and intentionally adds no generic GitHub integration. On an
enhanced host, producer mode also requires the optional
`experimental_useProducerMessageRendering(): void` protocol capability so the
plugin-scoped SDK rendering policy does not add another machine wrapper; absent
portable upstream does not need this capability.
