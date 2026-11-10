import {
  definePluginApp,
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
import type { Draft, Snapshot, LookupState } from "./ui/types.ts";
import { contract, snapshotSchema } from "./suite-rpc-contract.ts";
import "./app.css";
export default definePluginApp((app) => {
  const drafts = new Map<string, Draft>();
  function MessageRules({ subPath }: PluginNavPanelProps) {
    const rpc = useRpc<typeof contract>(),
      sdk = useSdk(),
      navigate = useBbNavigate(),
      connection = useRealtimeConnectionState();
    const [projects, setProjects] = useState<{ id: string; name: string }[]>(
        [],
      ),
      [signal, setSignal] = useState({ revision: 0, discoverFiles: true }),
      [error, setError] = useState<string | null>(null),
      [projectRetry, setProjectRetry] = useState(0),
      [projectLookup, setProjectLookup] = useState<LookupState>({
        status: "loading",
      });
    const route = panelScope(subPath, null),
      projectId = route.projectId;
    const choosePath = (path: string) =>
      navigate.toPluginPanel("rules", { subPath: panelPath(projectId, path) });
    const previousConnection = useRef(connection);
    useEffect(() => {
      let current = true;
      setProjectLookup({ status: "loading" });
      void sdk.projects.list().then(
        (p) => {
          if (current) {
            setProjects(p);
            setError(null);
            setProjectLookup({ status: "ready" });
          }
        },
        (e) => {
          if (current) {
            setError(String(e));
            setProjectLookup({ status: "error", message: String(e) });
          }
        },
      );
      return () => {
        current = false;
      };
    }, [sdk, connection, projectRetry]);
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
        {error && <p role="alert">Project list unavailable: {error}{" "}
          <button disabled={projectLookup.status === "loading"}
            onClick={() => setProjectRetry((n) => n + 1)}>Retry project list</button>
        </p>}
        <Panel
          client={client}
          projectId={projectId}
          legacyProjectId={route.legacyProjectId}
          projects={projects}
          projectLookup={projectLookup}
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
        Message Rules to manage shared groups, host directories, model, and run
        limits. Tests use saved revisions. Explicit configured JEV checks can
        use provider context checking when a verified local counter is
        unavailable; engineering/call limits and no implicit retry still apply.
      </p>
    ),
  });
});
