import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { appFixture } from "./app-fixture.ts";
import { TEMPLATES_CHANGED } from "../rpc-contract.ts";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://templates.test/",
  pretendToBeVisual: true,
});
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "MouseEvent",
  "Node",
  "MutationObserver",
  "localStorage",
  "sessionStorage",
] as const) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value:
      name === "window"
        ? dom.window
        : name === "document"
          ? dom.window.document
          : dom.window[name],
  });
}
for (const [name, value] of Object.entries({
  indexedDB,
  IDBKeyRange,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}
Object.defineProperty(dom.window.HTMLElement.prototype, "showPopover", {
  configurable: true,
  value: function (this: HTMLElement) {
    this.style.display = "block";
  },
});
Object.defineProperty(dom.window.HTMLElement.prototype, "hidePopover", {
  configurable: true,
  value: function (this: HTMLElement) {
    this.style.display = "none";
  },
});
const { act } = await import("react");
const { fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } =
  await import("@get-bb/plugin-sdk/testing/app");
const app = await loadPluginApp(() => import("../app.tsx"));
afterAll(() => {
  dom.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 350));
async function setup(
  panel = false,
  prepare?: (fixture: Awaited<ReturnType<typeof appFixture>>) => void,
) {
  // Each fresh server fixture is a distinct instance. Remounts within a test
  // reuse that fixture, including its real durable browser recovery storage.
  const fixture = await appFixture(`templates-app-${crypto.randomUUID()}`);
  prepare?.(fixture);
  const slot = panel
    ? renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        { pluginId: "new-thread-templates", rpc: fixture.handlers },
      )
    : renderSlot(
        app.homepageSections[0]!,
        { projectId: "project-a" },
        { pluginId: "new-thread-templates", rpc: fixture.handlers },
      );
  const stop = fixture.wire.onRealtime((channel, payload) => {
    void slot.behavior.emitRealtime(channel, payload);
  });
  return {
    fixture,
    slot,
    async close() {
      stop();
      slot.lifecycle.unmount();
      await act(async () => {});
      await fixture.dispose();
    },
  };
}
async function managementReady(slot: ReturnType<typeof renderSlot>) {
  await slot.findByRole("button", { name: "+ New template" });
  await waitFor(() =>
    expect(
      (
        slot.getByRole("button", {
          name: "+ New template",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
}
async function openReview(slot: ReturnType<typeof renderSlot>) {
  await slot.findByRole("button", { name: /(?:Review a PR|PR Review)/ });
  await act(async () => {
    slot.getByRole("button", { name: /(?:Review a PR|PR Review)/ }).click();
  });
  await slot.findByLabelText(/Pull request URL/);
}
async function fillReview(slot: ReturnType<typeof renderSlot>) {
  await waitFor(() =>
    expect(
      (slot.getByLabelText(/Pull request URL/) as HTMLInputElement).disabled,
    ).toBe(false),
  );
  await act(async () => {
    const subject = slot.queryByLabelText(/Main change or review goal/);
    if (subject)
      fireEvent.change(subject, { target: { value: "Identity consistency" } });
    fireEvent.change(slot.getByLabelText(/Pull request URL/), {
      target: { value: "https://example.test/pull/42" },
    });
  });
  await act(pause);
  await waitFor(() =>
    expect(
      slot
        .getByRole("button", { name: "Start thread" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
}

function seedSucceeded(
  fixture: Awaited<ReturnType<typeof appFixture>>,
  id: string,
) {
  const revision = fixture.entries.find(
    (entry) => entry.id === "review-pr",
  )!.published!;
  const inputs = {
    pr_url: "https://example.test/pull/completed",
    subject: "Retained completed subject",
    focus: "Retained original inputs",
  };
  const nativeSubmission: import("../native-submission.ts").NativeSubmission = {
    projectId: "project-a",
    providerId: "provider-a",
    model: "model-a",
    reasoningLevel: "medium",
    permissionMode: "auto",
    executionInputSources: {},
    environment: { type: "project-default" },
    input: [{ type: "text", text: "Completed native request", mentions: [] }],
  };
  const status: import("../rpc-contract.ts").LaunchStatus = {
    operationId: id,
    templateId: revision.templateId,
    revision: revision.revision,
    phase: "succeeded",
    projectId: "project-a",
    threadId: "previous-confirmed-thread",
    message: "Thread started",
    retryable: false,
    actor: fixture.context.actor,
    inputs,
    nativeAttribution: "plugin-origin",
    createdAt: 1,
    updatedAt: 2,
  };
  fixture.seedReceipt(status, revision, nativeSubmission);
  fixture.seedPersonal({
    inputs,
    projectId: "project-a",
    operationId: id,
    revision: revision.revision,
    nativeOperation: {
      templateId: revision.templateId,
      revision: revision.revision,
      inputs,
      nativeSubmission,
    },
  });
}

test("restored succeeded native operation never redirects and only becomes reusable after acknowledged scoped cleanup", async () => {
  const id = crypto.randomUUID();
  let held!: ReturnType<
    Awaited<ReturnType<typeof appFixture>>["wire"]["holdSaves"]
  >;
  const t = await setup(false, (fixture) => {
    seedSucceeded(fixture, id);
    held = fixture.wire.holdSaves();
  });
  try {
    await openReview(t.slot);
    await held.reached;
    await t.slot.findByRole("button", { name: "Open thread" });
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    expect((await t.fixture.readPersonal())?.operationId).toBe(id);
    expect(
      (await t.fixture.readPersonal())?.nativeOperation?.nativeSubmission
        .input[0]?.type,
    ).toBe("text");
    expect(
      (
        t.slot.getByRole("button", {
          name: "Start thread",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(t.fixture.wire.saveInputs).toHaveLength(1);
    await act(async () => {
      held.release();
    });
    await waitFor(async () =>
      expect((await t.fixture.readPersonal())?.operationId).toBeUndefined(),
    );
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Start thread",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect((await t.fixture.readPersonal())?.nativeOperation).toBeUndefined();
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    await act(async () => {
      t.slot.getByRole("button", { name: "‹ All templates" }).click();
    });
    await openReview(t.slot);
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Start thread",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      (t.slot.getByLabelText(/Main change or review goal/) as HTMLInputElement)
        .value,
    ).toBe("Retained completed subject");
    expect(t.slot.queryByRole("button", { name: "Open thread" })).toBeNull();
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    await act(pause);
    await act(async () => {
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
    await waitFor(() =>
      expect(
        t.slot.inspection.navigateCalls.filter(
          (call) => call.method === "toThread",
        ),
      ).toHaveLength(1),
    );
    expect(
      (
        t.fixture.calls.find((call) => call.method === "launch")!.input as {
          operationId: string;
        }
      ).operationId,
    ).not.toBe(id);
    expect((await t.fixture.readPersonal())?.operationId).toBeUndefined();
  } finally {
    held.release();
    await t.close();
  }
});

test("journal and active RPC completion share one cleanup and active navigation waits for its acknowledgement", async () => {
  const t = await setup();
  let releaseLaunch = () => {},
    releaseCleanup = () => {};
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    releaseLaunch = t.fixture.holdResponse("launch");
    await act(async () => {
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
    const pending = (await t.fixture.readPersonal())!;
    const savesBeforeCleanup = t.fixture.wire.saveInputs.length;
    const held = t.fixture.wire.holdSaves();
    releaseCleanup = held.release;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await held.reached;
    await act(async () => {
      releaseLaunch();
    });
    await act(pause);
    expect(t.fixture.wire.saveInputs).toHaveLength(savesBeforeCleanup + 1);
    expect((await t.fixture.readPersonal())?.operationId).toBe(
      pending.operationId,
    );
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    await act(async () => {
      releaseCleanup();
    });
    await waitFor(() =>
      expect(
        t.slot.inspection.navigateCalls.filter(
          (call) => call.method === "toThread",
        ),
      ).toHaveLength(1),
    );
    expect((await t.fixture.readPersonal())?.operationId).toBeUndefined();
    expect(t.fixture.wire.saveInputs).toHaveLength(savesBeforeCleanup + 1);
    expect(t.fixture.flags.launchCount).toBe(1);
  } finally {
    releaseLaunch();
    releaseCleanup();
    await t.close();
  }
});

test("restored success with lost cleanup response offers confirmed receipt and recovers without passive navigation", async () => {
  const id = crypto.randomUUID();
  const t = await setup(false, (fixture) => {
    seedSucceeded(fixture, id);
    fixture.wire.loseNextSaveResponse();
  });
  try {
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Reconnect inputs" });
    expect(t.slot.getByRole("button", { name: "Open thread" })).toBeTruthy();
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
    await act(async () => {
      t.slot.getByRole("button", { name: "Reconnect inputs" }).click();
    });
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Start thread",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect((await t.fixture.readPersonal())?.operationId).toBeUndefined();
    await waitFor(() =>
      expect(
        t.slot.queryByText(/Personal inputs could not finish saving/),
      ).toBeNull(),
    );
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    await act(async () => {
      t.slot.getByRole("button", { name: "Open thread" }).click();
    });
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(1);
  } finally {
    await t.close();
  }
});

test("held completed-reference cleanup cannot navigate or clear another current owner's operation after switch and unmount", async () => {
  const old = crypto.randomUUID(),
    next = crypto.randomUUID();
  let held!: ReturnType<
    Awaited<ReturnType<typeof appFixture>>["wire"]["holdSaves"]
  >;
  const t = await setup(false, (fixture) => {
    seedSucceeded(fixture, old);
    held = fixture.wire.holdSaves();
  });
  try {
    await openReview(t.slot);
    await held.reached;
    await act(async () => {
      t.fixture.wire.switchActor("bea");
      t.fixture.seedPersonal({
        inputs: { subject: "Bea work" },
        projectId: "project-b",
        operationId: next,
        revision: 1,
      });
    });
    await waitFor(() =>
      expect(
        (
          t.slot.getByLabelText(
            /Main change or review goal/,
          ) as HTMLInputElement
        ).value,
      ).toBe("Bea work"),
    );
    t.slot.lifecycle.unmount();
    await act(async () => {
      held.release();
    });
    expect((await t.fixture.readPersonal())?.operationId).toBe(next);
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    held.release();
    await t.close();
  }
});

test("late completed-reference cleanup never overwrites a newer operation from the same owner", async () => {
  const old = crypto.randomUUID(),
    next = crypto.randomUUID();
  let held!: ReturnType<
    Awaited<ReturnType<typeof appFixture>>["wire"]["holdSaves"]
  >;
  const t = await setup(false, (fixture) => {
    seedSucceeded(fixture, old);
    held = fixture.wire.holdSaves();
  });
  try {
    await openReview(t.slot);
    await held.reached;
    const updated = {
      inputs: {
        subject: "Newer same-owner work",
        pr_url: "https://example.test/pull/newer",
      },
      projectId: "project-b",
      operationId: next,
      revision: 1,
    };
    await act(async () => {
      t.fixture.wire.invalidateExternally(t.fixture.personalAddress(), updated);
      held.release();
    });
    await t.slot.findByRole("button", { name: "Use saved inputs" });
    await act(async () => {
      t.slot.getByRole("button", { name: "Use saved inputs" }).click();
    });
    await waitFor(() =>
      expect(
        (
          t.slot.getByLabelText(
            /Main change or review goal/,
          ) as HTMLInputElement
        ).value,
      ).toBe(updated.inputs.subject),
    );
    expect((await t.fixture.readPersonal())?.operationId).toBe(next);
    expect((await t.fixture.readPersonal())?.inputs).toEqual(updated.inputs);
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    held.release();
    await t.close();
  }
});

test("native slots register icon, searchable chooser, details/back and separate persistent personal drafts", async () => {
  const t = await setup();
  try {
    expect(app.homepageSections).toHaveLength(1);
    expect(app.navPanels).toHaveLength(1);
    expect(app.composerCustomizations).toHaveLength(0);
    await t.slot.findByRole("button", { name: /(?:Review a PR|PR Review)/ });
    await act(async () => {
      fireEvent.change(t.slot.getByRole("searchbox"), {
        target: { value: "no-match" },
      });
    });
    expect(t.slot.getByText("No matching templates.")).toBeTruthy();
    await act(async () => {
      fireEvent.change(t.slot.getByRole("searchbox"), {
        target: { value: "" },
      });
    });
    await openReview(t.slot);
    await fillReview(t.slot);
    await act(async () => {
      fireEvent.change(
        t.slot.getByLabelText(/(?:Focus|Important context or concerns)/),
        {
          target: { value: "Retained focus\nsecond line" },
        },
      );
    });
    await act(async () => {
      t.slot.getByRole("button", { name: "Details" }).click();
    });
    expect(t.slot.getByText("First message")).toBeTruthy();
    await waitFor(() =>
      expect(!!t.slot.queryByText("Saving personal inputs…")).toBe(false),
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "‹ All templates" }).click();
    });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("PR Review"),
    );
    await openReview(t.slot);
    await waitFor(() =>
      expect(
        (
          t.slot.getByLabelText(
            /(?:Focus|Important context or concerns)/,
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("Retained focus\nsecond line"),
    );
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("Details toggles one resolved destination summary and secondary source without duplication", async () => {
  const t = await setup();
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    await t.slot.findByLabelText("Final launch destination");
    expect(t.slot.getAllByLabelText("Final launch destination")).toHaveLength(
      1,
    );
    expect(t.slot.queryByText("/workspace/fixture")).toBeNull();
    await act(async () => {
      t.slot.getByRole("button", { name: "Details" }).click();
    });
    expect(t.slot.getAllByLabelText("Final launch destination")).toHaveLength(
      1,
    );
    expect(t.slot.getByText("/workspace/fixture")).toBeTruthy();
    expect(t.slot.getByText("First message")).toBeTruthy();
    await act(async () => {
      t.slot.getByRole("button", { name: "Hide details" }).click();
    });
    expect(t.slot.getAllByLabelText("Final launch destination")).toHaveLength(
      1,
    );
    expect(t.slot.queryByText("/workspace/fixture")).toBeNull();
  } finally {
    await t.close();
  }
});

test("required validation retains values and focuses first invalid field; textarea Enter does not send; Ctrl Enter sends once", async () => {
  const t = await setup();
  try {
    await openReview(t.slot);
    await act(async () => {
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        t.slot.getByLabelText(/Pull request URL/),
      ),
    );
    expect(t.slot.getAllByText("Required").length).toBeGreaterThan(0);
    await fillReview(t.slot);
    const focus = t.slot.getByLabelText(
      /(?:Focus|Important context or concerns)/,
    );
    await act(async () => {
      fireEvent.change(focus, { target: { value: "Keep this" } });
      fireEvent.keyDown(focus, { key: "Enter" });
    });
    expect(t.fixture.flags.launchCount).toBe(0);
    await act(pause);
    await act(async () => {
      fireEvent.keyDown(focus, { key: "Enter", ctrlKey: true });
      fireEvent.keyDown(focus, { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
    expect(
      t.fixture.calls.find((c) => c.method === "launch")?.input,
    ).toMatchObject({
      revision: 1,
      inputs: { focus: "Keep this" },
      projectId: "project-a",
    });
    await waitFor(() =>
      expect(
        t.slot.inspection.navigateCalls.some((c) => c.method === "toThread"),
      ).toBe(true),
    );
  } finally {
    await t.close();
  }
});

test("unknown launch survives remount, keeps captured snapshot and never resends on reconnect or unrelated reads", async () => {
  const t = await setup();
  try {
    t.fixture.flags.launchMode = "lost";
    await openReview(t.slot);
    await fillReview(t.slot);
    await act(async () => {
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
    await t.slot.findByRole("button", { name: "Check launch status" });
    await act(async () => {
      t.slot.getByRole("button", { name: "‹ All templates" }).click();
    });
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Check launch status" });
    expect(
      t.slot
        .getByRole("button", { name: "Start thread" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await t.slot.behavior.setRealtimeConnectionState("reconnecting");
    await t.slot.behavior.setRealtimeConnectionState("connected");
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    expect(t.fixture.flags.launchCount).toBe(1);
    expect(
      t.slot.inspection.navigateCalls.filter((c) => c.method === "toThread"),
    ).toHaveLength(0);
    const [id, status] = [...t.fixture.launches][0]!;
    t.fixture.launches.set(id, {
      ...status,
      phase: "succeeded",
      threadId: "recovered-thread",
      message: "Confirmed receipt",
    });
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await t.slot.findByRole("button", { name: "Open thread" });
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Start thread",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(0);
    await act(async () => {
      t.slot.getByRole("button", { name: "Open thread" }).click();
    });
    expect(
      t.slot.inspection.navigateCalls.filter(
        (call) => call.method === "toThread",
      ),
    ).toHaveLength(1);
    expect(t.fixture.flags.launchCount).toBe(1);
    expect(t.slot.queryByText(/Response lost/)).toBeNull();
  } finally {
    await t.close();
  }
});

test("same authoritative catalog recovery clears error with unchanged content; success stays quiet and teardown stops resources", async () => {
  const t = await setup();
  try {
    await t.slot.findByRole("button", { name: /(?:Review a PR|PR Review)/ });
    t.fixture.flags.catalogError = true;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await t.slot.findByText(/Catalog temporarily unavailable/);
    expect(
      t.slot.getByRole("button", { name: /(?:Review a PR|PR Review)/ }),
    ).toBeTruthy();
    t.fixture.flags.catalogError = false;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await waitFor(() =>
      expect(t.slot.queryByText(/Catalog temporarily unavailable/)).toBeNull(),
    );
    const count = t.fixture.calls.length;
    await act(pause);
    expect(t.fixture.calls.length).toBe(count);
    t.slot.lifecycle.unmount();
    const disposed = t.fixture.calls.length;
    await act(pause);
    expect(t.fixture.calls.length).toBe(disposed);
  } finally {
    await t.close();
  }
});

test("editor tabs, preview, unknown-token publication error and shared save failure preserve last published revision", async () => {
  localStorage.clear();
  const t = await setup(true);
  try {
    await managementReady(t.slot);
    const edits = t.slot.getAllByRole("button", { name: "Edit" });
    await act(async () => {
      edits[0]!.click();
    });
    const baseline = t.fixture.entries[0]!.published!.definition.promptTemplate;
    for (const name of ["Project", "Model", "Prompt", "Fields"]) {
      await act(async () => {
        t.slot.getByRole("tab", { name }).click();
      });
      expect(
        t.slot.getByRole("tab", { name }).getAttribute("aria-selected"),
      ).toBe("true");
    }
    await act(async () => {
      t.slot.getByRole("tab", { name: "Prompt" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("First message template"), {
        target: { value: "Unknown {{missing}}" },
      });
      t.slot.getByRole("button", { name: "Publish" }).click();
    });
    await t.slot.findByText(/Unknown field missing/);
    expect(t.fixture.entries[0]!.published!.definition.promptTemplate).toBe(
      baseline,
    );
    expect(t.fixture.calls.filter((c) => c.method === "publish")).toHaveLength(
      0,
    );
    await act(async () => {
      t.slot
        .getByRole("button", { name: "Preview with sample inputs" })
        .click();
    });
    expect(t.slot.getByRole("region", { name: "Sample preview" })).toBeTruthy();
    expect(t.fixture.flags.launchCount).toBe(0);
    t.fixture.flags.saveError = true;
    await act(async () => {
      t.slot.getByRole("button", { name: "Save draft" }).click();
    });
    await t.slot.findByText("Shared draft write failed");
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    expect(t.slot.getByText("Shared draft write failed")).toBeTruthy();
  } finally {
    await t.close();
  }
});

test("unsaved edits guard Back and restore from captured-owner checkpoint after shell-like remount", async () => {
  localStorage.clear();
  const t = await setup(true);
  try {
    await managementReady(t.slot);
    await act(async () => {
      t.slot.getAllByRole("button", { name: "Edit" })[0]!.click();
    });
    await t.slot.findByLabelText("Name");
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Name"), {
        target: { value: "Unfinished personal editor work" },
      });
    });
    await act(async () => {
      t.slot.getByRole("button", { name: "‹ All templates" }).click();
    });
    expect(
      t.slot.getByRole("dialog", { name: "Unsaved template changes" }),
    ).toBeTruthy();
    await act(async () => {
      t.slot.getByRole("button", { name: "Stay" }).click();
    });
    expect((t.slot.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Unfinished personal editor work",
    );
    t.slot.lifecycle.unmount();
    const again = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    try {
      await managementReady(again);
      await act(async () => {
        again.getAllByRole("button", { name: "Edit" })[0]!.click();
      });
      await again.findByRole("button", { name: "Restore unfinished edits" });
      await act(async () => {
        again.getByRole("button", { name: "Restore unfinished edits" }).click();
      });
      expect((again.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "Unfinished personal editor work",
      );
      expect(
        t.fixture.calls.filter((c) => c.method === "saveDraft"),
      ).toHaveLength(0);
    } finally {
      again.lifecycle.unmount();
    }
  } finally {
    await t.close();
  }
});

test("strict public RPC rejects own undefined keys and supports projectId absence", async () => {
  const f = await appFixture();
  try {
    const definition = f.entries.find((e) => e.id === "review-pr")!.published!
      .definition;
    await expect(
      f.handlers.preview!({
        definition,
        inputs: {
          pr_url: "https://example.test/pull/1",
          ...(definition.fields.some((field) => field.key === "subject")
            ? { subject: "Identity review" }
            : {}),
        },
        projectId: undefined,
      }),
    ).rejects.toThrow();
    const response = await f.handlers.preview!({
      definition,
      inputs: {
        pr_url: "https://example.test/pull/1",
        ...(definition.fields.some((field) => field.key === "subject")
          ? { subject: "Identity review" }
          : {}),
      },
    });
    expect(response.effects.projectName).toBe("Fixture project");
  } finally {
    await f.dispose();
  }
});

test("purpose cards request supported public native icons", async () => {
  const t = await setup(false, (f) => f.addLegacyFixtures());
  try {
    await t.slot.findByRole("button", { name: /PR Review/ });
    const names = [...t.slot.container.querySelectorAll("[data-icon]")].map(
      (node) => node.getAttribute("data-icon"),
    );
    for (const name of [
      "MessageSquare",
      "GitPullRequest",
      "Bug",
      "Explore",
      "Edit",
    ])
      expect(names).toContain(name);
    expect(names).not.toContain("Zap");
  } finally {
    await t.close();
  }
});

test("compact gallery removes directory and recovery chrome; Manage stays reachable with an empty catalog", async () => {
  const t = await setup(false, (fixture) => {
    for (const entry of fixture.entries) entry.published = null;
  });
  try {
    await t.slot.findByText("No published templates yet.");
    expect(t.slot.queryByText(/A starting point/)).toBeNull();
    expect(t.slot.queryByRole("button", { name: "Inspect drafts" })).toBeNull();
    expect(
      t.slot.queryByRole("button", { name: /Recent launches/ }),
    ).toBeNull();
    expect(t.slot.queryByRole("heading", { name: "Templates" })).toBeNull();
    await act(async () => {
      t.slot.getByRole("button", { name: "Manage" }).click();
    });
    expect(
      t.slot.inspection.navigateCalls.some(
        (call) => call.method === "toPluginPanel",
      ),
    ).toBe(true);
  } finally {
    await t.close();
  }
});

test("known rejected launch unlocks deliberate new operation; unknown is still check-only", async () => {
  const t = await setup();
  try {
    t.fixture.flags.launchMode = "failed";
    await openReview(t.slot);
    await fillReview(t.slot);
    await act(async () => {
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await t.slot.findByRole("button", { name: "Retry preparation" });
    expect(
      t.slot.getByRole("button", { name: "Edit inputs for a new launch" }),
    ).toBeTruthy();
    const first = t.fixture.calls.find((c) => c.method === "launch")!.input as {
      operationId: string;
    };
    await act(async () => {
      t.slot
        .getByRole("button", { name: "Edit inputs for a new launch" })
        .click();
    });
    await waitFor(() =>
      expect(
        (t.slot.getByLabelText(/Pull request URL/) as HTMLInputElement)
          .disabled,
      ).toBe(false),
    );
    await act(async () => {
      fireEvent.change(
        t.slot.getByLabelText(/(?:Focus|Important context or concerns)/),
        {
          target: { value: "New intent" },
        },
      );
    });
    await act(pause);
    t.fixture.flags.launchMode = "success";
    await act(async () => {
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await waitFor(() => expect(t.fixture.flags.launchCount).toBe(2));
    const launches = t.fixture.calls.filter((c) => c.method === "launch");
    expect(
      (launches[1]!.input as { operationId: string }).operationId,
    ).not.toBe(first.operationId);
  } finally {
    await t.close();
  }
});

test("unsaved NEW template is discoverable after shell exit with original id and zero shared writes", async () => {
  localStorage.clear();
  const t = await setup(true);
  try {
    await managementReady(t.slot);
    await act(async () => {
      t.slot.getByRole("button", { name: "+ New template" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Name"), {
        target: { value: "Brand new unfinished template" },
      });
      t.slot.getByRole("button", { name: "+ Add field" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Stable key"), {
        target: { value: "goal" },
      });
      t.slot.getByRole("tab", { name: "Prompt" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("First message template"), {
        target: { value: "New {{goal}}" },
      });
    });
    const keys = Object.keys(localStorage).filter((k) =>
      k.startsWith("new-thread-templates:editor:v1:"),
    );
    const originalId = JSON.parse(
      keys[0]!.slice("new-thread-templates:editor:v1:".length),
    )[1];
    t.slot.lifecycle.unmount();
    const again = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    try {
      await again.findByRole("button", { name: "Resume unfinished template" });
      await act(async () => {
        again
          .getByRole("button", { name: "Resume unfinished template" })
          .click();
      });
      expect((again.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "Brand new unfinished template",
      );
      await act(async () => {
        again.getByRole("tab", { name: "Prompt" }).click();
      });
      expect(
        (again.getByLabelText("First message template") as HTMLTextAreaElement)
          .value,
      ).toBe("New {{goal}}");
      expect(
        t.fixture.calls.filter((c) => c.method === "saveDraft"),
      ).toHaveLength(0);
      await act(async () => {
        again.getByRole("button", { name: "Save draft" }).click();
      });
      await waitFor(() =>
        expect(
          t.fixture.calls.filter((c) => c.method === "saveDraft"),
        ).toHaveLength(1),
      );
      expect(
        (
          t.fixture.calls.find((c) => c.method === "saveDraft")!.input as {
            definition: { id: string };
          }
        ).definition.id,
      ).toBe(originalId);
    } finally {
      again.lifecycle.unmount();
    }
  } finally {
    await t.close();
  }
});

test("delayed launch response cannot navigate after actual actor changes", async () => {
  const t = await setup();
  let release = () => {};
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    release = t.fixture.holdResponse("launch");
    await act(async () => {
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
    await act(async () => {
      t.fixture.wire.switchActor("bea");
    });
    await act(async () => {
      release();
    });
    expect(
      t.slot.inspection.navigateCalls.filter((c) => c.method === "toThread"),
    ).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(1);
  } finally {
    release();
    await t.close();
  }
});

test("delayed shared editor saves do not publish or select stale work after identity change", async () => {
  localStorage.clear();
  const t = await setup(true);
  let release = () => {};
  try {
    await managementReady(t.slot);
    await act(async () => {
      t.slot.getAllByRole("button", { name: "Edit" })[0]!.click();
    });
    release = t.fixture.holdResponse("saveDraft");
    await act(async () => {
      t.slot.getByRole("button", { name: "Publish" }).click();
    });
    await waitFor(() =>
      expect(t.fixture.calls.some((c) => c.method === "saveDraft")).toBe(true),
    );
    await act(async () => {
      t.fixture.wire.switchActor("bea");
    });
    await act(async () => {
      release();
    });
    await waitFor(() => expect(t.slot.queryByLabelText("Name")).toBeNull());
    expect(t.fixture.calls.filter((c) => c.method === "publish")).toHaveLength(
      0,
    );
    expect(t.slot.queryByText("Draft saved.")).toBeNull();
  } finally {
    release();
    await t.close();
  }
});

test("number authoring never poisons recovery through partial negative edits and corrected ranges survive remount", async () => {
  localStorage.clear();
  const t = await setup(true);
  try {
    await managementReady(t.slot);
    await act(async () => {
      t.slot.getByRole("button", { name: "+ New template" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Name"), {
        target: { value: "Numbers recover" },
      });
      t.slot.getByRole("button", { name: "+ Add field" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Type"), {
        target: { value: "number" },
      });
    });
    await act(async () => {
      t.slot.getByText("Help, defaults and validation").click();
    });
    for (const label of ["Default value", "Minimum", "Maximum"]) {
      await act(async () => {
        fireEvent.change(t.slot.getByLabelText(label), {
          target: { value: "-" },
        });
      });
      await act(async () => {
        fireEvent.change(t.slot.getByLabelText(label), {
          target: { value: "1" },
        });
      });
    }
    expect(t.slot.queryByText(/unreadable|could not be read/)).toBeNull();
    const raw = JSON.parse(
      localStorage.getItem(
        Object.keys(localStorage).find((k) =>
          k.startsWith("new-thread-templates:editor:v1:"),
        )!,
      )!,
    );
    expect(raw.definition.fields[0]).toMatchObject({
      default: 1,
      validation: { min: 1, max: 1 },
    });
    t.slot.lifecycle.unmount();
    const again = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    try {
      await again.findByRole("button", { name: "Resume unfinished template" });
      await act(async () => {
        again
          .getByRole("button", { name: "Resume unfinished template" })
          .click();
      });
      expect(
        (again.getByLabelText("Default value") as HTMLInputElement).value,
      ).toBe("1");
      expect((again.getByLabelText("Minimum") as HTMLInputElement).value).toBe(
        "1",
      );
      expect((again.getByLabelText("Maximum") as HTMLInputElement).value).toBe(
        "1",
      );
    } finally {
      again.lifecycle.unmount();
    }
  } finally {
    await t.close();
  }
});

test("unfinished numeric defaults and bounds survive collapse and checkpoint remount and block writes until corrected", async () => {
  localStorage.clear();
  const t = await setup(true);
  let again: ReturnType<typeof renderSlot> | null = null;
  try {
    await managementReady(t.slot);
    await act(async () => {
      t.slot.getByRole("button", { name: "+ New template" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Name"), {
        target: { value: "Unfinished numeric work" },
      });
      t.slot.getByRole("button", { name: "+ Add field" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Type"), {
        target: { value: "number" },
      });
      t.slot.getByText("Help, defaults and validation").click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Default value"), {
        target: { value: "2" },
      });
      fireEvent.change(t.slot.getByLabelText("Minimum"), {
        target: { value: "0" },
      });
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Default value"), {
        target: { value: "-" },
      });
      fireEvent.change(t.slot.getByLabelText("Minimum"), {
        target: { value: "1e" },
      });
    });
    await act(async () => {
      t.slot.getByRole("button", { name: /^New field Number/ }).click();
    });
    await act(async () => {
      t.slot.getByRole("button", { name: /^New field Number/ }).click();
    });
    expect(
      (t.slot.getByLabelText("Default value") as HTMLInputElement).value,
    ).toBe("-");
    expect((t.slot.getByLabelText("Minimum") as HTMLInputElement).value).toBe(
      "1e",
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "Save draft" }).click();
    });
    expect(
      t.fixture.calls.filter((call) => call.method === "saveDraft"),
    ).toHaveLength(0);
    await waitFor(() =>
      expect(
        document.activeElement === t.slot.getByLabelText("Default value"),
      ).toBe(true),
    );
    const checkpointKey = Object.keys(localStorage).find((key) =>
      key.startsWith("new-thread-templates:editor:v1:"),
    )!;
    const checkpoint = JSON.parse(localStorage.getItem(checkpointKey)!);
    expect(checkpoint.definition.fields[0]).toMatchObject({
      default: 2,
      validation: { min: 0 },
    });
    expect(checkpoint.numericText).toMatchObject({
      "fields.0.default": "-",
      "fields.0.min": "1e",
    });
    expect(JSON.stringify(checkpoint.definition.fields)).not.toContain("null");
    t.slot.lifecycle.unmount();
    again = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    await managementReady(again);
    await act(async () => {
      again!
        .getByRole("button", { name: "Resume unfinished template" })
        .click();
    });
    await act(async () => {
      again!.getByText("Help, defaults and validation").click();
    });
    expect(
      (again.getByLabelText("Default value") as HTMLInputElement).value,
    ).toBe("-");
    expect((again.getByLabelText("Minimum") as HTMLInputElement).value).toBe(
      "1e",
    );
    await act(async () => {
      again!.getByRole("button", { name: "Publish" }).click();
    });
    expect(
      t.fixture.calls.filter((call) => call.method === "publish"),
    ).toHaveLength(0);
    await act(async () => {
      fireEvent.change(again!.getByLabelText("Default value"), {
        target: { value: "3" },
      });
      fireEvent.change(again!.getByLabelText("Minimum"), {
        target: { value: "1" },
      });
    });
    expect(
      again.queryByText(
        "Complete the unfinished number before saving or publishing.",
      ),
    ).toBeNull();
    await act(async () => {
      again!.getByRole("tab", { name: "Prompt" }).click();
    });
    await act(async () => {
      fireEvent.change(again!.getByLabelText("First message template"), {
        target: { value: "Use {{field_1}}." },
      });
      again!.getByRole("button", { name: "Publish" }).click();
    });
    await waitFor(() =>
      expect(again!.queryByText(/ · unsaved changes/)).toBeNull(),
    );
    expect(
      t.fixture.entries.find(
        (entry) =>
          entry.published?.definition.name === "Unfinished numeric work",
      )?.published?.definition.fields[0]?.default,
    ).toBe(3);
    expect(localStorage.getItem(checkpointKey)).toBeNull();
  } finally {
    again?.lifecycle.unmount();
    await t.close();
  }
});

test("held-save Back and full unmount preserve input recovery and close every IndexedDB connection", async () => {
  const originalOpen = indexedDB.open.bind(indexedDB),
    live = new Set<IDBDatabase>();
  let opened = 0,
    closed = 0;
  indexedDB.open = ((...args: Parameters<IDBFactory["open"]>) => {
    const request = originalOpen(...args);
    request.addEventListener("success", () => {
      const database = request.result;
      opened++;
      live.add(database);
      const close = database.close.bind(database);
      database.close = () => {
        if (live.delete(database)) closed++;
        close();
      };
    });
    return request;
  }) as IDBFactory["open"];
  const t = await setup();
  let release = () => {};
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    await waitFor(() =>
      expect(!!t.slot.queryByText("Saving personal inputs…")).toBe(false),
    );
    const hold = t.fixture.wire.holdSaves();
    release = hold.release;
    await act(async () => {
      fireEvent.change(
        t.slot.getByLabelText(/(?:Focus|Important context or concerns)/),
        {
          target: { value: "Durable after full detach" },
        },
      );
    });
    await act(async () => {
      t.slot.getByRole("button", { name: "‹ All templates" }).click();
    });
    t.slot.lifecycle.unmount();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(live.size).toBe(0));
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBe(opened);
    const request = originalOpen("new-thread-templates-recovery-v1", 1);
    const records = await new Promise<any[]>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("drafts", "readonly"),
          get = tx.objectStore("drafts").getAll();
        get.onsuccess = () => {
          resolve(get.result);
        };
        tx.oncomplete = () => db.close();
      };
      request.onerror = () => reject(request.error);
    });
    expect(
      records.some(
        (record) =>
          record.draft?.desired?.inputs?.focus === "Durable after full detach",
      ),
    ).toBe(true);
  } finally {
    release();
    await t.close();
    indexedDB.open = originalOpen;
  }
});

test("older unpublished unknown launch remains reachable through Manage History beyond first 50 and recovers same read without resend", async () => {
  const t = await setup(true);
  try {
    t.fixture.seedRecent(52);
    await managementReady(t.slot);
    await t.slot.findByRole("button", {
      name: "History",
    });
    await act(async () => {
      t.slot.getByRole("button", { name: "History" }).click();
    });
    await t.slot.findByRole("button", { name: "Load older launches" });
    expect(
      t.slot.queryByRole("heading", { name: "Historical unpublished review" }),
    ).toBeNull();
    await act(async () => {
      t.slot.getByRole("button", { name: "Load older launches" }).click();
    });
    await t.slot.findByRole("heading", {
      name: "Historical unpublished review",
    });
    const row = t.slot
      .getByRole("heading", { name: "Historical unpublished review" })
      .closest("article")!;
    const { within } = await import("@testing-library/react");
    t.fixture.flags.statusError = true;
    await act(async () => {
      within(row).getByRole("button", { name: "Check launch status" }).click();
    });
    await t.slot.findByText("Status temporarily unavailable");
    t.fixture.flags.statusError = false;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await waitFor(() =>
      expect(t.slot.queryByText("Status temporarily unavailable")).toBeNull(),
    );
    expect(
      t.fixture.calls.some(
        (c) =>
          c.method === "recentLaunches" &&
          (c.input as { offset?: number }).offset === 50,
      ),
    ).toBe(true);
    expect(t.fixture.flags.launchCount).toBe(0);
    await act(async () => {
      within(row).getByRole("button", { name: "Details" }).click();
    });
    expect(within(row).getByText("Submitted inputs")).toBeTruthy();
    expect(
      within(row).getAllByText(/https:\/\/example.test\/pull\/51/)[0],
    ).toBeTruthy();
  } finally {
    await t.close();
  }
});

test("native model picker uses authoritative primary host for project defaults and reuse environment when selected", async () => {
  localStorage.clear();
  const t = await setup(true);
  try {
    await managementReady(t.slot);
    await act(async () => {
      t.slot.getAllByRole("button", { name: "Edit" })[0]!.click();
    });
    await act(async () => {
      t.slot.getByRole("tab", { name: "Model" }).click();
    });
    expect(t.slot.queryByTestId("bb-provider-model-picker")).toBeNull();
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Model policy"), {
        target: { value: "explicit" },
      }),
    );
    expect(
      t.slot
        .getByTestId("bb-provider-model-picker")
        .getAttribute("data-routing-id"),
    ).toBe("host-primary");
    await act(async () => {
      t.slot.getByRole("tab", { name: "Project" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByRole("combobox", { name: "Project" }), {
        target: { value: "project-a" },
      });
    });
    await act(async () => {
      fireEvent.change(t.slot.getByRole("combobox", { name: "Environment" }), {
        target: { value: "reuse" },
      });
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Existing environment"), {
        target: { value: "env-a" },
      });
      t.slot.getByRole("tab", { name: "Model" }).click();
    });
    expect(
      t.slot
        .getByTestId("bb-provider-model-picker")
        .getAttribute("data-routing-kind"),
    ).toBe("environment");
    expect(
      t.slot
        .getByTestId("bb-provider-model-picker")
        .getAttribute("data-routing-id"),
    ).toBe("env-a");
  } finally {
    await t.close();
  }
});

test("checkbox without explicit default displays and previews false without requiring a toggle", async () => {
  const t = await setup();
  try {
    const entry = t.fixture.entries.find((e) => e.id === "review-pr")!;
    entry.published!.definition = {
      ...entry.published!.definition,
      fields: [
        {
          key: "enabled",
          label: "Enabled",
          type: "checkbox",
          required: true,
          order: 0,
        },
      ],
      promptTemplate: "Enabled {{enabled}}",
      titleTemplate: "Checkbox",
    };
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await openReviewCheckbox();
    async function openReviewCheckbox() {
      await t.slot.findByRole("button", { name: /(?:Review a PR|PR Review)/ });
      await act(async () => {
        t.slot
          .getByRole("button", { name: /(?:Review a PR|PR Review)/ })
          .click();
      });
    }
    await t.slot.findByRole("checkbox", { name: /Enabled/ });
    expect(
      (t.slot.getByRole("checkbox", { name: /Enabled/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    await act(pause);
    await act(async () => {
      t.slot.getByRole("button", { name: "Details" }).click();
    });
    await t.slot.findByText("Enabled false", { exact: true });
    expect(t.slot.queryByText("Required")).toBeNull();
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("real form renders all six approved field types with defaults, options, help and validation", async () => {
  const t = await setup();
  try {
    const entry = t.fixture.entries.find((e) => e.id === "review-pr")!;
    entry.published!.definition = {
      ...entry.published!.definition,
      name: "All field types",
      titleTemplate: "Fields",
      fields: [
        {
          key: "short",
          label: "Short text",
          type: "text",
          required: true,
          order: 0,
          default: "Initial",
          help: "A short summary",
        },
        {
          key: "long",
          label: "Long text",
          type: "textarea",
          required: false,
          order: 1,
          default: "Details",
        },
        {
          key: "link",
          label: "URL",
          type: "url",
          required: false,
          order: 2,
          default: "https://example.test",
        },
        {
          key: "count",
          label: "Number",
          type: "number",
          required: true,
          order: 3,
          default: 3,
          validation: { min: 0, max: 10 },
        },
        {
          key: "priority",
          label: "Select",
          type: "select",
          required: true,
          order: 4,
          default: "high",
          options: [
            { value: "high", label: "High" },
            { value: "low", label: "Low" },
          ],
        },
        {
          key: "enabled",
          label: "Checkbox",
          type: "checkbox",
          required: true,
          order: 5,
        },
      ],
      promptTemplate:
        "{{short}}\n{{long}}\n{{link}}\n{{count}}\n{{priority}}\n{{enabled}}",
    };
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await t.slot.findByRole("button", { name: /All field types/ });
    await act(async () => {
      t.slot.getByRole("button", { name: /All field types/ }).click();
    });
    await t.slot.findByText("A short summary");
    await waitFor(() =>
      expect(
        (t.slot.getByLabelText(/Number/) as HTMLInputElement).disabled,
      ).toBe(false),
    );
    expect(
      (t.slot.getByLabelText(/Short text/) as HTMLInputElement).value,
    ).toBe("Initial");
    expect(
      (t.slot.getByLabelText(/Long text/) as HTMLTextAreaElement).tagName,
    ).toBe("TEXTAREA");
    expect((t.slot.getByLabelText(/URL/) as HTMLInputElement).type).toBe("url");
    expect(
      (t.slot.getByRole("checkbox", { name: /Checkbox/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText(/Number/), {
        target: { value: "-1" },
      });
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await t.slot.findByText("Minimum 0", { exact: true });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-field")).toBe("count"),
    );
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText(/Number/), {
        target: { value: "4" },
      });
      fireEvent.change(t.slot.getByRole("combobox", { name: /Select/ }), {
        target: { value: "low" },
      });
      fireEvent.click(t.slot.getByRole("checkbox", { name: /Checkbox/ }));
      t.slot.getByRole("button", { name: "Details" }).click();
    });
    await act(pause);
    expect(
      [...t.slot.container.querySelectorAll(".ntt-preview")].at(-1)
        ?.textContent,
    ).toContain("4\nlow\ntrue");
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("customer Feedback Session form preserves subject focus contributors and named preparation processes", async () => {
  const t = await setup();
  try {
    await t.slot.findByRole("button", { name: /Feedback Session/ });
    await act(async () => {
      t.slot.getByRole("button", { name: /Feedback Session/ }).click();
    });
    await t.slot.findByLabelText(/What are we giving feedback on/);
    await act(async () => {
      fireEvent.change(
        t.slot.getByLabelText(/What are we giving feedback on/),
        { target: { value: "Settings redesign" } },
      );
      fireEvent.change(t.slot.getByLabelText(/Main focus and context/), {
        target: { value: "Keyboard navigation and clarity" },
      });
      fireEvent.change(t.slot.getByLabelText(/Feedback contributors/), {
        target: { value: "Ada and Bea" },
      });
      t.slot.getByRole("button", { name: "Details" }).click();
    });
    await act(pause);
    const message =
      [...t.slot.container.querySelectorAll(".ntt-preview")].at(-1)
        ?.textContent ?? "";
    expect(message).toContain("Settings redesign");
    expect(message).toContain("Keyboard navigation and clarity");
    expect(message).toContain("Ada and Bea");
    expect(message).toContain("/rapid-fire-feedback-in-bb-mode");
    expect(message).toContain("/thread-brief");
    expect(message).toContain("/workbench-plan");
    expect(message).toContain("feedback giver and reviewer");
    expect(message).toContain("implementation completion separately");
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("customer PR Review requires the subject and renders independent posted review with feedback sequencing", async () => {
  const t = await setup();
  try {
    await openReview(t.slot);
    expect(t.slot.getByLabelText(/Main change or review goal/)).toBeTruthy();
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText(/Pull request URL/), {
        target: { value: "https://example.test/pull/47" },
      });
      t.slot.getByRole("button", { name: "Start thread" }).click();
    });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-field")).toBe(
        "subject",
      ),
    );
    await fillReview(t.slot);
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText(/Important context or concerns/), {
        target: { value: "Owner isolation and response loss" },
      });
      t.slot.getByRole("button", { name: "Details" }).click();
    });
    await act(pause);
    const message =
      [...t.slot.container.querySelectorAll(".ntt-preview")].at(-1)
        ?.textContent ?? "";
    expect(message).toContain("Identity consistency");
    expect(message).toContain("Owner isolation and response loss");
    expect(message).toContain("independent second mate");
    expect(message).toContain("run and post a /github-pr-review");
    expect(message).toContain("/pr-review");
    expect(message).toContain("/bb-delegation-mode");
    expect(message).toContain(
      "Address initial feedback thoughtfully before any squash-merge step",
    );
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("management admits ready identity before enabling New so one click cannot be erased by acquisition", async () => {
  const fixture = await appFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = fixture.handlers["bb-identity.v1.bootstrap"]!;
  fixture.handlers["bb-identity.v1.bootstrap"] = async (input) => {
    await held;
    return original(input);
  };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    { pluginId: "new-thread-templates", rpc: fixture.handlers },
  );
  try {
    await act(async () => {});
    const button = slot.queryByRole("button", { name: "+ New template" });
    if (button) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(slot.queryByLabelText("Name")).toBeNull();
    await act(async () => {
      release();
    });
    await slot.findByRole("button", { name: "+ New template" });
    await waitFor(() =>
      expect(
        (
          slot.getByRole("button", {
            name: "+ New template",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      slot.getByRole("button", { name: "+ New template" }).click();
    });
    await slot.findByLabelText("Name");
    expect(slot.queryByLabelText("Name")).toBeTruthy();
  } finally {
    release();
    slot.lifecycle.unmount();
    await fixture.dispose();
  }
});

test("Edit with BB keeps full native component mounted across Back with frozen origin and exact server-owned submission", async () => {
  const t = await setup();
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Edit with BB",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "Edit with BB" }).click();
    });
    await t.slot.findByTestId("bb-new-thread-composer");
    const composer = t.slot.getByTestId("bb-new-thread-composer"),
      key = composer.getAttribute("data-draft-key");
    expect(key).toContain("new-thread-templates/native/");
    expect(composer.getAttribute("data-default-project-id")).toBe("project-a");
    expect(
      t.slot.queryByText(
        "Text and attachments saved. Recheck destination and run settings after reopening.",
      ),
    ).toBeNull();
    await act(async () => {
      fireEvent.change(t.slot.getByTestId("bb-new-thread-composer-input"), {
        target: { value: "Edited complete request" },
      });
      t.slot.getByRole("button", { name: "‹ Back to form" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText(/Important context or concerns/), {
        target: { value: "New form focus" },
      });
    });
    await act(async () => {
      t.slot.getByRole("button", { name: "Resume BB editor" }).click();
    });
    expect(t.slot.getByTestId("bb-new-thread-composer")).toBe(composer);
    expect(
      (
        t.slot.getByTestId(
          "bb-new-thread-composer-input",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Edited complete request");
    expect(composer.getAttribute("data-draft-key")).toBe(key);
    expect(t.slot.getByText(/The form has changed/)).toBeTruthy();
    await act(async () => {
      t.slot.getByTestId("bb-new-thread-composer-submit").click();
    });
    await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
    const request = t.fixture.calls.find((c) => c.method === "launch")!
      .input as import("../rpc-contract.ts").LaunchRequest;
    expect(request.nativeSubmission?.input).toEqual([
      { type: "text", text: "Edited complete request", mentions: [] },
    ]);
    expect(request.nativeSubmission?.environment).toEqual({
      type: "host",
      hostId: "host-a",
      workspace: { type: "unmanaged", path: null },
    });
    expect(request.inputs).not.toHaveProperty("focus");
    expect(request.inputs.subject).toBe("Identity consistency");
    expect(request.nativeSubmission?.projectId).toBe("project-a");
    await waitFor(() =>
      expect(
        t.slot.inspection.navigateCalls.some((c) => c.method === "toThread"),
      ).toBe(true),
    );
  } finally {
    await t.close();
  }
});

test("native editor reset protects unsent work and saved reopening retains stable owner draft identity", async () => {
  const t = await setup();
  const previousConfirm = window.confirm;
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Edit with BB",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "Edit with BB" }).click();
    });
    await t.slot.findByTestId("bb-new-thread-composer");
    const first = t.slot
      .getByTestId("bb-new-thread-composer")
      .getAttribute("data-draft-key");
    window.confirm = () => false;
    await act(async () => {
      t.slot.getByRole("button", { name: "Reset to generated prompt" }).click();
    });
    expect(
      t.slot
        .getByTestId("bb-new-thread-composer")
        .getAttribute("data-draft-key"),
    ).toBe(first);
    const before = await t.fixture.readPersonal();
    const held = t.fixture.wire.holdSaves();
    window.confirm = () => true;
    await act(async () => {
      t.slot.getByRole("button", { name: "Reset to generated prompt" }).click();
    });
    await held.reached;
    expect(
      t.slot
        .getByTestId("bb-new-thread-composer")
        .getAttribute("data-draft-key"),
    ).toBe(first);
    expect(
      (
        t.slot.getByRole("button", {
          name: "‹ All templates",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect((await t.fixture.readPersonal())?.nativeEditor?.editorDraftId).toBe(
      before?.nativeEditor?.editorDraftId,
    );
    held.release();
    await waitFor(() =>
      expect(
        t.slot
          .getByTestId("bb-new-thread-composer")
          .getAttribute("data-draft-key"),
      ).not.toBe(first),
    );
    const reset = t.slot
      .getByTestId("bb-new-thread-composer")
      .getAttribute("data-draft-key");
    const confirmed = await t.fixture.readPersonal();
    expect(confirmed?.nativeEditor?.editorDraftId).not.toBe(
      before?.nativeEditor?.editorDraftId,
    );
    expect(decodeURIComponent(reset!)).toContain(
      confirmed!.nativeEditor!.editorDraftId,
    );
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "‹ All templates",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "‹ All templates" }).click();
    });
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Resume BB editor" });
    await act(async () => {
      t.slot.getByRole("button", { name: "Resume BB editor" }).click();
    });
    await t.slot.findByTestId("bb-new-thread-composer");
    expect(
      t.slot
        .getByTestId("bb-new-thread-composer")
        .getAttribute("data-draft-key"),
    ).toBe(reset);
    expect(
      t.slot.getByText(
        "Text and attachments saved. Recheck destination and run settings after reopening.",
      ),
    ).toBeTruthy();
    expect((await t.fixture.readPersonal())?.nativeEditor?.editorDraftId).toBe(
      confirmed?.nativeEditor?.editorDraftId,
    );
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    window.confirm = previousConfirm;
    await t.close();
  }
});

test("native submit waits for held form autosave and then persists exact native operation before its single launch", async () => {
  const t = await setup();
  let release = () => {};
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Edit with BB",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "Edit with BB" }).click();
    });
    await t.slot.findByTestId("bb-new-thread-composer");
    const origin = structuredClone(
      (await t.fixture.readPersonal())!.nativeEditor!,
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "‹ Back to form" }).click();
    });
    const held = t.fixture.wire.holdSaves();
    release = held.release;
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText(/Important context or concerns/), {
        target: { value: "Updated form during native draft" },
      });
    });
    await held.reached;
    await act(async () => {
      t.slot.getByRole("button", { name: "Resume BB editor" }).click();
    });
    await act(async () => {
      fireEvent.change(t.slot.getByTestId("bb-new-thread-composer-input"), {
        target: { value: "Native exact request after form edit" },
      });
      t.slot.getByTestId("bb-new-thread-composer-submit").click();
    });
    expect(t.fixture.flags.launchCount).toBe(0);
    // Hold the actual launch response so the committed personal operation can
    // be read before confirmed completion removes its reference.
    const releaseLaunch = t.fixture.holdResponse("launch");
    await act(async () => {
      release();
    });
    try {
      await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
      const stored = (await t.fixture.readPersonal())!;
      expect(stored.inputs.focus).toBe("Updated form during native draft");
      expect(stored.nativeEditor).toEqual(origin);
      expect(stored.nativeOperation?.inputs).toEqual(origin.inputs);
      expect(stored.nativeOperation?.inputs).not.toHaveProperty("focus");
      expect(stored.nativeOperation?.nativeSubmission.input).toEqual([
        {
          type: "text",
          text: "Native exact request after form edit",
          mentions: [],
        },
      ]);
      const issued = t.fixture.calls.find((call) => call.method === "launch")!
        .input as import("../rpc-contract.ts").LaunchRequest;
      expect(stored.operationId).toBe(issued.operationId);
      expect(stored.nativeOperation?.nativeSubmission).toEqual(
        issued.nativeSubmission,
      );
      expect(
        t.fixture.calls.filter((call) => call.method === "launch"),
      ).toHaveLength(1);
    } finally {
      await act(async () => {
        releaseLaunch();
      });
    }
    await waitFor(() =>
      expect(
        t.slot.inspection.navigateCalls.filter(
          (call) => call.method === "toThread",
        ),
      ).toHaveLength(1),
    );
    expect((await t.fixture.readPersonal())?.operationId).toBeUndefined();
  } finally {
    release();
    await t.close();
  }
});

test("mounted native editor keeps frozen origin and unsent text when another client replaces the shared origin", async () => {
  const t = await setup();
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Edit with BB",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "Edit with BB" }).click();
    });
    const composer = await t.slot.findByTestId("bb-new-thread-composer");
    const key = composer.getAttribute("data-draft-key");
    await act(async () => {
      fireEvent.change(t.slot.getByTestId("bb-new-thread-composer-input"), {
        target: { value: "Unsent local native work" },
      });
    });
    const committed = (await t.fixture.readPersonal())!;
    const replacement = crypto.randomUUID();
    await act(async () => {
      t.fixture.wire.invalidateExternally(t.fixture.personalAddress(), {
        ...committed,
        nativeEditor: {
          ...committed.nativeEditor!,
          editorDraftId: replacement,
        },
      });
    });
    await waitFor(async () =>
      expect(
        (await t.fixture.readPersonal())?.nativeEditor?.editorDraftId,
      ).toBe(replacement),
    );
    await act(pause);
    expect(t.slot.getByTestId("bb-new-thread-composer")).toBe(composer);
    expect(
      t.slot.getByText(/Another view saved a different BB editor draft/),
    ).toBeTruthy();
    expect(composer.getAttribute("data-draft-key")).toBe(key);
    expect(
      (
        t.slot.getByTestId(
          "bb-new-thread-composer-input",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Unsent local native work");
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("native pending recovery reuses exact structured snapshot and preserves omitted original project on preparation retry", async () => {
  const { nativeSubmissionSchema } = await import("../native-submission.ts");
  const submission = nativeSubmissionSchema.parse({
    projectId: "project-a",
    providerId: "provider-a",
    model: "model-a",
    reasoningLevel: "medium",
    permissionMode: "auto",
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      permissionMode: "explicit",
    },
    environment: {
      type: "host",
      hostId: "host-a",
      workspace: { type: "unmanaged", path: null },
    },
    input: [
      {
        type: "text",
        text: "/review",
        mentions: [
          {
            start: 0,
            end: 7,
            resource: {
              kind: "command",
              label: "review",
              name: "review",
              argumentHint: null,
              origin: "project",
              source: "skill",
              trigger: "/",
            },
          },
        ],
      },
      {
        type: "localFile",
        path: "/tmp/context.txt",
        hostId: "host-a",
        sourceProjectId: "project-a",
        name: "context.txt",
        sizeBytes: 8,
      },
    ],
    sessionOptions: { inspect: true },
  });
  const id = crypto.randomUUID();
  const t = await setup(false, (fixture) => {
    const revision = fixture.entries.find(
        (e) => e.id === "review-pr",
      )!.published!,
      inputs = {
        pr_url: "https://example.test/pull/9",
        subject: "Original native subject",
        focus: "Original focus",
      },
      nativeOperation = {
        templateId: "review-pr",
        revision: revision.revision,
        inputs,
        nativeSubmission: submission,
      };
    const status: import("../rpc-contract.ts").LaunchStatus = {
      operationId: id,
      templateId: "review-pr",
      revision: revision.revision,
      phase: "failed",
      projectId: "project-a",
      threadId: null,
      message: "Retry preparation",
      retryable: true,
      actor: { key: fixture.wire.actor!.identity.key, name: "Ada Fixture" },
      inputs,
      nativeAttribution: "plugin-origin",
      createdAt: 1,
      updatedAt: 1,
    };
    fixture.seedReceipt(status, revision, submission);
    fixture.seedPersonal({
      inputs: { ...inputs, focus: "New form focus" },
      projectId: "project-b",
      operationId: id,
      revision: revision.revision,
      nativeOperation,
    });
  });
  try {
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Retry preparation" });
    expect(t.slot.queryByRole("button", { name: "Edit with BB" })).toBeNull();
    await act(async () => {
      t.slot.getByRole("button", { name: "Retry preparation" }).click();
    });
    await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
    const request = t.fixture.calls.find((c) => c.method === "launch")!
      .input as import("../rpc-contract.ts").LaunchRequest;
    expect(request.operationId).toBe(id);
    expect(request.nativeSubmission).toEqual(submission);
    expect(Object.hasOwn(request, "projectId")).toBe(false);
    expect(request.inputs.focus).toBe("Original focus");
    await waitFor(() =>
      expect(
        t.slot.inspection.navigateCalls.filter(
          (call) => call.method === "toThread",
        ),
      ).toHaveLength(1),
    );
    expect((await t.fixture.readPersonal())?.operationId).toBeUndefined();
  } finally {
    await t.close();
  }
});

test("genuine new-project template never opens native editor or provisions during inspection", async () => {
  const t = await setup(false, (fixture) => {
    fixture.addLegacyFixtures();
    const entry =
      fixture.entries.find((e) => e.id === "start-project") ??
      fixture.entries.find(
        (e) => e.draft?.definition.destination.kind === "new-project",
      )!;
    const definition = structuredClone(entry.draft!.definition);
    if (definition.destination.kind !== "new-project")
      throw new Error("fixture");
    definition.destination.hostId = "host-a";
    definition.destination.path = "/workspace/new-source";
    entry.published = {
      templateId: entry.id,
      revision: 1,
      definition,
      publishedAt: 1,
      publishedBy: fixture.context.actor,
    };
  });
  try {
    await t.slot.findByRole("button", { name: /Start a project/ });
    await act(async () => {
      t.slot.getByRole("button", { name: /Start a project/ }).click();
    });
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Start thread",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      for (const input of t.slot.container.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >("[data-field]"))
        fireEvent.change(input, { target: { value: "Sample project" } });
    });
    await act(pause);
    expect(
      (
        t.slot.getByRole("button", {
          name: "Edit with BB",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      t.slot.getByText(
        "BB editor is available for existing projects. This template creates its project when sent.",
      ),
    ).toBeTruthy();
    expect(t.slot.queryByTestId("bb-new-thread-composer")).toBeNull();
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("native editor actor change unmounts old owner and new actor receives a separate draft key", async () => {
  const t = await setup();
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Edit with BB",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "Edit with BB" }).click();
    });
    await t.slot.findByTestId("bb-new-thread-composer");
    const before = t.slot
      .getByTestId("bb-new-thread-composer")
      .getAttribute("data-draft-key");
    await act(async () => {
      t.fixture.wire.switchActor("bea");
    });
    await waitFor(() =>
      expect(t.slot.queryByTestId("bb-new-thread-composer")).toBeNull(),
    );
    await fillReview(t.slot);
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Edit with BB",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await act(async () => {
      t.slot.getByRole("button", { name: "Edit with BB" }).click();
    });
    await t.slot.findByTestId("bb-new-thread-composer");
    expect(
      t.slot
        .getByTestId("bb-new-thread-composer")
        .getAttribute("data-draft-key"),
    ).not.toBe(before);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("Settings reuses authoring, per-template Project, exact removal and History after all definitions are removed", async () => {
  localStorage.clear();
  const fixture = await appFixture(`settings-${crypto.randomUUID()}`);
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    { pluginId: "new-thread-templates", rpc: fixture.handlers },
  );
  const stop = fixture.wire.onRealtime(
    (channel, payload) => void slot.behavior.emitRealtime(channel, payload),
  );
  const confirm = window.confirm;
  window.confirm = () => true;
  try {
    await managementReady(slot);
    expect(slot.container.querySelector(".ntt-settings")).toBeTruthy();
    expect(slot.container.querySelector(".ntt-panel")).toBeNull();
    expect(slot.queryByRole("button", { name: "‹ New thread" })).toBeNull();
    await act(async () =>
      slot.getByRole("button", { name: "+ New template" }).click(),
    );
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Name"), {
        target: { value: "Settings authored template" },
      });
      slot.getByRole("tab", { name: "Project" }).click();
    });
    await act(async () =>
      fireEvent.change(slot.getByRole("combobox", { name: "Project" }), {
        target: { value: "project-b" },
      }),
    );
    await act(async () =>
      slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(slot.queryByText(/ · unsaved changes/)).toBeNull(),
    );
    const created = fixture.entries.find(
      (e) => e.draft?.definition.name === "Settings authored template",
    )!;
    expect(created.draft!.definition.destination).toEqual({
      kind: "existing-project",
      projectId: "project-b",
      environment: { kind: "project-default" },
    });
    // A collaborator changes the row after this editor's admitted snapshot.
    created.draft!.generation++;
    await act(async () => slot.getByRole("button", { name: "Remove" }).click());
    await slot.findByText("Template changed; reload before removing");
    expect(slot.getByLabelText("Name").getAttribute("value")).toBe(
      "Settings authored template",
    );
    expect(fixture.entries.some((e) => e.id === created.id)).toBe(true);
    // Return and reopen admits the new exact generation; remove succeeds.
    await act(async () =>
      slot.getByRole("button", { name: "‹ All templates" }).click(),
    );
    await slot.findByText("Settings authored template");
    const row = slot
      .getByText("Settings authored template")
      .closest(".ntt-list-row")!;
    await act(async () =>
      (row.querySelector("button") as HTMLButtonElement).click(),
    );
    await act(async () => slot.getByRole("button", { name: "Remove" }).click());
    await waitFor(() =>
      expect(fixture.entries.some((e) => e.id === created.id)).toBe(false),
    );
    await waitFor(() => expect(slot.queryByLabelText("Name")).toBeNull());
    const removed = fixture.calls
      .filter((c) => c.method === "remove")
      .at(-1)!.input;
    expect(removed).toEqual({
      templateId: created.id,
      expectedGeneration: 2,
      expectedRevision: null,
      expectedLatestRevision: 0,
    });
    fixture.entries.splice(0);
    await slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await slot.findByText("Create your first template.");
    await act(async () =>
      slot.getByRole("button", { name: "History" }).click(),
    );
    await slot.findByRole("heading", { name: "History" });
    expect(fixture.flags.launchCount).toBe(0);
  } finally {
    window.confirm = confirm;
    stop();
    slot.lifecycle.unmount();
    await act(async () => {});
    await fixture.dispose();
  }
});

test("contextual route changes guard unsaved work, recover missing targets and re-admit the current actor", async () => {
  localStorage.clear();
  const { TemplatesPanel } = await import("../app.tsx");
  const t = await setup(true);
  const route = async (path: string) =>
    act(async () =>
      t.slot.lifecycle.rerender(<TemplatesPanel subPath={path} />),
    );
  try {
    await managementReady(t.slot);
    await route("compose/edit/review-pr");
    await t.slot.findByLabelText("Name");
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Name"), {
        target: { value: "Unfinished PR authoring" },
      }),
    );
    await route("compose/edit/feedback-session");
    await t.slot.findByRole("dialog", { name: "Unsaved template changes" });
    expect((t.slot.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Unfinished PR authoring",
    );
    await act(async () => t.slot.getByRole("button", { name: "Stay" }).click());
    expect((t.slot.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Unfinished PR authoring",
    );
    await route("compose/edit/review-pr");
    await route("compose/new");
    await t.slot.findByRole("dialog", { name: "Unsaved template changes" });
    await act(async () =>
      t.slot.getByRole("button", { name: "Discard changes" }).click(),
    );
    await waitFor(() =>
      expect((t.slot.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "",
      ),
    );
    await route("compose/edit/%ZZ");
    await t.slot.findByText(/This template link is invalid/);
    await route("compose/edit/removed-template");
    await t.slot.findByText(/This template is unavailable or has been removed/);
    expect(t.slot.getByRole("button", { name: "History" })).toBeTruthy();
    await route("compose/edit/feedback-session");
    await waitFor(() =>
      expect((t.slot.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "Feedback Session",
      ),
    );
    await act(async () => t.fixture.wire.switchActor("bea"));
    await waitFor(() =>
      expect((t.slot.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "Feedback Session",
      ),
    );
    expect(
      t.fixture.calls.filter((c) => c.method === "saveDraft"),
    ).toHaveLength(0);
  } finally {
    await t.close();
  }
});

test("compact selected form has one purpose header, contextual Edit and untouched required fields stay quiet", async () => {
  const t = await setup();
  try {
    expect(t.slot.getByRole("button", { name: "New template" })).toBeTruthy();
    await openReview(t.slot);
    expect(t.slot.container.querySelector(".ntt-run.ntt-surface")).toBeNull();
    expect(
      t.slot.queryAllByRole("heading", { name: "PR Review" }),
    ).toHaveLength(1);
    expect(t.slot.queryByText("Required · Required")).toBeNull();
    expect(t.slot.queryAllByRole("alert")).toHaveLength(0);
    await act(async () => t.slot.getByRole("button", { name: "Edit" }).click());
    expect(t.slot.inspection.navigateCalls.at(-1)).toMatchObject({
      method: "toPluginPanel",
      path: "templates",
      options: { subPath: "compose/edit/review-pr" },
    });
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("contextual Edit survives full slot unmount and returns once to original pinned form and personal inputs", async () => {
  sessionStorage.clear();
  const t = await setup();
  let panel: ReturnType<typeof renderSlot> | null = null;
  let home: ReturnType<typeof renderSlot> | null = null;
  let stopPanel = () => {},
    stopHome = () => {};
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    const original = structuredClone(
      t.fixture.entries.find((e) => e.id === "review-pr")!.published!,
    );
    await act(async () => t.slot.getByRole("button", { name: "Edit" }).click());
    const path = t.slot.inspection.navigateCalls.at(-1)!;
    expect(path).toMatchObject({
      method: "toPluginPanel",
      options: { subPath: "compose/edit/review-pr" },
    });
    t.slot.lifecycle.unmount();
    panel = renderSlot(
      app.navPanels[0]!,
      { subPath: "compose/edit/review-pr" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    stopPanel = t.fixture.wire.onRealtime(
      (channel, payload) => void panel?.behavior.emitRealtime(channel, payload),
    );
    await panel.findByLabelText("Name");
    await act(async () => {
      fireEvent.change(panel!.getByLabelText("Name"), {
        target: { value: "Shared author revision" },
      });
      panel!.getByRole("button", { name: "Save draft" }).click();
    });
    await waitFor(() =>
      expect(panel!.queryByText(/ · unsaved changes/)).toBeNull(),
    );
    await act(async () =>
      panel!.getByRole("button", { name: "‹ All templates" }).click(),
    );
    expect(panel.inspection.navigateCalls.at(-1)).toMatchObject({
      method: "toCompose",
    });
    panel.lifecycle.unmount();
    stopPanel();
    home = renderSlot(
      app.homepageSections[0]!,
      { projectId: "project-b" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    stopHome = t.fixture.wire.onRealtime(
      (channel, payload) => void home?.behavior.emitRealtime(channel, payload),
    );
    await home.findByLabelText(/Pull request URL/);
    await waitFor(() =>
      expect(
        (home!.getByLabelText(/Pull request URL/) as HTMLInputElement).value,
      ).toBe("https://example.test/pull/42"),
    );
    expect(
      home.container.querySelector(".ntt-selected-name")?.textContent,
    ).toContain(original.definition.name);
    expect(home.queryByText("Shared author revision")).toBeNull();
    expect(home.inspection.navigateCalls).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
    await act(async () =>
      home!.getByRole("button", { name: "‹ All templates" }).click(),
    );
    home.lifecycle.unmount();
    stopHome();
    home = renderSlot(
      app.homepageSections[0]!,
      { projectId: "project-a" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    await home.findByRole("searchbox");
    expect(home.queryByLabelText(/Pull request URL/)).toBeNull();
  } finally {
    stopPanel();
    stopHome();
    panel?.lifecycle.unmount();
    home?.lifecycle.unmount();
    await t.close();
  }
});

test("armed contextual return cannot cross owners and unpublished or removed targets fall back without launch", async () => {
  const { rememberFormReturn, armFormReturn } = await import("../ui/return.ts");
  for (const removed of [false, true]) {
    sessionStorage.clear();
    const fixture = await appFixture(`return-owner-${crypto.randomUUID()}`);
    const entry = fixture.entries.find((e) => e.id === "review-pr")!;
    const owner = `${fixture.personalAddress().instanceId}:${fixture.wire.actor!.identity.key}`;
    expect(
      rememberFormReturn(owner, structuredClone(entry.published!), null),
    ).toBeNull();
    armFormReturn(owner, entry.id);
    if (removed) fixture.entries.splice(fixture.entries.indexOf(entry), 1);
    else entry.published = null;
    fixture.wire.switchActor("bea");
    const slot = renderSlot(
      app.homepageSections[0]!,
      { projectId: "project-b" },
      { pluginId: "new-thread-templates", rpc: fixture.handlers },
    );
    const stop = fixture.wire.onRealtime(
      (channel, payload) => void slot.behavior.emitRealtime(channel, payload),
    );
    try {
      await slot.findByRole("searchbox");
      expect(slot.queryByLabelText(/Pull request URL/)).toBeNull();
      expect(
        slot.queryByText(/The edited template is no longer published/),
      ).toBeNull();
      await act(async () => fixture.wire.switchActor("ada"));
      await slot.findByText(/The edited template is no longer published/);
      expect(slot.queryByLabelText(/Pull request URL/)).toBeNull();
      expect(slot.getByRole("button", { name: "Manage" })).toBeTruthy();
      expect(slot.inspection.navigateCalls).toHaveLength(0);
      expect(fixture.flags.launchCount).toBe(0);
      expect(
        fixture.calls.filter(
          (c) => c.method === "saveDraft" || c.method === "publish",
        ),
      ).toHaveLength(0);
    } finally {
      stop();
      slot.lifecycle.unmount();
      await act(async () => {});
      await fixture.dispose();
    }
  }
});

test("unavailable return navigation storage retains form and exposes a useful fallback", async () => {
  const t = await setup();
  const prototype = Object.getPrototypeOf(sessionStorage);
  const original = prototype.setItem;
  try {
    await openReview(t.slot);
    await fillReview(t.slot);
    prototype.setItem = function (key: string, value: string) {
      if (this === sessionStorage) throw new Error("Storage unavailable");
      return original.call(this, key, value);
    };
    await act(async () => t.slot.getByRole("button", { name: "Edit" }).click());
    await t.slot.findByText(
      /The selected form could not be retained for return/,
    );
    expect(
      (t.slot.getByLabelText(/Pull request URL/) as HTMLInputElement).value,
    ).toBe("https://example.test/pull/42");
    expect(t.slot.inspection.navigateCalls).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    prototype.setItem = original;
    await t.close();
  }
});

test("Prompt lists only current valid field placeholders and inserts into saved body/title selection with focus", async () => {
  localStorage.clear();
  const t = await setup(true, (fixture) => {
    const definition = fixture.entries[0]!.draft!.definition;
    definition.fields = [
      {
        key: "subject",
        label: "Subject label",
        type: "text",
        required: false,
        order: 0,
      },
      {
        key: "notes",
        label: "Notes label",
        type: "textarea",
        required: false,
        order: 1,
      },
      {
        key: "url",
        label: "URL label",
        type: "url",
        required: false,
        order: 2,
      },
      {
        key: "count",
        label: "Count label",
        type: "number",
        required: false,
        order: 3,
      },
      {
        key: "choice",
        label: "Choice label",
        type: "select",
        required: false,
        order: 4,
        options: [{ value: "a", label: "A" }],
      },
      {
        key: "enabled",
        label: "Enabled label",
        type: "checkbox",
        required: false,
        order: 5,
      },
      {
        key: "constructor",
        label: "Reserved key",
        type: "text",
        required: false,
        order: 6,
      },
      {
        key: "bad-key",
        label: "Invalid key",
        type: "text",
        required: false,
        order: 7,
      },
      {
        key: "duplicate",
        label: "Duplicate one",
        type: "text",
        required: false,
        order: 8,
      },
      {
        key: "duplicate",
        label: "Duplicate two",
        type: "text",
        required: false,
        order: 9,
      },
    ];
    definition.titleTemplate = "Title X";
    definition.promptTemplate = "before SELECT after";
  });
  try {
    await managementReady(t.slot);
    await act(async () =>
      t.slot.getAllByRole("button", { name: "Edit" })[0]!.click(),
    );
    await act(async () => t.slot.getByRole("tab", { name: "Prompt" }).click());
    const group = t.slot.getByRole("group", { name: "Field placeholders" });
    const { within } = await import("@testing-library/react");
    expect(within(group).getAllByRole("button")).toHaveLength(6);
    for (const [key, type] of [
      ["subject", "Short text"],
      ["notes", "Long text"],
      ["url", "URL"],
      ["count", "Number"],
      ["choice", "Select"],
      ["enabled", "Checkbox"],
    ])
      expect(
        within(group).getByRole("button", {
          name: new RegExp(`\\{\\{${key}\\}\\}.*${type}`),
        }),
      ).toBeTruthy();
    expect(within(group).queryByText("{{constructor}}")).toBeNull();
    expect(within(group).queryByText("{{duplicate}}")).toBeNull();
    expect(t.slot.getByText(/Fix field keys in Fields/)).toBeTruthy();
    const body = t.slot.getByLabelText(
      "First message template",
    ) as HTMLTextAreaElement;
    await act(async () => {
      body.focus();
      body.setSelectionRange(7, 13);
      fireEvent.select(body);
    });
    await act(async () =>
      within(group)
        .getByRole("button", { name: /\{\{subject\}\}/ })
        .click(),
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(body);
      expect(body.selectionStart).toBe(18);
      expect(body.selectionEnd).toBe(18);
    });
    expect(body.value).toBe("before {{subject}} after");
    const title = t.slot.getByLabelText(
      "Thread title template",
    ) as HTMLInputElement;
    await act(async () => {
      title.focus();
      title.setSelectionRange(6, 7);
      fireEvent.select(title);
    });
    await act(async () =>
      within(group)
        .getByRole("button", { name: /\{\{notes\}\}/ })
        .click(),
    );
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(title.value).toBe("Title {{notes}}");
    await act(async () => t.slot.getByRole("tab", { name: "Fields" }).click());
    await act(async () =>
      fireEvent.change(
        within(
          t.slot.container.querySelector(
            ".ntt-field-config:not([hidden])",
          ) as HTMLElement,
        ).getByLabelText("Stable key"),
        { target: { value: "renamed_subject" } },
      ),
    );
    await act(async () => t.slot.getByRole("tab", { name: "Prompt" }).click());
    expect(
      t.slot.getByRole("button", { name: /\{\{renamed_subject\}\}/ }),
    ).toBeTruthy();
    expect(
      t.slot.queryByRole("button", { name: /\{\{subject\}\}/ }),
    ).toBeNull();
    await act(async () =>
      t.slot.getByRole("button", { name: "Publish" }).click(),
    );
    await t.slot.findByText(/Unknown field subject/);
    expect(
      t.fixture.calls.filter((call) => call.method === "publish"),
    ).toHaveLength(0);
    await act(async () => t.slot.getByRole("tab", { name: "Fields" }).click());
    await act(async () =>
      t.slot.getByRole("button", { name: "Remove Subject label" }).click(),
    );
    await act(async () =>
      t.slot.getByRole("button", { name: "+ Add field" }).click(),
    );
    await act(async () => t.slot.getByRole("tab", { name: "Prompt" }).click());
    expect(
      t.slot.queryByRole("button", { name: /\{\{renamed_subject\}\}/ }),
    ).toBeNull();
    expect(t.slot.getByRole("button", { name: /\{\{field_/ })).toBeTruthy();
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("held Save rebases own newer text and partial numeric checkpoint without warning or premature leave", async () => {
  localStorage.clear();
  const t = await setup(true);
  let release = () => {};
  try {
    await managementReady(t.slot);
    await act(async () =>
      t.slot.getByRole("button", { name: "+ New template" }).click(),
    );
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Name"), {
        target: { value: "First save" },
      });
      t.slot.getByRole("button", { name: "+ Add field" }).click();
    });
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Type"), {
        target: { value: "number" },
      }),
    );
    await act(async () =>
      t.slot.getByText("Help, defaults and validation").click(),
    );
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Default value"), {
        target: { value: "1" },
      }),
    );
    release = t.fixture.holdResponse("saveDraft");
    await act(async () =>
      t.slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(
        t.fixture.calls.filter((call) => call.method === "saveDraft"),
      ).toHaveLength(1),
    );
    await act(async () => {
      fireEvent.change(t.slot.getByLabelText("Name"), {
        target: { value: "Newer unsaved work" },
      });
      fireEvent.change(t.slot.getByLabelText("Default value"), {
        target: { value: "-" },
      });
    });
    await act(async () => release());
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Save draft",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(t.slot.queryByText(/A newer local editor checkpoint/)).toBeNull();
    expect(t.slot.queryByText("Draft saved.")).toBeNull();
    const { listEditorCheckpoints } =
      await import("../ui/editor-checkpoint.ts");
    const address = t.fixture.personalAddress();
    const owner = `${address.instanceId}:${address.owner}`;
    const saved = listEditorCheckpoints(owner).items[0]!.checkpoint;
    expect(saved.definition.name).toBe("Newer unsaved work");
    expect(saved.numericText?.["fields.0.default"]).toBe("-");
    expect(saved.generation).toBe(1);
    expect(JSON.parse(saved.baseline).name).toBe("First save");
    await act(async () =>
      t.slot.getByRole("button", { name: "‹ All templates" }).click(),
    );
    await t.slot.findByRole("dialog", { name: "Unsaved template changes" });
    await act(async () => t.slot.getByRole("button", { name: "Stay" }).click());
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Default value"), {
        target: { value: "2" },
      }),
    );
    await act(async () =>
      t.slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(t.slot.queryByText(/ · unsaved changes/)).toBeNull(),
    );
    expect(
      t.fixture.calls.filter((call) => call.method === "saveDraft").at(-1)
        ?.input,
    ).toMatchObject({ expectedGeneration: 1 });
    expect(listEditorCheckpoints(owner).items).toHaveLength(0);
    expect(t.slot.queryAllByRole("alert")).toHaveLength(0);
  } finally {
    release();
    await t.close();
  }
});

test("Project Machine persists exact pin, requires deliberate workspace, routes native picker and never falls back for unavailable or reused targets", async () => {
  localStorage.clear();
  const t = await setup(true);
  try {
    await managementReady(t.slot);
    await act(async () =>
      t.slot.getAllByRole("button", { name: "Edit" })[0]!.click(),
    );
    await act(async () => t.slot.getByRole("tab", { name: "Project" }).click());
    await act(async () =>
      fireEvent.change(t.slot.getByRole("combobox", { name: "Project" }), {
        target: { value: "project-a" },
      }),
    );
    await act(async () =>
      fireEvent.change(t.slot.getByRole("combobox", { name: "Machine" }), {
        target: { value: "host-b" },
      }),
    );
    expect(
      (
        t.slot.getByRole("combobox", {
          name: "Environment",
        }) as HTMLSelectElement
      ).value,
    ).toBe("project-default");
    expect(
      t.slot.getByText(/Choose a source checkout or worktree for this machine/),
    ).toBeTruthy();
    await act(async () =>
      t.slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(t.slot.queryByText(/ · unsaved changes/)).toBeNull(),
    );
    expect(t.fixture.entries[0]!.draft!.definition.destination).toMatchObject({
      kind: "existing-project",
      projectId: "project-a",
      hostId: "host-b",
      environment: { kind: "project-default" },
    });
    await act(async () =>
      t.slot.getByRole("button", { name: "Publish" }).click(),
    );
    await t.slot.findByText(
      /A specific machine requires a source checkout or worktree/,
    );
    expect(
      t.fixture.calls.filter((call) => call.method === "publish"),
    ).toHaveLength(0);
    await act(async () =>
      fireEvent.change(t.slot.getByRole("combobox", { name: "Environment" }), {
        target: { value: "local-source" },
      }),
    );
    await waitFor(() =>
      expect(
        t.slot.queryByText(
          /A specific machine requires a source checkout or worktree/,
        ),
      ).toBeNull(),
    );
    await act(async () =>
      t.slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(t.slot.queryByText(/ · unsaved changes/)).toBeNull(),
    );
    await act(async () =>
      t.slot
        .getByRole("button", { name: "Preview with sample inputs" })
        .click(),
    );
    expect(
      t.slot.queryByText(
        /A specific machine requires a source checkout or worktree/,
      ),
    ).toBeNull();
    // Changing project AFTER pinning never silently returns to BB default.
    for (const projectId of ["project-b", "choose-at-launch", "project-a"]) {
      await act(async () =>
        fireEvent.change(t.slot.getByRole("combobox", { name: "Project" }), {
          target: { value: projectId },
        }),
      );
      expect(
        (t.slot.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement)
          .value,
      ).toBe("host-b");
      expect(
        (
          t.slot.getByRole("combobox", {
            name: "Environment",
          }) as HTMLSelectElement
        ).value,
      ).toBe("local-source");
    }
    await act(async () => t.slot.getByRole("tab", { name: "Model" }).click());
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Model policy"), {
        target: { value: "explicit" },
      }),
    );
    expect(
      t.slot
        .getByTestId("bb-provider-model-picker")
        .getAttribute("data-routing-id"),
    ).toBe("host-b");
    await act(async () => t.slot.getByRole("tab", { name: "Project" }).click());
    await act(async () =>
      fireEvent.change(t.slot.getByRole("combobox", { name: "Environment" }), {
        target: { value: "reuse" },
      }),
    );
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Existing environment"), {
        target: { value: "env-a" },
      }),
    );
    expect((t.slot.getByLabelText("Machine") as HTMLInputElement).value).toBe(
      "Fixture machine",
    );
    expect(t.slot.getByText(/saved machine differs/)).toBeTruthy();
    await act(async () =>
      t.slot
        .getByRole("button", { name: "Use this environment’s machine" })
        .click(),
    );
    expect(t.slot.queryByText(/saved machine differs/)).toBeNull();
    await act(async () =>
      t.slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(t.slot.queryByText(/ · unsaved changes/)).toBeNull(),
    );
    expect(t.fixture.entries[0]!.draft!.definition.destination).toMatchObject({
      hostId: "host-a",
      environment: { kind: "reuse", environmentId: "env-a" },
    });
    await act(async () =>
      fireEvent.change(t.slot.getByRole("combobox", { name: "Project" }), {
        target: { value: "project-b" },
      }),
    );
    expect(
      (t.slot.getByLabelText("Existing environment") as HTMLSelectElement)
        .value,
    ).toBe("env-a");
    expect((t.slot.getByLabelText("Machine") as HTMLInputElement).value).toBe(
      "Fixture machine",
    );
    expect(
      t.slot.getByText(
        /This environment is unavailable for the selected project/,
      ),
    ).toBeTruthy();
    await act(async () =>
      fireEvent.change(t.slot.getByRole("combobox", { name: "Project" }), {
        target: { value: "project-a" },
      }),
    );
    expect(
      t.slot.queryByText(
        /This environment is unavailable for the selected project/,
      ),
    ).toBeNull();

    await act(async () =>
      t.slot.getByRole("button", { name: "‹ All templates" }).click(),
    );
    t.fixture.context.hosts.splice(
      t.fixture.context.hosts.findIndex((host) => host.id === "host-a"),
      1,
    );
    const definition = t.fixture.entries[0]!.draft!.definition;
    definition.destination = {
      kind: "existing-project",
      projectId: "project-a",
      hostId: "host-a",
      environment: { kind: "local-source" },
    };
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await act(async () =>
      t.slot.getAllByRole("button", { name: "Edit" })[0]!.click(),
    );
    await act(async () => t.slot.getByRole("tab", { name: "Project" }).click());
    expect(
      (t.slot.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement)
        .value,
    ).toBe("host-a");
    expect(
      t.slot.getByText(/saved machine is unavailable or disconnected/),
    ).toBeTruthy();
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("genuinely newer external checkpoint survives held save and restored raw number remains usable", async () => {
  localStorage.clear();
  const t = await setup(true);
  let release = () => {};
  let again: ReturnType<typeof renderSlot> | null = null;
  let stop = () => {};
  try {
    await managementReady(t.slot);
    await act(async () =>
      t.slot.getAllByRole("button", { name: "Edit" })[0]!.click(),
    );
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Description"), {
        target: { value: "An acknowledged older edit" },
      }),
    );
    release = t.fixture.holdResponse("saveDraft");
    await act(async () =>
      t.slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(
        t.fixture.calls.filter((call) => call.method === "saveDraft"),
      ).toHaveLength(1),
    );
    const { writeEditorCheckpoint, readEditorCheckpoint } =
      await import("../ui/editor-checkpoint.ts");
    const entry = t.fixture.entries[0]!,
      address = t.fixture.personalAddress(),
      owner = `${address.instanceId}:${address.owner}`;
    const external = {
      ...entry.draft!.definition,
      name: "Newer external work",
      fields: [
        {
          key: "amount",
          label: "Amount",
          type: "number" as const,
          required: false,
          order: 0,
        },
      ],
    };
    expect(
      writeEditorCheckpoint(
        owner,
        external,
        JSON.stringify(entry.draft!.definition),
        entry.draft!.generation,
        { "fields.0.default": "1e" },
      ),
    ).toBeNull();
    await act(async () => release());
    await t.slot.findByText("A newer local editor checkpoint was retained.");
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    expect(
      t.slot.getByText("A newer local editor checkpoint was retained."),
    ).toBeTruthy();
    expect(
      readEditorCheckpoint(owner, entry.id).value?.numericText?.[
        "fields.0.default"
      ],
    ).toBe("1e");
    t.slot.lifecycle.unmount();
    again = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    stop = t.fixture.wire.onRealtime(
      (channel, payload) => void again?.behavior.emitRealtime(channel, payload),
    );
    await again.findByRole("button", { name: "Resume unfinished template" });
    await act(async () =>
      again!
        .getByRole("button", { name: "Resume unfinished template" })
        .click(),
    );
    expect((again.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Newer external work",
    );
    await act(async () =>
      again!.getByText("Help, defaults and validation").click(),
    );
    expect(
      (again.getByLabelText("Default value") as HTMLInputElement).value,
    ).toBe("1e");
    await act(async () =>
      fireEvent.change(again!.getByLabelText("Default value"), {
        target: { value: "2" },
      }),
    );
    await act(async () =>
      again!.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(readEditorCheckpoint(owner, entry.id).value).toBeNull(),
    );
    expect(again.queryAllByRole("alert")).toHaveLength(0);
    expect(t.fixture.entries[0]!.draft!.definition.fields[0]!.default).toBe(2);
  } finally {
    release();
    stop();
    again?.lifecycle.unmount();
    await t.close();
  }
});

test("save error survives unrelated catalog recovery and pending retry then clears only on same authoritative save", async () => {
  localStorage.clear();
  const t = await setup(true);
  let release = () => {};
  try {
    await managementReady(t.slot);
    await act(async () =>
      t.slot.getAllByRole("button", { name: "Edit" })[0]!.click(),
    );
    await act(async () =>
      fireEvent.change(t.slot.getByLabelText("Description"), {
        target: { value: "A retried edit" },
      }),
    );
    t.fixture.flags.saveError = true;
    await act(async () =>
      t.slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await t.slot.findByText("Shared draft write failed");
    t.fixture.flags.saveError = false;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    expect(t.slot.getByText("Shared draft write failed")).toBeTruthy();
    release = t.fixture.holdResponse("saveDraft");
    await act(async () =>
      t.slot.getByRole("button", { name: "Save draft" }).click(),
    );
    await waitFor(() =>
      expect(
        t.fixture.calls.filter((call) => call.method === "saveDraft"),
      ).toHaveLength(2),
    );
    expect(t.slot.getByText("Shared draft write failed")).toBeTruthy();
    await act(async () => release());
    await waitFor(() =>
      expect(t.slot.queryByText("Shared draft write failed")).toBeNull(),
    );
    expect(t.slot.queryByText(/ · unsaved changes/)).toBeNull();
    expect(t.slot.queryByText("Draft saved.")).toBeNull();
    expect(t.fixture.entries[0]!.draft!.definition.description).toBe(
      "A retried edit",
    );
  } finally {
    release();
    await t.close();
  }
});

test("mobile reachability keeps selected recovery and last-good content while cold empty chooser falls back", async () => {
  const t = await setup(false, (fixture) => fixture.wire.failNextLoads(1));
  const home = () =>
      t.slot.container.querySelector("[data-new-thread-templates-homepage]")!,
    form = () =>
      t.slot.container.querySelector("[data-new-thread-templates-form]")!;
  try {
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Reconnect inputs" });
    expect(home().getAttribute("data-new-thread-templates-homepage")).toBe(
      "selected",
    );
    expect(form().getAttribute("data-new-thread-templates-form")).toBe(
      "recovery",
    );
    await act(async () =>
      t.slot.getByRole("button", { name: "Reconnect inputs" }).click(),
    );
    await waitFor(() =>
      expect(form().getAttribute("data-new-thread-templates-form")).toBe(
        "usable",
      ),
    );
    t.fixture.flags.catalogError = true;
    t.fixture.flags.contextError = true;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await t.slot.findByText(/Destination choices could not refresh/);
    await t.slot.findByText(/Templates could not refresh/);
    expect(form().getAttribute("data-new-thread-templates-form")).toBe(
      "usable",
    );
    t.fixture.flags.catalogError = false;
    t.fixture.flags.contextError = false;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await waitFor(() =>
      expect(
        t.slot.queryByText(/Destination choices could not refresh/),
      ).toBeNull(),
    );
    await fillReview(t.slot);
    const release = t.fixture.holdResponse("launch");
    try {
      t.fixture.flags.launchMode = "unknown";
      await act(async () =>
        t.slot.getByRole("button", { name: "Start thread" }).click(),
      );
      await waitFor(() => expect(t.fixture.flags.launchCount).toBe(1));
      expect(form().getAttribute("data-new-thread-templates-form")).toBe(
        "usable",
      );
    } finally {
      await act(async () => release());
    }
    await t.slot.findByRole("button", { name: "Check launch status" });
    expect(form().getAttribute("data-new-thread-templates-form")).toBe(
      "usable",
    );
    for (const entry of t.fixture.entries) entry.published = null;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    expect(home().getAttribute("data-new-thread-templates-homepage")).toBe(
      "selected",
    );
    expect(form().getAttribute("data-new-thread-templates-form")).toBe(
      "usable",
    );
    await act(async () =>
      t.slot.getByRole("button", { name: "‹ All templates" }).click(),
    );
    await t.slot.findByText("No published templates yet.");
    expect(home().getAttribute("data-new-thread-templates-homepage")).toBe(
      "unavailable",
    );
  } finally {
    await t.close();
  }
});

test("mobile selected recovery stays reachable before first successful context", async () => {
  const t = await setup(false, (fixture) => {
    fixture.flags.contextError = true;
  });
  try {
    await openReview(t.slot);
    await t.slot.findByText(/Destination choices could not refresh/);
    const home = t.slot.container.querySelector(
        "[data-new-thread-templates-homepage]",
      )!,
      form = t.slot.container.querySelector(
        "[data-new-thread-templates-form]",
      )!;
    expect(home.getAttribute("data-new-thread-templates-homepage")).toBe(
      "selected",
    );
    expect(form.getAttribute("data-new-thread-templates-form")).toBe(
      "recovery",
    );
    t.fixture.flags.contextError = false;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await waitFor(() =>
      expect(form.getAttribute("data-new-thread-templates-form")).toBe(
        "usable",
      ),
    );
  } finally {
    await t.close();
  }
});

test("mobile borrowed read-only form keeps Back reachable with real shared personal binding", async () => {
  const fixture = await appFixture(`mobile-view-${crypto.randomUUID()}`);
  const identity = await import("@phosphorco/bb-identity/react");
  const { useMemo } = await import("react");
  const { TemplateRun } = await import("../ui/run.tsx");
  const { browserDrafts } = await import("../ui/drafts.ts");
  const { inputDraftResource } = await import("../model.ts");
  const drafts = browserDrafts(inputDraftResource.definition.codec);
  // Only the supplied, static view is a fixture. Provider, state binding,
  // controller and wire remain the product composition. No directory UI is added.
  function ReadOnlyScope() {
    const session = identity.useIdentitySession();
    const view = useMemo<
      import("@phosphorco/bb-identity/client").IdentityView | null
    >(() => {
      if (session.status !== "ready") return null;
      const snapshot = {
        status: "ready" as const,
        session,
        subject: {
          kind: "person" as const,
          key: fixture.wire.personKey("bea"),
          issuer: "fixture",
          subject: "bea",
        },
        overriding: true,
        viewGeneration: 1,
      };
      const unsupported = async () => ({
        ok: false as const,
        error: {
          code: "unsupported" as const,
          message: "Static borrowed-view fixture",
          retry: "never" as const,
        },
      });
      return {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        select: unsupported,
        reset: unsupported,
        registerGuard: () => () => {},
        dispose() {},
      };
    }, [session]);
    return view ? (
      <identity.BbIdentity.Context view={view}>
        <TemplateRun
          template={
            fixture.entries.find((entry) => entry.id === "review-pr")!
              .published!
          }
          projectId="project-a"
          drafts={drafts}
          onBack={() => {}}
          onEdit={() => {}}
        />
      </identity.BbIdentity.Context>
    ) : null;
  }
  function Surface() {
    const client = identity.useBbIdentityClient();
    return (
      <identity.BbIdentity.Provider client={client}>
        <ReadOnlyScope />
      </identity.BbIdentity.Provider>
    );
  }
  const slot = renderSlot(
    { component: Surface },
    {},
    { pluginId: "new-thread-templates", rpc: fixture.handlers },
  );
  const stop = fixture.wire.onRealtime(
    (channel, payload) => void slot.behavior.emitRealtime(channel, payload),
  );
  try {
    await slot.findByLabelText(/Pull request URL/);
    expect(
      slot.container
        .querySelector("[data-new-thread-templates-form]")
        ?.getAttribute("data-new-thread-templates-form"),
    ).toBe("recovery");
    expect(
      (slot.getByRole("button", { name: "Start thread" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(fixture.flags.launchCount).toBe(0);
  } finally {
    stop();
    slot.lifecycle.unmount();
    await act(async () => {});
    await fixture.dispose();
  }
});

function assignmentFor(
  f: Awaited<ReturnType<typeof appFixture>>,
  id: string,
  changes: Partial<import("../rpc-contract.ts").AssignmentStatus> = {},
): import("../rpc-contract.ts").AssignmentStatus {
  return {
    operationId: id,
    actorKey: f.wire.actor!.identity.key,
    threadId: "previous-confirmed-thread",
    state: "unknown",
    message: "Inbox response was not confirmed. Thread creation succeeded.",
    retryable: false,
    ...changes,
  };
}
async function openAssignmentHistory(slot: ReturnType<typeof renderSlot>) {
  await managementReady(slot);
  await act(async () => slot.getByRole("button", { name: "History" }).click());
  await slot.findByRole("button", { name: "Open thread" });
}
test("assignment History separates initial claim from current manual Unassign without a live template or passive writes", async () => {
  const id = crypto.randomUUID();
  let releaseRecent = () => {};
  const t = await setup(true, (f) => {
    f.useVerifiedAssignmentActor();
    seedSucceeded(f, id);
    f.launches.get(id)!.assignment = assignmentFor(f, id, {
      state: "claimed",
      receipt: {
        operationId: id,
        threadId: "previous-confirmed-thread",
        actorKey: f.wire.actor!.identity.key,
        outcome: "claimed",
        reason: "claimed-untouched",
        decidedAt: 1,
        ownerRevision: 1,
      },
      current: {
        threadId: "previous-confirmed-thread",
        revision: 2,
        ownerKeys: [],
        truncated: false,
        explicitlyUnassigned: true,
      },
    });
    f.entries.splice(0);
  });
  try {
    await openAssignmentHistory(t.slot);
    await t.slot.findByText("Inbox: unassigned.");
    expect(t.slot.getByRole("status").textContent).toContain(
      "Last checked Inbox assignment",
    );
    expect(t.slot.getByRole("status").querySelectorAll("button")).toHaveLength(
      0,
    );
    expect(
      t.slot.getByText("Initial Inbox assignment completed."),
    ).toBeTruthy();
    expect(t.slot.queryByText(/Inbox: assigned to Ada/)).toBeNull();
    expect(
      t.slot.queryByRole("button", { name: "Retry assignment" }),
    ).toBeNull();
    expect(
      t.fixture.calls.filter(
        (c) => c.method === "launchStatus" || c.method === "retryAssignment",
      ),
    ).toHaveLength(0);
    const beforeReads = t.fixture.calls.filter(
      (c) => c.method === "recentLaunches",
    ).length;
    releaseRecent = t.fixture.holdResponse("recentLaunches");
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await waitFor(() =>
      expect(
        t.fixture.calls.filter((c) => c.method === "recentLaunches").length,
      ).toBeGreaterThan(beforeReads),
    );
    t.fixture.launches.get(id)!.assignment!.current = {
      threadId: "previous-confirmed-thread",
      revision: 3,
      ownerKeys: [t.fixture.wire.personKey("bea")],
      truncated: false,
      explicitlyUnassigned: false,
    };
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await t.slot.findByText("Inbox: assigned to someone else.");
    await act(async () => releaseRecent());
    await act(async () => {});
    expect(t.slot.getByText("Inbox: assigned to someone else.")).toBeTruthy();
    expect(t.fixture.flags.launchCount).toBe(0);
    expect(
      t.fixture.calls.filter((c) => c.method === "retryAssignment"),
    ).toHaveLength(0);
    await act(async () =>
      t.slot.getByRole("button", { name: "Open thread" }).click(),
    );
    expect(
      t.slot.inspection.navigateCalls.some(
        (call) =>
          call.method === "toThread" &&
          call.threadId === "previous-confirmed-thread",
      ),
    ).toBe(true);
  } finally {
    releaseRecent();
    await t.close();
  }
});
test("unknown assignment permits only explicit same-op retry and matching Check recovers its own errors", async () => {
  const id = crypto.randomUUID();
  const t = await setup(true, (f) => {
    f.useVerifiedAssignmentActor();
    seedSucceeded(f, id);
    f.launches.get(id)!.assignment = assignmentFor(f, id);
  });
  try {
    await openAssignmentHistory(t.slot);
    await t.slot.findByText("Inbox assignment outcome unknown.");
    expect(
      t.slot.queryByRole("button", { name: "Retry assignment" }),
    ).toBeNull();
    t.fixture.flags.assignmentCheckError = true;
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await t.slot.findByText("Assignment lookup unavailable");
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    expect(t.slot.getByText("Assignment lookup unavailable")).toBeTruthy();
    t.fixture.flags.assignmentCheckError = false;
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await waitFor(() =>
      expect(t.slot.queryByText("Assignment lookup unavailable")).toBeNull(),
    );
    t.fixture.launches.get(id)!.assignment!.retryable = true;
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await t.slot.findByRole("button", { name: "Retry assignment" });
    expect(t.slot.queryByText("Assignment lookup unavailable")).toBeNull();
    t.fixture.flags.assignmentRetryError = true;
    await act(async () =>
      t.slot.getByRole("button", { name: "Retry assignment" }).click(),
    );
    await t.slot.findByText("Assignment response lost");
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    expect(t.slot.getByText("Assignment response lost")).toBeTruthy();
    t.fixture.flags.assignmentRetryError = false;
    t.fixture.launches.get(id)!.assignment = assignmentFor(t.fixture, id, {
      state: "skipped-preserved",
      retryable: false,
      receipt: {
        operationId: id,
        threadId: "previous-confirmed-thread",
        actorKey: t.fixture.wire.actor!.identity.key,
        outcome: "skipped-preserved",
        reason: "ownership-touched",
        decidedAt: 3,
        ownerRevision: 2,
      },
      current: {
        threadId: "previous-confirmed-thread",
        revision: 2,
        ownerKeys: [],
        truncated: false,
        explicitlyUnassigned: true,
      },
    });
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await t.slot.findByText("Inbox: unassigned.");
    expect(t.slot.queryByText("Assignment response lost")).toBeNull();
    expect(
      t.slot.queryByRole("button", { name: "Retry assignment" }),
    ).toBeNull();
    const attempts = t.fixture.calls.filter(
      (c) => c.method === "retryAssignment",
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.input).toMatchObject({
      operationId: id,
      expectedActor: t.fixture.wire.actor!.identity.key,
    });
    expect(t.fixture.flags.launchCount).toBe(0);
    expect(t.slot.getByRole("button", { name: "Open thread" })).toBeTruthy();
  } finally {
    await t.close();
  }
});
test("late assignment retry is fenced after original actor changes", async () => {
  const id = crypto.randomUUID();
  const t = await setup(true, (f) => {
    f.useVerifiedAssignmentActor();
    seedSucceeded(f, id);
    f.launches.get(id)!.assignment = assignmentFor(f, id, { retryable: true });
    f.flags.assignmentRetryResult = assignmentFor(f, id, {
      state: "claimed",
      retryable: false,
      current: {
        threadId: "previous-confirmed-thread",
        revision: 1,
        ownerKeys: [f.wire.actor!.identity.key],
        truncated: false,
        explicitlyUnassigned: false,
      },
    });
  });
  const release = t.fixture.holdResponse("retryAssignment");
  try {
    await openAssignmentHistory(t.slot);
    await t.slot.findByRole("button", { name: "Retry assignment" });
    await act(async () => {
      t.slot.getByRole("button", { name: "Retry assignment" }).click();
      t.slot.getByRole("button", { name: "Retry assignment" }).click();
    });
    await waitFor(() =>
      expect(t.fixture.calls.some((c) => c.method === "retryAssignment")).toBe(
        true,
      ),
    );
    expect(
      t.fixture.calls.filter((c) => c.method === "retryAssignment"),
    ).toHaveLength(1);
    await act(async () => t.fixture.wire.switchActor("bea"));
    await waitFor(() =>
      expect(
        t.slot.queryByRole("button", { name: "Check assignment" }),
      ).toBeNull(),
    );
    await act(async () => release());
    expect(t.slot.queryByText("Inbox: assigned to Ada Fixture.")).toBeNull();
    expect(
      t.slot.queryByRole("button", { name: "Retry assignment" }),
    ).toBeNull();
    expect(
      t.slot.inspection.navigateCalls.filter((c) => c.method === "toThread"),
    ).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    release();
    await t.close();
  }
});
test("optional assignment failure never blocks direct or full native confirmed cleanup and navigation", async () => {
  for (const native of [false, true]) {
    const t = await setup(false, (f) => {
      f.flags.assignment = assignmentFor(f, crypto.randomUUID(), {
        state: native ? "unknown" : "unavailable",
        message: "Inbox is optional; creation is confirmed.",
      });
    });
    try {
      await openReview(t.slot);
      await fillReview(t.slot);
      if (native) {
        await waitFor(() =>
          expect(
            (
              t.slot.getByRole("button", {
                name: "Edit with BB",
              }) as HTMLButtonElement
            ).disabled,
          ).toBe(false),
        );
        await act(async () =>
          t.slot.getByRole("button", { name: "Edit with BB" }).click(),
        );
        await t.slot.findByTestId("bb-new-thread-composer");
        await act(async () =>
          t.slot.getByTestId("bb-new-thread-composer-submit").click(),
        );
      } else
        await act(async () =>
          t.slot.getByRole("button", { name: "Start thread" }).click(),
        );
      await waitFor(() =>
        expect(
          t.slot.inspection.navigateCalls.filter(
            (c) => c.method === "toThread",
          ),
        ).toHaveLength(1),
      );
      await waitFor(async () =>
        expect((await t.fixture.readPersonal())?.operationId).toBeUndefined(),
      );
      expect((await t.fixture.readPersonal())?.nativeOperation).toBeUndefined();
      expect(t.fixture.flags.launchCount).toBe(1);
      expect(
        t.fixture.calls.filter((c) => c.method === "retryAssignment"),
      ).toHaveLength(0);
    } finally {
      await t.close();
    }
  }
});

test("assignment recovery excludes ineligible actor evidence, machine fallback and historical rows without intent", async () => {
  for (const scenario of ["asserted-person", "machine", "no-intent"] as const) {
    const id = crypto.randomUUID();
    const t = await setup(true, (f) => {
      seedSucceeded(f, id);
      if (scenario !== "no-intent")
        f.launches.get(id)!.assignment = assignmentFor(f, id, {
          retryable: true,
        });
      if (scenario === "machine") {
        // Synthetic machine session with the same key deliberately challenges
        // kind/evidence gating; no provider identity proof is claimed here.
        Object.assign(f.wire.actor!, {
          identity: {
            kind: "machine",
            key: f.wire.actor!.identity.key,
            instanceId: f.personalAddress().instanceId,
            hostId: "host-a",
          },
          evidence: "machine",
        });
      }
    });
    try {
      await openAssignmentHistory(t.slot);
      expect(
        t.slot.queryByRole("button", { name: "Check assignment" }),
      ).toBeNull();
      expect(
        t.slot.queryByRole("button", { name: "Retry assignment" }),
      ).toBeNull();
      expect(
        t.fixture.calls.filter(
          (c) => c.method === "launchStatus" || c.method === "retryAssignment",
        ),
      ).toHaveLength(0);
      expect(t.fixture.flags.launchCount).toBe(0);
    } finally {
      await t.close();
    }
  }
});

test("borrowed view-as cannot Check or Retry assignment for the submitting actor", async () => {
  const f = await appFixture(`assignment-view-${crypto.randomUUID()}`);
  f.useVerifiedAssignmentActor();
  const id = crypto.randomUUID();
  seedSucceeded(f, id);
  const status = f.launches.get(id)!;
  status.assignment = assignmentFor(f, id, { retryable: true });
  const identity = await import("@phosphorco/bb-identity/react");
  const { useMemo } = await import("react");
  const { AssignmentResult } = await import("../ui/assignment.tsx");
  function Scope() {
    const session = identity.useIdentitySession();
    const view = useMemo<
      import("@phosphorco/bb-identity/client").IdentityView | null
    >(() => {
      if (session.status !== "ready") return null;
      const snapshot = {
        status: "ready" as const,
        session,
        subject: {
          kind: "person" as const,
          key: f.wire.personKey("bea"),
          issuer: "fixture",
          subject: "bea",
        },
        overriding: true,
        viewGeneration: 1,
      };
      const unsupported = async () => ({
        ok: false as const,
        error: {
          code: "unsupported" as const,
          message: "Static view fixture",
          retry: "never" as const,
        },
      });
      return {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        select: unsupported,
        reset: unsupported,
        registerGuard: () => () => {},
        dispose() {},
      };
    }, [session]);
    return view ? (
      <identity.BbIdentity.Context view={view}>
        <AssignmentResult status={status} />
      </identity.BbIdentity.Context>
    ) : null;
  }
  function Surface() {
    const client = identity.useBbIdentityClient();
    return (
      <identity.BbIdentity.Provider client={client}>
        <Scope />
      </identity.BbIdentity.Provider>
    );
  }
  const slot = renderSlot(
    { component: Surface },
    {},
    { pluginId: "new-thread-templates", rpc: f.handlers },
  );
  try {
    await slot.findByText("Inbox assignment outcome unknown.");
    expect(slot.queryByRole("button", { name: "Check assignment" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Retry assignment" })).toBeNull();
    expect(
      f.calls.filter(
        (c) => c.method === "launchStatus" || c.method === "retryAssignment",
      ),
    ).toHaveLength(0);
  } finally {
    slot.lifecycle.unmount();
    await act(async () => {});
    await f.dispose();
  }
});

test("truncated 200-owner assignment snapshot cannot prove original actor absent while positive membership remains truthful", async () => {
  const id = crypto.randomUUID(),
    owners = Array.from({ length: 200 }, (_, i) => `fixture:owner-${i}`);
  const t = await setup(true, (f) => {
    f.useVerifiedAssignmentActor();
    seedSucceeded(f, id);
    f.launches.get(id)!.assignment = assignmentFor(f, id, {
      state: "claimed",
      receipt: {
        operationId: id,
        threadId: "previous-confirmed-thread",
        actorKey: f.wire.actor!.identity.key,
        outcome: "claimed",
        reason: "claimed-untouched",
        decidedAt: 1,
        ownerRevision: 1,
      },
      current: {
        threadId: "previous-confirmed-thread",
        revision: 2,
        ownerKeys: owners,
        truncated: true,
        explicitlyUnassigned: false,
      },
    });
  });
  try {
    await openAssignmentHistory(t.slot);
    await t.slot.findByText(
      "Inbox: ownership list is partial; assignment to Ada Fixture is unknown.",
    );
    expect(t.slot.queryByText("Inbox: assigned to someone else.")).toBeNull();
    expect(t.slot.queryByText("Inbox: unassigned.")).toBeNull();
    const current = t.fixture.launches.get(id)!.assignment!.current!;
    current.ownerKeys = [
      t.fixture.wire.actor!.identity.key,
      ...owners.slice(0, 199),
    ];
    current.revision++;
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await t.slot.findByText("Inbox: assigned to Ada Fixture and others.");
    expect(t.slot.queryByText(/ownership list is partial/)).toBeNull();
    expect(
      t.fixture.calls.filter((c) => c.method === "retryAssignment"),
    ).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("held assignment Check cannot undo newer parent ownership and does not reassign", async () => {
  const id = crypto.randomUUID();
  const t = await setup(true, (f) => {
    f.useVerifiedAssignmentActor();
    seedSucceeded(f, id);
    f.launches.get(id)!.assignment = assignmentFor(f, id, {
      state: "claimed",
      receipt: {
        operationId: id,
        threadId: "previous-confirmed-thread",
        actorKey: f.wire.actor!.identity.key,
        outcome: "claimed",
        reason: "claimed-untouched",
        decidedAt: 1,
        ownerRevision: 1,
      },
      current: {
        threadId: "previous-confirmed-thread",
        revision: 2,
        ownerKeys: [f.wire.actor!.identity.key],
        truncated: false,
        explicitlyUnassigned: false,
      },
    });
  });
  const release = t.fixture.holdResponse("launchStatus");
  try {
    await openAssignmentHistory(t.slot);
    await t.slot.findByText("Inbox: assigned to Ada Fixture.");
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await waitFor(() =>
      expect(t.fixture.calls.some((c) => c.method === "launchStatus")).toBe(
        true,
      ),
    );
    t.fixture.launches.get(id)!.assignment!.current = {
      threadId: "previous-confirmed-thread",
      revision: 3,
      ownerKeys: [],
      truncated: false,
      explicitlyUnassigned: true,
    };
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await t.slot.findByText("Inbox: unassigned.");
    await act(async () => release());
    await waitFor(() =>
      expect(
        (
          t.slot.getByRole("button", {
            name: "Check assignment",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(t.slot.getByText("Inbox: unassigned.")).toBeTruthy();
    expect(t.slot.queryByText("Inbox: assigned to Ada Fixture.")).toBeNull();
    expect(
      t.fixture.calls.filter((c) => c.method === "retryAssignment"),
    ).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    release();
    await t.close();
  }
});

test("replayed parent facts already learned by Check cannot clear a newer provider lookup error", async () => {
  const id = crypto.randomUUID();
  const t = await setup(true, (f) => {
    f.useVerifiedAssignmentActor();
    seedSucceeded(f, id);
    f.launches.get(id)!.assignment = assignmentFor(f, id);
  });
  try {
    await openAssignmentHistory(t.slot);
    await t.slot.findByText("Inbox assignment outcome unknown.");
    t.fixture.launches.get(id)!.assignment = assignmentFor(t.fixture, id, {
      state: "claimed",
      receipt: {
        operationId: id,
        threadId: "previous-confirmed-thread",
        actorKey: t.fixture.wire.actor!.identity.key,
        outcome: "claimed",
        reason: "claimed-untouched",
        decidedAt: 1,
        ownerRevision: 1,
      },
      current: {
        threadId: "previous-confirmed-thread",
        revision: 1,
        ownerKeys: [t.fixture.wire.actor!.identity.key],
        truncated: false,
        explicitlyUnassigned: false,
      },
    });
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await t.slot.findByText("Inbox: assigned to Ada Fixture.");
    t.fixture.flags.assignmentCheckError = true;
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await t.slot.findByText("Assignment lookup unavailable");
    const beforeReads = t.fixture.calls.filter(
      (c) => c.method === "recentLaunches",
    ).length;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await waitFor(() =>
      expect(
        t.fixture.calls.filter((c) => c.method === "recentLaunches").length,
      ).toBeGreaterThan(beforeReads),
    );
    await act(async () => {});
    expect(t.slot.getByText("Assignment lookup unavailable")).toBeTruthy();
    t.fixture.flags.assignmentCheckError = false;
    await act(async () =>
      t.slot.getByRole("button", { name: "Check assignment" }).click(),
    );
    await waitFor(() =>
      expect(t.slot.queryByText("Assignment lookup unavailable")).toBeNull(),
    );
    expect(t.slot.getByText("Inbox: assigned to Ada Fixture.")).toBeTruthy();
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});

test("assignment response after surface disposal remains recoverable by original person without passive retry or another spawn", async () => {
  const id = crypto.randomUUID();
  const t = await setup(true, (f) => {
    f.useVerifiedAssignmentActor();
    seedSucceeded(f, id);
    f.launches.get(id)!.assignment = assignmentFor(f, id, { retryable: true });
    f.flags.assignmentRetryResult = assignmentFor(f, id, {
      state: "claimed",
      retryable: false,
      receipt: {
        operationId: id,
        threadId: "previous-confirmed-thread",
        actorKey: f.wire.actor!.identity.key,
        outcome: "claimed",
        reason: "claimed-untouched",
        decidedAt: 1,
        ownerRevision: 1,
      },
      current: {
        threadId: "previous-confirmed-thread",
        revision: 1,
        ownerKeys: [f.wire.actor!.identity.key],
        truncated: false,
        explicitlyUnassigned: false,
      },
    });
  });
  const release = t.fixture.holdResponse("retryAssignment");
  let reopened: ReturnType<typeof renderSlot> | undefined;
  let stop = () => {};
  try {
    await openAssignmentHistory(t.slot);
    await t.slot.findByRole("button", { name: "Retry assignment" });
    await act(async () =>
      t.slot.getByRole("button", { name: "Retry assignment" }).click(),
    );
    await waitFor(() =>
      expect(
        t.fixture.calls.filter((c) => c.method === "retryAssignment"),
      ).toHaveLength(1),
    );
    t.slot.lifecycle.unmount();
    await act(async () => release());
    expect(
      t.slot.inspection.navigateCalls.filter((c) => c.method === "toThread"),
    ).toHaveLength(0);
    reopened = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { pluginId: "new-thread-templates", rpc: t.fixture.handlers },
    );
    stop = t.fixture.wire.onRealtime(
      (channel, payload) =>
        void reopened!.behavior.emitRealtime(channel, payload),
    );
    await openAssignmentHistory(reopened);
    await reopened.findByText("Inbox: assigned to Ada Fixture.");
    await act(async () =>
      reopened!.getByRole("button", { name: "Check assignment" }).click(),
    );
    await waitFor(() =>
      expect(
        (
          reopened!.getByRole("button", {
            name: "Check assignment",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      t.fixture.calls.filter((c) => c.method === "retryAssignment"),
    ).toHaveLength(1);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    release();
    stop();
    reopened?.lifecycle.unmount();
    await t.close();
  }
});

test("panel correction: keyboard card activation enters named non-input heading and Back restores card focus", async () => {
  const t = await setup();
  try {
    const card = await t.slot.findByRole("button", { name: /PR Review/ });
    await act(async () => {
      card.focus();
      card.click();
    });
    const heading = await t.slot.findByRole("heading", { name: "PR Review" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).not.toBe(
      t.slot.getByLabelText(/Pull request URL/),
    );
    await act(async () =>
      t.slot.getByRole("button", { name: "‹ All templates" }).click(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        t.slot.getByRole("button", { name: /PR Review/ }),
      ),
    );
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});
test("panel correction: stale History Check rejection cannot replace newer authoritative recovery", async () => {
  const t = await setup(true, (f) => f.seedRecent(1));
  let reject!: (error: Error) => void;
  const held = new Promise<never>((_, no) => (reject = no));
  t.fixture.handlers.launchStatus = () => held;
  try {
    await managementReady(t.slot);
    await act(async () =>
      t.slot.getByRole("button", { name: "History" }).click(),
    );
    await t.slot.findByRole("button", { name: "Check launch status" });
    await act(async () =>
      t.slot.getByRole("button", { name: "Check launch status" }).click(),
    );
    const current = [...t.fixture.launches.values()][0]!;
    current.message = "New authoritative History state";
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await t.slot.findByText("New authoritative History state");
    await act(async () => reject(new Error("Obsolete History failure")));
    expect(t.slot.queryByText("Obsolete History failure")).toBeNull();
  } finally {
    reject(new Error("disposed"));
    await t.close();
  }
});
test("panel correction: selected initial context failure exposes recovery marker while Send remains disabled", async () => {
  const t = await setup(false, (f) => {
    f.flags.contextError = true;
    f.wire.failNextLoads(1);
  });
  try {
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Reconnect inputs" });
    await t.slot.findByText(/Destination choices could not refresh/);
    expect(
      t.slot.container
        .querySelector("[data-new-thread-templates-form]")!
        .getAttribute("data-new-thread-templates-form"),
    ).toBe("recovery");
    expect(
      (
        t.slot.getByRole("button", {
          name: "Start thread",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        t.slot.getByRole("button", {
          name: "‹ All templates",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  } finally {
    await t.close();
  }
});
for (const native of [false, true])
  test(`panel correction: reload resumes exact saved ${native ? "native" : "direct"} request with same operation and original inputs`, async () => {
    const id = crypto.randomUUID();
    let request!: import("../rpc-contract.ts").LaunchRequest;
    const t = await setup(false, (f) => {
      seedSucceeded(f, id);
      const old = f.launches.get(id)!;
      request = {
        operationId: id,
        templateId: "review-pr",
        revision: 1,
        inputs: structuredClone(old.inputs),
        expectedActor: f.wire.actor!.identity.key,
        expectedSession: "historic-session",
        ...(native
          ? {
              nativeSubmission: {
                projectId: "project-b",
                providerId: "provider-a",
                model: "model-a",
                reasoningLevel: "medium",
                permissionMode: "auto",
                executionInputSources: {},
                environment: { type: "project-default" as const },
                input: [
                  {
                    type: "text" as const,
                    text: "Exact saved native body",
                    mentions: [],
                  },
                ],
              },
            }
          : { projectId: "project-a" }),
      };
      f.launches.delete(id);
      f.seedPersonal({
        inputs: {
          pr_url: "https://example.test/changed",
          subject: "Current form differs",
        },
        projectId: "project-b",
        operationId: id,
        revision: 1,
        launchCheckpoint: { version: 1, request },
      });
    });
    try {
      await openReview(t.slot);
      const resume = await t.slot.findByRole("button", {
        name: "Resume saved request",
      });
      expect(t.fixture.flags.launchCount).toBe(0);
      await act(async () => resume.click());
      await waitFor(() =>
        expect(t.fixture.calls.some((c) => c.method === "resumeLaunch")).toBe(
          true,
        ),
      );
      const call = t.fixture.calls.find((c) => c.method === "resumeLaunch")!
        .input as {
        checkpoint: import("../model.ts").LaunchCheckpoint;
        expectedActor: string;
        expectedSession: string;
      };
      expect(call.checkpoint.request).toEqual(request);
      expect(call.expectedActor).toBe(request.expectedActor);
      expect(call.expectedSession).not.toBe("historic-session");
      await waitFor(() =>
        expect(
          t.slot.inspection.navigateCalls.some((c) => c.method === "toThread"),
        ).toBe(true),
      );
      expect(
        (await t.fixture.readPersonal())?.launchCheckpoint,
      ).toBeUndefined();
    } finally {
      await t.close();
    }
  });
test("panel correction: legacy reference with absent journal is explicitly check-only without rebuilding current request", async () => {
  const id = crypto.randomUUID();
  const t = await setup(false, (f) =>
    f.seedPersonal({
      inputs: {
        subject: "Retained legacy work",
        pr_url: "https://example.test/legacy",
      },
      operationId: id,
      revision: 1,
    }),
  );
  try {
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Check launch status" });
    await t.slot.findByText(/original request cannot be safely recovered/i);
    expect(
      t.slot.queryByRole("button", { name: "Resume saved request" }),
    ).toBeNull();
    expect(
      t.slot.queryByRole("button", { name: "Edit inputs for a new launch" }),
    ).toBeNull();
    expect(t.fixture.flags.launchCount).toBe(0);
    expect((await t.fixture.readPersonal())?.operationId).toBe(id);
  } finally {
    await t.close();
  }
});

test("panel correction: unreadable local recovery is visible and retained when review fails", async () => {
  const t = await setup(false, (f) => f.wire.failNextLoads(1));
  const address = t.fixture.personalAddress(),
    actor = t.fixture.wire.actor!.identity.key;
  const rawKey = JSON.stringify([
    JSON.stringify([
      address.instanceId,
      address.pluginId,
      address.collection,
      address.recordId,
      address.owner,
    ]),
    actor,
    "broken-checkpoint",
  ]);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("new-thread-templates-recovery-v1", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("drafts", { keyPath: "key" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const raw = {
    key: rawKey,
    revision: 1,
    draft: { unreadable: "retained unfinished work" },
  };
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("drafts", "readwrite");
    tx.objectStore("drafts").put(raw);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  try {
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Reconnect inputs" });
    await t.slot.findByRole("button", { name: "Review recovery drafts" });
    await act(async () =>
      t.slot.getByRole("button", { name: "Review recovery drafts" }).click(),
    );
    await t.slot.findByText(
      "A saved recovery draft is unreadable. It has been retained.",
    );
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    expect(
      t.slot.getByText(
        "A saved recovery draft is unreadable. It has been retained.",
      ),
    ).toBeTruthy();
    const retained = await new Promise<unknown>((resolve, reject) => {
      const tx = database.transaction("drafts", "readonly"),
        get = tx.objectStore("drafts").get(rawKey);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    expect(retained).toEqual(raw);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    database.close();
    await t.close();
  }
});

test("panel correction: older History catch and finally cannot clear a newer busy Check or attach a stale Retry error", async () => {
  for (const retry of [false, true]) {
    const t = await setup(true, (f) => {
      f.seedRecent(1);
      if (retry) {
        const row = [...f.launches.values()][0]!;
        row.phase = "failed";
        row.retryable = true;
      }
    });
    let rejectOld!: (e: Error) => void,
      releaseNew!: (
        value: import("../rpc-contract.ts").LaunchStatus | null,
      ) => void;
    const old = new Promise<never>((_, reject) => (rejectOld = reject)),
      newer = new Promise<import("../rpc-contract.ts").LaunchStatus | null>(
        (yes) => (releaseNew = yes),
      );
    const status = [...t.fixture.launches.values()][0]!;
    if (retry) t.fixture.handlers.launch = () => old;
    else t.fixture.handlers.launchStatus = () => old;
    try {
      await managementReady(t.slot);
      await act(async () =>
        t.slot.getByRole("button", { name: "History" }).click(),
      );
      await t.slot.findByRole("button", {
        name: retry ? "Retry preparation" : "Check launch status",
      });
      await act(async () =>
        t.slot
          .getByRole("button", {
            name: retry ? "Retry preparation" : "Check launch status",
          })
          .click(),
      );
      status.message = "Newer authoritative status";
      await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
      await t.slot.findByText("Newer authoritative status");
      t.fixture.handlers.launchStatus = () => newer;
      await act(async () =>
        t.slot.getByRole("button", { name: "Check launch status" }).click(),
      );
      await act(async () =>
        rejectOld(new Error("Old request error must stay fenced")),
      );
      expect(
        t.slot.queryByText("Old request error must stay fenced"),
      ).toBeNull();
      expect(
        (
          t.slot.getByRole("button", {
            name: "Check launch status",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await act(async () => releaseNew(structuredClone(status)));
      await waitFor(() =>
        expect(
          (
            t.slot.getByRole("button", {
              name: "Check launch status",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      expect(t.fixture.flags.launchCount).toBe(0);
    } finally {
      rejectOld(new Error("disposed"));
      releaseNew?.(null);
      await t.close();
    }
  }
});
test("panel correction: History Retry rejection stays with original actor and session", async () => {
  const t = await setup(true, (f) => {
    f.seedRecent(1);
    const row = [...f.launches.values()][0]!;
    row.phase = "failed";
    row.retryable = true;
  });
  let reject!: (error: Error) => void;
  const held = new Promise<never>((_, no) => (reject = no));
  t.fixture.handlers.launch = () => held;
  try {
    await managementReady(t.slot);
    await act(async () =>
      t.slot.getByRole("button", { name: "History" }).click(),
    );
    await t.slot.findByRole("button", { name: "Retry preparation" });
    await act(async () =>
      t.slot.getByRole("button", { name: "Retry preparation" }).click(),
    );
    await act(async () => t.fixture.wire.switchActor("bea"));
    await act(async () => reject(new Error("Original actor's delayed error")));
    expect(t.slot.queryByText("Original actor's delayed error")).toBeNull();
    expect(
      t.slot.inspection.navigateCalls.filter((c) => c.method === "toThread"),
    ).toHaveLength(0);
  } finally {
    reject(new Error("disposed"));
    await t.close();
  }
});
test("panel correction: saved unknown server effect stays check-only despite exact checkpoint", async () => {
  const id = crypto.randomUUID();
  const t = await setup(false, (f) => {
    seedSucceeded(f, id);
    const old = f.launches.get(id)!;
    old.phase = "indeterminate";
    old.threadId = null;
    old.message = "Native effect is unknown";
    const request = {
      operationId: id,
      templateId: "review-pr",
      revision: 1,
      inputs: old.inputs,
      expectedActor: f.wire.actor!.identity.key,
      expectedSession: "historic-session",
    };
    f.seedPersonal({
      inputs: old.inputs,
      operationId: id,
      launchCheckpoint: { version: 1, request },
    });
  });
  try {
    await openReview(t.slot);
    await t.slot.findByText("Native effect is unknown");
    expect(
      t.slot.queryByRole("button", { name: "Resume saved request" }),
    ).toBeNull();
    await act(async () =>
      t.slot.getByRole("button", { name: "Check launch status" }).click(),
    );
    expect(
      t.fixture.calls.filter((c) => c.method === "resumeLaunch"),
    ).toHaveLength(0);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});
test("panel correction: new direct and native sends persist exact checkpoint before any launch dispatch", async () => {
  for (const native of [false, true]) {
    const t = await setup();
    const original = t.fixture.handlers.launch!;
    let witnessed = false;
    t.fixture.handlers.launch = async (raw) => {
      const saved = await t.fixture.readPersonal();
      expect(saved?.launchCheckpoint).toEqual({ version: 1, request: raw });
      expect(saved?.operationId).toBe(
        (raw as import("../model.ts").LaunchRequest).operationId,
      );
      witnessed = true;
      return original(raw);
    };
    try {
      await openReview(t.slot);
      await fillReview(t.slot);
      if (native) {
        await waitFor(() =>
          expect(
            (
              t.slot.getByRole("button", {
                name: "Edit with BB",
              }) as HTMLButtonElement
            ).disabled,
          ).toBe(false),
        );
        await act(async () =>
          t.slot.getByRole("button", { name: "Edit with BB" }).click(),
        );
        await t.slot.findByTestId("bb-new-thread-composer");
        await act(async () =>
          t.slot.getByTestId("bb-new-thread-composer-submit").click(),
        );
      } else
        await act(async () =>
          t.slot.getByRole("button", { name: "Start thread" }).click(),
        );
      await waitFor(() => expect(witnessed).toBe(true));
      await waitFor(() =>
        expect(
          t.slot.inspection.navigateCalls.some(
            (call) => call.method === "toThread",
          ),
        ).toBe(true),
      );
      await waitFor(async () =>
        expect((await t.fixture.readPersonal())?.operationId).toBeUndefined(),
      );
      expect(
        (await t.fixture.readPersonal())?.launchCheckpoint,
      ).toBeUndefined();
    } finally {
      await t.close();
    }
  }
});

test("panel correction: failed Restore and Discard keep checkpoint visible until matching successful recovery", async () => {
  const t = await setup(false, (f) => f.wire.failNextLoads(1));
  const { browserDrafts } = await import("../ui/drafts.ts"),
    { inputDraftResource } = await import("../model.ts"),
    { idCodec } = await import("@phosphorco/bb-identity/model");
  const address = t.fixture.personalAddress(),
    actor = t.fixture.wire.actor!.identity.key,
    owner = idCodec("owner-session").decode("prior-surface");
  if (!owner.ok) throw new Error("fixture owner");
  const drafts = browserDrafts(inputDraftResource.definition.codec);
  const saved = await drafts.write(
    {
      formatVersion: 1,
      key: { address, actor, ownerSession: owner.value },
      schemaVersion: 1,
      localGeneration: 1,
      acknowledged: {
        status: "empty",
        address,
        version: { epoch: "empty", sequence: 0 },
      },
      desired: {
        inputs: {
          subject: "Retained checkpoint work",
          pr_url: "https://example.test/recovery",
        },
      },
      inFlight: null,
    },
    null,
  );
  expect(saved.ok).toBe(true);
  const originalOpen = indexedDB.open;
  try {
    await openReview(t.slot);
    await t.slot.findByRole("button", { name: "Reconnect inputs" });
    await act(async () =>
      t.slot.getByRole("button", { name: "Review recovery drafts" }).click(),
    );
    await t.slot.findByRole("button", { name: "Restore inputs" });
    t.fixture.wire.failNextLoads(1);
    await act(async () =>
      t.slot.getByRole("button", { name: "Restore inputs" }).click(),
    );
    await waitFor(() =>
      expect(
        t.slot
          .getAllByRole("alert")
          .some((el) =>
            el.textContent?.includes("Controlled state read failure"),
          ),
      ).toBe(true),
    );
    expect(t.slot.getByRole("button", { name: "Restore inputs" })).toBeTruthy();
    indexedDB.open = () => {
      throw new Error("Storage temporarily unavailable");
    };
    await act(async () =>
      t.slot
        .getByRole("button", { name: "Discard this recovery draft" })
        .click(),
    );
    await t.slot.findByText(
      "Browser draft storage is unavailable. Save your inputs before leaving.",
    );
    expect(t.slot.getByRole("button", { name: "Restore inputs" })).toBeTruthy();
    indexedDB.open = originalOpen;
    const retained = await drafts.find(address, actor, 20);
    expect(
      retained.ok &&
        retained.value.some(
          (candidate) =>
            candidate.draft.desired.inputs.subject ===
            "Retained checkpoint work",
        ),
    ).toBe(true);
    await act(async () =>
      t.slot
        .getByRole("button", { name: "Discard this recovery draft" })
        .click(),
    );
    await waitFor(() =>
      expect(
        t.slot.queryAllByText(
          "Browser draft storage is unavailable. Save your inputs before leaving.",
        ).length,
      ).toBe(0),
    );
    expect(
      t.slot.queryByRole("button", { name: "Discard this recovery draft" }),
    ).toBeNull();
  } finally {
    indexedDB.open = originalOpen;
    await t.close();
  }
});

test("panel correction: History refresh follows variable authoritative page boundaries without skips", async () => {
  const t = await setup(true, (f) => {
    f.seedRecent(7);
    f.flags.recentPageSize = 3;
  });
  try {
    await managementReady(t.slot);
    await act(async () =>
      t.slot.getByRole("button", { name: "History" }).click(),
    );
    await t.slot.findByRole("heading", { name: "Recent fixture 2" });
    await act(async () =>
      t.slot.getByRole("button", { name: "Load older launches" }).click(),
    );
    await t.slot.findByRole("heading", { name: "Recent fixture 5" });
    t.fixture.flags.recentPageSize = 2;
    const before = t.fixture.calls.length;
    await t.slot.behavior.emitRealtime(TEMPLATES_CHANGED, {});
    await waitFor(() =>
      expect(
        t.fixture.calls
          .slice(before)
          .filter((c) => c.method === "recentLaunches"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        t.slot.queryAllByRole("heading", { name: "Recent fixture 2" }),
      ).toHaveLength(1),
    );
    expect(
      t.fixture.calls
        .slice(before)
        .filter((c) => c.method === "recentLaunches")
        .map((c) => (c.input as { offset: number }).offset),
    ).toEqual([0, 2]);
    await act(async () =>
      t.slot.getByRole("button", { name: "Load older launches" }).click(),
    );
    await t.slot.findByRole("heading", { name: "Recent fixture 5" });
    await act(async () =>
      t.slot.getByRole("button", { name: "Load older launches" }).click(),
    );
    await t.slot.findByRole("heading", {
      name: "Historical unpublished review",
    });
    expect(t.slot.getAllByRole("heading", { level: 3 })).toHaveLength(8);
    expect(t.fixture.flags.launchCount).toBe(0);
  } finally {
    await t.close();
  }
});
