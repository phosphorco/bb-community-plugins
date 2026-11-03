import { useEffect } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { TEMPLATES_CONFIG_EVENTS } from "../events.ts";

/** Public native events wake mounted reads; no scan, timer or synthetic channel. */
export function useConfigurationEvents(refresh: () => void) {
  const sdk = useSdk();
  useEffect(() => {
    const stops = TEMPLATES_CONFIG_EVENTS.map((event) =>
      sdk.subscribe({ event, callback: refresh }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [sdk, refresh]);
}
