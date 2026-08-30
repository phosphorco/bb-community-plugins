import "./app.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin-sdk/app";

import type { rpcContract } from "./rpc-contract.ts";

type Project = {
  id: string;
  name: string;
  message: string | null;
};

type Status = {
  automatic: boolean;
  pending: number;
  resumed: number;
};

function RestartResumeSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const draftDirty = useRef(false);
  const draftGeneration = useRef(0);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);

  const refresh = useCallback(() => {
    if (refreshInFlight.current !== null) {
      refreshQueued.current = true;
      return refreshInFlight.current;
    }

    const request = (async () => {
      do {
        refreshQueued.current = false;
        const [projectResult, nextStatus] = await Promise.all([
          rpc.call("listProjects", null),
          rpc.call("status", null),
        ]);
        setProjects(projectResult.projects);
        setStatus(nextStatus);
        setSelectedProjectId((current) => {
          const nextProjectId = projectResult.projects.some((project) => project.id === current)
            ? current
            : (projectResult.projects[0]?.id ?? "");
          if (nextProjectId !== current) {
            draftDirty.current = false;
            draftGeneration.current += 1;
            selectedProjectIdRef.current = nextProjectId;
          }
          return nextProjectId;
        });
        setLoading(false);
      } while (refreshQueued.current);
    })();
    refreshInFlight.current = request;
    void request.then(
      () => {
        if (refreshInFlight.current === request) refreshInFlight.current = null;
      },
      () => {
        if (refreshInFlight.current === request) refreshInFlight.current = null;
      },
    );
    return request;
  }, [rpc]);

  useEffect(() => {
    void refresh().catch((cause) => {
      setFeedback(cause instanceof Error ? cause.message : "Could not load restart-resume settings.");
      setLoading(false);
    });
  }, [refresh]);

  useRealtime("restart-resume", useCallback(() => {
    void refresh().catch(() => undefined);
  }, [refresh]));

  useEffect(() => {
    const project = projects.find((candidate) => candidate.id === selectedProjectId);
    if (draftDirty.current) return;
    setMessage(project?.message ?? "");
  }, [projects, selectedProjectId]);

  const save = async () => {
    if (selectedProjectId === "") return;
    const projectId = selectedProjectId;
    const saveGeneration = draftGeneration.current;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await rpc.call("saveProjectMessage", {
        projectId,
        message,
      });
      setProjects((current) => current.map((project) => project.id === result.id ? result : project));
      if (selectedProjectIdRef.current === result.id && draftGeneration.current === saveGeneration) {
        draftDirty.current = false;
        setMessage(result.message ?? "");
      }
      setFeedback("Project message saved.");
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : "Could not save the project message.");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (selectedProjectId === "") return;
    const projectId = selectedProjectId;
    const clearGeneration = draftGeneration.current;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await rpc.call("clearProjectMessage", { projectId });
      setProjects((current) => current.map((project) => project.id === result.id ? result : project));
      if (selectedProjectIdRef.current === result.id && draftGeneration.current === clearGeneration) {
        draftDirty.current = false;
        setMessage("");
      }
      setFeedback("Project message cleared; the built-in default will be used.");
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : "Could not clear the project message.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="restart-resume-muted">Loading restart-resume settings…</p>;

  return (
    <div className="restart-resume-settings">
      <p className="restart-resume-intro">
        BB records host-daemon restart interruptions durably. Automatic resume is enabled by default above; it only acts on an unarchived thread still in an error state.
      </p>

      <section className="restart-resume-card" aria-labelledby="restart-resume-project-title">
        <div className="restart-resume-heading">
          <div>
            <h3 id="restart-resume-project-title">Project resume message</h3>
            <p>Leave this blank to use the default: an informative prompt for interrupted turns, or “.” when no turn was in progress.</p>
          </div>
          {status !== null && <span className="restart-resume-count">{status.resumed} resumed</span>}
        </div>

        {projects.length === 0 ? (
          <p className="restart-resume-muted">No projects are available.</p>
        ) : (
          <>
            <label className="restart-resume-label">
              Project
              <select
                value={selectedProjectId}
                onChange={(event) => {
                  draftDirty.current = false;
                  draftGeneration.current += 1;
                  selectedProjectIdRef.current = event.target.value;
                  setSelectedProjectId(event.target.value);
                }}
              >
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label className="restart-resume-label">
              Message sent after a host restart
              <textarea
                value={message}
                onChange={(event) => {
                  draftDirty.current = true;
                  draftGeneration.current += 1;
                  setMessage(event.target.value);
                  setFeedback(null);
                }}
                maxLength={4000}
                placeholder="Use the default restart-resume message"
                rows={4}
              />
            </label>
            <div className="restart-resume-actions">
              <button type="button" className="restart-resume-button secondary" disabled={saving} onClick={() => void clear()}>
                Clear override
              </button>
              <button type="button" className="restart-resume-button" disabled={saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save message"}
              </button>
            </div>
          </>
        )}
        {feedback !== null && <p className="restart-resume-feedback">{feedback}</p>}
      </section>

      <p className="restart-resume-help">
        To retry one thread manually, run <code>bb restart-resume resume</code> inside it. Pending recoveries retry after temporary host errors.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "restart-resume-settings",
    title: "Project resume messages",
    description: "Customize what Restart Resume sends after a host daemon restart.",
    component: RestartResumeSettings,
  });
});
