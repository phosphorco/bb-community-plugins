import {
  reduceObservations,
  type EvaluatorV1,
  type EvidenceV1,
  type EvidenceRequestV1,
  type RuleObservationV1,
} from "@phosphorco/bb-message-admission/protocol";
import { match, usesJev, actionOf, type Capture, type History, type Rule } from "../contracts/model.ts";
import { canonical } from "../contracts/hash.ts";
import { readPolicyBytes } from "./snapshot.ts";
import type { createAdmissionEvaluator } from "./evaluator.ts";
const unavailable = (): History => ({events:[],coverage:"unavailable",through:null});
function history(evidence: EvidenceV1,side: "sender" | "destination",limit: number): History {
  if (!limit) return {events:[],coverage:"empty-confirmed",through:null};
  const windows=evidence.windows.filter(w=>w.side===side && w.selection==="latest");
  if (windows.length!==1) return unavailable();
  const window=windows[0]!;
  return {
    events:window.events.map(event=>({id:event.id,text:event.text,sequence:event.sequence})),
    coverage:window.coverage==="unavailable"?"unavailable":window.coverage==="partial"?"truncated":window.events.length?"complete":"empty-confirmed",
    through:window.events.at(-1)?.sequence ?? null,
  };
}
export function nativeEvaluator(evaluate: ReturnType<typeof createAdmissionEvaluator>, providerId="message-rules"): EvaluatorV1 {
  return async (input,context) => {
    try {
      const feedback=input.submission.feedbackBinding;
      // Only native can construct this correlation from its stored obligation.
      // Exempt this exact MR feedback original for MR alone; other evaluators
      // and ordinary neighboring originals still run under native admission.
      if (feedback?.providerId===providerId && feedback.recipientThreadId===input.submission.threadId)
        return reduceObservations({assessmentId:input.assessmentId,observations:[],complete:true});
      const snapshot=readPolicyBytes(input.publication.snapshotBytes),submission=input.submission;
      if (input.publication.evaluatorVersion!==snapshot.evaluatorVersion)
        throw Error("Publication evaluator version does not match its immutable policy bytes.");
      const candidate: Capture = {
        message:submission.policyContext.messageText,projectId:submission.projectId,
        projectTitle:submission.policyContext.projectTitle,senderTitle:submission.policyContext.senderTitle,
        destinationTitle:submission.policyContext.destinationTitle,
        provenance:{senderId:submission.source.senderThreadId,destinationId:submission.threadId},
        sender:unavailable(),destination:unavailable(),
      };
      const tokens: string[]=[];
      const result=await evaluate({
        assessmentId:input.assessmentId,policyBytes:input.publication.snapshotBytes,candidate,
        binding:{submission,publication:input.publication.publication},
        nativeDeadlineAt:input.deadlineAt,signal:context.signal,evidenceTokens:()=>tokens,
        captureEvidence:async (rules: Rule[]) => {
          // Group scope was already gated. Eliminate cheap nonmatches before
          // asking native for the bounded evidence used by matching JEV checks.
          const criteria=rules.filter(r=>usesJev(r)&&match(r.match,candidate)===true).flatMap(r=>r.criteria);
          const sender=Math.max(0,...criteria.map(q=>q.context.senderHistory));
          const destination=Math.max(0,...criteria.map(q=>q.context.destinationHistory));
          const windows: EvidenceRequestV1["windows"]=[
            ...(sender?[{side:"sender" as const,selection:"latest" as const,limit:sender}]:[]),
            ...(destination?[{side:"destination" as const,selection:"latest" as const,limit:destination}]:[]),
          ];
          // Empty windows still capture a native validation token for selected
          // routing titles/content when applicable rules require no history.
          const evidence=await context.captureEvidence({version:1,windows,prefixMode:"native-candidate"});
          if (evidence.assessmentId!==input.assessmentId ||
            canonical(evidence.original)!==canonical(submission.original) ||
            canonical(evidence.operation)!==canonical(submission.operation) ||
            evidence.metadata.threadId!==submission.threadId ||
            evidence.metadata.senderThreadId!==submission.source.senderThreadId ||
            evidence.metadata.projectId!==submission.projectId ||
            canonical(evidence.metadata.policyContext)!==canonical(submission.policyContext))
            throw Error("Native evidence does not match this exact submission and routing snapshot.");
          if (evidence.windows.some(w=>w.threadId!==(w.side==="sender"?submission.source.senderThreadId:submission.threadId)))
            throw Error("Native history window belongs to a different original thread.");
          tokens.push(evidence.token);
          return {...candidate,sender:history(evidence,"sender",sender),destination:history(evidence,"destination",destination)};
        },
      });
      const observations: RuleObservationV1[]=result.rules.map(row=>{
        const rule=snapshot.rules.find(r=>r.id===row.id)!;
        const applicable=row.applies===true,action=actionOf(rule);
        const knownReject=row.status==="reject" || (applicable&&action==="reject");
        return {
          groupId:rule.groupId,ruleId:row.id,revision:String(row.revision),
          status:row.status==="reject"?"reject":row.status==="unknown"?"unresolved":row.status==="not-applicable"||!applicable?"not-applicable":"pass",
          causes:knownReject?[{code:"rule-rejected",message:row.title}]:[],
          advice:result.advice.filter(a=>a.ruleIds.includes(row.id)).map(a=>a.text),
          routing:applicable&&action==="steer"?"steer-if-active":applicable&&(action==="queue"||action==="queue-batched")?"defer":"preserve",
          membership:applicable&&action==="queue"?"separate":applicable&&action==="queue-batched"?"join-next-ordinary":"preserve",
        };
      });
      // A new callback context cannot attest a token captured by a previous
      // invocation, even when the durable assessment forbids another paid call.
      // Native must reconcile its recorded assessment. Keep known diagnosis,
      // but never promote cached evidence into a fresh final disposition.
      const priorEvidence=(result.evidenceTokens??[]).some(token=>!tokens.includes(token));
      return reduceObservations({assessmentId:input.assessmentId,observations,
        complete:result.policy!=="unknown"&&!priorEvidence,
        unresolved:[...result.errors.map(message=>({code:"message-rules-unresolved",message})),
          ...(priorEvidence?[{code:"prior-assessment-evidence",message:"Recorded assessment evidence belongs to its original callback. Reconcile the native assessment; no paid work was replayed."}]:[])],
        evidenceTokens:(result.evidenceTokens??[]).filter(token=>tokens.includes(token))});
    } catch (error) {
      return reduceObservations({assessmentId:input.assessmentId,observations:[],complete:false,
        unresolved:[{code:"message-rules-evaluation-failed",message:error instanceof Error?error.message:String(error)}]});
    }
  };
}
