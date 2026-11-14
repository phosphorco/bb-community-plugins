import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
const evidence = process.env.MESSAGE_RULES_EVIDENCE_ROOT;
if (!evidence)
  throw Error(
    "Set MESSAGE_RULES_EVIDENCE_ROOT to a task-owned proof directory.",
  );
mkdirSync(evidence, { recursive: true });
const root = resolve("../.."),
  workspace = resolve("../../..");
const records = [];
for (const [name, command, args, cwd] of [
  ["install", "npm", ["ci", "--cache", "/tmp/message-rules-npm-cache"], root],
  ["test", "npm", ["run", "test"], root],
  ["typecheck", "npm", ["run", "typecheck"], root],
  ["build", "npm", ["run", "build"], root],
  ["workspace", "./bin/check", ["--role", "normal"], workspace],
]) {
  const log = resolve(evidence, name + ".log"),
    fd = openSync(log, "w"),
    start = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      npm_config_cache:
        process.env.npm_config_cache ?? "/tmp/message-rules-npm-cache",
    },
  });
  closeSync(fd);
  records.push({
    name,
    command,
    args,
    cwd,
    start,
    exit: result.status,
    error: result.error?.message ?? null,
    log,
  });
  writeFileSync(
    resolve(evidence, "results.json"),
    JSON.stringify(records, null, 2) + "\n",
  );
  console.log(name + ": " + result.status + " · " + log);
}
process.exitCode = records.every((x) => x.exit === 0) ? 0 : 1;
