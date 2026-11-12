import { useEffect, useRef, useState } from "react";
import type { Client } from "./types.ts";
import type { DecisionRow, RecentDecisions } from "../admission/decisions-contract.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2);
const status = (row: DecisionRow) => row.native.record?.status ?? `unknown (${row.native.state})`;
function Decision({ row, readDetail, busy }: { row: DecisionRow; readDetail: () => void; busy: boolean }) {
  const submission = row.submission, record = row.native.record;
  return <details className="mr-native-decision">
    <summary>
      <strong>Native outcome: {status(row)}</strong>{" · "}{row.assessmentId}
      {submission && <span>{` · ${submission.policyContext.senderTitle ?? "Unnamed sender"} (${submission.source.senderThreadId ?? "no sender thread declared"}) → ${submission.policyContext.destinationTitle ?? "Unnamed destination"} (${submission.threadId})`}</span>}
    </summary>
    <dl>
      <dt>Operation</dt><dd>{row.operation ? `${row.operation.namespace} / ${row.operation.operationId}` : "Unknown — no valid frozen binding"}</dd>
      <dt>Original</dt><dd>{submission ? `${submission.original.originalId} · revision ${submission.original.revision}` : "Unavailable"}</dd>
      <dt>Frozen publication</dt><dd>{row.frozenPublication ? `${row.frozenPublication.providerId} / ${row.frozenPublication.publicationId} · ${row.frozenPublication.fingerprint}` : "Unavailable"}</dd>
      <dt>Frozen policy version</dt><dd>{row.frozenPolicy ? `configuration ${row.frozenPolicy.catalogRevision} · evaluator ${row.frozenPolicy.evaluatorVersion} · basis ${row.frozenPolicy.catalogBasis}` : "Unavailable"}</dd>
      <dt>Native lookup</dt><dd>{row.native.reason ?? "Current public native operation record; it may contain later assessments than this callback."}</dd>
    </dl>
    <button type="button" disabled={busy} onClick={readDetail}>Read callback detail</button>
    {row.diagnostics.map((message, index) => <p key={index} className="mr-note">{message}</p>)}
    {submission && <>
      <p>Project: {submission.policyContext.projectTitle ?? "Unnamed"} ({submission.projectId ?? "unknown"}). Declared initiator: {submission.source.initiator}; visible human activity: {String(submission.source.visibleHumanActivity)}.</p>
      <details><summary>Declared source, destination and original input</summary>
        <p>{submission.policyContext.messageText}</p>
        <pre>{json(submission)}</pre>
        {row.rawOriginal && <><p>Raw original: {row.rawOriginal.bytes} bytes{row.rawOriginal.truncated ? " · bounded excerpt, truncated" : " · complete"}</p><pre>{row.rawOriginal.text}</pre></>}
      </details>
    </>}
    {row.frozenPolicy && <details><summary>Frozen group scopes</summary><pre>{json(row.frozenPolicy.groups)}</pre></details>}
    {record && <>
      <h3>Native assessments</h3>
      {!record.assessments.length && <p>No native assessments in this operation record.</p>}
      {record.assessments.map((assessment, index) => <div key={index} className="mr-native-assessment">
        <p><strong>{assessment.verdict}</strong> · {assessment.assessmentId} · complete: {String(assessment.complete)}</p>
        <ul>{assessment.observations.map((rule, i) => <li key={i}>
          Group {rule.groupId} · rule {rule.ruleId} · revision {rule.revision} · {rule.status}
          <ul>{rule.causes.map((cause, j) => <li key={j}>{cause.code}: {cause.message}</li>)}</ul>
        </li>)}</ul>
        <h4>All known causes</h4>
        <ul>{assessment.causes.map((cause, i) => <li key={i}>{cause.groupId} / {cause.ruleId} · {cause.code}: {cause.message}</li>)}</ul>
        <h4>All advice</h4>
        <ul>{assessment.advice.map((advice, i) => <li key={i}>{advice}</li>)}</ul>
        <ul>{assessment.unresolved.map((reason, i) => <li key={i}>Unresolved · {reason.code}: {reason.message}</li>)}</ul>
        <details><summary>Assessment observations and routing</summary><pre>{json(assessment)}</pre></details>
      </div>)}
      <h3>Feedback and delivery</h3>
      <p>Feedback: {record.feedback?.status ?? "none recorded"}. Delivery: {record.delivery.state}.</p>
      <ul>{record.reasons.map((reason, i) => <li key={i}>{reason.code}: {reason.message}</li>)}</ul>
      <details><summary>Feedback, delivery and acceptance details</summary>
        <pre>{json({ feedback: record.feedback, delivery: record.delivery, acceptedOriginal: record.acceptedOriginal, acceptanceReceipt: record.acceptanceReceipt })}</pre>
      </details>
      {record.publication && <details><summary>Publication reported by this operation</summary><pre>{json(record.publication)}</pre></details>}
    </>}
    <details><summary>Local MR evaluation — diagnostic, not native finality</summary>
      <p>Callback state: {row.local.state}. {row.local.reason}</p>
      <pre>{json(row.local.evaluation)}</pre>
    </details>
    <p className="mr-note">This callback's frozen publication can differ from the latest policy in the enforcement banner.</p>
  </details>;
}

export function RecentNativeDecisions({ client }: { client: Client }) {
  const [page, setPage] = useState<RecentDecisions | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0), pending = useRef(false);
  useEffect(() => {
    generation.current++; pending.current = false;
    setBusy(false); setPage(null); setError(null);
    return () => { generation.current++; pending.current = false; };
  }, [client]);
  async function read(before?: string, assessmentId?: string) {
    if (pending.current) return;
    const current = ++generation.current;
    pending.current = true; setBusy(true);
    try {
      const next = await client.listRecentDecisions({ limit: assessmentId ? 1 : 10, ...(before ? { before } : {}), ...(assessmentId ? { assessmentId } : {}) });
      if (generation.current !== current) return;
      setPage(next); setError(null);
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === current) { pending.current = false; setBusy(false); }
    }
  }
  return <details className="mr-recent-decisions">
    <summary>Recent native decisions</summary>
    <section aria-label="Recent native decisions" aria-busy={busy}>
      <p className="mr-note">Coverage: MR evaluator callbacks retained here. Inputs before the MR callback, a missing or deactivated plugin, other providers and operational exemptions may be absent. Accepted preparations are not rejected history.</p>
      <div className="mr-inline">
        <button type="button" disabled={busy} onClick={() => void read()}>{page ? "Refresh" : "Read recent decisions"}</button>
        {page?.nextCursor && <button type="button" disabled={busy} onClick={() => void read(page.nextCursor!)}>More</button>}
      </div>
      {busy && <p role="status">Reading recent native decisions…</p>}
      {error && <p role="alert">Decision read failed: {error}{page ? " Last successful page retained; outcomes may have changed." : " No decision page has been read."}</p>}
      {!page && !busy && !error && <p>Read on demand. This view does not evaluate or send messages.</p>}
      {page && !page.rows.length && <p>{page.retention === "no-retained-callbacks" ? "No retained MR evaluator callbacks; the ledger does not exist yet." : "No retained MR evaluator callbacks on this page."}</p>}
      {page?.rows.map(row => <Decision key={row.cursor} row={row} busy={busy} readDetail={() => void read(undefined, row.assessmentId)} />)}
      {page && <p className="mr-note">Refresh reads the newest page. More replaces this page with older callbacks in retained insertion order. Native outcomes are factual as of the last explicit read.</p>}
    </section>
  </details>;
}
