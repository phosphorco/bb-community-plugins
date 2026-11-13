import type { AcceptedOriginalV1, PreviewPlacementInputV1, PreviewPlacementResultV1, RequestedIntent, SubmissionV1 } from "@phosphorco/bb-message-admission/protocol";
export const message="Choose the next step.";
const execution={provider:"test-provider",model:"test-model",reasoning:"medium",serviceTier:"default",permissionMode:"default",canAsk:false,configuration:{}};
const source=(sender:string)=>({senderThreadId:sender,initiator:"agent" as const,author:{sender},editor:null,origin:null,externalOperation:null,visibleHumanActivity:false});
const intent=():RequestedIntent=>({mode:"queue",membership:"preserve",schedule:{kind:"ordinary"},execution:structuredClone(execution)});
function original(id:string,sender:string):AcceptedOriginalV1 {
  const requestedIntent=intent();
  return {version:1,original:{originalId:id,revision:1},operation:{namespace:"fixture",operationId:id},requestFingerprint:"sha256:"+"a".repeat(64),threadId:"receiver",rawInput:{text:id},source:source(sender),requestedIntent,effectiveIntent:{...structuredClone(requestedIntent),changes:[]},acceptedAt:"2026-11-12T00:00:00Z",acceptanceSequence:id==="A"?1:2,admission:{kind:"evaluated",publications:[],assessments:[]}};
}
export function baseInput(id="q-a-s-b"):PreviewPlacementInputV1 {
  const scheduled=original("S","sender-s");
  const schedule={kind:"scheduled" as const,notBefore:"2026-12-01T00:00:00Z"};
  scheduled.requestedIntent.schedule=structuredClone(schedule);scheduled.effectiveIntent.schedule=structuredClone(schedule);
  const candidate:SubmissionV1={version:1,operation:{namespace:"fixture",operationId:id},requestFingerprint:"sha256:"+"b".repeat(64),original:{originalId:"B",revision:1},threadId:"receiver",projectId:"project-test",rawInput:{text:message},policyContext:{messageText:message,projectTitle:"Test project",senderTitle:"Sender B",destinationTitle:"Receiver"},requestedIntent:{...intent(),mode:"proceed"},source:source("sender-b"),kind:"message",override:"none",expectedPlacementWitness:null};
  return {version:1,simulation:true,now:"2026-11-12T00:00:00Z",candidate,queue:[{groupId:"ordinary-a",originals:[original("A","sender-a")],joinState:"open",claimed:false,blocked:false,orderKey:"1",witness:"target-a"},{groupId:"scheduled-s",originals:[scheduled],joinState:"open",claimed:false,blocked:false,orderKey:"2",witness:"target-s"}]};
}
function result(status:PreviewPlacementResultV1["status"],reason?:string):PreviewPlacementResultV1 {
  return {version:1,simulation:true,status,targetGroupId:status==="join"?"ordinary-a":null,orderedOriginalIds:status==="join"?["A","B"]:status==="conflict"?[]:["B"],reasons:reason?[{code:reason,message:"Injected test boundary: "+reason}]:[]};
}
// Explicit scenario inputs and scripted boundary responses, not a selector.
// Root separately runs these inputs against the actual native pure selector.
export function placementCases(){
  const join=baseInput(),closed=baseInput("closed-target");closed.queue[0]!.joinState="frozen";closed.queue[0]!.claimed=true;
  const promised=structuredClone(closed);promised.candidate.operation.operationId="promised-closed";promised.candidate.expectedPlacementWitness="target-a";
  const divider=baseInput("explicit-divider");divider.queue[0]!.joinState="divider";
  const incompatible=baseInput("incompatible-choices");incompatible.candidate.requestedIntent.execution.model="another-model";
  const legacy=baseInput("legacy-timing");legacy.candidate.requestedIntent.schedule={kind:"legacy-unknown"};
  const legacyTarget=baseInput("legacy-target");legacyTarget.queue[0]!.originals[0]!.effectiveIntent.schedule={kind:"legacy-unknown"};
  return [{input:join,result:result("join")},{input:closed,result:result("singleton","closed-target")},{input:promised,result:result("conflict","target-changed")},{input:divider,result:result("conflict","divider")},{input:incompatible,result:result("conflict","incompatible")},{input:legacy,result:result("conflict","legacy-intent-unknown")},{input:legacyTarget,result:result("singleton","closed-target")}];
}
export function fixtureSource(input:PreviewPlacementInputV1,result:PreviewPlacementResultV1){
  const expect={status:result.status,targetGroupId:result.targetGroupId,orderedOriginalIds:result.orderedOriginalIds,reasonCodes:result.reasons.map(reason=>reason.code)};
  return `---\nversion: 1\nid: ${input.candidate.operation.operationId}\nproject_id: project-test\nproject_title: Test project\nsender_id: sender-b\ndestination_id: receiver\nsender_title: Sender B\ndestination_title: Receiver\nexpect: allow\nexpected_rules: []\nexpected_route: queue-batched\n---\n# Message\n${message}\n\n# Native placement\n\`\`\`json\n${JSON.stringify({input,expect},null,2)}\n\`\`\`\n`;
}
