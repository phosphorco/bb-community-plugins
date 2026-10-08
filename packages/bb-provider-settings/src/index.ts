import { z } from 'zod';
const nonblank = z.string().refine(s => s.trim().length > 0, 'Must not be blank');
export const issueSchema = z.object({ code: z.enum(['malformed', 'choice-kind-not-allowed', 'provider-unavailable', 'provider-blocked', 'field-not-offered', 'catalog-unavailable', 'model-unavailable', 'selected-only-not-offered', 'reasoning-unsupported', 'service-tier-unsupported', 'sample-route-unreadable', 'owner-fields-would-be-lost', 'conflict']), message: z.string() }).passthrough();
export type Issue = z.infer<typeof issueSchema>;
export type IssueCode = Issue['code'];
export type ServiceTier = 'default' | 'fast';
export type ReasoningLevel = string;
const fieldsSchema = z.object({ providerId: nonblank.optional(), model: nonblank.optional(), reasoningLevel: nonblank.optional() }).strict();
const entrySchema = fieldsSchema.omit({ providerId: true });
const selectionSchema = fieldsSchema.required().extend({ serviceTier: z.enum(['default', 'fast']).optional() }).strict();
export const roleChoiceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inherit') }).strict(), z.object({ kind: z.literal('tuple'), selection: selectionSchema }).strict(),
    z.object({ kind: z.literal('fields'), fields: fieldsSchema }).strict(), z.object({ kind: z.literal('by-provider'), entries: z.record(nonblank, entrySchema) }).strict(),
]);
export type RoleChoice = z.infer<typeof roleChoiceSchema>;
export type ExecutionSelection = z.infer<typeof selectionSchema>;
const routeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('host'), hostId: nonblank }).strict(), z.object({ kind: z.literal('environment'), environmentId: nonblank }).strict()]);
export type CatalogRoute = z.infer<typeof routeSchema>;
const capFields = z.object({ model: z.enum(['demonstrated', 'unknown']), reasoningLevel: z.enum(['demonstrated', 'unknown']), reasoningWithoutModel: z.enum(['demonstrated', 'unknown']) });
const capabilitySchema = z.object({ evidence: nonblank, boundaries: z.array(z.enum(['fork-child', 'create'])).min(1), providers: z.record(z.string(), z.object({ blocked: z.array(z.string()).optional(), perBoundary: z.object({ 'fork-child': capFields.optional(), create: capFields.optional() }) })) });
export type RoleCapability = z.infer<typeof capabilitySchema>;
export const roleDescriptorV1Schema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), label: nonblank, description: z.string().optional(), choiceKinds: z.array(z.enum(['inherit', 'tuple', 'fields', 'by-provider'])).min(1), cascade: z.literal('caller-v1').optional(), providerPolicy: z.enum(['any', 'fixed-to-source']), saveValidation: z.enum(['destination', 'invocation']), capability: capabilitySchema.optional(), applies: nonblank, writable: z.boolean() }).passthrough().superRefine((r, c) => {
    if (r.providerPolicy === 'fixed-to-source' && !r.capability)
        c.addIssue({ code: 'custom', message: 'Fixed roles need capability' });
    if (r.choiceKinds.includes('fields') && r.cascade !== 'caller-v1')
        c.addIssue({ code: 'custom', message: 'Fields need cascade' });
});
export type RoleDescriptorV1 = z.infer<typeof roleDescriptorV1Schema>;
export const describeEnvelopeSchema = z.object({ protocol: z.literal('bb-provider-settings'), versions: z.array(z.number().int().min(1).max(1000)).min(1).max(16), roles: z.unknown().optional() }).passthrough();
export type DescribeEnvelope = z.infer<typeof describeEnvelopeSchema>;
export const readInputSchema = z.object({ version: z.literal(1), role: nonblank }).strict();
export const validateInputSchema = readInputSchema.extend({ choice: roleChoiceSchema, sampleRoute: routeSchema.optional() }).strict();
export const saveInputSchema = validateInputSchema.extend({ expectedFingerprint: nonblank }).strict();
const eligibilitySchema = z.discriminatedUnion('status', [z.object({ status: z.literal('verified'), route: routeSchema.nullable(), routeKind: z.enum(['destination', 'sample', 'primary-preview']) }).passthrough(), z.object({ status: z.literal('invalid'), issues: z.array(issueSchema), routeKind: z.enum(['destination', 'sample', 'primary-preview']) }).passthrough(), z.object({ status: z.literal('deferred'), reason: z.string() }).passthrough()]);
export type Eligibility = z.infer<typeof eligibilitySchema>;
export const readResultSchema = z.object({ version: z.literal(1), role: z.string(), stored: z.discriminatedUnion('status', [z.object({ status: z.literal('valid-shape'), choice: roleChoiceSchema, staticIssues: z.array(issueSchema) }).passthrough(), z.object({ status: z.literal('malformed'), issues: z.array(issueSchema), raw: z.string().optional() }).passthrough()]), fingerprint: z.string(), ownedFieldsDigest: z.string().nullable(), eligibility: z.object({ status: z.literal('unverified') }).passthrough(), ownedFieldsPresent: z.array(z.string()), rule: z.string(), destinationRoute: routeSchema.nullable(), destinationPreview: z.boolean() }).passthrough();
export type ReadResult = z.infer<typeof readResultSchema>;
export const validateResultSchema = z.object({ shapeIssues: z.array(issueSchema), eligibility: eligibilitySchema }).passthrough();
export type ValidateResult = z.infer<typeof validateResultSchema>;
export const saveResultSchema = z.discriminatedUnion('outcome', [z.object({ outcome: z.literal('saved'), read: readResultSchema, eligibility: eligibilitySchema }).passthrough(), z.object({ outcome: z.literal('rejected'), issues: z.array(issueSchema), eligibility: eligibilitySchema.optional() }).passthrough(), z.object({ outcome: z.literal('conflict'), current: readResultSchema }).passthrough()]);
export type SaveResult = z.infer<typeof saveResultSchema>;
export interface ProviderInfo {
    id: string;
    available: boolean;
    capabilities: {
        modelCatalogScope: 'host' | 'workspace';
        supportsServiceTier: boolean;
        permissionModes: string[];
    };
    serviceTiers?: {
        id: ServiceTier;
    }[];
}
export interface CatalogModel {
    id: string;
    model: string;
    routeProviderId?: string;
    isDefault: boolean;
    defaultReasoningEffort: string;
    supportedReasoningEfforts: {
        reasoningEffort: string;
    }[];
}
export interface ProviderCatalog {
    providerId: string;
    route: CatalogRoute | null;
    modelLoadError: {
        code: string;
        detail: string | null;
    } | null;
    models: CatalogModel[];
    selectedOnlyModels: CatalogModel[];
}
export interface ValidationPolicy {
    match: 'model' | 'id-or-model';
    routeQualifier: 'ignore' | 'must-equal-provider-when-present';
    candidates: 'models' | 'models+selected-only';
    modelLoadError: 'reject' | 'not-checked';
    tier: 'non-default-requires-support' | 'any-non-null-requires-support-and-listed' | 'not-validated';
}
export type DecodeResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    issues: Issue[];
};
export const issue = (code: IssueCode, message: string): Issue => ({ code, message });
export function decodeRoleChoice(input: unknown): DecodeResult<RoleChoice> {
    const r = roleChoiceSchema.safeParse(input);
    return r.success ? { ok: true, value: r.data } : { ok: false, issues: r.error.issues.map(i => issue('malformed', `${i.path.join('.')}: ${i.message}`)) };
}
export function normalizeRoleChoice(choice: RoleChoice): DecodeResult<RoleChoice> {
    const d = decodeRoleChoice(choice);
    if (!d.ok)
        return d;
    let c = d.value;
    if (c.kind === 'fields' && !Object.keys(c.fields).length)
        c = { kind: 'inherit' };
    if (c.kind === 'by-provider') {
        const entries = Object.fromEntries(Object.entries(c.entries).filter(([, v]) => Object.keys(v).length));
        c = Object.keys(entries).length ? { kind: 'by-provider', entries } : { kind: 'inherit' };
    }
    return { ok: true, value: c };
}
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}
export class ProviderSettingsCodecError extends Error {
    constructor(public issues: Issue[]) {
        super('Invalid role choice');
        this.name = 'ProviderSettingsCodecError';
    }
}
export function encodeRoleChoice(choice: RoleChoice): string {
    const n = normalizeRoleChoice(choice);
    if (!n.ok)
        throw new ProviderSettingsCodecError(n.issues);
    return canonical(n.value);
}
export function checkStatic(choice: RoleChoice, role: RoleDescriptorV1): Issue[] {
    if (!role.choiceKinds.includes(choice.kind))
        return [issue('choice-kind-not-allowed', 'Choice kind is not offered')];
    if (choice.kind !== 'by-provider')
        return [];
    return Object.entries(choice.entries).flatMap(([p, e]) => {
        const cap = role.capability;
        const support = cap && Object.hasOwn(cap.providers, p) ? cap.providers[p] : undefined;
        if (!support || support.blocked?.length)
            return [issue('provider-blocked', `Provider ${p} is blocked`)];
        for (const boundary of cap!.boundaries) {
            const b = support.perBoundary[boundary];
            if ((e.model !== undefined && b?.model !== 'demonstrated') || (e.reasoningLevel !== undefined && b?.reasoningLevel !== 'demonstrated') || (e.reasoningLevel !== undefined && e.model === undefined && b?.reasoningWithoutModel !== 'demonstrated'))
                return [issue('field-not-offered', `${p} fields lack evidence at ${boundary}`)];
        }
        return [];
    });
}
export function negotiateVersion(envelope: unknown, supported: readonly number[]): {
    kind: 'ok';
    version: 1;
    roles: RoleDescriptorV1[];
    versions: number[];
} | {
    kind: 'incompatible';
    reason: 'version' | 'schema';
    versions?: number[];
} {
    const e = describeEnvelopeSchema.safeParse(envelope);
    if (!e.success)
        return { kind: 'incompatible', reason: 'schema' };
    if (!e.data.versions.includes(1) || !supported.includes(1))
        return { kind: 'incompatible', reason: 'version', versions: e.data.versions };
    const r = z.array(roleDescriptorV1Schema).safeParse(e.data.roles);
    return r.success ? { kind: 'ok', version: 1, roles: r.data, versions: e.data.versions } : { kind: 'incompatible', reason: 'schema', versions: e.data.versions };
}
export function validateSelection(sel: ExecutionSelection, providers: readonly ProviderInfo[], catalog: ProviderCatalog, policy: ValidationPolicy, opts?: {
    newSelection?: boolean;
}): {
    ok: true;
    row: CatalogModel;
} | {
    ok: false;
    issues: Issue[];
} {
    const fail = (c: IssueCode, m: string) => ({ ok: false as const, issues: [issue(c, m)] });
    const p = providers.find(p => p.id === sel.providerId && p.available);
    if (!p)
        return fail('provider-unavailable', 'Provider unavailable');
    if (policy.modelLoadError === 'reject' && catalog.modelLoadError)
        return fail('catalog-unavailable', catalog.modelLoadError.code);
    const match = (r: CatalogModel) => (r.model === sel.model || (policy.match === 'id-or-model' && r.id === sel.model)) && (policy.routeQualifier === 'ignore' || !r.routeProviderId || r.routeProviderId === sel.providerId);
    const row = catalog.models.find(match) ?? (policy.candidates === 'models+selected-only' ? catalog.selectedOnlyModels.find(match) : undefined);
    if (!row)
        return fail(opts?.newSelection && catalog.selectedOnlyModels.some(match) ? 'selected-only-not-offered' : 'model-unavailable', 'Model unavailable');
    if (!row.supportedReasoningEfforts.some(e => e.reasoningEffort === sel.reasoningLevel))
        return fail('reasoning-unsupported', 'Reasoning unsupported');
    if (sel.serviceTier !== undefined && policy.tier !== 'not-validated') {
        const must = policy.tier === 'any-non-null-requires-support-and-listed' || sel.serviceTier !== 'default';
        if (must && (!p.capabilities.supportsServiceTier || (policy.tier === 'any-non-null-requires-support-and-listed' && !p.serviceTiers?.some(t => t.id === sel.serviceTier))))
            return fail('service-tier-unsupported', 'Tier unsupported');
    }
    return { ok: true, row };
}
export type Resolution = {
    kind: 'no-override';
} | {
    kind: 'rejected';
    issues: Issue[];
} | {
    kind: 'override';
    boundary: 'spawn' | 'first-send';
    fields: {
        providerId?: string | undefined;
        model?: string | undefined;
        reasoningLevel?: string | undefined;
        serviceTier?: ServiceTier | undefined;
    };
    deferredChecks?: 'reasoning-vs-native-default-model'[];
};
export interface ProviderBasis {
    providerId: string;
    model?: string;
    reasoningLevel?: string;
    boundary: 'fork-child' | 'create';
}
export function resolveTuple(choice: RoleChoice, providers: readonly ProviderInfo[], catalog: ProviderCatalog, policy: ValidationPolicy): Resolution {
    if (choice.kind === 'inherit')
        return { kind: 'no-override' };
    if (choice.kind !== 'tuple')
        return { kind: 'rejected', issues: [issue('choice-kind-not-allowed', 'Expected tuple')] };
    const r = validateSelection(choice.selection, providers, catalog, policy);
    return r.ok ? { kind: 'override', boundary: 'spawn', fields: { ...choice.selection, model: r.row.model } } : { kind: 'rejected', issues: r.issues };
}
export async function resolveCallerCascade(fields: Extract<RoleChoice, {
    kind: 'fields';
}>['fields'], caller: ExecutionSelection, providers: readonly ProviderInfo[], catalogFor: (p: string) => Promise<ProviderCatalog>, policy: ValidationPolicy): Promise<Resolution> {
    const providerId = fields.providerId ?? caller.providerId;
    const p = providers.find(p => p.id === providerId && p.available);
    if (!p)
        return { kind: 'rejected', issues: [issue('provider-unavailable', 'Provider unavailable')] };
    const catalog = await catalogFor(providerId);
    const rows = [...catalog.models, ...catalog.selectedOnlyModels];
    const row = fields.model ? rows.find(r => r.id === fields.model || r.model === fields.model) : (providerId === caller.providerId ? rows.find(r => r.model === caller.model) : undefined) ?? rows.find(r => r.isDefault);
    if (!row)
        return { kind: 'rejected', issues: [issue('model-unavailable', 'Model unavailable')] };
    const reasoningLevel = fields.reasoningLevel ?? (providerId === caller.providerId && row.model === caller.model ? caller.reasoningLevel : row.defaultReasoningEffort);
    const sel: ExecutionSelection = { providerId, model: row.model, reasoningLevel, ...(p.capabilities.supportsServiceTier ? { serviceTier: caller.serviceTier ?? 'default' } : {}) };
    const r = validateSelection(sel, providers, catalog, { ...policy, modelLoadError: 'not-checked', tier: 'not-validated' });
    return r.ok ? { kind: 'override', boundary: 'spawn', fields: sel } : { kind: 'rejected', issues: r.issues };
}
export function resolveByProvider(choice: RoleChoice, basis: ProviderBasis, providers: readonly ProviderInfo[], catalog: ProviderCatalog | null, policy: ValidationPolicy, capability: RoleCapability): Resolution {
    if (choice.kind === 'inherit' || choice.kind === 'by-provider' && !Object.hasOwn(choice.entries, basis.providerId))
        return { kind: 'no-override' };
    if (choice.kind !== 'by-provider')
        return { kind: 'rejected', issues: [issue('choice-kind-not-allowed', 'Expected provider entries')] };
    const e = choice.entries[basis.providerId]!;
    const issues = checkStatic({ kind: 'by-provider', entries: { [basis.providerId]: e } }, { id: 'role', label: 'Role', choiceKinds: ['by-provider'], providerPolicy: 'fixed-to-source', saveValidation: 'invocation', capability, applies: 'Invocation', writable: true });
    if (issues.length)
        return { kind: 'rejected', issues };
    if (!providers.some(p => p.id === basis.providerId && p.available))
        return { kind: 'rejected', issues: [issue('provider-unavailable', 'Provider unavailable')] };
    const boundary = basis.boundary === 'create' ? 'spawn' : 'first-send';
    if (basis.boundary === 'create' && !e.model)
        return { kind: 'override', boundary, fields: { ...e }, deferredChecks: ['reasoning-vs-native-default-model'] };
    if (!catalog)
        return { kind: 'rejected', issues: [issue('catalog-unavailable', 'Catalog missing')] };
    const model = e.model ?? basis.model ?? '';
    const row = [...catalog.models, ...catalog.selectedOnlyModels].find(r => r.model === model || (policy.match === 'id-or-model' && r.id === model));
    const r = validateSelection({ providerId: basis.providerId, model, reasoningLevel: e.reasoningLevel ?? basis.reasoningLevel ?? row?.defaultReasoningEffort ?? '' }, providers, catalog, policy);
    return (r.ok || e.reasoningLevel === undefined && r.issues.every(i => i.code === 'reasoning-unsupported')) ? { kind: 'override', boundary, fields: { ...(e.model !== undefined ? { model: (r.ok ? r.row : row!).model } : {}), ...(e.reasoningLevel !== undefined ? { reasoningLevel: e.reasoningLevel } : {}) } } : { kind: 'rejected', issues: r.issues };
}
export type Provenance = 'explicit-map' | 'omit-map';
export type SpawnFields = Partial<ExecutionSelection> & {
    executionInputSources?: Partial<Record<keyof ExecutionSelection, 'explicit'>>;
};
export type FirstSendFields = Pick<SpawnFields, 'model' | 'reasoningLevel'> & {
    executionInputSources?: Partial<Record<'model' | 'reasoningLevel', 'explicit'>>;
};
export class ProjectionBoundaryError extends Error {
    constructor() {
        super('Invalid projection boundary');
        this.name = 'ProjectionBoundaryError';
    }
}
function project(r: Resolution, p: Provenance, boundary: 'spawn' | 'first-send'): SpawnFields {
    if (r.kind === 'no-override')
        return {};
    if (r.kind !== 'override' || r.boundary !== boundary || (boundary === 'first-send' && (r.fields.providerId !== undefined || r.fields.serviceTier !== undefined)))
        throw new ProjectionBoundaryError();
    const fields = Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v !== undefined));
    return { ...fields, ...(p === 'explicit-map' && Object.keys(fields).length ? { executionInputSources: Object.fromEntries(Object.keys(fields).map(k => [k, 'explicit'])) } : {}) };
}
export function projectSpawnOverride(r: Resolution, p: Provenance): SpawnFields {
    return project(r, p, 'spawn');
}
export function projectFirstSendOverride(r: Resolution, p: Provenance): FirstSendFields {
    return project(r, p, 'first-send') as FirstSendFields;
}
export type OwnerErrorKind = 'absent' | 'vanished' | 'host-incompatible' | 'unavailable' | 'incompatible' | 'owner-error' | 'unauthorized' | 'cancelled' | 'transient';
export function classifyOwnerError(error: unknown): OwnerErrorKind {
    const e = error as {
        name?: string;
        status?: number;
        body?: unknown;
        code?: string;
    };
    if (e?.name === 'AbortError')
        return 'cancelled';
    const body = e?.body;
    const message = typeof body === 'string' ? body : body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
    const code = typeof body === 'object' && body !== null ? (body as {
        error?: {
            code?: string;
        };
    }).error?.code : e?.code;
    if (e?.status === 404) {
        if (code === 'unknown_method')
            return 'absent';
        if (/unknown plugin/i.test(message))
            return 'vanished';
        return 'host-incompatible';
    }
    if (e?.status === 503)
        return /not running \(status:/i.test(message) ? 'unavailable' : 'transient';
    if (e?.status === 401 || e?.status === 403)
        return 'unauthorized';
    if (code === 'invalid_input' || code === 'invalid_output' || e?.name === 'ZodError')
        return 'incompatible';
    if (e?.status === 500)
        return 'owner-error';
    return 'transient';
}
export async function fingerprintValues(values: readonly unknown[]): Promise<string> {
    const bytes = new TextEncoder().encode(canonical(values));
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function reconcileUnknownSave(before: ReadResult, submitted: RoleChoice, fresh: ReadResult): 'matches-submitted' | 'unchanged' | 'conflicting' {
    if (fresh.stored.status !== 'valid-shape' || fresh.ownedFieldsDigest !== before.ownedFieldsDigest)
        return 'conflicting';
    if (canonical(fresh.stored.choice) === canonical(submitted))
        return 'matches-submitted';
    if (before.stored.status === 'valid-shape' && canonical(fresh.stored.choice) === canonical(before.stored.choice))
        return 'unchanged';
    return 'conflicting';
}
