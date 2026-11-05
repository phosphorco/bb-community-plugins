import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
export interface MountedReadContext {
  isCurrent(): boolean;
}
const isHidden = () => document.visibilityState === "hidden";

/** One mounted owner retains one raw request across loader replacements.
 * Invalidation revokes freshness immediately; remote disposal is not cancellation. */
export function useMountedResource<T>(
  load: (context: MountedReadContext) => Promise<T>,
  initialValue: T | null = null,
) {
  const [state, setState] = useState<{
    value: T | null;
    error: string | null;
    loading: boolean;
    fresh: boolean;
  }>({
    value: initialValue,
    error: null,
    loading: initialValue === null,
    fresh: false,
  });
  const latest = useRef(load);
  latest.current = load;
  const owner = useRef({
    active: false,
    generation: 0,
    running: false,
    queued: false,
    failures: 0,
    fresh: false,
    acceptedLoad: null as ((context: MountedReadContext) => Promise<T>) | null,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const runRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => {
    const current = owner.current;
    current.generation++;
    current.fresh = false;
    current.queued = true;
    if (current.timer) clearTimeout(current.timer);
    current.timer = undefined;
    if (current.active)
      setState((previous) => ({
        ...previous,
        fresh: false,
        loading: previous.value === null,
      }));
    runRef.current();
  }, []);
  const seed = useCallback((value: T | null) => {
    if (value !== null && owner.current.active)
      setState((previous) =>
        previous.value === null
          ? { ...previous, value, loading: false, fresh: false }
          : previous,
      );
  }, []);
  const isFresh = useCallback(
    () =>
      owner.current.active &&
      owner.current.fresh &&
      owner.current.acceptedLoad === latest.current,
    [],
  );
  const connection = useRealtimeConnectionState(),
    previousConnection = useRef(connection);
  useEffect(() => {
    const current = owner.current;
    current.active = true;
    const clear = () => {
      if (current.timer) clearTimeout(current.timer);
      current.timer = undefined;
    };
    const run = async () => {
      clear();
      if (!current.active || current.running || !current.queued || isHidden())
        return;
      current.running = true;
      current.queued = false;
      const generation = current.generation,
        captured = latest.current;
      const matches = () =>
        current.active &&
        generation === current.generation &&
        captured === latest.current;
      try {
        const value = await captured({ isCurrent: matches });
        if (matches()) {
          current.failures = 0;
          current.fresh = true;
          current.acceptedLoad = captured;
          setState({ value, error: null, loading: false, fresh: true });
        }
      } catch (error) {
        if (matches()) {
          current.failures++;
          current.fresh = false;
          setState((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
            fresh: false,
          }));
          if (!isHidden() && !current.queued)
            current.timer = setTimeout(
              refresh,
              Math.min(30_000, 1000 * 2 ** Math.min(current.failures - 1, 5)),
            );
        }
      } finally {
        current.running = false;
        if (current.active && current.queued) void run();
      }
    };
    runRef.current = () => {
      void run();
    };
    const visibility = () => {
      if (isHidden()) {
        clear();
        current.generation++;
        current.fresh = false;
        current.queued = true;
        setState((previous) => ({ ...previous, fresh: false }));
      } else refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      current.active = false;
      current.generation++;
      current.fresh = false;
      current.queued = false;
      clear();
      runRef.current = () => {};
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh]);
  useEffect(() => {
    refresh();
  }, [load, refresh]);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (previous !== "connected" && connection === "connected") refresh();
  }, [connection, refresh]);
  return {
    ...state,
    fresh: state.fresh && owner.current.acceptedLoad === load,
    refresh,
    isFresh,
    seed,
  };
}

/** Plugin facts are separate from native configuration events. */
export function useMountedRead<T>(
  load: (context: MountedReadContext) => Promise<T>,
  channel: string,
  initialValue: T | null = null,
) {
  const resource = useMountedResource(load, initialValue);
  useRealtime(channel, resource.refresh);
  return resource;
}
