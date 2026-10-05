# BB provider settings

The root entry provides portable role choices, consumer-specific validation,
resolution and explicit execution projections. It depends on zod alone.
`/bb` binds injected public SDK clients to a named owner and registers owner
roles. `/react` provides optional shared controls using BB's native picker.
Owners retain storage, permissions, routing and invocation capture.

Read [CONTRACT.md](CONTRACT.md) for the exact v1 protocol and policies.

Read never loads catalogs or writes. Editing stages native picker callbacks as
browsing only; apply preview values to overrides deliberately, then Save. Inherit and entry
removal remain available without a catalog. Unknown saves are re-read once and
compared by content; no automatic retry. Fingerprints use raw owner API values;
check/write remains non-atomic.

The directory groups roles into compact, searchable rows. Opening a role reads
its saved choice; Edit opens the native picker, and **Use this selection** stages
a tuple before the separate Save action. Previously opened editors stay mounted
when collapsed, preserving drafts. Refresh keeps existing rows visible and
revalidates open editors; collapsed editors revalidate when reopened after a
refresh. A changed saved value is adopted only for a clean editor, or shown as a
conflict alongside an unsaved draft. Catalog browsing is cached within the page
and cleared on refresh. The `/react` entry carries theme-token styles; root and
`/bb` entries remain free of DOM and styling side effects.

Each editor explains its inheritance and validation rules under **How this
works**, using the role's generic descriptor and owner-supplied notes. Fixed
provider roles show which model and reasoning overrides are offered, including
reasoning that requires a model override. **No overrides** means inherited
execution remains available; **Not verified yet** describes an override that is
turned off. Editing follows three steps: preview, stage the chosen overrides,
then review the draft and Save. Preview labels follow the picker immediately.

`bun run test` freshly emits JS and declarations, then runs public-entry,
controlled React, owner protocol, conformance-kit self-tests and SDK type
witnesses. These tests are source evidence, not native host proof. Each plugin
that adopts a role proves its own integration in its own tests with the kit
below; the package names and imports no consumer.

React and the SDK are optional peers. The selected development SDK archive and
ordinary registry release are distinct inputs; no minimum host version or loaded
server byte identity is promised. Consumer adoption, ordinary npm installation,
final native controls and role execution require independent later review.

Memoize owner clients by the actual injected SDK and target id, for example
`useMemo(() => createOwnerClient(sdk, pluginId), [sdk, pluginId])`. Recreating a
client signals a new owner lifetime; equivalent role/catalog wrappers do not.

## Conformance kit: `/testing` and `/testing/react`

A plugin that adopts a role proves its integration from its own tests with the
kit. The kit is **source conformance, not native-execution proof**: it drives
the plugin's real owner, registered by its own factory with
`registerProviderSettingsOwner`, through the SDK fake plugin host
(`createFakePluginHost` from `@get-bb/plugin-sdk/testing`). It never
reimplements Read, Validate or Save, names no consumer and carries no evidence.
Passing scenarios say nothing about a running BB host, its picker or a provider.

`/testing` is DOM-free and needs only the package and the SDK:

- fixtures: `policies` (`strictModel`, `callerTolerant`, `listedTier`),
  `providerFixture`, `catalogRowFixture`, `catalogFixture`, `capabilityFixture`,
  `roleDescriptorFixture`, `selectionFixture`;
- fakes: `createFakeCatalog()` stands in for `sdk.providers` (hold, fail, log);
  `createOwnerProbe(hosts, { catalog })` routes `sdk.plugins.callRpc` to each
  owner's fake host, logs calls, holds or loses responses, and `settled()`
  awaits the actual pending promises;
- scenarios: `ownerScenarios(subject)`, `crossOwnerScenario(subjects)` (two or
  more independent owners), `invocationScenarios(subject)`, registered with
  `defineScenarios(test, scenarios)` under `node:test` or `bun:test`;
- invocation assertions: `expectNativeInherit(requests, baseline)`,
  `expectNoExecutionFields(request)`, `withOverride(request, fields)`.

Inherit is compared with the plugin's own native baseline, not with "no
fields": the subject supplies the requests it sends with no override, including
a caller's tuple, feature-owned permission provenance or a captured
`executionInputSources` map, and inherit must reproduce them exactly. Use
`expectNoExecutionFields` only where the baseline really omits them.

```ts
import test from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createFakeCatalog, defineScenarios, ownerScenarios } from '@phosphorco/bb-provider-settings/testing';
import { createPlugin } from '../server.ts';          // your factory; its owner port reads catalogs via catalog.sdk

const catalog = createFakeCatalog();
const store = new Map<string, string>();              // the storage your factory persists to
const host = createFakePluginHost({ pluginId: 'my-plugin' });
await createPlugin({ catalogSdk: catalog.sdk, store })(host.bb);
defineScenarios(test, ownerScenarios({
  host, roleId: 'reviewer', catalog,
  acceptedChoice: { kind: 'tuple', selection: { providerId: 'p', model: 'exec-model', reasoningLevel: 'low' } },
  readRaw: () => Object.fromEntries(store), roleKeys: ['reviewer'],
  writeExternally: async () => { store.set('reviewer', JSON.stringify({ kind: 'inherit' }) + ' '); },
}));
```

`/testing/react` adds `mountEditor(element, { probe })` and
`editorScenarios(subject)` / `crossOwnerEditorScenario(subjects)` for controls
built on `RoleSettingsEditor`. `mountEditor` resolves only after the initial
owner Read's actual promise has settled, React work has flushed inside `act`, and
the editor shows a ready or explicit error state; there are no fixed delays.
It needs the optional peers `react`, `react-dom` and `jsdom`. `/testing` and the
core entries never import them.

Each scenario that lacks a subject hook is returned with a `skip` reason. A skip
is a visible gap; it never counts as a pass. When a scenario cannot apply to a
role (for example there are no protected fields, or a reasoning-only role has
nothing to validate against a catalog), declare it in `notApplicable` with a
reason instead. That omits it rather than skipping it, so a conforming plugin's
run has no gaps. An id cannot be both skipped and not applicable.

## Retained compatibility overlaps

These small overlaps remain intentionally alongside the shared kernel. Their
retirement requires the stated replacement and compatibility witnesses; the
conditions below do not claim those witnesses already exist or authorize removal.
Owner storage, instructions, permissions, destination routing and lifecycle stay
with each feature.

- Rosetta's provider-first destination availability guard preserves feature
  routing constraints and the original failure before model lookup. Retire the
  overlapping generic availability check only when shared ordered validation
  preserves the same errors and zero-model-call behavior; host/workspace routing
  remains feature-owned. RTD's existing early availability/permission/workspace/
  tier guard has the same ordered-validation limitation: simultaneous unsupported
  or unlisted tier plus missing model must keep the original precedence and avoid
  calling models. Its replacement requires an ordered/capability validation API
  and those negative witnesses, not deletion of owner permission/workspace policy.
- Rosetta's local combined profile/instructions Save classifies native write
  outcomes for its custom operation. The shared error taxonomy does not provide
  an equivalent definite-write-outcome decision. Retire this classifier only
  when a shared facility supports that operation and preserves the distinction
  between definite rejection and uncertain response loss, including output-schema
  errors, generic 500/503 responses and owner-specific disabled responses. Local
  owned-field content reconciliation remains separate from central choice-only
  reconciliation; neither comparison is atomic CAS.
- Perspectives repeats model/default/reasoning matching only to restore its
  original rejected-reasoning diagnostic; the effective tuple comes from the
  shared resolver. Retire the diagnostic lookup when shared rejected issues carry
  sufficient resolved model/reason context, or an equivalent diagnostic can be
  formed without the duplicate lookup. Preserve the original failure messages
  and invocation trimming while Read/Save retain configured nonblank bytes.
- GitHub's browse-default seed repeats shared default-row/reasoning selection to
  supply a feature-specific browsing label. Retire that seed only after adopting
  the shared browse label/context and proving equivalent mounted behavior for
  inherit and partial choices, default selection and deliberate promotion. A
  browse seed must never become configured intent or authoritative inheritance.
