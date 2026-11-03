import "./app.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import type { templatesContract } from "./rpc-contract.ts";
import { TEMPLATES_CATALOG_CHANGED } from "./events.ts";
import { inputDraftResource, type PublishedRevision } from "./model.ts";
import { browserDrafts } from "./ui/drafts.ts";
import type { DraftStorage } from "@phosphorco/bb-identity/state";
import type { PersonalDraft } from "./model.ts";
import { TemplatesIcon, TemplatePurposeIcon } from "./ui/icon.tsx";
import { galleryCache } from "./ui/gallery-cache.ts";
import { useMountedRead, type MountedReadContext } from "./ui/read.ts";
import {
  rememberFormReturn,
  takeFormReturn,
  armFormReturn,
} from "./ui/return.ts";
import { mountMobileTemplates } from "./ui/mobile-home.ts";
import { DeferredScreen, templateScreens } from "./ui/deferred-screen.tsx";

function TemplateGallery({
  projectId,
  drafts,
}: PluginHomepageSectionProps & { drafts: DraftStorage<PersonalDraft> }) {
  const rpc = useRpc<typeof templatesContract>(),
    navigate = useBbNavigate(),
    session = useIdentitySession();
  const liveSession = useRef(session);
  liveSession.current = session;
  const origin = window.location.origin;
  const load = useCallback(
    async (read: MountedReadContext) => {
      // Metadata ticket precedes dispatch, even before the first public instance fact.
      const ticket = galleryCache.beginRequest(origin);
      if (!read.isCurrent()) throw new Error("Templates read was superseded.");
      const value = await rpc.call("publishedCatalog", {});
      const live = liveSession.current;
      if (live.status === "ready" && live.instanceId !== value.instanceId)
        throw new Error(
          "Templates belongs to a different instance. Reconnect to refresh it.",
        );
      return galleryCache.accept(
        ticket(value.instanceId),
        value,
        read.isCurrent,
      );
    },
    [rpc, origin],
  );
  const instanceId = session.status === "ready" ? session.instanceId : null;
  const catalog = useMountedRead(
    load,
    TEMPLATES_CATALOG_CHANGED,
    instanceId ? galleryCache.readMemory({ origin, instanceId }) : null,
  );
  const previousInstance = useRef(instanceId);
  useEffect(() => {
    const previous = previousInstance.current;
    previousInstance.current = instanceId;
    if (
      instanceId &&
      ((previous && previous !== instanceId) ||
        (catalog.value && catalog.value.instanceId !== instanceId))
    )
      catalog.refresh();
  }, [instanceId, catalog.value, catalog.refresh]);
  useLayoutEffect(() => {
    if (!instanceId) return;
    catalog.seed(galleryCache.readMemory({ origin, instanceId }));
  }, [instanceId, origin, catalog.seed]);
  const currentCatalog =
    instanceId && catalog.value?.instanceId === instanceId
      ? catalog.value
      : null;
  const verified = !!instanceId && !!currentCatalog && catalog.fresh;
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
      !currentCatalog ||
      !verified ||
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
    const live = currentCatalog.revisions.find(
      (revision) => revision.templateId === restored.revision.templateId,
    );
    if (!live) {
      setReturnError(
        "The edited template is no longer published. Your inputs remain saved; choose another template or open Manage.",
      );
      return;
    }
    setSelected(restored.revision);
    setReturnProject(restored.projectId);
  }, [returnOwner, currentCatalog, verified]);
  const lastCard = useRef<HTMLButtonElement | null>(null);
  const lastCardId = useRef<string | null>(null);
  const entries = currentCatalog?.revisions ?? [];
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
          {currentCatalog && " Showing the last available templates."}
          <button type="button" className="ntt-link" onClick={catalog.refresh}>
            Retry templates
          </button>
        </div>
      )}
      {returnError && (
        <p className="ntt-alert" role="alert">
          {returnError}
        </p>
      )}
      {selected ? (
        <DeferredScreen
          key={`${returnOwner}:${selected.templateId}:${selected.revision}`}
          load={templateScreens.run}
          heading={selected.definition.name}
          selected
          onReload={() => {
            if (!returnOwner) return;
            const problem = rememberFormReturn(
              returnOwner,
              selected,
              returnProject === undefined ? projectId : returnProject,
            );
            setReturnError(problem);
            if (problem) return;
            const armProblem = armFormReturn(returnOwner, selected.templateId);
            setReturnError(armProblem);
            if (armProblem) return;
            window.location.reload();
          }}
          onBack={() => {
            setSelected(null);
            setReturnProject(undefined);
            requestAnimationFrame(() => lastCard.current?.focus());
          }}
          screenProps={{
            template: selected,
            projectId: returnProject === undefined ? projectId : returnProject,
            drafts,
            onEdit: () => {
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
            },
            onBack: () => {
              setSelected(null);
              setReturnProject(undefined);
              requestAnimationFrame(() => lastCard.current?.focus());
            },
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
          {!verified && entries.length > 0 && (
            <p className="ntt-help" role="status">
              Checking templates…
            </p>
          )}
          {catalog.loading && !currentCatalog ? (
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
                  disabled={!verified}
                  onClick={(e) => {
                    if (!verified || !catalog.isFresh()) return;
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
        <DeferredManagement {...props} />
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
        <DeferredManagement subPath="" surface="settings" />
      </BbIdentity.Context>
    </BbIdentity.Provider>
  );
}
function DeferredManagement(
  props: PluginNavPanelProps & { surface?: "panel" | "settings" },
) {
  const navigate = useBbNavigate(),
    session = useIdentitySession();
  const owner =
    session.status === "ready"
      ? `${session.instanceId}:${session.actor.identity.key}`
      : "";
  return (
    <DeferredScreen
      key={owner}
      load={templateScreens.management}
      screenProps={props}
      heading="Templates"
      settings={props.surface === "settings"}
      onBack={() => {
        if (owner && props.subPath.startsWith("compose/edit/")) {
          try {
            armFormReturn(
              owner,
              decodeURIComponent(props.subPath.slice("compose/edit/".length)),
            );
          } catch {
            /* Return to chooser for malformed routes. */
          }
        }
        navigate.toCompose();
      }}
    />
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
