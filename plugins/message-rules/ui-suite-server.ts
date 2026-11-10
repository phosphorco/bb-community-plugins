import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  bindBbIdentity,
  type IdentityRpcHandlers,
} from "@phosphorco/bb-identity/bb";
import { canonical } from "./contracts/hash.ts";
import { fileLocation } from "./contracts/model.ts";
import { createStore } from "./state/store.ts";
import { createFiles } from "./files/files.ts";
import { createSuiteService, savedBasis } from "./suites/runner.ts";
import { createHttpTransport } from "./evaluation/transport.ts";
import type { TokenCounter, Transport } from "./evaluation/evaluator.ts";
import type { Run } from "./state/store.ts";
import { contract, snapshotSchema } from "./suite-rpc-contract.ts";
export function createMessageRules(
  bb: BbPluginApi,
  options: {
    transportFor?: (run: Run) => Transport;
    countTokens?: TokenCounter;
    fetcher?: typeof fetch;
  } = {},
) {
  const identityResult = bindBbIdentity(bb);
  if (!identityResult.ok) throw Error(identityResult.error.message);
  const identity = identityResult.value;
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      secret: true,
      label: "Message Rules JEV API key",
      description:
        "Used only by Message Rules. No ambient or other-plugin credential fallback.",
    },
  });
  const store = createStore(bb.storage.database()),
    files = createFiles(bb.sdk.files, store);
  const service = createSuiteService(
    store,
    options.transportFor ??
      ((r) =>
        createHttpTransport(
          r.frozen.config.connection,
          async () => {
            const values = await settings.get();
            return typeof values.apiKey === "string" ? values.apiKey : null;
          },
          options.fetcher,
        )),
    options.countTokens,
  );
  const publish = (projectId: string, discoverFiles = false) =>
    bb.realtime.publish("changed", { projectId, discoverFiles });
  const unsubscribe = service.subscribe(publish);
  const fileErrors = new Map<string, { location: string; message: string }>();
  async function snapshot(projectId: string, discoverFiles = false) {
    let p = store.get(projectId);
    const location = p ? canonical(fileLocation(p.config)) : "";
    const prior = fileErrors.get(projectId);
    let readError: string | null =
      prior?.location === location ? prior.message : null;
    if (discoverFiles && p?.config.hostId && p.config.root)
      try {
        p = await files.discover(projectId);
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
    return snapshotSchema.parse({
      project: p,
      basis: p ? savedBasis(p) : null,
      run: store.latest(projectId),
      readError,
      connection: {
        configured: !!configured.apiKey,
        tokenAccounting: !!options.countTokens,
        mode: options.transportFor ? "injected" : "live",
      },
      delivery: {
        state: "capability-blocked",
        reason:
          "Full original mixed-sender delivery and safe separation are unproved. Queue hooks are not registered.",
      },
      unresolved: store.unresolved(projectId),
    });
  }
  const handlers: IdentityRpcHandlers<typeof contract> = {
    snapshot: {
      origin: "interactive-user",
      handle: async (i) => snapshot(i.projectId, i.discoverFiles),
    },
    configure: {
      origin: "interactive-user",
      handle: async (i) => {
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
        store.saveGroup(i.projectId, i.revision, i.group);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    deleteGroup: {
      origin: "interactive-user",
      handle: async (i) => {
        store.removeGroup(i.projectId, i.revision, i.groupId);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    saveRule: {
      origin: "interactive-user",
      handle: async (i) => {
        store.saveRule(i.projectId, i.revision, i.rule);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    deleteRule: {
      origin: "interactive-user",
      handle: async (i) => {
        store.removeRule(i.projectId, i.revision, i.ruleId);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    saveFile: {
      origin: "interactive-user",
      handle: async (i) => {
        await files.save(i.projectId, i.path, i.source, i.hash, i.location);
        const next = await snapshot(i.projectId, true);
        publish(i.projectId);
        return next;
      },
    },
    toggleTest: {
      origin: "interactive-user",
      handle: async (i) => {
        store.toggle(i.projectId, i.revision, i.occurrenceId, i.enabled);
        publish(i.projectId);
        return snapshot(i.projectId);
      },
    },
    startSuite: {
      origin: "interactive-user",
      handle: async (i, invocation) => {
        if (i.hasRelevantDrafts)
          throw Error("Save or discard relevant drafts before Test.");
        await files.discover(i.projectId);
        const actor = await invocation.person();
        if (!actor.ok) throw Error(actor.error.message);
        try {
          service.start(i.projectId, i.requestId, i.basis, actor.value.actor);
          publish(i.projectId);
          return snapshot(i.projectId);
        } finally {
          actor.value.dispose();
        }
      },
    },
    cancelSuite: {
      origin: "interactive-user",
      handle: async (i) => {
        const run = store.run(i.runId);
        if (!run || run.frozen.projectId !== i.projectId)
          throw Error("Run does not belong to this project.");
        service.cancel(i.runId);
        return snapshot(i.projectId);
      },
    },
  };
  identity.rpc.register(contract, handlers);
  bb.onDispose(async () => {
    unsubscribe();
    fileErrors.clear();
    await service.dispose();
    identity.dispose();
  });
  return { store, files, service, snapshot };
}
