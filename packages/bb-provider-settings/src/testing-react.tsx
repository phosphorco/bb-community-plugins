/**
 * Mounted-editor conformance for `RoleSettingsEditor` and controls built on it.
 *
 * Editors render in a JSDOM document with the SDK test runtime installed, so
 * the native picker is the SDK's `TestProviderModelPicker`. Owner calls go
 * through an `OwnerProbe` to the consumer's real owner on an SDK fake host.
 *
 * This is source conformance, not native-execution proof. It does not show
 * that a running BB host's picker, composer or settings storage behaved.
 *
 * Runtime peers: `react`, `react-dom` and `jsdom` (optional peers of the
 * package, needed only by this entry) and `@get-bb/plugin-sdk`.
 * @module
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { ExecutionSelection } from './index.js';
import { ConformanceError } from './testing.js';
import type { FakeCatalog, OwnerProbe, Scenario, ScenarioOptions } from './testing.js';
import { applicable } from './testing.js';

export interface MountedEditor {
    readonly window: Window;
    readonly document: Document;
    /** Visible text of the mounted tree. */
    text(): string;
    /** The button whose trimmed text equals `label` (or matches it), or null. */
    button(label: string | RegExp): HTMLButtonElement | null;
    /** Click an enabled button, then wait for settlement. Missing or disabled buttons throw. */
    click(label: string | RegExp): Promise<void>;
    /** Change a `<select aria-label=…>`, then wait for settlement. */
    select(ariaLabel: string, value: string): Promise<void>;
    /** The mounted SDK picker element, or null. */
    picker(): HTMLElement | null;
    /**
     * Fire the picker's own `onChange` the way a native reconciliation would:
     * fill the test picker's inputs (when given), then press its apply control.
     */
    applyPicker(selection?: Partial<ExecutionSelection>): Promise<void>;
    rerender(element: ReactElement): Promise<void>;
    /**
     * Await every pending owner and catalog promise, flush React work inside
     * `act`, repeat until nothing is pending, then require a ready or explicit
     * error state. No timers are involved.
     */
    settled(): Promise<void>;
    dispose(): Promise<void>;
}

export interface MountOptions {
    /** Owner calls to await during settlement. */
    readonly probe?: OwnerProbe;
    /** Catalog calls to await during settlement (already included when the probe was given this catalog). */
    readonly catalog?: FakeCatalog;
    /** Settle after the first render. Default true; pass false to observe the pre-Read state. */
    readonly settle?: boolean;
    /** Observable ready state. Default: the editor no longer shows "Reading…", or it shows an alert. */
    readonly ready?: (editor: MountedEditor) => boolean;
}

const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const MAX_SETTLE_ROUNDS = 100;

function defaultReady(editor: MountedEditor): boolean {
    return !editor.text().includes('Reading…') || editor.document.querySelector('[role="alert"]') !== null;
}

function matches(label: string | RegExp, text: string): boolean {
    return typeof label === 'string' ? text === label : label.test(text);
}

/**
 * Render `element` into a fresh JSDOM document. By default this resolves only
 * after the editor's initial owner Read has settled and a ready state is visible.
 */
export async function mountEditor(element: ReactElement, options: MountOptions = {}): Promise<MountedEditor> {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://conformance.invalid/' });
    const previous = new Map<string, PropertyDescriptor | undefined>();
    const scope = globalThis as Record<string, unknown>;
    for (const key of GLOBALS) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom.window as unknown as Record<string, unknown>)[key] });
    }
    const { installTestPluginRuntime } = await import('@get-bb/plugin-sdk/testing/app');
    installTestPluginRuntime();
    const document = dom.window.document;
    const root: Root = createRoot(document.getElementById('root')!);
    const pending = () => (options.probe?.pending ?? 0) + (options.catalog?.pending ?? 0);
    let disposed = false;
    const editor: MountedEditor = {
        window: dom.window as unknown as Window,
        document,
        text: () => document.body.textContent ?? '',
        button: label => [...document.querySelectorAll('button')].find(b => matches(label, b.textContent?.trim() ?? '')) ?? null,
        async click(label) {
            const button = editor.button(label);
            if (!button) throw new ConformanceError('mounted-editor', `no button ${String(label)}`);
            if (button.disabled) throw new ConformanceError('mounted-editor', `button ${String(label)} is disabled`);
            await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
            await editor.settled();
        },
        async select(ariaLabel, value) {
            const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${ariaLabel}"]`);
            if (!select) throw new ConformanceError('mounted-editor', `no select ${ariaLabel}`);
            await act(async () => { select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
            await editor.settled();
        },
        picker: () => document.querySelector<HTMLElement>('[data-testid="bb-provider-model-picker"]'),
        async applyPicker(selection = {}) {
            const picker = editor.picker();
            if (!picker) throw new ConformanceError('mounted-editor', 'no picker is mounted');
            const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
            const labels: Record<string, string> = { providerId: 'Provider ID', model: 'Model', reasoningLevel: 'Reasoning level' };
            for (const [field, value] of Object.entries(selection)) {
                if (field === 'serviceTier') {
                    const tier = picker.querySelector<HTMLSelectElement>('select[aria-label="Service tier"]')!;
                    await act(async () => { tier.value = String(value ?? ''); tier.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
                    continue;
                }
                const input = picker.querySelector<HTMLInputElement>(`input[aria-label="${labels[field]}"]`);
                if (!input) throw new ConformanceError('mounted-editor', `the picker has no ${field} input`);
                await act(async () => { setter.call(input, String(value)); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
            }
            const apply = [...picker.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Apply execution selection');
            if (!apply) throw new ConformanceError('mounted-editor', 'the picker has no apply control; is the SDK test runtime installed?');
            await act(async () => { apply.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
            await editor.settled();
        },
        async rerender(next) {
            await act(async () => { root.render(next); });
            await editor.settled();
        },
        async settled() {
            for (let round = 0; ; round++) {
                await act(async () => { await Promise.all([options.probe?.settled(), options.catalog?.settled()]); });
                if (!pending()) break;
                if (round >= MAX_SETTLE_ROUNDS) throw new ConformanceError('mounted-editor', 'owner or catalog calls kept starting after settlement');
            }
            if (!(options.ready ?? defaultReady)(editor)) throw new ConformanceError('mounted-editor', 'pending calls settled but the editor shows neither a ready nor an error state');
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            await act(async () => { root.unmount(); });
            dom.window.close();
            for (const [key, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete scope[key];
            }
        },
    };
    try {
        await act(async () => { root.render(element); });
        if (options.settle !== false) await editor.settled();
    } catch (e) {
        await editor.dispose();
        throw e;
    }
    return editor;
}

/**
 * A role's real settings control and the owner behind it. `render` must return
 * the control wired to `probe` (for `RoleSettingsEditor`: `client={probe.client(owner)}`
 * and `catalogSdk={catalog.sdk}`).
 */
export interface EditorSubject {
    render(): ReactElement;
    readonly probe: OwnerProbe;
    readonly catalog: FakeCatalog;
    /** The owner plugin id the control targets. Defaults to the probe's only owner. */
    readonly owner?: string;
    readRaw(): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
    writeExternally(): Promise<void>;
    seedMalformed?(): Promise<void>;
    /** Turn the browsed selection into saved intent. Defaults handle tuple roles and `fields` roles (model). */
    promote?(editor: MountedEditor): Promise<void>;
    restore?(): Promise<void>;
}

export type EditorScenarioId =
    | 'display-no-catalog' | 'delayed-read' | 'edit-browse-no-save-intent' | 'late-callback-no-promotion'
    | 'explicit-promotion-saves' | 'conflict-visible' | 'malformed-visible-explicit-reset';

function fail(id: string, detail: string): never {
    throw new ConformanceError(id, detail);
}

/** Order-independent JSON text for storage snapshots. */
function json(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    if (Array.isArray(value)) return '[' + value.map(json).join(',') + ']';
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + json(record[k])).join(',') + '}';
}

async function defaultPromote(editor: MountedEditor): Promise<void> {
    // 'Custom: use browsed selection' is the pre-redesign label of the same promotion.
    const tuple = /^(Use this selection|Custom: use browsed selection)$/;
    if (editor.button(tuple)) return editor.click(tuple);
    if (!editor.document.querySelector('select[aria-label="model"]')) fail('explicit-promotion-saves', 'no default promotion path; supply promote()');
    await editor.select('model', 'set');
    // 'Use browsed values for Set fields' is the pre-redesign label of the same promotion.
    await editor.click(/^(Apply preview to overrides|Use browsed values for Set fields)$/);
}

/**
 * Standard mounted-editor scenarios for one role. Each mounts a fresh editor
 * through `mountEditor`, so every interaction waits for the actual pending
 * owner and catalog promises.
 */
export function editorScenarios(subject: EditorSubject, options: ScenarioOptions<EditorScenarioId> = {}): readonly Scenario[] {
    const owner = subject.owner ?? (subject.probe.owners.length === 1 ? subject.probe.owners[0]! : fail('editor', 'name the owner this control targets'));
    const saves = () => subject.probe.calls.filter(c => c.method === 'providerSettingsV1Save' && c.pluginId === owner).length;
    const snapshot = async () => structuredClone({ ...await subject.readRaw() });
    const mount = (settle = true) => mountEditor(subject.render(), { probe: subject.probe, settle });
    const saveDisabled = (editor: MountedEditor) => { const b = editor.button('Save'); return !b || b.disabled; };
    const run = (id: EditorScenarioId, body: (id: string) => Promise<void>, gap?: string): Scenario => {
        const skip = options.skip?.[id] ?? gap;
        const go = async () => { await subject.restore?.(); await body(id); };
        return skip === undefined ? { id, run: go } : { id, skip, run: go };
    };
    async function within(body: (editor: MountedEditor) => Promise<void>, settle = true) {
        const editor = await mount(settle);
        try { await body(editor); } finally { await editor.dispose(); }
    }
    return applicable([
        run('display-no-catalog', async id => {
            const catalogCalls = subject.catalog.calls.length, saveCalls = saves();
            await within(async editor => {
                if (editor.picker()) fail(id, 'the picker mounted without a deliberate Edit');
                if (!/Current:/.test(editor.text())) fail(id, 'the stored choice is not displayed');
            });
            if (subject.catalog.calls.length !== catalogCalls) fail(id, 'displaying the stored choice loaded a provider catalog');
            if (saves() !== saveCalls) fail(id, 'displaying the stored choice saved');
        }),
        run('delayed-read', async id => {
            const before = await snapshot(), saveCalls = saves();
            const pause = subject.probe.holdNext('providerSettingsV1Read', owner);
            await within(async editor => {
                try {
                    await pause.reached;
                    const edit = editor.button('Edit');
                    if (edit && !edit.disabled) fail(id, 'Edit is enabled before the initial Read settled');
                } finally { pause.release(); }
                await editor.settled();
                if (!/Malformed/.test(editor.text())) {
                    await editor.click('Edit');
                    if (!editor.picker()) fail(id, 'Edit did not mount the picker after the Read settled');
                }
            }, false);
            if (saves() !== saveCalls) fail(id, 'a delayed Read led to a Save');
            if (json(await snapshot()) !== json(before)) fail(id, 'a delayed Read changed stored data');
        }),
        run('edit-browse-no-save-intent', async id => {
            const before = await snapshot(), saveCalls = saves();
            await within(async editor => {
                await editor.click('Edit');
                if (!editor.picker()) fail(id, 'Edit did not mount the picker');
                if (!saveDisabled(editor)) fail(id, 'browsing enabled Save');
            });
            if (saves() !== saveCalls) fail(id, 'browsing saved');
            if (json(await snapshot()) !== json(before)) fail(id, 'browsing changed stored data');
        }),
        run('late-callback-no-promotion', async id => {
            const before = await snapshot(), saveCalls = saves();
            await within(async editor => {
                await editor.click('Edit');
                await editor.applyPicker();
                await editor.applyPicker({ reasoningLevel: 'medium' });
                if (!saveDisabled(editor)) fail(id, 'a picker callback without explicit promotion enabled Save');
                if (/Draft:/.test(editor.text())) fail(id, 'a picker callback without explicit promotion created a draft');
            });
            if (saves() !== saveCalls) fail(id, 'a picker callback saved');
            if (json(await snapshot()) !== json(before)) fail(id, 'a picker callback changed stored data');
        }),
        run('explicit-promotion-saves', async id => {
            const saveCalls = saves();
            await within(async editor => {
                await editor.click('Edit');
                await (subject.promote ?? defaultPromote)(editor);
                if (saveDisabled(editor)) fail(id, 'explicit promotion did not enable Save');
                const before = await snapshot();
                await editor.click('Save');
                if (saves() !== saveCalls + 1) fail(id, `expected exactly one Save, saw ${saves() - saveCalls}`);
                if (editor.document.querySelector('[role="alert"]')) fail(id, `Save reported: ${editor.document.querySelector('[role="alert"]')!.textContent}`);
                if (!saveDisabled(editor)) fail(id, 'Save stayed enabled after a successful save');
                if (json(await snapshot()) === json(before)) fail(id, 'Save did not change stored data');
            });
        }),
        run('conflict-visible', async id => {
            await within(async editor => {
                await editor.click('Inherit');
                await subject.writeExternally();
                const external = await snapshot();
                await editor.click('Save');
                if (!editor.button('Use current') || !editor.button('Overwrite')) fail(id, 'a conflicting Save shows no Use current / Overwrite decision');
                if (json(await snapshot()) !== json(external)) fail(id, 'a conflicting Save overwrote the external write');
            });
        }),
        run('malformed-visible-explicit-reset', async id => {
            await subject.seedMalformed!();
            const catalogCalls = subject.catalog.calls.length;
            await within(async editor => {
                if (!/Malformed/.test(editor.text())) fail(id, 'malformed stored data is not visible');
                if (editor.picker()) fail(id, 'the picker mounted for malformed data');
                await editor.click('Inherit');
                await editor.click('Save');
                if (!/Current: Inherit/.test(editor.text())) fail(id, 'an explicit reset did not display inherit');
            });
            if (subject.catalog.calls.length !== catalogCalls) fail(id, 'resetting malformed data loaded a provider catalog');
        }, subject.seedMalformed ? undefined : 'subject supplies no seedMalformed'),
    ], options);
}

/**
 * Explicit owner targeting in mounted controls. Each subject's control is
 * mounted alone; saving through it must reach only its owner and leave every
 * other owner's storage identical. An editor that fell back to the current
 * plugin's implicit RPC hooks would miss the owner and fail here.
 */
export function crossOwnerEditorScenario(subjects: readonly EditorSubject[]): Scenario {
    const id = 'cross-owner-editor-targeting';
    return {
        id,
        async run() {
            const owners = subjects.map(s => s.owner ?? fail(id, 'every subject must name its owner'));
            if (new Set(owners).size < 2 || owners.length !== subjects.length) fail(id, 'needs at least two subjects on distinct owners');
            for (const [index, target] of subjects.entries()) {
                await target.restore?.();
                const others = subjects.filter(s => s !== target);
                const before = await Promise.all(others.map(async s => json({ ...await s.readRaw() })));
                const from = target.probe.calls.length;
                const editor = await mountEditor(target.render(), { probe: target.probe });
                try {
                    await editor.click('Inherit');
                    await editor.click('Save');
                    if (editor.document.querySelector('[role="alert"]')) fail(id, `Save through ${owners[index]} reported an error`);
                } finally { await editor.dispose(); }
                const calls = target.probe.calls.slice(from);
                if (!calls.some(c => c.method === 'providerSettingsV1Save')) fail(id, `the control for ${owners[index]} never saved`);
                const strays = calls.filter(c => c.pluginId !== owners[index]);
                if (strays.length) fail(id, `the control for ${owners[index]} called ${strays.map(c => c.pluginId).join(', ')}`);
                for (const [i, s] of others.entries()) if (json({ ...await s.readRaw() }) !== before[i]) fail(id, `saving through ${owners[index]} changed ${s.owner}'s storage`);
            }
        },
    };
}

