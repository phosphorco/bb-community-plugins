// Explicit emitted declaration consumer. Compile separately; ordinary src-only
// typecheck and Bun test discovery are not evidence that this file compiled.
import {type MentionQueryV2,type ListMentionsOutputV2,type ResolveLookupOutputV2,listMentionsInputV2Schema} from '@phosphorco/bb-cross-references';
import {createCrossReferencesV2Client,crossReferencesV2RpcContract,type CrossReferencesSdk} from '@phosphorco/bb-cross-references/bb';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {runCrossReferencesV2Conformance} from '@phosphorco/bb-cross-references/testing';
const query:MentionQueryV2={kind:'authored-url',href:'https://example.test/a'};
const command=listMentionsInputV2Schema.parse({version:2,query,pageSize:25});
function use(sdk:CrossReferencesSdk){const client=createCrossReferencesV2Client(sdk);const read:Promise<ListMentionsOutputV2>=client.listMentions(command);return {read,check:()=>runCrossReferencesV2Conformance({sdk,input:command,lookup:{version:2,mode:'exact-url',text:'https://example.test/a'},assertPage(page){page.coverage.authoredUrlCoverage.watermark satisfies string;}})};}
void use;
// @ts-expect-error containment is explicitly deferred
const unsupported:MentionQueryV2={kind:'resource',target:{provider:'test',keys:{id:'x'}},relation:'contains'};
void unsupported;

type IsAny<T>=0 extends (1&T)?true:false;
const publicOutputIsNotAny:false=null as unknown as IsAny<ListMentionsOutputV2>;
void publicOutputIsNotAny;

// Compile the exported registration contract against the public SDK, rather
// than allowing an adapter annotation to hide lost handler-input inference.
function registerTyped(bb:Pick<BbPluginApi,'rpc'>){
 bb.rpc.register(crossReferencesV2RpcContract,{
  crossReferencesV2ListMentions(input){
   input.query satisfies MentionQueryV2;
   const inputIsNotAny:false=null as unknown as IsAny<typeof input>;
   void inputIsNotAny;
   // @ts-expect-error handler input comes from the strict V2 schema
   input.nonexistent;
   return {version:2,status:'unavailable',reason:'read-budget',retryable:true} satisfies ListMentionsOutputV2;
  },
  crossReferencesV2ResolveLookup(input){
   input.mode satisfies 'recognize'|'exact-url';
   return {version:2,state:'unrecognized',options:[],reasons:[]} satisfies ResolveLookupOutputV2;
  },
 });
}
void registerTyped;
