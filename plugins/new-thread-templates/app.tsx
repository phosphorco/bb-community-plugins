import "./app.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type PluginHomepageSectionProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  BbIdentity,
  useBbIdentityClient,
  useIdentitySession,
} from "@phosphorco/bb-identity/react";
import { templatesContract, TEMPLATES_CHANGED } from "./rpc-contract.ts";
import { inputDraftResource, type PublishedRevision } from "./model.ts";
import { browserDrafts } from "./ui/drafts.ts";
import type { DraftStorage } from "@phosphorco/bb-identity/state";
import type { PersonalDraft } from "./model.ts";
import { TemplatesIcon, TemplatePurposeIcon } from "./ui/icon.tsx";
import { useMountedRead } from "./ui/read.ts";
import { TemplateRun } from "./ui/run.tsx";
import { rememberFormReturn, takeFormReturn } from "./ui/return.ts";
import { mountMobileTemplates } from "./ui/mobile-home.ts";
import { Management } from "./ui/management.tsx";

function TemplateGallery({
  projectId,
  drafts,
}: PluginHomepageSectionProps & { drafts: DraftStorage<PersonalDraft> }) {
  const rpc = useRpc<typeof templatesContract>(),
    navigate = useBbNavigate(),
    session = useIdentitySession();
  const load = useCallback(() => rpc.call("catalog", {}), [rpc]);
  const catalog = useMountedRead(load, TEMPLATES_CHANGED);
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState<PublishedRevision | null>(null);
  const [returnProject, setReturnProject] = useState<string | null | undefined>(
    undefined,
  );
  const [returnError, setReturnError] = useState<string | null>(null);
  const admittedReturn = useRef<string | null>(null);
  const returnOwner =
    session.status === "ready"
      ? `${session.instanceId}:${session.actor.identity.key}`
      : null;
  useEffect(() => {
    if (
      !returnOwner ||
      !catalog.value ||
      admittedReturn.current === returnOwner
    )
      return;
    const changedOwner =
      admittedReturn.current !== null && admittedReturn.current !== returnOwner;
    admittedReturn.current = returnOwner;
    if (changedOwner) {
      // The public template may stay selected; the binding replaces personal
      // work for the new actor. Never carry the old navigation project over.
      setReturnProject(undefined);
      setReturnError(null);
    }
    const restored = takeFormReturn(returnOwner);
    if (!restored) return;
    const live = catalog.value.entries.find(
      (e) => e.id === restored.revision.templateId,
    );
    if (!live?.published) {
      setReturnError(
        "The edited template is no longer published. Your inputs remain saved; choose another template or open Manage.",
      );
      return;
    }
    setSelected(restored.revision);
    setReturnProject(restored.projectId);
  }, [returnOwner, catalog.value]);
  const lastCard = useRef<HTMLButtonElement | null>(null);
  const lastCardId = useRef<string | null>(null);
  const entries = useMemo(
    () =>
      catalog.value?.entries.flatMap((e) =>
        e.published ? [e.published] : [],
      ) ?? [],
    [catalog.value],
  );
  const matches = entries.filter((e) =>
    `${e.definition.name} ${e.definition.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div
      className="ntt ntt-stack ntt-gallery"
      data-new-thread-templates-homepage={
        session.status !== "ready"
          ? "unavailable"
          : selected
            ? "selected"
            : entries.length > 0
              ? "usable"
              : "unavailable"
      }
    >
      {catalog.error && (
        <div className="ntt-alert" role="alert">
          Templates could not refresh: {catalog.error}
          {catalog.value && " Showing the last available templates."}
        </div>
      )}
      {returnError && (
        <p className="ntt-alert" role="alert">
          {returnError}
        </p>
      )}
      {selected ? (
        <TemplateRun
          key={`${selected.templateId}:${selected.revision}`}
          template={selected}
          projectId={returnProject === undefined ? projectId : returnProject}
          drafts={drafts}
          onEdit={() => {
            if (!returnOwner) return;
            const problem = rememberFormReturn(
              returnOwner,
              selected,
              returnProject === undefined ? projectId : returnProject,
            );
            setReturnError(problem);
            if (!problem)
              navigate.toPluginPanel("templates", {
                subPath: `compose/edit/${encodeURIComponent(selected.templateId)}`,
              });
          }}
          onBack={() => {
            setSelected(null);
            setReturnProject(undefined);
            requestAnimationFrame(() => lastCard.current?.focus());
          }}
        />
      ) : (
        <>
          <div className="ntt-gallery-toolbar">
            <label className="ntt-field">
              <span className="ntt-sr">Search templates</span>
              <input
                className="ntt-input"
                type="search"
                placeholder="Search templates…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              className="ntt-link"
              type="button"
              onClick={() => navigate.toPluginPanel("templates")}
            >
              Manage
            </button>
            <button
              type="button"
              className="ntt-link"
              onClick={() =>
                navigate.toPluginPanel("templates", { subPath: "compose/new" })
              }
            >
              New template
            </button>
          </div>
          {catalog.loading && !catalog.value ? (
            <p role="status" className="ntt-muted">
              Loading templates…
            </p>
          ) : matches.length ? (
            <div className="ntt-grid">
              {matches.map((template) => (
                <button
                  key={template.templateId}
                  ref={(node) => {
                    if (node && lastCardId.current === template.templateId)
                      lastCard.current = node;
                  }}
                  type="button"
                  className="ntt-card"
                  onClick={(e) => {
                    lastCard.current = e.currentTarget;
                    lastCardId.current = template.templateId;
                    setSelected(template);
                  }}
                >
                  <TemplatePurposeIcon templateId={template.templateId} />
                  <span>
                    <strong>{template.definition.name}</strong>
                    <small>{template.definition.description}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="ntt-muted">
              {entries.length
                ? "No matching templates."
                : "No published templates yet."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
export function HomepageTemplates(props: PluginHomepageSectionProps) {
  const client = useBbIdentityClient();
  const [drafts] = useState(() =>
    browserDrafts(inputDraftResource.definition.codec),
  );
  return (
    <BbIdentity.Provider
      client={client}
      fallback={
        <p className="ntt ntt-muted" role="status">
          Loading templates…
        </p>
      }
    >
      <BbIdentity.Context pendingEdits="preserve">
        <TemplateGallery {...props} drafts={drafts} />
      </BbIdentity.Context>
    </BbIdentity.Provider>
  );
}
export function TemplatesPanel(props: PluginNavPanelProps) {
  const client = useBbIdentityClient();
  return (
    <BbIdentity.Provider
      client={client}
      fallback={
        <p className="ntt ntt-muted" role="status">
          Loading templates…
        </p>
      }
    >
      <BbIdentity.Context pendingEdits="preserve">
        <Management {...props} />
      </BbIdentity.Context>
    </BbIdentity.Provider>
  );
}
export function TemplatesSettings() {
  const client = useBbIdentityClient();
  return (
    <BbIdentity.Provider
      client={client}
      fallback={
        <p className="ntt ntt-muted" role="status">
          Loading templates…
        </p>
      }
    >
      <BbIdentity.Context pendingEdits="preserve">
        <Management subPath="" surface="settings" />
      </BbIdentity.Context>
    </BbIdentity.Provider>
  );
}
export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "mobile-home",
    mount: mountMobileTemplates,
  });
  app.experimental_icons.register({
    name: "new-thread-templates/templates",
    component: TemplatesIcon,
  });
  app.slots.homepageSection({
    id: "templates",
    title: "Templates",
    component: HomepageTemplates,
  });
  app.slots.settingsSection({
    id: "templates",
    title: "Templates",
    component: TemplatesSettings,
  });
  app.slots.navPanel({
    id: "templates",
    path: "templates",
    title: "Templates",
    icon: "new-thread-templates/templates",
    component: TemplatesPanel,
  });
});
