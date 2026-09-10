import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  canonicalizeResource,
  projectionPayloadDigest,
  type Resource,
} from "../canonical.ts";
import { rpcContract } from "../rpc-contract.ts";
import crossReferencesPlugin from "../server.ts";

const source: Resource = {
  provider: "test",
  keys: { source: "server" },
  presentation: { label: "Server source", url: "/plugins/test" },
};
const target: Resource = {
  provider: "bb",
  keys: { project: "proj_server01", thread: "thr_server01" },
  presentation: { label: "Server target" },
};

const input = {
  protocolVersion: 1 as const,
  producerPluginId: "machine-monitor",
  mutationId: "00000000-0000-4000-8000-000000000011",
  source,
  revision: 1,
  expectedRevision: 0,
  tombstone: false,
  targets: [target],
  payloadDigest: projectionPayloadDigest(
    "machine-monitor",
    canonicalizeResource(source),
    false,
    [canonicalizeResource(target)],
  ),
};

test("registers the typed RPCs, verifies FK-backed storage, and publishes committed invalidation", async (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const signals: Array<{ channel: string; payload: unknown }> = [];
  let handlers: Record<string, (input: any) => unknown> | null = null;
  const bb = {
    storage: {
      database: () => db,
      migrate: (_database: Database.Database, migrations: string[]) => migrations.forEach((migration) => db.exec(migration)),
    },
    rpc: {
      register: (_contract: unknown, registeredHandlers: Record<string, (input: any) => unknown>) => { handlers = registeredHandlers; },
    },
    realtime: {
      publish: (channel: string, payload: unknown) => signals.push({ channel, payload }),
    },
  } as any;
  crossReferencesPlugin(bb);

  const parsed = await rpcContract.applyProjection.input["~standard"].validate(input);
  assert.equal("issues" in parsed, false);

  assert.deepEqual(Object.keys(handlers ?? {}), ["applyProjection", "getProjection", "listBacklinks"]);
  assert.equal((await handlers!.applyProjection(input) as { outcome: string }).outcome, "applied");
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.channel, "cross-references-changed");
  const signal = signals[0]?.payload as { affectedIdentityDigests: string[]; revision: number };
  assert.equal(signal.revision, 1);
  assert.equal(signal.affectedIdentityDigests.length, 2);

  const projection = await handlers!.getProjection({
    producerPluginId: "machine-monitor",
    source: { provider: source.provider, keys: source.keys },
  }) as { projection: { targets: Resource[] } | null };
  assert.equal(projection.projection?.targets[0]?.presentation.label, "Server target");
  const backlinks = await handlers!.listBacklinks({ target: { provider: target.provider, keys: target.keys }, pageSize: 1 }) as { rows: unknown[]; nextCursor: string | null };
  assert.equal(backlinks.rows.length, 1);
  assert.equal(backlinks.nextCursor, null);

  assert.throws(
    () => handlers!.applyProjection({ ...input, targets: Array.from({ length: 257 }, () => target) }),
    /targets/i,
  );
});
