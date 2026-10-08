import "./app.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { SettingsSnapshot, Source } from "./contract.ts";
import type { rpcContract } from "./rpc-contract.ts";

export function FigmaSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const id = useId();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncDisclosure, setSyncDisclosure] = useState<{ file: string; freshness: string | null } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [readToken, setReadToken] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [draft, setDraft] = useState<{ binaryPath?: string; mirrorEnabled?: boolean; clientId?: string; redirectUri?: string }>({});
  const [file, setFile] = useState("");
  const [acceptUnverified, setAcceptUnverified] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const reading = useRef(false);
  const queued = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    if (mutation.current || reading.current) { queued.current = true; return; }
    reading.current = true;
    setLoading(true);
    const epoch = generation.current;
    try {
      const next = await rpc.call("status", null);
      if (mounted.current && epoch === generation.current) {
        setSnapshot(next);
        setError(null);
        if (next.official.phase !== "authorizing") setAuthorizationUrl(null);
      }
    } catch {
      if (mounted.current && epoch === generation.current) setError("Could not refresh Figma status. Retry to check the connection.");
    } finally {
      reading.current = false;
      if (mounted.current && epoch === generation.current) setLoading(false);
      if (mounted.current && queued.current && !mutation.current) {
        queued.current = false;
        void refresh();
      }
    }
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      generation.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  useRealtime("figma", useCallback(() => { void refresh(); }, [refresh]));

  const run = async (label: string, action: () => Promise<void>) => {
    if (mutation.current || !mounted.current) return;
    mutation.current = true;
    const epoch = ++generation.current;
    setBusy(label);
    setError(null);
    setActionError(null);
    setFeedback(null);
    try { await action(); }
    catch {
      if (mounted.current && generation.current === epoch) setActionError(`${label} failed. Retry this action; refreshing status does not repeat it.`);
    } finally {
      mutation.current = false;
      if (mounted.current && generation.current === epoch) {
        setBusy(null);
        setLoading(false);
      }
      if (mounted.current && queued.current) { queued.current = false; void refresh(); }
    }
  };
  // Mutation results can only update this mounted lifetime, never a later remount.
  const accept = (next: SettingsSnapshot, epoch: number) => {
    if (mounted.current && generation.current === epoch) setSnapshot(next);
  };
  const save = () => run("Save settings", async () => {
    const epoch = generation.current;
    const next = await rpc.call("configure", {
      ...draft,
      ...(readToken === "" ? {} : { readToken }),
      ...(clientSecret === "" ? {} : { clientSecret }),
    });
    if (!mounted.current || generation.current !== epoch) return;
    accept(next, epoch);
    setReadToken(""); setClientSecret(""); setDraft({}); setAuthorizationUrl(null);
    setSyncDisclosure(null);
    setAcceptUnverified(false);
    setFeedback("Settings saved. Test the read connection or connect Figma to verify access.");
  });
  const sourceAction = (method: "disconnect" | "testConnection" | "refreshTools", source: Source, label: string) => run(label, async () => {
    const epoch = generation.current;
    const next = method === "testConnection"
      ? await rpc.call(method, { source, ...(file.trim() ? { file: file.trim() } : {}) })
      : await rpc.call(method, { source });
    accept(next, epoch);
    if (!mounted.current || generation.current !== epoch) return;
    if (method === "disconnect") {
      if (source === "official") { setAuthorizationUrl(null); setClientSecret(""); }
      else { setReadToken(""); setSyncDisclosure(null); setAcceptUnverified(false); }
    }
    if (method === "testConnection" && next[source].phase === "error") {
      setActionError(`${label} did not verify access.${next[source].detail ? ` ${next[source].detail}` : ""}`);
      return;
    }
    setFeedback(`${label} completed. Connection status is shown below.`);
  });
  const syncReadCache = () => run("Sync read cache", async () => {
    const epoch = generation.current;
    const target = file.trim();
    setSyncDisclosure(null);
    const result = await rpc.call("syncMirror", { file: target, acceptUnverified });
    if (!mounted.current || generation.current !== epoch) return;
    setAcceptUnverified(false);
    const meta = result._meta;
    const freshness = meta && typeof meta === "object" && "bbFigmaFreshness" in meta
      ? meta.bbFigmaFreshness : null;
    let disclosure: string | null = null;
    if (freshness && typeof freshness === "object") {
      const sentences: string[] = [];
      if ("state" in freshness && freshness.state === "rebaselined") sentences.push("The read cache now has a new version baseline.");
      if ("mutationVisibilityVerified" in freshness && freshness.mutationVisibilityVerified === false) sentences.push("Visibility of the earlier edit is unverified.");
      if ("detail" in freshness && typeof freshness.detail === "string") sentences.push(freshness.detail);
      if (sentences.length) disclosure = sentences.join(" ");
    }
    setSyncDisclosure({ file: target, freshness: disclosure });
    if (result.isError === true) setActionError("Sync read cache reported an error. Cache freshness has not been verified. Retry the sync.");
    else setFeedback("Read cache sync returned. Review its freshness disclosure below.");
    queued.current = true;
  });
  const connect = () => run("Connect Figma", async () => {
    const epoch = generation.current;
    setAuthorizationUrl(null);
    const result = await rpc.call("connectOfficial", null);
    const url = new URL(result.authorizationUrl);
    if (url.protocol !== "https:") throw new Error("Invalid authorization URL");
    if (!mounted.current || generation.current !== epoch) return;
    setAuthorizationUrl(url.href);
    setFeedback("Open the authorization link to finish connecting, then return here.");
    queued.current = true;
  });

  const cacheEnabled = draft.mirrorEnabled ?? snapshot?.config.mirrorEnabled ?? false;
  const cacheReady = !!(snapshot?.config.mirrorEnabled && snapshot.config.binaryAvailable && snapshot.config.tokenConfigured);
  return <div className="figma-settings" aria-busy={loading || busy !== null}>
    <p className="figma-muted">Connections are shared across this BB deployment. Saving or disconnecting affects everyone using these Figma tools.</p>
    <p>The official Figma MCP connection provides reads and writes. No local figmog installation is required for it; Figma authorization is still required.</p>
    {loading && <p role="status">Loading Figma settings…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy !== null} onClick={() => void refresh()}>Retry status</button></div>}
    {actionError && <p role="alert">{actionError}</p>}
    {feedback && <p role="status">{feedback}</p>}
    {busy && <p role="status">{busy}…</p>}
    {snapshot && <>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy !== null}>
          <legend>Optional figmog cache</legend>
          <label className="figma-checkbox" htmlFor={`${id}-cache-enabled`}>
            <input id={`${id}-cache-enabled`} type="checkbox" checked={cacheEnabled} onChange={(event) => setDraft(current => ({ ...current, mirrorEnabled: event.target.checked }))} />
            Use figmog for cached reads
          </label>
          <p className="figma-muted">{snapshot.config.binaryAvailable ? "figmog is available on the BB host." : "figmog was not found on the BB host. You can continue with official Figma MCP."} Re-enabling the cache starts a fresh mirror. Your saved read token is retained when the cache is turned off.</p>
          {!snapshot.config.binaryAvailable && <p><a href="https://github.com/sanctuarycomputer/figmog#install" target="_blank" rel="noopener noreferrer">Optional figmog installation instructions</a>. Automatic installation is not available yet. Install it on the BB host, then refresh status.</p>}
          <label htmlFor={`${id}-token`}>Replace Figma read token</label>
          <input id={`${id}-token`} type="password" disabled={!cacheEnabled} autoComplete="new-password" maxLength={16384} value={readToken} onChange={(e) => setReadToken(e.target.value)} aria-describedby={`${id}-token-help`} />
          <p id={`${id}-token-help`} className="figma-muted">{snapshot.config.tokenConfigured ? "A token is configured." : "No token is configured."} Leave blank to keep the current token. Disconnect read removes it.</p>
          <details>
            <summary>Advanced configuration</summary>
            <label htmlFor={`${id}-binary`}>figmog executable path</label>
            <input id={`${id}-binary`} maxLength={4096} value={draft.binaryPath ?? snapshot.config.binaryPath} onChange={(e) => setDraft((current) => ({ ...current, binaryPath: e.target.value }))} />
            <p className="figma-muted">For the optional cache, use “figmog” to detect it on the BB host's PATH, or enter its absolute executable path. No installation on your browser's computer is needed.</p>
            <p className="figma-muted">Official Figma access requires your own registered OAuth client and Figma admission. Configure its client ID, secret and registered callback URL before connecting. A saved configuration does not prove access.</p>
            <label htmlFor={`${id}-client`}>Figma OAuth client ID</label>
            <input id={`${id}-client`} maxLength={4096} value={draft.clientId ?? snapshot.config.clientId} onChange={(e) => setDraft((current) => ({ ...current, clientId: e.target.value }))} />
            <label htmlFor={`${id}-secret`}>Replace Figma OAuth client secret</label>
            <input id={`${id}-secret`} type="password" autoComplete="new-password" maxLength={16384} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} aria-describedby={`${id}-secret-help`} />
            <p id={`${id}-secret-help`} className="figma-muted">{snapshot.config.clientSecretConfigured ? "A client secret is configured." : "No client secret is configured."} Leave blank to keep it. Disconnect Figma removes the authorization session; the saved client configuration is retained.</p>
            <label htmlFor={`${id}-redirect`}>Registered OAuth redirect URL</label>
            <input id={`${id}-redirect`} type="url" maxLength={8192} value={draft.redirectUri ?? snapshot.config.redirectUri} onChange={(e) => setDraft((current) => ({ ...current, redirectUri: e.target.value }))} />
          </details>
          <button type="submit" className="figma-primary" disabled={Object.keys(draft).length === 0 && !readToken && !clientSecret}>Save settings</button>
        </fieldset>
      </form>
      <div className="figma-actions">
        <button type="button" disabled={busy !== null} onClick={() => void connect()}>Connect Figma</button>
        <button type="button" disabled={busy !== null} onClick={() => void refresh()}>Refresh status</button>
      </div>
      {authorizationUrl && <p><a href={authorizationUrl} target="_blank" rel="noopener noreferrer">Authorize Figma in a new tab</a></p>}
      <label htmlFor={`${id}-file`}>Figma file URL for connection test</label>
      <input id={`${id}-file`} type="url" value={file} disabled={busy !== null} onChange={(e) => { setFile(e.target.value); setAcceptUnverified(false); setSyncDisclosure(null); }} placeholder="https://www.figma.com/design/…" />
      <p className="figma-muted">Provide a file URL to check read access. Testing does not edit your file.</p>
      {cacheReady && <><label className="figma-checkbox" htmlFor={`${id}-accept-unverified`}>
        <input id={`${id}-accept-unverified`} type="checkbox" checked={acceptUnverified} disabled={busy !== null} onChange={(e) => setAcceptUnverified(e.target.checked)} aria-describedby={`${id}-sync-help`} />
        Accept refreshed cache without verifying the prior edit
      </label>
      <button type="button" disabled={busy !== null || !file.trim()} onClick={() => void syncReadCache()}>Sync read cache</button>
      <p id={`${id}-sync-help`} className="figma-muted">Leave this unchecked to require verification of a pending edit. Accepting an unverified refresh makes the read cache usable again, but does not prove that the earlier edit is visible.</p>
      </>}
      {syncDisclosure && <div role="status">
        <p>Read cache sync response for {syncDisclosure.file}</p>
        <p>A cache pull alone does not verify that a prior edit is visible.</p>
        {syncDisclosure.freshness !== null
          ? <p>{syncDisclosure.freshness}</p>
          : <p>No freshness disclosure was returned. Prior edit visibility is unverified.</p>}
      </div>}
      {(["official", "mirror"] as const).map((source) => {
        const title = source === "mirror" ? "Read" : "Figma";
        const connection = snapshot[source];
        return <section key={source} aria-labelledby={`${id}-${source}`}>
          <h3 id={`${id}-${source}`}>{source === "mirror" ? "Optional cache connection" : "Official Figma connection"}</h3>
          <p>Status: {connection.phase}{connection.serverVersion ? ` · Server ${connection.serverVersion}` : ""}</p>
          {connection.detail && <p className="figma-muted">{connection.detail}</p>}
          {source === "official" && <p className="figma-muted">After a BB restart, Test Figma resumes saved authorization; Connect Figma starts a new sign-in.</p>}
          <div className="figma-actions">
            <button type="button" disabled={busy !== null || (source === "mirror" && (!cacheReady || !file.trim()))} onClick={() => void sourceAction("testConnection", source, `Test ${title.toLowerCase()}`)}>Test {title.toLowerCase()}</button>
            <button type="button" disabled={busy !== null || (source === "mirror" && !cacheReady)} onClick={() => void sourceAction("refreshTools", source, `Refresh ${title.toLowerCase()} tools`)}>Refresh {title.toLowerCase()} tools</button>
            <button type="button" disabled={busy !== null} onClick={() => void sourceAction("disconnect", source, `Disconnect ${title.toLowerCase()}`)}>Disconnect {title.toLowerCase()}</button>
          </div>
          <details><summary>Available tools ({snapshot.tools[source].length})</summary>
            {snapshot.tools[source].length === 0 ? <p className="figma-muted">No tools discovered. Connect and refresh tools to check availability.</p> : <ul>{snapshot.tools[source].map((tool) => <li key={tool.name}><code>{tool.name}</code>{tool.description && <p className="figma-muted">{tool.description}</p>}</li>)}</ul>}
          </details>
        </section>;
      })}
      {snapshot.aliasesNeedReload && <p className="figma-muted">Tool shortcuts need a plugin reload. The generic Figma tools can use the current inventory.</p>}
    </>}
  </div>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "figma-connections", title: "Figma connections", description: "Manage shared read access and official Figma authorization.", component: FigmaSettings });
});
