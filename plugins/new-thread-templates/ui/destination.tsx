import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_BranchPicker as BranchPicker,
  type ExperimentalProviderModelPickerRouting,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import type { TemplateDefinition } from "../model.ts";
import type { ResolvedEffects, TemplatesContext } from "../rpc-contract.ts";
import { TextField } from "./fields.tsx";

export function ProjectSelect({
  context,
  value,
  onChange,
  id = "ntt-project",
  label = "Destination project",
  disabled,
}: {
  context: TemplatesContext;
  value: string;
  onChange(value: string): void;
  id?: string;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="ntt-field">
      <label htmlFor={id}>{label}</label>
      <select
        className="ntt-input"
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose a project…</option>
        {context.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
export function DestinationEditor({
  definition,
  change,
  context,
}: {
  definition: TemplateDefinition;
  change(next: TemplateDefinition): void;
  context: TemplatesContext | null;
}) {
  const destination = definition.destination,
    policy = destination.environment;
  const set = (next: TemplateDefinition["destination"]) =>
    change({ ...definition, destination: next });
  const project =
    destination.kind === "existing-project"
      ? context?.projects.find((p) => p.id === destination.projectId)
      : null;
  const hostId =
    destination.kind === "new-project"
      ? destination.hostId
      : (destination.hostId ??
        project?.sources.find((s) => s.isDefault)?.hostId ??
        project?.sources[0]?.hostId ??
        null);
  const reused =
    policy.kind === "reuse"
      ? context?.environments.find(
          (environment) => environment.id === policy.environmentId,
        )
      : null;
  const reusedHost = reused
    ? context?.hosts.find((host) => host.id === reused.hostId)
    : null;
  const pinnedHost =
    destination.kind !== "new-project" ? destination.hostId : undefined;
  const pinned = context?.hosts.find((host) => host.id === pinnedHost);
  const envs =
    context?.environments.filter(
      (e) =>
        destination.kind === "existing-project" &&
        e.projectId === destination.projectId,
    ) ?? [];
  return (
    <div className="ntt-stack">
      <div className="ntt-columns">
        <div className="ntt-field">
          <label htmlFor="ntt-destination-kind">Project</label>
          <select
            className="ntt-input"
            id="ntt-destination-kind"
            value={
              destination.kind === "existing-project"
                ? destination.projectId
                : destination.kind
            }
            onChange={(e) => {
              const value = e.target.value;
              set(
                value === "new-project"
                  ? {
                      kind: "new-project",
                      nameTemplate: "{{name}}",
                      hostId: "",
                      path: "",
                      environment: { kind: "local-source" },
                    }
                  : value === "choose-at-launch"
                    ? {
                        kind: "choose-at-launch",
                        ...(pinnedHost ? { hostId: pinnedHost } : {}),
                        environment:
                          destination.kind === "new-project"
                            ? { kind: "project-default" }
                            : policy,
                      }
                    : {
                        kind: "existing-project",
                        projectId: value,
                        ...(pinnedHost ? { hostId: pinnedHost } : {}),
                        environment:
                          destination.kind === "new-project"
                            ? { kind: "project-default" }
                            : policy,
                      },
              );
            }}
          >
            <option value="choose-at-launch">
              Choose when starting a thread
            </option>
            {destination.kind === "existing-project" &&
              !context?.projects.some(
                (p) => p.id === destination.projectId,
              ) && (
                <option value={destination.projectId}>
                  {destination.projectId || "Choose a project…"} (unavailable)
                </option>
              )}
            {context?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="new-project">
              Create project from an existing local directory…
            </option>
          </select>
        </div>
        {destination.kind !== "new-project" && (
          <div className="ntt-field">
            <label htmlFor="ntt-destination-host">Machine</label>
            {policy.kind === "reuse" ? (
              <input
                id="ntt-destination-host"
                className="ntt-input"
                readOnly
                value={
                  reused
                    ? `${reusedHost?.name ?? reused.hostId}${reusedHost?.online === false ? " (offline)" : ""}`
                    : "Choose an existing environment"
                }
              />
            ) : (
              <select
                id="ntt-destination-host"
                className="ntt-input"
                value={pinnedHost ?? ""}
                onChange={(event) => {
                  const { hostId: _host, ...rest } = destination;
                  set(
                    event.target.value
                      ? { ...rest, hostId: event.target.value }
                      : rest,
                  );
                }}
              >
                <option value="">BB default</option>
                {pinnedHost && !pinned && (
                  <option value={pinnedHost}>{pinnedHost} (unavailable)</option>
                )}
                {context?.hosts.map((host) => (
                  <option key={host.id} value={host.id} disabled={!host.online}>
                    {host.name}
                    {!host.online ? " (offline)" : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
      {pinnedHost && policy.kind === "project-default" && (
        <p className="ntt-error">
          Choose a source checkout or worktree for this machine. BB default
          keeps automatic environment selection.
        </p>
      )}
      {pinnedHost && policy.kind !== "reuse" && (!pinned || !pinned.online) && (
        <p className="ntt-error">
          The saved machine is unavailable or disconnected. Reconnect it or
          choose another machine.
        </p>
      )}
      {policy.kind === "reuse" &&
        policy.environmentId &&
        !envs.some(
          (environment) => environment.id === policy.environmentId,
        ) && (
          <p className="ntt-error">
            This environment is unavailable for the selected project. Choose an
            environment from this project.
          </p>
        )}
      {pinnedHost && reused && pinnedHost !== reused.hostId && (
        <div className="ntt-stack">
          <p className="ntt-error">
            The saved machine differs from this environment’s fixed machine.
          </p>
          <button
            type="button"
            className="ntt-link"
            onClick={() => set({ ...destination, hostId: reused.hostId })}
          >
            Use this environment’s machine
          </button>
        </div>
      )}
      <details
        key={destination.kind}
        open={
          destination.kind === "new-project" ||
          !!pinnedHost ||
          policy.kind !== "project-default"
        }
      >
        <summary>
          {destination.kind === "new-project"
            ? "Project source and environment"
            : "Environment options"}
        </summary>
        <div className="ntt-stack ntt-options">
          {destination.kind === "new-project" && (
            <>
              <TextField
                label="Project name template"
                value={destination.nameTemplate}
                onChange={(nameTemplate) =>
                  set({ ...destination, nameTemplate })
                }
              />
              <div className="ntt-field">
                <label htmlFor="ntt-source-host">Source machine</label>
                <select
                  className="ntt-input"
                  id="ntt-source-host"
                  value={destination.hostId}
                  onChange={(e) =>
                    set({ ...destination, hostId: e.target.value })
                  }
                >
                  <option value="">Choose an enrolled machine…</option>
                  {context?.hosts.map((h) => (
                    <option key={h.id} value={h.id} disabled={!h.online}>
                      {h.name}
                      {!h.online ? " (offline)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <TextField
                label="Existing absolute source path"
                value={destination.path}
                onChange={(path) => set({ ...destination, path })}
              />
              <p className="ntt-help">
                Creates a BB project using this existing local directory. No
                repository cloning or machine bootstrap.
              </p>
            </>
          )}
          <div className="ntt-field">
            <label htmlFor="ntt-environment-kind">Environment</label>
            <select
              className="ntt-input"
              id="ntt-environment-kind"
              value={policy.kind}
              onChange={(e) => {
                const kind = e.target.value;
                set({
                  ...destination,
                  environment:
                    kind === "reuse"
                      ? { kind, environmentId: "" }
                      : kind === "worktree"
                        ? { kind, baseBranch: "" }
                        : kind === "local-source"
                          ? { kind }
                          : { kind: "project-default" },
                });
              }}
            >
              {destination.kind !== "new-project" && (
                <option value="project-default" disabled={!!pinnedHost}>
                  BB automatic{pinnedHost ? " (requires default machine)" : ""}
                </option>
              )}
              {destination.kind === "existing-project" && (
                <option value="reuse">Existing environment</option>
              )}
              <option value="local-source">Project checkout</option>
              <option value="worktree">New worktree</option>
            </select>
          </div>
          {policy.kind === "reuse" && (
            <div className="ntt-field">
              <label htmlFor="ntt-environment">Existing environment</label>
              <select
                className="ntt-input"
                id="ntt-environment"
                value={policy.environmentId}
                onChange={(e) =>
                  set({
                    ...destination,
                    environment: { ...policy, environmentId: e.target.value },
                  })
                }
              >
                <option value="">Choose an environment…</option>
                {policy.environmentId &&
                  !envs.some(
                    (environment) => environment.id === policy.environmentId,
                  ) && (
                    <option value={policy.environmentId} disabled>
                      {reused?.name ?? policy.environmentId} (unavailable for
                      this project)
                    </option>
                  )}
                {envs.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.path ?? e.hostId}
                  </option>
                ))}
              </select>
            </div>
          )}
          {policy.kind === "worktree" &&
            (project ? (
              <BranchPicker
                hostId={hostId}
                projectId={project.id}
                value={policy.baseBranch || null}
                onChange={(value) =>
                  set({
                    ...destination,
                    environment: { ...policy, baseBranch: value ?? "" },
                  })
                }
                label="Base branch"
              />
            ) : (
              <TextField
                label="Base branch"
                value={policy.baseBranch}
                onChange={(baseBranch) =>
                  set({
                    ...destination,
                    environment: { ...policy, baseBranch },
                  })
                }
              />
            ))}
          {policy.kind === "local-source" && (
            <TextField
              label="Branch (optional)"
              value={policy.branch ?? ""}
              onChange={(branch) =>
                set({
                  ...destination,
                  environment: { ...policy, branch: branch || undefined },
                })
              }
            />
          )}
        </div>
      </details>
    </div>
  );
}
export function ModelEditor({
  definition,
  change,
  effects,
  routing,
}: {
  definition: TemplateDefinition;
  change(next: TemplateDefinition): void;
  effects: ResolvedEffects | null;
  routing?: ExperimentalProviderModelPickerRouting;
}) {
  const execution = definition.execution;
  const explicit = execution.kind === "explicit";
  const value: ExperimentalProviderModelPickerValue = {
    providerId: explicit
      ? execution.providerId
      : (effects?.execution.providerId ?? ""),
    model: explicit ? execution.model : (effects?.execution.model ?? ""),
    reasoningLevel: (explicit
      ? execution.reasoningLevel
      : (effects?.execution.reasoningLevel ??
        undefined)) as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(explicit && execution.serviceTier
      ? {
          serviceTier:
            execution.serviceTier as ExperimentalProviderModelPickerValue["serviceTier"],
        }
      : {}),
  };
  return (
    <div className="ntt-stack">
      <div className="ntt-field">
        <label htmlFor="ntt-execution-kind">Model policy</label>
        <select
          className="ntt-input"
          id="ntt-execution-kind"
          value={definition.execution.kind}
          onChange={(e) =>
            change({
              ...definition,
              execution:
                e.target.value === "explicit"
                  ? { kind: "explicit", providerId: "", model: "" }
                  : { kind: "project-default" },
            })
          }
        >
          <option value="project-default">
            Inherit final project defaults
          </option>
          <option value="explicit">Choose provider and model</option>
        </select>
      </div>
      <p className="ntt-help">
        Uses this project’s model defaults at launch. A selected model must be
        available there.
      </p>
      {explicit &&
        ((effects?.routing ?? routing) ? (
          <ProviderModelPicker
            routing={effects?.routing ?? routing}
            value={value}
            disabled={!explicit}
            onChange={(next) =>
              change({
                ...definition,
                execution: { kind: "explicit", ...next },
              })
            }
          />
        ) : (
          <p className="ntt-status">
            Choose a valid destination to load its native model picker.
          </p>
        ))}
      {explicit && !execution.model && (
        <p className="ntt-error">
          Choose an available model before publishing.
        </p>
      )}
    </div>
  );
}
export function EffectsSummary({
  effects,
  compact = false,
}: {
  effects: ResolvedEffects;
  compact?: boolean;
}) {
  return (
    <div className="ntt-summary" aria-label="Final launch destination">
      {effects.mode === "native" && <span>Edited with BB</span>}
      <span>
        {effects.createsProject ? "Create project" : "Project"}:{" "}
        <strong>{effects.projectName}</strong>
      </span>
      <span>
        Machine:{" "}
        <strong>
          {effects.hostName ??
            effects.hostId ??
            "Selected environment provider"}
        </strong>
      </span>
      <span>
        Environment: <strong>{effects.environment}</strong>
      </span>
      <span>
        Model:{" "}
        <strong>
          {effects.execution.providerId} / {effects.execution.model}
        </strong>
        {effects.execution.reasoningLevel &&
          ` · ${effects.execution.reasoningLevel}`}
        {!compact && effects.execution.inherited && " · inherited"}
      </span>
      {!compact && effects.path && (
        <span>
          Source: <strong>{effects.path}</strong>
        </span>
      )}
    </div>
  );
}
