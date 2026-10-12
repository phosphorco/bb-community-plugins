import "./app.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ConnectionPhase, ConnectionStatus, McpTool, SettingsSnapshot, Source } from "./contract.ts";
import type { rpcContract } from "./rpc-contract.ts";

type Area = "official" | "advanced";
type Draft = { clientId?: string; redirectUri?: string };
type Tone = "ok" | "pending" | "error" | "idle";

const officialLabels: Record<ConnectionPhase, [string, Tone]> = {
  connected: ["Connected", "ok"],
  connecting: ["Connecting…", "pending"],
  authorizing: ["Waiting for sign-in", "pending"],
  error: ["Connection problem", "error"],
  disconnected: ["Not connected", "idle"],
  unconfigured: ["Not connected", "idle"],
};
export function SentrySettings() {
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
  const [feedback, setFeedback] = useState<{ area: Area; text: string } | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [draft, setDraft] = useState<Draft>({});
  const [signedIn, setSignedIn] = useState(0);
  const mounted = useRef(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const reading = useRef(false);
  const queued = useRef(false);
  const officialStatus = useRef<HTMLParagraphElement>(null);
  const actionAlert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // A failed action can finish after its controls have scrolled off screen.
    // Focus its alert so the failure is visible and announced, even in a disclosure.
    if (actionError && actionAlert.current) {
      actionAlert.current.closest("details")?.setAttribute("open", "");
      actionAlert.current.focus();
    }
  }, [actionError]);
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
      if (mounted.current && epoch === generation.current) setError("Couldn't check Sentry status.");
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
  useRealtime("sentry", useCallback(() => { void refresh(); }, [refresh]));

  const run = async (label: string, area: Area, progress: string, failure: string, action: () => Promise<void>) => {
    if (mutation.current || !mounted.current) return;
    mutation.current = true;
    const epoch = ++generation.current;
    const failureBefore = actionFailure.current;
    setBusy({ area, progress });
    setFeedback(null);
    try {
      await action();
      if (mounted.current && generation.current === epoch && actionFailure.current === failureBefore && failureBefore?.label === label) {
        actionFailure.current = null; setActionError(null);
      }
    }
    catch (error) {
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
    if (mounted.current && generation.current === epoch) {
      setSnapshot(next);
      setError(null);
    }
  };
  const save = (area: "advanced") => run(`Save ${area}`, area, "Saving…", "Couldn't save. Your changes are kept; try again.", async () => {
    const epoch = generation.current;
    const fields: (keyof Draft)[] = ["clientId", "redirectUri"];
    const changes = Object.fromEntries(fields.filter(key => draft[key] !== undefined).map(key => [key, draft[key]]));
    const next = await rpc.call("configure", {
      ...changes,
      ...(area === "advanced" && clientSecret !== "" ? { clientSecret } : {}),
    });
    if (!mounted.current || generation.current !== epoch) return;
    accept(next, epoch);
    setClientSecret("");
    setDraft(current => Object.fromEntries(Object.entries(current).filter(([key]) => !fields.includes(key as keyof Draft))));
    setAuthorizationUrl(null); setCallbackUrl("");
    setFeedback({ area, text: "Saved." });
  });
  const sourceAction = (method: "disconnect" | "testConnection" | "refreshTools", source: Source) => {
    const [label, progress, failure, success] = method === "testConnection"
      ? ["Test Sentry", "Checking Sentry…", "Couldn't reach Sentry. Try again.", "Sentry is working."]
      : method === "refreshTools"
        ? ["Refresh tools", "Refreshing tools…", "Couldn't refresh tools. Try again.", "Tools refreshed."]
        : ["Disconnect Sentry", "Disconnecting…", "Couldn't disconnect. Try again.", "Disconnected."];
    return run(label, source, progress, failure, async () => {
      const epoch = generation.current;
      const next = await rpc.call(method, { source });
      accept(next, epoch);
      if (!mounted.current || generation.current !== epoch) return;
      if (method === "disconnect") { setAuthorizationUrl(null); setCallbackUrl(""); setClientSecret(""); }
      setFeedback({ area: source, text: success });
    });
  };
  const connect = () => run("Connect Sentry", "official", "Starting sign-in…", "Couldn't start sign-in.", async () => {
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
    "Sign-in didn't complete. Check the pasted address or start over. If Sentry already approved access, use Test Sentry.", async () => {
      const epoch = generation.current;
      let next: SettingsSnapshot;
      try { next = await rpc.call("finishAuthorization", { callbackUrl }); }
      finally { queued.current = true; }
      if (!mounted.current || generation.current !== epoch) return;
      accept(next, epoch);
      setCallbackUrl(""); setAuthorizationUrl(null);
      setFeedback({ area: "official", text: "Signed in to Sentry." });
      setSignedIn(count => count + 1);
    });
  const automaticRegistration = () => run("Use automatic registration", "advanced", "Removing client override…", "Couldn't remove the client override. Try again.", async () => {
    const epoch = generation.current;
    const next = await rpc.call("configure", { clientId: "", clientSecret: "" });
    if (!mounted.current || generation.current !== epoch) return;
    accept(next, epoch);
    setDraft(({ clientId: _clientId, ...rest }) => rest);
    setClientSecret(""); setAuthorizationUrl(null); setCallbackUrl("");
    setFeedback({ area: "advanced", text: "Client override removed. Connect Sentry to sign in again." });
  });

  const isBusy = busy !== null;
  const notices = (area: Area) => <>
    {actionError?.area === area && <p ref={actionAlert} tabIndex={-1} role="alert" className="sentry-error">{actionError.message}</p>}
    {busy?.area === area ? <p role="status" className="sentry-hint">{busy.progress}</p>
      : feedback?.area === area && <p role="status" className="sentry-hint">{feedback.text}</p>}
  </>;
  // Backend detail is shown only where it explains a problem or a recoverable state.
  const statusDetail = (source: Source, connection: ConnectionStatus, relevant: boolean) =>
    relevant && connection.detail && connection.phase !== "connected" && !(actionError?.area === source && actionError.coversDetail)
      ? <p className={connection.phase === "error" ? "sentry-error" : "sentry-hint"}>{connection.detail}</p> : null;

  if (!snapshot) return <div className="sentry-settings" aria-busy={loading}>
    {error
      ? <div role="alert" className="sentry-row"><p className="sentry-error">{error}</p><button type="button" className="sentry-button" onClick={() => void refresh()}>Retry</button></div>
      : <p role="status" className="sentry-hint">Loading…</p>}
  </div>;

  const { config, official } = snapshot;
  const [officialLabel, officialTone] = officialLabels[official.phase];
  const connected = official.phase === "connected";
  const signingIn = authorizationUrl !== null || official.phase === "authorizing";
  const loopback = config.redirectUri.startsWith("http://");
  const advancedDirty = draft.clientId !== undefined || draft.redirectUri !== undefined || clientSecret !== "";
  const hasOverride = !!(config.clientId || config.clientSecretConfigured);
  const submit = (action: () => void) => (event: FormEvent) => { event.preventDefault(); action(); };

  return <div className="sentry-settings" aria-busy={loading || isBusy}>
    {error && <div role="alert" className="sentry-row"><p className="sentry-error">{error}</p><button type="button" className="sentry-button" disabled={isBusy} onClick={() => void refresh()}>Retry</button></div>}

    <div className="sentry-group">
      <div className="sentry-row">
        <p ref={officialStatus} tabIndex={-1} className="sentry-status"><Dot tone={officialTone} />{officialLabel}</p>
        <div className="sentry-actions">
          {!connected && <button type="button" className={signingIn ? "sentry-button" : "sentry-button sentry-button-primary"} disabled={isBusy} onClick={() => void connect()}>
            {official.phase === "authorizing" || authorizationUrl ? "Start over" : "Connect Sentry"}
          </button>}
          <button type="button" className="sentry-button" disabled={isBusy} onClick={() => void sourceAction("testConnection", "official")}>Test Sentry</button>
          {official.phase !== "unconfigured" && official.phase !== "disconnected" &&
            <button type="button" className="sentry-button" disabled={isBusy} onClick={() => void sourceAction("disconnect", "official")}>Disconnect</button>}
        </div>
      </div>
      {statusDetail("official", official, true)}
      {notices("official")}
      {(authorizationUrl || (signingIn && loopback)) && <div className="sentry-panel">
        {authorizationUrl && <a className="sentry-button sentry-button-primary sentry-link-button" href={authorizationUrl} target="_blank" rel="noopener noreferrer">Approve access in Sentry<span aria-hidden="true"> ↗</span></a>}
        {loopback ? <form className="sentry-field" onSubmit={submit(() => void finishAuthorization())}>
          <label htmlFor={`${id}-callback`}>Callback URL</label>
          <p id={`${id}-callback-help`} className="sentry-hint">{authorizationUrl
            ? "After approving, paste the address your browser opens, even if the page doesn't load."
            : "Paste the address from the sign-in you started."}</p>
          <div className="sentry-row sentry-inline">
            <input id={`${id}-callback`} type="text" className="sentry-input" autoComplete="off" spellCheck={false} value={callbackUrl} disabled={isBusy} maxLength={65536} onChange={event => setCallbackUrl(event.target.value)} aria-describedby={`${id}-callback-help`} />
            <button type="submit" className="sentry-button" disabled={isBusy || !callbackUrl.trim()}>Finish sign-in</button>
          </div>
        </form> : authorizationUrl && <p className="sentry-hint">This page updates when you return.</p>}
      </div>}
      <Tools tools={snapshot.tools.official} disabled={isBusy} onRefresh={() => void sourceAction("refreshTools", "official")} />
      {snapshot.aliasesNeedReload && <p className="sentry-hint">Reload the Sentry plugin to update tool shortcuts.</p>}
    </div>

    <details className="sentry-disclosure">
      <summary><span>Advanced</span></summary>
      <form className="sentry-disclosure-body sentry-group" onSubmit={submit(() => void save("advanced"))}>
        <fieldset className="sentry-group" disabled={isBusy}>
          <legend className="sentry-legend">OAuth client</legend>
          <p className="sentry-hint">Leave empty to register automatically when you connect.</p>
          <Field id={`${id}-client`} label="Client ID">
            <input id={`${id}-client`} className="sentry-input" maxLength={4096} value={draft.clientId ?? config.clientId} onChange={(e) => setDraft((current) => ({ ...current, clientId: e.target.value }))} />
          </Field>
          <Field id={`${id}-secret`} label="Client secret" hint={config.clientSecretConfigured ? "Saved. Leave blank to keep it." : undefined}>
            <input id={`${id}-secret`} type="password" className="sentry-input" autoComplete="new-password" maxLength={16384} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} aria-describedby={config.clientSecretConfigured ? `${id}-secret-hint` : undefined} />
          </Field>
          <Field id={`${id}-redirect`} label="Redirect URL">
            <input id={`${id}-redirect`} type="url" className="sentry-input" maxLength={8192} value={draft.redirectUri ?? config.redirectUri} onChange={(e) => setDraft((current) => ({ ...current, redirectUri: e.target.value }))} />
          </Field>
          {hasOverride && <div className="sentry-row sentry-start">
            <button type="button" className="sentry-button" onClick={() => void automaticRegistration()} aria-describedby={`${id}-auto-help`}>Use automatic registration</button>
            <p id={`${id}-auto-help`} className="sentry-hint">Removes the override and signs Sentry out.</p>
          </div>}
        </fieldset>
        <fieldset className="sentry-group" disabled={isBusy}>
          <legend className="sentry-sr-only">Save connection settings</legend>
          <div className="sentry-actions">
            <button type="submit" className="sentry-button sentry-button-primary" disabled={!advancedDirty}>Save</button>
          </div>
        </fieldset>
        {notices("advanced")}
      </form>
    </details>
  </div>;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className="sentry-dot" data-tone={tone} aria-hidden="true" />;
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return <div className="sentry-field">
    <label htmlFor={id}>{label}</label>
    {children}
    {hint && <p id={`${id}-hint`} className="sentry-hint">{hint}</p>}
  </div>;
}

function Tools({ tools, disabled, onRefresh }: { tools: McpTool[]; disabled: boolean; onRefresh: () => void }) {
  return <details className="sentry-tools">
    <summary>{tools.length === 0 ? "No tools yet" : `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`}</summary>
    <div className="sentry-tools-body">
      {tools.length > 0 && <ul>{tools.map((tool) => <li key={tool.name} title={tool.description}><code>{tool.name}</code></li>)}</ul>}
      <button type="button" className="sentry-button sentry-button-small" disabled={disabled} onClick={onRefresh}>Refresh tools</button>
    </div>
  </details>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "sentry-connections", title: "Connection", description: "One Sentry sign-in, shared by everyone using this BB deployment.", component: SentrySettings });
});
