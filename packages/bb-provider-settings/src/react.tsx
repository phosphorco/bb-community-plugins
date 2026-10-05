import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { experimental_ProviderModelPicker, type ExperimentalProviderModelPickerValue } from '@get-bb/plugin-sdk/app';
import { normalizeRoleChoice, checkStatic, reconcileUnknownSave } from './index.js';
import type { RoleChoice, RoleDescriptorV1, ExecutionSelection, CatalogRoute, ProviderCatalog, ReadResult, ValidateResult, Issue } from './index.js';
import { createOwnerClient, enumerateProviderSettingsOwners, readCatalog, OwnerCallError } from './bb.js';
import type { OwnerClient, CatalogSdk, OwnerSdk, OwnerRow } from './bb.js';
export type BrowseSeed = {
    selection: ExecutionSelection;
    label: string;
};
export interface RoleSettingsEditorProps {
    client: OwnerClient;
    role: RoleDescriptorV1;
    catalogSdk: CatalogSdk;
    sampleRoute?: CatalogRoute;
    providerEntry?: string;
    seed?: (route: CatalogRoute | null, catalog: ProviderCatalog) => Promise<BrowseSeed | null>;
}
// Consumers compile Tailwind from their own sources only, so this package
// carries its own small stylesheet. Every color is a live BB theme token.
const STYLES = `
.bbps{color:var(--foreground);font-size:var(--text-sm,.8125rem);line-height:1.45;min-width:0}
.bbps *,.bbps *::before,.bbps *::after{box-sizing:border-box}
.bbps [hidden]{display:none!important}
.bbps p,.bbps h3,.bbps h4,.bbps dl,.bbps dd,.bbps ul{margin:0}
.bbps ul{padding-left:1.1em}
.bbps-stack{display:grid;gap:.625rem;min-width:0}
.bbps-muted{color:var(--muted-foreground)}
.bbps-small{font-size:var(--text-xs,.75rem);line-height:1.4}
.bbps-wrap{overflow-wrap:anywhere}
.bbps-btn{display:inline-flex;align-items:center;justify-content:center;gap:.375rem;min-height:1.75rem;padding:.25rem .625rem;border:1px solid var(--input,var(--border));border-radius:calc(var(--radius,.5rem) - 2px);background:transparent;color:var(--foreground);font:inherit;font-size:var(--text-xs,.75rem);font-weight:500;line-height:1.2;white-space:nowrap;cursor:pointer;transition:background-color .12s,color .12s,border-color .12s,opacity .12s}
.bbps-btn:hover:not(:disabled){background:var(--state-hover)}
.bbps-btn:focus-visible,.bbps-trigger:focus-visible,.bbps-details>summary:focus-visible,.bbps-input:focus-visible,.bbps-select:focus-visible{outline:none;box-shadow:0 0 0 1px var(--ring)}
.bbps-btn:disabled{opacity:.5;cursor:default}
.bbps-btn[data-variant=primary]{border-color:transparent;background:var(--foreground);color:var(--background)}
.bbps-btn[data-variant=primary]:hover:not(:disabled){background:color-mix(in oklab,var(--foreground) 88%,transparent)}
.bbps-btn[data-variant=ghost]{border-color:transparent;color:var(--muted-foreground)}
.bbps-btn[data-variant=ghost]:hover:not(:disabled){color:var(--foreground)}
.bbps-btn[data-variant=danger]{color:var(--destructive-text,var(--destructive))}
.bbps-row{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem;min-width:0}
.bbps-current{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:.5rem;row-gap:.25rem;min-width:0}
.bbps-label{color:var(--muted-foreground);font-size:var(--text-xs,.75rem)}
.bbps-choice{font-weight:500;overflow-wrap:anywhere;min-width:0}
.bbps-chip{display:inline-flex;align-items:center;gap:.25rem;padding:.0625rem .4375rem;border:1px solid var(--border);border-radius:999px;color:var(--muted-foreground);font-size:var(--text-2xs,.6875rem);font-weight:500;line-height:1.35;white-space:nowrap}
.bbps-chip[data-tone=success]{color:var(--success);border-color:color-mix(in oklab,var(--success) 40%,transparent)}
.bbps-chip[data-tone=danger]{color:var(--destructive-text,var(--destructive));background:var(--surface-destructive,transparent);border-color:var(--surface-destructive-border,var(--border))}
.bbps-chip[data-tone=warning]{color:var(--warning-text,var(--warning));background:var(--surface-attention,transparent);border-color:color-mix(in oklab,var(--warning,currentColor) 35%,transparent)}
.bbps-callout{display:grid;gap:.375rem;padding:.5rem .625rem;border:1px solid var(--border);border-radius:calc(var(--radius,.5rem) - 2px);font-size:var(--text-xs,.75rem);overflow-wrap:anywhere}
.bbps-callout[data-tone=danger]{color:var(--destructive-text,var(--destructive));background:var(--surface-destructive,transparent);border-color:var(--surface-destructive-border,var(--border))}
.bbps-callout[data-tone=warning]{color:var(--warning-text,var(--foreground));background:var(--surface-attention,transparent);border-color:color-mix(in oklab,var(--warning,currentColor) 35%,transparent)}
.bbps-callout[data-tone=draft]{background:var(--surface-selected,transparent);border-color:var(--surface-selected-border,var(--border))}
.bbps-callout .bbps-row{margin-top:.125rem}
.bbps-edit{display:grid;gap:.5rem;padding:.625rem;border:1px solid var(--border);border-radius:calc(var(--radius,.5rem) - 2px);background:var(--surface-recessed,transparent);min-width:0}
.bbps-fields{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:.625rem;row-gap:.375rem}
.bbps-select,.bbps-input{min-height:1.75rem;padding:.1875rem .5rem;border:1px solid var(--input,var(--border));border-radius:calc(var(--radius,.5rem) - 2px);background:var(--background);color:var(--foreground);font:inherit;font-size:var(--text-xs,.75rem)}
.bbps-select:disabled{opacity:.5}
.bbps-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:.5rem;padding-top:.625rem;border-top:1px solid var(--border-hairline,var(--border))}
.bbps-footer>.bbps-status{margin-right:auto}
.bbps-status{display:inline-flex;align-items:center;gap:.375rem;color:var(--muted-foreground);font-size:var(--text-xs,.75rem)}
.bbps-alert{color:var(--destructive-text,var(--destructive));font-size:var(--text-xs,.75rem);overflow-wrap:anywhere}
.bbps-details>summary{display:inline-flex;align-items:center;gap:.25rem;color:var(--muted-foreground);font-size:var(--text-xs,.75rem);cursor:pointer;list-style:none;border-radius:4px}
.bbps-details>summary::-webkit-details-marker{display:none}
.bbps-details>summary:hover{color:var(--foreground)}
.bbps-details[open]>summary .bbps-chevron{transform:rotate(90deg)}
.bbps-details dl{display:grid;grid-template-columns:minmax(5.5rem,auto) minmax(0,1fr);gap:.25rem .75rem;margin-top:.375rem;font-size:var(--text-xs,.75rem)}
.bbps-details dt{color:var(--muted-foreground)}
.bbps-details dd{overflow-wrap:anywhere}
.bbps-support{width:100%;max-width:28rem;margin-top:.5rem;border-collapse:collapse;font-size:var(--text-xs,.75rem)}
.bbps-support caption{text-align:left;font-weight:600;padding-bottom:.25rem}
.bbps-support th,.bbps-support td{padding:.25rem .5rem .25rem 0;text-align:left;border-bottom:1px solid var(--border-hairline,var(--border));font-weight:400}
.bbps-support thead th{color:var(--muted-foreground)}
.bbps-support td[data-support=available]{color:var(--success)}
.bbps-support td[data-support=unverified]{color:var(--muted-foreground)}
.bbps-support td[data-support=with-model]{color:var(--foreground)}
.bbps-support td[data-support=no-overrides]{color:var(--muted-foreground)}
.bbps-step{display:grid;gap:.375rem;min-width:0}
.bbps-step-title{font-size:var(--text-xs,.75rem);font-weight:600}
.bbps-step-title span{display:inline-grid;place-items:center;width:1.1rem;height:1.1rem;margin-right:.375rem;border-radius:999px;background:var(--muted,var(--state-hover));font-size:var(--text-2xs,.6875rem)}
.bbps-chevron{flex:none;width:.875rem;height:.875rem;color:var(--muted-foreground);transition:transform .15s}
.bbps-spinner{flex:none;width:.75rem;height:.75rem;border:1.5px solid currentColor;border-right-color:transparent;border-radius:999px;animation:bbps-spin .7s linear infinite}
@keyframes bbps-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.bbps-spinner{animation-duration:2.4s}.bbps-chevron,.bbps-btn{transition:none}}
.bbps-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.bbps-search{position:relative;flex:1 1 14rem;max-width:22rem}
.bbps-search .bbps-input{width:100%;min-height:2rem;padding-left:1.75rem}
.bbps-search svg{position:absolute;left:.5rem;top:50%;width:.875rem;height:.875rem;transform:translateY(-50%);color:var(--muted-foreground);pointer-events:none}
.bbps-toolbar>.bbps-status{margin-left:auto}
.bbps-groups{display:grid;gap:1rem}
.bbps-group{display:grid;gap:.375rem;min-width:0}
.bbps-group-title{margin:0;color:var(--muted-foreground);font-size:var(--text-xs,.75rem);font-weight:600;overflow-wrap:anywhere}
.bbps-card{border:1px solid var(--border);border-radius:var(--radius,.5rem);background:var(--card,transparent);overflow:hidden}
.bbps-card>*+*{border-top:1px solid var(--border-hairline,var(--border))}
.bbps-trigger{display:flex;width:100%;align-items:center;gap:.75rem;padding:.625rem .875rem;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s}
.bbps-trigger:hover{background:var(--state-hover)}
.bbps-trigger[aria-expanded=true] .bbps-chevron{transform:rotate(90deg)}
.bbps-trigger-text{display:grid;flex:1;gap:.125rem;min-width:0}
.bbps-trigger-title{font-weight:500;overflow-wrap:anywhere}
.bbps-trigger-summary{color:var(--muted-foreground);font-size:var(--text-xs,.75rem);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bbps-panel{padding:.75rem .875rem .875rem;border-top:1px solid var(--border-hairline,var(--border))}
.bbps-card>.bbps-panel{border-top:0}
.bbps-note{padding:.625rem .875rem;color:var(--muted-foreground);font-size:var(--text-xs,.75rem);overflow-wrap:anywhere}
@media (max-width:520px){.bbps-trigger{padding:.625rem .75rem}.bbps-panel{padding:.625rem .75rem .75rem}.bbps-footer{justify-content:stretch}.bbps-footer>.bbps-btn{flex:1}.bbps-footer>.bbps-status{flex-basis:100%}.bbps-details dl{grid-template-columns:1fr}.bbps-details dt{margin-top:.25rem}}
`;
function Styles() {
    // React 19 hoists and de-duplicates this resource by href.
    return <style href="bb-provider-settings-ui-v1" precedence="default">{STYLES}</style>;
}
function Chevron() {
    return <svg className="bbps-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>;
}
function Spinner() {
    return <span className="bbps-spinner" aria-hidden="true"/>;
}
// Directory-private link. The public editor props stay unchanged.
interface EditorLink {
    readonly embedded: true;
    /** Changes on explicit refresh or reconnect. */
    readonly generation: number;
    /** False while the row is collapsed; the editor stays mounted. */
    readonly visible: boolean;
    report(state: EditorReport): void;
}
interface EditorReport {
    read: ReadResult | null;
    dirty: boolean;
    saving: boolean;
}
const EditorLinkContext = createContext<EditorLink | null>(null);
function routeLabel(route: CatalogRoute | null): string {
    return route ? `${route.kind === 'host' ? 'machine' : 'environment'} ${route.kind === 'host' ? route.hostId : route.environmentId}` : 'the default catalog';
}
const fieldLabel = { providerId: 'Provider', model: 'Model', reasoningLevel: 'Reasoning' } as const;
function choiceText(choice: RoleChoice): string {
    if (choice.kind === 'inherit')
        return 'Inherit';
    if (choice.kind === 'tuple')
        return [`${choice.selection.providerId} / ${choice.selection.model}`, choice.selection.reasoningLevel, choice.selection.serviceTier].filter(Boolean).join(' · ');
    if (choice.kind === 'fields') {
        const keys = ['providerId', 'model', 'reasoningLevel'] as const;
        const set = keys.filter(k => choice.fields[k] !== undefined), inherited = keys.filter(k => choice.fields[k] === undefined);
        if (!set.length)
            return 'Inherit';
        return [...set.map(k => `${fieldLabel[k]}: ${choice.fields[k]}`), ...(inherited.length ? [`${inherited.map(k => fieldLabel[k]).join(', ')} inherited`] : [])].join(' · ');
    }
    return Object.entries(choice.entries).map(([p, e]) => `${providerName(p)}: ${e.model ?? 'original model'} · ${e.reasoningLevel ?? 'original reasoning'}`).join('; ') || 'Inherit';
}
function storedText(read: ReadResult): string {
    return read.stored.status === 'valid-shape' ? choiceText(read.stored.choice) : 'Malformed saved choice (retained)';
}
// Owner failures in user language; the classified kind stays visible for support.
function ownerFailure(action: string, e: unknown): string {
    if (!(e instanceof OwnerCallError))
        return `${action}: ${e instanceof Error ? e.message : String(e)}`;
    const reason = e.kind === 'unauthorized' ? 'you don’t have access to this plugin’s settings'
        : e.kind === 'unavailable' || e.kind === 'vanished' || e.kind === 'absent' ? 'the plugin isn’t running'
            : e.kind === 'incompatible' || e.kind === 'host-incompatible' ? 'the plugin uses an incompatible settings format'
                : e.kind === 'transient' ? 'the plugin didn’t respond'
                    : 'the plugin reported an error';
    return `${action}: ${reason}. Refresh to try again.`;
}
function Issues({ issues }: {
    issues: readonly Issue[];
}) {
    if (!issues.length)
        return null;
    return issues.length === 1 ? <p>{issues[0]!.message}</p> : <ul>{issues.map((i, n) => <li key={n}>{i.message}</li>)}</ul>;
}
function eligibilityText(v: ValidateResult): string {
    const e = v.eligibility;
    if (e.status === 'deferred')
        return `Checked at invocation: ${e.reason}`;
    const label = e.routeKind === 'sample' ? 'Sample' : e.routeKind === 'primary-preview' ? 'Primary preview' : 'Destination';
    return e.status === 'verified' ? `${label} verified on ${routeLabel(e.route)}` : `${label} unavailable or invalid; stored choice retained`;
}
// Plain-language explanations, derived only from the generic role descriptor.
type Boundary = 'fork-child' | 'create';
const boundaryText: Record<Boundary, string> = { 'fork-child': 'a new conversation branched from an existing one', create: 'a brand-new conversation' };
function providerName(id: string): string {
    return id.split(/[-_\s]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ') || id;
}
function listText(items: readonly string[]): string {
    return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
type Support = { status: 'available' } | { status: 'with-model' } | { status: 'unverified'; boundary: Boundary } | { status: 'no-overrides'; reasons: string[] };
function rawSupport(role: RoleDescriptorV1, provider: string, field: 'model' | 'reasoningLevel', withModel: boolean): Support {
    const cap = role.capability;
    const entry = cap && Object.hasOwn(cap.providers, provider) ? cap.providers[provider] : undefined;
    // Blocked or absent providers cannot carry overrides; inheriting still works for them.
    if (!cap || !entry || entry.blocked?.length)
        return { status: 'no-overrides', reasons: (entry?.blocked ?? []).map(code => code.replace(/[-_]+/g, ' ')) };
    for (const boundary of cap.boundaries) {
        const b = entry.perBoundary[boundary];
        const ok = field === 'model' ? b?.model === 'demonstrated' : b?.reasoningLevel === 'demonstrated' && (withModel || b?.reasoningWithoutModel === 'demonstrated');
        if (!ok)
            return { status: 'unverified', boundary };
    }
    return { status: 'available' };
}
/**
 * Whether a fixed-to-source role may carry this override for this provider on
 * every path it can take. Reasoning may be offered only together with a model override.
 */
function overrideSupport(role: RoleDescriptorV1, provider: string, field: 'model' | 'reasoningLevel', withModel = false): Support {
    const support = rawSupport(role, provider, field, withModel);
    if (field === 'reasoningLevel' && !withModel && support.status === 'unverified'
        && rawSupport(role, provider, 'model', false).status === 'available' && rawSupport(role, provider, 'reasoningLevel', true).status === 'available')
        return { status: 'with-model' };
    return support;
}
const supportLabel = { available: 'Available', 'with-model': 'With a model override', unverified: 'Not verified yet', 'no-overrides': 'No overrides' } as const;
function supportReason(role: RoleDescriptorV1, provider: string, field: 'model' | 'reasoningLevel', support: Support): string {
    const noun = field === 'model' ? 'model' : 'reasoning';
    const name = providerName(provider);
    if (support.status === 'no-overrides')
        return `Overrides aren’t available for ${name}${support.reasons.length ? ` (${support.reasons.join(', ')})` : ''}; without an override the role follows its inherited execution.`;
    if (support.status === 'with-model')
        return `Override the model too: changing ${name}’s reasoning on its own hasn’t been shown to work, but together with a model override it has.`;
    if (support.status === 'unverified')
        return `Not verified yet: overriding ${name}’s ${noun} hasn’t been shown to work when this role runs in ${boundaryText[support.boundary]}, so it’s turned off.`;
    return '';
}
function inheritHint(role: RoleDescriptorV1): string {
    if (role.providerPolicy === 'fixed-to-source')
        return 'keeps the original conversation’s model and reasoning';
    if (role.choiceKinds.includes('fields'))
        return 'follows the conversation that uses this role';
    return 'uses this role’s default';
}
function roleSummary(role: RoleDescriptorV1): string {
    if (role.providerPolicy === 'fixed-to-source' && role.capability) {
        const providers = Object.keys(role.capability.providers);
        const status = (p: string, field: 'model' | 'reasoningLevel') => overrideSupport(role, p, field).status;
        const reasoning = providers.filter(p => status(p, 'reasoningLevel') === 'available').map(providerName);
        const paired = providers.filter(p => status(p, 'reasoningLevel') === 'with-model').map(providerName);
        const model = providers.filter(p => status(p, 'model') === 'available').map(providerName);
        const unverified = (field: 'model' | 'reasoningLevel') => providers.some(p => status(p, field) === 'unverified');
        const lead = 'Always uses the same provider as the conversation it starts from.';
        if (providers.every(p => status(p, 'model') === 'no-overrides'))
            return `${lead} No model or reasoning overrides are offered; the role follows its inherited execution.`;
        return [
            lead,
            reasoning.length ? `You can override reasoning for ${listText(reasoning)}.` : '',
            paired.length ? `You can override reasoning together with the model for ${listText(paired)}.` : '',
            !reasoning.length && !paired.length ? (unverified('reasoningLevel') ? 'Reasoning overrides aren’t verified yet.' : 'No reasoning overrides are offered.') : '',
            model.length ? `You can override the model for ${listText(model)}.` : unverified('model') ? 'Model overrides aren’t verified yet.' : 'No model overrides are offered.',
        ].filter(Boolean).join(' ');
    }
    if (role.choiceKinds.includes('tuple'))
        return 'Save one provider, model and reasoning for new runs, or inherit the default.';
    if (role.choiceKinds.includes('fields'))
        return 'Override the provider, model or reasoning. Anything left on Inherit follows the conversation that uses this role.';
    return 'This role inherits its execution.';
}
function HowItWorks({ role, read }: {
    role: RoleDescriptorV1;
    read: ReadResult;
}) {
    const cap = role.providerPolicy === 'fixed-to-source' ? role.capability : undefined;
    const providers = cap ? Object.keys(cap.providers) : [];
    const statuses = new Set(providers.flatMap(p => (['model', 'reasoningLevel'] as const).map(f => overrideSupport(role, p, f).status)));
    const cell = (provider: string, field: 'model' | 'reasoningLevel') => {
        const support = overrideSupport(role, provider, field);
        return <td data-support={support.status} title={supportReason(role, provider, field, support) || undefined}>{supportLabel[support.status]}</td>;
    };
    return <details className="bbps-details">
      <summary><Chevron/>How this works</summary>
      <dl>
        {cap && <><dt>Provider</dt><dd>Always the same as the conversation this role starts from. Settings here are overrides for each provider; a provider without an override {inheritHint(role)}.</dd></>}
        {cap && <><dt>Where it runs</dt><dd>In {listText(cap.boundaries.map(b => boundaryText[b]))}. An override is offered only if it has been shown to work on every one of these paths.</dd></>}
        {!cap && role.choiceKinds.includes('tuple') && <><dt>Choice</dt><dd>A saved choice fixes the provider, model and reasoning together for new runs.</dd></>}
        {!cap && role.choiceKinds.includes('fields') && <><dt>Choice</dt><dd>Each field you override replaces the value from the conversation using this role; the rest are inherited from it.</dd></>}
        <dt>Inherit means</dt><dd>{read.rule}</dd>
        <dt>When it’s checked</dt><dd>{role.saveValidation === 'destination'
            ? 'A custom choice is checked against where this role runs before it’s saved; one that isn’t available there can’t be saved. Inherit restores the default without choosing a model, so no model availability check is needed.'
            : 'Each time the role runs, against where it actually runs. Saving checks that the choice is well-formed and allowed for this role. Check previews eligibility, but it isn’t a promise that the next run will accept the choice.'}</dd>
        <dt>When it applies</dt><dd>{role.applies}</dd>
        <dt>Preview vs. saved</dt><dd>Edit opens a preview of available models. Previewing never changes anything; only Save does.</dd>
      </dl>
      {cap && providers.length > 0 && <table className="bbps-support">
        <caption>What you can override</caption>
        <thead><tr><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Reasoning</th></tr></thead>
        <tbody>{providers.map(p => <tr key={p}><th scope="row">{providerName(p)}</th>{cell(p, 'model')}{cell(p, 'reasoningLevel')}</tr>)}</tbody>
      </table>}
      {cap && <p className="bbps-muted bbps-small" style={{ marginTop: '.375rem' }}>{[
            statuses.has('unverified') ? 'Not verified yet means that override hasn’t been shown to work on every path above, so it’s turned off rather than risk being ignored.' : '',
            statuses.has('no-overrides') ? 'No overrides means this provider can’t carry overrides here; without one, the role follows its inherited execution.' : '',
        ].filter(Boolean).join(' ')}</p>}
    </details>;
}
/**
 * Capability issues restated in user terms. They are recomputed from the role
 * descriptor and the choice the issues describe, never parsed from messages;
 * unrelated issues, or capability issues this cannot explain, keep their text.
 */
function explainIssues(issues: readonly Issue[], role: RoleDescriptorV1, choice: RoleChoice | null): Issue[] {
    const capabilityCodes = new Set(['field-not-offered', 'provider-blocked']);
    if (!issues.some(i => capabilityCodes.has(i.code)) || role.providerPolicy !== 'fixed-to-source' || !role.capability || choice?.kind !== 'by-provider')
        return [...issues];
    const explained = Object.entries(choice.entries).flatMap(([provider, entry]) => {
        const fields = (['model', 'reasoningLevel'] as const).filter(f => entry[f] !== undefined);
        for (const field of fields) {
            const support = overrideSupport(role, provider, field, field === 'reasoningLevel' && entry.model !== undefined);
            if (support.status !== 'available')
                return [{ code: support.status === 'no-overrides' ? 'provider-blocked' as const : 'field-not-offered' as const, message: `${supportReason(role, provider, field, support)} Remove the ${providerName(provider)} override or choose Inherit.` }];
        }
        return [];
    });
    if (!explained.length)
        return [...issues];
    return [...issues.filter(i => !capabilityCodes.has(i.code)), ...explained];
}
function EligibilityChip({ validation, busy }: {
    validation: ValidateResult | null;
    busy: boolean;
}) {
    if (busy)
        return <span className="bbps-chip"><Spinner/>Checking</span>;
    if (!validation)
        return <span className="bbps-chip" title="Eligibility not checked">Not checked</span>;
    const e = validation.eligibility;
    if (validation.shapeIssues.length || e.status === 'invalid')
        return <span className="bbps-chip" data-tone="danger" title={eligibilityText(validation)}>Unavailable</span>;
    if (e.status === 'verified')
        return <span className="bbps-chip" data-tone="success" title={eligibilityText(validation)}>Verified</span>;
    return <span className="bbps-chip" title={eligibilityText(validation)}>Checked when used</span>;
}
export function RoleSettingsEditor({ client, role, catalogSdk, sampleRoute, providerEntry, seed }: RoleSettingsEditorProps) {
    const link = useContext(EditorLinkContext);
    const [read, setRead] = useState<ReadResult | null>(null);
    const [draft, setDraft] = useState<RoleChoice>({ kind: 'inherit' });
    const [browse, setBrowse] = useState<ExecutionSelection | null>(null);
    const [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [refreshing, setRefreshing] = useState(false);
    // The initial Read settled with an error (distinct from still pending).
    const [readFailed, setReadFailed] = useState(false);
    const [error, setError] = useState(''), [refreshError, setRefreshError] = useState(''), [notice, setNotice] = useState(''), [label, setLabel] = useState('');
    const [validation, setValidation] = useState<ValidateResult | null>(null);
    const [conflict, setConflict] = useState<ReadResult | null>(null);
    const [selectedProvider, setSelectedProvider] = useState(providerEntry ?? '');
    const lifetime = useRef<AbortController | null>(null);
    const operation = useRef(0);
    const contextRoute = sampleRoute ? `${sampleRoute.kind}:${sampleRoute.kind === 'host' ? sampleRoute.hostId : sampleRoute.environmentId}` : '';
    const latest = useRef({ seed, catalogSdk });
    latest.current = { seed, catalogSdk };
    const readTicket = useRef(0), mutation = useRef(0);
    const live = useRef({ read, dirty, saving });
    live.current = { read, dirty, saving };
    // The refresh generation this editor's Read reflects.
    const readGeneration = useRef(link?.generation);
    const roleKey = JSON.stringify(role);
    const uid = useId();
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        operation.current++;
        readGeneration.current = link?.generation;
        setRead(null);
        setDraft({ kind: 'inherit' });
        setBrowse(null);
        setEditing(false);
        setDirty(false);
        setBusy(false);
        setSaving(false);
        setRefreshing(false);
        setRefreshError('');
        setReadFailed(false);
        readTicket.current++;
        setValidation(null);
        setConflict(null);
        setError('');
        setNotice('');
        setSelectedProvider(providerEntry ?? '');
        client.read(role.id, controller.signal).then(r => {
            if (lifetime.current !== controller || controller.signal.aborted)
                return;
            setRead(r);
            if (r.stored.status === 'valid-shape')
                setDraft(r.stored.choice);
        }).catch(e => {
            if (!controller.signal.aborted && lifetime.current === controller) {
                setError(ownerFailure('Couldn’t read the saved choice', e));
                setReadFailed(true);
            }
        });
        return () => {
            controller.abort();
            operation.current++;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- link.generation is handled by the revalidation effect
    }, [client, roleKey, catalogSdk.providers.list, catalogSdk.providers.models, contextRoute, providerEntry]);
    // Explicit directory refresh/reconnect revalidates a visible editor in place;
    // a collapsed editor waits until it is shown again. Only the newest refresh
    // Read may apply, and only if no Save/adoption happened since it started.
    // It never replaces a dirty draft or its base fingerprint without a visible conflict.
    const generation = link?.generation, visible = link?.visible ?? true, hasRead = read !== null;
    useEffect(() => {
        const controller = lifetime.current;
        // A pending initial Read is never duplicated; a failed one gets exactly
        // one fresh attempt per explicit refresh/reconnect generation.
        if (!controller || !visible || (!hasRead && !readFailed) || readGeneration.current === generation)
            return;
        readGeneration.current = generation;
        const ticket = ++readTicket.current, baseline = mutation.current;
        const current = () => lifetime.current === controller && !controller.signal.aborted && readTicket.current === ticket;
        setRefreshing(true);
        client.read(role.id, controller.signal).then(fresh => {
            if (!current())
                return;
            setRefreshing(false);
            setRefreshError('');
            const { read: shown, dirty: hasDraft, saving: pendingSave } = live.current;
            if (!shown) {
                // Recovery of a failed initial Read: this is now the first Read.
                setReadFailed(false);
                setError('');
                setRead(fresh);
                if (fresh.stored.status === 'valid-shape')
                    setDraft(fresh.stored.choice);
                return;
            }
            // A Save or adoption since this Read started reports newer state itself.
            if (pendingSave || !shown || mutation.current !== baseline)
                return;
            if (fresh.fingerprint === shown.fingerprint) {
                // Storage unchanged; route, rule or destination may still have moved.
                setRead(fresh);
                if (JSON.stringify(fresh.destinationRoute) !== JSON.stringify(shown.destinationRoute))
                    setValidation(null);
            }
            else if (!hasDraft) {
                setRead(fresh);
                setValidation(null);
                if (fresh.stored.status === 'valid-shape')
                    setDraft(fresh.stored.choice);
            }
            else {
                setConflict(fresh);
                setNotice('');
            }
        }).catch(e => {
            if (current()) {
                setRefreshing(false);
                setRefreshError(ownerFailure('Could not refresh', e));
            }
        });
    }, [client, role.id, generation, visible, hasRead, readFailed]);
    useEffect(() => {
        link?.report({ read, dirty, saving });
    }, [link, read, dirty, saving]);
    const fixed = role.providerPolicy === 'fixed-to-source';
    const storedProviders = draft.kind === 'by-provider' ? Object.keys(draft.entries) : [];
    const offeredProviders = Object.keys(role.capability?.providers ?? {}).filter(p => !role.capability!.providers[p]?.blocked?.length);
    const providerOptions = [...new Set([...offeredProviders, ...storedProviders])];
    const entryKey = providerEntry ?? (selectedProvider || providerOptions[0]);
    const route = read?.destinationRoute ?? sampleRoute ?? null;
    const pickerLifetime = lifetime.current;
    const pickerOperation = operation.current;
    const partial: {
        providerId?: string | undefined;
        model?: string | undefined;
        reasoningLevel?: string | undefined;
    } = draft.kind === 'fields' ? draft.fields : draft.kind === 'by-provider' && entryKey && Object.hasOwn(draft.entries, entryKey) ? draft.entries[entryKey]! : {};
    function change(next: RoleChoice) {
        operation.current++;
        setDraft(next);
        setDirty(true);
        setValidation(null);
        setNotice('');
    }
    function begin() {
        const controller = lifetime.current, id = ++operation.current;
        const active = () => Boolean(controller && !controller.signal.aborted && lifetime.current === controller && operation.current === id);
        return { controller, active };
    }
    async function check() {
        const op = begin();
        if (!op.controller)
            return;
        setBusy(true);
        setError('');
        try {
            const v = await client.validate(role.id, draft, sampleRoute, op.controller.signal);
            if (op.active())
                setValidation(v);
        }
        catch (e) {
            if (op.active())
                setError(String(e));
        }
        finally {
            if (op.active())
                setBusy(false);
        }
    }
    async function edit(replace = false) {
        const op = begin();
        if (!op.controller)
            return;
        setBusy(true);
        setError('');
        try {
            const v = await client.validate(role.id, draft, sampleRoute, op.controller.signal);
            if (!op.active())
                return;
            setValidation(v);
            if (!replace && (v.shapeIssues.length || v.eligibility.status === 'invalid' || read?.stored.status === 'malformed'))
                return;
            const explicit: {
                providerId?: string | undefined;
                model?: string | undefined;
                reasoningLevel?: string | undefined;
                serviceTier?: 'default' | 'fast' | undefined;
            } = draft.kind === 'tuple' ? draft.selection : partial;
            const providers = await latest.current.catalogSdk.providers.list(route?.kind === 'host' ? { hostId: route.hostId } : route?.kind === 'environment' ? { environmentId: route.environmentId } : {});
            if (!op.active())
                return;
            const providerId = fixed ? entryKey : explicit.providerId ?? providers.find(p => p.available)?.id;
            if (!providerId)
                throw new Error(fixed ? 'Choose an offered provider entry' : 'No available provider');
            if (fixed && !offeredProviders.includes(providerId))
                throw new Error('This provider is not offered; remove its entry or choose an offered provider');
            const { catalog } = await readCatalog(latest.current.catalogSdk, route, providerId);
            if (!op.active())
                return;
            if (catalog.modelLoadError)
                throw new Error(catalog.modelLoadError.detail ?? catalog.modelLoadError.code);
            const row = catalog.models.find(r => r.isDefault) ?? catalog.models[0];
            const featureSeed = latest.current.seed ? await latest.current.seed(route, catalog) : null;
            if (!op.active())
                return;
            if (!featureSeed && !row)
                throw new Error('No models available');
            const base = featureSeed?.selection ?? { providerId, model: row!.model, reasoningLevel: row!.defaultReasoningEffort };
            // Browsing may reconcile a stored alias, but only explicit promotion writes intent.
            const value = { ...base, ...Object.fromEntries(Object.entries(explicit).filter(([, v]) => v !== undefined)), ...(fixed ? { providerId } : {}) };
            setBrowse(value);
            setLabel(featureSeed?.label ?? 'Browsing');
            setEditing(true);
        }
        catch (e) {
            if (op.active())
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            if (op.active())
                setBusy(false);
        }
    }
    function writePartial(fields: typeof partial) {
        if (fixed && entryKey) {
            const entries = draft.kind === 'by-provider' ? { ...draft.entries } : {};
            const entry = { ...(fields.model !== undefined ? { model: fields.model } : {}), ...(fields.reasoningLevel !== undefined ? { reasoningLevel: fields.reasoningLevel } : {}) };
            if (Object.keys(entry).length)
                entries[entryKey] = entry;
            else
                delete entries[entryKey];
            change({ kind: 'by-provider', entries });
        }
        else
            change({ kind: 'fields', fields });
    }
    function toggle(field: 'providerId' | 'model' | 'reasoningLevel', set: boolean) {
        const fields = { ...partial };
        if (set && browse)
            fields[field] = browse[field];
        else
            delete fields[field];
        writePartial(fields);
    }
    function promote() {
        if (!browse)
            return;
        if (role.choiceKinds.includes('tuple'))
            change({ kind: 'tuple', selection: { ...browse } });
        else {
            const fields = { ...partial };
            for (const key of ['providerId', 'model', 'reasoningLevel'] as const)
                if (Object.hasOwn(fields, key))
                    fields[key] = browse[key];
            writePartial(fields);
        }
    }
    function stopBrowsing() {
        setEditing(false);
        setBrowse(null);
        setBusy(false);
    }
    function deleteEntry() {
        if (!entryKey)
            return;
        const entries = draft.kind === 'by-provider' ? { ...draft.entries } : {};
        delete entries[entryKey];
        change({ kind: 'by-provider', entries });
        stopBrowsing();
    }
    function adopt(current: ReadResult) {
        operation.current++;
        mutation.current++;
        setRead(current);
        setDraft(current.stored.status === 'valid-shape' ? current.stored.choice : { kind: 'inherit' });
        setConflict(null);
        setDirty(false);
        setValidation(null);
        setError('');
        setNotice('');
    }
    function cancel() {
        // Local only: discards the draft and browsing; never writes.
        if (conflict)
            adopt(conflict);
        else if (read)
            adopt(read);
        stopBrowsing();
    }
    async function save(current = read) {
        if (!current || saving)
            return;
        const controller = lifetime.current;
        const targetClient = client, targetRole = role.id;
        const presentationCurrent = () => controller !== null && lifetime.current === controller && !controller.signal.aborted;
        const normalized = normalizeRoleChoice(draft);
        if (!normalized.ok) {
            setError(normalized.issues.map(i => i.message).join('; '));
            return;
        }
        mutation.current++;
        setSaving(true);
        setError('');
        setNotice('');
        // Save has no signal: refresh/unmount must not cancel or retry a dispatched write.
        try {
            const r = await targetClient.save(targetRole, normalized.value, current.fingerprint, sampleRoute);
            if (!presentationCurrent())
                return;
            if (r.outcome === 'saved') {
                setRead(r.read);
                setDraft(r.read.stored.status === 'valid-shape' ? r.read.stored.choice : normalized.value);
                setDirty(false);
                setConflict(null);
                setEditing(false);
                setBrowse(null);
                setNotice('Saved');
            }
            else if (r.outcome === 'conflict') {
                setConflict(r.current);
                setError('Settings changed since Read. Use current or deliberately overwrite.');
            }
            else {
                setError(r.issues.map(i => i.message).join('; '));
            }
        }
        catch (e) {
            const cause = e && typeof e === 'object' && 'cause' in e ? e.cause as { status?: number; body?: unknown } : null;
            const nativeMessage = cause?.body && typeof cause.body === 'object' ? (cause.body as { error?: unknown }).error : cause?.body;
            const code = nativeMessage && typeof nativeMessage === 'object' ? (nativeMessage as { code?: string }).code : undefined;
            const definite = cause && (cause.status === 401 || cause.status === 403 || cause.status === 404 || (cause.status === 400 && code === 'invalid_input') || (cause.status === 503 && typeof nativeMessage === 'string' && /not running \(status: disabled\)/i.test(nativeMessage)));
            if (definite) {
                if (presentationCurrent()) setError('Save rejected by owner: ' + (typeof nativeMessage === 'string' ? nativeMessage : String(e)));
                return;
            }
            // Response loss/output failure is reconciled once by content. No implicit retry.
            try {
                const fresh = await targetClient.read(targetRole);
                if (!presentationCurrent())
                    return;
                const outcome = reconcileUnknownSave(current, normalized.value, fresh);
                setRead(fresh);
                if (outcome === 'matches-submitted') {
                    setNotice('Saved (confirmed by re-read)');
                    setDirty(false);
                    setEditing(false);
                    setBrowse(null);
                }
                else {
                    setError(outcome === 'unchanged' ? 'Not observed; the save may still land' : 'Conflicting current choice');
                    setConflict(fresh);
                }
            }
            catch {
                if (presentationCurrent())
                    setError(`Save outcome unknown: ${String(e)}`);
            }
        }
        finally {
            mutation.current++;
            if (presentationCurrent())
                setSaving(false);
        }
    }
    const staticIssues = read?.stored.status === 'valid-shape' ? read.stored.staticIssues : [];
    const invalid = read?.stored.status === 'malformed' || staticIssues.length > 0 || Boolean(validation?.shapeIssues.length) || validation?.eligibility.status === 'invalid';
    const storedIssues = read ? [...(read.stored.status === 'malformed' ? read.stored.issues : []), ...explainIssues(staticIssues, role, read.stored.status === 'valid-shape' ? read.stored.choice : null)] : [];
    const validationIssues = validation ? explainIssues([...validation.shapeIssues, ...(validation.eligibility.status === 'invalid' ? validation.eligibility.issues : [])], role, draft) : [];
    const locked = busy || saving || !read;
    const tupleRole = role.choiceKinds.includes('tuple');
    const embedded = link !== null;
    const statusId = `${uid}-status`;
    return <section aria-label={role.label} aria-busy={saving || busy || refreshing || (!read && !readFailed)} className="bbps bbps-stack">
    <Styles/>
    <div className="bbps-stack" style={{ gap: '.125rem' }}>
      {!embedded && <h3 style={{ fontWeight: 600 }}>{role.label}</h3>}
      <p className="bbps-muted bbps-small bbps-wrap">{role.applies}</p>
      <p className="bbps-small bbps-wrap">{roleSummary(role)}</p>
    </div>

    {read ? <div className="bbps-current">
        <span className="bbps-label">Current:</span>{' '}<span className="bbps-choice">{storedText(read)}</span>
        {read.stored.status === 'valid-shape' && read.stored.choice.kind === 'inherit' && <span className="bbps-muted bbps-small">({inheritHint(role)})</span>}
        <EligibilityChip validation={validation} busy={busy && !editing}/>
        {refreshing && <span className="bbps-status" role="status"><Spinner/>Refreshing</span>}
      </div> : !error && <p className="bbps-status" role="status"><Spinner/>Reading…</p>}

    {storedIssues.length > 0 && <div className="bbps-callout" data-tone={read?.stored.status === 'malformed' ? 'danger' : 'warning'}><Issues issues={storedIssues}/>{invalid && !editing && <p className="bbps-muted">The saved value is kept until you replace or clear it.</p>}</div>}
    {typeof read?.destinationUnresolved === 'string' && <div className="bbps-callout" data-tone="warning"><p>{read.destinationUnresolved}</p></div>}
    {validationIssues.length > 0 && <div className="bbps-callout" data-tone="danger"><p>{validation ? eligibilityText(validation) : ''}</p><Issues issues={validationIssues}/></div>}

    {fixed && !providerEntry && <label className="bbps-row"><span className="bbps-label">Override for provider</span><select className="bbps-select" aria-label="Provider entry" value={entryKey ?? ''} disabled={saving} onChange={e => {
        operation.current++;
        setSelectedProvider(e.target.value);
        stopBrowsing();
    }}><option value="" disabled>Choose provider</option>{providerOptions.map(p => <option key={p} value={p}>{providerName(p)}{offeredProviders.includes(p) ? '' : ' (no overrides)'}</option>)}</select></label>}
    {fixed && entryKey && <p className="bbps-small bbps-wrap">{Object.keys(partial).length
            ? <>{providerName(entryKey)} override: {[partial.model !== undefined ? `model ${partial.model}` : 'model from the original conversation', partial.reasoningLevel !== undefined ? `reasoning ${partial.reasoningLevel}` : 'reasoning from the original conversation'].join(' · ')}</>
            : <>No {providerName(entryKey)} override. When the original conversation uses {providerName(entryKey)}, this role keeps its model and reasoning.</>}</p>}

    {!editing && <div className="bbps-row" role="group" aria-label={`${role.label} actions`}>
      <button type="button" className="bbps-btn" disabled={locked} onClick={() => void edit()}>{busy ? <Spinner/> : null}Edit</button>
      {invalid && <button type="button" className="bbps-btn" disabled={locked} onClick={() => void edit(true)}>Replace</button>}
      <button type="button" className="bbps-btn" data-variant="ghost" disabled={saving || !read || !role.writable} title="Use the inherited default" onClick={() => {
        change({ kind: 'inherit' });
        stopBrowsing();
      }}>Inherit</button>
      {fixed && entryKey && <button type="button" className="bbps-btn" data-variant="ghost" disabled={saving || !read || !role.writable} onClick={deleteEntry}>Remove entry</button>}
      <button type="button" className="bbps-btn" data-variant="ghost" disabled={locked} title="Check eligibility without saving" onClick={() => void check()}>Check</button>
    </div>}

    {editing && browse && <div className="bbps-edit" role="group" aria-label={`Choose ${role.label} model`}>
      <div className="bbps-step">
        <p className="bbps-step-title"><span aria-hidden="true">1</span>Preview a model</p>
        <p className="bbps-muted bbps-small bbps-wrap">{label}: {browse.providerId}/{browse.model} on {routeLabel(route)}. Previewing doesn’t change anything.</p>
        <Picker value={browse as ExperimentalProviderModelPickerValue} onChange={value => {
            if (pickerLifetime && lifetime.current === pickerLifetime && !pickerLifetime.signal.aborted && operation.current === pickerOperation)
                setBrowse(value);
        }} {...(route ? { routing: route } : {})} allowProviderChange={!fixed} disabled={saving || !role.writable}/>
        {fixed && <p className="bbps-muted bbps-small">The provider can’t be changed here: this role always uses the original conversation’s provider.</p>}
      </div>
      {tupleRole
            ? <div className="bbps-step">
          <p className="bbps-step-title"><span aria-hidden="true">2</span>Use it as the new choice</p>
          <div className="bbps-row"><button type="button" className="bbps-btn" disabled={saving || !role.writable} onClick={promote}>Use this selection</button><span className="bbps-muted bbps-small">Copies the preview into a draft. Nothing is saved yet.</span></div>
        </div>
            : <div className="bbps-step">
          <p className="bbps-step-title"><span aria-hidden="true">2</span>Choose what to override</p>
          <div className="bbps-fields">{(['providerId', 'model', 'reasoningLevel'] as const).filter(k => !fixed || k !== 'providerId').map(k => {
                    const fields = { ...partial, [k]: browse[k] };
                    const candidate: RoleChoice = fixed && entryKey ? { kind: 'by-provider', entries: { [entryKey]: { ...(fields.model !== undefined ? { model: fields.model } : {}), ...(fields.reasoningLevel !== undefined ? { reasoningLevel: fields.reasoningLevel } : {}) } } } : { kind: 'fields', fields };
                    const blocked = checkStatic(candidate, role);
                    const support = fixed && entryKey && k !== 'providerId' ? overrideSupport(role, entryKey, k, k === 'reasoningLevel' && fields.model !== undefined) : null;
                    const reason = blocked.length ? (support && support.status !== 'available' ? supportReason(role, entryKey!, k as 'model' | 'reasoningLevel', support) : blocked.map(i => i.message).join('; ')) : '';
                    const id = `${uid}-${k}`;
                    return <div key={k} style={{ display: 'contents' }}>
                  <label htmlFor={id} className="bbps-small">{fieldLabel[k]}</label>
                  <div className="bbps-row"><select id={id} className="bbps-select" aria-label={k} disabled={saving || !role.writable} value={Object.hasOwn(partial, k) ? 'set' : 'inherit'} onChange={e => toggle(k, e.target.value === 'set')}><option value="inherit">{fixed ? 'Keep original' : 'Inherit'}</option><option value="set" disabled={blocked.length > 0}>Override: {browse[k]}</option></select>{reason && <span className="bbps-muted bbps-small bbps-wrap">{reason}</span>}</div>
                </div>;
                })}</div>
          <div className="bbps-row"><button type="button" className="bbps-btn" disabled={saving || !role.writable || !Object.keys(partial).length} onClick={promote}>Apply preview to overrides</button><span className="bbps-muted bbps-small">Only overridden fields are saved; the rest {fixed ? 'stay as the original conversation has them' : 'are inherited'}.</span></div>
        </div>}
      <p className="bbps-step-title"><span aria-hidden="true">3</span>Review the draft below, then Save</p>
    </div>}

    {dirty && <div className="bbps-callout" data-tone="draft"><p><span className="bbps-label">Draft:</span> <span className="bbps-choice">{choiceText(draft)}</span></p><p className="bbps-muted">Not saved yet. Save applies it to: {role.applies}</p></div>}

    {conflict && <div className="bbps-callout" data-tone="warning">
      <p>This choice was changed elsewhere. Keep the newer saved value, or overwrite it with your draft.</p>
      <p><span className="bbps-label">Current:</span> <span className="bbps-choice">{conflict.stored.status === 'valid-shape' ? choiceText(conflict.stored.choice) : 'Malformed choice retained'}</span></p>
      <div className="bbps-row"><button type="button" className="bbps-btn" disabled={saving} onClick={() => adopt(conflict)}>Use current</button><button type="button" className="bbps-btn" data-variant="danger" disabled={saving || !role.writable} onClick={() => void save(conflict)}>Overwrite</button></div>
    </div>}

    {read && <HowItWorks role={role} read={read}/>}
    {read && <details className="bbps-details">
      <summary><Chevron/>Details</summary>
      <dl>
        {role.description && <><dt>Owner notes</dt><dd>{role.description}</dd></>}
        <dt>Eligibility</dt><dd>{validation ? eligibilityText(validation) : 'Eligibility not checked'}</dd>
        {read.destinationPreview && <><dt>Destination</dt><dd>Preview on {routeLabel(read.destinationRoute)}</dd></>}
        {!role.writable && <><dt>Access</dt><dd>Read-only</dd></>}
      </dl>
    </details>}

    <div className="bbps-footer">
      <span className="bbps-status" id={statusId} role="status">{saving ? <><Spinner/>Saving…</> : notice}</span>
      {error && <p role="alert" className="bbps-alert" style={{ flexBasis: '100%', order: -1 }}>{error}</p>}
      {refreshError && <p role="alert" className="bbps-alert" style={{ flexBasis: '100%', order: -1 }}>{refreshError}</p>}
      {(dirty || editing) && <button type="button" className="bbps-btn" data-variant="ghost" disabled={saving} onClick={cancel}>Cancel</button>}
      <button type="button" className="bbps-btn" data-variant={dirty ? 'primary' : undefined} aria-describedby={statusId} disabled={busy || saving || !dirty || !role.writable} onClick={() => void save()}>Save</button>
    </div>
  </section>;
}
const Picker = experimental_ProviderModelPicker;
function ownerStatusText(row: OwnerRow): string {
    if (row.state === 'incompatible') {
        if (row.error === 'host-incompatible')
            return 'This host cannot read this plugin’s provider settings.';
        return row.versions?.length
            ? `This plugin uses a different provider settings format (versions: ${row.versions.join(', ')}).`
            : 'This plugin’s provider settings could not be understood.';
    }
    if (row.state === 'unavailable')
        return row.error === 'vanished' ? 'This plugin was removed while checking.' : 'This plugin is unavailable. Refresh after it is running.';
    if (row.error === 'unauthorized')
        return 'You do not have access to this plugin’s provider settings.';
    return 'Could not read this plugin’s provider settings. Refresh to try again.';
}
type CatalogProviders = CatalogSdk['providers'];
// Page-lifetime catalog cache for Edit seeding, scoped to one SDK instance and
// cleared on every explicit refresh/reconnect. Failures are never cached.
function catalogCache(sdk: CatalogSdk) {
    const cache = new Map<string, Promise<unknown>>();
    function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
        let p = cache.get(key) as Promise<T> | undefined;
        if (!p) {
            const created = load();
            p = created;
            cache.set(key, created);
            created.catch(() => {
                if (cache.get(key) === created)
                    cache.delete(key);
            });
        }
        return p;
    }
    const providers = {
        list: ((args: Parameters<CatalogProviders['list']>[0]) => memo('list:' + JSON.stringify(args ?? {}), () => sdk.providers.list(args as never))) as CatalogProviders['list'],
        models: ((args: Parameters<CatalogProviders['models']>[0]) => memo('models:' + JSON.stringify(args ?? {}), () => sdk.providers.models(args as never))) as CatalogProviders['models'],
    } as CatalogProviders;
    return { sdk: { providers } as CatalogSdk, clear: () => cache.clear() };
}
function SearchIcon() {
    return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3 3"/></svg>;
}
function RefreshIcon() {
    return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5v3h-3"/></svg>;
}
const SEARCH_THRESHOLD = 6;
export function ProviderSettingsDirectory({ sdk, reconnectKey }: {
    sdk: OwnerSdk & CatalogSdk;
    reconnectKey: unknown;
}) {
    const [rows, setRows] = useState<OwnerRow[]>([]), [omitted, setOmitted] = useState(0), [refresh, setRefresh] = useState(0), [error, setError] = useState(''), [checking, setChecking] = useState(true);
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set()), [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
    const [reports, setReports] = useState<ReadonlyMap<string, EditorReport>>(() => new Map());
    const [generation, setGeneration] = useState(0), [query, setQuery] = useState('');
    const catalog = useMemo(() => catalogCache(sdk), [sdk]);
    const clients = useMemo(() => new Map<string, OwnerClient>(), [sdk]);
    const client = useCallback((pluginId: string) => {
        let c = clients.get(pluginId);
        if (!c)
            clients.set(pluginId, c = createOwnerClient(sdk, pluginId));
        return c;
    }, [clients, sdk]);
    // A new SDK instance is a new context: nothing opened or read under the old one survives.
    useEffect(() => {
        setOpen(new Set());
        setMounted(new Set());
        setReports(new Map());
    }, [sdk]);
    useEffect(() => {
        const c = new AbortController();
        catalog.clear();
        setGeneration(g => g + 1);
        setOmitted(0);
        setError('');
        setChecking(true);
        enumerateProviderSettingsOwners({ sdk, signal: c.signal, onRow: row => {
                if (!c.signal.aborted)
                    setRows(old => row.state === 'pending' && old.some(r => r.pluginId === row.pluginId)
                        ? old
                        : [...old.filter(r => r.pluginId !== row.pluginId), row]);
            } }).then(r => {
            if (!c.signal.aborted) {
                setRows(r.rows);
                setOmitted(r.omittedCount);
                setChecking(false);
            }
        }).catch(() => {
            if (!c.signal.aborted) {
                setError('Discovery failed');
                setChecking(false);
            }
        });
        return () => c.abort();
    }, [sdk, reconnectKey, refresh, catalog]);
    const report = useCallback((key: string, state: EditorReport) => {
        setReports(old => {
            const prev = old.get(key);
            if (prev && prev.read === state.read && prev.dirty === state.dirty && prev.saving === state.saving)
                return old;
            const next = new Map(old);
            next.set(key, state);
            return next;
        });
    }, []);
    const toggle = useCallback((key: string) => {
        setOpen(old => {
            const next = new Set(old);
            if (next.has(key))
                next.delete(key);
            else
                next.add(key);
            return next;
        });
        setMounted(old => old.has(key) ? old : new Set(old).add(key));
    }, []);
    const visible = rows.filter(row => row.state !== 'pending' && row.state !== 'absent').sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    const participants = rows.filter(row => row.state === 'participant').length;
    const roleCount = visible.reduce((n, row) => n + (row.roles?.length ?? 0), 0);
    const needle = query.trim().toLowerCase();
    const matches = (row: OwnerRow, role?: RoleDescriptorV1) => !needle || [row.displayName ?? row.pluginId, row.pluginId, role?.label ?? '', role?.applies ?? '', role?.description ?? ''].some(s => s.toLowerCase().includes(needle));
    const shown = visible.filter(row => matches(row) || row.roles?.some(role => matches(row, role)));
    function onListKey(e: KeyboardEvent<HTMLDivElement>) {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !(e.target instanceof HTMLElement) || !e.target.matches('[data-bbps-trigger]'))
            return;
        const triggers = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-bbps-trigger]')].filter(t => !t.closest('[hidden]'));
        const at = triggers.indexOf(e.target);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? triggers.length - 1 : at + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 || next >= triggers.length)
            return;
        e.preventDefault();
        triggers[next]!.focus();
    }
    return <div className="bbps bbps-stack" style={{ gap: '1rem' }}>
      <Styles/>
      <div className="bbps-toolbar">
        {roleCount >= SEARCH_THRESHOLD && <div className="bbps-search"><SearchIcon/><input className="bbps-input" type="search" aria-label="Filter plugins and roles" placeholder="Filter plugins and roles" value={query} onChange={e => setQuery(e.target.value)}/></div>}
        <span className="bbps-status" role="status">{checking ? <><Spinner/>Checking plugins…{participants > 0 ? ` ${participants} with provider settings` : ''}</> : null}</span>
        <button type="button" className="bbps-btn" data-variant="ghost" disabled={checking} onClick={() => setRefresh(n => n + 1)}><RefreshIcon/>Refresh</button>
      </div>
      {error && <p role="alert" className="bbps-alert">Could not check plugins. Refresh to try again.</p>}
      {!checking && !error && visible.length === 0 && <p className="bbps-muted">No plugins with provider settings are available.</p>}
      {needle && visible.length > 0 && shown.length === 0 && <p className="bbps-muted">No plugins or roles match “{query.trim()}”.</p>}
      <div className="bbps-groups" onKeyDown={onListKey}>
      {visible.map(row => {
            const rowShown = shown.includes(row);
            const ownerMatch = matches(row);
            return <article key={row.pluginId} className="bbps-group" hidden={!rowShown}>
        <h3 className="bbps-group-title">{row.displayName ?? row.pluginId}</h3>
        <div className="bbps-card">
          {row.state !== 'participant' && <p className="bbps-note">{ownerStatusText(row)}</p>}
          {row.state === 'participant' && !row.roles?.length && <p className="bbps-note">This plugin has no configurable provider roles.</p>}
          {row.roles?.map(role => {
                const key = row.pluginId + '/' + role.id;
                const isOpen = open.has(key);
                const roleShown = ownerMatch || matches(row, role);
                return <RoleRow key={role.id} rowKey={key} pluginId={row.pluginId} role={role} open={isOpen} hidden={!roleShown} keepMounted={mounted.has(key)} report={reports.get(key)} generation={generation} onToggle={toggle} onReport={report} client={client} catalogSdk={catalog.sdk}/>;
            })}
        </div>
      </article>;
        })}
      </div>
      {omitted > 0 && <p className="bbps-muted bbps-small">{omitted === 1 ? '1 plugin isn’t running, so its settings weren’t checked.' : `${omitted} plugins aren’t running, so their settings weren’t checked.`}</p>}
    </div>;
}
function rowSummary(role: RoleDescriptorV1, report: EditorReport | undefined): ReactNode {
    if (report?.saving)
        return 'Saving…';
    const read = report?.read;
    const saved = read ? storedText(read) + (read.stored.status === 'valid-shape' && read.stored.choice.kind === 'inherit' ? ` · ${inheritHint(role)}` : '') : null;
    if (report?.dirty)
        return `Unsaved changes${saved ? ` · saved: ${saved}` : ''}`;
    return saved ?? role.applies;
}
function RoleRow({ rowKey, pluginId, role, open, hidden, keepMounted, report, generation, onToggle, onReport, client, catalogSdk }: {
    rowKey: string;
    pluginId: string;
    role: RoleDescriptorV1;
    open: boolean;
    hidden: boolean;
    keepMounted: boolean;
    report: EditorReport | undefined;
    generation: number;
    onToggle(key: string): void;
    onReport(key: string, state: EditorReport): void;
    client(pluginId: string): OwnerClient;
    catalogSdk: CatalogSdk;
}) {
    const id = useId();
    const visible = open && !hidden;
    const reportFn = useCallback((state: EditorReport) => onReport(rowKey, state), [onReport, rowKey]);
    const link = useMemo<EditorLink>(() => ({ embedded: true, generation, visible, report: reportFn }), [generation, visible, reportFn]);
    return <div hidden={hidden}>
    <button type="button" className="bbps-trigger" data-bbps-trigger="" aria-expanded={open} aria-controls={`${id}-panel`} aria-labelledby={`${id}-label`} aria-describedby={`${id}-summary`} onClick={() => onToggle(rowKey)}>
      <span className="bbps-trigger-text">
        <span id={`${id}-label`} className="bbps-trigger-title">{role.label}</span>
        <span id={`${id}-summary`} className="bbps-trigger-summary">{rowSummary(role, report)}</span>
      </span>
      {report?.dirty && <span className="bbps-chip" data-tone="warning">Unsaved</span>}
      <Chevron/>
    </button>
    <div id={`${id}-panel`} className="bbps-panel" hidden={!open}>
      {(keepMounted || open) && <EditorLinkContext.Provider value={link}>
        <DirectoryEditor client={client(pluginId)} role={role} catalogSdk={catalogSdk}/>
      </EditorLinkContext.Provider>}
    </div>
  </div>;
}
function DirectoryEditor({ client, role, catalogSdk }: {
    client: OwnerClient;
    role: RoleDescriptorV1;
    catalogSdk: CatalogSdk;
}) {
    return <RoleSettingsEditor client={client} role={role} catalogSdk={catalogSdk}/>;
}
