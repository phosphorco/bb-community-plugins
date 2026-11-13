import { useBbNavigate, useRpc, useSdk, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState } from "react";
import { panelPath, panelScope } from "./route.ts";
import { Panel } from "./panel.tsx";
import type { Draft, LookupState } from "./types.ts";
import { contract, snapshotSchema } from "../suite-rpc-contract.ts";
import { recentDecisionsSchema, type RecentDecisionsInput } from "../admission/decisions-contract.ts";

export type MessageRulesBodyProps = PluginNavPanelProps & { drafts: Map<string, Draft> };

export function MessageRulesBody({ subPath, drafts }: MessageRulesBodyProps) {
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
      async listRecentDecisions(input: RecentDecisionsInput) {
        return recentDecisionsSchema.parse(await rpc.call("listRecentDecisions", input));
      },
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
