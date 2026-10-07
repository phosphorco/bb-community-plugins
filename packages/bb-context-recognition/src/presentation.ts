/** Shared page realm. No React, SDK, or Zod runtime dependencies. */
import type { ComponentType } from 'react';
import type { PluginContentScriptContext } from '@get-bb/plugin-sdk';
import type { FileTarget, JsonValue, SourceIdentity } from './index.js';
export interface OwnerPresentationClient {
 readonly pluginId: string;
 call(method: string, input: JsonValue, signal?: AbortSignal): Promise<unknown>;
}
export interface PresentationNavigator {
 toThread(threadId: string): void;
 openUrl(url: string): void;
 openFile(target: FileTarget): boolean;
}
export interface PresentationPropsV1<D = unknown> {
 identity: SourceIdentity;
 revision?: string;
 data: D;
 owner: OwnerPresentationClient;
 navigate: PresentationNavigator;
 mode: 'docked' | 'full';
 size: { maxWidth: number; maxHeight: number; preferredHeight: number };
 consumer: { pluginId: string; surface: string };
 requestFull?: () => void;
 refresh?: () => void;
}
export type PresentationComponent<D = unknown> = ComponentType<PresentationPropsV1<D>>;
export type PresentationEntryV1 = Readonly<{
 pluginId: string; schema: string; generation: number; token: symbol;
 load: () => Promise<PresentationComponent>;
 decode: (data: unknown) => unknown | null;
 methods: readonly string[]; label?: string;
}>;
export interface PresentationRegistration<D> {
 schema: string;
 load: () => Promise<PresentationComponent<D>>;
 decode: (data: unknown) => D | null;
 methods: readonly string[];
 label?: string;
}
type RegistryV1 = { entries: Map<string, PresentationEntryV1>; events: EventTarget; revision: number };
type Realm = { v1?: RegistryV1 };
const key = Symbol.for('phosphor.bb-context-recognition.presentations');
const globalRealm = globalThis as typeof globalThis & { [key]?: Realm };
function registry(): RegistryV1 {
 const realm = globalRealm[key] ??= {};
 return realm.v1 ??= {entries: new Map(), events: new EventTarget(), revision: 0};
}
const schemaPattern = /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,3}\/[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/;
export class PresentationRegistrationError extends Error {
 constructor(message: string) {super(message); this.name = 'PresentationRegistrationError';}
}
function changed(r: RegistryV1): void {r.revision++; r.events.dispatchEvent(new Event('change'));}
/** ctx must be the host's content-script mount context. Same generation: last mount wins. */
export function registerPresentation<D>(ctx: Pick<PluginContentScriptContext, 'pluginId'|'generation'|'signal'>, registration: PresentationRegistration<D>): () => void {
 if (!ctx || typeof ctx.pluginId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(ctx.pluginId) || !Number.isSafeInteger(ctx.generation) || ctx.generation < 1 || !ctx.signal?.addEventListener)
  throw new PresentationRegistrationError('Expected a host content-script context.');
 if (typeof registration?.schema !== 'string' || registration.schema.length > 100 || !schemaPattern.test(registration.schema) || typeof registration.load !== 'function' || typeof registration.decode !== 'function' || !Array.isArray(registration.methods) || registration.methods.length < 1 || registration.methods.length > 16 || registration.methods.some(m => typeof m !== 'string' || m.length < 1 || m.length > 256 || /\p{Cc}/u.test(m)) || new Set(registration.methods).size !== registration.methods.length || (registration.label !== undefined && (typeof registration.label !== 'string' || registration.label.length > 64)))
  throw new PresentationRegistrationError('Invalid presentation registration.');
 const r = registry(), entryKey = ctx.pluginId + '\0' + registration.schema;
 if (ctx.signal.aborted || (r.entries.get(entryKey)?.generation ?? 0) > ctx.generation) return () => {};
 const entry: PresentationEntryV1 = Object.freeze({pluginId: ctx.pluginId, schema: registration.schema, generation: ctx.generation, token: Symbol(), load: registration.load as () => Promise<PresentationComponent>, decode: registration.decode, methods: Object.freeze([...registration.methods]), ...(registration.label === undefined ? {} : {label: registration.label})});
 let disposed = false;
 const dispose = () => {
  if (disposed) return;
  disposed = true;
  ctx.signal.removeEventListener('abort', dispose);
  if (r.entries.get(entryKey)?.token === entry.token) {r.entries.delete(entryKey); changed(r);}
 };
 r.entries.set(entryKey, entry);
 ctx.signal.addEventListener('abort', dispose, {once: true});
 changed(r);
 return dispose;
}
export function lookupPresentation(pluginId: string, schema: string): PresentationEntryV1 | undefined {return registry().entries.get(pluginId + '\0' + schema);}
export function subscribePresentations(listener: () => void): () => void {
 const r = registry(); r.events.addEventListener('change', listener);
 return () => r.events.removeEventListener('change', listener);
}
export function getPresentationRevision(): number {return registry().revision;}
