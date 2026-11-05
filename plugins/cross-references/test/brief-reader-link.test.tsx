// @vitest-environment jsdom
import {cleanup,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,expect,test} from 'vitest';
import {renderSlot} from '@get-bb/plugin-sdk/testing/app';
import {z} from 'zod';
import {BriefNavigationSurface,BriefMentionRow,type BriefMention} from '../brief-producer.tsx';
import {type BriefNavigationInput,type BriefNavigationOutput} from '@phosphorco/bb-cross-references';
afterEach(cleanup);
const hash='a'.repeat(64),file={kind:'thread-storage' as const,threadId:'thr_23456789ab',path:'BRIEF.md' as const};
function item(index=0):BriefMention{return {kind:'brief-occurrence',source:{provider:'recognition',keys:{provider:'bb.file',identity:hash},presentation:{label:'Brief'}},target:{provider:'url',keys:{href:'https://example.test/a'},presentation:{label:'Target',url:'https://example.test/a'}},producerPluginId:'thread-brief',graphRevision:8,evidenceRevision:8,cap:{state:'uncapped',limit:100,sourceHistoryUnknown:false},occurrenceKey:index.toString(16).padStart(64,'0'),sourceOccurrenceId:`ref-${index}`,locator:{kind:'thread-brief',threadId:file.threadId,file,sourceContentRevision:hash,section:{heading:{state:'named',text:index?'Second':'Goal'},line:index+1},location:{kind:'line',line:2,column:null,endLine:null}},sourceContentRevision:hash,frame:{codec:'utf8-fatal-bom-consumed-v1',rawBytes:20,bomBytes:0,fileUtf16Length:20,bodyBase:{startUtf16:0,startLine:1,utf16Length:20},lineMapping:{codec:'native-file-lines-v1',fileLineCount:3}},excerpt:{state:'unavailable',reason:'not-materialized',codecVersion:1},confirmation:'producer-attested',authoredUrlState:'not-url',authoredUrl:{state:'not-url'},provenance:{state:'withheld',digest:hash,cause:'policy',display:'Recognition details withheld',summary:{pluginId:'thread-brief',origin:'builtin',confidence:'high',basis:'explicit'}}};}

test('actual surface uses a public UrlLink when imperative HTTP URL opening declines an app route',async()=>{
 const row=item(),reader={kind:'thread-brief-reader' as const,version:1 as const,owner:'thread-brief' as const,path:'reveal' as const,threadId:file.threadId,token:'00000000-0000-4000-8000-000000000001'},path='/plugins/thread-brief/reveal/v1/'+file.threadId+'/'+reader.token,activated:string[]=[],requests:string[]=[];
 const sdk={plugins:{callRpc:async<T,>(request:{method:string;input?:unknown;outputSchema:z.ZodType<T>})=>{requests.push(request.method);if(request.method==='threadBriefNavigation.describe')return request.outputSchema.parse({protocol:'thread-brief-navigation',versions:[1],renderedReaderVersions:[1]});const i=request.input as BriefNavigationInput;const result:BriefNavigationOutput={version:1,state:'ready',sourceFile:i.sourceFile,sourceContentRevision:i.sourceContentRevision,location:{kind:'line',line:i.section.originalLine,column:null},proof:{kind:'accepted-revision-revalidated',acceptedRevision:i.sourceContentRevision,selection:'same-revision',frame:i.frame},reader};return request.outputSchema.parse(result);}}};
 const capture=(event:MouseEvent)=>{if(event.target instanceof HTMLAnchorElement&&event.target.getAttribute('href')===path){activated.push(path);event.preventDefault();}};document.addEventListener('click',capture,true);
 const slot=renderSlot({component:()=> <BriefNavigationSurface><BriefMentionRow item={row}/></BriefNavigationSurface>},{},{sdk,openUrl:()=>false});
 try{fireEvent.click(slot.getByRole('link',{name:'Goal'}));await waitFor(()=>expect(activated).toEqual([path]));expect(requests).toEqual(['threadBriefNavigation.describe','threadBriefNavigationV1ResolveHeading']);expect(slot.inspection.navigateCalls).toHaveLength(0);expect(slot.queryByRole('alert')).toBeNull();}
 finally{slot.lifecycle.unmount();document.removeEventListener('click',capture,true);}
});
