import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRpc,
  useSdk,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState } from "react";
import { panelPath, panelScope } from "./ui/route.ts";
import { Panel } from "./ui/panel.tsx";
import type { Draft, Snapshot } from "./ui/types.ts";
import { contract, snapshotSchema } from "./suite-rpc-contract.ts";
import "./app.css";
export default definePluginApp((app) => {
  const drafts = new Map<string, Draft>();
  function MessageRules({ subPath }: PluginNavPanelProps) {
    const rpc = useRpc<typeof contract>(),
      sdk = useSdk(),
      context = useBbContext(),
      navigate = useBbNavigate(),
      connection = useRealtimeConnectionState();
    const [projects, setProjects] = useState<{ id: string; name: string }[]>(
        [],
      ),
      [signal, setSignal] = useState({ revision: 0, discoverFiles: true }),
      [error, setError] = useState<string | null>(null);
    const route = panelScope(subPath, context.projectId),
      projectId = route.projectId;
    const chooseProject = (id: string) =>
      navigate.toPluginPanel("rules", { subPath: panelPath(id || null) });
    const choosePath = (path: string) =>
      navigate.toPluginPanel("rules", { subPath: panelPath(projectId, path) });
    const live = useRef(true),
      previousConnection = useRef(connection);
    useEffect(() => {
      live.current = true;
      void sdk.projects.list().then(
        (p) => {
          if (live.current) {
            setProjects(p);
            setError(null);
          }
        },
        (e) => {
          if (live.current) setError(String(e));
        },
      );
      return () => {
        live.current = false;
      };
    }, [sdk, connection]);
    useRealtime("changed", (event: unknown) => {
      if (!event || typeof event !== "object") return;
      if ("projectId" in event && event.projectId !== projectId) return;
      setSignal((x) => ({
        revision: x.revision + 1,
        discoverFiles: "discoverFiles" in event && event.discoverFiles === true,
      }));
    });
    useEffect(() => {
      if (previousConnection.current === connection) return;
      previousConnection.current = connection;
      setSignal((x) => ({ revision: x.revision + 1, discoverFiles: true }));
    }, [connection]);
    const client = useMemo(
      () => ({
        async call(method: string, input: unknown) {
          const result = await rpc.call(
            method as keyof typeof contract,
            input as never,
          );
          return snapshotSchema.parse(result);
        },
      }),
      [rpc],
    );
    return (
      <>
        {error && <p role="alert">{error}</p>}
        <Panel
          client={client}
          projectId={projectId}
          projects={projects}
          selectProject={chooseProject}
          subPath={route.path}
          navigate={choosePath}
          refreshSignal={signal.revision}
          discoverFiles={signal.discoverFiles}
          drafts={drafts}
        />
      </>
    );
  }
  app.slots.navPanel({
    id: "rules",
    title: "Message Rules",
    path: "rules",
    icon: "message-circle",
    component: MessageRules,
  });
  app.slots.settingsSection({
    id: "connection",
    title: "Message Rules",
    component: () => (
      <p>
        Set the Message Rules JEV API key in this plugin’s settings. Open
        Message Rules to select a project, host, test directory, model, and run
        limits. Tests use saved revisions. Explicit configured JEV checks can
        use provider context checking when a verified local counter is
        unavailable; engineering/call limits and no implicit retry still apply.
      </p>
    ),
  });
});
