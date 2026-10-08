import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ConnectionStatus, JsonObject, McpPeer, MirrorConfig, MirrorManager, MirrorOptions } from "../contract.ts";
import { openStdioPeer } from "./stdio.ts";

type WriteTicket = { files: string[]; unknown: boolean; target?: string };
type State = { version: 1; files: Record<string, string | null>; dirty: Record<string, string | null>; unknownDirty: boolean; active: Record<string, WriteTicket> };
const blank = (): State => ({ version: 1, files: {}, dirty: {}, unknownDirty: false, active: {} });
const has = (object: object, key: string) => Object.hasOwn(object, key);
const MAX_FILES = 512;
const MAX_QUEUE = 32;

function fileKey(ref: string): string {
  let key = ref;
  if (ref.includes("://")) {
    let url: URL;
    try { url = new URL(ref); } catch { throw new Error("Invalid Figma file reference."); }
    if (url.hostname !== "figma.com" && !url.hostname.endsWith(".figma.com")) throw new Error("Invalid Figma file URL.");
    const match = /^\/(?:file|design|proto|board)\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
    if (!match) throw new Error("Invalid Figma file URL.");
    key = match[1]!;
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("Invalid Figma file key.");
  return key;
}

function jsonText(result: JsonObject): unknown {
  if (result.isError === true) throw new Error("Figmog could not read or synchronize this file.");
  const content = result.content;
  if (!Array.isArray(content) || !content[0] || content[0].type !== "text" || typeof content[0].text !== "string") throw new Error("Figmog returned an invalid mirror result.");
  try { return JSON.parse(content[0].text); } catch { throw new Error("Figmog returned invalid mirror JSON."); }
}

/** One connection-owned process. Local metadata is the durable freshness owner. */
export function createMirrorManager(options: MirrorOptions): MirrorManager {
  const directory = resolve(options.directory);
  let config = { ...options.config };
  let desiredConfig = { ...config };
  const configuredStatus = (): Pick<ConnectionStatus, "phase" | "detail"> => {
    if (!config.binaryPath || !config.token) return { phase: "unconfigured", detail: "Enter an absolute path to an installed figmog executable and a Figma read token." };
    if (!isAbsolute(config.binaryPath)) return { phase: "error", detail: "Figmog requires an absolute executable path. Install it separately and enter its full path." };
    return { phase: "disconnected", detail: null };
  };
  const timeoutMs = Math.max(10, Math.min(options.requestTimeoutMs ?? 60_000, 300_000));
  let currentStatus: ConnectionStatus = { ...configuredStatus(), connectedAt: null, serverVersion: null };
  let raw: McpPeer | undefined;
  let facade: McpPeer | undefined;
  let startup: AbortController | undefined;
  let retiring: Promise<void> | undefined;
  let generationDir: string | undefined;
  let state: State = blank();
  let loaded = false;
  let epoch = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let queued = 0;
  let tail: Promise<void> = Promise.resolve();

  const notify = () => { try { options.onChange?.(); } catch { /* Observer cannot corrupt runtime. */ } };
  const setStatus = (phase: ConnectionStatus["phase"], detail: string | null = null) => {
    currentStatus = { phase, detail, connectedAt: phase === "connected" ? Date.now() : null, serverVersion: phase === "connected" ? raw?.info().serverInfo?.version ?? null : null };
    notify();
  };
  const enqueue = <T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, fence = epoch): Promise<T> => {
    if (queued >= MAX_QUEUE) return Promise.reject(new Error("Figmog request queue is full."));
    if (disposed) return Promise.reject(new Error("Figmog manager is disposed."));
    queued++;
    const deadline = new AbortController();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let rejectAbort: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error(signal?.aborted ? "Figmog request cancelled." : "Figmog request timed out."));
    combined.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    if (combined.aborted) onAbort();
    const result = tail.then(async () => {
      if (combined.aborted) throw new Error("Figmog request cancelled or timed out.");
      if (disposed || fence !== epoch) throw new Error("Figmog configuration changed; retry the request.");
      const value = await action(combined);
      if (combined.aborted || fence !== epoch) throw new Error("Figmog request interrupted.");
      return value;
    });
    tail = result.then(() => undefined, () => undefined);
    // Waiting callers have the same deadline; aborted queued work never starts.
    return Promise.race([result, aborted]).finally(() => {
      clearTimeout(timer); combined.removeEventListener("abort", onAbort);
    }).finally(() => { void result.finally(() => { queued--; }).catch(() => undefined); });
  };
  // Local intent/receipt bookkeeping must always run after bounded data work.
  // A timeout after persistence could lose a ticket the caller must finish.
  const bookkeeping = <T>(action: () => Promise<T>, beginning = false): Promise<T> => {
    if (beginning && disposed) return Promise.reject(new Error("Figmog manager is disposed."));
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const save = async () => {
    if (!generationDir) throw new Error("Figmog cache is unavailable.");
    const path = join(generationDir, "mirror-state.json");
    const temporary = join(generationDir, `.state-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      const parent = await open(generationDir, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } catch { throw new Error("Could not persist Figmog freshness state."); }
    finally { await unlink(temporary).catch(() => undefined); }
  };
  const load = async () => {
    if (loaded) return;
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    const digest = createHash("sha256").update("bb-figma-mirror-token\0").update(config.token).digest("hex");
    generationDir = join(directory, `generation-${digest}`);
    await mkdir(generationDir, { recursive: true, mode: 0o700 }); await chmod(generationDir, 0o700);
    state = blank();
    try {
      const saved = await readFile(join(generationDir, "mirror-state.json"), "utf8");
      if (Buffer.byteLength(saved) > 256 * 1024) throw new Error();
      const value = JSON.parse(saved) as State;
      if (value.version !== 1 || typeof value.unknownDirty !== "boolean") throw new Error();
      for (const map of [value.files, value.dirty]) {
        if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length > MAX_FILES) throw new Error();
        for (const [key, version] of Object.entries(map)) if (fileKey(key) !== key || (version !== null && typeof version !== "string")) throw new Error();
      }
      value.active ??= {}; // Migration from the pre-ticket metadata format.
      if (!value.active || typeof value.active !== "object" || Array.isArray(value.active) || Object.keys(value.active).length > MAX_QUEUE) throw new Error();
      for (const [id, ticket] of Object.entries(value.active)) {
        if (!/^[a-f0-9-]{36}$/.test(id) || !ticket || typeof ticket.unknown !== "boolean" || !Array.isArray(ticket.files) || ticket.files.length > MAX_FILES) throw new Error();
        for (const key of ticket.files) if (fileKey(key) !== key) throw new Error();
        if (ticket.target !== undefined && fileKey(ticket.target) !== ticket.target) throw new Error();
      }
      state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Figmog freshness state is invalid; cached reads are blocked.");
    }
    loaded = true;
    // A fresh manager cannot know whether a dispatched official request finished.
    // Recover durable active intent as uncertainty, never replay the write.
    if (Object.keys(state.active).length) {
      for (const ticket of Object.values(state.active)) {
        for (const key of ticket.files) state.dirty[key] = null;
        if (ticket.unknown) {
          state.unknownDirty = true;
          for (const key of Object.keys(state.files)) state.dirty[key] = null;
        }
      }
      state.active = {}; await save();
    }
  };
  const ensure = async (signal?: AbortSignal): Promise<McpPeer> => {
    await retiring; retiring = undefined;
    if (raw) return raw;
    if (!config.binaryPath || !config.token) throw new Error("Configure a Figmog binary and read token first.");
    if (!isAbsolute(config.binaryPath)) throw new Error("Figmog binary path must be absolute.");
    await access(config.binaryPath, constants.X_OK).catch(() => { throw new Error("Figmog executable is missing or is not executable."); });
    const binaryStat = await stat(config.binaryPath);
    if (!binaryStat.isFile()) throw new Error("Figmog binary path must name an executable file.");
    await load();
    setStatus("connecting");
    const interval = Math.max(1, Math.min(Math.floor(config.intervalSeconds ?? 10), 86_400));
    let failed = false;
    const openingEpoch = epoch;
    const controller = new AbortController(); startup = controller;
    try {
      const opened = await openStdioPeer({ binaryPath: config.binaryPath, cwd: generationDir!, token: config.token, intervalSeconds: Number.isFinite(interval) ? interval : 10, timeoutMs, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        onFailure: () => { failed = true; const old = raw; raw = undefined; retiring = old?.close(); setStatus("error", "Figmog process stopped; reconnect to continue."); },
      });
      if (failed || openingEpoch !== epoch || signal?.aborted) { await opened.close(); throw new Error("Figmog process could not start."); }
      raw = opened; facade = makeFacade(opened);
      // File sessions reopen lazily. One inaccessible old file cannot prevent
      // discovery or reads of other independently cached files.
      setStatus("connected", "Local figmog process connected. Use Test read with an authorized file to verify token access."); return opened;
    } catch {
      const failedPeer = raw; raw = undefined; await failedPeer?.close();
      setStatus("error", "Figmog could not connect. Check the executable and cache ownership.");
      throw new Error("Figmog could not connect. Check the executable and cache ownership.");
    } finally { if (startup === controller) startup = undefined; }
  };
  const stop = async () => {
    startup?.abort();
    const old = raw; raw = undefined;
    await old?.close(); await retiring; retiring = undefined;
    const configured = configuredStatus(); setStatus(configured.phase, configured.detail);
  };
  const upstreamStatus = async (key: string, signal?: AbortSignal): Promise<string> => {
    const peer = await ensure(signal);
    const value = jsonText(await peer.request("tools/call", { name: "figmog_status", arguments: { file: key } }, signal));
    if (!value || typeof value !== "object" || typeof (value as JsonObject).version !== "string") throw new Error("Figmog returned no file version.");
    const version = (value as JsonObject).version as string;
    if (!has(state.files, key) && Object.keys(state.files).length >= MAX_FILES) throw new Error("Figmog mirror inventory is full.");
    state.files[key] = version;
    await save();
    return version;
  };
  const discoverFiles = async (signal?: AbortSignal) => {
    const peer = await ensure(signal);
    const files = jsonText(await peer.request("tools/call", { name: "figmog_files", arguments: {} }, signal));
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error("Figmog returned an invalid file inventory.");
    for (const file of files) {
      if (typeof file?.key !== "string" || typeof file?.version !== "string") throw new Error("Figmog returned an invalid file inventory.");
      const key = fileKey(file.key);
      if (!has(state.files, key) && Object.keys(state.files).length >= MAX_FILES) throw new Error("Figmog mirror inventory is full.");
      if (!has(state.files, key) && state.unknownDirty) state.dirty[key] = null;
      state.files[key] = file.version;
    }
    await save();
  };
  const registerTarget = async (key: string) => {
    if (has(state.files, key)) return;
    if (Object.keys(state.files).length >= MAX_FILES) throw new Error("Figmog mirror inventory is full.");
    state.files[key] = null;
    // Persist target intent even if the next call fails or the host exits.
    if (state.unknownDirty) state.dirty[key] = null;
    await save();
  };
  const assertNoActiveWrite = () => {
    if (Object.keys(state.active).length) throw new Error("Figmog refresh-pending: an official write is in flight. Wait for its completion before reading or synchronizing mirrors.");
  };
  const syncOne = async (key: string, signal?: AbortSignal, allowRebaseline = false): Promise<JsonObject> => {
    assertNoActiveWrite();
    await registerTarget(key);
    const baseline = has(state.dirty, key) ? state.dirty[key] : undefined;
    const peer = await ensure(signal);
    const result = await peer.request("tools/call", { name: "figmog_sync", arguments: { file: key } }, signal);
    if (result.isError === true) throw new Error(`Figmog refresh-pending for ${key}: synchronization failed.`);
    const version = await upstreamStatus(key, signal);
    if (baseline !== undefined) {
      if (baseline === null && !allowRebaseline) throw new Error(`Figmog refresh-pending for ${key}: pre-write version is unavailable. Inspect the canvas, then use figma_sync with acceptUnverified:true to explicitly establish a new baseline; mutation visibility will remain unverified.`);
      if (baseline === version && !allowRebaseline) throw new Error(`Figmog refresh-pending for ${key}: a changed version has not been observed. Inspect the canvas, then use figma_sync with acceptUnverified:true to explicitly accept unverified recovery.`);
      delete state.dirty[key];
      await save(); notify();
      if (allowRebaseline) return { ...result, _meta: {
        ...(result._meta && typeof result._meta === "object" && !Array.isArray(result._meta) ? result._meta : {}),
        bbFigmaFreshness: { state: "rebaselined", file: key, previousBaseline: baseline, acceptedVersion: version, acceptedAt: Date.now(), version, mutationVisibilityVerified: false,
          detail: "Explicitly accepted full synchronization established a new baseline. The earlier mutation's visibility remains unverified." },
      } };

    }
    return result;
  };
  const refresh = async (file?: string, signal?: AbortSignal, allowRebaseline = false): Promise<JsonObject> => {
    await load(); assertNoActiveWrite();
    await ensure(signal);
    const targets = file === undefined ? Object.keys(state.files) : [fileKey(file)];
    if (!targets.length && state.unknownDirty && !allowRebaseline) throw new Error("Figmog refresh-pending: unknown write target has no baseline version. Inspect the canvas and use figma_sync with acceptUnverified:true without file for all-known-file recovery.");
    if (file !== undefined) return syncOne(targets[0]!, signal, allowRebaseline);
    const results: JsonObject[] = [];
    let failures = 0;
    for (const key of targets) {
      try { results.push({ file: key, state: "synced", result: await syncOne(key, signal, allowRebaseline) }); }
      catch {
        failures++;
        results.push({ file: key, state: "refresh-pending", error: "Synchronization or write visibility verification failed; this file remains pending." });
      }
    }
    // Only explicit bulk acceptance can release an unknown-target fence.
    // Each file's successful full sync commits independently; failures stay dirty.
    if (allowRebaseline && !failures) { state.unknownDirty = false; await save(); notify(); }
    const pendingUnknown = state.unknownDirty;
    const meta: JsonObject = { state: failures ? "partial" : pendingUnknown ? "refresh-pending" : allowRebaseline ? "rebaselined" : "synced",
      mutationVisibilityVerified: false,
      acceptedAt: Date.now(), unknownTargetFence: pendingUnknown,
      detail: allowRebaseline ? "Explicit full synchronization accepted a fresh baseline; earlier mutation visibility remains unverified. Later files use ordinary REST mirror freshness, without write-specific proof." : "Tracked files were synchronized; pending files and unknown targets still require recovery." };
    return { files: results, content: [{ type: "text", text: JSON.stringify({ files: results, freshness: meta }) }], isError: !!failures || pendingUnknown, _meta: { bbFigmaFreshness: meta } };
  };

  const targetFor = (args: JsonObject): string | undefined => {
    if (typeof args.file === "string") return fileKey(args.file);
    for (const name of ["id", "under", "target"]) if (typeof args[name] === "string" && args[name].includes("://")) return fileKey(args[name]);
    const keys = Object.keys(state.files);
    return keys.length === 1 ? keys[0] : undefined;
  };
  const guardedRequest = async (method: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonObject> => {
    const peer = await ensure(signal);
    if (method !== "tools/call") return peer.request(method, params, signal);
    assertNoActiveWrite();
    const name = params?.name;
    if (typeof name !== "string" || !name.startsWith("figmog_")) return peer.request(method, params, signal);
    const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as JsonObject : {};
    if (name === "figmog_files") {
      if (Object.keys(state.dirty).length) await refresh(undefined, signal);
      if (state.unknownDirty && !Object.keys(state.files).length) throw new Error("Figmog refresh-pending: unknown write target has no baseline version.");
      const result = await peer.request(method, params, signal); await discoverFiles(signal); return result;
    }
    const key = targetFor(args);
    if (!key) {
      if (Object.keys(state.dirty).length || state.unknownDirty) throw new Error("Figmog refresh-pending: pass an explicit file to resolve the write target.");
      return peer.request(method, params, signal);
    }
    await registerTarget(key);
    if (name === "figmog_sync") return syncOne(key, signal);
    if (has(state.dirty, key)) await syncOne(key, signal);
    // Explicit targeting keeps reopened sessions independent of process-local defaults.
    const result = await peer.request(method, { ...params, arguments: { ...args, file: key } }, signal);
    if (result.isError !== true) await upstreamStatus(key, signal);
    return result;
  };
  // Peer identity changes with the process so bridge catalogs cannot survive
  // reconnects, binary replacements, or a restarted server with different tools.
  const makeFacade = (underlying: McpPeer): McpPeer => ({
    request: (method, params, signal) => {
      const captured = params === undefined ? undefined : structuredClone(params);
      return enqueue((bounded) => {
        if (raw !== underlying) throw new Error("Figmog connection changed. Rediscover tools before calling this peer.");
        return guardedRequest(method, captured, bounded);
      }, signal);
    },
    info: () => underlying.info(),
    close: async () => { await manager.close(); },
  });
  const transition = (action: () => Promise<void>, dispose = false): Promise<void> => {
    if (disposed) return dispose ? disposal ?? Promise.resolve() : Promise.reject(new Error("Figmog manager is disposed."));
    ++epoch;
    if (dispose) disposed = true;
    // Closing the raw peer interrupts active I/O instead of waiting for its timeout.
    const stopping = stop();
    const result = tail.then(async () => { await stopping; await action(); if (dispose) disposed = true; });
    tail = result.then(() => undefined, () => undefined);
    // Later transitions run in order; the epoch invalidates queued calls.
    if (dispose) disposal = result;
    return result;
  };
  const manager: MirrorManager = {
    peer: (signal) => enqueue(async (bounded) => {
      try { await ensure(bounded); return facade!; }
      catch (error) {
        if (!bounded.aborted && currentStatus.phase !== "error") setStatus("error", "Figmog could not connect. Check the absolute executable path, read token, and private cache ownership.");
        throw error;
      }
    }, signal),
    status: () => ({ ...currentStatus }),
    configure: (next) => {
      if (disposed) return Promise.reject(new Error("Figmog manager is disposed."));
      const captured = { ...next };
      if (captured.binaryPath === desiredConfig.binaryPath && captured.token === desiredConfig.token && (captured.intervalSeconds ?? 10) === (desiredConfig.intervalSeconds ?? 10)) return Promise.resolve();
      desiredConfig = captured;
      return transition(async () => {
        if (captured.token === config.token) {
          // Replacing a binary cannot release writes still running upstream.
          config = captured;
        } else {
          const inFlight = loaded ? Object.keys(state.active) : [];
          if (inFlight.length) {
            for (const ticket of Object.values(state.active)) for (const key of ticket.files) state.dirty[key] = null;
            state.active = {}; await save(); // Old generation retains uncertainty.
          }
          config = captured; loaded = false; state = blank(); generationDir = undefined;
          if (inFlight.length) {
            await load();
            // Carry the active fence, never old principal's file metadata.
            for (const id of inFlight) state.active[id] = { files: [], unknown: true };
            state.unknownDirty = true;
            for (const key of Object.keys(state.files)) state.dirty[key] = null;
            await save();
          }
        }
        const configured = configuredStatus(); setStatus(configured.phase, configured.detail);
      });
    },
    markDirty: (file) => enqueue(async (signal) => {
      await load(); assertNoActiveWrite();
      await ensure(signal);
      await discoverFiles(signal);
      const keys = file === undefined ? Object.keys(state.files) : [fileKey(file)];
      // Resolve an earlier possible write before dispatching another. Otherwise
      // the first write's eventual version could falsely certify the second.
      for (const key of keys) {
        await registerTarget(key);
        await syncOne(key, signal); // Strict: unchanged prior baselines remain pending.
        state.dirty[key] = await upstreamStatus(key, signal);
      }
      if (file === undefined) state.unknownDirty = true;
      await save(); notify();
    }),
    beginWrite: (file) => bookkeeping(async () => {
      // Official edits must not depend on the binary, cached-file availability,
      // a REST budget or the validity of the optional read connection.
      await load();
      const target = file === undefined ? undefined : fileKey(file);
      // An unseen target has no cached bytes to invalidate. Retain only ticket
      // intent; never grow mirror inventory or perform REST for an official edit.
      const keys = target === undefined ? Object.keys(state.files) : has(state.files, target) ? [target] : [];
      if (Object.keys(state.active).length >= MAX_QUEUE) throw new Error("Too many official writes are in flight.");
      const overlapping = Object.keys(state.active).length > 0;
      if (overlapping) {
        for (const ticket of Object.values(state.active)) {
          for (const key of ticket.files) state.dirty[key] = null;
          if (ticket.unknown) for (const key of Object.keys(state.files)) state.dirty[key] = null;
        }
      }
      for (const key of keys) {
        await registerTarget(key);
        // Last-observed versions are only a heuristic. Prior uncertainty or
        // concurrent writes cannot be certified by another version change.
        state.dirty[key] = overlapping || has(state.dirty, key) ? null : state.files[key] ?? null;
      }
      if (file === undefined) state.unknownDirty = true;
      const ticket = randomUUID(); state.active[ticket] = { files: keys, unknown: file === undefined, ...(target ? { target } : {}) };
      try { await save(); }
      catch {
        // No official dispatch occurred. Retire the unreturned live ticket,
        // preserving uncertainty if persistence was partially successful.
        delete state.active[ticket];
        for (const key of keys) state.dirty[key] = null;
        if (file === undefined) state.unknownDirty = true;
        await save().catch(() => undefined);
        notify();
        throw new Error("Could not persist official write intent; the write was not dispatched.");
      }
      notify(); return ticket;
    }, true),
    endWrite: (ticket, outcome) => bookkeeping(async () => {
      await load();
      const active = state.active[ticket];
      if (!active) return; // Recovered tickets already became uncertain; idempotent finish.
      if (outcome === "uncertain") {
        for (const key of active.files) state.dirty[key] = null;
        if (active.unknown) {
          state.unknownDirty = true;
          for (const key of Object.keys(state.files)) state.dirty[key] = null;
        }
      }
      delete state.active[ticket]; await save(); notify();
    }),
    refresh: (file, signal, acceptUnverified = false) => enqueue((bounded) => refresh(file, bounded, acceptUnverified), signal),
    restart: () => transition(async () => { await ensure(); }),
    close: () => transition(async () => undefined, true),
  };
  return manager;
}
