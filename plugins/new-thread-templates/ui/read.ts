import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";

/** A mounted read owns its retries. No timer runs after success or while hidden. */
const isHidden = () => document.visibilityState === "hidden";

export function useMountedRead<T>(load: () => Promise<T>, channel: string) {
  const [state, setState] = useState<{
    value: T | null;
    error: string | null;
    loading: boolean;
  }>({ value: null, error: null, loading: true });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useRealtime(channel, refresh);
  useEffect(() => {
    let disposed = false,
      running = false,
      again = false,
      generation = 0,
      failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const read = async () => {
      clear();
      if (disposed || isHidden()) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      const request = ++generation;
      try {
        const value = await load();
        if (!disposed && request === generation) {
          failures = 0;
          setState({ value, error: null, loading: false });
        }
      } catch (error) {
        if (!disposed && request === generation) {
          failures++;
          setState((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          }));
          if (!isHidden())
            timer = setTimeout(
              () => {
                void read();
              },
              Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)),
            );
        }
      } finally {
        running = false;
        if (again && !disposed) {
          again = false;
          void read();
        }
      }
    };
    refreshRef.current = () => {
      void read();
    };
    const visibility = () => {
      if (isHidden()) clear();
      else void read();
    };
    document.addEventListener("visibilitychange", visibility);
    void read();
    return () => {
      disposed = true;
      generation++;
      clear();
      refreshRef.current = () => {};
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load]);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (previous !== "connected" && connection === "connected") refresh();
  }, [connection, refresh]);
  return { ...state, refresh };
}
