# Presentation registry: hosted supplier React components (package 0.4.0)

Status: **accepted design; implementation in progress**, Owner decisions are recorded in §13. Wire stays v1
(one added optional output field). Package and adopter verification are separate. No fork change.

Cole's ruling: a supplier plugin may hand consumers **any React component** to
render for a resolved identity. First use: Thread Brief renders Plan Graph's real
graph UI (`PlanGraphSurface` + `PlanGraphRenderer`) for a resolved `.plan.pkl`
mention instead of the data-only card. This activates, for this package only, the
"frontend presentation lease" reserved in
[bb-provider-settings CONTRACT §11](../../bb-provider-settings/CONTRACT.md) and
narrows rule 4 of `bb-plugin-contracts` ("components do not cross") to: *components
cross only through this registry, under the rules below*. The skill and its
checklist are updated in the same change.

Not acceptable and not used: DOM scanning, mounting into another plugin's DOM,
fork slots, imports between plugins.

## 1. Facts the design rests on (verified in source)

| Fact | Where | Consequence |
|---|---|---|
| All plugin bundles share one React, ReactDOM and SDK app facade through `globalThis.__bbPluginRuntime` | `packages/plugin-build/src/runtime-shims.mjs` | A component function from Plan Graph's bundle can render inside Thread Brief's tree; hooks and context work. |
| `useRpc`, `useRealtime`, `useSettings`, `useSdk`, `useBbNavigate`, `useComposer`, `experimental_usePluginId`, `experimental_useAppPanel`, `experimental_useFixedTabTarget` call `usePluginId()` → nearest `PluginContext` | `apps/app/src/lib/plugin-sdk-hooks.ts`, `components/plugin/plugin-context.ts`, set per slot in `PluginSlotMount.tsx` | Inside Thread Brief's slot they silently target **thread-brief**. `useBbNavigate().toPluginPanel/openThreadPanel/toCompose` are consumer-bound too. |
| Slot-independent exports: `useBbContext` (route), `useRealtimeConnectionState`, `experimental_useProviders`, `useEnvironmentProviders`, `experimental_useCodeTheme`, `Markdown`, `UrlLink`, `experimental_FileLink`, `experimental_Icon`, `experimental_ProviderIcon`, `ThreadTitle`, `experimental_Diff`, `experimental_SourceCode` | `plugin-sdk-app-impl.tsx` (only `PluginThreadChat` and `PluginNewThreadComposer` read the plugin id among components) | These may be used by hosted components (allowlist, §7). |
| Browser `sdk.plugins.callRpc({pluginId, method, input, outputSchema, signal})` targets any plugin explicitly | `packages/sdk/src/areas/plugins.ts` | The consumer builds the owner-bound client from its own `useSdk()`. |
| No public API subscribes to **another** plugin's realtime channel (`useRealtime` filters on the slot plugin id; `wsManager` is internal) | `plugin-sdk-hooks.ts` | v1 hosted components get no realtime; freshness is revision-driven (§5.4). |
| Plugin stylesheets are active only while the plugin has a mounted slot **or an active content-script generation**; utilities are scoped to `[data-bb-plugin="<id>"]` | `lib/plugin-css.ts`, `plugin-frontend.ts` (`retainCss` when `contentScripts.length > 0`), `plugin-build/src/scope-plugin-utilities.ts`; documented on `PluginContentScriptRegistration.mount` | Registration happens in a **content script** (keeps the owner stylesheet active for exactly the generation that registered) and the host wrapper renders an owner-scoped root (§6.2). |
| Content scripts get `{pluginId, generation, signal}` and a disposer called exactly once on replacement, deactivation or teardown | `plugin-sdk/src/app-contract.ts` | Registration lifecycle = content-script generation. No hand-rolled reload or disable detection is needed. |
| `ResolutionV1Schema` is `z.object` (strips unknown keys) | `src/index.ts` | 0.3.0 consumers silently drop the new field: wire-compatible. |
| Plan Graph resolve reads the saved projection (`plan.json`); `projectCompactPlan` / `presentCompactPlan` produce the renderer's graph; the renderer and surface use no SDK hooks and no portals | `lib/SavedPlanViews.ts`, `lib/CompactPlan.ts`, `components/PlanGraphRenderer.tsx` | Only `ThreadPlanBanner`/`useThreadPlanResource` are slot-bound; the graph itself is hostable. |

## 2. Ownership

| Supplier (Plan Graph) owns | Package owns | Consumer (Thread Brief) owns |
|---|---|---|
| The component, its data schema, its decoding, its RPC reads | Schema-id grammar, `PresentationRefV1` bounds, realm layout, register/lookup/subscribe semantics | Whether, where and how many presentations mount |
| Registering in its content script; what `methods` hosted code may call | `/react` host wrapper: boundary, Suspense, owner root, owner client, navigator | Stamping the resolving plugin id; fallback card; layout modes and size hints |
| Its own freshness inside the component | Conformance kit and bundle scan | Re-resolve triggers, caches, error presentation |

The package is still not a store or cache of supplier data: the realm holds only
registrations.

## 3. Wire change (v1-compatible)

`ResolutionV1` gains an optional output field, allowed only with `state:'ready'`
and `detail:'card'`. Inputs are unchanged (no new wire version, §10 of CONTRACT).

```ts
type PresentationRefV1 = {
  schema: PresentationSchemaId;   // e.g. 'plan-graph/plan@1'
  data: JsonValue;                // canonical JSON ≤ LIMITS.presentationDataBytes, depth ≤ LIMITS.presentationDepth (root depth zero)
};
// PresentationSchemaId: /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,3}\/[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/, ≤ 100
```

- `presentation` is **additive**: the supplier must still return `card` (and
  `label`/`href`/`fileTarget`); the card is the fallback for every failure.
- `data` is a small *reference + summary* (ids, revision, counts), not the heavy
  view model. The component fetches heavy data through its owner client (§5.2),
  so resolve stays inside `LIMITS.responseBytes` (32 identities × 4 KiB would not).
- Data shape is versioned by the schema major (`@1`); a breaking data change is a
  new schema id. Suppliers may register several majors.
- New `LIMITS`: `presentationDataBytes: 4096`, `presentationDepth: 8`,
  `presentationRpcMs: 5000` (per owner call from hosted code). Counted inside the
  existing `responseBytes` check. Consumer mount caps are consumer policy.
- Consumers decoding with 0.3.0 drop the field; 0.4.0 consumers receiving none
  render the card. No describe change: the resolution itself announces it.
- **Authority stamp.** The consumer's server records which plugin resolved the
  identity (its route) next to the presentation. The browser renders a
  registration only if `registration.pluginId === stamped pluginId`. A plugin can
  therefore never hijack another supplier's schema id or identity.

## 4. Registry (`./presentation` entry; no React or SDK runtime import)

### 4.1 Realm layout (frozen per slot)

```ts
const REALM_KEY = Symbol.for('phosphor.bb-context-recognition.presentations');
type Realm = { v1?: RegistryV1 };                    // created with ??= ; never replaced
type RegistryV1 = {
  entries: Map<string, PresentationEntryV1>;         // key = `${pluginId}\u0000${schema}`
  events: EventTarget;                               // dispatches Event('change'); no payload
  revision: number;                                  // +1 per effective change
};
type PresentationEntryV1 = Readonly<{
  pluginId: string; schema: PresentationSchemaId;
  generation: number; token: symbol;                 // compare-and-delete identity
  load: () => Promise<PresentationComponent>;        // the only cross-bundle code besides decode
  decode: (data: unknown) => unknown | null;         // supplier-owned; null → fallback card
  methods: readonly string[];                        // owner RPC allowlist, 1..16
  label?: string;                                    // ≤ 64, a11y/diagnostics
}>;
```

Slots hold only native containers, numbers and entries; no package functions
live in the realm, so behaviour never depends on which bundle created it. Each
package copy implements the v1 operations over this layout. Package versions may
add optional entry fields (readers ignore unknown ones) but never change v1
meaning; a breaking change adds a `v2` slot, and a transitional supplier writes
both.

### 4.2 Operations

- `registerPresentation(ctx, registration)` — called **only from a content
  script `mount(ctx)`**. `pluginId`/`generation` come from `ctx`, never from a
  string the supplier types. Validates schema id, methods and that `load` and
  `decode` are functions (throws `PresentationRegistrationError`, contained by
  the host's content-script failure handling). Rules:
  - existing entry with **higher** generation → no-op, returns inert disposer;
  - otherwise **replace** (reload replaces; same generation re-mount: last wins);
  - returns a disposer doing compare-and-delete on `token`; also wired to
    `ctx.signal` abort. Idempotent.
- `lookupPresentation(pluginId, schema)` → entry or `undefined` (O(1)).
- `subscribePresentations(listener)` → unsubscribe; `getPresentationRevision()`
  for `useSyncExternalStore`.

### 4.3 Lifecycle and order

| Event | Effect |
|---|---|
| Consumer renders before supplier registered | Lookup misses → card; `change` upgrades it in place when Plan Graph mounts. |
| Supplier reload | Host disposes old generation, mounts new; entry replaced or briefly absent; boundary resets on `token` change. |
| Stale disposer (old generation disposes after new registered) | Compare-and-delete fails on token → newer entry kept. Witness test required. |
| Supplier disabled/uninstalled | Host deactivates the generation → disposer → entry removed → card. Consumer's `plugins-changed` handling also re-resolves and drops that plugin's routes, so the stamp disappears server-side. |
| Supplier crashed without disposing | Consumer only renders entries whose plugin id is in its current ready discovery set; others are ignored. |
| Server/frontend skew during reload (resolve returns `@2`, browser has `@1`) | Miss → card until the frontend generation catches up. |
| Mixed package copies (0.4.x vs 0.5.x) | Same `Symbol.for` realm, same `v1` layout; both interoperate. Witness test with two built copies required. |

## 5. Props contract (what hosted components receive)

```ts
type PresentationComponent<D = unknown> = ComponentType<PresentationPropsV1<D>>;

interface PresentationPropsV1<D> {
  identity: SourceIdentity;            // resolved identity (authoritative kind)
  revision?: string;                   // resolution revision; changes → refetch
  data: D;                             // entry.decode(ref.data), non-null
  owner: OwnerPresentationClient;      // bound to entry.pluginId, method allowlist
  navigate: PresentationNavigator;     // consumer-built, plugin-independent
  mode: 'docked' | 'full';             // consumer layout mode
  size: { maxWidth: number; maxHeight: number; preferredHeight: number }; // CSS px hints
  consumer: { pluginId: string; surface: string };   // attribution only
  requestFull?: () => void;            // ask the consumer to open its full view
  refresh?: () => void;                // ask the consumer to re-resolve this identity
}

interface OwnerPresentationClient {
  readonly pluginId: string;
  call(method: string, input: JsonValue, signal?: AbortSignal): Promise<unknown>;
  // sdk.plugins.callRpc({pluginId, method, input, outputSchema: z.unknown(), signal})
  // with presentationRpcMs deadline, responseBytes cap, abort on unmount.
  // Rejects with PresentationCallError {kind: classifyRecognitionError kinds | 'not-allowed'}.
}

interface PresentationNavigator {
  toThread(threadId: string): void;
  openUrl(url: string): void;                       // SafeHref only
  openFile(target: FileTarget): boolean;            // experimental_openFilePreview
}
```

### 5.1 Why props, not hooks

Every slot hook resolves to the consumer. Hosted components must use **only**
props plus the slot-independent allowlist (§1, §7). `useBbNavigate` is
technically callable inside the consumer's slot, but `toPluginPanel`,
`openThreadPanel` and `toCompose` would act for the consumer, so it is excluded and
replaced by `navigate`. Opening the supplier's own panel is not expressible
without a fork (it needs the supplier's plugin id); hosted components offer
`requestFull` or a file/thread link instead.

### 5.2 Owner client

Built in the consumer by `/react` from the consumer's `useSdk()`; target is
explicit, so routing is correct. Identity is attribution only: the supplier sees
the consumer as caller and must serve hosted reads as it would any caller. The
`methods` allowlist is a guard against accidental writes from hosted code, not a
security boundary. Hosted reads are GET-like and side-effect free.

### 5.3 Settings

Not provided. The supplier reads its own settings server-side inside its
presentation RPC.

### 5.4 Realtime and freshness

Not provided (no public cross-plugin subscription exists). Freshness comes from
`revision` (consumer re-resolve triggers patch the resolution), `refresh()`, and
the component's own `visibilitychange`/`focus` refetch. No polling.

## 6. Consumer rendering (`./react` entry; React ^19 optional peer)

### 6.1 `PresentationHost`

```tsx
<PresentationHost
  sdk={useSdk()} consumer={{ pluginId: 'thread-brief', surface: 'thread-brief' }}
  stamp={{ pluginId, schema, data }} identity={…} revision={…}
  readyPlugins={readySet} mode={…} size={…} navigate={navigator}
  fallback={<DataCard … />} onDiagnostic={…} />
```

Steps, all inside the consumer's tree:

1. `useSyncExternalStore` on the registry → entry for `(stamp.pluginId, schema)`;
   miss, plugin not in `readyPlugins`, or `decode` → `null`/throw ⇒ `fallback`.
2. Lazily resolve `entry.load()` once per `token` (memoized `React.lazy`), under
   `<Suspense fallback={fallback}>`: first paint is the data card, as today.
3. Wrap in an **error boundary** keyed by `token + revision + retryKey`; on error render
   `fallback` plus a muted "Plan view failed" note and report once through
   `onDiagnostic`. The consumer advances `retryKey` for a bounded recovery attempt;
   `onReady` confirms a committed supplier subtree after Suspense. Failed lazy
   imports may reload on a new attempt; successful loads remain shared. A hosted crash never reaches the consumer's `PluginSlotBoundary`.
4. Render `<div data-bb-plugin-root="" data-bb-plugin={entry.pluginId} className="contents">`
   around the component so the owner's scoped utilities apply (§6.2).
5. Owner client and navigator are memoized per entry; unmount aborts in-flight
   owner calls.

### 6.2 Styles (documented DOM dependency)

The owner stylesheet is active because the registering content script retains
it for its generation; the owner-scoped root makes
`:where([data-bb-plugin="plan-graph"]) .x` match. This depends on BB's current
CSS scoping convention (`scope-plugin-utilities.ts`) and is listed in the
contract as a documented host dependency with a host witness (§8). Portaled
overlays from hosted code land outside the owner root; hosted components either
avoid portals, portal into a container inside their root, or use unscoped
(prefixed) CSS. Consequence for suppliers: registering keeps their stylesheet
loaded in every window while they are enabled, so presentation CSS must be
prefixed and small.

### 6.3 Performance

- Briefs without presentations do no extra work: Thread Brief imports `./react`
  with `import()` only when the document holds ≥ 1 stamped presentation.
- The registry is a Map lookup; supplier registration is O(1) at content-script
  mount; component code loads on first use via `load()`.
- Mount only when visible and expanded: docked-collapsed briefs mount none;
  an `IntersectionObserver` gates mounting; at most `4` hosted presentations
  mounted per brief (consumer policy), the rest stay cards.
- Hosted components follow `bb-performant-react`: no idle timers, observers
  only while mounted, memoized scene derivation.

## 7. Conformance additions

`./testing` (DOM-free): schema-id grammar and `PresentationRefV1` bounds
fixtures; resolve conformance checks `presentation` only with ready+card, data
size/depth, and that `card` is still present. Registry fixtures: replace,
higher-generation no-op, stale-disposer compare-and-delete, signal abort, two
package copies sharing one realm.

`./testing/react` (jsdom, React and `@get-bb/plugin-sdk/testing/app` peers):

```ts
runPresentationConformance({
  pluginId: 'plan-graph',
  register,                 // the plugin's REAL server registration (fake plugin host)
  mountContentScript,       // the plugin's REAL content-script mount
  cases: [{ identity, detail: 'card', expect: { schema: 'plan-graph/plan@1' } }],
  modes: ['docked', 'full'],
});
```

- Installs a test plugin runtime whose slot hooks (`useRpc`, `useSdk`,
  `useSettings`, `useRealtime`, `useBbNavigate`, `useComposer`,
  `experimental_usePluginId`, panel hooks) **throw** `SlotHookInHostedPresentation`.
- Resolves each case through the real handler, takes `presentation`, mounts the
  real content script into an isolated realm, renders the **real** component
  through the real `PresentationHost`, with a fake owner client routed to the
  plugin's real RPC handlers in `createFakePluginHost`.
- Asserts: renders in both modes without throwing; only allowlisted `methods`
  are called; unmount aborts; `decode(garbage) === null` yields the fallback;
  a thrown component yields the fallback; disposal removes the entry.
- **Bundle scan** `scanPresentationEntry({ entry })`: bundles the presentation
  entry with SDK/React external and fails if any named import from
  `@get-bb/plugin-sdk/app` is outside the allowlist (§1), or if the graph uses
  `document.querySelector*`, `getElementsBy*` or `MutationObserver` (no DOM
  scanning). Allowlist, not denylist, so new slot hooks fail closed.

Kit results are source conformance. Host proof (real BB, two plugins) and a live
witness set are separate (§8).

## 8. Witnesses before shipping (lease conditions)

1. **Positive owner client**: hosted Plan Graph call reaches `plan-graph`'s RPC
   from inside Thread Brief's slot (host log/network shows `/plugins/plan-graph/rpc/…`).
2. **Styles**: hosted graph styled in a window with no Plan Graph slot mounted.
3. **Reload**: Plan Graph reload swaps the component without a Thread Brief
   crash; stale-disposer ordering observed.
4. **Disable**: disabling Plan Graph reverts to the file-link fallback.
5. **Mixed version**: Thread Brief on 0.4.0, a supplier on a later build sharing
   the realm.
6. **Isolation**: a deliberately throwing presentation leaves the brief usable.

## 9. Plan Graph changes

- `server.ts` / `lib/ContextRecognition.ts`: for `detail:'card'` ready
  resolutions, add `presentation: {schema:'plan-graph/plan@1', data}` with
  `data = {id, revision, title, counts:{ready,blocked,done,total}}` (≤ 1 KiB).
  Card unchanged.
- New RPC `planGraphPresentationV1Scene` (strict input `{id, revision?}`) reads
  the same saved projection via `SavedPlanViews` (no export, no catalog scan) and
  returns `{state:'ready', revision, projection}` or `{state:'unavailable',
  reason}`; Plan Graph bounds it (≤ LIMITS.responseBytes, currently 64 KiB, and its node limits).
- New `components/PlanPresentation.tsx` (separate entry, lazily imported):

```tsx
export default function PlanPresentation({ identity, data, revision, owner, mode, size, navigate, requestFull }: PresentationPropsV1<PlanRef>) {
  const scene = useOwnerPlanScene(owner, data.id, revision);      // props-only loader, no useRpc
  if (scene.state !== 'ready') return <PlanGraphNotice … />;
  const graph = presentCompactPlan(scene.projection);
  return (
    <PlanGraphSurface className="plan-graph-hosted" style={{ maxHeight: size.maxHeight }}
      footer={<button onClick={requestFull}>Open</button>}>
      {graph && <PlanGraphRenderer graph={graph} interactive={mode === 'full'}
        sizing={mode === 'full' ? 'natural' : 'container'} />}
    </PlanGraphSurface>
  );
}
```

- `useOwnerPlanScene(owner, id, revision)`: `useSyncExternalStore` over a small
  per-`(id, revision)` cache in Plan Graph's module, refetch on revision change
  and `visibilitychange`; aborts on unmount. `useThreadPlanResource` and
  `ThreadPlanBanner` stay unchanged (they are slot-owned).
- `app.tsx`: `app.contentScripts.register({ id: 'presentations', mount: ctx =>
  registerPresentation(ctx, { schema: 'plan-graph/plan@1', load: () =>
  import('./components/PlanPresentation.tsx').then(m => m.default), decode:
  planRefSchema.safeParse→data|null, methods: ['planGraphPresentationV1Scene'] }) })`.
- Tests: `runPresentationConformance` + `scanPresentationEntry` on
  `components/PlanPresentation.tsx`. Pin `@phosphorco/bb-context-recognition@0.4.0`.

## 10. Thread Brief changes

- Server (`lib/document-enrichment.ts`, `lib/reference-host.ts`): when a routed
  resolution has `presentation`, stamp `{pluginId: route.pluginId, schema,
  data}` onto the projection. Built-ins never stamp.
- `lib/document-wire.ts`: add `presentation` to the projection key allowlist and
  decoder (schema-id grammar, bytes, depth via package schema).
- `BriefDocument.tsx` `reference-card` branch: if the ready projection has a
  stamp, render a lazily imported `HostedReference` that wraps
  `PresentationHost` with the existing card as `fallback`; else today's card.
- `HostedReference` builds `navigate` from Thread Brief's own `useBbNavigate()`
  (`toThread`, `openUrl`, `experimental_openFilePreview` only), passes
  `mode = preferences.view.mode`, `size` from pane geometry (docked ≈ 240 px,
  full = pane), `requestFull` → existing view reducer, `refresh` → existing
  retry, and `readyPlugins` from its discovery rows.
- Mount gating per §6.3; diagnostics into the existing per-supplier status.
- Host proof: zero / one / failing / throwing / disabled supplier presentations.

## 11. API listing (0.4.0 additions)

```ts
// root (zod only)
export const PresentationSchemaIdSchema: z.ZodString;
export const PresentationRefV1Schema: z.ZodType<PresentationRefV1>;
export type PresentationSchemaId = string; export type PresentationRefV1 = { schema: PresentationSchemaId; data: JsonValue };
// ResolutionV1 gains `presentation?: PresentationRefV1`; LIMITS gains presentationDataBytes, presentationDepth, presentationRpcMs

// ./presentation (no runtime imports; React types optional)
export function registerPresentation<D>(ctx: Pick<PluginContentScriptContext,'pluginId'|'generation'|'signal'>,
  r: { schema: PresentationSchemaId; load: () => Promise<PresentationComponent<D>>; decode: (data: unknown) => D | null;
       methods: readonly string[]; label?: string }): () => void;
export function lookupPresentation(pluginId: string, schema: PresentationSchemaId): PresentationEntryV1 | undefined;
export function subscribePresentations(listener: () => void): () => void;
export function getPresentationRevision(): number;
export class PresentationRegistrationError extends Error {}
export type { PresentationComponent, PresentationPropsV1, OwnerPresentationClient, PresentationNavigator, PresentationEntryV1 };

// ./react (react ^19, SDK app types)
export function PresentationHost(props: PresentationHostProps): ReactElement;
export function createOwnerPresentationClient(sdk: Pick<PluginBrowserBbSdk,'plugins'>, entry: PresentationEntryV1): OwnerPresentationClient & { dispose(): void };
export class PresentationCallError extends Error { kind: RecognitionErrorKind | 'not-allowed' }

// ./testing (DOM-free) and ./testing/react (jsdom)
export const presentationFixtures: readonly PresentationFixture[];
export function createIsolatedPresentationRealm(): { restore(): void };
export function runPresentationConformance(opts: PresentationConformanceOptions): Promise<ConformanceReport>;
export function scanPresentationEntry(opts: { entry: string; allow?: never }): Promise<ScanReport>;
export const HOSTED_SDK_APP_ALLOWLIST: readonly string[];
```

Package version 0.4.0; wire version 1; peers: `react` ^19 (optional),
`@get-bb/plugin-sdk` unchanged range (optional).

## 12. Open questions

1. **Styles dependency.** The owner-root attribute relies on BB's CSS scoping
   convention, and registration keeps the supplier stylesheet loaded globally.
   Accept as a documented DOM dependency, or require hosted components to ship
   prefixed unscoped CSS only?
2. **Realtime.** No cross-plugin subscription exists. Is revision + refresh +
   visibility refetch enough for plan graphs, or is live progress a requirement
   (which would need a fork capability and the full justification)?
3. **Owner panel navigation.** Hosted code cannot open Plan Graph's own panel.
   Is `requestFull` (Thread Brief full view) + file link acceptable for v1?
4. **Method allowlist.** Keep the per-registration RPC allowlist (guard, not
   security) or let hosted code call any supplier method?
5. **Mount cap.** 4 hosted presentations per brief, visibility-gated: right
   default for Thread Brief?

## 13. Decisions on the open questions (Outcome Owner)

1. **Styles:** accepted as a documented DOM dependency (`[data-bb-plugin]` scoping, supplier stylesheet kept loaded by its content script). The workspace contract prefers this to a fork patch.
2. **Realtime:** v1 uses revision changes, `refresh()` and refetch when the window becomes visible again. Live plan progress is later work and needs its own design; no fork capability now.
3. **Owner panel navigation:** `requestFull` plus the file link is enough for v1.
4. **Method allowlist:** kept. It guards against accidental writes; it is not a security boundary.
5. **Mount cap:** 4 visibility-gated hosted presentations per brief.
