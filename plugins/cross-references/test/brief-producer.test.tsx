// @vitest-environment jsdom
import {act,cleanup,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {renderSlot} from '@get-bb/plugin-sdk/testing/app';
import {z} from 'zod';
import {activateBriefReaderAnchor,useBriefReaderLink,BriefNavigationSurface,BriefMentionRow,BriefProducerStatus,createBriefIntentOwner,briefStatusMessage,type BriefMention} from '../brief-producer.tsx';
import {type BriefNavigationInput,type BriefNavigationOutput,type ProducerState} from '@phosphorco/bb-cross-references';
afterEach(cleanup);
const hash='a'.repeat(64),file={kind:'thread-storage' as const,threadId:'thr_brief_ui',path:'BRIEF.md' as const};
function item(index=0):BriefMention{return {kind:'brief-occurrence',source:{provider:'recognition',keys:{provider:'bb.file',identity:hash},presentation:{label:'Brief'}},target:{provider:'url',keys:{href:'https://example.test/a'},presentation:{label:'Target',url:'https://example.test/a'}},producerPluginId:'thread-brief',graphRevision:8,evidenceRevision:8,cap:{state:'uncapped',limit:100,sourceHistoryUnknown:false},occurrenceKey:index.toString(16).padStart(64,'0'),sourceOccurrenceId:`ref-${index}`,locator:{kind:'thread-brief',threadId:file.threadId,file,sourceContentRevision:hash,section:{heading:{state:'named',text:index?'Second':'Goal'},line:index+1},location:{kind:'line',line:2,column:null,endLine:null}},sourceContentRevision:hash,frame:{codec:'utf8-fatal-bom-consumed-v1',rawBytes:20,bomBytes:0,fileUtf16Length:20,bodyBase:{startUtf16:0,startLine:1,utf16Length:20},lineMapping:{codec:'native-file-lines-v1',fileLineCount:3}},excerpt:{state:'unavailable',reason:'not-materialized',codecVersion:1},confirmation:'producer-attested',authoredUrlState:'not-url',authoredUrl:{state:'not-url'},provenance:{state:'withheld',digest:hash,cause:'policy',display:'Recognition details withheld',summary:{pluginId:'thread-brief',origin:'builtin',confidence:'high',basis:'explicit'}}};}
function input(index=0):BriefNavigationInput{const i=item(index);return {version:1,sourceFile:file,sourceContentRevision:hash,frame:i.frame,section:{heading:i.locator.section.heading,originalLine:i.locator.section.line}};}
function ready(i:BriefNavigationInput):BriefNavigationOutput{return {version:1,state:'ready',sourceFile:i.sourceFile,sourceContentRevision:i.sourceContentRevision,location:{kind:'line',line:i.section.originalLine,column:null},proof:{kind:'accepted-revision-revalidated',acceptedRevision:i.sourceContentRevision,selection:'same-revision',frame:i.frame}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function click(overrides:Partial<{button:number;ctrlKey:boolean;metaKey:boolean;altKey:boolean;shiftKey:boolean;defaultPrevented:boolean}>={}){return {button:0,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,defaultPrevented:false,currentTarget:{hasAttribute:()=>false},preventDefault:vi.fn(),...overrides};}
test('declared rendered destination gets exactly one native route dispatch; malformed targets stay fixed TOP',async()=>{
 const selected={...input(),sourceFile:{...file,threadId:'thr_23456789ab'}};
 const reader={kind:'thread-brief-reader' as const,version:1 as const,owner:'thread-brief' as const,path:'reveal' as const,threadId:selected.sourceFile.threadId,token:'00000000-0000-4000-8000-000000000001'};
 const pending=deferred<BriefNavigationOutput>(),open=vi.fn(()=>true),openReader=vi.fn(()=>true);
 const owner=createBriefIntentOwner({resolve:()=>pending.promise,open,openReader,changed:()=>{}});
 const one=owner.primary(click(),selected),two=owner.primary(click(),selected);expect(one).toBe(two);
 pending.resolve({...ready(selected),reader});await one;
 expect(openReader).toHaveBeenCalledExactlyOnceWith('/plugins/thread-brief/reveal/v1/thr_23456789ab/00000000-0000-4000-8000-000000000001',expect.any(AbortSignal));expect(open).not.toHaveBeenCalled();
 const malformed=createBriefIntentOwner({resolve:async()=>({...ready(selected),reader:{...reader,owner:'other'} as unknown as typeof reader}),open,openReader,changed:()=>{}});
 await malformed.primary(click(),selected);expect(openReader).toHaveBeenCalledTimes(1);expect(open).toHaveBeenCalledExactlyOnceWith({target:selected.sourceFile,location:null});
 const late=deferred<BriefNavigationOutput>();const cancelled=createBriefIntentOwner({resolve:()=>late.promise,open,openReader,changed:()=>{}});
 const flight=cancelled.primary(click(),selected);cancelled.primary(click({ctrlKey:true}),selected);late.resolve({...ready(selected),reader});await flight;expect(openReader).toHaveBeenCalledTimes(1);expect(open).toHaveBeenCalledTimes(1);
 owner.dispose();malformed.dispose();cancelled.dispose();
});
test('ready native fallback names the viewport limitation; failed opens never get a success note',async()=>{
 const states:any[]=[],open=vi.fn(()=>true),owner=createBriefIntentOwner({resolve:async()=>ready(input()),open,changed:value=>states.push(value)});
 await owner.primary(click(),input());expect(open).toHaveBeenCalledExactlyOnceWith({target:file,location:{kind:'line',line:1,column:null}});expect(states.at(-1)).toMatchObject({error:null,note:expect.stringContaining('Preview may not place the heading in view')});
 const failed:any[]=[];const declined=createBriefIntentOwner({resolve:async()=>ready(input()),open:()=>false,changed:value=>failed.push(value)});await declined.primary(click(),input());expect(failed.at(-1)).toMatchObject({note:null,error:expect.stringContaining('Could not open')});owner.dispose();declined.dispose();
});
test('surface owner shares identical read AND dispatch, sibling primary cancels the older result',async()=>{
 const a=deferred<BriefNavigationOutput>(),b=deferred<BriefNavigationOutput>(),open=vi.fn((_intent:unknown)=>true),changed=vi.fn(),resolve=vi.fn((i:BriefNavigationInput)=>i.section.originalLine===1?a.promise:b.promise),owner=createBriefIntentOwner({resolve,open,changed});
 const e=click(),one=owner.primary(e,input()),two=owner.primary(click(),input());expect(e.preventDefault).toHaveBeenCalledOnce();expect(one).toBe(two);expect(resolve).toHaveBeenCalledOnce();
 const other=owner.primary(click(),input(1));a.resolve(ready(input()));await one;expect(open).not.toHaveBeenCalled();b.resolve(ready(input(1)));await other;expect(open).toHaveBeenCalledOnce();expect(open.mock.calls[0]?.[0]).toMatchObject({location:{line:2}});
});
test.each(['ctrlKey','metaKey','altKey','shiftKey','defaultPrevented','aux','context'] as const)('new %s native top intent cancels old proof without prevention/new read',async kind=>{
 const pending=deferred<BriefNavigationOutput>(),resolve=vi.fn(()=>pending.promise),open=vi.fn((_intent:unknown)=>true),owner=createBriefIntentOwner({resolve,open,changed:()=>{}});const first=owner.primary(click(),input());const native=click(kind==='aux'?{button:1}:kind==='context'?{}:{[kind]:true});
 if(kind==='context')owner.cancel();else owner.primary(native,input(1));expect(native.preventDefault).not.toHaveBeenCalled();expect(resolve).toHaveBeenCalledOnce();pending.resolve(ready(input()));await first;expect(open).not.toHaveBeenCalled();
});
test('retirement, invalid input, mismatched proof and native open failure are bounded with no retry',async()=>{
 const late=deferred<BriefNavigationOutput>(),open=vi.fn((_intent:unknown)=>true),owner=createBriefIntentOwner({resolve:()=>late.promise,open,changed:()=>{}});const p=owner.primary(click(),input());owner.dispose();late.resolve(ready(input()));await p;expect(open).not.toHaveBeenCalled();
 const changes=vi.fn(),failure=vi.fn((_intent:unknown)=>false),resolve=vi.fn(async()=>({...ready(input()),sourceContentRevision:'b'.repeat(64)}));const next=createBriefIntentOwner({resolve,open:failure,changed:changes});await next.primary(click(),input());expect(failure).toHaveBeenCalledOnce();expect(failure.mock.calls[0]?.[0]).toMatchObject({location:null});expect(changes.mock.calls.at(-1)?.[0].error).toContain('Could not open');
 const malformed={...input(),section:{...input().section,originalLine:0}};expect(()=>next.primary(click(),malformed)).not.toThrow();expect(resolve).toHaveBeenCalledOnce();
});
test('ACTUAL public FileLink component: no mount proof, synchronous primary interception, one sibling-shared read/open and modifier cancellation',async()=>{
 const a=deferred<BriefNavigationOutput>(),requests:{method:string;input?:unknown}[]=[];
 const sdk={plugins:{callRpc:async<T,>(request:{method:string;input?:unknown;outputSchema:z.ZodType<T>})=>{requests.push(request);return request.outputSchema.parse(request.method==='threadBriefNavigation.describe'?{protocol:'thread-brief-navigation',versions:[1]}:await a.promise);}}};
 const slot=renderSlot({component:()=> <BriefNavigationSurface><BriefMentionRow item={item()}/><BriefMentionRow item={item(1)}/></BriefNavigationSurface>},{},{sdk});
 expect(requests).toHaveLength(0);const goal=slot.getByRole('link',{name:'Goal'}),second=slot.getByRole('link',{name:'Second'});
 fireEvent.click(goal);await waitFor(()=>expect(requests.filter(r=>r.method==='threadBriefNavigationV1ResolveHeading')).toHaveLength(1));fireEvent.click(goal);expect(requests.filter(r=>r.method==='threadBriefNavigationV1ResolveHeading')).toHaveLength(1);
 fireEvent.click(second,{ctrlKey:true});await act(async()=>a.resolve(ready(input())));expect(slot.inspection.navigateCalls.filter(n=>n.method==='experimental_openFilePreview'&&n.options.location!==null)).toHaveLength(0);
 slot.lifecycle.unmount();
});
test('producer warning has truthful wording and codes with projection=null, no fabricated claim',()=>{
 const state:ProducerState={version:1,projection:null,evidence:null,revisionHighWater:10,status:{state:'over-limit',sourceContentRevision:hash,limits:['target-count'],attemptRevision:10,statusDigest:hash,sourceFile:file,applicability:'current'}};
 expect(briefStatusMessage(state)).toBe('brief references not updated: over limit');const slot=renderSlot({component:()=> <BriefProducerStatus threadId={file.threadId} view={{state,loading:false,error:null,stale:false,refresh:()=>{}}}/>},{});
 expect(slot.getByText('target-count')).toBeTruthy();expect(slot.getByRole('link',{name:'Open BRIEF.md'})).toBeTruthy();expect(slot.queryByText(/Brief targets/)).toBeNull();slot.lifecycle.unmount();
});

test('ACTUAL sibling FileLinks: newer primary wins, identical pending primary has one read and one native open',async()=>{
 const a=deferred<BriefNavigationOutput>(),b=deferred<BriefNavigationOutput>(),reads:BriefNavigationInput[]=[];
 const sdk={plugins:{callRpc:async<T,>(request:{method:string;input?:unknown;outputSchema:z.ZodType<T>})=>{if(request.method==='threadBriefNavigation.describe')return request.outputSchema.parse({protocol:'thread-brief-navigation',versions:[1]});const current=request.input as BriefNavigationInput;reads.push(current);return request.outputSchema.parse(await (current.section.originalLine===1?a.promise:b.promise));}}};
 const slot=renderSlot({component:()=> <BriefNavigationSurface><BriefMentionRow item={item()}/><BriefMentionRow item={item(1)}/></BriefNavigationSurface>},{},{sdk,openFilePreview:()=>true});
 fireEvent.click(slot.getByRole('link',{name:'Goal'}));await waitFor(()=>expect(reads).toHaveLength(1));fireEvent.click(slot.getByRole('link',{name:'Second'}));fireEvent.click(slot.getByRole('link',{name:'Second'}));await waitFor(()=>expect(reads).toHaveLength(2));
 await act(async()=>a.resolve(ready(input())));expect(slot.inspection.navigateCalls).toHaveLength(0);await act(async()=>b.resolve(ready(input(1))));expect(slot.inspection.navigateCalls.filter(n=>n.method==='experimental_openFilePreview')).toHaveLength(1);const opened=slot.inspection.navigateCalls[0];if(opened?.method==='experimental_openFilePreview')expect(opened.options).toMatchObject({target:file,location:{line:2}});slot.lifecycle.unmount();
});

test('actual public UrlLink activates its single owned declared route anchor exactly once',async()=>{
 const path='/plugins/thread-brief/reveal/v1/thr_23456789ab/00000000-0000-4000-8000-000000000001',controller=new AbortController(),activated:string[]=[],results:boolean[]=[];
 function Control(){const link=useBriefReaderLink();return <>{link.link}<button onClick={()=>{void link.openReader(path,controller.signal).then(value=>results.push(value));}}>Open</button></>;}
 const capture=(event:MouseEvent)=>{const node=event.target;if(node instanceof HTMLAnchorElement){activated.push(node.getAttribute('href')!);event.preventDefault();}};document.addEventListener('click',capture,true);
 const slot=renderSlot({component:Control},{});
 try{fireEvent.click(slot.getByRole('button',{name:'Open'}));await waitFor(()=>expect(results).toEqual([true]));expect(activated).toEqual([path]);expect(slot.inspection.navigateCalls).toHaveLength(0);}
 finally{slot.lifecycle.unmount();document.removeEventListener('click',capture,true);}
});
test('aborted-before-commit and retired owners never activate the public route anchor',async()=>{
 const path='/plugins/thread-brief/reveal/v1/thr_23456789ab/00000000-0000-4000-8000-000000000001',controller=new AbortController(),activated:string[]=[],results:boolean[]=[];
 function Control(){const link=useBriefReaderLink();return <>{link.link}<button onClick={()=>{void link.openReader(path,controller.signal).then(value=>results.push(value));controller.abort();}}>Cancel</button></>;}
 const capture=(event:MouseEvent)=>{if(event.target instanceof HTMLAnchorElement){activated.push(event.target.href);event.preventDefault();}};document.addEventListener('click',capture,true);
 const slot=renderSlot({component:Control},{});try{fireEvent.click(slot.getByRole('button',{name:'Cancel'}));await waitFor(()=>expect(results).toEqual([false]));expect(activated).toEqual([]);}finally{slot.lifecycle.unmount();document.removeEventListener('click',capture,true);}
 const gate=deferred<boolean>(),states:unknown[]=[],reader=vi.fn(()=>gate.promise),selected={...input(),sourceFile:{...file,threadId:'thr_23456789ab'}},destination={kind:'thread-brief-reader' as const,version:1 as const,owner:'thread-brief' as const,path:'reveal' as const,threadId:selected.sourceFile.threadId,token:'00000000-0000-4000-8000-000000000001'};
 const owner=createBriefIntentOwner({resolve:async()=>({...ready(selected),reader:destination}),open:()=>{throw Error('second dispatch');},openReader:reader,changed:value=>states.push(value)});const flight=owner.primary(click(),selected);await waitFor(()=>expect(reader).toHaveBeenCalledOnce());owner.primary(click({ctrlKey:true}),selected);gate.resolve(true);await flight;expect(states.at(-1)).toEqual({pending:false,error:null,note:null});owner.dispose();
});

test('owned anchor boundary refuses shape, target, download, different origin and canceled signal',()=>{
 const path='/plugins/thread-brief/reveal/v1/thr_23456789ab/00000000-0000-4000-8000-000000000001',host=document.createElement('span'),a=document.createElement('a'),controller=new AbortController();a.href=path;host.append(a);document.body.append(host);const click=vi.spyOn(a,'click').mockImplementation(()=>{});
 try{expect(activateBriefReaderAnchor(host,path,controller.signal)).toBe(true);expect(click).toHaveBeenCalledOnce();a.target='_blank';expect(activateBriefReaderAnchor(host,path,controller.signal)).toBe(false);a.removeAttribute('target');a.download='file';expect(activateBriefReaderAnchor(host,path,controller.signal)).toBe(false);a.removeAttribute('download');a.href='https://outside.test'+path;expect(activateBriefReaderAnchor(host,path,controller.signal)).toBe(false);a.href=path;host.append(document.createElement('i'));expect(activateBriefReaderAnchor(host,path,controller.signal)).toBe(false);host.lastElementChild!.remove();controller.abort();expect(activateBriefReaderAnchor(host,path,controller.signal)).toBe(false);expect(click).toHaveBeenCalledOnce();host.remove();expect(activateBriefReaderAnchor(host,path,new AbortController().signal)).toBe(false);}
 finally{host.remove();click.mockRestore();}
});
test('a rejected old bridge cannot overwrite a newer canceled intent state',async()=>{
 let reject!:(error:Error)=>void;const held=new Promise<boolean>((_,r)=>{reject=r;}),states:unknown[]=[],selected={...input(),sourceFile:{...file,threadId:'thr_23456789ab'}},reader={kind:'thread-brief-reader' as const,version:1 as const,owner:'thread-brief' as const,path:'reveal' as const,threadId:selected.sourceFile.threadId,token:'00000000-0000-4000-8000-000000000001'},open=vi.fn(()=>held);
 const owner=createBriefIntentOwner({resolve:async()=>({...ready(selected),reader}),open:()=>{throw Error('second dispatch');},openReader:open,changed:state=>states.push(state)});const flight=owner.primary(click(),selected);await waitFor(()=>expect(open).toHaveBeenCalledOnce());owner.primary(click({metaKey:true}),selected);const count=states.length;reject(Error('retired rejection'));await flight;expect(states).toHaveLength(count);expect(states.at(-1)).toEqual({pending:false,error:null,note:null});owner.dispose();
});

test('an unmounted public-link owner refuses a retained opener without updating React or clicking',async()=>{
 let retained!:(path:string,signal:AbortSignal)=>Promise<boolean>;
 function Control(){const link=useBriefReaderLink();retained=link.openReader;return link.link;}
 const slot=renderSlot({component:Control},{});slot.lifecycle.unmount();expect(await retained('/plugins/thread-brief/reveal/v1/thr_23456789ab/00000000-0000-4000-8000-000000000001',new AbortController().signal)).toBe(false);
});
