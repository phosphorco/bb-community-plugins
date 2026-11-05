import {
  normalizeAliasKey, personSummaryOf, RPC_METHODS,
  type CredentialHealthV1, type ResolutionOutcomeV1, type RosterEntryV1, type RosterRowV1,
} from "./index.js";
import { createPeopleAccountsClient, type PeopleAccountsClient, type PeopleAccountsSdk, type PeopleAccountsSupplierPort } from "./bb.js";

/** The part of `createFakePluginHost(...)` the kit drives. */
export interface FakeHostLike {
  readonly harness: {
    callRpc(method: string, input?: unknown, options?: { experimental_caller?: { kind: "plugin"; pluginId: string } | { kind: "client" } }): Promise<unknown>;
  };
}

/**
 * An SDK `plugins.callRpc` stand-in that dispatches into a fake host's real
 * registered handlers, as another plugin's backend would.
 */
export function sdkFromFakeHost(host: FakeHostLike | (() => FakeHostLike), callerPluginId = "people-accounts-consumer"): PeopleAccountsSdk {
  const current = typeof host === "function" ? host : () => host;
  return {
    plugins: {
      async callRpc({ method, input, signal }: { method: string; input?: unknown; signal?: AbortSignal }) {
        if (signal?.aborted) throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
        return current().harness.callRpc(method, input, { experimental_caller: { kind: "plugin", pluginId: callerPluginId } });
      },
    },
  } as unknown as PeopleAccountsSdk;
}

export const healthFixture = (extra: Partial<CredentialHealthV1> = {}): CredentialHealthV1 =>
  ({ state: "configured", actsAs: null, expiresAt: null, checkedAt: null, message: null, ...extra });

export function rosterEntryFixture(extra: Partial<RosterEntryV1> = {}): RosterEntryV1 {
  return {
    personKey: "person:fixture:ada",
    displayName: "Ada Fixture",
    aliases: { emails: ["ada@example.test"], nicknames: ["ada"], handles: ["ada-l"] },
    githubLogin: "ada-human",
    botLogin: "ada-bot",
    committer: { name: "Ada Fixture", email: "ada.commits@example.test" },
    ...extra,
  };
}

/**
 * A reference in-memory supplier port for consumer tests. Its matching is
 * exact after `normalizeAliasKey`; real suppliers own their own policy.
 */
export function createFixtureSupplierPort(rows: readonly RosterRowV1[], tokens: Readonly<Record<string, string>> = {}): PeopleAccountsSupplierPort & { calls: { credential: string[] } } {
  const calls = { credential: [] as string[] };
  const keysOf = (row: RosterRowV1): [string, ResolutionOutcomeV1 & { status: "resolved" } extends { matchedBy: infer M } ? M : never][] => [
    ...row.aliases.emails.map(v => [v, "email"] as const),
    ...row.aliases.nicknames.map(v => [v, "nickname"] as const),
    ...row.aliases.handles.map(v => [v, "handle"] as const),
    ...(row.githubLogin ? [[row.githubLogin, "github-login"] as const] : []),
    ...(row.botLogin ? [[row.botLogin, "bot-login"] as const] : []),
    ...(row.committer ? [[row.committer.email, "committer-email"] as const] : []),
    [row.displayName, "display-name"] as const,
  ].map(([value, by]) => [normalizeAliasKey(value), by]);
  return {
    calls,
    listRoster: () => rows,
    resolve(input) {
      const exact = rows.filter(row => row.personKey === input);
      if (exact.length === 1) return { status: "resolved", person: personSummaryOf(exact[0]!), matchedBy: "person-key" };
      const key = normalizeAliasKey(input);
      const hits = rows.flatMap(row => {
        const hit = keysOf(row).find(([k]) => k === key);
        return hit ? [{ row, matchedBy: hit[1] }] : [];
      });
      if (hits.length === 0) return { status: "not-found" };
      if (hits.length > 1) return { status: "ambiguous", candidates: hits.slice(0, 8).map(h => personSummaryOf(h.row)) };
      return { status: "resolved", person: personSummaryOf(hits[0]!.row), matchedBy: hits[0]!.matchedBy };
    },
    credential(botLogin) {
      calls.credential.push(botLogin);
      return tokens[botLogin] ?? null;
    },
  };
}

export class PeopleAccountsConformanceError extends Error {
  constructor(readonly check: string, message: string) {
    super(`${check}: ${message}`);
    this.name = "PeopleAccountsConformanceError";
  }
}

export interface PeopleAccountsConformanceOptions {
  /** A fake host whose factory is the adopter's real supplier registration. */
  host: FakeHostLike | (() => FakeHostLike);
  pluginId?: string;
  /** An entry the adopter has seeded into its roster. */
  entry: RosterEntryV1;
  /** Seeded token for `entry.botLogin`; enables the available-credential check. */
  token?: string;
  /** A seeded bot login with no stored token; enables the no-credential check. */
  botLoginWithoutToken?: string;
  /** An input the adopter's roster matches for several people. */
  ambiguous?: { input: string; personKeys: readonly string[] };
  /** An input nobody in the roster matches. Default: a fixed improbable name. */
  unknownInput?: string;
}

export interface PeopleAccountsConformanceResult {
  level: "source-conformance";
  pluginId: string;
  checks: string[];
}

function expect(check: string, condition: unknown, message: string): asserts condition {
  if (!condition) throw new PeopleAccountsConformanceError(check, message);
}

/** Drive an adopter's real registered handlers through the production client. */
export async function runPeopleAccountsConformance(options: PeopleAccountsConformanceOptions): Promise<PeopleAccountsConformanceResult> {
  const sdk = sdkFromFakeHost(options.host);
  const client: PeopleAccountsClient = createPeopleAccountsClient(sdk, options.pluginId);
  const host = typeof options.host === "function" ? options.host : () => options.host as FakeHostLike;
  const { entry } = options;
  const unknown = options.unknownInput ?? "nobody-by-this-name@conformance.invalid";
  const secrets = [options.token].filter((t): t is string => Boolean(t));
  const secretFree = (check: string, value: unknown) => {
    const json = JSON.stringify(value);
    for (const secret of secrets) expect(check, !json.includes(secret), "output contains the bot token");
  };
  const checks: string[] = [];
  // Raw replies from the real handlers, before the client strips unknown fields.
  const rawSecretFree = async (check: string, method: string, input: unknown) => {
    let reply: unknown;
    try { reply = await host().harness.callRpc(method, input); }
    catch (error) { reply = { message: error instanceof Error ? error.message : String(error), error }; }
    secretFree(check, reply);
  };

  const roster = await client.roster();
  const row = roster.entries.find(r => r.personKey === entry.personKey);
  expect("roster", row, "seeded entry is missing from the roster");
  expect("roster", row.displayName === entry.displayName && row.githubLogin === entry.githubLogin && row.botLogin === entry.botLogin, "seeded entry fields changed");
  secretFree("roster", roster);
  await rawSecretFree("roster", RPC_METHODS.roster, { version: 1 });
  checks.push("roster-secret-free");

  const names = [
    ...entry.aliases.emails, ...entry.aliases.nicknames, ...entry.aliases.handles,
    ...(entry.githubLogin ? [entry.githubLogin] : []), ...(entry.committer ? [entry.committer.email] : []), entry.personKey,
  ];
  const variants = [...entry.aliases.emails.map(e => e.toUpperCase()), ...entry.aliases.handles.map(h => `@${h}`), ...entry.aliases.nicknames.map(n => `  ${n} `)];
  for (const batch of chunk([...names, ...variants], 16)) {
    await rawSecretFree("aliases", RPC_METHODS.resolve, { version: 1, inputs: batch });
    const resolved = await client.resolve({ inputs: batch });
    secretFree("aliases", resolved);
    expect("aliases", resolved.results.length === batch.length, "results do not echo every input");
    resolved.results.forEach((result, i) => {
      expect("aliases", result.input === batch[i], `result ${i} echoes "${result.input}" instead of "${batch[i]}"`);
      expect("aliases", result.status === "resolved" && result.person.personKey === entry.personKey, `"${batch[i]}" did not resolve to ${entry.personKey}`);
    });
    expect("aliases", resolved.attribution.primary?.person.personKey === entry.personKey && resolved.attribution.others.length === 0, "duplicate mentions did not collapse to one person");
  }
  checks.push("aliases-resolve");

  const mixed = await client.resolve({ inputs: [unknown, names[0]!], participants: ["Conformance Participant"] });
  expect("not-found", mixed.results[0]?.status === "not-found", "unknown input did not report not-found");
  expect("not-found", mixed.attribution.primary?.input === names[0], "first resolved input is not primary");
  expect("not-found", mixed.attribution.skipped.length === 1 && mixed.attribution.fallbackReason?.includes(unknown) && mixed.attribution.fallbackReason.includes("Conformance Participant"), "skipped name or participants missing from the fallback reason");
  const empty = await client.resolve({ inputs: [], participants: [] });
  expect("not-found", empty.attribution.primary === null && empty.attribution.fallbackReason !== null, "empty request did not fail open with a reason");
  checks.push("not-found-fails-open");

  if (options.ambiguous) {
    const { input, personKeys } = options.ambiguous;
    const result = await client.resolve({ inputs: [input] });
    const first = result.results[0];
    expect("ambiguous", first?.status === "ambiguous", "ambiguous input did not report ambiguous");
    const keys = first.candidates.map(c => c.personKey);
    expect("ambiguous", personKeys.every(k => keys.includes(k)), "candidates omit an expected person");
    expect("ambiguous", result.attribution.primary === null && result.attribution.fallbackReason?.includes(input), "ambiguous input picked a person or lacks a reason");
    checks.push("ambiguous-never-picks");
  }

  if (entry.botLogin) {
    const unknownAccount = await client.credential("no-such-bot-conformance");
    expect("credential", unknownAccount.status === "unavailable" && unknownAccount.reason === "unknown-account", "unknown bot login was not unknown-account");
    if (options.token !== undefined) {
      const requested = entry.botLogin.toUpperCase();
      const available = await client.credential(requested);
      expect("credential", available.status === "available" && available.token === options.token && available.botLogin === requested, "seeded token was not returned for the roster bot login");
    }
    if (options.botLoginWithoutToken !== undefined) {
      const missing = await client.credential(options.botLoginWithoutToken);
      expect("credential", missing.status === "unavailable" && missing.reason === "no-credential", "bot login without a token was not no-credential");
    }
    checks.push("credential-backend");
  }

  let strict = false;
  try { await host().harness.callRpc(RPC_METHODS.resolve, { version: 1, inputs: [], extra: true }); } catch { strict = true; }
  expect("strict-input", strict, "resolve accepted an unknown input field");
  checks.push("strict-input");

  return { level: "source-conformance", pluginId: client.pluginId, checks };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
