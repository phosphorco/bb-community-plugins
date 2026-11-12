import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  bindBbIdentity,
  type IdentityRpcHandlers,
} from "@phosphorco/bb-identity/bb";
import { GLOBAL_CATALOG } from "./contracts/catalog.ts";
import { createGlobalCatalog } from "./state/global.ts";
import { canonical } from "./contracts/hash.ts";
import { fileLocation } from "./contracts/model.ts";
import { createStore } from "./state/store.ts";
import { createFiles } from "./files/files.ts";
import { createSuiteService, savedBasis } from "./suites/runner.ts";
import { createSelectedJevTransport } from "./evaluation/shared-transport.ts";
import {createJevClient} from "@phosphorco/bb-jev/bb";
import type { TokenCounter, Transport } from "./evaluation/evaluator.ts";
import type { Run } from "./state/store.ts";
import type { AdmissionSnapshot } from "./admission/snapshot.ts";
import { createNativeAdmission } from "./admission/native.ts";
import { admissionContract } from "./admission-rpc-contract.ts";
import { contract, snapshotSchema } from "./suite-rpc-contract.ts";
export function createMessageRules(
  bb: BbPluginApi,
  options: {
    transportFor?: (run: Run) => Transport;
    admissionTransportFor?: (snapshot: AdmissionSnapshot) => Transport;
    countTokens?: TokenCounter;
    fetcher?: typeof fetch;
  } = {},
) {
  // Publish only our authoring contract. Identity's own internal RPCs retain
  // their registration policy, and all calls still use its bound handlers.
  const identityResult = bindBbIdentity({
    ...bb,
    rpc: {
      ...bb.rpc,
      register: (registered, handlers, options) =>
        bb.rpc.register(
          registered,
          handlers,
          (Object.is(registered, contract) || Object.is(registered, admissionContract))
            ? {
                ...options,
                experimental_discoverable: true,
                experimental_description:
                  "Global Message Rules authoring and saved tests. projectId is message-rules-global. Saving does not enable live message enforcement.",
              }
            : options,
        ),
    },
  });
  if (!identityResult.ok) throw Error(identityResult.error.message);
  const identity = identityResult.value;
  const settings = bb.settings.define({
    connectionSource:{type:"select",label:"JEV connection",options:["shared","dedicated"],default:"shared",description:"Shared uses the explicit Topics-owned server connection. Dedicated uses only the key below; no credential scans or fallback."},
    apiKey: {
      type: "string",
      secret: true,
      label: "Dedicated Message Rules JEV API key",
      description:
        "Optional override, used only when Dedicated Message Rules override is explicitly selected. The shared Topics key stays in Topics settings.",
    },
  });
  const store = createStore(bb.storage.database()),
    files = createFiles(bb.sdk.files, store);
  const catalog = createGlobalCatalog(store);
  async function discover(projectId: string) {
    if (projectId !== GLOBAL_CATALOG) return files.discover(projectId);
    const errors: string[] = [];
    const sources = catalog.sources();
    for (const p of sources) {
      // Imported directories stay in place and are discovered only once.
      if (
        p.id === GLOBAL_CATALOG &&
        sources.some(
          (s) =>
            s.id !== GLOBAL_CATALOG &&
            s.config.hostId === p.config.hostId &&
            s.config.root === p.config.root,
        )
      )
        continue;
      if (!p.config.hostId || !p.config.root) continue;
      try {
        await files.discover(p.id);
      } catch (e) {
        errors.push(p.id + ": " + (e instanceof Error ? e.message : String(e)));
      }
    }
    catalog.sync();
    if (errors.length) throw Error(errors.join("; "));
    return store.get(GLOBAL_CATALOG)!;
  }
  const connectionSelection=async()=>{const values=await settings.get();return {source:values.connectionSource==='dedicated'?'dedicated' as const:'shared' as const,credential:typeof values.apiKey==='string'?values.apiKey:null};};
  const sharedConnection=createJevClient(bb.sdk);
  const admission = createNativeAdmission(bb,store,options.admissionTransportFor ?? (policy=>createSelectedJevTransport(bb.sdk,policy.connection,connectionSelection,options.fetcher)),options.countTokens,()=>bb.realtime.publish("changed",{projectId:GLOBAL_CATALOG,discoverFiles:false}));
  bb.background.service("message-rules-admission-recovery",{start:signal=>admission.start(signal)});
  const service = createSuiteService(
    store,
    options.transportFor ?? (run=>createSelectedJevTransport(bb.sdk,run.frozen.config.connection,connectionSelection,options.fetcher)),
    options.countTokens,
    (input,signal)=>admission.previewPlacement(input,signal),
  );
  const publish = (projectId: string, discoverFiles = false) =>
    bb.realtime.publish("changed", { projectId, discoverFiles });
  const unsubscribe = service.subscribe(publish);
  const fileErrors = new Map<string, { location: string; message: string }>();
  async function snapshot(
    projectId: string,
    discoverFiles = false,
    requestId?: string,
    runId?: string,
  ) {
    let p = store.get(projectId);
    const location = p ? canonical(fileLocation(p.config)) : "";
    const prior = fileErrors.get(projectId);
    let readError: string | null =
      prior?.location === location ? prior.message : null;
    if (
      discoverFiles &&
      p &&
      (projectId === GLOBAL_CATALOG || (p.config.hostId && p.config.root))
    )
      try {
        p = await discover(projectId);
        const current = store.get(projectId);
        if (!current || canonical(fileLocation(current.config)) !== location)
          throw Error(
            "Test location changed during discovery. Refresh to retry.",
          );
        p = current;
        fileErrors.delete(projectId);
        readError = null;
      } catch (e) {
        p = store.get(projectId);
        readError = e instanceof Error ? e.message : String(e);
        const currentLocation = p ? canonical(fileLocation(p.config)) : "";
        if (currentLocation !== location)
          readError = "Test location changed during discovery. " + readError;
        fileErrors.set(projectId, {
          location: currentLocation,
          message: readError,
        });
      }
    const configured = await settings.get();
    let connection={configured:!!configured.apiKey,source:'dedicated',ownerPluginId:'message-rules',reason:configured.apiKey?'Dedicated key configured; authentication is established only by an observed request.':'Dedicated override selected but no key is configured.'};
    if(options.transportFor)connection={configured:false,source:'injected',ownerPluginId:'message-rules',reason:'Controlled test transport.'};
    else if(configured.connectionSource!=='dedicated'){
      try{const metadata=await sharedConnection.describe();connection={configured:metadata.configured,source:'shared',ownerPluginId:metadata.ownerPluginId,reason:metadata.configured?'Topics shared setting configured; authentication is established only by an observed request.':'Topics shared key is not configured.'};}
      catch(error){connection={configured:false,source:'shared',ownerPluginId:'jev-topics',reason:error instanceof Error?error.message:String(error)};}
    }
    const requested = requestId
      ? (store.db
          .prepare("SELECT id FROM mr_runs WHERE project_id=? AND request_id=?")
          .get(projectId, requestId) as { id: string } | undefined)
      : undefined;
    const acknowledgedRun = requested ? store.run(requested.id) : runId ? store.run(runId) : null;
    if (acknowledgedRun && acknowledgedRun.frozen.projectId !== projectId)
      throw Error("Run does not belong to this catalog.");
    return snapshotSchema.parse({
      ...(acknowledgedRun ? { acknowledgedRun } : {}),
      project: p,
      ...(projectId === GLOBAL_CATALOG ? { catalog: catalog.info() } : {}),
      basis: p ? savedBasis(p) : null,
      run: store.latest(projectId),
      readError,
      connection: {
        ...connection,
        tokenAccounting: !!options.countTokens,
        mode: options.transportFor ? "injected" : "live",
      },
      delivery: await admission.state(),
      unresolved: store.unresolved(projectId),
    });
  }
  const requireGlobal = (id: string) => {
    if (id !== GLOBAL_CATALOG)
      throw Error(
        "Catalog moved to global Message Rules. Open /plugins/message-rules/rules; legacy project catalogs are read-only.",
      );
  };
  const handlers: IdentityRpcHandlers<typeof contract> = {
    snapshot: {
      origin: "interactive-user",
      handle: async (i) => snapshot(i.projectId, i.discoverFiles, i.requestId, i.runId),
    },
    configure: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        if (!i.root.startsWith("/"))
          throw Error("Choose an absolute directory on the selected host.");
        store.configure(i.projectId, i.revision, {
          hostId: i.hostId,
          root: i.root,
          connection: i.connection,
        });
        const next = await snapshot(i.projectId, true);
        publish(i.projectId);
        return next;
      },
    },
    saveGroup: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        store.saveGroup(i.projectId, i.revision, i.group);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    deleteGroup: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        store.removeGroup(i.projectId, i.revision, i.groupId);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    saveRule: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        store.saveRule(i.projectId, i.revision, i.rule);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    deleteRule: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        store.removeRule(i.projectId, i.revision, i.ruleId);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    saveFile: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        let sourceId = i.projectId;
        if (i.projectId === GLOBAL_CATALOG) {
          const p = store.get(GLOBAL_CATALOG)!;
          const occurrence = i.occurrenceId
            ? p.occurrences.find((o) => o.occurrenceId === i.occurrenceId)
            : null;
          if (i.occurrenceId && !occurrence)
            throw Error("Test identity no longer exists.");
          sourceId =
            occurrence?.sourceProjectId ??
            catalog
              .sources()
              .find(
                (s) =>
                  s.config.hostId === i.location.hostId &&
                  s.config.root === i.location.root,
              )?.id ??
            GLOBAL_CATALOG;
          if (!occurrence && !i.groupId)
            throw Error("Select a group before adding a test.");
          if (i.groupId && !p.groups.some((g) => g.id === i.groupId))
            throw Error("Choose a saved group.");
        }
        await files.save(sourceId, i.path, i.source, i.hash, i.location);
        let savedSourceOccurrenceId: string | undefined;
        if (i.projectId === GLOBAL_CATALOG) {
          const p = await files.discover(sourceId);
          const o = p.occurrences.find((o) => o.path === i.path &&
            (!o.sourceProjectId || o.sourceProjectId === sourceId));
          if (!o) throw Error("Saved test could not be rediscovered at its source. Refresh before continuing.");
          savedSourceOccurrenceId = o.occurrenceId;
          if (i.groupId) {
            catalog.assign(sourceId, o.occurrenceId, i.groupId);
            if (sourceId === GLOBAL_CATALOG)
              store.write(sourceId, p.revision, (p) => {
                const target = p.occurrences.find(
                  (x) => x.occurrenceId === o.occurrenceId,
                )!;
                target.groupId = i.groupId;
                target.ownership = "Explicit group assignment";
                target.projectId = null;
              });
          }
          catalog.sync();
        }
        const next = await snapshot(i.projectId, true);
        publish(i.projectId);
        const saved = next.project?.occurrences.find((o) =>
          (o.sourceProjectId ?? GLOBAL_CATALOG) === sourceId &&
          (o.sourceOccurrenceId ?? o.occurrenceId) === savedSourceOccurrenceId);
        return { ...next, ...(saved ? { savedOccurrenceId: saved.occurrenceId } : {}) };
      },
    },
    toggleTest: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        if (i.projectId === GLOBAL_CATALOG) {
          const p = store.get(GLOBAL_CATALOG)!;
          if (p.revision !== i.revision)
            throw Error("Saved inputs changed. Refresh before retrying.");
          const o = p.occurrences.find(
            (o) => o.occurrenceId === i.occurrenceId,
          );
          if (!o) throw Error("Test identity no longer exists.");
          const source = store.get(o.sourceProjectId ?? GLOBAL_CATALOG)!;
          store.toggle(
            source.id,
            source.revision,
            o.sourceOccurrenceId ?? o.occurrenceId,
            i.enabled,
          );
          catalog.sync();
        } else store.toggle(i.projectId, i.revision, i.occurrenceId, i.enabled);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    assignTest: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        store.db.transaction(() => {
          const p = store.get(GLOBAL_CATALOG)!;
          if (p.revision !== i.revision)
            throw Error("Saved inputs changed. Refresh before moving a test.");
          const o = p.occurrences.find(
            (o) => o.occurrenceId === i.occurrenceId,
          );
          if (!o) throw Error("Test identity no longer exists.");
          catalog.assign(
            o.sourceProjectId ?? GLOBAL_CATALOG,
            o.sourceOccurrenceId ?? o.occurrenceId,
            i.groupId,
          );
          store.write(GLOBAL_CATALOG, p.revision, (p) => {
            const target = p.occurrences.find(
              (o) => o.occurrenceId === i.occurrenceId,
            )!;
            target.groupId = i.groupId;
            target.ownership = "Explicit group assignment";
          });
          catalog.sync();
        })();
        publish(GLOBAL_CATALOG);
        return snapshot(GLOBAL_CATALOG);
      },
    },
    startSuite: {
      origin: "interactive-user",
      handle: async (i, invocation) => {
        requireGlobal(i.projectId);
        if (i.hasRelevantDrafts)
          throw Error("Save or discard relevant drafts before Test.");
        const prior = store.db
          .prepare("SELECT id FROM mr_runs WHERE project_id=? AND request_id=?")
          .get(i.projectId, i.requestId) as { id: string } | undefined;
        if (prior) {
          const run = store.run(prior.id)!;
          service.start(i.projectId, i.requestId, i.basis, run.frozen.actor, i.selectedOccurrenceIds);
          return snapshot(i.projectId, false, i.requestId);
        }
        await discover(i.projectId);
        const actor = await invocation.person();
        if (!actor.ok) throw Error(actor.error.message);
        try {
          service.start(i.projectId, i.requestId, i.basis, actor.value.actor, i.selectedOccurrenceIds);
          publish(i.projectId);
          return snapshot(i.projectId, false, i.requestId);
        } finally {
          actor.value.dispose();
        }
      },
    },
    cancelSuite: {
      origin: "interactive-user",
      handle: async (i) => {
        requireGlobal(i.projectId);
        const run = store.run(i.runId);
        if (!run || run.frozen.projectId !== i.projectId)
          throw Error("Run does not belong to this project.");
        service.cancel(i.runId);
        return snapshot(i.projectId, false, undefined, i.runId);
      },
    },
  };
  identity.rpc.register(contract, handlers);
  const admissionHandlers: IdentityRpcHandlers<typeof admissionContract> = {
    testAdmissionState: {origin:"interactive-user",handle:async () => admission.state()},
    publishTestPolicy: {origin:"interactive-user",handle:async input => {
      const result=await admission.publishTestPolicy(input); publish(GLOBAL_CATALOG); return result;
    }},
    deactivateTestPolicy: {origin:"interactive-user",handle:async input => {
      const result=await admission.deactivateTestPolicy(input); publish(GLOBAL_CATALOG); return result;
    }},
    lookupTestPublication: {origin:"interactive-user",handle:async input => admission.lookupTestPublication(input)},
  };
  identity.rpc.register(admissionContract,admissionHandlers);
  bb.onDispose(async () => {
    unsubscribe();
    fileErrors.clear();
    await admission.dispose();
    await service.dispose();
    identity.dispose();
  });
  return { store, files, service, snapshot, admission };
}
