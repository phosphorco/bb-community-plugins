function clone(value) { return structuredClone(value); }
import { prepareExecutionReference } from "../../../../execution-contract.ts";
function createSource(fixture) {
  const state = { events: clone(fixture.events), listed: new Set(fixture.threads), missing: new Set(), nextError: null };
  return {
    append(id, event) { state.events[id].push(event); },
    rewrite(id, sequence, patch) { Object.assign(state.events[id].find((event) => event.sequence === sequence), patch); },
    omitFromList(id) { state.listed.delete(id); }, restoreToList(id) { state.listed.add(id); },
    confirmNotFound(id) { state.missing.add(id); }, failNextRead(error) { state.nextError = error; },
    read() { if (state.nextError) { state.failureCount = (state.failureCount ?? 0) + 1; const error = state.nextError; state.nextError = null; throw error; } return { events: clone(state.events), listed: new Set(state.listed), missing: new Set(state.missing) }; },
    getInjectedFailureCount() { return state.failureCount ?? 0; },
  };
}
export function controlledExtractionOperations({ fault } = {}) {
  return {
    createPublicSource: createSource,
    createPersistentStore: () => ({ rows: [], checkpoint: { generation: 0 }, coverage: null, persistenceFailureCount: 0, getInjectedWriteFailureCount() { return this.persistenceFailureCount; } }),
    createProjector: async ({ source, store, persistenceFault }) => ({
      async pull() {
        let input;
        try { input = source.read(); } catch (error) {
          if (fault === "delete-on-generic-failure") store.rows = store.rows.filter((row) => row.threadId !== "thread-201");
          throw error;
        }
        const rows = store.rows.filter((row) => fault === "ignore-404" || !input.missing.has(row.threadId));
        for (const [threadId, events] of Object.entries(input.events)) {
          if (!input.listed.has(threadId) && !store.rows.some((row) => row.threadId === threadId)) continue;
          if (input.missing.has(threadId)) continue;
          for (const event of events) {
            const index = rows.findIndex((row) => row.threadId === threadId && row.sequence === event.sequence);
            const row = { threadId, sequence: event.sequence, value: event.value };
            if (index < 0) rows.push(row); else rows[index] = row;
          }
        }
        if (fault === "drop-201st-thread") rows.splice(rows.findIndex((row) => row.threadId === "thread-201"), 1);
        if (fault === "drop-501st-event") rows.splice(rows.findIndex((row) => row.threadId === "thread-1" && row.sequence === 501), 1);
        if (fault === "ignore-append") { const i = rows.findIndex((row) => row.sequence === 502); if (i >= 0) rows.splice(i, 1); }
        if (fault === "ignore-rewrite") { const row = rows.find((item) => item.threadId === "thread-201"); if (row) row.value = "thread-201-v1"; }
        if (fault === "delete-on-omission" && !input.listed.has("thread-201")) { const i = rows.findIndex((row) => row.threadId === "thread-201"); if (i >= 0) rows.splice(i, 1); }
        if (persistenceFault === "before-publication") { store.persistenceFailureCount += 1; throw new Error("injected before publication"); }
        if (persistenceFault === "after-rows-before-checkpoint") { store.persistenceFailureCount += 1; if (fault === "partial-publication") store.rows = rows; throw new Error("injected after rows"); }
        store.rows = rows;
        store.checkpoint = { generation: store.checkpoint.generation + 1 };
        store.coverage = { mode: fault === "dishonest-coverage" ? "complete-retained-projection" : "partial-retained-projection", incompleteReasons: fault === "dishonest-coverage" ? [] : ["backfill-in-progress"], earliestVerifiedRetainedInclusiveMs: 1_700_000_000_000 };
      },
      async readPublishedSnapshot() { return { rows: clone(store.rows), checkpoint: clone(store.checkpoint), coverage: clone(store.coverage) }; },
      async dispose() {},
    }),
  };
}

// Remaining operation-level doubles are intentionally added with their suites.
export function controlledReferenceOperations({ fault } = {}) {
  return {
    createRepository: () => {
      const state = { executions: new Map(), references: new Map(), currentBundle: null, expired: new Set() };
      return {
        state,
        async saveExecution(record) { state.executions.set(record.result.executionId, structuredClone(record)); },
        async replaceCurrentBundle(bundle) { state.currentBundle = structuredClone(bundle); },
        async expireExecution(id) { state.expired.add(id); },
      };
    },
    admissionFor: (scopeKey) => ({ kind: "admitted", model: "shared-high-trust-equal-information", sourceScope: { scopeKey, projection: "tool_execution_fact_v1", storage: "plugin-owned-sqlite" } }),
    createReferenceService: ({ repository, admission }) => ({
      async create(request) {
        const record = repository.state.executions.get(request.executionId);
        if (!record) return fault === "accept-forged" ? { kind: "prepared", capsule: {} } : { kind: "error", error: { code: "record-expired" } };
        const { nowMs, ...locator } = request;
        const effectiveAdmission = fault === "accept-scope" ? { ...admission, sourceScope: record.snapshot.sourceScope } : admission;
        const effectiveLocator = fault === "accept-datum" ? { ...locator, targetDatumKey: record.result.result.datumKeys[0] } : locator;
        let result = prepareExecutionReference({ admission: effectiveAdmission, lookup: { kind: "found", record }, locator: effectiveLocator, nowMs, issuedReferenceId: "analytics-ref_abcdefghijklmnop" });
        if (result.kind === "prepared" && fault === "wrong-row") result = { ...result, capsule: { ...result.capsule, capturedSelectedRow: { ...result.capsule.capturedSelectedRow, failures: 99 } } };
        if (result.kind === "prepared" && fault === "wrong-sql") result = { ...result, capsule: { ...result.capsule, definition: { ...result.capsule.definition, query: { ...result.capsule.definition.query, sql: "SELECT 1" } } } };
        if (result.kind === "prepared") repository.state.references.set(result.capsule.token, structuredClone(result.capsule));
        return result;
      },
      async resolve({ token }) {
        const capsule = repository.state.references.get(token);
        if (!capsule || fault === "expire-capsule") return { kind: "error", error: { code: "record-expired" } };
        if (fault === "mutable-resolution" && repository.state.currentBundle) return { kind: "prepared", capsule: { ...capsule, definition: { ...capsule.definition, bundle: repository.state.currentBundle } } };
        return { kind: "prepared", capsule: structuredClone(capsule) };
      },
    }),
  };
}

export function controlledMigrationOperations({ fault } = {}) {
  return {
    async createSyntheticPersistentStore(seed) { return structuredClone(seed); },
    async runMigration({ persistent }) {
      persistent.priorStore.schemaVersion = persistent.priorStore.migrationSql.length;
      persistent.migrated = {
        store: structuredClone(persistent.priorStore),
        bundle: fault === "rewrite-bundle" ? { ...persistent.legacyBundle, title: "rewritten" } : structuredClone(persistent.legacyBundle),
        reference: { version: 1, retroverified: fault === "retroverify-reference", capsule: structuredClone(persistent.legacyReference) },
      };
      if (fault === "drop-fact") persistent.migrated.store.rows.tool_execution_facts_v1 = [];
    },
    async reconstructAndRead({ persistent }) {
      if (fault === "non-idempotent-reconstruct") persistent.migrated.store.schemaVersion += 1;
      const result = structuredClone(persistent.migrated);
      return result;
    },
    async readPackageManifest() { return fault === "bad-manifest" ? { name: "wrong", dependencies: {} } : { name: "@phosphorco/bb-plugin-analytics", dependencies: { "@duckdb/duckdb-wasm": "1.33.1-dev57.0" } }; },
  };
}
