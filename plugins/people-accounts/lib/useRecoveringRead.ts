import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { useRealtimeConnectionState } from "@get-bb/plugin-sdk/app"
import { createRecoveringRead, type ReadRecoveryEnvironment } from "./recovering-read.ts"

const browser: ReadRecoveryEnvironment = {
  visible: () => document.visibilityState !== "hidden",
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: timer => window.clearTimeout(timer as number),
  listen(wake, visibility) {
    window.addEventListener("online", wake)
    window.addEventListener("focus", wake)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      window.removeEventListener("online", wake)
      window.removeEventListener("focus", wake)
      document.removeEventListener("visibilitychange", visibility)
    }
  },
}

/** Memoize read with useCallback; changing its source creates a separate resource. */
export function useRecoveringRead<T>(read: () => Promise<T>) {
  const resource = useMemo(() => createRecoveringRead(read, browser), [read])
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot)
  const connection = useRealtimeConnectionState()
  const priorConnection = useRef(connection)
  useEffect(() => {
    const previous = priorConnection.current
    priorConnection.current = connection
    if (previous !== "connected" && connection === "connected") void resource.refresh()
  }, [connection, resource])
  return { ...state, refresh: resource.refresh, confirm: resource.confirm, update: resource.update }
}
