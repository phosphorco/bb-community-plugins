import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  canonicalizeResource,
  CROSS_REFERENCES_PLUGIN_ID,
  getProjectionResponseSchema,
  isExactBbThreadResource,
  machineMonitorResource,
  MACHINE_MONITOR_PRODUCER_ID,
  projectionPayloadDigest,
  projectionResponseSchema,
  type AttachmentError,
  type ProjectionResponse,
} from "./attachment-contract.ts";
import { MachineMonitorReferenceStore, type ClaimedProjection } from "./store.ts";

export const REFERENCE_LEASE_MS = 75_000;

type SdkErrorShape = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
};

function errorShape(value: unknown): SdkErrorShape {
  return typeof value === "object" && value !== null ? value as SdkErrorShape : {};
}

function abortError(): Error {
  const error = new Error("Machine Monitor reference delivery aborted.");
  error.name = "AbortError";
  return error;
}

/** The installed SDK has no PluginRpcArgs.signal, so make the service wait abort-aware locally. */
function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    });
  });
}

function isValidMachineMonitorProjection(projection: {
  producerPluginId: string;
  source: { provider: string; keys: Record<string, string>; presentation: { label: string; detail?: string; url?: string } };
  payloadDigest: string;
  tombstone: boolean;
  targets: Array<{ provider: string; keys: Record<string, string>; presentation: { label: string; detail?: string; url?: string } }>;
}): boolean {
  try {
    const source = canonicalizeResource(projection.source);
    const expectedSource = canonicalizeResource(machineMonitorResource());
    const targets = projection.targets.map(canonicalizeResource);
    const targetIdentities = new Set<string>();
    for (const target of targets) {
      if (!isExactBbThreadResource(target) || targetIdentities.has(target.canonicalIdentityJson)) return false;
      targetIdentities.add(target.canonicalIdentityJson);
    }
    if (projection.tombstone && targets.length !== 0) return false;
    return projection.producerPluginId === MACHINE_MONITOR_PRODUCER_ID
      && source.canonicalIdentityJson === expectedSource.canonicalIdentityJson
      && projectionPayloadDigest(MACHINE_MONITOR_PRODUCER_ID, source, projection.tombstone, targets) === projection.payloadDigest;
  } catch {
    return false;
  }
}

/** Classify only structured SDK fields; transport text is never a protocol. */
export function classifyCrossReferencesError(cause: unknown): AttachmentError {
  const shape = errorShape(cause);
  const name = typeof shape.name === "string" ? shape.name : null;
  const code = typeof shape.code === "string" ? shape.code : null;
  const status = typeof shape.status === "number" && Number.isSafeInteger(shape.status) ? shape.status : null;
  const message = cause instanceof Error ? cause.message : typeof shape.message === "string" ? shape.message : String(cause);

  if (name === "AbortError" || name === "BbRequestAbortedError") return { kind: "aborted", code, status, message };
  if (name === "BbRequestTimeoutError" || code === "timeout" || code === "request_timeout") return { kind: "transient", code, status, message };
  if (code === "unknown_method") return { kind: "incompatible", code, status, message };
  if (code === "plugin_not_found" || code === "plugin_missing" || code === "missing_plugin") return { kind: "absent", code, status, message };
  if (name === "ZodError" || name === "BbRpcValidationError" || code === "invalid_json" || code === "invalid_input" || code === "invalid_output" || code === "non_json_result") return { kind: "blocked", code, status, message };
  if (code === "handler_error") return { kind: status != null && status >= 500 ? "transient" : "blocked", code, status, message };
  if (code === "plugin_disabled" || code === "plugin_stopped" || code === "plugin_unavailable" || code === "plugin_not_running" || code === "not_running" || code === "plugin_not_installed") return { kind: "absent", code, status, message };
  if (status === 404) return { kind: "absent", code, status, message };
  if (status === 401 || status === 403 || (status != null && status >= 400 && status < 500 && status !== 408 && status !== 429)) return { kind: "blocked", code, status, message };
  if (status === 408 || status === 429 || (status != null && status >= 500)) return { kind: "transient", code, status, message };
  if (code !== null) return { kind: "blocked", code, status, message };
  return { kind: "transient", code, status, message };
}

function waitForWake(
  signal: AbortSignal,
  deadline: number | null,
  addWaiter: (wake: () => void) => void,
  removeWaiter: (wake: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => finish();
    const abort = () => finish();
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      removeWaiter(wake);
      resolve();
    };
    if (signal.aborted || (deadline != null && deadline <= Date.now())) {
      finish();
      return;
    }
    addWaiter(wake);
    signal.addEventListener("abort", abort, { once: true });
    if (deadline != null) timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
  });
}

export type ReferenceDeliveryResult = "ignored" | "acknowledged" | "rebased" | "blocked" | "failed";

export class MachineMonitorReferenceDelivery {
  private readonly waiters = new Set<() => void>();
  private readonly bb: BbPluginApi;
  private readonly store: MachineMonitorReferenceStore;

  constructor(bb: BbPluginApi, store: MachineMonitorReferenceStore) {
    this.bb = bb;
    this.store = store;
  }

  wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private async callProjection(command: ClaimedProjection["command"]): Promise<ProjectionResponse> {
    return await this.bb.sdk.plugins.callRpc({
      pluginId: CROSS_REFERENCES_PLUGIN_ID,
      method: "applyProjection",
      input: command,
      outputSchema: projectionResponseSchema,
    });
  }

  private async reconcile(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    try {
      const response = await awaitWithAbort(this.bb.sdk.plugins.callRpc({
        pluginId: CROSS_REFERENCES_PLUGIN_ID,
        method: "getProjection",
        input: {
          producerPluginId: MACHINE_MONITOR_PRODUCER_ID,
          source: { provider: "bb", keys: machineMonitorResource().keys },
        },
        outputSchema: getProjectionResponseSchema,
      }), signal);
      if (signal.aborted) return;
      const projection = response.projection;
      if (projection != null && !isValidMachineMonitorProjection(projection)) {
        this.store.recordReconciliationFailure({
          kind: "blocked",
          code: "invalid_projection",
          status: null,
          message: "Cross References returned an invalid Machine Monitor projection.",
        });
        return;
      }
      this.store.reconcileRemote(projection == null ? null : {
        revision: projection.revision,
        payloadDigest: projection.payloadDigest,
      });
    } catch (cause) {
      if (signal.aborted) return;
      this.store.recordReconciliationFailure(classifyCrossReferencesError(cause));
    }
  }

  private async deliverOnce(claimed: ClaimedProjection, signal: AbortSignal): Promise<ReferenceDeliveryResult> {
    try {
      const response = await awaitWithAbort(this.callProjection(claimed.command), signal);
      // callRpc has no signal in the installed SDK contract. The response may
      // still arrive after service shutdown; it must not acknowledge anything.
      if (signal.aborted) return "ignored";
      return this.store.recordResponse(claimed, response);
    } catch (cause) {
      if (signal.aborted) return "ignored";
      this.store.recordFailure(claimed, classifyCrossReferencesError(cause));
      return "failed";
    }
  }

  async start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.store.recoverInFlightForRestart(Date.now());
    await this.reconcile(signal);
    while (!signal.aborted) {
      const claimed = this.store.claimDue(Date.now(), REFERENCE_LEASE_MS);
      if (claimed != null) {
        await this.deliverOnce(claimed, signal);
        continue;
      }
      const deadline = this.store.nextWakeAt(Date.now());
      await waitForWake(signal, deadline, (wake) => this.waiters.add(wake), (wake) => this.waiters.delete(wake));
    }
  }
}
