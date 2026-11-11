# BB message admission

`@phosphorco/bb-message-admission@0.1.0-alpha.1` defines the optional native
`experimental_messageAdmission` capability. It supplies authoritative data
contracts, an injected binding and a controlled-port conformance driver. Native
BB owns acceptance, storage, transactions, queue selection and recovery; Message
Rules owns authored policy and evaluation. This package implements neither.

```ts
import { bindMessageAdmission } from '@phosphorco/bb-message-admission/bb';

const binding = await bindMessageAdmission(bb);
if (binding.status === 'available') {
  const active = await binding.client.readActivePublication({
    version: 1,
    providerId: 'message-rules',
  });
}
```

An absent/incompatible host returns `unsupported`; a failing describe call
returns `unavailable`. Keep preview/content tests usable in those states, and
report native placement assertions as unsupported. Availability validates
advertised method shapes; behavioral conformance remains a separate proof.

| Entry | Contents |
| --- | --- |
| `/protocol` | SDK-free types, strict input/additive output codecs, limits, canonical fingerprints and complete-verdict reduction |
| `/bb` | Binding from an unknown public BB object, version negotiation, bounded calls and callback validation |
| `/testing` | Drivers over caller-owned real registered capability/submission ports; no native implementation or fake DB |

See [CONTRACT.md](CONTRACT.md) for method names, data boundaries, scope,
scheduling, evidence, recovery and proof obligations. Consumers pin the exact
registry version after the steward releases it. A local packed-consumer test is
packaging evidence and does not establish registry publication or native behavior.

Development uses the repository's exact Bun 1.3.14 and TypeScript 5.9.3 tools:

```sh
npm run typecheck
npm test
npm run build
npm run test:packed-consumer
```

The packed probe installs a local tarball in disposable scratch alongside the
actual npm registry SDK 0.6.52, compiles public SDK inputs and imports all three
emitted entries. It tests absent/incompatible/capable scripted binding fixtures.
It does not replace native adopter conformance or the SDK emitted-declaration
externalization check. No SDK or React runtime is imported by this package.
