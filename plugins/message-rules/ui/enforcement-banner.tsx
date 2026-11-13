import type { Snapshot } from "./types.ts";

export function EnforcementBanner({ delivery, readError, projects }: {
  delivery?: Snapshot["delivery"]; readError?: string | null;
  projects: { id:string; name:string }[];
}) {
  const policy=delivery?.activePolicy;
  const known=delivery?.activeKnown===true&&!readError;
  const current=known&&delivery?.state==="available"&&delivery.generationReady===true;
  const enforcing=current&&policy?.enabled;
  const project=policy&&(projects.find(project=>project.id===policy.projectId)?.name??policy.projectId);
  return <section className="mr-notice" role="status" aria-label="Message Rules enforcement">
    <strong>{enforcing?"Static sender rules active":current?"Not enforcing":delivery||readError?"Enforcement status unavailable":"Reading enforcement status"}</strong>
    <p>{enforcing?`Frozen policy for ${project}. `:"Saving and testing rules do not activate live enforcement. "}
      {readError?`Status read failed: ${readError}. `:delivery?.reason}
    </p>
    {policy&&<details><summary>Active policy</summary><p>{policy.ref.policyId} · catalog revision {policy.catalogRevision} · activated {new Date(policy.createdAt).toLocaleString()}. Saved edits do not change this frozen policy.</p></details>}
    {!!delivery?.recentSenderDecisions?.length&&<details><summary>Recent sender decisions · {delivery.recentSenderDecisions.length}</summary>
      {delivery.recentSenderDecisions.map((row,index)=><p key={index}>{new Date(row.created_at).toLocaleString()} · {row.sender_thread_id??"Human/system"} → {row.thread_id}<br/>{JSON.stringify(row.decision)}</p>)}
    </details>}
  </section>;
}
