import { createContext, createElement, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSelector } from '@tanstack/react-store';
import { UrlLink, experimental_FileLink as FileLink, useRpc, useRealtimeConnectionState } from '@get-bb/plugin-sdk/app';
import { MarkdownRequestSchema, type MarkdownRequest, type MarkdownSource, type MarkdownNode, type PreparedMarkdown } from './index.js';
import { createMarkdownSurface, type MarkdownSurface, type MarkdownTransport } from './store.js';
import type { markdownRpcContract } from './bb.js';
import { NativeCodeBlock, NativeMath, NativeImage } from './native.js';
export type { MarkdownTransport } from './store.js';

const STYLES = `.bb-md{min-width:0;overflow-wrap:anywhere;line-height:1.5;color:var(--foreground)}.bb-md p,.bb-md .bb-md-p{margin:0 0 .5rem}.bb-md p:last-child,.bb-md .bb-md-p:last-child{margin-bottom:0}.bb-md h1,.bb-md h2,.bb-md h3,.bb-md h4,.bb-md h5,.bb-md h6{font-weight:600;margin:1rem 0 .5rem}.bb-md h1{font-size:1.15em}.bb-md ul,.bb-md ol{padding-left:1.25rem;margin:.5rem 0}.bb-md ul{list-style:disc}.bb-md ol{list-style:decimal}.bb-md blockquote{border-left:2px solid var(--border);padding-left:.75rem;margin:.5rem 0;color:var(--muted-foreground)}.bb-md code{font-family:var(--font-mono,monospace);background:var(--muted);border-radius:3px;padding:.08em .25em;font-size:.92em}.bb-md pre{white-space:pre-wrap;overflow-wrap:anywhere}.bb-md pre code{padding:0;background:transparent}.bb-md a{color:var(--link,var(--primary));text-decoration:underline;text-underline-offset:2px}.bb-md img{max-width:100%;height:auto}.bb-md-table{overflow:auto}.bb-md table{border-collapse:collapse;max-width:100%;font-size:inherit}.bb-md th,.bb-md td{border:1px solid var(--border);padding:.3rem .5rem;text-align:left}.bb-md hr{border:0;border-top:1px solid var(--border);margin:.75rem 0}.bb-md-literal{font:inherit;white-space:pre-wrap;margin:0;overflow-wrap:anywhere}.bb-md-error{color:var(--muted-foreground);font-size:.85em}.bb-md-error button{text-decoration:underline}.bb-md-inline-native,.bb-md-inline-native>p{display:contents}.bb-md .bb-md-h1,.bb-md .bb-md-h2,.bb-md .bb-md-h3,.bb-md .bb-md-h4,.bb-md .bb-md-h5,.bb-md .bb-md-h6{font-weight:600;margin:1rem 0 .5rem}.bb-md .bb-md-h1{font-size:1.15em}.bb-md[data-layout=compact]{font-size:inherit}`;
type Lease = ReturnType<MarkdownSurface['acquire']>;
type ContextValue = { surface: MarkdownSurface; attach(node:HTMLElement,lease:Lease):()=>void };
const Context = createContext<ContextValue|null>(null);
/** One owner per mounted surface, never one discovery/network owner per leaf. */
export function MarkdownProvider(props:{transport?:MarkdownTransport;reconnectKey?:unknown;children:ReactNode}) {
  return props.transport?<TransportMarkdownProvider {...props} transport={props.transport}/>:<RpcMarkdownProvider {...props}/>;
}
function RpcMarkdownProvider({children}:{children:ReactNode}) {
  const rpc=useRpc<typeof markdownRpcContract>(),connection=useRealtimeConnectionState();
  const transport=useMemo<MarkdownTransport>(()=>({
    // The SDK local RPC API has no AbortSignal parameter. The surface fences
    // late completions; server reads have their own deadlines and disposal.
    prepare:input=>rpc.call('markdownPrepareV1',input),
    invalidate:async()=>{await rpc.call('markdownInvalidateV1',{});},
  }),[rpc]);
  const [epoch,setEpoch]=useState(0),prior=useRef(connection);
  useEffect(()=>{const previous=prior.current;prior.current=connection;if(previous!=='connected'&&connection==='connected')setEpoch(value=>value+1);},[connection]);
  return <TransportMarkdownProvider transport={transport} reconnectKey={epoch}>{children}</TransportMarkdownProvider>;
}
function TransportMarkdownProvider({transport,reconnectKey,children}:{transport:MarkdownTransport;reconnectKey?:unknown;children:ReactNode}) {
  const state=useMemo(()=>{
    const surface=createMarkdownSurface(transport), nodes=new Map<HTMLElement,Lease>(),byKey=new Map<string,Set<HTMLElement>>();
    let observer:IntersectionObserver|null=null;
    surface.interaction(key=>{
      if(typeof document==='undefined')return false;
      const selection=document.getSelection();
      for(const node of byKey.get(key)??[]){
        if(document.activeElement && document.activeElement!==document.body && node.contains(document.activeElement))return true;
        if(selection&&!selection.isCollapsed)for(let i=0;i<selection.rangeCount;i++){try{if(selection.getRangeAt(i).intersectsNode(node))return true;}catch{/* A retired/disconnected range grants no routing authority. */}}
      }
      return false;
    });
    return {surface,nodes,
      attach(node:HTMLElement,lease:Lease){nodes.set(node,lease);let set=byKey.get(lease.key);if(!set){set=new Set();byKey.set(lease.key,set);}set.add(node);if(observer){lease.visibility(false);observer.observe(node);}return()=>{observer?.unobserve(node);nodes.delete(node);set!.delete(node);if(!set!.size)byKey.delete(lease.key);};},
      observe(value:IntersectionObserver|null){observer=value;if(value)for(const [node,lease]of nodes){lease.visibility(false);value.observe(node);}},
    };
  },[transport]);
  useEffect(()=>{
    const update=()=>state.surface.visibility(document.visibilityState!=='hidden');
    const flush=()=>state.surface.flushInteractions();
    const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(records=>{
      for(const record of records)state.nodes.get(record.target as HTMLElement)?.visibility(record.isIntersecting);
    });
    state.observe(observer);state.surface.start();update();
    document.addEventListener('visibilitychange',update);
    for(const event of ['selectionchange','pointerup','keyup','focusout'])document.addEventListener(event,flush);
    return()=>{document.removeEventListener('visibilitychange',update);for(const event of ['selectionchange','pointerup','keyup','focusout'])document.removeEventListener(event,flush);observer?.disconnect();state.observe(null);state.surface.stop();};
  },[state]);
  const previous=useRef(reconnectKey);
  useEffect(()=>{if(!Object.is(previous.current,reconnectKey)){previous.current=reconnectKey;state.surface.refresh();}},[reconnectKey,state]);
  return <Context.Provider value={state}><style>{STYLES}</style>{children}</Context.Provider>;
}
export interface MarkdownProps { content:string; source:MarkdownSource; intent:'prose'; layout?:'compact'|'full'; className?:string }
/** Required source+intent is validated again at runtime; a forged/missing frame
 * yields readable inert text and no backend demand. No ambient hook fallback. */
export const Markdown=memo(function Markdown(props:MarkdownProps){
  const context=useContext(Context), wrapper=useRef<HTMLDivElement>(null);
  const decoded=useMemo(()=>MarkdownRequestSchema.safeParse({content:props.content,source:props.source,intent:props.intent}),[props.content,props.source,props.intent]);
  if(!decoded.success||!context)return <div className={`bb-md ${props.className??''}`} data-markdown-state="unprepared"><pre className="bb-md-literal">{typeof props.content==='string'?props.content:''}</pre></div>;
  return <MarkdownDemand request={decoded.data} context={context} wrapper={wrapper} layout={props.layout??'full'} {...(props.className?{className:props.className}:{})}/>;
});
function MarkdownDemand({request,context,wrapper,layout,className}:{request:MarkdownRequest;context:ContextValue;wrapper:{current:HTMLDivElement|null};layout:'compact'|'full';className?:string}) {
  const key=context.surface.key(request);
  const entry=useMemo(()=>context.surface.entry(request),[context.surface,key]);
  const snapshot=useSelector(entry.store);
  useLayoutEffect(()=>{
    const lease=context.surface.acquire(request,typeof IntersectionObserver==='undefined');
    const node=wrapper.current,detach=node?context.attach(node,lease):undefined;
    return()=>{detach?.();lease.release();};
  },[context,key]);
  return <div ref={wrapper} className={`bb-md ${className??''}`} data-layout={layout} data-markdown-state={snapshot.model.status}>
    <PreparedMarkdownView model={snapshot.model}/>
    {snapshot.error&&<p className="bb-md-error" role="status">Markdown metadata is unavailable. <button type="button" onClick={()=>context.surface.refresh()}>Retry Markdown</button></p>}
  </div>;
}
/** Prepared data only. This does no recognition and cannot recursively enroll
 * excerpts or technical leaves. Runtime transport decoding belongs to owner. */
const PreparedMarkdownView=memo(function PreparedMarkdownView({model}:{model:PreparedMarkdown}) {
  if(model.format==='literal'||!model.tree)return <pre className="bb-md-literal">{model.original}</pre>;
  const render=(nodes:readonly MarkdownNode[],parentKey:string,insideLink=false):ReactNode=>nodes.map((node,index)=>{
    const key=`${parentKey}/${index}`;
    if(node.kind==='text')return node.value;
    if(node.kind==='code-block')return <NativeCodeBlock key={key} value={node.value} {...(node.language?{language:node.language}:{})}/>;
    if(node.kind==='math')return insideLink?<code key={key}>{node.value}</code>:<NativeMath key={key} value={node.value} display={node.display} {...(!node.display?{className:'bb-md-inline-native'}:{})}/>;
    if(node.kind==='local-image')return insideLink||!model.document?<span key={key}>{node.alt}</span>:<NativeImage key={key} target={node.target} document={model.document} alt={node.alt} {...(node.title?{title:node.title}:{})}/>;
    if(node.kind==='image')return <img key={key} src={node.src} alt={node.alt} title={node.title} loading="lazy"/>;
    if(node.kind==='file')return insideLink?<span key={key}>{render(node.children,key,true)}</span>:<FileLink key={key} target={node.target} {...(node.location?{location:node.location}:{})} {...(node.title?{title:node.title}:{})}>{render(node.children,key,true)}</FileLink>;
    const children=render(node.children,key,insideLink||node.tag==='a');
    if(node.tag==='a')return insideLink||!node.href?<span key={key}>{children}</span>:node.href.startsWith('#')?<a key={key} href={node.href} title={node.title}>{children}</a>:<UrlLink key={key} href={node.href} title={node.title}>{children}</UrlLink>;
    if(node.tag==='input')return <input key={key} type="checkbox" checked={node.checked??false} disabled readOnly aria-label={node.checked?'Completed task':'Incomplete task'}/>;
    if(node.tag==='table')return <div key={key} className="bb-md-table"><table>{children}</table></div>;
    const attributes={key,...(node.title?{title:node.title}:{}),...(node.start===undefined?{}:{start:node.start}),...(node.align?{style:{textAlign:node.align}}:{}),...(node.colSpan===undefined?{}:{colSpan:node.colSpan}),...(node.rowSpan===undefined?{}:{rowSpan:node.rowSpan})};
    // SDK technical components own flow wrappers. Preserve valid HTML by
    // using an equivalent accessible flow container for the rare paragraph or
    // phrasing ancestor that contains one, never div/p nested inside a p.
    const hasIsland=(items:readonly MarkdownNode[]):boolean=>items.some(item=>item.kind==='math'||item.kind==='local-image'||item.kind==='code-block'||(item.kind==='element'&&hasIsland(item.children)));
    if(hasIsland(node.children)&&['p','span','em','strong','b','i','del','ins','small','sub','sup','h1','h2','h3','h4','h5','h6'].includes(node.tag)){
      const heading=/^h[1-6]$/.test(node.tag),role=node.tag==='p'?'paragraph':heading?'heading':['em','i'].includes(node.tag)?'emphasis':['strong','b'].includes(node.tag)?'strong':node.tag==='del'?'deletion':node.tag==='ins'?'insertion':undefined;
      const style=['em','i'].includes(node.tag)?{display:'contents',fontStyle:'italic'}:['strong','b'].includes(node.tag)?{display:'contents',fontWeight:600}:node.tag==='span'?{display:'contents'}:undefined;
      const {key:elementKey,...flowAttributes}=attributes;
      return <div key={elementKey} {...flowAttributes} className={`bb-md-${node.tag}`} {...(role?{role}:{})} {...(heading?{'aria-level':Number(node.tag[1])}:{})} {...(style?{style}:{})}>{children}</div>;
    }
    return createElement(node.tag,attributes,...(node.tag==='br'||node.tag==='hr'?[]:[children]));
  });
  return <>{render(model.tree.children,'markdown')}</>;
});
export { createMarkdownSurface } from './store.js';
