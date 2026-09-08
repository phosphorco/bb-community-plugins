import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The target CLI is a pinned npm dependency, independent of the running host.
const cli = fileURLToPath(new URL("../node_modules/bb-app-target/dist/bb.js", import.meta.url));
const env = { ...process.env };
delete env.BB_CLI;
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
