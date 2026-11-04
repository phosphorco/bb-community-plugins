import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createInboxRowsClient} from './bb.js';
import {METHODS,assertRowPresentation,type ReadInput,type ReadOutput} from './index.js';
type FakeHost=ReturnType<typeof createFakePluginHost>;
export interface InboxRowsConformanceHost {bb:Pick<BbPluginApi,'rpc'|'storage'>;harness:{behavior:Pick<FakeHost['harness']['behavior'],'callRpc'>;lifecycle:Pick<FakeHost['harness']['lifecycle'],'dispose'>};}
export async function runInboxRowsSupplierConformance(options:{pluginId:string;createHost?:(options:{pluginId:string})=>InboxRowsConformanceHost;register:(bb:InboxRowsConformanceHost['bb'])=>unknown|Promise<unknown>;cases:readonly {input:ReadInput;check:(output:ReadOutput)=>unknown}[];presentation:{schema:string;methods:readonly string[]}}){
 const host=(options.createHost??createFakePluginHost)({pluginId:options.pluginId}),checks:{name:string;passed:boolean;error?:string}[]=[];
 const check=async(name:string,fn:()=>unknown|Promise<unknown>)=>{try{await fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:String(e)});}};
 try {
 await check('real-registration',()=>options.register(host.bb));
 const client=createInboxRowsClient(async c=>{if(c.pluginId!==options.pluginId)throw Error('Wrong owner');return host.harness.behavior.callRpc(c.method,c.input);},options.pluginId);
 await check('version-negotiation',()=>client.describe());
 await check('presentation-read-allowlist',()=>assertRowPresentation(options.presentation));
 await check('strict-input',async()=>{for(const input of [{version:1,occurrences:[{key:'k',threadId:'t'}],archiveMode:'active',extra:true},{version:1,occurrences:[{key:'k',threadId:'t',extra:true}],archiveMode:'active'},{version:1,occurrences:[{key:'k',threadId:'t'},{key:'k',threadId:'t2'}],archiveMode:'active'}]){let rejected=false;try{await host.harness.behavior.callRpc(METHODS.read,input);}catch(e){rejected=(e as {name?:string}).name==='ZodError'||(e as {code?:string}).code==='invalid_input';}if(!rejected)throw Error('Malformed input was not rejected with validation evidence');}});
 for(const [i,c]of options.cases.entries())await check(`read:${i}`,async()=>c.check(await client.read(c.input)));
 if(!options.cases.length)checks.push({name:'supplier-owned-witnesses',passed:false});
 return {pluginId:options.pluginId,proof:'source-conformance' as const,passed:checks.every(c=>c.passed),checks};
 } finally { await host.harness.lifecycle.dispose(); }
}
