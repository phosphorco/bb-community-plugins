# Integration-boundaries design receipt

Status: bounded implementation draft. The browser transport is the supported
local-auth JSON POST route; the additive RPC remains the agent/programmatic
surface. This receipt does not authorize server/app/service/runtime/store or
dependency edits outside the listed integration-boundaries grant.

This receipt records the composition boundary selected by the parent after the
`carry-forward-review` pass. It preserves the existing execution schemas,
runner bounds, legacy reference method, and query-runtime ownership.

## Locked operation boundary

The host owns admission, snapshot metadata, immutable record persistence, and
reference issuance. The locked child owns SQL reparsing/admission and fact-row
materialization. A caller supplies a locator and typed values, never SQL,
source scope, coverage, rows, cacheability, admission attestations, or a
result/report assertion.

The operation shape is per-query. There is no new bundle batch API. The same
payload is used by the selected local-auth browser HTTP POST and the additive
agent/programmatic `executionRpcContract`; the legacy `rpcContract` remains
unchanged until its existing handlers can be cut over:

```ts
type ExecuteQueryInput = ExecutionLocator;
// Exactly executionLocatorSchema:
// {
//   bundleId: identifier;
//   queryId: identifier;
//   range: utcRangeSchema;
//   parameters: boundParameterSchema[];
// }

type ExecuteQueryOutput =
  | {
      kind: "success";
      result: ExecutionResult;
      definition: ExecutionDefinition;
    }
  | { kind: "error"; error: ExecutionError };
```

`ExecuteQueryOutput.success.result` is the existing `executionResultSchema`.
It already carries the execution ID, resolved authoritative query and
snapshot, coverage, typed canonical columns/rows/datum keys, extent and
truncation, timing, and physical-cache status. `success.definition` is the
same validated per-query definition persisted in the immutable execution
record: its bundle snapshot, admitted query, and captured figures. The paired
response schema cross-validates execution ID, bundle identity, admitted query,
referenced result columns, and plotted count/extent/reduction. The host
validates the complete pair before returning it. Shared physical reuse remains
an implementation of the existing coordinator, not a new UI-visible batch
contract.

Reference creation is additive and retains the current v1 method until
`complete-workflow-cutover`. Its payload remains transport-neutral:

```ts
type CreateExecutionReferenceInput = {
  executionId: ExecutionId;
  visualizationId: Identifier;
  targetDatumKey?: DatumKey;
};

type CreateExecutionReferenceOutput = {
  id: ReferenceId;
  token: `analytics-ref:v2:${string}`;
  label: string; // bounded UTF-8 text
  expiresAtMs: number; // safe integer, bounded reference TTL
};
```

The input is exactly `createExecutionReferenceRequestSchema`. After fresh
host admission, the service looks up a retained immutable execution record,
calls the pure
`prepareExecutionReference()` seam, and persists the resulting self-contained
v2 capsule. Bundle edits, current mutable query state, client rows, and client
selection context cannot change the capsule. The v1 read path remains explicit
through `decodeLegacyStoredReferenceCapsule()` and is never relabeled as v2.

The direct host/service operation used by the Node `host-execution` suite and
later server composition is intentionally narrower than a public RPC handler.
The singleton service never stores ambient identity. Each call receives a
host-created internal context, separate from the JSON locator/reference input:

```ts
type InternalInvocationContext = {
  invocation: BbInvocation; // public @phosphorco/bb-identity/bb type
  requestSignal?: AbortSignal; // raw HTTP request signal when present
  invocationId: string; // host-created, per invocation
};

type ExecutionInvocationContext = InternalInvocationContext & {
  subscriberId: string; // host-created, distinct per coordinator subscriber
};

type AdmittedInvocation<T extends InternalInvocationContext> = T & {
  admission: Extract<HostAdmission, { kind: "admitted" }>;
};

interface AnalyticsExecutionService {
  execute(
    invocation: ExecutionInvocationContext,
    locator: ExecutionLocator,
  ): Promise<ExecutionWorkerOutcome>;
  createExecutionReference(
    invocation: InternalInvocationContext,
    input: CreateExecutionReferenceInput,
    nowMs: number,
  ): Promise<CreateExecutionReferenceOutput>;
  resolveReference(
    invocation: InternalInvocationContext,
    referenceId: ReferenceId,
    nowMs: number,
  ): Promise<ReferencePreparationOutcome>;
}
```

The service first turns the internal context into an `AdmittedInvocation` via
the public `bindBbIdentity(bb)`/`BbIdentityBinding` boundary. That handle is
passed to every authoritative lookup and operation; it is never constructed
from caller JSON and never retained as singleton state. `execute`,
`createExecutionReference`, and `resolveReference` all use this same
per-invocation admission path.

The execution lifecycle combines the package-issued `invocation.signal`, the
raw HTTP `requestSignal` when present, and the host service deadline into the
one subscriber signal passed to admission/coordinator. The HTTP binding owns
response-body completion and release; the service must observe that signal and
must not add a second response-body owner. The RPC path has no raw request
signal and uses the package invocation signal plus the host deadline.

## Host execution sequence

The ordinary host operation has one authoritative path:

1. Validate the locator shape and accept a host-created internal invocation
   context. Do not read a saved bundle, query, figure, or execution record at
   this stage. The caller still provides only typed locator values,
   visualization IDs, and optional datum keys.
2. Ask the host identity boundary to admit that invocation. A configured
   identity failure is an explicit denial; there is no feature-local tenant or
   default-person fallback. The singleton service passes the resulting
   per-invocation admitted handle down the rest of the operation.
3. Only after admission, resolve the bundle and query by the locator. Derive
   the host source scope, cacheability, SQL, query revision, max rows, and
   immutable figure captures from the saved authoritative bundle. No saved
   definition is returned before this admission step.
4. Create one paired snapshot and trusted source handoff from one readonly
   SQLite metadata transaction:

   ```ts
   type PairedSnapshot = {
     snapshot: ExecutionSnapshot;
     source: TrustedSourceHandoff;
   };

   createPairedSnapshot(input: {
     sourceScope: SourceScope;
     range: UtcRange;
   }): Promise<PairedSnapshot>;
   ```

   The host transaction reads index/coverage metadata only. The same active
   publication, generation, coverage/as-of values, and positive
   `factProjectionVersion` identify both halves. It does not move fact-row
   materialization into the host; the child reads facts through the trusted
   handoff. The accepted `ExecutionSnapshotProvider.createSnapshot()` return
   signature remains unchanged; this paired operation is an internal
   composition seam.
5. Call the locked child `admitQuery` with the exact authoritative SQL,
   parameters, and cacheability. Copy and assert all five attestation fields
   before constructing `ResolvedExecution`.
6. Execute every host, UI, and agent request through the same owned runtime and
   `SharedExecutionCoordinator.subscribe()` entrypoint, using the separate
   `subscriberId` and signal from that invocation context. The runtime may
   physically reuse stable work, but every logical execution gets its own
   immutable execution ID and result-scoped datum keys. `IsolatedExecutionWorker`
   remains a private runtime implementation behind the coordinator; there is no
   direct-worker bypass for a host lane.
7. Build the complete `StoredExecutionRecord` from the authoritative bundle,
   query, paired snapshot, canonical result, and validated figure contexts.
   Validate and persist one record before returning success; return that same
   validated record `result` and `definition` pair. Keep it independently of
   runtime cache eviction. No second mutable bundle lookup may supply the
   response definition.

Reference creation and resolution use the same internal invocation context and
admission-first rule: admit the caller, then look up the execution/reference
record and return only an authorized retained result. No reference operation
resolves or returns saved definitions before fresh admission.

No step accepts an authored query result, pass flag, report adapter, database
path, identity claim, or claimed coverage from the caller.

The definition handoff is per-query: every captured figure consumes the one
admitted query in that definition. It is sufficient authority for historical
figure rendering, menus, exports, and reference creation after bundle edits.
It is not a whole-dashboard historical layout snapshot; the UI may retain the
current bundle layout for placement only and must not use it as authority for
captured query or figure content.

## Expiry and reference authority

Execution records and references are separate durable authorities with their
own contract-governed expiry and pruning. Evicting an execution record from a
runtime cache must not delete an unexpired reference capsule. A reference may
outlive its execution record because its capsule is self-contained; an expired
execution record cannot create a new reference. Both creation and resolution
perform fresh host admission, and resolution never substitutes the current
bundle or snapshot for captured historical context.

The repository boundary therefore has two explicit read paths:

- v2 execution records and v2 capsules, each schema-validated before storage
  and after retrieval;
- legacy v1 capsules, decoded as unverified `legacy-client-lineage` with
  `retroverified: false`.

Cleanup/disposal is host-owned and must not be smuggled into query execution or
the browser adapter. Its concrete operation and migration remain an
implementation decision after the frozen run.

## Selected transport and lifecycle

The public browser RPC surface does not currently support caller cancellation.
The source evidence is:

- `fork/build/bb/packages/plugin-sdk/src/app-contract.ts:1278-1290` defines
  `PluginRpcClient.call(method, ...args)` with method/input only and a Promise.
- `community-plugins/plugins/analytics/types/bb-plugin-sdk-app.d.ts:1457-1464`
  exposes the same public shape; `PluginRpcCallArgs` is input-only.
- `fork/build/bb/apps/app/src/lib/plugin-sdk-hooks.ts:149-163` implements the
  RPC POST without a `signal` in its fetch options.
- `fork/build/bb/apps/server/src/routes/plugins.ts:676-687` forwards only the
  principal and principal key to the RPC dispatcher. The public
  `P6rPluginRequestContext` contains only those identity fields, and
  `fork/build/bb/apps/server/src/services/plugins/plugin-service.ts:2064-2083`
  forwards that context to the handler without the request signal.

Therefore an app `AbortController` on the RPC path may sequence-fence and
ignore a stale `executeQuery` response, but it must not be documented as
releasing server work. Sequence fencing is a UI state rule; it is not
subscriber detachment, worker cancellation, or resource release. The additive
RPC is retained for agents/programmatic callers and owns a bounded deadline;
it makes no caller-abort promise.

The selected browser transport is the supported plugin HTTP surface:

- `PluginHttp.route()` is public and mounts
  `/api/v1/plugins/<id>/http/<path>`. Its local-auth mode requires a local BB
  origin, and JSON POSTs use the normal content-type rule
  (`fork/build/bb/packages/plugin-sdk/src/backend-contract.ts:190-208`).
- `PluginHttpHandler` receives the Hono `Context` and the same public identity
  request context containing the principal and principal key
  (`backend-contract.ts:177-188`). The route dispatcher preserves that context
  when it invokes the plugin (`fork/build/bb/apps/server/src/routes/plugins.ts:593-619`;
  `fork/build/bb/apps/server/src/services/plugins/plugin-service.ts:2040-2054`).
- The original Context exposes `context.req.raw.signal` to the route handler;
  the existing Analytics `/facts.ndjson` route already receives that Context
  (`community-plugins/plugins/analytics/server.ts:358-381`). This is evidence
  for request-signal transport, not permission to reuse the facts route or move
  fact materialization into the host.

The HTTP handler exposes the same locator-only `executeQuery` payload, passes
both `context.req.raw.signal` and the package-issued `BbInvocation.signal` to
the same `AnalyticsExecutionService.execute()` seam, combines both with the
service deadline, and propagates the composed signal to admission and the
coordinator subscriber. Source inspection of pinned `@hono/node-server`
1.19.14 supports the candidate chain that an outgoing close aborts the
materialized `Request.signal` before `writableFinished`; it is not a real
disconnect witness. The pending composition/vertical proof must demonstrate:

`POST socket disconnect -> raw request abort -> subscriber detach -> last
subscriber worker stop`,

while an independent shared agent survives, superseded subscribers detach,
and identity cleanup runs exactly once. Baseline package response-body
lifetime remains package-owned as specified; enhanced-core `scope.release`
availability and cleanup are not proven by the normal source and cannot be
accepted as a blanket substitute. No explicit release or lease API is added
now; revisit only if those real transport proofs fail.

## Disjoint acceptance routing

The acceptance whitelist now includes the new `host-execution` and
`vertical-slice` suite paths alongside the existing suite-specific modules.
Their implementation modules are intentionally still absent: an exact absent
module produces a blocked outcome, while a present module with an
import/protocol defect fails. No module may report a synthetic pass or hand the
runner an assertion/report adapter.

The ownership split is:

| Lane | Binding and responsibility |
| --- | --- |
| `host-execution` | Node/service suite with a direct real-operation binding. It does not import or depend on browser/production-binding. |
| `vertical-slice` | Integrated browser suite; its binding is routed through the browser production dispatcher and calls the actual dashboard/host composition. |
| `ui`, `composition`, `end-to-end`, `performance` | Existing browser suites, each retaining a separate suite-specific binding module behind the production dispatcher as applicable. |
| `extraction`, `references`, `migration-packaging` | Component suites using separate test-owned `suites/data/bindings/<name>.mjs` modules. They do not route through the browser dispatcher. |
| `query-runtime` | Existing child/runtime binding, independent of both browser and component bindings. |

`browser/production-binding.mjs` is only a thin whitelist dispatcher for the
actual browser lanes. It imports the selected suite module and delegates
production operations; the acceptance binding applies bounded source
fingerprints. Neither layer owns assertions, expected rows, query fixtures, or
pass/report adapters. Component bindings use the existing
absent-versus-import-defect distinction in `suites/data/common.mjs`.

## Held implementation surface and proof

This bounded artifact preparation adds only the additive execution schemas and
test-suite routing in the integration-boundaries grant. It intentionally does
not edit server.ts, app.tsx, a host service, the store, query runtime, package
manifests, fixtures, or future suite/binding modules. The concrete public
`@phosphorco/bb-identity` dependency and `bindBbIdentity(bb)` composition are
later host/composition prerequisites; local source availability is not treated
as installed-artifact proof.

The future proof remains real operation evidence: authoritative per-invocation
admission, same-publication snapshot metadata, child-owned fact materialization,
schema-validated immutable persistence, v2 reference resolution after bundle
edits, HTTP disconnect-to-subscriber detach, shared-agent survival,
supersession, disposal, and disjoint nonpassing behavior for absent or
defective suite modules.
