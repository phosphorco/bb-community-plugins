import type { BbPluginApi, JsonValue, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import {
  LIMITS, PEOPLE_ACCOUNTS_PLUGIN_ID, RPC_METHODS,
  credentialInputSchema, credentialResultSchema,
  resolutionOutcomeV1Schema, resolveInputSchema, resolveResultSchema,
  rosterInputSchema, rosterResultSchema, rosterRowV1Schema, summarizeAttribution, tokenSchema,
  unavailableAttribution, utf8ByteLength,
  type AttributionV1, type CredentialResult, type PersonSummaryV1, type ResolutionOutcomeV1, type ResolutionV1,
  type ResolveRequest, type ResolveResult, type RosterResult, type RosterRowV1,
} from "./index.js";

export type PeopleAccountsSdk = Pick<BbPluginApi["sdk"], "plugins"> | Pick<PluginBrowserBbSdk, "plugins">;

/** Closed transport and contract failure kinds; malformed installed contracts are surfaced. */
export type CallErrorKind = "absent" | "disabled" | "timeout" | "malformed" | "cancelled" | "failed";

/**
 * Carries only a kind and a fixed message. The transport error is deliberately
 * not retained as `cause`: its text may include request or response bodies.
 */
export class PeopleAccountsCallError extends Error {
  readonly kind: CallErrorKind;
  constructor(kind: CallErrorKind, message: string) {
    super(message);
    this.name = "PeopleAccountsCallError";
    this.kind = kind;
  }
}

/**
 * Map a transport error to a kind. Only the code and status are read; messages
 * are not echoed, so a failing credential call cannot leak anything into text.
 */
export function classifyCallError(error: unknown): CallErrorKind {
  if (error instanceof PeopleAccountsCallError) return error.kind;
  const e = error as { name?: unknown; status?: unknown; code?: unknown; body?: unknown } | null;
  if (e?.name === "AbortError") return "cancelled";
  if (e?.name === "TimeoutError" || e?.code === "timeout") return "timeout";
  if (e?.name === "ZodError") return "malformed";
  const body = e?.body as { error?: { code?: unknown } } | null | undefined;
  const code = typeof body?.error?.code === "string" ? body.error.code : e?.code;
  if (code === "unknown_method") return "malformed";
  if (code === "plugin_not_found" || code === "unknown_plugin") return "absent";
  if (code === "plugin_disabled" || code === "plugin_not_running" || e?.status === 503) return "disabled";
  if (code === "invalid_input" || code === "invalid_output") return "malformed";
  if (e?.status === 404) return "absent";
  return "failed";
}

export interface PeopleAccountsClient {
  readonly pluginId: string;
  resolve(request: ResolveRequest, signal?: AbortSignal): Promise<ResolveResult>;
  roster(signal?: AbortSignal): Promise<RosterResult>;
  /**
   * Trusted backend integration only: returns the operator's bot token.
   * Call from a plugin server, never render or log the result.
   */
  credential(botLogin: string, signal?: AbortSignal): Promise<CredentialResult>;
}

export interface PeopleAccountsClientOptions {
  /** Budgets may only lower the published upper bounds. */
  callMs?: number;
}

function budget(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new RangeError(`Budget must be > 0 and <= ${maximum}.`);
  return value;
}

/** Explicit target; no hooks, storage, listing, caching, retry or singleton. */
export function createPeopleAccountsClient(
  sdk: PeopleAccountsSdk,
  targetPluginId: string = PEOPLE_ACCOUNTS_PLUGIN_ID,
  options: PeopleAccountsClientOptions = {},
): PeopleAccountsClient {
  const pluginId = z.string().min(1).max(256).parse(targetPluginId);
  const callMs = budget(options.callMs, LIMITS.callMs);

  async function call<T>(method: string, input: unknown, inputSchema: z.ZodType, outputSchema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const parsedInput = inputSchema.parse(input);
    if (signal?.aborted) throw new PeopleAccountsCallError("cancelled", `${method} was cancelled`);
    const controller = new AbortController();
    let rejectCancellation: (reason: unknown) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const abort = () => {
      rejectCancellation(new PeopleAccountsCallError("cancelled", `${method} was cancelled`));
      controller.abort(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      rejectCancellation(new PeopleAccountsCallError("timeout", `${method} timed out`));
      controller.abort();
    }, callMs);
    let value: unknown;
    try {
      value = await Promise.race([
        sdk.plugins.callRpc({ pluginId, method, input: parsedInput as JsonValue, outputSchema: z.unknown(), signal: controller.signal }),
        cancelled,
      ]);
    } catch (error) {
      if (error instanceof PeopleAccountsCallError) throw error;
      throw new PeopleAccountsCallError(classifyCallError(error), `${method} failed`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    const json = JSON.stringify(value);
    if (json === undefined || utf8ByteLength(json) > LIMITS.responseBytes) throw new PeopleAccountsCallError("malformed", `${method} result exceeds its byte limit or is not JSON`);
    const parsed = outputSchema.safeParse(value);
    if (!parsed.success) throw new PeopleAccountsCallError("malformed", `${method} result does not match the contract`);
    return parsed.data;
  }

  return {
    pluginId,
    async resolve(request, signal) {
      const result = await call(RPC_METHODS.resolve, { version: 1, ...request }, resolveInputSchema, resolveResultSchema, signal);
      if (result.results.length !== request.inputs.length || result.results.some((r, i) => r.input !== request.inputs[i])) {
        throw new PeopleAccountsCallError("malformed", `${RPC_METHODS.resolve} results do not echo the requested inputs in order`);
      }
      return result;
    },
    roster: signal => call(RPC_METHODS.roster, { version: 1 }, rosterInputSchema, rosterResultSchema, signal),
    async credential(botLogin, signal) {
      const result = await call(RPC_METHODS.credential, { version: 1, botLogin }, credentialInputSchema, credentialResultSchema, signal);
      if (result.botLogin !== botLogin) throw new PeopleAccountsCallError("malformed", `${RPC_METHODS.credential} answered for a different bot login`);
      return result;
    },
  };
}

export type FailOpenResolution =
  | { source: "supplier"; results: ResolutionV1[]; attribution: AttributionV1 }
  | { source: "unavailable"; error: CallErrorKind; results: []; attribution: AttributionV1 };

/**
 * Call v1 directly. Supplier absence and outages fail open; malformed installed
 * contracts throw a fixed secret-free error. Caller input validates first.
 */
export async function resolveAttributionFailOpen(client: PeopleAccountsClient, request: ResolveRequest, signal?: AbortSignal): Promise<FailOpenResolution> {
  resolveInputSchema.parse({ version: 1, ...request });
  try {
    const result = await client.resolve(request, signal);
    return { source: "supplier", results: result.results, attribution: result.attribution };
  } catch (error) {
    const kind = classifyCallError(error);
    if (kind === "malformed") throw new PeopleAccountsCallError("malformed", "Installed people-accounts does not implement the expected v1 contract.");
    return { source: "unavailable", error: kind, results: [], attribution: unavailableAttribution(kind, request) };
  }
}

// --- Supplier registration -----------------------------------------------------

/** What the supplier plugin provides. Storage, matching and health stay there. */
export interface PeopleAccountsSupplierPort {
  /** Current roster with credential health. Must not write or check tokens. */
  listRoster(): Promise<readonly RosterRowV1[]> | readonly RosterRowV1[];
  /** Match one input. Ambiguous inputs list candidates and never pick. */
  resolve(input: string): Promise<ResolutionOutcomeV1> | ResolutionOutcomeV1;
  /** The stored token for a roster bot login, or null when none is stored. */
  credential(botLogin: string): Promise<string | null> | string | null;
}

function projectPerson(person: PersonSummaryV1): PersonSummaryV1 {
  return {
    personKey: person.personKey, displayName: person.displayName, githubLogin: person.githubLogin, botLogin: person.botLogin,
    committer: person.committer === null ? null : { name: person.committer.name, email: person.committer.email },
  };
}
function projectRosterRow(row: RosterRowV1): RosterRowV1 {
  const { credential: c, aliases: a, committer } = row;
  return {
    personKey: row.personKey, displayName: row.displayName,
    aliases: { emails: [...a.emails], nicknames: [...a.nicknames], handles: [...a.handles] },
    githubLogin: row.githubLogin, botLogin: row.botLogin,
    committer: committer === null ? null : { name: committer.name, email: committer.email },
    credential: {
      state: c.state, actsAs: c.actsAs, expiresAt: c.expiresAt, checkedAt: c.checkedAt, message: c.message,
      ...(c.scopes === undefined ? {} : { scopes: c.scopes === null ? null : [...c.scopes] }),
    },
  };
}
function projectResolution(input: string, outcome: ResolutionOutcomeV1): ResolutionV1 {
  switch (outcome.status) {
    case "resolved": return { input, status: "resolved", person: projectPerson(outcome.person), matchedBy: outcome.matchedBy };
    case "ambiguous": return { input, status: "ambiguous", candidates: outcome.candidates.map(projectPerson) };
    default: return { input, status: "not-found" };
  }
}

function sdkSchema<T>(schema: z.ZodType<T>): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1, vendor: "bb-people-accounts",
      jsonSchema: {
        input: () => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
        output: () => z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }),
      },
      validate(value) {
        const r = schema.safeParse(value);
        return r.success ? { value: r.data } : { issues: r.error.issues.map(i => ({ message: i.message, path: i.path })) };
      },
    },
  } as StandardSchemaV1<T>;
}

/**
 * Register the fixed v1 methods over a supplier port. The helper
 * echoes inputs in order, computes attribution with `summarizeAttribution`,
 * and returns credentials by documented convention to backend callers.
 */
export function registerPeopleAccountsSupplier(bb: Pick<BbPluginApi, "rpc">, port: PeopleAccountsSupplierPort): void {
  const contract = {
    [RPC_METHODS.resolve]: { input: sdkSchema(resolveInputSchema), output: sdkSchema(resolveResultSchema) },
    [RPC_METHODS.roster]: { input: sdkSchema(rosterInputSchema), output: sdkSchema(rosterResultSchema) },
    [RPC_METHODS.credential]: { input: sdkSchema(credentialInputSchema), output: sdkSchema(credentialResultSchema) },
  };
  // Supplier values are projected to known fields here, so anything else a
  // supplier keeps on its objects (a token, storage metadata) never reaches the wire.
  async function roster(): Promise<RosterRowV1[]> {
    return z.array(rosterRowV1Schema).max(LIMITS.rosterEntries).parse(await port.listRoster()).map(projectRosterRow);
  }
  // Supplier and codec failures leave as fixed messages only: a port error's
  // text (for example a failed token read) never becomes an RPC error body.
  const guard = <I, O>(method: string, handler: (input: I) => Promise<O>) => async (input: I): Promise<O> => {
    try { return await handler(input); }
    catch { throw new Error(`${method}: the people-accounts supplier failed`); }
  };
  bb.rpc.register(contract, {
    [RPC_METHODS.resolve]: guard(RPC_METHODS.resolve, async (input: z.infer<typeof resolveInputSchema>) => {
      const results: ResolutionV1[] = [];
      for (const name of input.inputs) {
        results.push(projectResolution(name, resolutionOutcomeV1Schema.parse(await port.resolve(name))));
      }
      return { version: 1 as const, results, attribution: summarizeAttribution(results, input.participants) };
    }),
    [RPC_METHODS.roster]: guard(RPC_METHODS.roster, async () => ({ version: 1 as const, entries: await roster() })),
    [RPC_METHODS.credential]: guard(RPC_METHODS.credential, async (input: z.infer<typeof credentialInputSchema>) => {
      const wanted = input.botLogin.toLowerCase();
      const row = (await roster()).find(r => r.botLogin !== null && r.botLogin.toLowerCase() === wanted);
      // The answer echoes the requested login; the port is asked for the roster's spelling.
      if (!row || row.botLogin === null) return { status: "unavailable" as const, botLogin: input.botLogin, reason: "unknown-account" as const };
      const parsed = tokenSchema.safeParse(await port.credential(row.botLogin));
      if (!parsed.success) return { status: "unavailable" as const, botLogin: input.botLogin, reason: "no-credential" as const };
      return { status: "available" as const, botLogin: input.botLogin, token: parsed.data };
    }),
  }, { experimental_discoverable: true, experimental_description: "People Accounts attribution v1" });
}
