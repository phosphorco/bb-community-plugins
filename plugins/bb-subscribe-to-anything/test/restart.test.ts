import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Sqlite from "better-sqlite3";
import { Store } from "../store.ts";
import type { Database } from "../store.ts";
import { Engine } from "../engine.ts";

test("separate-process restart retains obligation and freezes ambiguous effects", () => {
  const root = mkdtempSync(join(tmpdir(), "subscribe-restart-")),
    path = join(root, "state.db");
  try {
    const worker = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        new URL("./restart-worker.ts", import.meta.url).pathname,
        path,
      ],
      { encoding: "utf8" },
    );
    assert.equal(worker.status, 73, worker.stderr);
    const db = new Sqlite(path),
      store = new Store(db as unknown as Database);
    const engine = new Engine(store, {
      now: () => 100,
      owner: async () => "available",
      launch: async () => {
        throw Error("must not relaunch");
      },
      wake: async () => {},
      stop: async () => {},
      send: async () => {
        throw Error("must not resend");
      },
      run: async () => {
        throw Error("must not run");
      },
      classify: async () => {
        throw Error("must not classify");
      },
    });
    engine.recover();
    const r = store.owned("owner")[0]!;
    assert.equal(r.state, "uncertain");
    assert.equal(
      store.findings(r.id).find((f) => f.id === "finding")!.delivery,
      "uncertain",
    );
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
