import { fingerprint } from "../contracts/hash.ts";
import { VERSION, type Capture, type Evaluation, type Rule } from "../contracts/model.ts";
import { evaluateScoped } from "../evaluation/scoped.ts";
import type { TokenCounter, Transport } from "../evaluation/evaluator.ts";
import { TransportError } from "../evaluation/transport.ts";
import type { AdmissionLedger } from "./ledger.ts";
import { readPolicyBytes, type AdmissionSnapshot } from "./snapshot.ts";
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve,reject) => {
    const abort = () => { cleanup(); reject(Error("Admission cancelled or deadline expired; effect may remain unknown.")); };
    const cleanup = () => signal.removeEventListener("abort",abort);
    signal.addEventListener("abort",abort,{once:true});
    work.then(value => { cleanup(); resolve(value); },error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
export type FrozenAdmission = {
  assessmentId: string;
  policyBytes: string;
  binding?: unknown;
  nativeDeadlineAt?: string;
  evidenceTokens?: () => string[];
  // Cheap native routing/content facts, never a mutable catalogue lookup.
  candidate: Capture;
  signal: AbortSignal;
  captureEvidence(rules: Rule[]): Promise<Capture>;
};
export function createAdmissionEvaluator(
  ledger: AdmissionLedger,
  transportFor: (snapshot: AdmissionSnapshot) => Transport,
  countTokens?: TokenCounter,
) {
  const active = new Map<string, { basis: string; promise: Promise<Evaluation> }>();
  const unknown = (basis: string, reason: string): Evaluation => ({
    version: VERSION,inputHash:basis,policy:"unknown",rules:[],advice:[],errors:[reason],
  });
  return (input: FrozenAdmission): Promise<Evaluation> => {
    const frozen = { policyBytes: input.policyBytes, candidate: input.candidate, binding: input.binding ?? null };
    const basis = fingerprint(frozen), pending = active.get(input.assessmentId);
    if (pending) {
      if (pending.basis !== basis) return Promise.resolve(unknown(basis,"Native assessment identity changed while evaluation is active."));
      return pending.promise;
    }
    const prior = ledger.begin(input.assessmentId,frozen);
    if (!prior.fresh)
      return Promise.resolve(prior.record.evaluation ?? unknown(basis,prior.record.reason ?? "An existing invocation owns this admission; no paid replay is permitted."));
    const run = async (): Promise<Evaluation> => {
      const cancelled = () => ledger.retire(input.assessmentId,"Native assessment cancelled; late answers cannot accept it.",true);
      input.signal.addEventListener("abort",cancelled,{once:true});
      try {
        if (input.signal.aborted) { cancelled(); return unknown(basis,"Native assessment cancelled."); }
        const snapshot = readPolicyBytes(input.policyBytes);
        const deadline = Math.min(Date.now()+snapshot.connection.timeoutMs,input.nativeDeadlineAt ? Date.parse(input.nativeDeadlineAt) : Infinity);
        if (!Number.isFinite(deadline) || deadline <= Date.now()) throw Error("Native assessment deadline expired.");
        const signal = AbortSignal.any([input.signal,AbortSignal.timeout(Math.max(1,deadline-Date.now()))]);
        const transport = transportFor(snapshot);
        const guarded: Transport = async (wire, dispatchSignal, context) => {
          if (signal.aborted || Date.now() >= deadline) throw Error("Admission time budget exhausted or cancelled before invocation.");
          const attempt = ledger.reserve(input.assessmentId,context?.partitionHash ?? fingerprint(wire),wire,snapshot.connection.maxCalls);
          ledger.invoke(input.assessmentId,attempt);
          let receipt:unknown=null;
          try {
            const raw = await abortable(Promise.resolve(transport(wire,dispatchSignal,context,{operation:{namespace:'message-rules.admission',operationId:attempt},deadlineAt:deadline,kind:'message-rules.admission',attribution:{assessmentId:input.assessmentId,attemptId:attempt,partitionHash:context?.partitionHash??fingerprint(wire),inputHash:basis},observe:value=>{receipt=value;}})).then(value => {
              ledger.observe(attempt,signal.aborted ? "unknown" : "observed",receipt===null?value:{response:value,transport:receipt});
              return value;
            }),signal);
            if (signal.aborted || Date.now() >= deadline) throw Error("Late admission transport response; outcome remains unresolved.");
            return raw;
          } catch (e) {
            ledger.observe(attempt,"unknown",e instanceof TransportError ? { message:e.message,invoked:e.invoked,observation:e.observation } : {message:e instanceof Error ? e.message : String(e)});
            throw e;
          }
        };
        let captureError: string | null = null;
        const result = await evaluateScoped(input.candidate,snapshot.groups,snapshot.rules,snapshot.connection,async rules => {
          try {
            const evidence = await abortable(input.captureEvidence(rules),signal);
            // Native routing and original content cannot be replaced by captured
            // history, even if a faulty capture port returns different metadata.
            return { ...input.candidate,sender:evidence.sender,destination:evidence.destination };
          } catch (e) {
            captureError = e instanceof Error ? e.message : String(e);
            return input.candidate;
          }
        },guarded,signal,countTokens);
        if (captureError) { result.policy="unknown"; delete result.route; result.errors.push(captureError); }
        if (signal.aborted) { result.policy="unknown"; delete result.route; result.errors.push("Admission evaluation cancelled or expired."); }
        result.evidenceTokens = input.evidenceTokens?.() ?? [];
        if (!ledger.finish(input.assessmentId,result)) return unknown(basis,"Admission ownership retired; late result was fenced.");
        return result;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        ledger.retire(input.assessmentId,reason);
        return unknown(basis,reason);
      } finally { input.signal.removeEventListener("abort",cancelled); }
    };
    const promise = run().finally(() => { active.delete(input.assessmentId); });
    active.set(input.assessmentId,{basis,promise});
    return promise;
  };
}
