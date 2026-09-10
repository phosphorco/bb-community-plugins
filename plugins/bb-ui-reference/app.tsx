import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  buildThemeTokens,
  discoverThemeTokenVariables,
  groupThemeTokens,
  NATIVE_UI_GROUPS,
  SURFACE_MAP_SECTIONS,
} from "./ui-reference.ts";

const TOGGLE_EVENT = "bb-ui-reference:toggle";
const POSITION_KEY = "bb-ui-reference:position";
const SURFACE_MAP_URL = "/api/v1/plugins/bb-ui-reference/http/surface-map";
const SURFACE_LEGEND_URL = "/api/v1/plugins/bb-ui-reference/http/surface-legend";
const NATIVE_UI_ICONS_URL = "/api/v1/plugins/bb-ui-reference/http/native-ui-icons";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText != null) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through for browser contexts where clipboard permission is denied.
    }
  }
  const input = element("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy unavailable");
}

function readPosition(): { x: number; y: number } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null") as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { x, y } = parsed as { x?: unknown; y?: unknown };
    return typeof x === "number" && typeof y === "number" ? { x, y } : null;
  } catch {
    return null;
  }
}

function readableStyleSheetCss(): string[] {
  const cssTexts: string[] = [];
  const visitRules = (rules: CSSRuleList) => {
    for (const rule of rules) {
      cssTexts.push(rule.cssText);
      if ("cssRules" in rule) visitRules((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visitRules(sheet.cssRules);
    } catch {
      // Cross-origin sheets are opaque; the complete pinned fallback remains.
    }
  }
  return cssTexts;
}

function nativeUiIllustration(entry: { icon: string; kind: string; experimental?: boolean }): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.classList.add(
    "bb-ui-reference-native-illustration",
    `is-${entry.kind}`,
    ...(entry.experimental ? ["is-experimental"] : []),
  );
  svg.setAttribute("viewBox", "0 0 80 40");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NAMESPACE, "use");
  use.setAttribute("href", `${NATIVE_UI_ICONS_URL}#${entry.icon}`);
  svg.append(use);
  return svg;
}

function mountReferenceFrame({ signal }: { signal: AbortSignal }): () => void {
  const frame = element("section", "bb-ui-reference-frame");
  frame.setAttribute("role", "dialog");
  frame.setAttribute("aria-label", "BB UI reference");
  frame.hidden = true;

  const header = element("header", "bb-ui-reference-header");
  const heading = element("div", "bb-ui-reference-heading");
  const headerHint = element("small");
  heading.append(element("strong", "", "BB UI reference"), headerHint);
  const sectionNav = element("div", "bb-ui-reference-section-nav");
  sectionNav.setAttribute("role", "tablist");
  sectionNav.setAttribute("aria-label", "Reference section");
  const sectionButtons: HTMLButtonElement[] = [];
  const close = element("button", "bb-ui-reference-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close UI reference");
  header.append(heading, sectionNav, close);

  const mapPanel = element("section", "bb-ui-reference-map-panel");
  const mapLegend = element("img", "bb-ui-reference-map-legend");
  mapLegend.src = SURFACE_LEGEND_URL;
  mapLegend.alt = "Legend: gray is native BB UI, blue is an additive plugin surface, purple is a replaceable region, and orange is trusted page code";
  mapLegend.draggable = false;
  let mapLegendUnavailable = false;

  const mapViewport = element("figure", "bb-ui-reference-map-viewport");
  mapViewport.id = "bb-ui-reference-map-view";
  mapViewport.setAttribute("role", "tabpanel");
  mapViewport.tabIndex = 0;
  mapViewport.dataset.section = "1";
  const mapImage = element("img", "bb-ui-reference-map-image");
  mapImage.src = `${SURFACE_MAP_URL}-1`;
  mapImage.alt = "Annotated BB plugin UI surface map";
  mapImage.draggable = false;
  const mapError = element("figcaption", "bb-ui-reference-map-error", "Surface map unavailable");
  mapError.hidden = true;
  mapViewport.append(mapImage, mapError);

  const nativePanel = element("section", "bb-ui-reference-native-panel");
  nativePanel.id = "bb-ui-reference-native-ui";
  nativePanel.setAttribute("role", "tabpanel");
  nativePanel.tabIndex = 0;
  nativePanel.hidden = true;
  const nativeHeading = element("div", "bb-ui-reference-native-heading");
  const nativeHeadingCopy = element("div");
  nativeHeadingCopy.append(
    element("strong", "", "Reusable BB UI"),
    element("small", "", "Choose a host capability or vendor a version-matched registry component."),
  );
  const nativeUiCount = NATIVE_UI_GROUPS.reduce((count, group) => count + group.entries.length, 0);
  nativeHeading.append(nativeHeadingCopy, element("span", "bb-ui-reference-token-count", `${nativeUiCount} pieces`));
  const nativeIntro = element("p", "bb-ui-reference-native-intro", "Host-owned entries preserve BB behavior and lifecycle. Registry entries copy BB-themed source into your plugin, where you own future edits.");
  const nativeGroups = element("div", "bb-ui-reference-native-groups");
  for (const group of NATIVE_UI_GROUPS) {
    const groupSection = element("section", "bb-ui-reference-native-group");
    const groupHeading = element("header", "bb-ui-reference-native-group-heading");
    groupHeading.append(
      element("strong", "", group.title),
      element("small", "", group.description),
    );
    groupSection.append(groupHeading);

    for (const entry of group.entries) {
      const copyValue = entry.kind === "registry"
        ? `npx shadcn add ${entry.target}`
        : `import { ${entry.name} } from "${entry.target}";`;
      const entryButton = element("button", "bb-ui-reference-native-entry");
      entryButton.type = "button";
      entryButton.title = `Copy ${copyValue}`;
      const entryCopy = element("span", "bb-ui-reference-native-entry-copy");
      const entryName = element("strong", "", entry.name);
      const entryKind = element(
        "span",
        `bb-ui-reference-native-kind is-${entry.kind}${entry.experimental ? " is-experimental" : ""}`,
        entry.experimental ? "Experimental" : entry.kind === "host" ? "SDK" : "Registry",
      );
      const entryNameLine = element("span", "bb-ui-reference-native-name");
      entryNameLine.append(entryName, entryKind);
      entryCopy.append(
        entryNameLine,
        element("code", "", entry.target),
        element("small", "", entry.description),
      );
      entryButton.append(nativeUiIllustration(entry), entryCopy);
      entryButton.addEventListener("click", () => {
        void copyText(copyValue)
          .then(() => showStatus(`Copied ${entry.name}`))
          .catch(() => showStatus("Copy unavailable"));
      }, { signal });
      groupSection.append(entryButton);
    }
    nativeGroups.append(groupSection);
  }
  nativePanel.append(nativeHeading, nativeIntro, nativeGroups);

  let currentSection: (typeof SURFACE_MAP_SECTIONS)[number] = SURFACE_MAP_SECTIONS[0];
  const resetHeaderHint = () => {
    headerHint.textContent = `${currentSection.title} · fitted view · drag to compare`;
  };
  const selectReferenceSection = (sectionId: number | "native-ui") => {
    const native = sectionId === "native-ui";
    mapLegend.hidden = native || mapLegendUnavailable;
    mapViewport.hidden = native;
    nativePanel.hidden = !native;
    if (native) {
      headerHint.textContent = "Native UI · reusable pieces · click to copy";
      nativePanel.setAttribute("aria-labelledby", "bb-ui-reference-native-ui-tab");
    }
    if (!native) {
      const section = SURFACE_MAP_SECTIONS.find((item) => item.id === sectionId) ?? SURFACE_MAP_SECTIONS[0];
      currentSection = section;
      mapViewport.dataset.section = String(section.id);
      mapImage.src = `${SURFACE_MAP_URL}-${section.id}`;
      mapViewport.setAttribute("aria-labelledby", `bb-ui-reference-section-${section.id}`);
      resetHeaderHint();
    }
    for (const button of sectionButtons) {
      const selected = button.dataset.section === String(sectionId);
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  };

  for (const section of SURFACE_MAP_SECTIONS) {
    const button = element("button", "", section.tabLabel);
    button.type = "button";
    button.id = `bb-ui-reference-section-${section.id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", mapViewport.id);
    button.dataset.section = String(section.id);
    button.addEventListener("click", () => selectReferenceSection(section.id), { signal });
    button.addEventListener("keydown", (event) => {
      const currentIndex = sectionButtons.indexOf(button);
      const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (direction === 0) return;
      event.preventDefault();
      const nextButton = sectionButtons[(currentIndex + direction + sectionButtons.length) % sectionButtons.length];
      if (nextButton == null) return;
      selectReferenceSection(nextButton.dataset.section === "native-ui" ? "native-ui" : Number(nextButton.dataset.section));
      nextButton.focus();
    }, { signal });
    sectionButtons.push(button);
    sectionNav.append(button);
  }
  const nativeButton = element("button", "", "Native UI");
  nativeButton.type = "button";
  nativeButton.id = "bb-ui-reference-native-ui-tab";
  nativeButton.setAttribute("role", "tab");
  nativeButton.setAttribute("aria-controls", nativePanel.id);
  nativeButton.dataset.section = "native-ui";
  nativeButton.addEventListener("click", () => selectReferenceSection("native-ui"), { signal });
  nativeButton.addEventListener("keydown", (event) => {
    const currentIndex = sectionButtons.indexOf(nativeButton);
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const nextButton = sectionButtons[(currentIndex + direction + sectionButtons.length) % sectionButtons.length];
    if (nextButton == null) return;
    selectReferenceSection(nextButton.dataset.section === "native-ui" ? "native-ui" : Number(nextButton.dataset.section));
    nextButton.focus();
  }, { signal });
  sectionButtons.push(nativeButton);
  sectionNav.append(nativeButton);
  selectReferenceSection(1);
  mapPanel.append(mapLegend, mapViewport, nativePanel);

  const palettePanel = element("section", "bb-ui-reference-palette-panel");
  const paletteHeading = element("div", "bb-ui-reference-palette-heading");
  paletteHeading.append(
    element("strong", "", "Semantic colors"),
    element("small", "", "Live demonstrations · click to copy a token"),
  );
  const colors = element("div", "bb-ui-reference-colors");
  colors.setAttribute("aria-label", "Current theme semantic colors");
  const status = element("span", "bb-ui-reference-status");
  status.setAttribute("role", "status");

  const showStatus = (message: string) => {
    status.textContent = message;
    headerHint.textContent = message;
    window.setTimeout(() => {
      if (status.textContent === message) {
        status.textContent = "";
        if (nativePanel.hidden) resetHeaderHint();
        else headerHint.textContent = "Native UI · reusable pieces · click to copy";
      }
    }, 1200);
  };

  const discoveredVariables = discoverThemeTokenVariables(readableStyleSheetCss());
  const themeTokens = buildThemeTokens(discoveredVariables);
  const themeTokenGroups = groupThemeTokens(themeTokens);
  paletteHeading.append(element("span", "bb-ui-reference-token-count", `${themeTokens.length} tokens`));

  for (const group of themeTokenGroups) {
    const groupSection = element("section", "bb-ui-reference-color-group");
    groupSection.setAttribute("aria-labelledby", `bb-ui-reference-group-${group.id}`);
    const groupHeading = element("header", "bb-ui-reference-color-group-heading");
    const groupTitle = element("strong", "", group.title);
    groupTitle.id = `bb-ui-reference-group-${group.id}`;
    groupHeading.append(groupTitle, element("small", "", group.description));
    groupSection.append(groupHeading);

    for (const token of group.tokens) {
      const button = element("button", "bb-ui-reference-color");
      button.type = "button";
      button.title = `Copy ${token.variable}`;
      const swatch = element("span", "bb-ui-reference-swatch", token.kind === "text" || token.foreground ? "Aa" : "");
      if (token.kind === "border") {
        swatch.classList.add("is-boundary");
        swatch.style.borderColor = `var(${token.variable})`;
      } else if (token.kind === "ring") {
        swatch.classList.add("is-ring");
        swatch.style.boxShadow = `0 0 0 2px var(${token.variable})`;
      } else if (token.kind === "text") {
        swatch.classList.add("is-text");
        swatch.style.color = `var(${token.variable})`;
      } else {
        swatch.style.background = `var(${token.variable})`;
        if (token.foreground) swatch.style.color = `var(${token.foreground})`;
      }
      const names = element("span", "bb-ui-reference-color-copy");
      names.append(
        element("strong", "", token.role),
        element("code", "", token.variable),
        element("small", "", token.guidance),
      );
      button.append(swatch, names);
      button.addEventListener("click", () => {
        void copyText(token.variable)
          .then(() => showStatus(`Copied ${token.variable}`))
          .catch(() => showStatus("Copy unavailable"));
      }, { signal });
      groupSection.append(button);
    }
    colors.append(groupSection);
  }
  palettePanel.append(paletteHeading, colors);

  const body = element("div", "bb-ui-reference-body");
  body.append(mapPanel, palettePanel);
  frame.append(header, body, status);
  document.body.append(frame);

  mapImage.addEventListener("error", () => {
    mapError.hidden = false;
    mapViewport.classList.add("has-error");
  }, { signal });
  mapLegend.addEventListener("error", () => {
    mapLegendUnavailable = true;
    mapLegend.hidden = true;
  }, { signal });

  let position = readPosition();
  const clampPosition = (x: number, y: number) => ({
    x: Math.max(8, Math.min(x, window.innerWidth - frame.offsetWidth - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - frame.offsetHeight - 8)),
  });
  const place = () => {
    if (frame.hidden) return;
    position = clampPosition(position?.x ?? window.innerWidth - frame.offsetWidth - 20, position?.y ?? 68);
    frame.style.left = `${position.x}px`;
    frame.style.top = `${position.y}px`;
  };
  const setOpen = (open: boolean) => {
    frame.hidden = !open;
    if (open) requestAnimationFrame(place);
  };

  let drag: { pointerId: number; dx: number; dy: number } | null = null;
  header.addEventListener("pointerdown", (event) => {
    if (event.target instanceof HTMLButtonElement) return;
    const rect = frame.getBoundingClientRect();
    drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
  }, { signal });
  header.addEventListener("pointermove", (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    position = clampPosition(event.clientX - drag.dx, event.clientY - drag.dy);
    frame.style.left = `${position.x}px`;
    frame.style.top = `${position.y}px`;
  }, { signal });
  const finishDrag = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    if (position) {
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify(position));
      } catch {
        // The frame remains movable when browser storage is unavailable.
      }
    }
  };
  header.addEventListener("pointerup", finishDrag, { signal });
  header.addEventListener("pointercancel", finishDrag, { signal });

  close.addEventListener("click", () => setOpen(false), { signal });
  window.addEventListener(TOGGLE_EVENT, () => setOpen(frame.hidden), { signal });
  window.addEventListener("resize", place, { signal });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !frame.hidden) setOpen(false);
  }, { signal });

  return () => frame.remove();
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "ui-reference-frame", mount: mountReferenceFrame });
  app.slots.sidebarFooterAction({
    id: "ui-reference",
    title: "Open BB UI reference",
    icon: "CircleQuestion",
    run: () => {
      window.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
    },
  });
});
