import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

import "../../../../app.css";
import {
  mountCapturedSvgFixture,
  observeCapturedArtifactMutation,
  observeCapturedSvgAbort,
  observeCapturedSvgBudgets,
  observeImageLineageFailure,
  type CapturedSvgBrowserSession,
  type CapturedSvgBrowserThemeName,
} from "./captured-svg.fixture.tsx";
import {
  capturedSvgOptions,
  createCapturedSvgBrowserCase,
  type CapturedSvgBrowserCase,
} from "./captured-svg.browser-data.ts";

type BrowserCaseName = "normal" | "boundary";
type StandaloneCaseName = "mutation" | "budgets" | "abort" | "lineage-failure";

type CapturedSvgBrowserEntryApi = Readonly<{
  mount(name: BrowserCaseName): Promise<Readonly<{ name: BrowserCaseName; text: string }>>;
  ready(): Promise<unknown>;
  openMenu(): Promise<unknown>;
  changeTheme(name: CapturedSvgBrowserThemeName): Promise<unknown>;
  updateEdited(): Promise<unknown>;
  exportCapturedSvg(): Promise<unknown>;
  standalone(name: StandaloneCaseName): unknown;
  unmount(): unknown;
}>;

installTestPluginRuntime();
document.body.innerHTML = '<div id="captured-svg-fixed-host" style="width: 1200px; min-height: 1200px; display: block;"></div>';
document.body.style.width = "1200px";
document.body.style.minHeight = "1200px";
document.body.style.margin = "0";

let activeSession: CapturedSvgBrowserSession | null = null;
let activeCase: CapturedSvgBrowserCase | null = null;

function requireSession(): CapturedSvgBrowserSession {
  if (activeSession == null) throw new Error("Captured SVG browser entry has no mounted session.");
  return activeSession;
}

function requireCase(): CapturedSvgBrowserCase {
  if (activeCase == null) throw new Error("Captured SVG browser entry has no active authored case.");
  return activeCase;
}

const api: CapturedSvgBrowserEntryApi = {
  async mount(name) {
    if (activeSession != null) throw new Error("Captured SVG browser entry already has a mounted session.");
    const authored = createCapturedSvgBrowserCase(name);
    activeCase = authored;
    activeSession = await mountCapturedSvgFixture(authored.input);
    return Object.freeze({ name, text: activeSession.root.textContent ?? "" });
  },
  async openMenu() {
    return requireSession().openMenu();
  },
  async ready() {
    return requireSession().ready();
  },
  async changeTheme(name) {
    return requireSession().changeTheme(name);
  },
  async updateEdited() {
    return requireSession().update(requireCase().input.edited);
  },
  async exportCapturedSvg() {
    return requireSession().exportCapturedSvg();
  },
  standalone(name) {
    const authored = createCapturedSvgBrowserCase(name === "lineage-failure" ? "boundary" : "normal");
    if (name === "mutation") {
      return observeCapturedArtifactMutation({ capture: authored.capture, options: capturedSvgOptions() });
    }
    if (name === "budgets") {
      return observeCapturedSvgBudgets({
        capture: authored.capture,
        options: capturedSvgOptions(),
        consumerMaxSvgBytes: 1_000_000,
      });
    }
    if (name === "abort") {
      return observeCapturedSvgAbort({ capture: authored.capture, options: capturedSvgOptions() });
    }
    const failure = observeImageLineageFailure({ capture: authored.capture, options: capturedSvgOptions() });
    return Object.freeze({
      ...failure,
      boundaryCalibration: authored.boundaryCalibration ?? null,
    });
  },
  async unmount() {
    const session = requireSession();
    try {
      return await session.unmount();
    } finally {
      activeSession = null;
      activeCase = null;
    }
  },
};

Object.assign(globalThis, { __bbCapturedSvgBrowser: api });
document.body.dataset.capturedSvgReady = "1";
