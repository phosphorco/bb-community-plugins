import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sha256, canonical } from "../contracts/hash.ts";
import { fileLocation, type FileLocation } from "../contracts/model.ts";
import { parseFixture } from "../contracts/fixture.ts";
import type { Occurrence, Store, SuiteConfig } from "../state/store.ts";
import { Conflict } from "../state/store.ts";
export type FilePort = Pick<
  BbPluginApi["sdk"]["files"],
  "list" | "read" | "write" | "mkdir"
>;
export function createFiles(port: FilePort, store: Store) {
  const locks = new Map<string, Promise<unknown>>();
  function location(c: SuiteConfig, name: string) {
    if (!c.hostId || !path.isAbsolute(c.root))
      throw Error(
        "Select a host and absolute test directory in JEV connection.",
      );
    if (
      name.includes("/") ||
      name.includes("\\") ||
      !name.endsWith(".md") ||
      name === ".."
    )
      throw Error("Choose a plain .md filename within the selected directory.");
    return {
      hostId: c.hostId,
      rootPath: c.root,
      path: path.join(c.root, name),
    };
  }
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(key, next);
    void next
      .finally(() => {
        if (locks.get(key) === next) locks.delete(key);
      })
      .catch(() => {});
    return next;
  };
  const discoveries = new Map<
    string,
    Promise<NonNullable<ReturnType<Store["get"]>>>
  >();
  async function doDiscover(projectId: string) {
    const p = store.get(projectId);
    if (!p) throw Error("Configure a test directory first.");
    const c = p.config;
    location(c, "check.md");
    const list = await port.list({
      hostId: c.hostId,
      path: c.root,
      limit: 1000,
      includeHidden: false,
    });
    const paths = list.files;
    if (!Array.isArray(paths) || paths.length >= 1000 || list.truncated)
      throw Error(
        "Test directory listing is incomplete. Previous tests are retained.",
      );
    const names = paths
      .filter(
        (x) =>
          path.dirname(x.path) === c.root ||
          (!path.isAbsolute(x.path) && path.dirname(x.path) === "."),
      )
      .map((x) => x.name)
      .filter((x) => x.endsWith(".md"))
      .sort();
    const readOne = async (name: string) => {
      try {
        const r = await port.read(location(c, name));
        if (r.contentEncoding !== "utf8")
          throw Error("Test must be UTF-8 text.");
        const source = r.content;
        if (typeof source !== "string")
          throw Error("Test file is not readable UTF-8 text.");
        let logicalId: string | null = null,
          error: string | null = null;
        try {
          logicalId = parseFixture(source).meta.id;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        return { path: name, source, hash: sha256(source), logicalId, error };
      } catch (e) {
        return {
          path: name,
          source: null,
          hash: null,
          logicalId: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    };
    const fresh: Awaited<ReturnType<typeof readOne>>[] = new Array(
      names.length,
    );
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, names.length) }, async () => {
        for (;;) {
          const at = index++;
          if (at >= names.length) return;
          fresh[at] = await readOne(names[at]!);
        }
      }),
    );
    // The global row also contains imported occurrences. Reconcile only the
    // scanned source; a relative filename is never a cross-source identity.
    const previous = p.occurrences.filter(
      (o) => !o.sourceProjectId || o.sourceProjectId === projectId,
    );
    const foreign = p.occurrences.filter(
      (o) => o.sourceProjectId && o.sourceProjectId !== projectId,
    );
    const used = new Set<string>();
    const occurrences: Occurrence[] = fresh.map((f) => {
      let old = previous.find((o) => o.path === f.path);
      if (!old) {
        const candidates = previous.filter(
          (o) =>
            !names.includes(o.path) &&
            !used.has(o.occurrenceId) &&
            ((f.logicalId && o.logicalId === f.logicalId) ||
              (!f.logicalId && f.hash && o.hash === f.hash)),
        );
        if (
          candidates.length === 1 &&
          fresh.filter((x) =>
            f.logicalId ? x.logicalId === f.logicalId : x.hash === f.hash,
          ).length === 1
        )
          old = candidates[0];
      }
      if (old) used.add(old.occurrenceId);
      return {
        ...old,
        ...f,
        occurrenceId: old?.occurrenceId ?? randomUUID(),
        enabled: old?.enabled ?? true,
        missing: false,
      };
    });
    for (const old of previous)
      if (
        !used.has(old.occurrenceId) &&
        !occurrences.some((x) => x.occurrenceId === old.occurrenceId)
      )
        occurrences.push({
          ...old,
          source: null,
          missing: true,
          error:
            "Previously discovered test is missing. Restore or disable it; it remains in the enabled count.",
        });
    const ids = new Map<string, Occurrence[]>();
    for (const o of occurrences)
      if (o.logicalId && !o.missing) {
        const bucket = ids.get(o.logicalId) ?? [];
        bucket.push(o);
        ids.set(o.logicalId, bucket);
      }
    for (const [id, items] of ids)
      if (items.length > 1)
        for (const o of items)
          o.error =
            "Duplicate test ID " +
            id +
            ": " +
            items.map((x) => x.path).join(", ");
    const latest = store.get(projectId)!;
    if (latest.revision !== p.revision)
      throw new Conflict(
        "Saved inputs changed during directory discovery. Refresh to retry.",
      );
    const merged = [...foreign, ...occurrences];
    if (canonical(merged) !== canonical(p.occurrences))
      return store.discover(projectId, p.revision, merged);
    return p;
  }
  const discover = (projectId: string) => {
    const pending = discoveries.get(projectId);
    if (pending) return pending;
    const read = doDiscover(projectId);
    discoveries.set(projectId, read);
    void read
      .finally(() => {
        if (discoveries.get(projectId) === read) discoveries.delete(projectId);
      })
      .catch(() => {});
    return read;
  };
  return {
    discover,
    async save(
      projectId: string,
      name: string,
      source: string,
      expectedHash: string | null,
      loadedLocation: FileLocation,
    ) {
      const p = store.get(projectId);
      if (!p) throw Error("Configure test directory first.");
      const checkLocation = () => {
        const current = store.get(projectId);
        if (
          !current ||
          canonical(fileLocation(current.config)) !== canonical(loadedLocation)
        )
          throw new Conflict(
            "Test location changed. Your draft belongs to the previous host/directory; no write was started.",
          );
      };
      checkLocation();
      const loc = location(p.config, name);
      return serial(p.config.hostId + ":" + loc.path, async () => {
        checkLocation();
        if (Buffer.byteLength(source) > 262144)
          throw Error("Test file exceeds 256 KiB.");
        try {
          const outcome = await port.write({
            ...loc,
            content: source,
            contentEncoding: "utf8",
            createParents: true,
            expectedSha256: expectedHash,
          });
          if (outcome.outcome === "conflict")
            throw new Conflict("Hash conflict; current file differs.");
        } catch (e) {
          let latest: string | null = null;
          try {
            latest = (await port.read(loc)).content;
          } catch {}
          if (latest === source)
            return { state: "confirmed" as const, hash: sha256(source) };
          throw new Conflict(
            "Save failed or has an unknown outcome. Draft retained; read current file before retrying. " +
              (e instanceof Error ? e.message : String(e)),
          );
        }
        return { state: "confirmed" as const, hash: sha256(source) };
      });
    },
  };
}
