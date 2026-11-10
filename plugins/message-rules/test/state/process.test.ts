import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createStore } from "../../state/store.ts";
import { createSuiteService, savedBasis } from "../../suites/runner.ts";
import { count, answer } from "../helpers.ts";
for (const global of [false, true])
  test(`${global ? "global Test all" : "legacy suite"}: real suspended old process cannot induce a replacement paid call; no transfer without quiescence`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "message-rules-owner-")),
      file = path.join(dir, "state.db");
    const child = fork(
      new URL("./worker.fixture.ts", import.meta.url),
      [file, global ? "global" : "legacy"],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const projectId = global ? "message-rules-global" : "project";
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    const messages: unknown[] = [];
    child.on("message", (m) => messages.push(m));
    const wait = (stage: string) =>
      new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("Missing " + stage + ": " + stderr)),
          5000,
        );
        const match = (m: any) => {
          if (m?.stage === stage) {
            clearTimeout(timeout);
            child.off("message", match);
            resolve(m);
          }
        };
        const existing = messages.find((m: any) => m.stage === stage);
        if (existing) {
          clearTimeout(timeout);
          resolve(existing);
        } else child.on("message", match);
      });
    let db: Database.Database | undefined;
    try {
      await wait("permit-committed-before-effect");
      db = new Database(file);
      const store = createStore(db);
      let replacements = 0;
      const replacement = createSuiteService(
        store,
        () => async (wire) => {
          replacements++;
          return answer(wire);
        },
        count,
      );
      const old = store.latest(projectId)!;
      assert.equal(old.status, "stopped-ownership-unknown");
      assert.equal(store.unresolved(projectId).length, 1);
      assert.throws(
        () =>
          replacement.start(
            projectId,
            "new",
            savedBasis(store.get(projectId)!),
            {},
          ),
        /still owns/,
      );
      assert.equal(replacements, 0);
      child.send("resume");
      assert.equal((await wait("effect")).calls, 1);
      child.send("finish");
      const done = await wait("quiesced");
      assert.equal(done.calls, 1);
      assert.equal(done.run.quiescent, true);
      assert.equal(replacements, 0);
      await replacement.dispose();
    } finally {
      child.kill("SIGKILL");
      db?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
