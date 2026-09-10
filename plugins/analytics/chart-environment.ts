import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { AnalyticsChartTheme } from "./analytics-model.ts";

const FALLBACK_THEME: AnalyticsChartTheme = {
  foreground: "rgb(240, 240, 240)",
  muted: "rgb(150, 150, 150)",
  border: "rgb(80, 80, 80)",
  surface: "rgb(30, 30, 30)",
  series: "rgb(120, 90, 240)",
};

export function useAnalyticsChartEnvironment(): {
  probeRef: RefObject<HTMLSpanElement | null>;
  theme: AnalyticsChartTheme;
  reducedMotion: boolean;
} {
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [theme, setTheme] = useState<AnalyticsChartTheme>(FALLBACK_THEME);
  const [reducedMotion, setReducedMotion] = useState(false);
  const fingerprint = useRef("");

  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (probe == null) return;
    let frame: number | null = null;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      frame = null;
      const style = getComputedStyle(probe);
      const next = {
        foreground: style.color,
        muted: style.borderTopColor,
        border: style.borderRightColor,
        surface: style.backgroundColor,
        series: style.borderBottomColor,
      };
      const nextFingerprint = JSON.stringify(next);
      if (nextFingerprint !== fingerprint.current) {
        fingerprint.current = nextFingerprint;
        setTheme(next);
      }
      setReducedMotion((current) => current === media.matches ? current : media.matches);
    };
    const schedule = () => {
      if (frame == null) frame = requestAnimationFrame(apply);
    };
    const observer = new MutationObserver(schedule);
    for (let ancestor = probe.parentElement, count = 0; ancestor != null && count < 6; ancestor = ancestor.parentElement, count += 1) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    }
    media.addEventListener("change", schedule);
    apply();
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      observer.disconnect();
      media.removeEventListener("change", schedule);
    };
  }, []);

  return { probeRef, theme, reducedMotion };
}
