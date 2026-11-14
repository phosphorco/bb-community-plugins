import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
const name = process.argv[2];
if (name === "capability-harness" && !process.env.MESSAGE_RULES_NATIVE_TRACE)
  throw Error(
    "Set MESSAGE_RULES_NATIVE_TRACE to the actual isolated native control/refusal trace.",
  );
if (name === "scaffold") {
  const p = JSON.parse(readFileSync("package.json", "utf8"));
  if (
    p.devDependencies["@get-bb/plugin-sdk"] !== "0.6.52" ||
    !p.bb.app ||
    !p.bb.server
  )
    throw Error("Invalid public scaffold");
  for (const n of [
    "evaluation",
    "files",
    "state",
    "suites",
    "ui",
    "admission",
    "receipts",
    "ui-suite",
    "capability-harness",
  ])
    if (!p.scripts["oracle:" + n])
      throw Error("Missing fail-closed oracle " + n);
  console.log(
    "Scaffold valid; domain oracles intentionally fail until substantive tests exist.",
  );
} else {
  const mapping = {
    "sdk-ui": "sdk",
    "capability-harness": "capability",
    evaluation: "evaluation",
    witnesses: "contracts",
    "ui-suite": "ui-suite",
    parity: "composition",
    recovery: "state",
    repository: "repository",
  };
  const dir = mapping[name] ?? name;
  if (name === "sdk" || name === "sdk-ui") {
    const compile = spawnSync("npx", ["--no-install", "tsc", "--noEmit"], {
      stdio: "inherit",
    });
    if (compile.status !== 0) process.exit(compile.status ?? 1);
  }
  const { readdirSync, statSync } = await import("node:fs");
  const dirs =
    name === "witnesses"
      ? ["contracts", "evaluation", "files", "state", "suites"]
      : name === "all"
        ? readdirSync("test").filter((x) => statSync("test/" + x).isDirectory())
        : [dir];
  const files = dirs.flatMap((d) =>
    existsSync("test/" + d)
      ? readdirSync("test/" + d)
          .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
          .map((f) => "test/" + d + "/" + f)
      : [],
  );
  if (!files.length) throw Error("No substantive acceptance suite for " + name);
  const p = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    { stdio: "inherit" },
  );
  process.exitCode = p.status ?? 1;
}
