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
  const actionFailure = useRef<{ label: string; revision: number } | null>(null);
  const reportActionError = (label: string, message: string) => {
    actionFailure.current = { label, revision: (actionFailure.current?.revision ?? 0) + 1 };
    setActionError(message);
  };
  const [syncDisclosure, setSyncDisclosure] = useState<{ file: string; freshness: string | null } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
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
  const officialHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (feedback?.startsWith("Figma sign-in completed")) officialHeading.current?.focus();
  }, [feedback]);

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
        if (["connected", "disconnected", "unconfigured"].includes(next.official.phase)) { setAuthorizationUrl(null); setCallbackUrl(""); }
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
    const failureBefore = actionFailure.current;
    setBusy(label);
    setError(null);
    setFeedback(null);
    try {
      await action();
      if (mounted.current && generation.current === epoch && actionFailure.current === failureBefore && failureBefore?.label === label) {
        actionFailure.current = null; setActionError(null);
      }
    }
    catch {
      if (mounted.current && generation.current === epoch) reportActionError(label, label === "Connect Figma"
        ? "Connect Figma failed. Check the official connection status below for the reason. Refreshing status does not retry registration."
        : label === "Finish sign-in"
          ? "Sign-in could not complete. Check the official connection status. Correct a malformed pasted address; start Connect Figma again if the callback was consumed. If authorization was saved, use Test Figma."
          : `${label} failed. Retry this action; refreshing status does not repeat it.`);
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
    setReadToken(""); setClientSecret(""); setDraft({}); setAuthorizationUrl(null); setCallbackUrl("");
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
      if (source === "official") { setAuthorizationUrl(null); setCallbackUrl(""); setClientSecret(""); }
      else { setReadToken(""); setSyncDisclosure(null); setAcceptUnverified(false); }
    }
    if (method === "testConnection" && next[source].phase === "error") {
      reportActionError(label, `${label} did not verify access.${next[source].detail ? ` ${next[source].detail}` : ""}`);
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
    if (result.isError === true) reportActionError("Sync read cache", "Sync read cache reported an error. Cache freshness has not been verified. Retry the sync.");
    else setFeedback("Read cache sync returned. Review its freshness disclosure below.");
    queued.current = true;
  });
  const connect = () => run("Connect Figma", async () => {
    const epoch = generation.current;
    setAuthorizationUrl(null); setCallbackUrl("");
    let result: { authorizationUrl: string };
    try { result = await rpc.call("connectOfficial", null); }
    finally { queued.current = true; }
    const url = new URL(result.authorizationUrl);
    if (url.protocol !== "https:") throw new Error("Invalid authorization URL");
    if (!mounted.current || generation.current !== epoch) return;
    setAuthorizationUrl(url.href);
    setFeedback("Open the authorization link to finish connecting, then return here.");
    queued.current = true;
  });
  const finishAuthorization = () => run("Finish sign-in", async () => {
    const epoch = generation.current;
    let next: SettingsSnapshot;
    try { next = await rpc.call("finishAuthorization", { callbackUrl }); }
    finally { queued.current = true; }
    if (!mounted.current || generation.current !== epoch) return;
    accept(next, epoch);
    setCallbackUrl(""); setAuthorizationUrl(null);
    setFeedback("Figma sign-in completed. BB stores and refreshes this authorization.");
  });
  const automaticRegistration = () => run("Use automatic registration", async () => {
    const epoch = generation.current;
    const next = await rpc.call("configure", { clientId: "", clientSecret: "" });
    if (!mounted.current || generation.current !== epoch) return;
    accept(next, epoch);
    setDraft(({ clientId: _clientId, ...rest }) => rest);
    setClientSecret(""); setAuthorizationUrl(null); setCallbackUrl("");
    setFeedback("Client override removed. Connect Figma will request authorization.");
  });

  const cacheEnabled = draft.mirrorEnabled ?? snapshot?.config.mirrorEnabled ?? false;
  const cacheReady = !!(snapshot?.config.mirrorEnabled && snapshot.config.binaryAvailable && snapshot.config.tokenConfigured);
  return <div className="figma-settings" aria-busy={loading || busy !== null}>
    <p className="figma-muted">Connections are shared across this BB deployment. Saving or disconnecting affects everyone using these Figma tools.</p>
    <p>The official Figma MCP connection provides reads and writes. No local figmog installation is required for it; Figma authorization is still required.</p>
    <p>Sign in once to use Figma tools across this BB deployment. BB stores the authorization and refreshes it automatically.</p>
    {loading && <p role="status">Loading Figma settings…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy !== null} onClick={() => void refresh()}>Retry status</button></div>}
    {actionError && <p role="alert">{actionError}</p>}
    {feedback && <p role="status">{feedback}</p>}
    {busy && <p role="status">{busy}…</p>}
    {snapshot && <>
      <div className="figma-actions">
        <button type="button" disabled={busy !== null} onClick={() => void connect()}>Connect Figma</button>
        <button type="button" disabled={busy !== null} onClick={() => void refresh()}>Refresh status</button>
      </div>
      {(authorizationUrl || snapshot.official.phase === "authorizing") && <>
        {authorizationUrl ? <p><a href={authorizationUrl} target="_blank" rel="noopener noreferrer">Authorize Figma in a new tab</a></p>
          : <p className="figma-muted">A Figma sign-in is pending. Paste the callback from that sign-in, or click Connect Figma to start again.</p>}
        {snapshot.config.redirectUri.startsWith("http://") && <form onSubmit={event => { event.preventDefault(); void finishAuthorization(); }}>
          <label htmlFor={`${id}-callback`}>Figma callback URL</label>
          <input id={`${id}-callback`} type="text" autoComplete="off" spellCheck={false} value={callbackUrl} disabled={busy !== null} maxLength={65536} onChange={event => setCallbackUrl(event.target.value)} aria-describedby={`${id}-callback-help`} />
          <p id={`${id}-callback-help`} className="figma-muted">After approving in Figma, paste the address from your browser here, even if the localhost page cannot load. Missing http://, quotes and whitespace are corrected automatically.</p>
          <button type="submit" disabled={busy !== null || !callbackUrl.trim()}>Finish sign-in</button>
        </form>}
      </>}
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
            <p className="figma-muted">Optional client override: enter both an ID and secret supplied for your own Figma MCP client. Otherwise Connect Figma requests registration automatically. Issued credentials are kept privately on the BB server.</p>
            <label htmlFor={`${id}-client`}>Figma OAuth client ID</label>
            <input id={`${id}-client`} maxLength={4096} value={draft.clientId ?? snapshot.config.clientId} onChange={(e) => setDraft((current) => ({ ...current, clientId: e.target.value }))} />
            <label htmlFor={`${id}-secret`}>Replace Figma OAuth client secret</label>
            <input id={`${id}-secret`} type="password" autoComplete="new-password" maxLength={16384} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} aria-describedby={`${id}-secret-help`} />
            <p id={`${id}-secret-help`} className="figma-muted">{snapshot.config.clientSecretConfigured ? "A client override secret is configured." : "No client override secret is configured."} Leave blank to keep it. Disconnect Figma removes the authorization session; the saved client override is retained.</p>
            {(snapshot.config.clientId || snapshot.config.clientSecretConfigured) && <>
              <button type="button" onClick={() => void automaticRegistration()}>Use automatic registration</button>
              <p className="figma-muted">Removes the saved client override and disconnects official Figma. Your read token is retained.</p>
            </>}
            <label htmlFor={`${id}-redirect`}>OAuth callback URL</label>
            <input id={`${id}-redirect`} type="url" maxLength={8192} value={draft.redirectUri ?? snapshot.config.redirectUri} onChange={(e) => setDraft((current) => ({ ...current, redirectUri: e.target.value }))} />
          </details>
          <button type="submit" className="figma-primary" disabled={Object.keys(draft).length === 0 && !readToken && !clientSecret}>Save settings</button>
        </fieldset>
      </form>
      <label htmlFor={`${id}-file`}>Figma file URL for cache access test</label>
      <input id={`${id}-file`} type="url" value={file} disabled={busy !== null} onChange={(e) => { setFile(e.target.value); setAcceptUnverified(false); setSyncDisclosure(null); }} placeholder="https://www.figma.com/design/…" />
      <p className="figma-muted">Test read checks this file through the optional cache. Test Figma checks the official connection and account identity; it does not verify access to this file. Neither test edits your file.</p>
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
          <h3 id={`${id}-${source}`} ref={source === "official" ? officialHeading : undefined} tabIndex={source === "official" ? -1 : undefined}>{source === "mirror" ? "Optional cache connection" : "Official Figma connection"}</h3>
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
