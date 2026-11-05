import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, mkdir, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailbox, requestMailbox } from "../mailbox.ts";

function plain(url: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, BB_SERVER_URL: url, BB_THREAD_ID: " observer ", BB_PROJECT_ID: " project " };
  for (const key of Object.keys(env)) if (/proxy/i.test(key) || /^(node_options|node_extra_ca_certs|node_use_env_proxy|node_tls_reject_unauthorized|ssl_cert_file|ssl_cert_dir)$/i.test(key)) delete env[key];
  return env;
}
test("portable CLI wire protocol preserves newline framing, bounds, HTTP failures and abort", async () => {
  let mode = "okay", requests = 0;
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    requests++;
    let body = ""; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    assert.equal(req.url, "/api/v1/plugins/bb-subscribe-to-anything/cli");
    assert.equal(req.headers["content-type"], "application/json"); assert.equal(req.headers.origin, undefined);
    if (mode === "http") { res.writeHead(403); res.end("denied"); }
    else if (mode === "lost") req.socket.destroy();
    else if (mode === "invalid") res.end("\n{bad-json");
    else if (mode === "envelope") res.end(JSON.stringify({ exitCode: "0", stdout: "{}" }));
    else if (mode === "output") res.end(JSON.stringify({ exitCode: 0, stdout: "x".repeat(1048577) }));
    else if (mode === "framing") res.end(" ".repeat(7 * 1024 * 1024 + 1));
    else if (mode === "exit") res.end(JSON.stringify({ exitCode: 2, stderr: "denied assignment" }));
    else if (mode === "pending") { res.write("\n"); }
    else { res.write("\n\n"); res.end(JSON.stringify({ exitCode: 0, stdout: '{"accepted":true}', stderr: "" })); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const env = plain(`http://127.0.0.1:${address.port}`);
  const pending = new Set<AbortController>();
  const client = {
    transport: "wire",
    rpc(op: string, extra: string[] = []) {
      const controller = new AbortController(); pending.add(controller);
      return requestMailbox(`${env.BB_SERVER_URL}/api/v1/plugins/bb-subscribe-to-anything/cli`, {
        argv: [op, "sub", "token", "worker", ...extra], cwd: process.cwd(), threadId: "observer", projectId: "project",
      }, controller.signal).finally(() => { controller.abort(); pending.delete(controller); });
    },
    abort() { for (const controller of pending) controller.abort(); },
    close() { this.abort(); },
  };
  try {
    assert.deepEqual(await client.rpc("collector-result", ["task", "sealed-payload"]), { accepted: true });
    assert.deepEqual(bodies[0], { argv: ["collector-result", "sub", "token", "worker", "task", "sealed-payload"], cwd: process.cwd(), threadId: "observer", projectId: "project" });
    for (mode of ["http", "lost", "invalid", "envelope", "output", "framing", "exit"]) {
      const before = requests;
      await assert.rejects(client.rpc("collector-result", ["task", "sealed-payload"]));
      assert.equal(requests, before + 1, "no retry or CLI fallback after ambiguous effect");
      assert.equal(client.transport, "wire");
    }
    mode = "pending";
    const waiting = client.rpc("collector-poll"); setTimeout(() => client.abort(), 25);
    await assert.rejects(waiting);
  } finally { client.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test("custom wrappers, PATH wrappers, unsupported connections and custom transport retain CLI before effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "mailbox-wrapper-"));
  try {
    const wrapper = join(root, "bb");
    await writeFile(wrapper, '#!/bin/sh\nprintf \'{"wrapper":true}\'\n', { mode: 0o700 });
    const base = plain("http://127.0.0.1:38886");
    for (const env of [ { ...base, BB_CLI: wrapper }, { ...base, BB_CLI: "", PATH: `${root}:${process.env.PATH}` } ]) {
      const client = await createMailbox("sub", "token", "worker", env);
      assert.equal(client.transport, "cli"); assert.deepEqual(await client.rpc("collector-poll"), { wrapper: true }); client.close();
    }
    for (const value of [undefined, "", "https://127.0.0.1:38886", "http://example.test", "http://127.0.0.1/path", "http://x:y@127.0.0.1", "http://127.0.0.1?", "http://127.0.0.1#", "http://127.0.0.1/?q=a"]) {
      const client = await createMailbox("sub", "token", "worker", { ...base, BB_SERVER_URL: value });
      assert.equal(client.transport, "cli", String(value)); client.close();
    }
    for (const override of [{ http_proxy: "custom" }, { no_proxy: "custom" }, { node_options: "custom" }, { ssl_cert_file: "custom" }, { BB_THREAD_ID: "bad/id" }, { BB_PROJECT_ID: "bad/id" }, { BB_SUBSCRIBE_TRANSPORT: "cli" }, { BB_CLI: "bb" }]) {
      const client = await createMailbox("sub", "token", "worker", { ...base, ...override });
      assert.equal(client.transport, "cli", JSON.stringify(override)); client.close();
    }
    const previousCwd = process.cwd();
    await mkdir(join(root, "cwd", "rel"), { recursive: true });
    await mkdir(join(root, "lookup", "rel"), { recursive: true });
    await writeFile(join(root, "cwd", "rel", "bb"), '#!/bin/sh\nprintf \'{"relativeWrapper":true}\'\n', { mode: 0o700 });
    // Stock is unnecessary for this portable shadowing fixture: any other
    // executable at the PATH-relative location must not override the cwd script.
    await symlink(process.env.BB_CLI ? await realpath(process.env.BB_CLI).catch(() => process.execPath) : process.execPath, join(root, "lookup", "rel", "bb"));
    try {
      process.chdir(join(root, "cwd"));
      const client = await createMailbox("sub", "token", "worker", { ...base, BB_CLI: "rel/bb", PATH: `${join(root, "lookup")}:${base.PATH}` });
      assert.equal(client.transport, "cli"); assert.deepEqual(await client.rpc("collector-poll"), { relativeWrapper: true }); client.close();
      for (const PATH of [undefined, ""]) {
        const refused = await createMailbox("sub", "token", "worker", { ...base, PATH });
        assert.equal(refused.transport, "cli"); refused.close();
      }
    } finally { process.chdir(previousCwd); }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("installed reviewed stock CLI selects native with exact context and no fallback after ambiguity", async t => {
  let requests = 0;
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    requests++; let text = ""; for await (const chunk of req) text += chunk;
    bodies.push(JSON.parse(text));
    if (requests === 1) res.end(JSON.stringify({ exitCode: 0, stdout: '{"accepted":true}', stderr: "" }));
    else req.socket.destroy();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = await createMailbox("sub", "token", "worker", plain(`http://127.0.0.1:${address.port}`));
  try {
    if (client.transport !== "native" && process.env.SUBSCRIPTION_REQUIRE_NATIVE !== "1") {
      t.skip("Installed CLI is outside the reviewed stock bundle/connection gate; portable wire/fallback tests still run. Set SUBSCRIPTION_REQUIRE_NATIVE=1 for mandatory host proof."); return;
    }
    assert.equal(client.transport, "native", "mandatory current-host native proof cannot pass by CLI fallback");
    assert.deepEqual(await client.rpc("collector-result", ["task", "sealed-payload"]), { accepted: true });
    assert.deepEqual(bodies[0], { argv: ["collector-result", "sub", "token", "worker", "task", "sealed-payload"], cwd: process.cwd(), threadId: "observer", projectId: "project" });
    await assert.rejects(client.rpc("collector-result", ["task", "sealed-payload"]));
    assert.equal(requests, 2, "ambiguous request must not fall back or retry automatically");
    assert.equal(client.transport, "native");
  } finally { client.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
