/** Optional React host; registration and wire entries stay React-free. */
import { Component, Suspense, lazy, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode, ErrorInfo, LazyExoticComponent } from 'react';
import type { PluginBrowserBbSdk } from '@get-bb/plugin-sdk';
import { LIMITS, PresentationRefV1Schema, SafeHrefSchema, FileTargetSchema, UnknownResultSchema, canonicalJson } from './index.js';
import type { JsonValue, PresentationRefV1 } from './index.js';
import { classifyRecognitionError } from './bb.js';
import type { RecognitionErrorKind } from './bb.js';
import { getPresentationRevision, lookupPresentation, subscribePresentations } from './presentation.js';
import type { PresentationComponent, PresentationEntryV1, PresentationPropsV1, OwnerPresentationClient } from './presentation.js';
export class PresentationCallError extends Error {
 readonly kind: RecognitionErrorKind | 'not-allowed';
 readonly cause: unknown;
 constructor(kind: RecognitionErrorKind | 'not-allowed', cause?: unknown) {super(`Presentation call failed: ${kind}`); this.name='PresentationCallError'; this.kind=kind; this.cause=cause;}
}
/** Explicit owner route, one call, no retry. Bounds decoded canonical JSON, not raw transport bytes. */
export function createOwnerPresentationClient(sdk: Pick<PluginBrowserBbSdk, 'plugins'>, entry: PresentationEntryV1): OwnerPresentationClient & {dispose(): void} {
 const pending = new Set<AbortController>();
 const methods = new Set(entry.methods);
 let disposed = false;
 return {
  pluginId: entry.pluginId,
  call(method, input, callerSignal) {
   if (!methods.has(method)) return Promise.reject(new PresentationCallError('not-allowed'));
   if (disposed || callerSignal?.aborted) return Promise.reject(new PresentationCallError('cancelled'));
   try {canonicalJson(input);} catch (e) {return Promise.reject(new PresentationCallError('incompatible', e));}
   const controller = new AbortController(); pending.add(controller);
   return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: PresentationCallError | undefined, value?: unknown) => {
     if (settled) return;
     settled = true; clearTimeout(timer); callerSignal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', aborted); pending.delete(controller);
     controller.abort();
     if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(new PresentationCallError('cancelled'));
    const aborted = () => finish(new PresentationCallError('cancelled'));
    const timer = setTimeout(() => finish(new PresentationCallError('transient')), LIMITS.presentationRpcMs);
    callerSignal?.addEventListener('abort', cancel, {once:true}); controller.signal.addEventListener('abort', aborted, {once:true});
    Promise.resolve().then(() => {
     if (settled) return undefined;
     return sdk.plugins.callRpc({pluginId:entry.pluginId, method, input, outputSchema:UnknownResultSchema, signal:controller.signal});
    }).then(value => {
     if (settled) return;
     try {
      if (new TextEncoder().encode(canonicalJson(value)).byteLength > LIMITS.responseBytes) throw new TypeError('Presentation result exceeds responseBytes.');
      finish(undefined, value);
     } catch(e) {finish(new PresentationCallError('incompatible', e));}
    }, error => {if (!settled) finish(new PresentationCallError(classifyRecognitionError(error), error));});
   });
  },
  dispose() {if (disposed) return; disposed=true; for (const controller of [...pending]) controller.abort();}
 };
}
export interface PresentationDiagnostic {pluginId: string; schema: string; stage:'decode'|'render'; message: string}
export interface PresentationHostProps extends Omit<PresentationPropsV1, 'data'|'owner'> {
 sdk: Pick<PluginBrowserBbSdk, 'plugins'>;
 stamp: PresentationRefV1 & {pluginId: string};
 readyPlugins: ReadonlySet<string>;
 fallback: ReactNode;
 onDiagnostic?: (diagnostic: PresentationDiagnostic) => void;
 /** Consumer-owned retry attempt; remounts the failed boundary without changing source revision. */
 retryKey?: number;
 /** The supplier subtree committed successfully (including after Suspense). */
 onReady?: () => void;
}
const loaders = new WeakMap<PresentationEntryV1, {component:LazyExoticComponent<PresentationComponent>;failed:boolean}>();
// Entry objects are immutable and token-unique. WeakMap avoids retaining retired code.
function componentFor(entry: PresentationEntryV1): LazyExoticComponent<PresentationComponent> {
 let cached = loaders.get(entry);
 if (!cached || cached.failed) {
  const next={component:null as unknown as LazyExoticComponent<PresentationComponent>,failed:false};
  next.component=lazy(()=>entry.load().then(defaultExport=>({default:defaultExport}),error=>{next.failed=true;throw error;}));
  loaders.set(entry,next);cached=next;
 }
 return cached.component;
}
class HostedBoundary extends Component<{children:ReactNode;fallback:ReactNode;entry:PresentationEntryV1;onDiagnostic?:PresentationHostProps['onDiagnostic']}, {failed:boolean}> {
 state={failed:false};
 static getDerivedStateFromError() {return {failed:true};}
 componentDidCatch(error: unknown, _info:ErrorInfo) {
  try {this.props.onDiagnostic?.({pluginId:this.props.entry.pluginId,schema:this.props.entry.schema,stage:'render',message:error instanceof Error ? error.message : 'Hosted view failed.'});} catch {}
 }
 render() {return this.state.failed ? <>{this.props.fallback}<span role="status" className="text-muted-foreground">Plan view failed</span></> : this.props.children;}
}
function Hosted(props:PresentationHostProps & {entry:PresentationEntryV1;data:unknown;View:LazyExoticComponent<PresentationComponent>}): ReactElement {
 const {entry, sdk} = props;
 const ownerState = useMemo(() => {
  let client:ReturnType<typeof createOwnerPresentationClient>|undefined;
  let active=true;
  const owner:OwnerPresentationClient={pluginId:entry.pluginId,call(method,input,signal) {
   if(!active)return Promise.reject(new PresentationCallError('cancelled'));
   client ??= createOwnerPresentationClient(sdk,entry);
   return client.call(method,input,signal);
  }};
  return {owner,activate(){active=true;},dispose(){active=false;client?.dispose();client=undefined;}};
 },[entry,sdk]);
 useLayoutEffect(()=>{ownerState.activate();return()=>ownerState.dispose();},[ownerState]);
 // A boundary failure or teardown cancels acknowledgement after commit effects.
 useEffect(()=>{let active=true;queueMicrotask(()=>{if(active)props.onReady?.();});return()=>{active=false;};},[props.onReady]);
 const navigate=useMemo(()=>({
  toThread:props.navigate.toThread,
  openUrl:(url:string)=>{if(SafeHrefSchema.safeParse(url).success)props.navigate.openUrl(url);},
  openFile:(target:Parameters<typeof props.navigate.openFile>[0])=>FileTargetSchema.safeParse(target).success&&props.navigate.openFile(target),
 }),[props.navigate]);
 const View=props.View;
 const componentProps:PresentationPropsV1={identity:props.identity,data:props.data,owner:ownerState.owner,navigate,mode:props.mode,size:props.size,consumer:props.consumer,
  ...(props.revision===undefined?{}:{revision:props.revision}),...(props.requestFull?{requestFull:props.requestFull}:{}),...(props.refresh?{refresh:props.refresh}:{})};
 return <div data-bb-plugin-root="" data-bb-plugin={entry.pluginId} className="contents"><View {...componentProps}/></div>;
}
/** Mounted by the consumer only when visible and within its mount cap. */
export function PresentationHost(props: PresentationHostProps): ReactElement {
 useSyncExternalStore(subscribePresentations,getPresentationRevision,()=>0);
 const entry=lookupPresentation(props.stamp.pluginId,props.stamp.schema);
 const decoded=useMemo(()=>{
  if(!entry||!props.readyPlugins.has(entry.pluginId)||!PresentationRefV1Schema.safeParse(props.stamp).success)return null;
  try {return entry.decode(props.stamp.data);} catch {return null;}
 },[entry,props.stamp,props.readyPlugins]);
 // Keep attempt selection outside Suspense: sibling counters are independent,
 // and suspended retries must reuse their already selected lazy component.
 const View=useMemo(()=>entry?componentFor(entry):null,[entry,props.retryKey,props.revision]);
 if(!entry||decoded===null||!View)return <>{props.fallback}</>;
 // Token-local boundary: the token's entry gets a new inner component on replacement.
 return <TokenHost key={`${boundaryKey(entry,props.revision)}:${props.retryKey??0}`} {...props} entry={entry} data={decoded} View={View}/>;
}
const tokenKeys=new WeakMap<PresentationEntryV1,number>();let nextKey=0;
function boundaryKey(entry:PresentationEntryV1,revision:string|undefined):string {let id=tokenKeys.get(entry);if(id===undefined){id=++nextKey;tokenKeys.set(entry,id);}return `${id}:${revision??''}`;}
function TokenHost(props:PresentationHostProps & {entry:PresentationEntryV1;data:unknown;View:LazyExoticComponent<PresentationComponent>}):ReactElement {
 return <HostedBoundary entry={props.entry} fallback={props.fallback} {...(props.onDiagnostic?{onDiagnostic:props.onDiagnostic}:{})}><Suspense fallback={props.fallback}><Hosted {...props}/></Suspense></HostedBoundary>;
}
