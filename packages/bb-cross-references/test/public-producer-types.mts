/** Explicitly compile this consumer; .mts is not ordinary node:test discovery. */
import {type ProducerApplyInput,type ProducerReportStatusInput,type ProducerState,type BriefNavigationInput,classifyBriefDisplayTextV1,crossReferencesProducerRpcSchemas,PRODUCER_METHODS} from '@phosphorco/bb-cross-references';
import {createCrossReferencesProducerClient,registerCrossReferencesProducer,registerBriefNavigation,type CrossReferencesSdk} from '@phosphorco/bb-cross-references/bb';
import {runCrossReferencesProducerConformance,runBriefNavigationConformance} from '@phosphorco/bb-cross-references/testing';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
declare const sdk:CrossReferencesSdk,api:Pick<BbPluginApi,'rpc'>,apply:ProducerApplyInput,status:ProducerReportStatusInput,state:ProducerState,nav:BriefNavigationInput;
const client=createCrossReferencesProducerClient(sdk);void client.apply(apply);void client.reportStatus(status);void classifyBriefDisplayTextV1('Goal');
registerCrossReferencesProducer(api,{'crossReferencesProducer.describe':()=>({protocol:'cross-references-producer',versions:[1],sourceKinds:['thread-brief'],limits:{inputBytes:1048576,statusBytes:16384,locations:512,perTarget:100,headingBytes:256,limitCodes:[]}}),crossReferencesProducerV1GetState:()=>state,crossReferencesProducerV1Apply:input=>({version:1,outcome:'applied',currentRevision:input.projection.revision,currentDigest:input.projection.payloadDigest,evidenceDisposition:'installed',state}),crossReferencesProducerV1ReportStatus:()=>({version:1,outcome:'recorded',state})});
registerBriefNavigation(api,{'threadBriefNavigation.describe':()=>({protocol:'thread-brief-navigation',versions:[1]}),threadBriefNavigationV1ResolveHeading:input=>({version:1,state:'fallback',sourceFile:input.sourceFile,location:null,reason:'stale'})});
void runCrossReferencesProducerConformance({sdk,command:apply,blocked:status});void runBriefNavigationConformance({sdk,input:nav,assertResult:()=>{}});
const parsed:ProducerApplyInput=crossReferencesProducerRpcSchemas[PRODUCER_METHODS.apply].input.parse(apply);void parsed;
// @ts-expect-error a string heading is neither intro nor an explicit B variant
const badHeading:BriefNavigationInput={...nav,section:{heading:'Goal',originalLine:1}};
// @ts-expect-error the producer family cannot be invoked with the legacy command alone
void client.apply(apply.projection);
// @ts-expect-error arbitrary raw status/error text is not a permitted status variant
const badStatus:ProducerReportStatusInput={...status,status:{state:'over-limit',error:'raw'}};
void badHeading;void badStatus;

import {BRIEF_READER_ROUTE,encodeBriefReaderPath,decodeBriefReaderPath,type BriefReaderDestination} from '@phosphorco/bb-cross-references';
const reader:BriefReaderDestination={...BRIEF_READER_ROUTE,threadId:'thr_23456789ab',token:'00000000-0000-4000-8000-000000000001'};
const readerPath:string=encodeBriefReaderPath(reader);const decodedReader:BriefReaderDestination|null=decodeBriefReaderPath(readerPath);void decodedReader;
// @ts-expect-error arbitrary URL destinations are not rendered Brief destinations
const badReader:BriefReaderDestination={kind:'url',href:'https://outside.test'};
void badReader;
