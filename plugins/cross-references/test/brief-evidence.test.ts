import assert from 'node:assert/strict';
import test from 'node:test';
import {
 briefEvidenceDigest,briefOccurrenceKey,briefPresentation,briefStatusDigest,canonicalizeResource,projectionPayloadDigest,sha256Hex,verifiedFileIdentity,
 type BriefEvidenceV1,type BriefHeadingV1,type ProducerApplyInput,type ProducerReportStatusInput,
} from '@phosphorco/bb-cross-references';
import {admitBriefApply} from '../brief-evidence.ts';
/** Only fixture construction. All admission, mutation and read logic is product code. */
export function briefFixture(revision=8,expectedRevision=0,options:{threadId?:string;heading?:BriefHeadingV1;count?:number;href?:string}={}):ProducerApplyInput {
 const threadId=options.threadId??'thr_brief_fixture',href=options.href??'https://example.test/brief-target',sourceFile={kind:'thread-storage' as const,threadId,path:'BRIEF.md' as const},raw=sha256Hex('# Goal\nSee reference.\n'),heading=options.heading===undefined?{state:'named' as const,text:'Goal'}:options.heading;
 const target={provider:'url',keys:{href}},presentation={label:{state:'safe' as const,text:'Reference'},detail:null,url:{state:'exact' as const,href}};
 const evidence:BriefEvidenceV1={kind:'thread-brief',sourceFile,sourceState:'present',sourceContentRevision:raw,completeness:{state:'complete',codecVersion:1},metadataPolicyVersion:1,
  frame:{codec:'utf8-fatal-bom-consumed-v1',rawBytes:22,bomBytes:0,fileUtf16Length:22,bodyBase:{startUtf16:0,startLine:1,utf16Length:22},lineMapping:{codec:'native-file-lines-v1',fileLineCount:3}},
  sourcePresentation:{label:{state:'safe',text:'Brief'},detail:null,url:{state:'absent'}},targetDescriptors:[{target,presentation,codec:{state:'available',value:{kind:'url',href}}}],occurrences:[]};
 for(let i=0;i<(options.count??1);i++){const locator={kind:'thread-brief' as const,threadId,file:sourceFile,sourceContentRevision:raw,section:{heading,line:1},location:{kind:'line' as const,line:2,column:1,endLine:null},span:{frame:'file-utf16' as const,start:7,end:20}},id=`ref-${i}`;
  evidence.occurrences.push({occurrenceKey:briefOccurrenceKey(raw,target,locator,id),sourceOccurrenceId:id,target,locator,authoredUrl:{state:'exact',href},provenance:{state:'safe',value:{pluginId:'thread-brief',origin:'builtin',confidence:'high',source:{provider:'bb.url',id:href},recognition:{basis:'text-url',explanation:'An explicit reference'}}}});
 }
 const source={...verifiedFileIdentity(sourceFile),presentation:briefPresentation(evidence.sourcePresentation)},targets=evidence.targetDescriptors.map(d=>({...d.target,presentation:briefPresentation(d.presentation)}));
 return {version:1,projection:{protocolVersion:1,producerPluginId:'thread-brief',mutationId:`00000000-0000-4000-8000-${revision.toString(16).padStart(12,'0')}`,source,revision,expectedRevision,tombstone:false,targets,payloadDigest:projectionPayloadDigest('thread-brief',canonicalizeResource(source),false,targets.map(canonicalizeResource))},evidence,evidenceDigest:briefEvidenceDigest(evidence)};
}
export function refreshBrief(input:ProducerApplyInput):ProducerApplyInput {
 const e=input.evidence;input.projection.source={...verifiedFileIdentity(e.sourceFile),presentation:briefPresentation(e.sourcePresentation)};input.projection.targets=e.targetDescriptors.map(d=>({...d.target,presentation:briefPresentation(d.presentation)}));
 for(const o of e.occurrences)o.occurrenceKey=briefOccurrenceKey(e.sourceContentRevision!,o.target,o.locator,o.sourceOccurrenceId);
 input.evidenceDigest=briefEvidenceDigest(e);input.projection.payloadDigest=projectionPayloadDigest('thread-brief',canonicalizeResource(input.projection.source),input.projection.tombstone,input.projection.targets.map(canonicalizeResource));return input;
}
/** Literal decoded-file EMPTY, including the uniquely possible BOM-only raw bytes. */
export function briefEmptyFixture(revision=9,expectedRevision=8,bom=false):ProducerApplyInput {
 const input=briefFixture(revision,expectedRevision),e=input.evidence;e.sourceState='empty';e.sourceContentRevision=sha256Hex(bom?'\uFEFF':'');
 e.frame={codec:'utf8-fatal-bom-consumed-v1',rawBytes:bom?3:0,bomBytes:bom?3:0,fileUtf16Length:0,bodyBase:{startUtf16:0,startLine:1,utf16Length:0},lineMapping:{codec:'native-file-lines-v1',fileLineCount:1}};
 e.occurrences=[];e.targetDescriptors=[];input.projection.tombstone=true;return refreshBrief(input);
}
export function briefStatus(command:ProducerApplyInput,attemptRevision=10,expectedRevision=command.projection.revision):ProducerReportStatusInput {
 const source=verifiedFileIdentity(command.evidence.sourceFile),status={state:'over-limit' as const,sourceContentRevision:sha256Hex('new oversized source'),limits:['per-target-occurrences' as const]};
 return {version:1,producerPluginId:'thread-brief',source,sourceFile:command.evidence.sourceFile,attemptRevision,expectedRevision,status,statusDigest:briefStatusDigest('thread-brief',source,command.evidence.sourceFile,status)};
}
test('actual Brief admission pins whole snapshot, exact heading/intro and per-edge bounds',()=>{
 const valid=briefFixture();assert.equal(admitBriefApply(valid).evidenceDigest,valid.evidenceDigest);assert.equal(admitBriefApply(briefFixture(8,0,{heading:null})).evidence.occurrences[0]!.locator.section.heading,null);
 const duplicate=briefFixture();duplicate.evidence.occurrences.push(duplicate.evidence.occurrences[0]!);assert.throws(()=>admitBriefApply(duplicate));
 assert.throws(()=>admitBriefApply(briefFixture(8,0,{count:101})),e=>e instanceof Error&&'limits' in e&&Array.isArray(e.limits)&&e.limits.includes('per-target-occurrences'));
 const wrong=briefFixture();wrong.evidence.occurrences[0]!.locator.file.threadId='thr_wrong';assert.throws(()=>admitBriefApply(wrong));
});

test('actual admission reports safe presentation byte bounds precisely rather than withholding or mislabelling identity',()=>{
 const long=briefFixture();const descriptor=long.evidence.targetDescriptors[0]!;
 // A generic recognition target isolates presentation limits from URL identity512.
 descriptor.target={provider:'recognition',keys:{provider:'fixture',identity:sha256Hex('target')}};descriptor.codec={state:'withheld',digest:sha256Hex('codec'),display:'Identity metadata withheld',cause:'unclassified'};long.evidence.occurrences[0]!.target=descriptor.target;
 descriptor.presentation.url={state:'exact',href:'/'+'a'.repeat(2047)};refreshBrief(long);assert.doesNotThrow(()=>admitBriefApply(long));
 descriptor.presentation.url={state:'exact',href:'/'+'a'.repeat(2049)};long.projection.targets[0]!.presentation.url=descriptor.presentation.url.href;assert.throws(()=>admitBriefApply(long),e=>e instanceof Error&&'limits' in e&&Array.isArray(e.limits)&&e.limits.includes('presentation-url-bytes'));
 descriptor.presentation.url={state:'absent'};delete long.projection.targets[0]!.presentation.url;descriptor.presentation.label={state:'safe',text:' '};long.projection.targets[0]!.presentation.label=' ';assert.throws(()=>admitBriefApply(long),e=>e instanceof Error&&'code' in e&&e.code==='invalid');
});

test('actual SAFE ingress recomputation rejects partial and inherited entity names; preserves ordinary exact metadata',()=>{
 for(const text of ['&colon','&col','&amp','&constructor;','&__proto__;','&toString;','&hasOwnProperty;','https&colon//example.test/?token=secret']){
  const input=briefFixture(8,0,{heading:{state:'named',text}});assert.throws(()=>admitBriefApply(input),text);
 }
 for(const text of ['Research & Development','100% done','Goal &amp; plan']){const input=briefFixture(8,0,{heading:{state:'named',text}});const accepted=admitBriefApply(input);assert.deepEqual(accepted.evidence.occurrences[0]!.locator.section.heading,{state:'named',text});}
 const input=briefFixture();const present={...input,projection:{...input.projection,source:{...input.projection.source,presentation:{...input.projection.source.presentation,detail:undefined}}}};
 const parsed=crossReferencesProducerRpcSchemas[PRODUCER_METHODS.apply].input.parse(present);assert.equal(Object.hasOwn(parsed.projection.source.presentation,'detail'),false);assert.equal(parsed.projection.source.presentation.label,'Brief');
 assert.throws(()=>crossReferencesProducerRpcSchemas[PRODUCER_METHODS.apply].input.parse({...present,projection:{...present.projection,source:{...present.projection.source,presentation:{label:'Brief',unrecognized:'must reject before adapter'}}}}));
});
import {crossReferencesProducerRpcSchemas,PRODUCER_METHODS} from '@phosphorco/bb-cross-references';


test('literal EMPTY admission requires coherent empty/BOM-only raw and decoded frame; present no-reference is distinct',()=>{
 for(const bom of [false,true])assert.equal(admitBriefApply(briefEmptyFixture(9,8,bom)).evidence.sourceState,'empty');
 const changes:((e:BriefEvidenceV1)=>void)[]=[e=>{e.frame!.rawBytes=10;e.frame!.fileUtf16Length=10;e.frame!.bodyBase.utf16Length=10;},e=>{e.frame!.rawBytes=1;},e=>{e.frame!.fileUtf16Length=1;},e=>{e.frame!.fileUtf16Length=1;e.frame!.bodyBase.startUtf16=1;},e=>{e.frame!.fileUtf16Length=1;e.frame!.bodyBase.utf16Length=1;},e=>{e.frame!.lineMapping.fileLineCount=2;e.frame!.bodyBase.startLine=2;},e=>{e.frame!.lineMapping.fileLineCount=2;},e=>{e.sourceContentRevision=sha256Hex(' ');},e=>{e.frame!.bomBytes=3;e.frame!.rawBytes=3;}];
 for(const change of changes){const input=briefEmptyFixture();change(input.evidence);refreshBrief(input);assert.throws(()=>admitBriefApply(input));}
 const present=briefFixture();present.evidence.occurrences=[];present.evidence.targetDescriptors=[];refreshBrief(present);assert.equal(admitBriefApply(present).command.tombstone,false);
});
