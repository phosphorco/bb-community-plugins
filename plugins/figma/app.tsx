import "./app.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ConnectionPhase, ConnectionStatus, McpTool, SettingsSnapshot, Source } from "./contract.ts";
import type { rpcContract } from "./rpc-contract.ts";

type Area = "official" | "mirror" | "advanced";
type Draft = { binaryPath?: string; mirrorEnabled?: boolean; clientId?: string; redirectUri?: string };
type Tone = "ok" | "pending" | "error" | "idle";

const officialLabels: Record<ConnectionPhase, [string, Tone]> = {
  connected: ["Connected", "ok"],
  connecting: ["Connecting…", "pending"],
  authorizing: ["Waiting for sign-in", "pending"],
  error: ["Connection problem", "error"],
  disconnected: ["Not connected", "idle"],
  unconfigured: ["Not connected", "idle"],
};
const cacheLabels: Record<ConnectionPhase, [string, Tone]> = {
  connected: ["Running", "ok"],
  connecting: ["Starting…", "pending"],
  authorizing: ["Starting…", "pending"],
  error: ["Problem", "error"],
  disconnected: ["Stopped", "idle"],
  unconfigured: ["Needs a read token", "idle"],
};

export function FigmaSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const id = useId();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<{ area: Area; progress: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ area: Area; message: string; coversDetail: boolean } | null>(null);
  const actionFailure = useRef<{ label: string; revision: number } | null>(null);
  const reportActionError = (label: string, area: Area, message: string, coversDetail = false) => {
    actionFailure.current = { label, revision: (actionFailure.current?.revision ?? 0) + 1 };
    setActionError({ area, message, coversDetail });
  };
  const [syncDisclosure, setSyncDisclosure] = useState<{ file: string; freshness: string | null } | null>(null);
  const [feedback, setFeedback] = useState<{ area: Area; text: string } | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [readToken, setReadToken] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [draft, setDraft] = useState<Draft>({});
  const [file, setFile] = useState("");
  const [acceptUnverified, setAcceptUnverified] = useState(false);
  const [signedIn, setSignedIn] = useState(0);
  const mounted = useRef(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const reading = useRef(false);
  const queued = useRef(false);
  const officialStatus = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (signedIn) officialStatus.current?.focus();
  }, [signedIn]);

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
      if (mounted.current && epoch === generation.current) setError("Couldn't check Figma status.");
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

  const run = async (label: string, area: Area, progress: string, failure: string, action: () => Promise<void>) => {
    if (mutation.current || !mounted.current) return;
    mutation.current = true;
    const epoch = ++generation.current;
    const failureBefore = actionFailure.current;
    setBusy({ area, progress });
    setError(null);
    setFeedback(null);
    try {
      await action();
      if (mounted.current && generation.current === epoch && actionFailure.current === failureBefore && failureBefore?.label === label) {
        actionFailure.current = null; setActionError(null);
      }
    }
    catch {
      if (mounted.current && generation.current === epoch) reportActionError(label, area, failure);
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
  const save = (area: "mirror" | "advanced") => run(`Save ${area}`, area, "Saving…", "Couldn't save. Your changes are kept; try again.", async () => {
    const epoch = generation.current;
    const fields: (keyof Draft)[] = area === "mirror" ? ["mirrorEnabled"] : ["clientId", "redirectUri", "binaryPath"];
    const changes = Object.fromEntries(fields.filter(key => draft[key] !== undefined).map(key => [key, draft[key]]));
    const next = await rpc.call("configure", {
      ...changes,
      ...(area === "mirror" && readToken !== "" ? { readToken } : {}),
      ...(area === "advanced" && clientSecret !== "" ? { clientSecret } : {}),
    });
    if (!mounted.current || generation.current !== epoch) return;
    accept(next, epoch);
    if (area === "mirror") { setReadToken(""); setSyncDisclosure(null); setAcceptUnverified(false); }
    else setClientSecret("");
    setDraft(current => Object.fromEntries(Object.entries(current).filter(([key]) => !fields.includes(key as keyof Draft))));
    setAuthorizationUrl(null); setCallbackUrl("");
    setFeedback({ area, text: "Saved." });
  });
  const sourceAction = (method: "disconnect" | "testConnection" | "refreshTools", source: Source) => {
    const official = source === "official";
    const [label, progress, failure, success] = method === "testConnection"
      ? official
        ? ["Test Figma", "Checking Figma…", "Couldn't reach Figma. Try again.", "Figma is working."]
        : ["Test read", "Checking read access…", "Couldn't verify read access. Try again.", "Read access works."]
      : method === "refreshTools"
        ? [`Refresh ${source} tools`, "Refreshing tools…", "Couldn't refresh tools. Try again.", "Tools refreshed."]
        : official
          ? ["Disconnect Figma", "Disconnecting…", "Couldn't disconnect. Try again.", "Disconnected."]
          : ["Remove read token", "Removing token…", "Couldn't remove the read token. Try again.", "Read token removed."];
    return run(label, source, progress, failure, async () => {
      const epoch = generation.current;
      const next = method === "testConnection" && !official
        ? await rpc.call(method, { source, ...(file.trim() ? { file: file.trim() } : {}) })
        : await rpc.call(method, { source });
      accept(next, epoch);
      if (!mounted.current || generation.current !== epoch) return;
      if (method === "disconnect") {
        if (official) { setAuthorizationUrl(null); setCallbackUrl(""); setClientSecret(""); }
        else { setReadToken(""); setSyncDisclosure(null); setAcceptUnverified(false); }
      }
      if (method === "testConnection" && next[source].phase === "error") {
        const detail = next[source].detail;
        reportActionError(label, source, `${failure.replace(" Try again.", "")}${detail ? ` ${detail}` : ""}`, true);
        return;
      }
      setFeedback({ area: source, text: success });
    });
  };
  const syncReadCache = () => run("Sync cache", "mirror", "Syncing…", "Sync failed. Cache freshness is unverified; try again.", async () => {
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
      if ("state" in freshness && freshness.state === "rebaselined") sentences.push("The cache has a new version baseline.");
      if ("mutationVisibilityVerified" in freshness && freshness.mutationVisibilityVerified === false) sentences.push("The earlier edit isn't verified as visible.");
      if ("detail" in freshness && typeof freshness.detail === "string") sentences.push(freshness.detail);
      if (sentences.length) disclosure = sentences.join(" ");
    }
    setSyncDisclosure({ file: target, freshness: disclosure });
    if (result.isError === true) reportActionError("Sync cache", "mirror", "Sync reported an error. Cache freshness is unverified; try again.");
    queued.current = true;
  });
  const connect = () => run("Connect Figma", "official", "Starting sign-in…", "Couldn't start sign-in.", async () => {
    const epoch = generation.current;
    setAuthorizationUrl(null); setCallbackUrl("");
    let result: { authorizationUrl: string };
    try { result = await rpc.call("connectOfficial", null); }
    finally { queued.current = true; }
    const url = new URL(result.authorizationUrl);
    if (url.protocol !== "https:") throw new Error("Invalid authorization URL");
    if (!mounted.current || generation.current !== epoch) return;
    setAuthorizationUrl(url.href);
    queued.current = true;
  });
  const finishAuthorization = () => run("Finish sign-in", "official", "Finishing sign-in…",
    "Sign-in didn't complete. Check the pasted address or start over. If Figma already approved access, use Test Figma.", async () => {
      const epoch = generation.current;
      let next: SettingsSnapshot;
      try { next = await rpc.call("finishAuthorization", { callbackUrl }); }
      finally { queued.current = true; }
      if (!mounted.current || generation.current !== epoch) return;
      accept(next, epoch);
      setCallbackUrl(""); setAuthorizationUrl(null);
      setFeedback({ area: "official", text: "Signed in to Figma." });
      setSignedIn(count => count + 1);
    });
  const automaticRegistration = () => run("Use automatic registration", "advanced", "Removing client override…", "Couldn't remove the client override. Try again.", async () => {
    const epoch = generation.current;
    const next = await rpc.call("configure", { clientId: "", clientSecret: "" });
    if (!mounted.current || generation.current !== epoch) return;
    accept(next, epoch);
    setDraft(({ clientId: _clientId, ...rest }) => rest);
    setClientSecret(""); setAuthorizationUrl(null); setCallbackUrl("");
    setFeedback({ area: "advanced", text: "Client override removed. Connect Figma to sign in again." });
  });

  const isBusy = busy !== null;
  const notices = (area: Area) => <>
    {actionError?.area === area && <p role="alert" className="figma-error">{actionError.message}</p>}
    {busy?.area === area ? <p role="status" className="figma-hint">{busy.progress}</p>
      : feedback?.area === area && <p role="status" className="figma-hint">{feedback.text}</p>}
  </>;
  // Backend detail is shown only where it explains a problem or a recoverable state.
  const statusDetail = (source: Source, connection: ConnectionStatus, relevant: boolean) =>
    relevant && connection.detail && connection.phase !== "connected" && !(actionError?.area === source && actionError.coversDetail)
      ? <p className={connection.phase === "error" ? "figma-error" : "figma-hint"}>{connection.detail}</p> : null;

  if (!snapshot) return <div className="figma-settings" aria-busy={loading}>
    {error
      ? <div role="alert" className="figma-row"><p className="figma-error">{error}</p><button type="button" className="figma-button" onClick={() => void refresh()}>Retry</button></div>
      : <p role="status" className="figma-hint">Loading…</p>}
  </div>;

  const { config, official, mirror } = snapshot;
  const [officialLabel, officialTone] = officialLabels[official.phase];
  const connected = official.phase === "connected";
  const signingIn = authorizationUrl !== null || official.phase === "authorizing";
  const loopback = config.redirectUri.startsWith("http://");
  const cacheEnabled = draft.mirrorEnabled ?? config.mirrorEnabled;
  const cacheReady = config.mirrorEnabled && config.binaryAvailable && config.tokenConfigured;
  const [cacheLabel, cacheTone] = !config.mirrorEnabled ? ["Off", "idle" as Tone]
    : !config.binaryAvailable ? ["figmog not found", "error" as Tone]
      : !config.tokenConfigured ? cacheLabels.unconfigured : cacheLabels[mirror.phase];
  const cacheDirty = draft.mirrorEnabled !== undefined || readToken !== "";
  const advancedDirty = draft.clientId !== undefined || draft.redirectUri !== undefined || draft.binaryPath !== undefined || clientSecret !== "";
  const hasOverride = !!(config.clientId || config.clientSecretConfigured);
  const submit = (action: () => void) => (event: FormEvent) => { event.preventDefault(); action(); };

  return <div className="figma-settings" aria-busy={loading || isBusy}>
    {error && <div role="alert" className="figma-row"><p className="figma-error">{error}</p><button type="button" className="figma-button" disabled={isBusy} onClick={() => void refresh()}>Retry</button></div>}

    <div className="figma-group">
      <div className="figma-row">
        <p ref={officialStatus} tabIndex={-1} className="figma-status"><Dot tone={officialTone} />{officialLabel}</p>
        <div className="figma-actions">
          {!connected && <button type="button" className={signingIn ? "figma-button" : "figma-button figma-button-primary"} disabled={isBusy} onClick={() => void connect()}>
            {official.phase === "authorizing" || authorizationUrl ? "Start over" : "Connect Figma"}
          </button>}
          <button type="button" className="figma-button" disabled={isBusy} onClick={() => void sourceAction("testConnection", "official")}>Test Figma</button>
          {official.phase !== "unconfigured" && official.phase !== "disconnected" &&
            <button type="button" className="figma-button" disabled={isBusy} onClick={() => void sourceAction("disconnect", "official")}>Disconnect</button>}
        </div>
      </div>
      {statusDetail("official", official, true)}
      {notices("official")}
      {(authorizationUrl || (signingIn && loopback)) && <div className="figma-panel">
        {authorizationUrl && <a className="figma-button figma-button-primary figma-link-button" href={authorizationUrl} target="_blank" rel="noopener noreferrer">Approve access in Figma<span aria-hidden="true"> ↗</span></a>}
        {loopback ? <form className="figma-field" onSubmit={submit(() => void finishAuthorization())}>
          <label htmlFor={`${id}-callback`}>Callback URL</label>
          <p id={`${id}-callback-help`} className="figma-hint">{authorizationUrl
            ? "After approving, paste the address your browser opens, even if the page doesn't load."
            : "Paste the address from the sign-in you started."}</p>
          <div className="figma-row figma-inline">
            <input id={`${id}-callback`} type="text" className="figma-input" autoComplete="off" spellCheck={false} value={callbackUrl} disabled={isBusy} maxLength={65536} onChange={event => setCallbackUrl(event.target.value)} aria-describedby={`${id}-callback-help`} />
            <button type="submit" className="figma-button" disabled={isBusy || !callbackUrl.trim()}>Finish sign-in</button>
          </div>
        </form> : authorizationUrl && <p className="figma-hint">This page updates when you return.</p>}
      </div>}
      <Tools tools={snapshot.tools.official} disabled={isBusy} onRefresh={() => void sourceAction("refreshTools", "official")} />
      {snapshot.aliasesNeedReload && <p className="figma-hint">Reload the Figma plugin to update tool shortcuts.</p>}
    </div>

    <details className="figma-disclosure">
      <summary><span>Read cache</span><span className="figma-summary-status"><Dot tone={cacheTone} />{cacheLabel}</span></summary>
      <div className="figma-disclosure-body">
        <form className="figma-group" onSubmit={submit(() => void save("mirror"))}>
          <fieldset className="figma-group" disabled={isBusy}>
            <legend className="figma-sr-only">Read cache settings</legend>
            <label className="figma-check" htmlFor={`${id}-cache-enabled`}>
              <input id={`${id}-cache-enabled`} type="checkbox" checked={cacheEnabled} onChange={(event) => setDraft(current => ({ ...current, mirrorEnabled: event.target.checked }))} aria-describedby={`${id}-cache-help`} />
              <span>Cache reads with figmog</span>
            </label>
            <p id={`${id}-cache-help`} className="figma-hint figma-indent">{config.binaryAvailable
              ? "Speeds up repeated reads. Edits always use the Figma connection."
              : <>figmog isn't installed on the BB host. <a href="https://github.com/sanctuarycomputer/figmog#install" target="_blank" rel="noopener noreferrer">Install figmog</a></>}</p>
            <Field id={`${id}-token`} label="Read token" hint={config.tokenConfigured ? "Saved. Leave blank to keep it." : "A Figma personal access token with file read access."}>
              <input id={`${id}-token`} type="password" className="figma-input" disabled={!cacheEnabled} autoComplete="new-password" maxLength={16384} value={readToken} onChange={(e) => setReadToken(e.target.value)} aria-describedby={`${id}-token-hint`} />
            </Field>
            <div className="figma-actions">
              <button type="submit" className="figma-button figma-button-primary" disabled={!cacheDirty}>Save</button>
              {(config.tokenConfigured || mirror.phase !== "unconfigured") &&
                <button type="button" className="figma-button" onClick={() => void sourceAction("disconnect", "mirror")}>Remove read token</button>}
            </div>
          </fieldset>
        </form>
        {statusDetail("mirror", mirror, cacheReady)}
        {notices("mirror")}
        {cacheReady && <div className="figma-group figma-divided">
          <Field id={`${id}-file`} label="Figma file URL">
            <input id={`${id}-file`} type="url" className="figma-input" value={file} disabled={isBusy} onChange={(e) => { setFile(e.target.value); setAcceptUnverified(false); setSyncDisclosure(null); }} placeholder="https://www.figma.com/design/…" />
          </Field>
          <label className="figma-check" htmlFor={`${id}-accept-unverified`}>
            <input id={`${id}-accept-unverified`} type="checkbox" checked={acceptUnverified} disabled={isBusy} onChange={(e) => setAcceptUnverified(e.target.checked)} aria-describedby={`${id}-sync-help`} />
            <span>Accept the sync without verifying the earlier edit</span>
          </label>
          <p id={`${id}-sync-help`} className="figma-hint figma-indent">Makes a stuck cache usable again, but the earlier edit may not be visible. Check the canvas first.</p>
          <div className="figma-actions">
            <button type="button" className="figma-button" disabled={isBusy || !file.trim()} onClick={() => void sourceAction("testConnection", "mirror")}>Test read</button>
            <button type="button" className="figma-button" disabled={isBusy || !file.trim()} onClick={() => void syncReadCache()}>Sync</button>
          </div>
          {syncDisclosure && <p role="status" className="figma-hint">
            Synced {syncDisclosure.file}. {syncDisclosure.freshness ?? "The earlier edit isn't verified as visible."}
          </p>}
          <Tools tools={snapshot.tools.mirror} disabled={isBusy} onRefresh={() => void sourceAction("refreshTools", "mirror")} />
        </div>}
      </div>
    </details>

    <details className="figma-disclosure">
      <summary><span>Advanced</span></summary>
      <form className="figma-disclosure-body figma-group" onSubmit={submit(() => void save("advanced"))}>
        <fieldset className="figma-group" disabled={isBusy}>
          <legend className="figma-legend">OAuth client</legend>
          <p className="figma-hint">Leave empty to register automatically when you connect.</p>
          <Field id={`${id}-client`} label="Client ID">
            <input id={`${id}-client`} className="figma-input" maxLength={4096} value={draft.clientId ?? config.clientId} onChange={(e) => setDraft((current) => ({ ...current, clientId: e.target.value }))} />
          </Field>
          <Field id={`${id}-secret`} label="Client secret" hint={config.clientSecretConfigured ? "Saved. Leave blank to keep it." : undefined}>
            <input id={`${id}-secret`} type="password" className="figma-input" autoComplete="new-password" maxLength={16384} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} aria-describedby={config.clientSecretConfigured ? `${id}-secret-hint` : undefined} />
          </Field>
          <Field id={`${id}-redirect`} label="Redirect URL">
            <input id={`${id}-redirect`} type="url" className="figma-input" maxLength={8192} value={draft.redirectUri ?? config.redirectUri} onChange={(e) => setDraft((current) => ({ ...current, redirectUri: e.target.value }))} />
          </Field>
          {hasOverride && <div className="figma-row figma-start">
            <button type="button" className="figma-button" onClick={() => void automaticRegistration()} aria-describedby={`${id}-auto-help`}>Use automatic registration</button>
            <p id={`${id}-auto-help`} className="figma-hint">Removes the override and signs Figma out.</p>
          </div>}
        </fieldset>
        <fieldset className="figma-group" disabled={isBusy}>
          <legend className="figma-legend">figmog</legend>
          <Field id={`${id}-binary`} label="Executable path">
            <input id={`${id}-binary`} className="figma-input" maxLength={4096} value={draft.binaryPath ?? config.binaryPath} onChange={(e) => setDraft((current) => ({ ...current, binaryPath: e.target.value }))} />
          </Field>
          <div className="figma-actions">
            <button type="submit" className="figma-button figma-button-primary" disabled={!advancedDirty}>Save</button>
          </div>
        </fieldset>
        {notices("advanced")}
      </form>
    </details>
  </div>;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className="figma-dot" data-tone={tone} aria-hidden="true" />;
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return <div className="figma-field">
    <label htmlFor={id}>{label}</label>
    {children}
    {hint && <p id={`${id}-hint`} className="figma-hint">{hint}</p>}
  </div>;
}

function Tools({ tools, disabled, onRefresh }: { tools: McpTool[]; disabled: boolean; onRefresh: () => void }) {
  return <details className="figma-tools">
    <summary>{tools.length === 0 ? "No tools yet" : `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`}</summary>
    <div className="figma-tools-body">
      {tools.length > 0 && <ul>{tools.map((tool) => <li key={tool.name} title={tool.description}><code>{tool.name}</code></li>)}</ul>}
      <button type="button" className="figma-button figma-button-small" disabled={disabled} onClick={onRefresh}>Refresh tools</button>
    </div>
  </details>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "figma-connections", title: "Connection", description: "One Figma sign-in, shared by everyone using this BB deployment.", component: FigmaSettings });
});
