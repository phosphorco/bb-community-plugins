import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

import "../../../../app.css";
import {
  createStaleEventBrowserCase,
  type StaleEventBrowserCase,
} from "./stale-event.browser-data.ts";
import {
  mountStaleEventFixture,
  type MountedStaleEventSession,
} from "./stale-event.fixture.tsx";

type StaleEventBrowserEntryApi = Readonly<{
  mount(): Promise<unknown>;
  ready(): Promise<unknown>;
  pointerReference(): Promise<unknown>;
  tableReference(): Promise<unknown>;
  focusFigureKeyboardAction(): Promise<unknown>;
  completeFigureKeyboardReference(): Promise<unknown>;
  update(phase: "B" | "C"): Promise<unknown>;
  unmount(): Promise<unknown>;
}>;

installTestPluginRuntime();
document.body.innerHTML = '<div id="stale-event-fixed-host" style="width: 1200px; min-height: 1200px; display: block;"></div>';
document.body.style.width = "1200px";
document.body.style.minHeight = "1200px";
document.body.style.margin = "0";

let activeSession: MountedStaleEventSession | null = null;
let activeCase: StaleEventBrowserCase | null = null;

function requireSession(): MountedStaleEventSession {
  if (activeSession == null) throw new Error("Stale event browser entry has no mounted session.");
  return activeSession;
}

function requireCase(): StaleEventBrowserCase {
  if (activeCase == null) throw new Error("Stale event browser entry has no authored case.");
  return activeCase;
}

const api: StaleEventBrowserEntryApi = {
  async mount() {
    if (activeSession != null) throw new Error("Stale event browser entry already has a mounted session.");
    activeCase = createStaleEventBrowserCase();
    activeSession = await mountStaleEventFixture(
      activeCase.a,
      {
        id: "analytics-ref_stale_event_a",
        token: "analytics-ref:v2:stale_event_a",
        label: "Stale event fixture reference",
        expiresAtMs: 1_700_100_000_000,
      },
    );
    return Object.freeze({ mounted: true });
  },
  async ready() {
    return requireSession().ready();
  },
  async pointerReference() {
    return requireSession().pointerReference();
  },
  async tableReference() {
    return requireSession().tableReference();
  },
  async focusFigureKeyboardAction() {
    return requireSession().focusFigureKeyboardAction();
  },
  async completeFigureKeyboardReference() {
    return requireSession().completeFigureKeyboardReference();
  },
  async update(phase) {
    const session = requireSession();
    const authored = requireCase();
    return session.updateWithBoundary(phase, phase === "B" ? authored.b : authored.c);
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

Object.assign(globalThis, { __bbStaleEventBrowser: api });
document.body.dataset.staleEventReady = "1";
