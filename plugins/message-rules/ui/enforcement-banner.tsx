import type { Snapshot } from "./types.ts";

export function EnforcementBanner({ delivery, readError, projects }: {
  delivery?: Snapshot["delivery"]; readError?: string | null;
  projects: { id: string; name: string }[];
}) {
  const publication = delivery?.activePublication;
  const known = delivery?.activeKnown === true && !readError;
  const enforcing = known && delivery?.state === "available" && delivery.generationReady === true && publication?.enrollment.mode === "enforce";
  const inactive = known && delivery?.state === "available" && (!publication || publication.enrollment.mode === "disabled");
  const scope = publication?.enrollment.projectIds.map(id => {
    const name = projects.find(project => project.id === id)?.name;
    return name ? `${name} (${id})` : id;
  }).join(", ");
  return <p className="mr-notice" role="status" aria-label="Message Rules enforcement">
    <strong>{enforcing ? "Enforcing Message Rules" : inactive ? "Not enforcing" : delivery || readError ? "Enforcement status unavailable" : "Enforcement status unknown"}</strong>
    <span>
      {publication && <>
        {known ? "Native publication" : "Last observed publication"} {publication.publication.publicationId}
        {` · configuration ${publication.configurationVersion} · evaluator ${publication.evaluatorVersion} · ${publication.enrollment.mode === "enforce" ? `frozen project scope: ${scope}` : "enrollment disabled"}. `}
      </>}
      {enforcing ? "Current evaluator generation is ready. " : inactive ? "The authoritative native pointer has no enforcing publication. " :
        readError ? `The current native pointer is unknown because this read failed: ${readError}. ` :
        delivery ? `${publication?.enrollment.mode === "enforce" ? "Current-generation enforcement is unconfirmed. " : ""}${delivery.reason} ` : "Reading the authoritative native pointer. "}
      Saving, toggling rules, Test and JEV configuration never enroll a project. Saved edits and tests are separate from the frozen native policy.
    </span>
  </p>;
}
