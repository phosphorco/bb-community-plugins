/**
 * Conformance kit for provider-settings owners and invocations.
 *
 * Consumers prove their own integration from their own tests. Every owner
 * scenario calls the consumer's real owner, the one its plugin factory
 * registered with `registerProviderSettingsOwner`, through the SDK fake plugin
 * host (`createFakePluginHost` from `@get-bb/plugin-sdk/testing`). The kit
 * never reimplements Read, Validate or Save. It sends protocol calls and
 * observes the subject's own storage and native requests.
 *
 * This is source conformance, not native-execution proof. The fake host is an
 * in-process stand-in for the BB server. Passing scenarios do not show that a
 * running BB host, its picker, or a provider honoured the settings.
 *
 * This entry is DOM-free. Mounted editor scenarios live in `./testing/react`.
 * @module
 */
import { createOwnerClient } from './bb.js';
import type { CatalogSdk, OwnerClient, OwnerSdk } from './bb.js';
import { normalizeRoleChoice } from './index.js';
import type {
    CatalogModel, CatalogRoute, ExecutionSelection, FirstSendFields, ProviderCatalog, ProviderInfo, RoleCapability,
    RoleChoice, RoleDescriptorV1, SaveResult, SpawnFields, ValidationPolicy,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures

/** Neutral validation policies covering the three supported policy shapes. */
export const policies: {
    /** Exact model match, route qualifier enforced, catalog errors reject, non-default tiers need support. */
    readonly strictModel: ValidationPolicy;
    /** Id-or-model match including selected-only rows; catalog errors and tiers are not checked. */
    readonly callerTolerant: ValidationPolicy;
    /** Like strictModel, but any tier must be supported and listed by the provider. */
    readonly listedTier: ValidationPolicy;
} = Object.freeze({
    strictModel: Object.freeze({ match: 'model', routeQualifier: 'must-equal-provider-when-present', candidates: 'models', modelLoadError: 'reject', tier: 'non-default-requires-support' }),
    callerTolerant: Object.freeze({ match: 'id-or-model', routeQualifier: 'ignore', candidates: 'models+selected-only', modelLoadError: 'not-checked', tier: 'not-validated' }),
    listedTier: Object.freeze({ match: 'model', routeQualifier: 'must-equal-provider-when-present', candidates: 'models', modelLoadError: 'reject', tier: 'any-non-null-requires-support-and-listed' }),
});

export function providerFixture(id = 'p', extra: Partial<ProviderInfo> = {}): ProviderInfo {
    return { id, available: true, capabilities: { modelCatalogScope: 'host', supportsServiceTier: true, permissionModes: ['auto', 'accept-edits'] }, serviceTiers: [{ id: 'default' }, { id: 'fast' }], ...extra };
}

export function catalogRowFixture(extra: Partial<CatalogModel> = {}): CatalogModel {
    return { id: 'catalog-id', model: 'exec-model', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], ...extra };
}

export function catalogFixture(extra: Partial<ProviderCatalog> = {}): ProviderCatalog {
    return { providerId: 'p', route: { kind: 'host', hostId: 'h' }, modelLoadError: null, models: [catalogRowFixture()], selectedOnlyModels: [], ...extra };
}

/** A capability witness for fixed-to-source roles. Its evidence string says it is test-only. */
export function capabilityFixture(extra: Partial<RoleCapability> = {}): RoleCapability {
    return { evidence: 'test-only-role-witness-not-host-proof', boundaries: ['fork-child'], providers: { p: { perBoundary: { 'fork-child': { model: 'demonstrated', reasoningLevel: 'demonstrated', reasoningWithoutModel: 'demonstrated' } } } }, ...extra };
}

/** A valid role descriptor. `cascade` is dropped automatically when `fields` is not offered. */
export function roleDescriptorFixture(extra: Partial<RoleDescriptorV1> = {}): RoleDescriptorV1 {
    const role: RoleDescriptorV1 = { id: 'expert', label: 'Expert', choiceKinds: ['inherit', 'fields'], cascade: 'caller-v1', providerPolicy: 'any', saveValidation: 'invocation', applies: 'Used by the next invocation.', writable: true, ...extra };
    if (!role.choiceKinds.includes('fields')) delete role.cascade;
    return role;
}

/** Matches the default provider and catalog fixtures. */
export const selectionFixture: ExecutionSelection = Object.freeze({ providerId: 'p', model: 'exec-model', reasoningLevel: 'low', serviceTier: 'default' });

// ---------------------------------------------------------------------------
// Errors, pauses and comparison

/** Thrown when a subject breaks a scenario. `scenario` names the scenario id. */
export class ConformanceError extends Error {
    constructor(readonly scenario: string, detail: string) {
        super(`[${scenario}] ${detail}`);
        this.name = 'ConformanceError';
    }
}

/** A held call. `reached` resolves once the call is held; `release()` lets it finish. */
export interface Pause {
    readonly reached: Promise<void>;
    release(): void;
}

interface Gate extends Pause {
    readonly released: boolean;
    reach(): void;
    wait(): Promise<void>;
}

function createGate(): Gate {
    let reach!: () => void, open!: () => void, released = false;
    const reached = new Promise<void>(r => { reach = r; });
    const gate = new Promise<void>(r => { open = r; });
    return { reached, reach: () => reach(), wait: () => gate, release() { released = true; open(); }, get released() { return released; } };
}

/** Order-independent JSON text, so comparisons ignore key order but not values or presence. */
function canonical(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(record[k])).join(',') + '}';
}

function same(left: unknown, right: unknown): boolean {
    return canonical(left) === canonical(right);
}

function check(scenario: string, condition: unknown, detail: string): asserts condition {
    if (!condition) throw new ConformanceError(scenario, detail);
}

function equal(scenario: string, actual: unknown, expected: unknown, detail: string): void {
    if (!same(actual, expected)) throw new ConformanceError(scenario, `${detail}\n  expected: ${canonical(expected)}\n  actual:   ${canonical(actual)}`);
}

// ---------------------------------------------------------------------------
// Fake catalog

export interface CatalogCall {
    readonly method: 'list' | 'models';
    readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Stands in for `sdk.providers.list` / `sdk.providers.models`. Pass `sdk` to the
 * owner port's catalog reader and to editors as `catalogSdk`. Data set without
 * a route answers every route; route-specific data takes precedence.
 */
export interface FakeCatalog {
    readonly sdk: CatalogSdk;
    readonly calls: readonly CatalogCall[];
    /** Number of catalog calls still awaiting a response. */
    readonly pending: number;
    setProviders(providers: readonly ProviderInfo[], route?: CatalogRoute | null): void;
    setModels(providerId: string, catalog: Partial<Omit<ProviderCatalog, 'providerId' | 'route'>>, route?: CatalogRoute | null): void;
    /** The next call of `method` rejects with `error`. */
    failNext(method: 'list' | 'models', error: unknown): void;
    /** Hold the next call of `method` until the returned pause is released. */
    holdNext(method: 'list' | 'models'): Pause;
    /** Resolves when every catalog call in flight has settled. Throws while a held call is unreleased. */
    settled(): Promise<void>;
}

function routeKey(route: CatalogRoute | null | undefined): string {
    return !route ? '*' : route.kind === 'host' ? `host:${route.hostId}` : `environment:${route.environmentId}`;
}

function argsRoute(args: Record<string, unknown>): CatalogRoute | null {
    return typeof args.hostId === 'string' ? { kind: 'host', hostId: args.hostId } : typeof args.environmentId === 'string' ? { kind: 'environment', environmentId: args.environmentId } : null;
}

export function createFakeCatalog(seed: { readonly providers?: readonly ProviderInfo[]; readonly catalog?: Partial<Omit<ProviderCatalog, 'providerId' | 'route'>> } = {}): FakeCatalog {
    const providers = new Map<string, readonly ProviderInfo[]>([['*', seed.providers ?? [providerFixture()]]]);
    const models = new Map<string, Partial<ProviderCatalog>>();
    const calls: CatalogCall[] = [];
    const failures: { method: string; error: unknown }[] = [];
    const holds: { method: string; gate: Gate }[] = [];
    const inflight = new Set<{ promise: Promise<unknown>; gate: Gate | null }>();
    function take<T extends { method: string }>(list: T[], method: string): T | undefined {
        const index = list.findIndex(item => item.method === method);
        return index < 0 ? undefined : list.splice(index, 1)[0];
    }
    async function answer(method: 'list' | 'models', args: Record<string, unknown>): Promise<unknown> {
        calls.push({ method, args: structuredClone(args) });
        const hold = take(holds, method)?.gate ?? null;
        const run = (async () => {
            if (hold) { hold.reach(); await hold.wait(); }
            const failure = take(failures, method);
            if (failure) throw failure.error;
            const route = argsRoute(args), key = routeKey(route);
            if (method === 'list') return structuredClone(providers.get(key) ?? providers.get('*') ?? []);
            const providerId = String(args.providerId);
            const found = models.get(`${key}|${providerId}`) ?? models.get(`*|${providerId}`) ?? seed.catalog ?? {};
            const { providerId: _p, route: _r, ...base } = catalogFixture({ providerId, route });
            return structuredClone({ ...base, ...found });
        })();
        const entry = { promise: run, gate: hold };
        inflight.add(entry);
        try { return await run; } finally { inflight.delete(entry); }
    }
    return {
        sdk: { providers: { list: (args: Record<string, unknown> = {}) => answer('list', args), models: (args: Record<string, unknown>) => answer('models', args) } } as unknown as CatalogSdk,
        calls,
        get pending() { return inflight.size; },
        setProviders(list, route) { providers.set(routeKey(route), structuredClone([...list])); },
        setModels(providerId, catalog, route) { models.set(`${routeKey(route)}|${providerId}`, structuredClone(catalog)); },
        failNext(method, error) { failures.push({ method, error }); },
        holdNext(method) { const gate = createGate(); holds.push({ method, gate }); return gate; },
        async settled() {
            while (inflight.size) {
                if ([...inflight].some(e => e.gate && !e.gate.released)) throw new Error('A held catalog call is unreleased; release its pause before waiting for settlement.');
                await Promise.allSettled([...inflight].map(e => e.promise));
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Owner probe

/** Structural view of `FakePluginHost` from `@get-bb/plugin-sdk/testing`; the kit needs nothing else. */
export interface FakeHostLike {
    readonly harness: {
        readonly behavior: { callRpc(method: string, input?: unknown): Promise<unknown> };
        readonly inspection: { readonly pluginId: string; readonly registrations: { readonly rpcMethods: readonly string[] } };
    };
}

export type OwnerMethod = 'providerSettingsDescribe' | 'providerSettingsV1Read' | 'providerSettingsV1Validate' | 'providerSettingsV1Save';
export const ownerMethods: readonly OwnerMethod[] = Object.freeze(['providerSettingsDescribe', 'providerSettingsV1Read', 'providerSettingsV1Validate', 'providerSettingsV1Save']);

export interface OwnerCall {
    readonly pluginId: string;
    readonly method: string;
    readonly input: unknown;
}

/**
 * Routes `sdk.plugins.callRpc` to each owner's fake host with host semantics,
 * logs every call, and can hold or lose responses. `sdk` also answers
 * `plugins.list` (every owner running) and, when a catalog is supplied,
 * `providers.*`, so it can back `ProviderSettingsDirectory` too.
 */
export interface OwnerProbe {
    readonly sdk: OwnerSdk & CatalogSdk;
    readonly owners: readonly string[];
    readonly calls: readonly OwnerCall[];
    /** Number of owner calls still awaiting a response. */
    readonly pending: number;
    /** A real `createOwnerClient` bound to `pluginId`. Defaults to the only owner. */
    client(pluginId?: string): OwnerClient;
    /** The next matching call runs on the owner, but its response is withheld until release. */
    holdNext(method: OwnerMethod, pluginId?: string): Pause;
    /** The next matching Save commits on the owner, then the caller sees a transport failure. */
    loseNextResponse(method: 'providerSettingsV1Save', pluginId?: string): void;
    /**
     * Resolves once every owner (and catalog) call in flight has settled, awaiting
     * the actual pending promises. Throws while a held call is unreleased.
     */
    settled(): Promise<void>;
}

function isHost(value: unknown): value is FakeHostLike {
    return typeof value === 'object' && value !== null && 'harness' in value;
}

function abortError(): Error {
    return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

function validateOutput(schema: unknown, value: unknown): unknown {
    const standard = (schema as { '~standard'?: { validate(v: unknown): unknown } } | undefined)?.['~standard'];
    if (!standard) return value;
    const result = standard.validate(value) as { value?: unknown; issues?: readonly { message: string }[] };
    if (result instanceof Promise) throw new Error('Asynchronous output schemas are not supported by the owner probe.');
    if (result.issues) throw Object.assign(new Error('Owner output failed validation'), { status: 500, body: { error: { code: 'invalid_output', issues: result.issues } } });
    return result.value;
}

export function createOwnerProbe(owners: FakeHostLike | Readonly<Record<string, FakeHostLike>>, options: { readonly catalog?: FakeCatalog } = {}): OwnerProbe {
    const hosts = new Map<string, FakeHostLike>(isHost(owners) ? [[owners.harness.inspection.pluginId, owners]] : Object.entries(owners));
    if (!hosts.size) throw new Error('createOwnerProbe needs at least one owner host.');
    const calls: OwnerCall[] = [];
    const holds: { method: string; pluginId: string | undefined; gate: Gate }[] = [];
    const losses: { method: string; pluginId: string | undefined }[] = [];
    const inflight = new Set<{ promise: Promise<unknown>; gate: Gate | null }>();
    function take<T extends { method: string; pluginId: string | undefined }>(list: T[], method: string, pluginId: string): T | undefined {
        const index = list.findIndex(item => item.method === method && (item.pluginId === undefined || item.pluginId === pluginId));
        return index < 0 ? undefined : list.splice(index, 1)[0];
    }
    async function callRpc(args: { pluginId: string; method: string; input?: unknown; outputSchema?: unknown; signal?: AbortSignal }): Promise<unknown> {
        if (args.signal?.aborted) throw abortError();
        calls.push({ pluginId: args.pluginId, method: args.method, input: structuredClone(args.input ?? null) });
        const host = hosts.get(args.pluginId);
        if (!host) throw Object.assign(new Error(`unknown plugin ${args.pluginId}`), { status: 404, body: { ok: false, error: `unknown plugin ${args.pluginId}` } });
        const hold = take(holds, args.method, args.pluginId)?.gate ?? null;
        const lose = take(losses, args.method, args.pluginId);
        const run = (async () => {
            const result = await host.harness.behavior.callRpc(args.method, args.input ?? null);
            if (hold) { hold.reach(); await hold.wait(); }
            if (lose) throw new Error('Owner response lost after the call completed');
            return validateOutput(args.outputSchema, result);
        })();
        const entry = { promise: run, gate: hold };
        inflight.add(entry);
        try { return await run; } finally { inflight.delete(entry); }
    }
    const providers = options.catalog?.sdk.providers;
    const sdk = {
        plugins: {
            callRpc,
            async list() { return { plugins: [...hosts.keys()].map(id => ({ id, name: id, status: 'running' })) }; },
        },
        providers: providers ?? new Proxy({}, { get: (_t, key) => () => { throw new Error(`No catalog was given to createOwnerProbe; providers.${String(key)} is unavailable.`); } }),
    } as unknown as OwnerSdk & CatalogSdk;
    return {
        sdk,
        owners: [...hosts.keys()],
        calls,
        get pending() { return inflight.size + (options.catalog?.pending ?? 0); },
        client(pluginId) {
            if (pluginId === undefined) {
                if (hosts.size !== 1) throw new Error('This probe has several owners; name the owner whose client you want.');
                pluginId = [...hosts.keys()][0]!;
            }
            return createOwnerClient(sdk, pluginId);
        },
        holdNext(method, pluginId) { const gate = createGate(); holds.push({ method, pluginId, gate }); return gate; },
        loseNextResponse(method, pluginId) { losses.push({ method, pluginId }); },
        async settled() {
            while (inflight.size || (options.catalog?.pending ?? 0)) {
                if ([...inflight].some(e => e.gate && !e.gate.released)) throw new Error('A held owner call is unreleased; release its pause before waiting for settlement.');
                await Promise.allSettled([...inflight].map(e => e.promise));
                await options.catalog?.settled();
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Scenarios

/** One runnable conformance check. A `skip` reason marks a visible gap; it never counts as a pass. */
export interface Scenario {
    readonly id: string;
    readonly skip?: string;
    run(): Promise<void>;
}

/** Minimal shape shared by `node:test` and `bun:test`. */
export interface TestRegistrar {
    (name: string, fn: () => Promise<void>): unknown;
    skip(name: string, fn: () => Promise<void>): unknown;
}

/** Registers each scenario as a test; skipped ones keep their reason in the test name. */
export function defineScenarios(test: TestRegistrar, scenarios: readonly Scenario[], prefix = ''): void {
    for (const s of scenarios) {
        if (s.skip !== undefined) test.skip(`${prefix}${s.id} — gap: ${s.skip}`, s.run);
        else test(`${prefix}${s.id}`, () => s.run());
    }
}

function scenario(id: string, run: () => Promise<void>, skip: string | undefined): Scenario {
    return skip === undefined ? { id, run } : { id, skip, run };
}

/**
 * A role registered by the consumer's real plugin factory on an SDK fake host.
 * The subject exposes the plugin's own storage so the kit can observe it.
 */
export interface RoleSubject {
    /** The fake host the plugin factory ran on. Its owner methods must be registered. */
    readonly host: FakeHostLike;
    readonly roleId: string;
    /** Declares a read-only role; `describe` verifies the declaration. */
    readonly readOnly?: boolean;
    /** A non-inherit choice the owner must accept and persist. */
    readonly acceptedChoice: RoleChoice;
    /** A well-formed choice the owner must refuse at Save. */
    readonly rejectedChoice?: RoleChoice;
    /** Sample route for invocation-validated roles; destination roles resolve their own. */
    readonly sampleRoute?: CatalogRoute;
    /** The fake catalog the plugin's owner port reads through. */
    readonly catalog?: FakeCatalog;
    /** Snapshot of the plugin's own persisted storage, keyed however the plugin stores it. */
    readRaw(): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
    /** Keys of `readRaw()` this role may change. Every other key must stay identical. */
    readonly roleKeys: readonly string[];
    /** An intervening writer changes this role's stored value (any change will do). */
    writeExternally(): Promise<void>;
    /** Store a value the owner decodes as malformed. */
    seedMalformed?(): Promise<void>;
    /** Store owner-owned fields that an inherit reset would lose. */
    seedProtectedFields?(): Promise<void>;
    /** Count or log of native work the plugin has performed; Read and Validate must not change it. */
    sideEffects?(): unknown;
    /** Rerun the plugin factory over the retained storage and return the new host. */
    reload?(): Promise<FakeHostLike>;
    /** Restore baseline storage before each scenario, when scenarios must not share state. */
    restore?(): Promise<void>;
}

export type OwnerScenarioId =
    | 'describe' | 'strict-inputs' | 'unknown-role-isolated'
    | 'read-validate-no-side-effects' | 'stale-fingerprint-conflict' | 'conflict-after-async-validation'
    | 'rejected-choice-not-written' | 'save-readback' | 'reload-retains-intent' | 'reset-without-catalog'
    | 'malformed-retained' | 'protected-fields-veto-reset' | 'read-only-role-rejects';

export interface ScenarioOptions<Id extends string> {
    /** Mark scenarios as known gaps: a required behaviour this subject does not prove yet. Every skip needs a reason. */
    readonly skip?: Partial<Record<Id, string>>;
    /**
     * Declare scenarios that do not apply to this role (for example no protected fields, or a
     * reasoning-only role with nothing to validate against a catalog). They are omitted, not
     * skipped, so a test run stays free of gaps. Every entry needs a reason, and an id cannot be
     * both a gap and not applicable.
     */
    readonly notApplicable?: Partial<Record<Id, string>>;
}

/** Applies `notApplicable`: validates the declaration and omits those scenarios. */
export function applicable<Id extends string>(list: readonly Scenario[], options: ScenarioOptions<Id>): readonly Scenario[] {
    const na = Object.entries(options.notApplicable ?? {}) as [string, string | undefined][];
    const ids = new Set(list.map(s => s.id));
    for (const [id, reason] of na) {
        if (!ids.has(id)) throw new Error(`notApplicable names unknown scenario '${id}'`);
        if (!reason || !reason.trim()) throw new Error(`notApplicable '${id}' needs a reason`);
        if (options.skip && id in options.skip) throw new Error(`'${id}' cannot be both skipped and notApplicable`);
    }
    for (const [id, reason] of Object.entries(options.skip ?? {}) as [string, string | undefined][]) {
        if (!reason || !reason.trim()) throw new Error(`skip '${id}' needs a reason`);
    }
    const omit = new Set(na.map(([id]) => id));
    return list.filter(s => !omit.has(s.id));
}

const UNKNOWN_ROLE = 'conformance-unknown-role';

async function raw(subject: RoleSubject): Promise<Record<string, unknown>> {
    return structuredClone({ ...await subject.readRaw() });
}

function outsideRole(subject: RoleSubject, value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !subject.roleKeys.includes(k)));
}

function normalized(choice: RoleChoice): RoleChoice {
    const n = normalizeRoleChoice(choice);
    if (!n.ok) throw new Error(`Subject choice is not a valid role choice: ${n.issues.map(i => i.message).join('; ')}`);
    return n.value;
}

async function settles(promise: Promise<unknown>): Promise<boolean> {
    try { await promise; return true; } catch { return false; }
}

/**
 * The standard owner scenarios for one role. They run in the returned order and
 * may leave stored state behind; supply `restore` when that matters. Scenarios
 * whose subject hook is missing are returned with a skip reason, so the gap stays
 * visible. Scenarios that do not apply (write checks on a read-only role) are omitted.
 */
export function ownerScenarios(subject: RoleSubject, options: ScenarioOptions<OwnerScenarioId> = {}): readonly Scenario[] {
    let host = subject.host;
    let probe = createOwnerProbe(host, subject.catalog ? { catalog: subject.catalog } : {});
    const pluginId = host.harness.inspection.pluginId;
    const client = () => probe.client(pluginId);
    const read = async () => client().read(subject.roleId);
    const save = async (id: string, choice: RoleChoice, fingerprint: string): Promise<SaveResult> => {
        try { return await client().save(subject.roleId, choice, fingerprint, subject.sampleRoute); }
        catch (e) { throw new ConformanceError(id, `Save failed instead of returning an outcome: ${String(e)}`); }
    };
    const unchanged = async (id: string, before: Record<string, unknown>, what: string) => equal(id, await raw(subject), before, `${what} changed the plugin's stored data`);
    const sideEffects = () => structuredClone(subject.sideEffects?.() ?? null);
    const needs = (id: OwnerScenarioId, hook: unknown, name: string) => options.skip?.[id] ?? (hook ? undefined : `subject supplies no ${name}`);
    const writable = !subject.readOnly;
    const make = (id: OwnerScenarioId, run: () => Promise<void>, gap?: string) => scenario(id, async () => { await subject.restore?.(); await run(); }, options.skip?.[id] ?? gap);
    const list: Scenario[] = [
        make('describe', async () => {
            const id = 'describe';
            const methods = host.harness.inspection.registrations.rpcMethods;
            for (const m of ownerMethods) check(id, methods.includes(m), `owner method ${m} is not registered`);
            const described = await client().describe();
            check(id, described.kind === 'ok', `Describe is not compatible: ${JSON.stringify(described)}`);
            const role = described.roles.find(r => r.id === subject.roleId);
            check(id, role, `Describe does not list role ${subject.roleId}`);
            check(id, role.writable === writable, `role writable=${role.writable} but the subject declares readOnly=${!writable}`);
            const direct = await host.harness.behavior.callRpc('providerSettingsDescribe', null);
            for (const input of [{}, { futureField: true }]) equal(id, await host.harness.behavior.callRpc('providerSettingsDescribe', input), direct, 'Describe must ignore unknown input');
        }),
        make('strict-inputs', async () => {
            const id = 'strict-inputs', before = await raw(subject);
            const current = await read();
            const inputs: [OwnerMethod, Record<string, unknown>][] = [
                ['providerSettingsV1Read', { version: 1, role: subject.roleId, extra: true }],
                ['providerSettingsV1Read', { version: 2, role: subject.roleId }],
                ['providerSettingsV1Validate', { version: 1, role: subject.roleId, choice: { kind: 'inherit' }, extra: true }],
                ['providerSettingsV1Save', { version: 1, role: subject.roleId, choice: { kind: 'inherit' }, expectedFingerprint: current.fingerprint, extra: true }],
                ['providerSettingsV1Save', { version: 1, role: subject.roleId, choice: { kind: 'inherit', extra: true }, expectedFingerprint: current.fingerprint }],
            ];
            for (const [method, input] of inputs) check(id, !await settles(host.harness.behavior.callRpc(method, input)), `${method} accepted a non-strict input ${JSON.stringify(input)}`);
            await unchanged(id, before, 'rejected strict inputs');
        }),
        make('unknown-role-isolated', async () => {
            const id = 'unknown-role-isolated', before = await raw(subject), effects = sideEffects();
            const current = await read();
            for (const [method, input] of [
                ['providerSettingsV1Read', { version: 1, role: UNKNOWN_ROLE }],
                ['providerSettingsV1Validate', { version: 1, role: UNKNOWN_ROLE, choice: { kind: 'inherit' } }],
                ['providerSettingsV1Save', { version: 1, role: UNKNOWN_ROLE, choice: { kind: 'inherit' }, expectedFingerprint: current.fingerprint }],
            ] as const) {
                let result: unknown;
                try { result = await host.harness.behavior.callRpc(method, input); } catch { continue; }
                const r = result as { role?: unknown; outcome?: unknown };
                check(id, r.role !== subject.roleId && r.outcome !== 'saved', `${method} for an unknown role answered as ${subject.roleId}`);
            }
            await unchanged(id, before, 'unknown-role calls');
            equal(id, sideEffects(), effects, 'unknown-role calls performed native work');
        }),
        make('read-validate-no-side-effects', async () => {
            const id = 'read-validate-no-side-effects', before = await raw(subject), effects = sideEffects();
            const catalogCalls = subject.catalog?.calls.length ?? 0;
            const result = await read();
            equal(id, result.eligibility, { status: 'unverified' }, 'Read must not claim eligibility');
            await unchanged(id, before, 'Read');
            check(id, (subject.catalog?.calls.length ?? 0) === catalogCalls, 'Read loaded a provider catalog');
            for (const choice of [subject.acceptedChoice, { kind: 'inherit' } as RoleChoice]) await client().validate(subject.roleId, choice, subject.sampleRoute);
            await unchanged(id, before, 'Validate');
            equal(id, sideEffects(), effects, 'Read or Validate performed native work');
        }),
    ];
    if (writable) list.push(
        make('stale-fingerprint-conflict', async () => {
            const id = 'stale-fingerprint-conflict';
            const before = await read();
            await subject.writeExternally();
            const external = await raw(subject);
            check(id, (await read()).fingerprint !== before.fingerprint, 'writeExternally did not change the fingerprint the owner reports');
            const result = await save(id, subject.acceptedChoice, before.fingerprint);
            check(id, result.outcome === 'conflict', `Save with a stale fingerprint returned ${result.outcome}, not conflict`);
            await unchanged(id, external, 'a stale Save');
        }),
        make('conflict-after-async-validation', async () => {
            const id = 'conflict-after-async-validation', catalog = subject.catalog!;
            const before = await read();
            const pause = catalog.holdNext('models');
            const pending = save(id, subject.acceptedChoice, before.fingerprint);
            const first = await Promise.race([pause.reached.then(() => 'held' as const), pending.then(() => 'done' as const, () => 'done' as const)]);
            if (first !== 'held') { pause.release(); throw new ConformanceError(id, 'Save never consulted the catalog. Give the subject a sampleRoute or a destination role, or skip this scenario with a reason.'); }
            await subject.writeExternally();
            const external = await raw(subject);
            pause.release();
            const result = await pending;
            check(id, result.outcome === 'conflict', `a write during Save validation was overwritten (outcome ${result.outcome})`);
            await unchanged(id, external, 'a Save that lost its race');
        }, needs('conflict-after-async-validation', subject.catalog, 'catalog')),
        make('rejected-choice-not-written', async () => {
            const id = 'rejected-choice-not-written', before = await raw(subject);
            const result = await save(id, subject.rejectedChoice!, (await read()).fingerprint);
            check(id, result.outcome === 'rejected', `the rejected choice returned ${result.outcome}`);
            await unchanged(id, before, 'a rejected Save');
        }, needs('rejected-choice-not-written', subject.rejectedChoice, 'rejectedChoice')),
        make('save-readback', async () => {
            const id = 'save-readback', before = await raw(subject);
            const result = await save(id, subject.acceptedChoice, (await read()).fingerprint);
            check(id, result.outcome === 'saved', `the accepted choice returned ${result.outcome}: ${JSON.stringify(result)}`);
            check(id, result.read.stored.status === 'valid-shape', 'the saved Read is not valid-shape');
            equal(id, result.read.stored.choice, normalized(subject.acceptedChoice), 'Save did not read back the submitted choice');
            const again = await read();
            check(id, again.fingerprint === result.read.fingerprint, 'a fresh Read disagrees with the Save readback');
            equal(id, outsideRole(subject, await raw(subject)), outsideRole(subject, before), 'Save changed storage outside roleKeys');
        }),
        make('reload-retains-intent', async () => {
            const id = 'reload-retains-intent';
            let current = await read();
            const result = await save(id, subject.acceptedChoice, current.fingerprint);
            check(id, result.outcome === 'saved', `the accepted choice returned ${result.outcome}`);
            current = await read();
            host = await subject.reload!();
            check(id, host.harness.inspection.pluginId === pluginId, 'reload returned a host for another plugin');
            probe = createOwnerProbe(host, subject.catalog ? { catalog: subject.catalog } : {});
            const after = await read();
            check(id, after.fingerprint === current.fingerprint, 'the reloaded owner reports a different fingerprint');
            equal(id, after.stored, current.stored, 'the reloaded owner reads a different choice');
        }, needs('reload-retains-intent', subject.reload, 'reload')),
        make('reset-without-catalog', async () => {
            const id = 'reset-without-catalog', catalogCalls = subject.catalog?.calls.length ?? 0;
            const result = await save(id, { kind: 'inherit' }, (await read()).fingerprint);
            check(id, result.outcome === 'saved', `an inherit reset returned ${result.outcome}: ${JSON.stringify(result)}`);
            check(id, (subject.catalog?.calls.length ?? 0) === catalogCalls, 'an inherit reset loaded a provider catalog');
            const after = await read();
            check(id, after.stored.status === 'valid-shape' && after.stored.choice.kind === 'inherit', 'Read after reset is not inherit');
        }),
        make('malformed-retained', async () => {
            const id = 'malformed-retained';
            await subject.seedMalformed!();
            const before = await raw(subject);
            const current = await read();
            check(id, current.stored.status === 'malformed', `seeded malformed data reads as ${current.stored.status}`);
            await client().validate(subject.roleId, subject.acceptedChoice, subject.sampleRoute);
            await unchanged(id, before, 'reading malformed data');
            const catalogCalls = subject.catalog?.calls.length ?? 0;
            const result = await save(id, { kind: 'inherit' }, current.fingerprint);
            check(id, result.outcome === 'saved', `an explicit reset of malformed data returned ${result.outcome}`);
            check(id, (subject.catalog?.calls.length ?? 0) === catalogCalls, 'resetting malformed data loaded a provider catalog');
        }, needs('malformed-retained', subject.seedMalformed, 'seedMalformed')),
        make('protected-fields-veto-reset', async () => {
            const id = 'protected-fields-veto-reset';
            await subject.seedProtectedFields!();
            const before = await raw(subject);
            const result = await save(id, { kind: 'inherit' }, (await read()).fingerprint);
            check(id, result.outcome === 'rejected' && result.issues.some(i => i.code === 'owner-fields-would-be-lost'), `a lossy reset returned ${JSON.stringify(result)}`);
            await unchanged(id, before, 'a vetoed reset');
        }, needs('protected-fields-veto-reset', subject.seedProtectedFields, 'seedProtectedFields')),
    );
    else list.push(make('read-only-role-rejects', async () => {
        const id = 'read-only-role-rejects', before = await raw(subject);
        const result = await save(id, { kind: 'inherit' }, (await read()).fingerprint);
        check(id, result.outcome === 'rejected', `a read-only role returned ${result.outcome}`);
        await unchanged(id, before, 'a read-only Save');
    }));
    return applicable(list, options);
}

/**
 * Explicit targeting across independently registered owners. For each owner,
 * a client bound to it reads and saves; every call must reach that owner only,
 * and every other owner's storage must stay identical.
 */
export function crossOwnerScenario(subjects: readonly RoleSubject[]): Scenario {
    const id = 'cross-owner-explicit-targeting';
    return scenario(id, async () => {
        const hosts: Record<string, FakeHostLike> = {};
        for (const s of subjects) hosts[s.host.harness.inspection.pluginId] = s.host;
        check(id, Object.keys(hosts).length >= 2 && Object.keys(hosts).length === subjects.length, 'cross-owner targeting needs at least two subjects on distinct plugins');
        const probe = createOwnerProbe(hosts);
        for (const target of subjects) {
            await target.restore?.();
            const targetId = target.host.harness.inspection.pluginId, client = probe.client(targetId);
            const others = subjects.filter(s => s !== target);
            const before = await Promise.all(others.map(s => raw(s)));
            const from = probe.calls.length;
            const current = await client.read(target.roleId);
            check(id, current.role === target.roleId, `owner ${targetId} answered for role ${current.role}`);
            if (!target.readOnly) {
                const result = await client.save(target.roleId, target.acceptedChoice, current.fingerprint, target.sampleRoute);
                check(id, result.outcome === 'saved', `Save through ${targetId} returned ${result.outcome}`);
                const after = await client.read(target.roleId);
                check(id, after.stored.status === 'valid-shape', `owner ${targetId} did not keep the saved choice`);
                equal(id, after.stored.choice, normalized(target.acceptedChoice), `owner ${targetId} did not keep the saved choice`);
            }
            const strays = probe.calls.slice(from).filter(c => c.pluginId !== targetId);
            check(id, !strays.length, `calls for ${targetId} reached ${strays.map(c => c.pluginId).join(', ')}`);
            for (const [i, s] of others.entries()) equal(id, await raw(s), before[i], `work through ${targetId} changed ${s.host.harness.inspection.pluginId}'s storage`);
        }
    }, undefined);
}

// ---------------------------------------------------------------------------
// Invocation

/** One native request the plugin made, e.g. `{ method: 'threads.spawn', args }`. */
export interface NativeRequest {
    readonly method: string;
    readonly args: Readonly<Record<string, unknown>>;
}

/** The request fields that carry execution choice and its provenance. */
export const executionFields = Object.freeze(['providerId', 'model', 'reasoningLevel', 'serviceTier', 'executionInputSources'] as const);

/**
 * The plugin's real dispatch path, observed at its native SDK boundary.
 * `baseline` is what the plugin sends with no provider-settings override,
 * including any execution fields and provenance it owns itself (a caller's
 * tuple, a feature-owned permission source, a captured map). Inherit must
 * reproduce it exactly.
 */
export interface InvocationSubject {
    readonly baseline: readonly NativeRequest[];
    /** Persist a choice for the role the invocation reads. */
    setChoice(choice: RoleChoice): Promise<void>;
    /** Trigger one real invocation. It may reject when the plugin refuses. */
    invoke(): Promise<void>;
    /** Every native request so far, in order. The kit compares only the new ones. */
    requests(): readonly NativeRequest[];
    /** An accepted override and the exact requests it must produce. `withOverride` helps build them. */
    readonly override: { readonly choice: RoleChoice; readonly expected: readonly NativeRequest[] };
    /** Choices the invocation must refuse before any native request (invalid field, capability unknown). */
    readonly refusedChoices?: readonly RoleChoice[];
    /** Change the destination after `override.choice` was saved, e.g. another host or catalog. */
    changeDestination?(): Promise<void>;
}

export type InvocationScenarioId = 'inherit-native-path' | 'override-exact-fields' | 'refused-before-dispatch' | 'destination-changed-rejects-before-dispatch';

function fieldDiff(actual: NativeRequest, expected: NativeRequest): string[] {
    return executionFields.flatMap(field => {
        const a = Object.hasOwn(actual.args, field), e = Object.hasOwn(expected.args, field);
        if (a !== e) return [`${field} is ${a ? 'present' : 'absent'} but the baseline has it ${e ? 'present' : 'absent'}`];
        return a && !same(actual.args[field], expected.args[field]) ? [`${field} is ${canonical(actual.args[field])}, expected ${canonical(expected.args[field])}`] : [];
    });
}

function compareRequests(id: string, actual: readonly NativeRequest[], expected: readonly NativeRequest[], what: string): void {
    check(id, actual.length === expected.length, `${what}: ${actual.length} native requests, expected ${expected.length} (${actual.map(r => r.method).join(', ') || 'none'})`);
    actual.forEach((request, i) => {
        const wanted = expected[i]!;
        check(id, request.method === wanted.method, `${what}: request ${i} is ${request.method}, expected ${wanted.method}`);
        const diff = fieldDiff(request, wanted);
        check(id, !diff.length, `${what}: ${request.method} ${diff.join('; ')}`);
        equal(id, request.args, wanted.args, `${what}: ${request.method} arguments differ`);
    });
}

/**
 * Inherit adds nothing to the plugin's native baseline. Each request must match
 * the baseline exactly: which execution fields are present or absent, their
 * values, and every other argument.
 */
export function expectNativeInherit(actual: readonly NativeRequest[], baseline: readonly NativeRequest[]): void {
    compareRequests('inherit-native-path', actual, baseline, 'inherit');
}

/** For baselines that truly omit them: the request carries no execution fields at all. */
export function expectNoExecutionFields(request: NativeRequest): void {
    const present = executionFields.filter(f => Object.hasOwn(request.args, f));
    if (present.length) throw new ConformanceError('no-execution-fields', `${request.method} carries ${present.join(', ')}`);
}

/**
 * The expected request after an override: the baseline request with the
 * projected fields applied and the provenance maps merged (baseline sources
 * first, then the override's). Use the result in `InvocationSubject.override.expected`.
 */
export function withOverride(request: NativeRequest, fields: SpawnFields | FirstSendFields): NativeRequest {
    const { executionInputSources, ...values } = fields;
    const base = request.args.executionInputSources;
    const sources = executionInputSources ? { ...(typeof base === 'object' && base !== null ? base : {}), ...executionInputSources } : base;
    return { method: request.method, args: { ...request.args, ...values, ...(sources === undefined ? {} : { executionInputSources: sources }) } };
}

export function invocationScenarios(subject: InvocationSubject, options: ScenarioOptions<InvocationScenarioId> = {}): readonly Scenario[] {
    const fresh = async (run: () => Promise<void>, refusal: boolean) => {
        const from = subject.requests().length;
        try { await run(); } catch (e) { if (!refusal) throw e; }
        return subject.requests().slice(from);
    };
    const skip = (id: InvocationScenarioId, gap?: string) => options.skip?.[id] ?? gap;
    return applicable([
        scenario('inherit-native-path', async () => {
            await subject.setChoice({ kind: 'inherit' });
            expectNativeInherit(await fresh(() => subject.invoke(), false), subject.baseline);
        }, skip('inherit-native-path')),
        scenario('override-exact-fields', async () => {
            await subject.setChoice(subject.override.choice);
            compareRequests('override-exact-fields', await fresh(() => subject.invoke(), false), subject.override.expected, 'override');
        }, skip('override-exact-fields')),
        scenario('refused-before-dispatch', async () => {
            for (const choice of subject.refusedChoices ?? []) {
                await subject.setChoice(choice);
                const sent = await fresh(() => subject.invoke(), true);
                check('refused-before-dispatch', !sent.length, `refused choice ${JSON.stringify(choice)} still sent ${sent.map(r => r.method).join(', ')}`);
            }
        }, skip('refused-before-dispatch', subject.refusedChoices?.length ? undefined : 'subject supplies no refusedChoices')),
        scenario('destination-changed-rejects-before-dispatch', async () => {
            await subject.setChoice(subject.override.choice);
            await subject.changeDestination!();
            const sent = await fresh(() => subject.invoke(), true);
            check('destination-changed-rejects-before-dispatch', !sent.length, `a changed destination still sent ${sent.map(r => r.method).join(', ')}`);
        }, skip('destination-changed-rejects-before-dispatch', subject.changeDestination ? undefined : 'subject supplies no changeDestination')),
    ], options);
}

