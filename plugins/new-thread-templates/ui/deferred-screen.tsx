import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

/** Native dynamic imports; no request, draft or identity state lives here. */
export const templateScreens = {
  run: () =>
    import("./run.tsx").then((module) => ({ default: module.TemplateRun })),
  management: () =>
    import("./management.tsx").then((module) => ({
      default: module.Management,
    })),
};

class ScreenFailure extends Component<
  {
    children: ReactNode;
    failed(error: unknown): void;
    fallback(error: unknown): ReactNode;
  },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  componentDidCatch(error: Error) {
    this.props.failed(error);
  }
  render() {
    return this.state.failed
      ? this.props.fallback(this.state.error)
      : this.props.children;
  }
}

function ScreenReady({
  children,
  ready,
}: {
  children: ReactNode;
  ready(): void;
}) {
  useEffect(ready, [ready]);
  return children;
}

function Recovery({
  heading,
  backLabel,
  onBack,
  loading,
  failed,
  retry,
  className,
  selected,
  onReload,
}: {
  heading: string;
  backLabel: string;
  onBack(): void;
  loading: boolean;
  failed: boolean;
  retry(): void;
  className: string;
  selected: boolean;
  onReload(): void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  return (
    <section
      className={className}
      {...(selected ? { "data-new-thread-templates-form": "recovery" } : {})}
    >
      <div className="ntt-row ntt-between">
        <button type="button" className="ntt-link" onClick={onBack}>
          {backLabel}
        </button>
        <h3 className="ntt-selected-name" ref={title} tabIndex={-1}>
          {heading}
        </h3>
      </div>
      {failed && (
        <p className="ntt-alert" role="alert">
          This view could not load. Your saved work is retained.
        </p>
      )}
      {loading && (
        <p className="ntt-muted" role="status">
          Loading {selected ? "template form" : "template editor"}…
        </p>
      )}
      {!loading && (
        <div className="ntt-row">
          <button type="button" className="ntt-button" onClick={retry}>
            Retry loading
          </button>
          <button type="button" className="ntt-link" onClick={onReload}>
            Reload view
          </button>
        </div>
      )}
    </section>
  );
}

/** React owns suspension/disposal. A failed import never admits a form or dispatches work. */
export function DeferredScreen<P extends object>({
  load,
  screenProps,
  heading,
  onBack,
  selected = false,
  settings = false,
  onReload = () => window.location.reload(),
}: {
  load(): Promise<{ default: ComponentType<P> }>;
  screenProps: P;
  heading: string;
  onBack(): void;
  selected?: boolean;
  settings?: boolean;
  onReload?(): void;
}) {
  const [attempt, setAttempt] = useState(0),
    [failed, setFailed] = useState(false);
  const Screen = useMemo(() => lazy(load), [load, attempt]);
  const recovered = useCallback(() => setFailed(false), []);
  const rememberFailure = useCallback(() => setFailed(true), []);
  const recovery = (loading: boolean, currentFailure = failed) => (
    <Recovery
      heading={heading}
      backLabel={selected ? "‹ All templates" : "‹ New thread"}
      onBack={onBack}
      loading={loading}
      failed={currentFailure}
      retry={() => setAttempt((value) => value + 1)}
      selected={selected}
      onReload={onReload}
      className={
        selected
          ? "ntt-run ntt-stack"
          : `ntt ntt-stack ${settings ? "ntt-settings" : "ntt-panel"}`
      }
    />
  );
  return (
    <ScreenFailure
      key={attempt}
      failed={rememberFailure}
      fallback={() => recovery(false, true)}
    >
      <Suspense fallback={recovery(true)}>
        <ScreenReady ready={recovered}>
          <Screen {...screenProps} />
        </ScreenReady>
      </Suspense>
    </ScreenFailure>
  );
}
