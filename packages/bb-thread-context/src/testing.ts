/** Real registered handlers; source conformance does not prove live freshness/access. */
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createThreadContextClient} from './bb.js';
import {METHODS,type ReadOutput} from './index.js';
export async function runThreadContextSupplierConformance(options:{pluginId:string;register(bb:ReturnType<typeof createFakePluginHost>['bb']):void|Promise<void>;cases:readonly {threadId:string;expect:'ready'|'unavailable';check?:(value:ReadOutput)=>void}[]}) {
 const host=createFakePluginHost({pluginId:options.pluginId});const checks:{name:string;passed:boolean}[]=[];
 const check=async(name:string,fn:()=>unknown|Promise<unknown>)=>{try{await fn();checks.push({name,passed:true});}catch{checks.push({name,passed:false});}};
 const require=(ok:unknown)=>{if(!ok)throw Error('Conformance assertion failed');};
 const sdk={plugins:{callRpc:async(a:{pluginId:string;method:string;input:unknown})=>{require(a.pluginId===options.pluginId);return host.harness.behavior.callRpc(a.method,a.input);}}} as unknown as Parameters<typeof createThreadContextClient>[0];const client=createThreadContextClient(sdk,options.pluginId);
 await check('registration',()=>options.register(host.bb));await check('negotiation',async()=>require((await client.describe())?.version===1));
 await check('strict-input',async()=>{for(const v of [{threadId:'t',path:'/arbitrary'},{threadId:''}]){let failed=false;try{await host.harness.behavior.callRpc(METHODS.read,v);}catch{failed=true;}require(failed);}});
 for(const c of options.cases)await check(`read:${c.threadId}`,async()=>{const v=await client.read({threadId:c.threadId});require(v.threadId===c.threadId&&v.state===c.expect);c.check?.(v);});
 if(!options.cases.length)checks.push({name:'supplier-owned-witnesses',passed:false});
 return {pluginId:options.pluginId,proof:'source-conformance' as const,passed:checks.every(c=>c.passed),checks};
}
