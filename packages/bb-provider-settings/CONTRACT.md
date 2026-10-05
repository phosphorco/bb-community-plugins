# @phosphorco/bb-provider-settings — v1 contract

Status: **accepted design contract** (revision 3, independently reviewed by the
Execution Steward on 2026-10-02). Implementation and consumer acceptance remain
separate plan obligations.

- `registration-probe` is verified with typed limits. The final collector is `runtime/collector-revision/steward-final-collector.json` (`e36588ce…`).
- Decisions, digests and evidence links: campaign record `evidence/contract.md`. Consumers: [CONSUMERS.md](CONSUMERS.md).

This package gives plugins one way to represent, validate, resolve and edit the
provider / model / reasoning / service-tier choice for an agent *role* they own.
It is not a settings store, a registry, a permission system or a rule engine.
Where existing consumers validate differently, the package exposes **small named
policy values**, so that adoption keeps each consumer's outcomes unchanged.

## 1. Ownership

| Owned by the feature (never moved here) | Provided by this package |
|---|---|
| Storage keys and schemas, fingerprints of its own keys, migrations | DTOs and codecs for role choices |
| Permissions, instructions, tools, credentials, workspace gates | Pure resolution against an explicit basis |
| Destination routing, provisioning, capture/snapshot timing | Catalog validation with per-consumer policy values |
| Schedules, retries, idempotency, cleanup, policy precedence | Typed projection of *new* overrides to spawn / first-send fields |
| Which roles exist and when edits apply | Fixed owner RPC protocol, owner enumeration, error classification |
| | Optional React controls driven by explicit owner clients |

## 2. Public entries

| Entry | Runtime imports | Contents |
|---|---|---|
| `@phosphorco/bb-provider-settings` | `zod` only. No React and no `@get-bb/plugin-sdk` runtime | DTOs/codecs, `resolve*`, `validateSelection`, `projectSpawnOverride`, `projectFirstSendOverride`, `classifyOwnerError`, `negotiateVersion`, `fingerprintValues`, `reconcileUnknownSave` |
| `…/bb` | root and `zod`. BB only through injected `bb`/`sdk` objects (types only) | `registerProviderSettingsOwner`, `createOwnerClient`, `enumerateProviderSettingsOwners`, `readCatalog` |
| `…/react` | root, `/bb`, `react` (peer), `@get-bb/plugin-sdk/app` (peer) **only** for `experimental_ProviderModelPicker` | `RoleSettingsEditor`, `ProviderSettingsDirectory` |

- `/react` never calls `useRpc`, `useSettings`, `useRealtime` or `experimental_usePluginId`. They resolve to the *slot owner*, which was observed calling the wrong plugin. A bundle-scan test fails if any appears.
- The root entry is tested in an environment without React or the SDK.
- `react` and `@get-bb/plugin-sdk` are optional peers; `zod` is a dependency.
- No frontend registry, store, bus or `globalThis` key is exported (§11).

## 2a. Public API (exact names for emitted types and tests)

All DTOs are plain JSON. Each has an exported zod schema named `<camelName>Schema`: `roleChoiceSchema`, `describeEnvelopeSchema`, `roleDescriptorV1Schema`, `readInputSchema`, `readResultSchema`, `validateInputSchema`, `validateResultSchema`, `saveInputSchema`, `saveResultSchema`, `issueSchema`. Input schemas are strict; output schemas are passthrough.

```ts
// ── root: catalog data (structural subsets of SDK shapes; extra fields ignored) ──
export interface ProviderInfo {
  id: string; available: boolean;
  capabilities: { modelCatalogScope: "host" | "workspace"; supportsServiceTier: boolean; permissionModes: string[] };
  serviceTiers?: { id: ServiceTier }[];
}
export interface CatalogModel {
  id: string; model: string; routeProviderId?: string; isDefault: boolean;
  defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string }[];
}
export interface ProviderCatalog {
  providerId: string; route: CatalogRoute | null;
  modelLoadError: { code: string; detail: string | null } | null;
  models: CatalogModel[]; selectedOnlyModels: CatalogModel[];
}
export type DecodeResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

// ── root: codecs (never throw except encode) ──
export function decodeRoleChoice(input: unknown): DecodeResult<RoleChoice>;
//   Validates shape only. NO normalization: `fields: {}` and empty entries decode as stored (Read retains them).
export function normalizeRoleChoice(choice: RoleChoice): DecodeResult<RoleChoice>;
//   fields:{} → inherit; entries:{} → inherit; entry {} deleted; blank strings → issue `malformed`.
export function encodeRoleChoice(choice: RoleChoice): string;
//   normalize + canonical JSON (sorted keys). Throws `ProviderSettingsCodecError` (with .issues) when normalize fails.
export function checkStatic(choice: RoleChoice, role: RoleDescriptorV1): Issue[];
//   choice kind allowed + RoleCapability filter (§4). No catalog.
export function negotiateVersion(envelope: unknown, supported: readonly number[]):
  | { kind: "ok"; version: 1; roles: RoleDescriptorV1[]; versions: number[] }
  | { kind: "incompatible"; reason: "version" | "schema"; versions?: number[] };

// ── root: validation and resolution ──
export function validateSelection(
  sel: { providerId: string; model: string; reasoningLevel: string; serviceTier?: ServiceTier },
  providers: readonly ProviderInfo[], catalog: ProviderCatalog, policy: ValidationPolicy,
  opts?: { newSelection?: boolean },            // true: selected-only rows rejected under candidates:"models"
): { ok: true; row: CatalogModel } | { ok: false; issues: Issue[] };
export function resolveTuple(choice: RoleChoice, providers: readonly ProviderInfo[], catalog: ProviderCatalog, policy: ValidationPolicy): Resolution;          // boundary "spawn"
export function resolveCallerCascade(
  fields: Extract<RoleChoice, { kind: "fields" }>["fields"], caller: ExecutionSelection,
  providers: readonly ProviderInfo[], catalogFor: (providerId: string) => Promise<ProviderCatalog>, policy: ValidationPolicy,
): Promise<Resolution>;                                                    // boundary "spawn"; always validates (§5)
export function resolveByProvider(
  choice: RoleChoice, basis: ProviderBasis,
  providers: readonly ProviderInfo[],                // availability of basis.providerId
  catalog: ProviderCatalog | null,                   // null only for create + reasoning-only
  policy: ValidationPolicy, capability: RoleCapability,
): Resolution;                                     // boundary "first-send" (fork-child) or "spawn" (create)
export function projectSpawnOverride(r: Resolution, p: Provenance): SpawnFields;        // §6
export function projectFirstSendOverride(r: Resolution, p: Provenance): FirstSendFields; // §6
export class ProjectionBoundaryError extends Error {}
export function classifyOwnerError(error: unknown): OwnerErrorKind;    // §8 table
export function reconcileUnknownSave(before: ReadResult, submitted: RoleChoice, fresh: ReadResult):
  "matches-submitted" | "unchanged" | "conflicting";
export function fingerprintValues(values: readonly unknown[]): Promise<string>;  // sha256 hex of canonical JSON, WebCrypto

// ── /bb: owner side (the only adapter shape) ──
export interface OwnerRolePort {
  descriptor: RoleDescriptorV1;
  policy: ValidationPolicy;
  readValues(): Promise<readonly unknown[]>;   // exact values from the OWNER API, fixed key order, defaults included
  decode(values: readonly unknown[]): { choice: DecodeResult<RoleChoice>; owned: unknown; rule: string };
  preserveOwned?(values: readonly unknown[], next: RoleChoice): Issue[];  // e.g. Rosetta instructions
  destination?(): Promise<{ route: CatalogRoute | null; preview: boolean } | { unresolved: string }>; // destination roles only
  checkSampleRoute(route: CatalogRoute): Promise<Issue[]>;                 // `sample-route-unreadable` etc.
  catalog(route: CatalogRoute | null, providerId: string): Promise<{ providers: ProviderInfo[]; catalog: ProviderCatalog }>;
  featureChecks?(sel: ExecutionSelection, route: CatalogRoute | null): Promise<Issue[]>; // workspace gates, new-machine rule
  write(next: RoleChoice, values: readonly unknown[]): Promise<void>;      // writes only this role's keys via owner storage
}
// Type-only imports:
//   import type { BbPluginApi } from "@get-bb/plugin-sdk";             (server: BbPluginApi["sdk"] = PluginBbSdk)
//   import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";  (browser: useSdk())
export type CatalogSdk = Pick<BbPluginApi["sdk"], "providers"> | Pick<PluginBrowserBbSdk, "providers">;
export type OwnerSdk = Pick<BbPluginApi["sdk"], "plugins"> | Pick<PluginBrowserBbSdk, "plugins">;
// The package type tests compile both a server-side `bb.sdk` and an app-side `useSdk()` argument against these.
export function registerProviderSettingsOwner(
  bb: Pick<BbPluginApi, "rpc">,
  roles: readonly OwnerRolePort[],
): void;   // registers the four methods (§7); implements fingerprint/static/eligibility/conflict/re-read
export function readCatalog(sdk: CatalogSdk, route: CatalogRoute | null, providerId: string):
  Promise<{ providers: ProviderInfo[]; catalog: ProviderCatalog }>;  // sdk.providers.list + .models with route args

// ── /bb: caller side ──
export interface OwnerClient {
  readonly pluginId: string;
  describe(signal?: AbortSignal): Promise<ReturnType<typeof negotiateVersion>>;
  read(role: string, signal?: AbortSignal): Promise<ReadResult>;
  validate(role: string, choice: RoleChoice, sampleRoute?: CatalogRoute, signal?: AbortSignal): Promise<ValidateResult>;
  save(role: string, choice: RoleChoice, expectedFingerprint: string, sampleRoute?: CatalogRoute): Promise<SaveResult>; // no signal
}
// Transport failures reject with `OwnerCallError { kind: OwnerErrorKind; cause: unknown }`.
export function createOwnerClient(sdk: OwnerSdk, pluginId: string): OwnerClient;
export interface OwnerRow {
  pluginId: string; displayName: string | null; listedStatus: string;
  state: "pending" | "participant" | "absent" | "incompatible" | "unavailable" | "error";
  versions?: number[]; roles?: RoleDescriptorV1[]; error?: OwnerErrorKind;
}
export function enumerateProviderSettingsOwners(opts: {
  sdk: OwnerSdk; signal: AbortSignal;
  concurrency?: number; timeoutMs?: number; onRow(row: OwnerRow): void;
}): Promise<{ rows: OwnerRow[]; omittedCount: number }>;
```

`SpawnFields`, `FirstSendFields`, `Provenance`, `OwnerErrorKind`, `Issue`, `IssueCode`, `Resolution`, `ProviderBasis`, `RoleCapability`, `ValidationPolicy`, `ReadResult`, `ValidateResult`, `SaveResult` and `RoleDescriptorV1` are the types defined in §§3–8. There is no other adapter layer. Consumer adapters are `OwnerRolePort` objects.

## 3. Selection data

### 3.1 Identifiers

| Name | Meaning |
|---|---|
| `providerId` | **Execution** provider, immutable per thread. Permission, tier and fixed-provider checks use it. |
| catalog `id` | Catalog row identity; may differ from `model` |
| `model` | Execution model string sent to spawn/send (`row.model`) |
| `routeProviderId` | Optional route qualifier on a row. Not a general substitute for `providerId` (Pi routes to underlying providers while execution stays `pi`). |

A stored choice keeps the **exact string the user configured** (Perspectives may
store a catalog `id`). Read and save never canonicalize it. Resolution maps it to
`row.model` at invocation.

### 3.2 DTOs

```ts
export type ReasoningLevel = string;     // checked against the catalog
export type ServiceTier = "default" | "fast";
export interface ExecutionSelection { providerId: string; model: string; reasoningLevel: ReasoningLevel; serviceTier?: ServiceTier }
export type RoleChoice =
  | { kind: "inherit" }
  | { kind: "tuple"; selection: ExecutionSelection }
  | { kind: "fields"; fields: { providerId?: string; model?: string; reasoningLevel?: ReasoningLevel } }
  | { kind: "by-provider"; entries: Record<string, { model?: string; reasoningLevel?: ReasoningLevel }> };
export type CatalogRoute = { kind: "host"; hostId: string } | { kind: "environment"; environmentId: string };
```

Codec rules:

- Strings are non-empty after trim; a blank string is a decode error.
- **Clearing a field = deleting its key.** `fields: {}`, `entries: {}` and an entry `{}` normalize to `inherit` or to deletion on *encode* of a new save.
- `serviceTier` exists only on `tuple`. **`by-provider` never carries or advertises a tier.**
- Legacy blanks (Perspectives `""`/`"inherit"`, Rosetta `""`) are converted in the owner adapter. The raw stored strings are never rewritten by read.

| Shape | Used by |
|---|---|
| `inherit` | every role |
| `tuple` | Rosetta conversation agent, GitHub reviewer, Thread Progress sticker |
| `fields` + cascade `caller-v1` | Perspectives planner and expert |
| `by-provider` (provider fixed to the source) | BTW, Sticky Notes shortener, Thread Progress summary |

## 4. Validation policy (exact, per consumer)

`validateSelection(selection, catalog, policy)` takes the catalog that the caller
loaded for an **explicit route**. It never checks permission or workspace gates;
those stay feature-owned.

```ts
export interface ValidationPolicy {
  match: "model" | "id-or-model";                      // configured string vs row.model, or row.id || row.model
  routeQualifier: "must-equal-provider-when-present" | "ignore";
  candidates: "models" | "models+selected-only";
  modelLoadError: "reject" | "not-checked";            // not-checked: fall through to matching, as today
  tier: "any-non-null-requires-support-and-listed"     // RTD
      | "non-default-requires-support"                 // Rosetta
      | "not-validated";                               // Perspectives (tier inherited, never chosen)
}
```

| Consumer | match | routeQualifier | candidates | modelLoadError | tier | Feature-owned extra gates |
|---|---|---|---|---|---|---|
| Rosetta (`agent-profile.ts:121-143`) | model | must-equal | models | reject | non-default-requires-support | workspace scope requires an `environment` route; new-machine target vs existing destination |
| Perspectives (`Perspectives.ts:598-662`) | id-or-model | ignore | models+selected-only | not-checked | not-validated | permission support and ceiling; trigger rule (§5) |
| Review to Disposition (`project-resolver.ts:28-37`) | model | must-equal | models | reject | any-non-null-requires-support-and-listed | permission support; workspace scope requires `profile.environment.type === "project-default"` |
| New roles (GitHub, Progress, BTW, Sticky) | model | must-equal | models | reject | non-default-requires-support (tuple only) | as listed in CONSUMERS.md |

The checks run in a fixed order:

1. Provider available (`provider-unavailable`).
2. `modelLoadError` (when `reject`) → `catalog-unavailable`.
3. Model match → `model-unavailable`, or `selected-only-not-offered` for a new selection when `candidates: models` and the row exists only in `selectedOnlyModels`.
4. Reasoning supported → `reasoning-unsupported`.
5. Tier per policy → `service-tier-unsupported`.

Consolidation is accepted only when each consumer's existing fixtures produce
**identical** accept/reject outcomes with its policy row.

**Static role capability** (fixed-to-source roles only). This is cheap, static data that each owner declares from its **own** witnesses. It is published in the role descriptor (§7), so controls, Validate, Save and invocation all apply the same filter:

```ts
type Cap = "demonstrated" | "unknown";
export interface RoleCapability {
  evidence: string;                                  // link to the role's witness receipts
  boundaries: ("fork-child" | "create")[];           // every path this role can take (summary: both)
  providers: Record<string, {
    blocked?: string[];                              // e.g. ["catalog-empty"]
    perBoundary: Partial<Record<"fork-child" | "create", {
      model: Cap; reasoningLevel: Cap; reasoningWithoutModel: Cap;
    }>>;
  }>;
}
```

An entry shape for provider `P` is **offered** only when, for **every** boundary in `boundaries`:
- `model` present ⇒ `model` is demonstrated;
- `reasoningLevel` present ⇒ `reasoningLevel` is demonstrated;
- `reasoningLevel` without `model` ⇒ `reasoningWithoutModel` is demonstrated.

So no field can silently work on only one of the summary's paths. A provider that is absent, or has `blocked` codes, → `provider-blocked`. Any other gap → `field-not-offered`.

These **static** checks are definitive. They reject on Validate and Save (for every `saveValidation` mode) and again at invocation. The package names no vendors.

**Static filtering vs catalog eligibility:**
- **Static capability filtering** answers "may this role carry this kind of field for this provider at all?". It needs no catalog, and a failure is always a rejection.
- **Catalog eligibility** answers "does this exact model/effort exist on a route?". It is dynamic: destination roles reject on failure; invocation roles get `deferred` or a sample warning.

The two are reported separately.

Probe matrix (fingerprinted `bb-machine`, BB-recorded execution, `independentProviderEcho: false`). These are inputs to role policies, not constants:

| Provider | model | reasoning | tier |
|---|---|---|---|
| `codex` | supported | supported | supported (not used by `by-provider`) |
| `claude-code` | supported | supported | unknown |
| `pi` | unavailable | unavailable | unknown; provider **blocked**: `catalog-empty`, `no-authorized-source-permission` |

## 5. Resolution

All resolution functions are pure. The **basis** is supplied by the feature at its
own boundary and is never inferred.

**`tuple`:** `resolveTuple(choice, catalog, policy)` validates the tuple and returns it for a spawn. `inherit` → `no-override`.

**`fields` (`caller-v1`):** `resolveCallerCascade(fields, caller, providers, catalogFor, policy)` reproduces `Perspectives.ts:598-662` exactly:

1. `providerId` = the field, else `caller.providerId`. The provider must be available.
2. Candidates are `models + selectedOnlyModels`.
   - With a model field: the row where `row.id === field || row.model === field`.
   - Without one: if the provider is unchanged, the row where `row.model === caller.model`. **Otherwise, or if that row is missing, the `isDefault` row, even for the same provider.**
   - No row → `model-unavailable`. The resolved model is `row.model`.
3. `reasoningLevel` = the field. Otherwise the caller's value if provider **and** `row.model` are both unchanged. Otherwise `row.defaultReasoningEffort`. Unsupported → `reasoning-unsupported`.
4. `serviceTier` = `caller.serviceTier ?? "default"` when the provider `supportsServiceTier`, else omitted. It is not validated.
5. There is no `modelLoadError` check; a failed catalog surfaces through matching, as today.

**The trigger stays in Perspectives.** When no selection field **and** no permission override is set, Perspectives returns the caller tuple with **no catalog calls** and never calls the cascade. Permission checks run after the cascade, in Perspectives.

**`by-provider`:**

```ts
export interface ProviderBasis {           // what is actually executing, supplied explicitly
  providerId: string;
  model?: string;                        // required for "fork-child"; absent for "create" (native default deferred)
  reasoningLevel?: ReasoningLevel;
  boundary: "fork-child" | "create";
}
resolveByProvider(choice, basis, providers, catalog, policy, capability: RoleCapability) => Resolution
```

- No entry for `basis.providerId` → `no-override`. This is deliberate inheritance: the existing native path is unchanged, and no field is copied into native requests.
- An entry exists → each present field is checked against `capability`.
  - For `fork-child`, the effective model is `entry.model ?? basis.model`, validated against the catalog. **A reasoning-only entry is validated against the child's `basis.model`.**
  - For `create`, see the create-boundary rule below.
  - Only the entry's own fields are emitted.
- Any failure → `rejected`, with the entry retained. No other entry is substituted. The provider never changes.

**Bases, by boundary:**

- **Fork child** (BTW, Sticky, summary fork). The authoritative basis is the **child's** execution read after `fork` returns (`sdk.threads.defaultExecutionOptions({ threadId: child })`), revalidated immediately before the first send.
- **Early check, before the child exists.** These checks are **definitive**: decode, static capability, `provider-blocked`, and catalog eligibility of an **explicit** `entry.model` (with its reasoning) on the source route.
  - Any check that depends on the *inherited* model (a reasoning-only entry against the source's current model) is a **provisional estimate**. It never blocks the operation, because an anchored fork child may execute a different model than the source's current one.
  - The model-dependent check becomes definitive only against the child basis, after fork.
- **Create boundary** (summary fallback only). The native create chooses the omitted model from the project/provider defaults, not from the source. That deferral is **preserved**:
  - An entry with `model` emits `model` (and `reasoningLevel` if present), validated against the create route's catalog.
  - A **reasoning-only** entry emits only `reasoningLevel`; the model stays omitted. The package returns `deferredChecks: ["reasoning-vs-native-default-model"]`.
    - The feature may run a *provisional* check against its best estimate of the native default. That is `projects.defaultExecutionOptions` when its provider equals the source provider, otherwise the catalog `isDefault` row. The check is labelled provisional.
    - The **native create is authoritative**. A create rejection is handled as a known pre-worker failure (CONSUMERS §4).
    - **No source model is emitted to make validation possible.**
  - With no entry, the fallback stays byte-identical.
  - **The reasoning-only override on the create boundary is not advertised** until the summary role's fallback witness shows how native create treats it. Until then the role's capability for that boundary is `reasoningLevel: "unknown"`, which yields `field-not-offered` for reasoning-only entries reaching the fallback. Entries that include a model are unaffected.
  - No create-then-send restructure of the fallback is proposed. That is **not** a claim of SDK impossibility: `ThreadSpawnArgs` requires `prompt` or `input`, and `input: []` may type-check. The restructure is unwitnessed and unnecessary for defining partial native create validation.

```ts
export type Resolution =
  | { kind: "no-override" }
  | { kind: "override"; boundary: "spawn" | "first-send"; fields: { providerId?: string; model?: string; reasoningLevel?: string; serviceTier?: ServiceTier };
      deferredChecks?: "reasoning-vs-native-default-model"[] }
  | { kind: "rejected"; issues: Issue[] };
```

Revalidation at dispatch may reject a captured explicit choice. It never replaces one.

## 6. Projection of new overrides

```ts
type Provenance = "explicit-map" | "omit-map";
projectSpawnOverride(r: Resolution & { boundary?: "spawn" }, p: Provenance)
  : { providerId?; model?; reasoningLevel?; serviceTier?; executionInputSources?: Partial<Record<"providerId"|"model"|"reasoningLevel"|"serviceTier", "explicit">> };
projectFirstSendOverride(r: Resolution & { boundary?: "first-send" }, p: Provenance)
  : { model?; reasoningLevel?; executionInputSources?: Partial<Record<"model"|"reasoningLevel", "explicit">> };
```

- `no-override` → `{}`: no fields and no map.
- A boundary mismatch throws `ProjectionBoundaryError`. So does any `providerId` or `serviceTier` reaching `projectFirstSendOverride`. **Provider is never emitted on send or fork**, and fork requests receive nothing.
- **Never `executionInputSources: {}`.** With `explicit-map`, the keys equal **exactly** the emitted fields. With `omit-map`, there is no map.
  - Probe evidence: an empty map ignored the overrides; a partial map dropped unlisted fields; an absent map and an all-explicit map both applied.
- The owner appends its own provenance keys (e.g. `permissionMode: "explicit"`) **unchanged**, only for fields it emits itself.
- Provenance mode per consumer: Rosetta `omit-map` (as today); all others `explicit-map`.
- **Never applied** to captured Future Threads requests, Review to Disposition profile projection or permission provenance. Those are forwarded exactly as today.
- Witnesses check **accepted execution**, never `send ok`.

## 7. Owner RPC protocol

`registerProviderSettingsOwner(bb, owner)` (`/bb`) registers the following through
`bb.rpc.register`. Handlers receive **input only**: there is no caller identity,
project or thread. Everything they need is explicit input that the owner validates.

**Storage is always the owner's existing global role settings.** No request input can change the destination of a save.

| Method (fixed name) | Input | Output |
|---|---|---|
| `providerSettingsDescribe` | anything (ignored) | `DescribeEnvelope` |
| `providerSettingsV1Read` | `{ version: 1; role }` (strict) | `ReadResult`. **No catalog calls, no writes.** |
| `providerSettingsV1Validate` | `{ version: 1; role; choice; sampleRoute?: CatalogRoute }` (strict) | `ValidateResult`. Catalog checks, no writes. |
| `providerSettingsV1Save` | `{ version: 1; role; choice; expectedFingerprint: string; sampleRoute?: CatalogRoute }` (strict) | `SaveResult` |

```ts
// Describe: envelope parsed tolerantly; roles decoded only under a shared version.
export interface DescribeEnvelope { protocol: "bb-provider-settings"; versions: number[]; roles: unknown }
//   versions: 1..16 entries, each an integer 1..1000
export interface RoleDescriptorV1 {
  id: string;                                          // /^[a-z][a-z0-9-]{0,47}$/, stable
  label: string; description?: string;
  choiceKinds: RoleChoice["kind"][];
  cascade?: "caller-v1";
  providerPolicy: "any" | "fixed-to-source";
  saveValidation: "destination" | "invocation";        // see below
  capability?: RoleCapability;                         // required when providerPolicy = "fixed-to-source"
  applies: string;                                     // one sentence: when edits take effect
  writable: boolean;
}
export interface ReadResult {
  version: 1; role: string;
  stored: { status: "valid-shape"; choice: RoleChoice; staticIssues: Issue[] }  // staticIssues: kind/capability, no catalog
        | { status: "malformed"; issues: Issue[]; raw?: string };
  fingerprint: string;                                 // over readValues() (always defined)
  ownedFieldsDigest: string | null;                    // sha256 of feature-owned values inside written keys (Rosetta instructions)
  eligibility: { status: "unverified" };               // Read never claims catalog validity
  ownedFieldsPresent: string[];                        // e.g. ["additionalInstructions"]
  rule: string;                                        // inheritance rule text, e.g. "inherits the calling thread"
  destinationRoute: CatalogRoute | null;               // destination roles only; null = not yet known
  destinationPreview: boolean;                         // Rosetta new-machine: true
}
export type Eligibility =
  | { status: "verified"; route: CatalogRoute | null; routeKind: "destination" | "sample" | "primary-preview" }
  | { status: "invalid"; issues: Issue[]; routeKind: "destination" | "sample" | "primary-preview" }
  | { status: "deferred"; reason: string };            // invocation-authoritative, no usable route
export interface ValidateResult { shapeIssues: Issue[]; eligibility: Eligibility }
export type SaveResult =
  | { outcome: "saved"; read: ReadResult; eligibility: Eligibility }
  | { outcome: "rejected"; issues: Issue[]; eligibility?: Eligibility }
  | { outcome: "conflict"; current: ReadResult };
```

**Save acceptance per role (`saveValidation`):**

- **Every mode:**
  - Decode and static checks (choice kind, capability) reject first.
  - A config written outside this protocol (for example by the native settings form) that is malformed or fails static checks is **retained** and reported on Read. It is never normalized.
  - **`inherit` / reset, and deletion of an override key or entry, never need a catalog, a destination or a configured project.** Only fields being *set* are catalog-checked. Owner-field preservation still applies (Rosetta rejects dropping non-empty instructions). That way an invalid override can always be cleared while the destination is unavailable.
- **`destination`** (Rosetta, GitHub reviewer). For set fields, the owner resolves its own configured destination route and validates there. `invalid` → `rejected`. If the destination is unresolved, setting a tuple is rejected with the reason.
  - When the destination does not exist yet (Rosetta new-machine target), it validates against the primary catalog as a preview, as today: `routeKind: "primary-preview"`, `destinationPreview: true`. Destination validation happens again at dispatch.
- **`invocation`** (Perspectives, BTW, Sticky, Progress summary and sticker). Execution context exists only at invocation, so save accepts **statically valid** explicit intent. Only *catalog* eligibility may be deferred. A choice outside the role's offered field set is never saved.
  - Without a `sampleRoute`, eligibility is `deferred`.
  - With one, the owner validates the route itself (it must be a host or environment it can read). A sample `invalid` is returned as a **warning** and does not reject.
  - Authoritative validation happens at invocation. Editing a global default never requires an active thread.
- `sampleRoute` never selects the storage destination, never provisions and never changes scope. A preview or sample **effective** tuple is never saved implicitly; only the user's explicit `choice` is saved.

**Fingerprints and conflicts:**

- `fingerprint` = `fingerprintValues(port.readValues())`: SHA-256 of the canonical JSON array of the values that the **owner's own storage API** returns (e.g. `settings.get()`), for every key the save writes, in fixed order, **including default-filled values**.
  - It is not computed over physical settings-database bytes or presence, which plugins cannot read.
  - The values are not decoded or normalized first.
  - So an explicit value equal to the default and an unset key fingerprint identically. That is an accepted limit of the owner API.
- Save writes only those keys, after checking `expectedFingerprint === current` (`conflict` otherwise).
- This is check-then-write in one handler call. It is **not atomic**: native settings handles have no compare-and-swap, and the native settings form or another writer can interleave (last writer wins in that window). There is no global revision.
- **Feature fields stored inside a written key** (Rosetta `additionalInstructions` inside `agentProfile`) are covered by the fingerprint. They are preserved verbatim on a selection-only save.

Other rules:

- Results are domain values; handlers throw only for genuine faults (native `500`).
- Owner inputs are strict. Client output schemas tolerate added fields. Changed semantics require a new method name and version.
- Register with `experimental_discoverable: true` as inert metadata. Callers never use `experimental_discoverRpc` (the route is absent on this fork).

## 8. Client side

**Owner client.** `createOwnerClient(sdk, pluginId)` returns typed calls bound to one target through `sdk.plugins.callRpc({ pluginId, method, input, outputSchema, signal })`.

**Version negotiation.** `negotiateVersion(envelope, [1])` → `max(shared)`.

- `[1]` and `[1, 2]` → v1; roles are decoded with `RoleDescriptorV1`.
- `[2]` → `incompatible(version)`, with `[2]` shown. Roles are not decoded.
- A malformed envelope → `incompatible(schema)`.

Fixtures: `[1]`, `[1,2]`, `[2]`, `[]`, `[0]`, non-integer, more than 16 entries.

**Enumeration.** `enumerateProviderSettingsOwners({ sdk, signal, concurrency: 4, timeoutMs: 5000, onRow })`:

1. Call `plugins.list()` once.
2. Describe only owners whose status is `running` or `degraded` (`degraded` is not yet observed).
3. Rows are keyed by **target** `pluginId`; any owner name reported by describe is ignored.
4. Progressive `onRow` per owner, so a slow owner never hides its neighbours.
5. Generation token: stale results are dropped, and the previous generation is aborted.
6. Other statuses → omitted, with one "disabled or failed plugins" note. No participant persistence.
7. Triggers: mount, explicit refresh, realtime reconnect. No polling, no lifecycle listeners, no catalog loading.

**Error classification.** `classifyOwnerError` uses native status **plus body shape**:

| Status and body | Kind |
|---|---|
| 404 with `body.error.code === "unknown_method"` | `absent` (observed) |
| 404 with a string body naming an unknown plugin | `vanished` |
| Generic 404 `not_found` | `host-incompatible` |
| 503 with a string body `not running (status: X)` | `unavailable` (observed, disabled) |
| 400 `invalid_input`, 500 `invalid_output`, or a local output-schema failure | `incompatible` (observed) |
| Other 500 | `owner-error` |
| 401 / 403 | `unauthorized` |
| `AbortError` | `cancelled` |
| Network failure or timeout | `transient` |

**Save outcome.** Response loss, timeout, abort after dispatch, network failure or 5xx → `unknown`. The client does a fresh Read and reconciles by **content**, not by fingerprint change. A changed fingerprint alone proves nothing, because another writer may have changed the value.

- `matches-submitted`: the fresh decoded `choice` equals the submitted choice **and** `ownedFieldsDigest` equals the value read before the save. Shown as "saved (confirmed by re-read)".
- `unchanged`: the fresh choice and owned digest equal the pre-save read. Shown as "not observed; the save may not have applied or may still land". The user may deliberately save again with the fresh fingerprint.
- `conflicting`: anything else. The current value is shown, as in a conflict.

There is **no auto-retry and no implicit abort** on unmount or refresh. Saves are never attributed when the content does not match.

## 9. React controls (`/react`)

```tsx
type BrowseSeed = { selection: ExecutionSelection; label: string };   // never saved, never "effective"
<RoleSettingsEditor
  client={ownerClient}                        // owner-bound RPC (read/validate/save)
  role={descriptorV1}
  catalogSdk={sdk}                            // CatalogSdk (providers.list/models), injected like the Directory's sdk
  sampleRoute?={CatalogRoute}                 // routing for browsing/sample validation
  providerEntry?={string}                     // by-provider: edit one entry
  seed?={(route: CatalogRoute | null, catalog: ProviderCatalog) => Promise<BrowseSeed | null>}  // feature seed rule
/>
<ProviderSettingsDirectory sdk={sdk /* OwnerSdk & CatalogSdk */} reconnectKey={n} />
```

**Picker seeding.** The native picker needs a complete value, so the editor builds one locally. There is no new RPC.

1. **Saved explicit fields** come first. Only fields that are `Set` or part of a tuple are used.
2. Any **missing** field is filled from the browse seed:
   - the feature `seed` callback, if one is given. Rosetta passes its existing `agentPickerSeed` rule (project-default model and effort, `agent-profile.ts:100-117`);
   - otherwise a deterministic **default seed** from `readCatalog(catalogSdk, route, providerId)`, using:
     - the route: `ReadResult.destinationRoute`, else `sampleRoute`, else `null` (primary routing);
     - the provider: the explicit provider field, else the `by-provider` entry key, else the first `available` provider in `providers.list` order;
     - the model: the `isDefault` row, else the first row; its `defaultReasoningEffort`; no tier.
3. Seeded fields are labelled **"Browsing: <provider>/<model> on <route>"**, with the label following the current picker preview. They are not saved and are not shown as effective intent. Fields whose toggle is `Inherit` stay absent, whatever the seed contains.
4. If the catalog cannot be loaded, or no provider is available, the picker is not mounted. The editor shows the specific cause.

Catalog loads happen only on Edit/Replace or Check, never merely from opening or
refreshing a read-only row. Directory browsing caches are scoped to its SDK and
page lifetime, cleared on explicit refresh/reconnect, and do not retain failures.

1. **Unopened** rows perform no Read or catalog load. **Expanded** rows call Read
   and show:
   - the stored choice as text, or malformed with its cause;
   - a compact eligibility status;
   - descriptor-derived explanations and the owner-supplied inheritance rule under **How this works**, with **"Eligibility not checked"** under **Details**.

   Fixed-provider explanations distinguish unavailable overrides from inherited
   execution, and unverified support from reasoning available only with a model
   override. Boundary descriptions use plain language. The shared UI knows no
   owner-specific settings or execution rules; it reads the generic descriptor
   and owner-supplied Read metadata.

   No catalog load and no picker.
   `staticIssues` from Read are shown immediately, because they need no catalog.
   Previously opened editors stay mounted when collapsed, preserving drafts.
   Explicit directory refresh/reconnect retains existing rows and revalidates
   visible editors; hidden editors revalidate once when reopened. Pending initial
   Reads are not duplicated. A failed initial Read can recover on explicit
   refresh, with Edit gated until success. Refresh preserves a dirty draft and
   its base fingerprint, showing a conflict if saved storage changed. A clean
   editor adopts the fresh value. Older responses cannot replace newer Reads or
   a confirmed Save.
2. **Check** (explicit button) or **Edit** calls Validate (destination, or the user-chosen sample) and shows `verified`, `invalid` (retained value plus cause), `deferred` or a primary preview, each labelled.
3. **Edit or Replace** mounts `experimental_ProviderModelPicker` with the validated route. An invalid saved value is validated and shown **before** the picker mounts; only **Replace** opens the picker for it. Server validation still decides.
   - **`tuple`:** **Use this selection** stages the whole browsed picker value (provider, model, reasoning, plus tier when offered).
   - **`fields` (partial):** three explicit toggles, **Provider**, **Model** and **Reasoning**, with `inherit | set` values shown as **Inherit | Override: <preview value>**.
     - The picker is a browsing surface only. Switching a toggle to `set` copies that field from the browse value. **Apply preview to overrides** deliberately stages later browse changes for fields whose toggles are `set`.
     - Fields toggled `Inherit` remain absent whatever the picker shows, so choosing one field never makes the others explicit.
     - Switching an override back to **Inherit** deletes the key.
     - When Provider is `Inherit`, the picker's provider is a labelled **browse** selection (sample or preview), never saved.
   - **`by-provider`:** **Override for provider** selects an entry offered by `capability`. Each entry has a fixed provider (`allowProviderChange: false`) and **Model** and **Reasoning** toggles, shown as **Keep original | Override: <preview value>**. Toggles whose field is not offered for that provider are disabled and explain why. Removing an entry deletes it. The support table explains when reasoning requires a model override; static validation remains authoritative.
   - **Stored strings stay as stored.** A configured catalog `id` (Perspectives) remains that string until the user deliberately picks a model. A pick stores the picker's `model` string; reconciliation alone never rewrites it.
4. Picker **`onChange`** updates browsing only. The native picker may reconcile invalid values into a default browse value. Reconciliation never enables Save.
5. **Inherit / Use this selection** is an explicit decision. A sample or preview tuple is labelled ("Preview on …") and never becomes the saved choice unless the user stages it and saves.
6. **Save** sends the explicit choice with the Read fingerprint.
   - A conflict shows the current value, with **Use current** or **Overwrite** (which re-sends with the new fingerprint).
   - `owner-fields-would-be-lost` is shown as returned.
   - An unknown outcome is handled as in §8.
7. Each row shows its own pending and error state.

The controls ship scoped theme-token styles through `/react`, including hidden
panel handling and reduced-motion support. Root and `/bb` imports have no DOM or
styling side effects. No optimistic UI state claims that a Save committed before
confirmation or successful unknown-outcome reconciliation.

The effect of native picker storage writes (empty `sessionStorage bb.promptbox.*`, catalog caches) on an existing composer selection is **unobserved**. That is why the picker is deferred until Edit. `integration-instrument` must include a witness with a pre-populated composer.

## 10. Packaging and hosts

- Ordinary npm package. The generator owns the manifest and must generate it before the next install (`sync:check` currently passes with the Markdown-only directory).
- The emitted JS and `.d.ts` for each entry are packed under `artifacts/`, which is never committed.
- The **same archive bytes** are installed into two independent consumers with plain `npm install`. Organization workspace builds are a separate, labelled input.
- The community Perspectives manifest ships only a registry version, never an outside-repo `file:` path. Its release waits for authorized publication. Shared local controls need an authorized app entry (React peer, `files`, build); until then, the native form is its local editor and a third writer.
- **No minimum host version.** The tested target is *fingerprinted*:
  - reported version 0.44.0, `appUpdate` commit `null`;
  - UI origin `127.0.0.1:38888` served `index-B3mIX_l0.js` (`469b1699…`);
  - SDK origin `127.0.0.1:38886`, kept separate from the UI origin;
  - the server revision is unobservable;
  - discovery GET returns 404 (fork patch 0028), recorded as a fingerprint.
- Probe identity hashes are disk-at-call values, not loaded bytes. Duplicate and mixed-version receipts belong to an earlier generation. Catalogs were equal for host and environment, so the package tests need a fixture with differing routes.
- **Final-archive host proof must be re-run.** The new method names and DTOs were not exercised by the probe.

## 11. Reserved, not shipped: frontend presentation lease

Not exported in v1.

- **Key:** `Symbol.for("phosphor.bb-provider-settings.realm")` on `globalThis`, holding plain-data versioned slots (`{ v1: Map }`) and a data-only `EventTarget`.
- **Leases** are taken only in a `contentScripts` `mount(ctx)` and keyed by `(pluginId, generation, token)`. They are released by the disposer or by `ctx.signal`, with compare-and-delete. No top-level writes, and no cross-bundle calls except the leased component.
- Rows and authority stay RPC-only. Leased components receive explicit owner clients and context as props.
- **Ship only when** a named role needs presentation that shared controls cannot express, **and** mixed-version, stale-disposer and positive owner-client witnesses pass.
- **Evidence:** `runtime/browser/native-realm-witness.json`; the positive owner-bound client is in `runtime/browser/final/native-picker-witness.json`.

## 12. Out of scope (v1)

A universal capture tuple, rule engine, generic schema UI, shared store, participant
registry, polling, cross-owner push, a custom picker, permission, instruction or
concurrency settings, per-person preferences, a Review to Disposition policy writer,
Future Threads defaults, and fork patches.

## 13. Conformance kit (`/testing`, `/testing/react`)

- The kit is part of the public surface and follows this contract; it adds no protocol.
- Owner scenarios call a consumer's real registered owner through the SDK fake plugin host and observe the consumer's own storage. They never reimplement Read, Validate or Save.
- Invocation scenarios compare a consumer's native requests with the consumer's own no-override baseline. Inherit must reproduce that baseline exactly, field presence included.
- Mounted scenarios settle on the actual pending owner and catalog promises, then on a visible ready or error state. They use no fixed delays.
- Kit results are source conformance. They are never native-execution, host or provider proof.
- `/testing` is DOM-free. Only `/testing/react` uses the optional `react`, `react-dom` and `jsdom` peers.

## Issue codes (closed)

`malformed`, `choice-kind-not-allowed`, `provider-unavailable`, `provider-blocked`,
`field-not-offered`, `catalog-unavailable`, `model-unavailable`,
`selected-only-not-offered`, `reasoning-unsupported`, `service-tier-unsupported`,
`sample-route-unreadable`, `owner-fields-would-be-lost`, `conflict`.
