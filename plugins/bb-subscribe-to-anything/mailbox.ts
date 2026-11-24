export const mailboxDeadlines = { pollMs:35000, requestMs:15000, stopMs:10000 } as const;
// Pure existing-CLI wire protocol; the worker factory below owns eligibility,
// connection selection, total deadline and cancellation. No alternate route.
export async function requestMailbox(endpoint: string, body: unknown, signal: AbortSignal) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(endpoint, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify(body),
    });
    if (!response.body) throw Object.assign(new Error(`Collector mailbox HTTP ${response.status}`),{httpStatus:response.status,collectorRefused:response.status===401||response.status===403});
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      // One JSON envelope, optionally preceded by newline keepalives. JSON
      // escaping can expand the CLI's 1 MiB decoded output up to sixfold.
      if (!response.ok && bytes>65536) { chunks.push(next.value.subarray(0,Math.max(0,65536-(bytes-next.value.byteLength))));break; }
      if (bytes > 7 * 1024 * 1024) throw Object.assign(new Error("Collector mailbox framing limit"),{receivedBytes:bytes,limitBytes:7*1024*1024});
      chunks.push(next.value);
    }
    const text=Buffer.concat(chunks).toString("utf8");
    if(!response.ok)throw Object.assign(new Error(`Collector mailbox HTTP ${response.status}`),{httpStatus:response.status,statusText:response.statusText,body:text,bodyTruncated:bytes>65536,receivedBytes:bytes,collectorRefused:response.status===401||response.status===403});
    const envelope = JSON.parse(text);
    if (!Number.isInteger(envelope.exitCode) || typeof (envelope.stdout ?? "") !== "string" ||
        typeof (envelope.stderr ?? "") !== "string") throw new Error("Invalid collector mailbox envelope");
    if (Buffer.byteLength(envelope.stdout ?? "") > 1024 * 1024 || Buffer.byteLength(envelope.stderr ?? "") > 1024 * 1024)
      throw new Error("Collector mailbox output limit");
    if (envelope.exitCode !== 0) {
      let refusal=false;try{refusal=JSON.parse(envelope.stdout||"{}").collectorFailure?.refused===true;}catch{}
      throw Object.assign(new Error(`Collector mailbox unavailable: ${envelope.stderr ?? ""}`),{exitCode:envelope.exitCode,stdout:envelope.stdout??"",stderr:envelope.stderr??"",collectorRefused:refusal});
    }
    return JSON.parse(envelope.stdout || "");
  } finally { await reader?.cancel().catch(() => {}); }
}

// Serialized into the provider worker. This is a wire client, never an executor.
// Native admission is deliberately narrower than CLI compatibility. The digest
// identifies the reviewed stock 0.6.49 CLI entry + all its JS chunks, not a path
// name or a claimed version. New/unknown builds safely retain CLI execution.
export async function createMailbox(id: string, token: string, worker: string, env = process.env, request = requestMailbox, deadlines: {pollMs:number;requestMs:number;stopMs:number} = mailboxDeadlines) {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs/promises");
  const { createReadStream } = await import("node:fs");
  const path = await import("node:path");
  let endpoint: string | undefined;
  const threadId = env.BB_THREAD_ID?.trim(), projectId = env.BB_PROJECT_ID?.trim();
  const controllers = new Set<AbortController>();
  const children = new Set<ReturnType<typeof spawn>>();
  let closed = false;
  const helpers = {
    async executable(name: string) {
      if (path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
        const candidate = path.resolve(name);
        await fs.access(candidate, 1); return await fs.realpath(candidate);
      }
      if (!env.PATH) throw new Error("Unknown executable search path");
      // Match execvp PATH lookup; do not replace custom wrappers with another bb.
      for (const dir of env.PATH.split(path.delimiter)) {
        const candidate = path.resolve(dir || ".", name);
        try { await fs.access(candidate, 1); return await fs.realpath(candidate); } catch {}
      }
      throw new Error("CLI executable unavailable");
    },
    async stockCli() {
      // Stock bb resolves BB_CLI again relative to cwd for its own re-exec.
      // A bare/relative override can therefore differ from spawn's PATH target.
      if (env.BB_CLI && !path.isAbsolute(env.BB_CLI)) return false;
      const entry = await helpers.executable(env.BB_CLI || "bb");
      // The reviewed entry uses /usr/bin/env node. Preserve a custom interpreter.
      if (await helpers.executable("node") !== await fs.realpath(process.execPath)) return false;
      const root = path.dirname(entry), chunks = await fs.readdir(path.join(root, "bb-chunks"));
      const files = [path.basename(entry), ...chunks.filter(n => n.endsWith(".js")).sort().map(n => `bb-chunks/${n}`)];
      const digest = createHash("sha256");
      for (const file of files) {
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(path.join(root, file))) hash.update(bytes);
        digest.update(`${file}\0${hash.digest("hex")}\n`);
      }
      return digest.digest("hex") === "59146c74a9a4658ae39d8467c846edf6b7b1c58ef3a45183377a992d44e18c73";
    },
    async native(argv: string[], ms: number) {
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        return await request(endpoint!, { argv, cwd: process.cwd(), ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}) }, controller.signal);
      } finally {
        controller.abort();
        clearTimeout(timer); controllers.delete(controller);
      }
    },
    cli(argv: string[], ms: number) { return new Promise<any>((resolve, reject) => {
      const child = spawn(env.BB_CLI || "bb", ["subscribe", ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
      children.add(child);
      const started=Date.now(),chunks: Buffer[] = []; let stderrChunks:Buffer[]=[],stderrCaptured=0,size = 0, stderrBytes=0, problem: Error | undefined;
      const timer = setTimeout(() => { problem = new Error("Collector mailbox deadline"); child.kill("SIGKILL"); }, ms);
      child.stdout!.on("data", (data: Buffer) => {
        size += data.length;
        if (size > 1024 * 1024) { problem = new Error("Collector mailbox output limit"); child.kill("SIGKILL"); }
        else chunks.push(data);
      });
      child.stderr!.on("data", (data: Buffer) => { stderrBytes+=data.length;const part=data.subarray(0,Math.max(0,65536-stderrCaptured));if(part.length){stderrChunks.push(part);stderrCaptured+=part.length;} });
      child.once("error", error => { clearTimeout(timer); children.delete(child); reject(Object.assign(error,{operation:argv[0],cli:env.BB_CLI||"bb",collectorRefused:["EACCES","EPERM"].includes((error as NodeJS.ErrnoException).code??"")})); });
      child.once("close", code => {
        clearTimeout(timer); children.delete(child);
        const stdout=Buffer.concat(chunks).toString("utf8"),stderr=Buffer.concat(stderrChunks).toString("utf8");let refused=false;
        try{refused=JSON.parse(stdout||"{}").collectorFailure?.refused===true;}catch{}
        const details={operation:argv[0],cli:env.BB_CLI||"bb",exitCode:code,signal:child.signalCode,timeoutMs:ms,durationMs:Date.now()-started,stdout,stderr,omittedStderrBytes:Math.max(0,stderrBytes-Buffer.byteLength(stderr)),collectorRefused:refused};
        if (problem || code !== 0) reject(Object.assign(problem??new Error(`Collector mailbox unavailable: ${stderr}`),details));
        else try { resolve(JSON.parse(stdout)); } catch (error) { reject(Object.assign(error as Error,details)); }
      });
    }); },
  };
  try {
    const configured = env.BB_SERVER_URL?.trim() || "", url = new URL(configured);
    const custom = Object.entries(env).some(([key, value]) => value &&
      (/proxy/i.test(key) || /^(node_options|node_extra_ca_certs|node_use_env_proxy|node_tls_reject_unauthorized|ssl_cert_file|ssl_cert_dir)$/i.test(key)));
    if (!custom && env.BB_SUBSCRIBE_TRANSPORT !== "cli" && url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/" &&
        (configured === url.origin || configured === `${url.origin}/`) &&
        !url.username && !url.password && !url.search && !url.hash &&
        threadId && /^[a-zA-Z0-9_-]+$/.test(threadId) && (!projectId || /^[a-zA-Z0-9_-]+$/.test(projectId)) &&
        await helpers.stockCli()) endpoint = `${url.origin}/api/v1/plugins/bb-subscribe-to-anything/cli`;
  } catch { /* Unknown connection/build: choose CLI before making any request. */ }
  return {
    transport: endpoint ? "native" : "cli",
    rpc(op: string, extra: string[] = []) {
      if (closed) return Promise.reject(new Error("Collector mailbox closed"));
      const argv = [op, id, token, worker, ...extra], ms = op === "collector-poll" ? deadlines.pollMs : op === "collector-stopped" ? deadlines.stopMs : deadlines.requestMs;
      // Never change transport after a request could have taken effect.
      return endpoint ? helpers.native(argv, ms) : helpers.cli(argv, ms);
    },
    abort() {
      for (const controller of controllers) controller.abort();
      for (const child of children) child.kill("SIGKILL");
    },
    close() { closed = true; this.abort(); },
  };
}
