import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { SourceIdentity } from '@phosphorco/bb-context-recognition';

/** Same canonical relative-path admission as the existing native consumer.
 * The shared recognizer supplies candidates; this is filesystem containment. */
export function containedMentionPath(path:string):boolean {
  return path.length>0 && path.length<=4096 && !path.startsWith('/') &&
    !/[\\:%?#\u0000-\u001f\u007f]/u.test(path) &&
    path.split('/').every(part=>part.length>0 && part!=='.' && part!=='..');
}
export function mentionFileFrame(source:SourceIdentity,sourceThreadId:string):{path:string;frame?:'workspace'|'thread-storage'}|undefined {
  if(source.provider!=='bb.file')return;
  const colon=source.id.indexOf(':');
  if(colon<=0 || source.id.slice(0,colon)!==sourceThreadId)return;
  let path=source.id.slice(colon+1),frame:'workspace'|'thread-storage'|undefined;
  for(const candidate of ['workspace','thread-storage'] as const)if(path.startsWith(candidate+':')){frame=candidate;path=path.slice(candidate.length+1);break;}
  return containedMentionPath(path)?{path,...(frame?{frame}:{})}:undefined;
}
// Plugin-private diagnostics. Never retain an Error, candidate, path or SDK object.
const diagnosticStages = ['source-prefetch','timeline-prefetch','project-context','thread-target','file-admission','source-owner','thread-storage','environment','host-admission','host-transport','host-root-realpath','host-root-stat','host-target-realpath','host-open','host-file-stat','host-opened-realpath','host-revalidate','host-current-stat','host-close','native-wait','collection'] as const;
const diagnosticReasons = ['sdk-failure','transport-failure','outer-timeout','native-timeout','source-deadline','cancelled','frame-changed','host-root-mismatch','retryable-host-response','host-permission','host-io','host-unknown','verifier-unavailable','source-identity-mismatch','timeline-cursor-stalled','unknown'] as const;
const diagnosticFrames = ['unknown','thread-storage','workspace'] as const;
export const mentionDiagnosticSchema = z.strictObject({
  stage:z.enum(diagnosticStages),reason:z.enum(diagnosticReasons),frame:z.enum(diagnosticFrames),
  elapsedMs:z.number().int().min(0).max(60_000).optional(),remainingMs:z.number().int().min(0).max(60_000).optional(),capped:z.boolean().optional(),
});
export type MentionDiagnostic = z.infer<typeof mentionDiagnosticSchema>;
export type MentionDiagnosticStage = MentionDiagnostic['stage'];
export type MentionDiagnosticReason = MentionDiagnostic['reason'];
type Frame = MentionDiagnostic['frame'];
const unknownDiagnostic:MentionDiagnostic={stage:'host-transport',reason:'host-unknown',frame:'unknown'};
export function safeMentionDiagnostic(value:unknown):MentionDiagnostic {
  try {const result=mentionDiagnosticSchema.safeParse(value);return result.success?result.data:{...unknownDiagnostic};}catch{return {...unknownDiagnostic};}
}
// Host fact detail cannot impersonate a server SDK/deadline stage.
const hostDiagnosticSchema=mentionDiagnosticSchema.refine(event=>
  ['host-root-realpath','host-root-stat','host-target-realpath','host-open','host-file-stat','host-opened-realpath','host-revalidate','host-current-stat'].includes(event.stage) &&
  ['host-permission','host-io','host-unknown'].includes(event.reason) && event.frame==='unknown' && event.remainingMs===undefined);
export function safeHostMentionDiagnostic(value:unknown):MentionDiagnostic {
  try{const result=hostDiagnosticSchema.safeParse(value);return result.success?result.data:{...unknownDiagnostic};}catch{return {...unknownDiagnostic};}
}
export function diagnosticNow():number {try{return performance.now();}catch{return NaN;}}
function time(value:number):number|undefined {return Number.isFinite(value)?Math.min(60_000,Math.max(0,Math.floor(value))):undefined;}
type Group = Pick<MentionDiagnostic,'stage'|'reason'|'frame'> & {count:number;elapsedMsMin?:number;elapsedMsMax?:number;remainingMsMin?:number;remainingMsMax?:number};
/** Source-local, bounded and nonthrowing, including the optional diagnostic port.
 * Only the collector logs, at its existing fenced warning sites. */
export class MentionDiagnostics {
  private groups:Group[]=[];
  private omittedCount=0;
  private capped=false;
  private closed=false;
  private readonly active:()=>boolean;
  private readonly sink?: (event:MentionDiagnostic)=>void;
  constructor(active:()=>boolean=()=>true,sink?:(event:MentionDiagnostic)=>void){this.active=active;this.sink=sink;}
  record(input:unknown):void {try{
    if(this.closed || !this.active())return;
    const event=safeMentionDiagnostic(input);
    this.capped ||= !!event.capped;
    let group=this.groups.find(g=>g.stage===event.stage && g.reason===event.reason && g.frame===event.frame);
    if(!group){if(this.groups.length>=16){this.omit(1);return;}group={stage:event.stage,reason:event.reason,frame:event.frame,count:0};this.groups.push(group);}
    if(group.count>=1_000_000)this.capped=true;else group.count++;
    for(const key of ['elapsedMs','remainingMs'] as const){const value=event[key];if(value!==undefined){
      const low=`${key}Min` as const,high=`${key}Max` as const;
      group[low]=Math.min(group[low]??value,value);group[high]=Math.max(group[high]??value,value);
    }}
    try{this.sink?.({...event});}catch{/* Observability cannot fail collection. */}
  }catch{/* Never change product admission or thrown errors. */}}
  private omit(count:number):void {this.capped=true;this.omittedCount=Math.min(1_000_000,this.omittedCount+count);}
  operation(stage:MentionDiagnosticStage,frame:Frame='unknown',remaining?:()=>number):MentionDiagnosticOperation {return new MentionDiagnosticOperation(this,stage,frame,remaining);}
  fallback(boundary?:MentionDiagnosticOperation):void {if(!boundary?.reported())this.record({stage:'collection',reason:'unknown',frame:'unknown'});}
  close():void {this.closed=true;}
  encode():string {try{
    // Enums and integer fields are ASCII; string length equals UTF-8 bytes.
    const groups=this.groups.map(g=>({...g}));let omittedCount=this.omittedCount,capped=this.capped;
    let encoded=JSON.stringify({version:1,groups,omittedCount,capped});
    while(encoded.length>4096 && groups.length){const dropped=groups.pop()!;omittedCount=Math.min(1_000_000,omittedCount+dropped.count);capped=true;encoded=JSON.stringify({version:1,groups,omittedCount,capped});}
    return encoded;
  }catch{return '{"version":1,"groups":[],"omittedCount":0,"capped":true}';}}
}
export class MentionDiagnosticOperation {
  private started=diagnosticNow();
  private settled=false;
  private failureReported=false;
  private readonly owner:MentionDiagnostics;
  private stage:MentionDiagnosticStage;
  private frame:Frame;
  private readonly remaining?:()=>number;
  constructor(owner:MentionDiagnostics,stage:MentionDiagnosticStage,frame:Frame,remaining?:()=>number){this.owner=owner;this.stage=stage;this.frame=frame;this.remaining=remaining;}
  enter(stage:MentionDiagnosticStage,frame:Frame=this.frame):void {if(!this.settled){this.stage=stage;this.frame=frame;this.started=diagnosticNow();}}
  fail(reason:MentionDiagnosticReason,remaining?:number):void {try{
    if(this.settled)return;
    remaining??=this.remaining?.();
    const elapsed=diagnosticNow()-this.started;
    this.report({stage:this.stage,reason,frame:this.frame,elapsedMs:time(elapsed),remainingMs:remaining===undefined?undefined:time(remaining),
      ...((Number.isFinite(elapsed)&&(elapsed<0||elapsed>60_000))||(remaining!==undefined&&Number.isFinite(remaining)&&(remaining<0||remaining>60_000))?{capped:true}:{})});
  }catch{/* Nonthrowing diagnostics. */}}
  report(event:unknown):void {if(this.settled)return;this.settled=true;this.failureReported=true;
    try{const safe=safeMentionDiagnostic(event),remaining=this.remaining?.();this.owner.record({...safe,...(safe.remainingMs===undefined && remaining!==undefined?{remainingMs:time(remaining)}:{})});}catch{/* A diagnostic port cannot change collection. */}}
  reported():boolean {return this.failureReported;}
  close():void {this.settled=true;}
}

const path=z.string().min(1).max(4096);
export const mentionFileHostContract=defineRpcContract({
  mentionFileExists:{input:z.strictObject({rootPath:path,path}),output:z.strictObject({exists:z.boolean(),retryable:z.boolean().optional(),diagnostic:hostDiagnosticSchema.catch({stage:'host-transport',reason:'host-unknown',frame:'unknown'}).optional()})},
});

