import { bindMessageAdmission } from "@phosphorco/bb-message-admission/bb";
import { listRecentDecisions } from "../../admission/decisions.ts";
import { nativeEvaluator } from "../../admission/native-evaluator.ts";
import { createAdmissionEvaluator } from "../../admission/evaluator.ts";
import { createAdmissionLedger } from "../../admission/ledger.ts";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  canonicalJson, publicationFingerprint, reduceObservations,
  type EvaluatorV1, type SubmissionV1, type OperationRecordV1,
  type PublicationV1, type NativeAdmissionProtocolV1,
} from "@phosphorco/bb-message-admission/protocol";
import { createMessageRules } from "../../ui-suite-server.ts";
import { canonical } from "../../contracts/hash.ts";
import { defaultConnection, newGroup, newRule, VERSION } from "../../contracts/model.ts";
import { GLOBAL_CATALOG } from "../../contracts/catalog.ts";

// Historical reader fixture. The retired evaluator constructs retained rows only.
// Production uses the native sender hook and never binds this legacy protocol.
// These are adapter fixtures, never live native or provider evidence.
export async function decisionsFixture(db = new Database(":memory:"), available = true) {
  const counters = { evaluate: 0, lookup: 0, inflight: 0, peak: 0, paid: 0, writes: 0, capture: 0 };
  const secret = "fixture-connection-auth-value-never-return";
  const group = { ...newGroup("scoped-group"), title: "Frozen scoped group", enabled: true, revision: 7,
    match: { kind: "condition" as const, field: "project_id" as const, operator: "equals" as const, value: "project-test", insensitive: false } };
  const rules = [1, 2].map(n => ({ ...newRule("rule-" + n, group.id), enabled: true, title: "Cause " + n, revision: n,
    advice: "All advice " + n }));
  const snapshotBytes = canonical({ format: 1, evaluatorVersion: VERSION, catalogRevision: 17, catalogBasis: "frozen-basis", groups: [group], rules,
    connection: { ...defaultConnection, apiKey: secret } });
  const content = { version: 1 as const, providerId: "message-rules", snapshotBytes, configurationVersion: "17", evaluatorVersion: VERSION,
    enrollment: { mode: "enforce" as const, projectIds: ["project-test"] } };
  const publication: PublicationV1 = { version: 1, publication: { providerId: "message-rules", publicationId: "frozen-publication", fingerprint: await publicationFingerprint(content, 4 * 1024 * 1024) },
    operation: { namespace: "fixture-policy", operationId: "fixture-publish" }, snapshotBytes, configurationVersion: "17", evaluatorVersion: VERSION,
    enrollment: content.enrollment, publishedAt: "2026-11-12T10:00:00Z" };
  let active: PublicationV1 | null = publication, callback!: EvaluatorV1;
  let offline = false, missing = false;
  const records = new Map<string, OperationRecordV1>();
  const native: NativeAdmissionProtocolV1 = {
    describe: () => ({ protocol: "bb-message-admission", versions: [1], capabilities: { admission: true, publication: true, operations: true, placement: false,
      originalManifest: false, activity: false, feedback: false, limits: { requestBytes: 4*1024*1024, responseBytes: 4*1024*1024, snapshotBytes: 4*1024*1024,
        evidenceBytes: 4*1024*1024, manifestBytes: 4*1024*1024, evaluationMs: 60000, concurrentEvaluations: 32 } } }),
    registerEvaluator: (input, evaluator) => { callback = evaluator; return { version: 1, registrationId: "fixture-registration", generation: "fixture-generation", evaluatorVersion: input.evaluatorVersion }; },
    unregisterEvaluator: () => ({ version: 1, removed: true }),
    readActivePublication: () => { if (offline) throw Error("fixture native read offline"); return active; },
    publish: () => { counters.writes++; throw Error("Publication forbidden by read fixture"); },
    recheckOperation: () => { counters.writes++; throw Error("Recheck forbidden by read fixture"); },
    lookupOperation: async input => {
      counters.lookup++; counters.inflight++; counters.peak = Math.max(counters.peak, counters.inflight);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (offline) throw Error("fixture native read offline");
        const record = missing ? null : records.get(input.operation.operationId) ?? null;
        return { version: 1, status: record ? "found" : "missing", record };
      } finally { counters.inflight--; }
    },
  };
  const fake = createFakePluginHost({ pluginId: "message-rules" });
  fake.bb.storage.database = () => db;
  if (available) Object.assign(fake.bb, { experimental_messageAdmission: native });
  const product = createMessageRules(fake.bb, {
    transportFor: () => async () => { counters.paid++; throw Error("Paid test forbidden"); },
    admissionTransportFor: () => async () => { counters.paid++; throw Error("Paid admission forbidden"); },
  });
  await product.admission.ready;
  const rpc = (method: string, input: object) => fake.harness.behavior.callRpc(method, input) as Promise<any>;
  const historicalBinding=await bindMessageAdmission(fake.bb);
  const read = (input: object = {}) => listRecentDecisions(db,input,async()=>{if(historicalBinding.status!=="available")throw Error(historicalBinding.detail);return historicalBinding.client;});
  const snapshot = () => rpc("snapshot", { projectId: GLOBAL_CATALOG, discoverFiles: false });
  async function capture(id: string, status: "accepted" | "rejected" | "unresolved" = "rejected") {
    const submission: SubmissionV1 = { version: 1, operation: { namespace: "fixture-native", operationId: "operation-" + id }, requestFingerprint: "sha256:" + "a".repeat(64),
      original: { originalId: "original-" + id, revision: 3 }, threadId: "destination-id", projectId: status === "accepted" ? "outside-project" : "project-test",
      policyContext: { messageText: "Original " + id, projectTitle: "Testing project", senderTitle: "Sender name", destinationTitle: "Destination name" },
      rawInput: { text: "untouched original", nonsecretDebug: { host: "10.20.30.40", path: "/fixture/source", accountId: "account-id" } },
      requestedIntent: { mode: "queue", schedule: { kind: "ordinary" }, membership: "preserve", execution: { provider: null, model: null, reasoning: null, serviceTier: null, permissionMode: null, canAsk: false, configuration: {} } },
      source: { senderThreadId: "sender-id", initiator: "agent", author: { kind: "machine", machineId: "machine-id" }, editor: { kind: "user", userId: "user-id" }, origin: { kind: "agent", threadId: "sender-id" }, externalOperation: null, visibleHumanActivity: false },
      kind: "message", override: "none", expectedPlacementWitness: null };
    if(!callback) callback=nativeEvaluator(createAdmissionEvaluator(createAdmissionLedger(db),()=>async()=>{counters.paid++;throw Error("Historical fixture cannot invoke paid transport");}));
    counters.evaluate++;
    const localResult = await callback({ version: 1, assessmentId: id, generation: "fixture-generation", cancellationGeneration: "fixture-cancel",
      deadlineAt: new Date(Date.now() + 20000).toISOString(), submission, publication }, {
      signal: new AbortController().signal,
      captureEvidence: async () => {
        counters.capture++;
        return { version: 1, token: "evidence-" + id, operation: submission.operation, original: submission.original, assessmentId: id,
          capturedAt: new Date().toISOString(), metadata: { projectId: submission.projectId, threadId: submission.threadId, senderThreadId: submission.source.senderThreadId, policyContext: submission.policyContext },
          windows: [], readSetFingerprint: "sha256:" + "b".repeat(64), prefixMode: "native-candidate" };
      },
    });
    const assessment = status === "unresolved" ? reduceObservations({ assessmentId: id, observations: localResult.observations, complete: false,
      unresolved: [{ code: "fixture-native-unresolved", message: "Native evidence remains unresolved" }] }) : localResult;
    const record: OperationRecordV1 = { version: 1, operation: submission.operation, requestFingerprint: submission.requestFingerprint,
      kind: "submission", status, original: submission.original, assessments: [assessment], publication,
      acceptedOriginal: status === "accepted" ? { version: 1, operation: submission.operation, requestFingerprint: submission.requestFingerprint,
        original: submission.original, threadId: submission.threadId, rawInput: submission.rawInput, source: submission.source,
        requestedIntent: submission.requestedIntent, effectiveIntent: { ...submission.requestedIntent, changes: [] }, acceptedAt: "2026-11-12T10:01:00Z", acceptanceSequence: 1,
        admission: { kind: "evaluated", publications: [publication.publication], assessments: [assessment] } } : null,
      feedback: status === "accepted" ? null : { version: 1, obligationId: "feedback-" + id, operation: { namespace: "feedback", operationId: id },
        providerId: "message-rules", original: submission.original, rejectionAssessmentId: id, recipientThreadId: "sender-id", causeIds: ["rule-1", "rule-2"],
        advice: [...assessment.advice], status: "uncertain", nativeRequestId: null, verification: null, reasons: [{ code: "unknown-delivery", message: "Delivery not confirmed" }] },
      delivery: { state: status === "accepted" ? "provider-accepted" : "none", queueId: status === "accepted" ? "queue-id" : null, requestId: status === "accepted" ? "request-id" : null, groupIndex: status === "accepted" ? 0 : null, details: { fixture: "controlled delivery state" } }, reasons: [] };
    records.set(submission.operation.operationId, record);
    return { submission, record, localResult };
  }
  return { db, fake, product, rpc, read, snapshot, capture, records, counters, secret, publication,
    setOffline(value: boolean) { offline = value; }, setMissing(value: boolean) { missing = value; }, setActive(value: PublicationV1 | null) { active = value; },
    async close(closeDb = true) { await fake.harness.lifecycle.dispose(); if (closeDb) db.close(); },
    dump() { return canonicalJson(db.prepare("SELECT rowid,* FROM mr_admissions ORDER BY rowid").all(), 4*1024*1024); },
  };
}
