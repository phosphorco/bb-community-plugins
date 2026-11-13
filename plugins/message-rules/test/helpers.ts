import Database from "better-sqlite3";
import { createStore } from "../state/store.ts";
import { newRule, newGroup, defaultConnection } from "../contracts/model.ts";
import type { Rule, Capture } from "../contracts/model.ts";
import { fixtureTemplate } from "../contracts/template.ts";
import { sha256 } from "../contracts/hash.ts";
import type { FilePort } from "../files/files.ts";
import type { Wire, Transport } from "../evaluation/evaluator.ts";
export const captured: Capture = {
  message: "Still working on it.",
  senderTitle: "#execution-steward",
  destinationTitle: "#outcome-owner",
  sender: {
    events: [
      { id: "e1", text: "Send a completed result or blocker.", sequence: 1 },
    ],
    coverage: "complete",
    through: 1,
  },
  destination: {
    events: [
      { id: "e2", text: "Waiting for a decision-ready report.", sequence: 2 },
    ],
    coverage: "complete",
    through: 2,
  },
  provenance: { senderId: "sender", destinationId: "destination" },
};
export const count = (s: string) => new TextEncoder().encode(s).byteLength; // Injected fixture token oracle only; never claimed JEV tokenizer.
export function jevRule(id = "avoid-status-pings"): Rule {
  return {
    ...newRule(id),
    title: "Avoid status pings",
    check: "jev",
    enabled: true,
    advice: "Send a blocker, a decision request, or a completed result.",
    criteria: [
      {
        id: "progress",
        type: "choice",
        instructions: "Is this only a progress update?",
        criteria: { yes: "Only a progress update", no: "Actionable result" },
        rejectChoices: ["yes"],
        context: {
          message: true,
          senderHistory: 0,
          destinationHistory: 0,
          requireComplete: true,
        },
      },
    ],
  };
}
export const answer = (wire: Wire, choice = "yes") => ({
  model: wire.model,
  answers: Object.fromEntries(
    Object.entries(wire.questions)
      .reverse()
      .map(([key, q]) => [
        key,
        q.type === "choice"
          ? {
              type: "choice",
              choice,
              confidence: 0.6,
              probabilities: Object.fromEntries(
                Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
              ),
            }
          : {
              type: "score",
              score: 1,
              confidence: 0.6,
              legend: Object.fromEntries(
                (q.criteria as string[]).map((v, i) => [i, v]),
              ),
              probabilities: Object.fromEntries(
                (q.criteria as string[]).map((_, i) => [i, i === 1 ? 1 : 0]),
              ),
            },
      ]),
  ),
});
export const mockTransport: Transport = async (wire) => answer(wire);
export const testGroup = {
  ...newGroup("legacy-unscoped"),
  title: "Proof group",
  enabled: true,
  match: {
    kind: "condition" as const,
    field: "project_id" as const,
    operator: "equals" as const,
    value: "project",
    insensitive: false,
  },
};
export function setup() {
  const db = new Database(":memory:"),
    store = createStore(db);
  store.configure("project", null, {
    hostId: "host-proof",
    root: "/tests",
    connection: defaultConnection,
  });
  store.saveGroup("project", store.get("project")!.revision, testGroup);
  return { db, store };
}
export function memoryFiles(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let writes = 0;
  const port: FilePort = {
    async list() {
      return {
        files: [...values.keys()].map((name) => ({
          name,
          path: "/tests/" + name,
        })),
        truncated: false,
      };
    },
    async read(a) {
      const name = a.path.split("/").at(-1)!,
        content = values.get(name);
      if (content === undefined) throw Error("Missing " + name);
      return {
        path: a.path,
        content,
        contentEncoding: "utf8",
        sha256: sha256(content),
        sizeBytes: Buffer.byteLength(content),
      };
    },
    async write(a) {
      const name = a.path.split("/").at(-1)!,
        old = values.get(name);
      if (
        (a.expectedSha256 === null && old !== undefined) ||
        (typeof a.expectedSha256 === "string" &&
          (old === undefined || sha256(old) !== a.expectedSha256))
      )
        throw Error("Hash conflict");
      values.set(name, a.content);
      writes++;
      return {
        outcome: "written",
        sha256: sha256(a.content),
        sizeBytes: Buffer.byteLength(a.content),
      };
    },
    async mkdir(a) {
      return { ok: true };
    },
  };
  return { port, values, writes: () => writes };
}
export const source = (id = "progress-only-update", expect = "reject") =>
  fixtureTemplate(id)
    .replace("expect: allow", "expect: " + expect)
    .replace("expected_rules: []", "expected_rules: [avoid-status-pings]")
    .replace("Write the message to check.", "Still working on it.");
export const waitUntil = async (fn: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Timed out waiting for actual service completion.");
};
