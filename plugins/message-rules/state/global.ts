import { canonical, fingerprint } from "../contracts/hash.ts";
import { GLOBAL_CATALOG, type CatalogInfo } from "../contracts/catalog.ts";
import { fileLocation, newGroup, type Predicate } from "../contracts/model.ts";
import { parseFixture } from "../contracts/fixture.ts";
import { Conflict, type Store, type Occurrence } from "./store.ts";

// Old rows and all run/attempt rows remain intact. The migration receipt is also
// the explicit compatibility map; no lookup relies on display-name uniqueness.
export function createGlobalCatalog(store: Store) {
  const db = store.db;
  const readInfo = () => {
    const row = db
      .prepare("SELECT value FROM mr_metadata WHERE key='global-catalog-v1'")
      .get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as CatalogInfo) : null;
  };
  db.transaction(() => {
    if (readInfo()) return;
    db.exec(
      "CREATE TABLE IF NOT EXISTS mr_legacy_catalog_backup(id TEXT PRIMARY KEY,row_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mr_test_owners(source_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,group_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(source_id,occurrence_id));",
    );
    const rows = db.prepare("SELECT * FROM mr_projects ORDER BY id").all() as {
      id: string;
    }[];
    if (rows.some((r) => r.id === GLOBAL_CATALOG))
      throw Error(
        "Reserved global catalog ID already exists; migration stopped without replacing it.",
      );
    const info: CatalogInfo = {
      aliases: [],
      sources: [],
      notes: [
        "Legacy tests keep their original project context and host directory. Ownership organizes tests; every fixture evaluates the complete applicable catalog.",
        "Ownership: a unique expected-rule group, otherwise the first legacy group by order and ID. Empty legacy catalogs get a disabled Imported tests group. IDs remain unchanged unless they collide; the compatibility map records every imported ID.",
      ],
    };
    const used = {
      group: new Set<string>(),
      rule: new Set<string>(),
      test: new Set<string>(),
    };
    const allocate = (
      kind: keyof typeof used,
      projectId: string,
      oldId: string,
    ) => {
      let id = oldId;
      if (used[kind].has(id))
        id =
          oldId.slice(0, 60) +
          "-" +
          fingerprint({ kind, projectId, oldId }).slice(0, 16);
      if (used[kind].has(id))
        throw Error("Catalog ID mapping collision; migration stopped.");
      used[kind].add(id);
      info.aliases.push({ projectId, kind, oldId, id });
      return id;
    };
    let global = store.write(GLOBAL_CATALOG, null, () => {});
    for (const raw of rows) {
      db.prepare("INSERT INTO mr_legacy_catalog_backup VALUES(?,?)").run(
        raw.id,
        JSON.stringify(raw),
      );
      const p = store.get(raw.id)!;
      for (const [kind, items] of [
        ["group", p.groups],
        ["rule", p.rules],
      ] as const) {
        if (new Set(items.map((item) => item.id)).size !== items.length)
          throw Error(
            "Ambiguous duplicate " +
              kind +
              " ID inside legacy project " +
              p.id +
              ". Original rows are preserved; migration rolled back.",
          );
      }
      const groups = p.groups
        .slice()
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      if (!groups.length)
        groups.push({
          ...newGroup("imported-tests"),
          title: "Imported tests · " + p.id,
        });
      const missing = [...new Set(p.rules.map((r) => r.groupId))].filter(
        (id) => !groups.some((g) => g.id === id),
      );
      for (const id of missing)
        groups.push({
          ...newGroup(id),
          title: "Imported unassigned rules · scope required",
        });
      const groupMap = new Map<string, string>();
      const exact: Predicate = {
        kind: "condition",
        field: "project_id",
        operator: "equals",
        value: p.id,
        insensitive: false,
      };
      const hasExact = (m: Predicate): boolean =>
        canonical(m) === canonical(exact) ||
        (m.kind === "all" && m.children.some(hasExact));
      for (const g of groups) {
        const id = allocate("group", p.id, g.id);
        groupMap.set(g.id, id);
        global.groups.push({
          ...g,
          id,
          order: global.groups.length,
          match: hasExact(g.match)
            ? g.match
            : { kind: "all", children: [exact, g.match] },
          revision: g.revision + (hasExact(g.match) ? 0 : 1),
        });
      }
      for (const r of p.rules
        .slice()
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)))
        global.rules.push({
          ...r,
          id: allocate("rule", p.id, r.id),
          groupId: groupMap.get(r.groupId) ?? groupMap.get(groups[0]!.id)!,
          order: global.rules.length,
        });
      info.sources.push({
        projectId: p.id,
        defaultGroupId: groupMap.get(groups[0]!.id)!,
      });
      for (const o of p.occurrences) allocate("test", p.id, o.occurrenceId);
      if (rows.length === 1) global.config = structuredClone(p.config);
    }
    if (rows.length) {
      const connections = rows.map(
        (row) => store.get(row.id)!.config.connection,
      );
      global.config.connection = { ...connections[0]! };
      for (const key of [
        "maxWireBytes",
        "maxCalls",
        "timeoutMs",
        "maxResponseBytes",
        "perRequestTokens",
        "perQuestionTokens",
      ] as const)
        global.config.connection[key] = Math.min(
          ...connections.map((c) => c[key]),
        );
      info.notes.push(
        "One global run budget uses the minimum legacy limits. Model: " +
          global.config.connection.model +
          " (first source by ID); original source configurations remain in the backup.",
      );
    }
    store.write(GLOBAL_CATALOG, global.revision, (p) => {
      p.groups = global.groups;
      p.rules = global.rules;
      p.config = global.config;
    });
    db.prepare("INSERT INTO mr_metadata VALUES('global-catalog-v1',?)").run(
      canonical(info),
    );
    db.prepare(
      "UPDATE mr_metadata SET value='4' WHERE key='schema-version'",
    ).run();
  })();
  const info = () => readInfo()!;
  const sources = () => [
    ...info()
      .sources.map((s) => store.get(s.projectId)!)
      .filter(Boolean),
    store.get(GLOBAL_CATALOG)!,
  ];
  function owner(
    sourceId: string,
    o: Occurrence,
  ): { groupId: string; reason: string } {
    const saved = db
      .prepare(
        "SELECT group_id,reason FROM mr_test_owners WHERE source_id=? AND occurrence_id=?",
      )
      .get(sourceId, o.occurrenceId) as
      | { group_id: string; reason: string }
      | undefined;
    if (
      saved &&
      store.get(GLOBAL_CATALOG)!.groups.some((g) => g.id === saved.group_id)
    )
      return { groupId: saved.group_id, reason: saved.reason };
    const meta = info();
    const entry = meta.sources.find((s) => s.projectId === sourceId);
    let groupId = entry?.defaultGroupId;
    if (
      groupId &&
      !store.get(GLOBAL_CATALOG)!.groups.some((g) => g.id === groupId)
    )
      groupId = undefined;
    let reason = "Legacy fallback: first group by order and ID";
    try {
      const f = parseFixture(o.source ?? "");
      const expected = f.meta.expected_rules ?? [];
      const ids = expected.map(
        (id) =>
          (f.meta.rule_catalog === "global"
            ? id
            : meta.aliases.find(
                (a) =>
                  a.projectId === sourceId &&
                  a.kind === "rule" &&
                  a.oldId === id,
              )?.id) ?? id,
      );
      const groups = new Set(
        ids.map(
          (id) =>
            store.get(GLOBAL_CATALOG)!.rules.find((r) => r.id === id)?.groupId,
        ),
      );
      if (groups.size === 1 && !groups.has(undefined)) {
        groupId = [...groups][0];
        reason = "Legacy mapping: unique expected-rule group";
      }
    } catch {}
    if (!groupId) {
      const key = "import-test-group:" + sourceId;
      const record = db
        .prepare("SELECT value FROM mr_metadata WHERE key=?")
        .get(key) as { value: string } | undefined;
      groupId = record?.value;
      if (
        !groupId ||
        !store.get(GLOBAL_CATALOG)!.groups.some((g) => g.id === groupId)
      ) {
        const p = store.get(GLOBAL_CATALOG)!;
        groupId =
          sourceId === GLOBAL_CATALOG
            ? "unassigned-tests"
            : "imported-tests-" + fingerprint(sourceId).slice(0, 12);
        for (let n = 1; p.groups.some((g) => g.id === groupId); n++)
          groupId =
            "imported-tests-" + fingerprint({ sourceId, n }).slice(0, 12);
        const match: Predicate =
          sourceId === GLOBAL_CATALOG
            ? { kind: "all", children: [] }
            : {
                kind: "condition",
                field: "project_id",
                operator: "equals",
                value: sourceId,
                insensitive: false,
              };
        store.saveGroup(GLOBAL_CATALOG, p.revision, {
          ...newGroup(groupId),
          title:
            sourceId === GLOBAL_CATALOG
              ? "Imported tests · choose a group"
              : "Imported tests · " + sourceId,
          order: p.groups.length,
          match,
        });
        db.prepare(
          "INSERT INTO mr_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(key, groupId);
      }
      reason =
        sourceId === GLOBAL_CATALOG
          ? "External file import: explicit assignment required; organized in a disabled import group"
          : "Legacy default group was removed; organized in a disabled import group";
    }
    if (!groupId)
      throw new Conflict(
        "Assign a group to the test before discovery: " + o.path,
      );
    db.prepare(
      "INSERT INTO mr_test_owners VALUES(?,?,?,?) ON CONFLICT(source_id,occurrence_id) DO UPDATE SET group_id=excluded.group_id,reason=excluded.reason",
    ).run(sourceId, o.occurrenceId, groupId, reason);
    return { groupId, reason };
  }
  const sync = db.transaction(() => {
    const meta = info(),
      p = store.get(GLOBAL_CATALOG)!;
    const own = p.occurrences.filter(
      (o) => !o.sourceProjectId || o.sourceProjectId === GLOBAL_CATALOG,
    );
    const occurrences: Occurrence[] = [];
    let infoChanged = false;
    for (const source of sources()) {
      for (const o of source.id === GLOBAL_CATALOG ? own : source.occurrences) {
        const alias = meta.aliases.find(
          (a) =>
            a.projectId === source.id &&
            a.kind === "test" &&
            a.oldId === o.occurrenceId,
        );
        // Occurrence UUID collisions use the same stable namespace rule as migration.
        const id =
          alias?.id ??
          (source.id === GLOBAL_CATALOG
            ? o.occurrenceId
            : "legacy-" +
              fingerprint({ source: source.id, id: o.occurrenceId }).slice(
                0,
                32,
              ));
        if (!alias && source.id !== GLOBAL_CATALOG) {
          meta.aliases.push({
            projectId: source.id,
            kind: "test",
            oldId: o.occurrenceId,
            id,
          });
          infoChanged = true;
        }
        const mapping =
          source.id === GLOBAL_CATALOG && o.groupId
            ? {
                groupId: o.groupId,
                reason: o.ownership ?? "Assigned when created",
              }
            : owner(source.id, o);
        let projectId: string | null =
          source.id === GLOBAL_CATALOG ? null : source.id;
        try {
          const fixture = parseFixture(o.source ?? "");
          if (fixture.meta.project_id !== undefined)
            projectId = fixture.meta.project_id;
        } catch {}
        occurrences.push({
          ...o,
          occurrenceId: id,
          sourceProjectId: source.id,
          sourceOccurrenceId: o.sourceOccurrenceId ?? o.occurrenceId,
          projectId,
          location: fileLocation(source.config),
          groupId: mapping.groupId,
          ownership: mapping.reason,
          ruleAliases: Object.fromEntries(
            meta.aliases
              .filter((a) => a.projectId === source.id && a.kind === "rule")
              .map((a) => [a.oldId, a.id]),
          ),
        });
      }
    }
    if (infoChanged)
      db.prepare(
        "UPDATE mr_metadata SET value=? WHERE key='global-catalog-v1'",
      ).run(canonical(meta));
    const current = store.get(GLOBAL_CATALOG)!;
    if (canonical(occurrences) !== canonical(current.occurrences))
      return store.discover(GLOBAL_CATALOG, current.revision, occurrences);
    return p;
  });
  sync();
  return {
    info,
    sources,
    sync,
    assign(sourceId: string, occurrenceId: string, groupId: string) {
      if (!store.get(GLOBAL_CATALOG)!.groups.some((g) => g.id === groupId))
        throw new Conflict("Choose a saved group.");
      db.prepare(
        "INSERT INTO mr_test_owners VALUES(?,?,?,?) ON CONFLICT(source_id,occurrence_id) DO UPDATE SET group_id=excluded.group_id,reason=excluded.reason",
      ).run(sourceId, occurrenceId, groupId, "Explicit group assignment");
    },
  };
}
