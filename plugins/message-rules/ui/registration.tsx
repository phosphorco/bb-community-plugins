import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { MessageRulesBodyProps } from "./message-rules-body.tsx";
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { Draft } from "./types.ts";

export function registerMessageRules(app: PluginAppBuilder) {
  const drafts = new Map<string, Draft>();
  const MessageRules = createMessageRulesPanel(drafts);
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
        JEV uses the shared Topics connection by default. The optional dedicated
        Message Rules JEV API key is used only when explicitly selected in this plugin’s settings. Open
        Message Rules to manage shared groups, host directories, model, and run
        limits. Tests use saved revisions. Explicit configured JEV checks can
        use provider context checking when a verified local counter is
        unavailable; engineering/call limits and no implicit retry still apply.
      </p>
    ),
  });
}

export const PANEL_LOAD_RECOVERY_MS = 10_000;
type LoadSurface<Props extends object> = () => Promise<{ default: ComponentType<Props> }>;

class MessageRulesLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function BodyRecovery({ children, retire }: { children: ReactNode; retire: () => void }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => () => {
    if (content.current?.contains(document.activeElement)) retire();
  }, [retire]);
  return <div ref={content} className="mr-body-load-status">{children}</div>;
}

function BodyLoading({ name, retry, retire }: { name: string; retry: () => void; retire: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), PANEL_LOAD_RECOVERY_MS);
    return () => clearTimeout(timer);
  }, []);
  return <BodyRecovery retire={retire}>
    <div role="status">{slow ? `${name} is taking longer to load.` : `Loading ${name}…`}</div>
    {slow && <RetryBody name={name} retry={retry} />}
  </BodyRecovery>;
}

function RetryBody({ name, retry }: { name: string; retry: () => void }) {
  return <button type="button" onClick={retry}
    className="mr-body-load-retry">
    Retry loading {name}
  </button>;
}

class BodyBoundary extends Component<{ name: string; children: ReactNode; retry: () => void; retire: () => void }, { error: MessageRulesLoadError | null }> {
  state: { error: MessageRulesLoadError | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    // Surface render failures retain BB's native slot crash handling.
    if (!(error instanceof MessageRulesLoadError)) throw error;
    return { error };
  }

  render() {
    if (this.state.error) return <BodyRecovery retire={this.props.retire}>
      <div role="alert">{this.props.name} could not load.</div>
      <details className="mr-body-load-details">
        <summary>Error details</summary>
        <pre>{this.state.error.cause instanceof Error ? this.state.error.cause.stack ?? this.state.error.cause.message : this.state.error.message}</pre>
      </details>
      <RetryBody name={this.props.name} retry={this.props.retry} />
    </BodyRecovery>;
    return this.props.children;
  }
}

/** React owns module caching. The registration retains only its selected lazy
 * component, including explicit recovery. Draft state remains with the registration that supplied its Map. */
function createBodyLoader<Props extends object>(name: string, load: LoadSurface<Props>) {
  const loadWithError = async () => {
    try { return await load(); }
    catch (cause) { throw new MessageRulesLoadError(cause); }
  };
  let currentPanel = lazy(loadWithError);
  return function MessageRulesBodyLoader(props: Props) {
    const region = useRef<HTMLDivElement>(null);
    const [{ Panel, attempt }, setSelection] = useState(() => ({ Panel: currentPanel, attempt: 0 }));
    const retry = () => {
      const nextPanel = lazy(loadWithError);
      currentPanel = nextPanel;
      setSelection(previous => ({ Panel: nextPanel, attempt: previous.attempt + 1 }));
    };
    const retire = useCallback(() => region.current?.focus({ preventScroll: true }), []);
    const Surface = Panel as ComponentType<Props>;
    return <div ref={region} role="region" aria-label={name} tabIndex={-1}
      data-mr-body-loader="" className="mr-body-loader">
      <BodyBoundary name={name} key={attempt} retry={retry} retire={retire}>
        <Suspense fallback={<BodyLoading name={name} retry={retry} retire={retire} />}>
          <Surface {...props} />
        </Suspense>
      </BodyBoundary>
    </div>;
  };
}


type BodyModule = { MessageRulesBody: ComponentType<MessageRulesBodyProps> };

export function createMessageRulesPanel(drafts: Map<string, Draft>, load: () => Promise<BodyModule> = () => import("./message-rules-body.tsx")) {
  const Body = createBodyLoader<MessageRulesBodyProps>("Message Rules", async () => ({ default: (await load()).MessageRulesBody }));
  return function MessageRulesEntry(props: PluginNavPanelProps) {
    return <Body {...props} drafts={drafts} />;
  };
}
