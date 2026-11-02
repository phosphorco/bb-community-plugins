import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
  type ExperimentalProviderModelPickerRouting,
} from "@get-bb/plugin-sdk/app";
import {
  useBorrowedIdentityClient,
  useIdentitySession,
} from "@phosphorco/bb-identity/react";
import {
  definitionSchema,
  emptyDefinition,
  type TemplateDefinition,
  type TemplateEntry,
} from "../model.ts";
import { templatesContract, TEMPLATES_CHANGED } from "../rpc-contract.ts";
import { useMountedRead } from "./read.ts";
import {
  DestinationEditor,
  ModelEditor,
  ProjectSelect,
} from "./destination.tsx";
import {
  listEditorCheckpoints,
  removeEditorCheckpoint,
  type EditorCheckpoint,
} from "./editor-checkpoint.ts";
import { armFormReturn } from "./return.ts";
import { RecentLaunches } from "./recent.tsx";
import { TemplatePurposeIcon } from "./icon.tsx";
import { TemplateEditor } from "./editor.tsx";

export function Management({
  subPath,
  surface = "panel",
}: PluginNavPanelProps & { surface?: "panel" | "settings" }) {
  const rpc = useRpc<typeof templatesContract>(),
    navigate = useBbNavigate(),
    client = useBorrowedIdentityClient(),
    session = useIdentitySession();
  const [selected, setSelected] = useState<TemplateEntry | null>(null),
    [initial, setInitial] = useState<TemplateDefinition | null>(null),
    [generation, setGeneration] = useState<number | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null),
    [previewProject, setPreviewProject] = useState("");
  type WriteAction = "save" | "publish" | "remove" | "duplicate" | "unpublish";
  const errorAction = useRef<WriteAction | null>(null);
  const failWrite = (action: WriteAction, problem: unknown) => {
    errorAction.current = action;
    setError(problem instanceof Error ? problem.message : String(problem));
  };
  const recoverWrite = (action: WriteAction) => {
    if (errorAction.current === action) {
      errorAction.current = null;
      setError(null);
    }
  };
  const [history, setHistory] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [navigationRequest, setNavigationRequest] = useState<{
    id: string;
    go(): void;
    cancel(): void;
  } | null>(null);
  const activePath = useRef("");
  const [admittedOwner, setAdmittedOwner] = useState<string | null>(null);
  const [restored, setRestored] = useState<EditorCheckpoint | null>(null),
    [recoveries, setRecoveries] = useState<
      ReturnType<typeof listEditorCheckpoints>
    >({ items: [], error: null });
  const checkpointOwner =
    session.status === "ready"
      ? `${session.instanceId}:${session.actor.identity.key}`
      : "";
  useEffect(() => {
    if (checkpointOwner && !initial)
      setRecoveries(listEditorCheckpoints(checkpointOwner));
  }, [checkpointOwner, initial]);
  const activeTarget = useRef<string | null>(initial?.id ?? null);
  activeTarget.current = initial?.id ?? null;
  const active = useRef(true),
    generationRef = useRef<number | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const load = useCallback(() => rpc.call("catalog", {}), [rpc]);
  const catalog = useMountedRead(load, TEMPLATES_CHANGED);
  const loadContext = useCallback(
    () =>
      rpc.call("context", {
        ...(previewProject ? { projectId: previewProject } : {}),
      }),
    [rpc, previewProject],
  );
  const context = useMountedRead(loadContext, TEMPLATES_CHANGED);
  const entries = catalog.value?.entries ?? [];
  const select = (entry: TemplateEntry) => {
    setRestored(null);
    setSelected(entry);
    setInitial(
      structuredClone(entry.draft?.definition ?? entry.published!.definition),
    );
    generationRef.current = entry.draft?.generation ?? null;
    setGeneration(generationRef.current);
    setError(null);
  };
  const newTemplate = () => {
    setRestored(null);
    const definition = emptyDefinition(crypto.randomUUID());
    setSelected(null);
    setInitial(definition);
    generationRef.current = null;
    setGeneration(null);
    setError(null);
  };
  const openedPath = useRef<string | null>(null);
  const capture = () => {
    const live = client.currentSession();
    return live.ok && live.value.status === "ready"
      ? {
          actor: live.value.actor.identity.key,
          stamp: live.value.stamp,
          target: activeTarget.current,
        }
      : null;
  };
  const same = (captured: ReturnType<typeof capture>) => {
    const live = capture();
    return (
      active.current &&
      !!captured &&
      live?.actor === captured.actor &&
      live?.stamp === captured.stamp &&
      live?.target === captured.target
    );
  };
  const owner =
    session.status === "ready"
      ? `${session.instanceId}:${session.actor.identity.key}:${session.stamp}`
      : null;
  const canManage = owner !== null && admittedOwner === owner;
  const previousOwner = useRef(owner);
  useEffect(() => {
    if (previousOwner.current !== owner) {
      previousOwner.current = owner;
      openedPath.current = null;
      setInitial(null);
      setHistory(false);
      setSelected(null);
      setRestored(null);
      setSaving(false);
      setError(null);
      setRouteError(null);
      setNavigationRequest(null);
      activePath.current = "";
    }
    setAdmittedOwner(owner);
  }, [owner]);
  useEffect(() => {
    if (!canManage || openedPath.current === subPath || !catalog.value) return;
    if (!subPath && openedPath.current === null) {
      openedPath.current = "";
      activePath.current = "";
      return;
    }
    openedPath.current = subPath;
    const captured = capture();
    const priorPath = activePath.current;
    const apply = () => {
      if (!same(captured)) return;
      setNavigationRequest(null);
      setHistory(false);
      setRouteError(null);
      activePath.current = subPath;
      if (!subPath) {
        setInitial(null);
        setSelected(null);
        return;
      }
      const path = subPath.replace(/^compose\//, "");
      if (path === "new") {
        newTemplate();
        return;
      }
      let id: string;
      try {
        id = decodeURIComponent(
          path.startsWith("edit/") ? path.slice(5) : path,
        );
      } catch {
        setInitial(null);
        setRouteError(
          "This template link is invalid. Choose a template below.",
        );
        return;
      }
      const entry = catalog.value!.entries.find((e) => e.id === id);
      if (entry) select(entry);
      else {
        setInitial(null);
        setSelected(null);
        setRouteError(
          "This template is unavailable or has been removed. Choose another template or open History.",
        );
      }
    };
    if (initial)
      setNavigationRequest({
        id: crypto.randomUUID(),
        go: apply,
        cancel: () => {
          setNavigationRequest(null);
          navigate.toPluginPanel("templates", {
            subPath: priorPath,
            replace: true,
          });
          openedPath.current = priorPath;
        },
      });
    else apply();
  }, [subPath, catalog.value, canManage]);
  const remove = async (definition: TemplateDefinition) => {
    const captured = capture();
    if (!canManage || !captured || saving) return false;
    if (generationRef.current === null && !selected) return true;
    setSaving(true);
    try {
      await rpc.call("remove", {
        templateId: definition.id,
        expectedGeneration: generationRef.current,
        expectedRevision: selected?.published?.revision ?? null,
        expectedLatestRevision: selected?.latestRevision ?? 0,
      });
      if (!same(captured)) return false;
      recoverWrite("remove");
      catalog.refresh();
      return true;
    } catch (e) {
      if (same(captured)) {
        failWrite("remove", e);
        catalog.refresh();
      }
      return false;
    } finally {
      if (same(captured)) setSaving(false);
    }
  };
  const save = async (definition: TemplateDefinition) => {
    if (saving || !canManage || session.status !== "ready") return false;
    const captured = {
      actor: session.actor.identity.key,
      session: session.stamp,
      target: activeTarget.current,
    };
    setSaving(true);
    try {
      const draft = await rpc.call("saveDraft", {
        definition: definitionSchema.parse(
          JSON.parse(JSON.stringify(definition)),
        ),
        expectedGeneration: generationRef.current,
      });
      const live = client.currentSession();
      if (
        !same({
          actor: captured.actor,
          stamp: captured.session,
          target: captured.target,
        })
      )
        return false;
      generationRef.current = draft.generation;
      setGeneration(draft.generation);
      recoverWrite("save");
      catalog.refresh();
      return { generation: generationRef.current! };
    } catch (e) {
      if (
        same({
          actor: captured.actor,
          stamp: captured.session,
          target: captured.target,
        })
      )
        failWrite("save", e);
      return false;
    } finally {
      if (
        same({
          actor: captured.actor,
          stamp: captured.session,
          target: captured.target,
        })
      )
        setSaving(false);
    }
  };
  const publish = async (definition: TemplateDefinition) => {
    if (session.status !== "ready") return false;
    const captured = {
      actor: session.actor.identity.key,
      session: session.stamp,
      target: activeTarget.current,
    };
    if (!(await save(definition))) return false;
    const live = client.currentSession();
    if (
      !live.ok ||
      live.value.status !== "ready" ||
      live.value.actor.identity.key !== captured.actor ||
      live.value.stamp !== captured.session ||
      !active.current
    )
      return false;
    setSaving(true);
    try {
      const result = await rpc.call("publish", {
        templateId: definition.id,
        expectedGeneration: generationRef.current!,
      });
      if (
        !active.current ||
        !same({
          actor: captured.actor,
          stamp: captured.session,
          target: captured.target,
        })
      )
        return false;
      if (result.issues.length) {
        failWrite(
          "publish",
          result.issues.map((i) => `${i.path}: ${i.message}`).join("\n"),
        );
        return false;
      }
      recoverWrite("publish");
      setSelected(result.entry);
      catalog.refresh();
      return { generation: generationRef.current! };
    } catch (e) {
      if (
        same({
          actor: captured.actor,
          stamp: captured.session,
          target: captured.target,
        })
      )
        failWrite("publish", e);
      return false;
    } finally {
      if (
        same({
          actor: captured.actor,
          stamp: captured.session,
          target: captured.target,
        })
      )
        setSaving(false);
    }
  };
  const duplicate = async (entry: TemplateEntry) => {
    const captured = capture();
    if (!captured || saving) return;
    setSaving(true);
    try {
      const draft = await rpc.call("duplicate", {
        templateId: entry.id,
        newId: crypto.randomUUID(),
      });
      if (!same(captured)) return;
      select({
        id: draft.templateId,
        draft,
        published: null,
        latestRevision: 0,
      });
      catalog.refresh();
    } catch (e) {
      if (same(captured)) failWrite("duplicate", e);
    } finally {
      if (same(captured)) setSaving(false);
    }
  };
  const unpublish = async (entry: TemplateEntry) => {
    const captured = capture();
    if (!entry.published || !captured || saving) return;
    setSaving(true);
    try {
      await rpc.call("unpublish", {
        templateId: entry.id,
        expectedRevision: entry.published.revision,
      });
      if (same(captured)) {
        recoverWrite("unpublish");
        catalog.refresh();
      }
    } catch (e) {
      if (same(captured)) failWrite("unpublish", e);
    } finally {
      if (same(captured)) setSaving(false);
    }
  };
  return (
    <div
      className={`ntt ${surface === "settings" ? "ntt-settings" : "ntt-panel"}`}
      role="region"
      aria-label="Templates workspace"
      tabIndex={0}
    >
      <main className="ntt-management ntt-stack">
        {catalog.error && (
          <div className="ntt-alert" role="alert">
            Templates could not refresh: {catalog.error}
            {catalog.value && " Showing the last available definitions."}
          </div>
        )}
        {context.error && (
          <div className="ntt-alert" role="alert">
            Destination catalog could not refresh: {context.error}
          </div>
        )}
        {history ? (
          <RecentLaunches onBack={() => setHistory(false)} />
        ) : initial && canManage ? (
          <TemplateEditor
            key={`${initial.id}:${owner}`}
            initial={initial}
            checkpointOwner={
              session.status === "ready"
                ? `${session.instanceId}:${session.actor.identity.key}`
                : ""
            }
            checkpointGeneration={generation}
            restored={restored}
            onRestoreGeneration={(value) => {
              generationRef.current = value;
              setGeneration(value);
            }}
            publishedRevision={selected?.published?.revision ?? 0}
            saving={saving}
            error={error}
            onBack={() => {
              setInitial(null);
              setSelected(null);
              setRouteError(null);
              if (subPath.startsWith("compose/")) {
                if (
                  subPath.startsWith("compose/edit/") &&
                  checkpointOwner &&
                  initial
                )
                  armFormReturn(checkpointOwner, initial.id);
                navigate.toCompose();
              } else if (subPath)
                navigate.toPluginPanel("templates", { replace: true });
            }}
            onRemove={remove}
            navigationRequest={navigationRequest}
            onSave={save}
            onPublish={publish}
            renderDestination={(definition, change) => (
              <DestinationEditor
                definition={definition}
                change={change}
                context={context.value}
              />
            )}
            renderModel={(definition, change) => {
              const d = definition.destination;
              const projectId =
                d.kind === "existing-project" ? d.projectId : previewProject;
              const project = context.value?.projects.find(
                (p) => p.id === projectId,
              );
              const env =
                d.environment.kind === "reuse"
                  ? context.value?.environments.find(
                      (e) =>
                        e.id ===
                        (d.environment.kind === "reuse"
                          ? d.environment.environmentId
                          : ""),
                    )
                  : null;
              const hostId =
                d.kind === "new-project"
                  ? d.hostId
                  : d.hostId
                    ? d.hostId
                    : d.environment.kind === "project-default"
                      ? context.value?.primaryHostId
                      : (d.hostId ??
                        project?.sources.find((s) => s.isDefault)?.hostId ??
                        project?.sources[0]?.hostId);
              const routing:
                | ExperimentalProviderModelPickerRouting
                | undefined = env
                ? { kind: "environment", environmentId: env.id }
                : hostId
                  ? { kind: "host", hostId }
                  : undefined;
              return (
                <div className="ntt-stack">
                  {d.kind === "choose-at-launch" && context.value && (
                    <>
                      <ProjectSelect
                        context={context.value}
                        value={previewProject}
                        onChange={setPreviewProject}
                        label="Preview destination project"
                      />
                      <p className="ntt-help">
                        Used to browse this project’s available models. The
                        launcher checks the actual destination again.
                      </p>
                    </>
                  )}
                  <ModelEditor
                    definition={definition}
                    change={change}
                    effects={null}
                    routing={routing}
                  />
                </div>
              );
            }}
          />
        ) : (
          <>
            <div className="ntt-row ntt-between">
              {surface !== "settings" && (
                <button
                  type="button"
                  className="ntt-link"
                  onClick={() => navigate.toCompose()}
                >
                  ‹ New thread
                </button>
              )}
              <div className="ntt-row">
                <button
                  type="button"
                  className="ntt-link"
                  disabled={!canManage}
                  onClick={() => setHistory(true)}
                >
                  History
                </button>
                <button
                  type="button"
                  className="ntt-button ntt-primary"
                  disabled={!canManage}
                  onClick={newTemplate}
                >
                  + New template
                </button>
              </div>
            </div>
            {routeError && (
              <p className="ntt-alert" role="alert">
                {routeError}
              </p>
            )}
            {error && (
              <div className="ntt-alert" role="alert">
                {error}
              </div>
            )}
            {recoveries.error && (
              <p className="ntt-alert" role="alert">
                {recoveries.error}
              </p>
            )}
            {canManage && recoveries.items.length > 0 && (
              <section
                aria-label="Unfinished local templates"
                className="ntt-surface ntt-stack"
              >
                <h3>Unfinished local templates</h3>
                {recoveries.items.map((item) => (
                  <div className="ntt-row ntt-between" key={item.id}>
                    <span>
                      {item.checkpoint.definition.name || "Untitled template"}
                    </span>
                    <div className="ntt-row">
                      <button
                        type="button"
                        className="ntt-button"
                        onClick={() => {
                          setSelected(
                            entries.find((e) => e.id === item.id) ?? null,
                          );
                          setInitial(item.checkpoint.definition);
                          setRestored(item.checkpoint);
                          generationRef.current = item.checkpoint.generation;
                          setGeneration(item.checkpoint.generation);
                          setError(null);
                        }}
                      >
                        Resume unfinished template
                      </button>
                      <button
                        type="button"
                        className="ntt-link"
                        onClick={() => {
                          const problem = removeEditorCheckpoint(
                            checkpointOwner,
                            item.checkpoint.definition,
                            item.checkpoint.numericText,
                          );
                          setRecoveries(listEditorCheckpoints(checkpointOwner));
                          if (problem) setError(problem);
                        }}
                      >
                        Discard local edits
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}
            {catalog.loading && !catalog.value ? (
              <p role="status">Loading templates…</p>
            ) : (
              <div>
                {entries.map((entry) => {
                  const def =
                    entry.draft?.definition ?? entry.published?.definition;
                  if (!def) return null;
                  return (
                    <div
                      className="ntt-row ntt-between ntt-list-row"
                      key={entry.id}
                    >
                      <div>
                        <h3 className="ntt-list-name">
                          <TemplatePurposeIcon templateId={def.id} />
                          {def.name || "Untitled template"}
                        </h3>
                        <p className="ntt-help">
                          {entry.published
                            ? `Published · revision ${entry.published.revision}`
                            : "Draft · configure before publishing"}
                          {entry.draft
                            ? ` · edited by ${entry.draft.editedBy.name}`
                            : ""}
                        </p>
                        <p className="ntt-muted ntt-small">{def.description}</p>
                      </div>
                      <div className="ntt-row">
                        <button
                          type="button"
                          className="ntt-button"
                          disabled={!canManage}
                          onClick={() => select(entry)}
                        >
                          {entry.published ? "Edit" : "Configure"}
                        </button>
                        <button
                          type="button"
                          className="ntt-button"
                          disabled={saving || !canManage}
                          onClick={() => void duplicate(entry)}
                        >
                          Duplicate
                        </button>
                        {entry.published && (
                          <button
                            type="button"
                            className="ntt-link"
                            disabled={saving || !canManage}
                            onClick={() => void unpublish(entry)}
                          >
                            Unpublish
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {!entries.length && (
                  <p className="ntt-muted">Create your first template.</p>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
