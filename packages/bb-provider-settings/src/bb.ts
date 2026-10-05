import { z } from 'zod';
import type { BbPluginApi, StandardSchemaV1, JsonValue } from '@get-bb/plugin-sdk';
import type { PluginBrowserBbSdk } from '@get-bb/plugin-sdk/app';
import { readInputSchema, validateInputSchema, saveInputSchema, readResultSchema, validateResultSchema, saveResultSchema, describeEnvelopeSchema, roleDescriptorV1Schema, negotiateVersion, checkStatic, normalizeRoleChoice, fingerprintValues, validateSelection, issue, classifyOwnerError } from './index.js';
import type { RoleDescriptorV1, ValidationPolicy, RoleChoice, DecodeResult, Issue, CatalogRoute, ProviderInfo, ProviderCatalog, ExecutionSelection, ReadResult, ValidateResult, SaveResult, OwnerErrorKind, Eligibility } from './index.js';
function sdkSchema<T>(schema: z.ZodType<T>): StandardSchemaV1<T> {
    return { '~standard': { version: 1, vendor: 'bb-provider-settings', jsonSchema: { input: () => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), output: () => z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) }, validate(value) {
                const r = schema.safeParse(value);
                return r.success ? { value: r.data } : { issues: r.error.issues.map(i => ({ message: i.message, path: i.path })) };
            } } };
}
export type CatalogSdk = Pick<BbPluginApi['sdk'], 'providers'> | Pick<PluginBrowserBbSdk, 'providers'>;
export type OwnerSdk = Pick<BbPluginApi['sdk'], 'plugins'> | Pick<PluginBrowserBbSdk, 'plugins'>;
export interface OwnerRolePort {
    descriptor: RoleDescriptorV1;
    policy: ValidationPolicy;
    readValues(): Promise<readonly unknown[]>;
    decode(values: readonly unknown[]): {
        choice: DecodeResult<RoleChoice>;
        owned: unknown;
        rule: string;
    };
    preserveOwned?(values: readonly unknown[], next: RoleChoice): Issue[];
    destination?(): Promise<{
        route: CatalogRoute | null;
        preview: boolean;
    } | {
        unresolved: string;
    }>;
    checkSampleRoute(route: CatalogRoute): Promise<Issue[]>;
    catalog(route: CatalogRoute | null, providerId: string): Promise<{
        providers: ProviderInfo[];
        catalog: ProviderCatalog;
    }>;
    featureChecks?(sel: ExecutionSelection, route: CatalogRoute | null): Promise<Issue[]>;
    write(next: RoleChoice, values: readonly unknown[]): Promise<void>;
}
export async function readCatalog(sdk: CatalogSdk, route: CatalogRoute | null, providerId: string): Promise<{
    providers: ProviderInfo[];
    catalog: ProviderCatalog;
}> {
    const routing = route?.kind === 'host' ? { hostId: route.hostId } : route?.kind === 'environment' ? { environmentId: route.environmentId } : {};
    const providers = await sdk.providers.list(routing);
    const result = await sdk.providers.models({ providerId, ...routing });
    return { providers: providers as ProviderInfo[], catalog: { ...result, providerId, route } as ProviderCatalog };
}
export function registerProviderSettingsOwner(bb: Pick<BbPluginApi, 'rpc'>, roles: readonly OwnerRolePort[]): void {
    roles = roles.map(port => ({ ...port, descriptor: roleDescriptorV1Schema.parse(structuredClone(port.descriptor)) }));
    const map = new Map(roles.map(p => [p.descriptor.id, p]));
    if (map.size !== roles.length)
        throw new Error('Duplicate role id');
    const get = (id: string) => {
        const p = map.get(id);
        if (!p)
            throw new Error(`Unknown role: ${id}`);
        return p;
    };
    async function destination(p: OwnerRolePort) {
        try { return await p.destination?.(); }
        catch (e) { return { unresolved: e instanceof Error ? e.message : String(e) }; }
    }
    async function read(p: OwnerRolePort, values?: readonly unknown[]): Promise<ReadResult> {
        values ??= await p.readValues();
        const d = p.decode(values);
        const owned = d.owned;
        const dest = p.descriptor.saveValidation === 'destination' ? await destination(p) : undefined;
        return { version: 1, role: p.descriptor.id, stored: d.choice.ok ? { status: 'valid-shape', choice: d.choice.value, staticIssues: checkStatic(d.choice.value, p.descriptor) } : { status: 'malformed', issues: d.choice.issues, ...(typeof values[0] === 'string' ? { raw: values[0] } : {}) }, fingerprint: await fingerprintValues(values), ownedFieldsDigest: owned === null || owned === undefined ? null : await fingerprintValues([owned]), ownedFieldsPresent: owned && typeof owned === 'object' ? Object.keys(owned).filter(k => Boolean((owned as Record<string, unknown>)[k])) : [], eligibility: { status: 'unverified' }, rule: d.rule, destinationRoute: dest && 'route' in dest ? dest.route : null, destinationPreview: dest && 'preview' in dest ? dest.preview : false, ...(dest && 'unresolved' in dest ? { destinationUnresolved: dest.unresolved } : {}) };
    }
    async function validate(p: OwnerRolePort, choice: RoleChoice, sampleRoute?: CatalogRoute): Promise<ValidateResult> {
        const shapeIssues = checkStatic(choice, p.descriptor);
        const deferred: Eligibility = { status: 'deferred', reason: 'Validated against the invocation context' };
        if (shapeIssues.length || choice.kind === 'inherit')
            return { shapeIssues, eligibility: deferred };
        let route: CatalogRoute | null = null, routeKind: 'destination' | 'sample' | 'primary-preview' = 'sample';
        if (p.descriptor.saveValidation === 'destination') {
            const d = await destination(p);
            if (!d || 'unresolved' in d)
                return { shapeIssues, eligibility: { status: 'invalid', routeKind: 'destination', issues: [issue('catalog-unavailable', d && 'unresolved' in d ? d.unresolved : 'Destination unresolved')] } };
            route = d.route;
            routeKind = d.preview ? 'primary-preview' : 'destination';
        }
        else {
            if (!sampleRoute)
                return { shapeIssues, eligibility: deferred };
            route = sampleRoute;
            const unreadable = await p.checkSampleRoute(sampleRoute);
            if (unreadable.length)
                return { shapeIssues, eligibility: { status: 'invalid', routeKind, issues: unreadable } };
        }
        const sels: {
            providerId: string;
            model?: string | undefined;
            reasoningLevel?: string | undefined;
            serviceTier?: 'default' | 'fast' | undefined;
        }[] = choice.kind === 'tuple' ? [choice.selection] : choice.kind === 'fields' && choice.fields.providerId ? [{ ...choice.fields, providerId: choice.fields.providerId }] : choice.kind === 'by-provider' ? Object.entries(choice.entries).map(([providerId, e]) => ({ providerId, ...e })) : [];
        if (!sels.length)
            return { shapeIssues, eligibility: deferred };
        const partial = sels.some(s => !s.model);
        const explicit = sels.filter(s => s.model);
        const issues: Issue[] = [];
        try {
            for (const sel of explicit) {
                const c = await p.catalog(route, sel.providerId);
                const row = [...c.catalog.models, ...c.catalog.selectedOnlyModels].find(r => r.model === sel.model || (p.policy.match === 'id-or-model' && r.id === sel.model));
                const full: ExecutionSelection = { providerId: sel.providerId, model: sel.model!, reasoningLevel: sel.reasoningLevel ?? row?.defaultReasoningEffort ?? '', ...(sel.serviceTier ? { serviceTier: sel.serviceTier } : {}) };
                const r = validateSelection(full, c.providers, c.catalog, p.policy, { newSelection: true });
                if (!r.ok)
                    issues.push(...r.issues.filter(i => sel.reasoningLevel !== undefined || i.code !== 'reasoning-unsupported'));
                else
                    issues.push(...await p.featureChecks?.(full, route) ?? []);
            }
        }
        catch (e) {
            issues.push(issue('catalog-unavailable', e instanceof Error ? e.message : String(e)));
        }
        return { shapeIssues, eligibility: issues.length ? { status: 'invalid', issues, routeKind } : partial ? deferred : { status: 'verified', route, routeKind } };
    }
    const contract = { providerSettingsDescribe: { input: sdkSchema(z.unknown()), output: sdkSchema(describeEnvelopeSchema) }, providerSettingsV1Read: { input: sdkSchema(readInputSchema), output: sdkSchema(readResultSchema) }, providerSettingsV1Validate: { input: sdkSchema(validateInputSchema), output: sdkSchema(validateResultSchema) }, providerSettingsV1Save: { input: sdkSchema(saveInputSchema), output: sdkSchema(saveResultSchema) } };
    bb.rpc.register(contract, {
        providerSettingsDescribe: () => ({ protocol: 'bb-provider-settings' as const, versions: [1], roles: roles.map(p => p.descriptor) }),
        providerSettingsV1Read: input => read(get(input.role)),
        providerSettingsV1Validate: input => validate(get(input.role), input.choice, input.sampleRoute),
        providerSettingsV1Save: async (input): Promise<SaveResult> => {
            const p = get(input.role), n = normalizeRoleChoice(input.choice);
            if (!n.ok)
                return { outcome: 'rejected', issues: n.issues };
            if (!p.descriptor.writable)
                return { outcome: 'rejected', issues: [issue('field-not-offered', 'Role is read-only')] };
            const values = await p.readValues();
            const current = await read(p, values);
            if (current.fingerprint !== input.expectedFingerprint)
                return { outcome: 'conflict', current };
            const preserved = p.preserveOwned?.(values, n.value) ?? [];
            if (preserved.length)
                return { outcome: 'rejected', issues: preserved };
            const v = await validate(p, n.value, input.sampleRoute);
            if (v.shapeIssues.length)
                return { outcome: 'rejected', issues: v.shapeIssues, eligibility: v.eligibility };
            if (p.descriptor.saveValidation === 'destination' && v.eligibility.status === 'invalid')
                return { outcome: 'rejected', issues: v.eligibility.issues, eligibility: v.eligibility };
            const latest = await p.readValues();
            if (await fingerprintValues(latest) !== current.fingerprint)
                return { outcome: 'conflict', current: await read(p, latest) };
            await p.write(n.value, latest);
            return { outcome: 'saved', read: await read(p), eligibility: v.eligibility };
        },
    }, { experimental_discoverable: true });
}
export class OwnerCallError extends Error {
    readonly kind: OwnerErrorKind;
    constructor(public cause: unknown) {
        super('Owner call failed');
        this.name = 'OwnerCallError';
        this.kind = classifyOwnerError(cause);
    }
}
export interface OwnerClient {
    readonly pluginId: string;
    describe(signal?: AbortSignal): Promise<ReturnType<typeof negotiateVersion>>;
    read(role: string, signal?: AbortSignal): Promise<ReadResult>;
    validate(role: string, choice: RoleChoice, sampleRoute?: CatalogRoute, signal?: AbortSignal): Promise<ValidateResult>;
    save(role: string, choice: RoleChoice, expectedFingerprint: string, sampleRoute?: CatalogRoute): Promise<SaveResult>;
}
export function createOwnerClient(sdk: OwnerSdk, pluginId: string): OwnerClient {
    async function call<T>(method: string, input: unknown, outputSchema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
        try {
            return await sdk.plugins.callRpc({ pluginId, method, input: JSON.parse(JSON.stringify(input)) as JsonValue, outputSchema, ...(signal ? { signal } : {}) });
        }
        catch (e) {
            throw new OwnerCallError(e);
        }
    }
    return { pluginId, describe: async (signal) => negotiateVersion(await call('providerSettingsDescribe', null, z.unknown(), signal), [1]), read: (role, signal) => call('providerSettingsV1Read', { version: 1, role }, readResultSchema, signal), validate: (role, choice, sampleRoute, signal) => call('providerSettingsV1Validate', { version: 1, role, choice, ...(sampleRoute ? { sampleRoute } : {}) }, validateResultSchema, signal), save: (role, choice, expectedFingerprint, sampleRoute) => call('providerSettingsV1Save', { version: 1, role, choice, expectedFingerprint, ...(sampleRoute ? { sampleRoute } : {}) }, saveResultSchema) };
}
export interface OwnerRow {
    pluginId: string;
    displayName: string | null;
    listedStatus: string;
    state: 'pending' | 'participant' | 'absent' | 'incompatible' | 'unavailable' | 'error';
    versions?: number[];
    roles?: RoleDescriptorV1[];
    error?: OwnerErrorKind;
}
export async function enumerateProviderSettingsOwners(opts: {
    sdk: OwnerSdk;
    signal: AbortSignal;
    concurrency?: number;
    timeoutMs?: number;
    onRow(row: OwnerRow): void;
}): Promise<{
    rows: OwnerRow[];
    omittedCount: number;
}> {
    const listed = await opts.sdk.plugins.list({ signal: opts.signal });
    if (opts.signal.aborted)
        return { rows: [], omittedCount: 0 };
    const all = listed.plugins;
    const eligible = all.filter(p => p.status === 'running' || p.status === 'degraded');
    const rows: OwnerRow[] = [];
    let index = 0;
    async function worker() {
        while (!opts.signal.aborted && index < eligible.length) {
            const p = eligible[index++]!;
            const row: OwnerRow = { pluginId: p.id, displayName: p.name ?? null, listedStatus: p.status, state: 'pending' };
            opts.onRow({ ...row });
            const c = new AbortController();
            const abort = () => c.abort();
            opts.signal.addEventListener('abort', abort, { once: true });
            if (opts.signal.aborted)
                c.abort();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let cancelListener: (() => void) | undefined;
            try {
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        reject(Object.assign(new Error('Describe timeout'), { name: 'TimeoutError' }));
                        c.abort();
                    }, Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.min(5000, opts.timeoutMs!)) : 5000);
                });
                const cancelled = new Promise<never>((_, reject) => {
                    cancelListener = () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
                    c.signal.addEventListener('abort', cancelListener, { once: true });
                });
                const d = await Promise.race([createOwnerClient(opts.sdk, p.id).describe(c.signal), timeout, cancelled]);
                if (d.kind === 'ok') {
                    row.state = 'participant';
                    row.roles = d.roles;
                    row.versions = d.versions;
                }
                else {
                    row.state = 'incompatible';
                    if (d.versions)
                        row.versions = d.versions;
                }
            }
            catch (e) {
                const kind = e instanceof OwnerCallError ? e.kind : classifyOwnerError(e);
                row.error = kind;
                row.state = kind === 'absent' ? 'absent' : kind === 'incompatible' || kind === 'host-incompatible' ? 'incompatible' : kind === 'unavailable' || kind === 'vanished' ? 'unavailable' : 'error';
            }
            finally {
                clearTimeout(timer);
                if (cancelListener)
                    c.signal.removeEventListener('abort', cancelListener);
                opts.signal.removeEventListener('abort', abort);
            }
            if (!opts.signal.aborted) {
                rows.push(row);
                opts.onRow({ ...row });
            }
        }
    }
    await Promise.all(Array.from({ length: Number.isFinite(opts.concurrency) ? Math.max(1, Math.min(4, Math.floor(opts.concurrency!))) : 4 }, () => worker()));
    return { rows: rows.sort((a, b) => a.pluginId.localeCompare(b.pluginId)), omittedCount: all.length - eligible.length };
}
