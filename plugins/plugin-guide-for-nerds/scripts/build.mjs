import { withBuildLifecycle } from './build-lifecycle.mjs';
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const lazy = process.argv.includes("--lazy");
const explicitCli = process.env.BB_GUIDE_FORK_CLI;
if (lazy && (!explicitCli || !isAbsolute(explicitCli))) {
  throw new Error("Lazy builds require absolute BB_GUIDE_FORK_CLI for a proven generation-serving builder/host pair. Public BB 0.44 produces one app bundle.");
}
const env = { ...process.env };
delete env.BB_CLI;
// Public 0.44 discovers SDK value exports relative to its compiler, so a
// hoisted CLI can accidentally discover another workspace's older SDK.
// Isolate ONLY published compiler artifacts; the plugin is built in place.
let scratch;
process.exitCode = await withBuildLifecycle(async lifecycle => {
  let executable = explicitCli;
  if (!lazy) {
    const packageRoot = join(dirname(require.resolve("bb-app-build-044")), "..");
    const sdkRoot = join(dirname(require.resolve("@get-bb/plugin-sdk/app")), "..");
    const compilerPackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
    if (compilerPackage.version !== '0.44.0' || sdkPackage.version !== '0.5.29') {
      throw new Error('Independent public build requires bb-app 0.44.0 and Plugin SDK 0.5.29.');
    }
    const compilerRequire = createRequire(join(packageRoot, "package.json"));
    scratch = await mkdtemp(join(tmpdir(), "nerd-guide-public-compiler-"));
    await cp(join(packageRoot, "host-daemon", "dist"), join(scratch, "compiler"), { recursive: true });
    await mkdir(join(scratch, "node_modules", "@get-bb"), { recursive: true });
    // These are real published packages, with ordinary module resolution;
    // no SDK declaration copies or TypeScript aliases are introduced.
    await symlink(sdkRoot, join(scratch, "node_modules", "@get-bb", "plugin-sdk"));
    await symlink(dirname(compilerRequire.resolve("npm/package.json")), join(scratch, "node_modules", "npm"));
    executable = join(scratch, "compiler", "bb");
  }
  lifecycle.throwIfCancelled();
  return await lifecycle.run(executable, ["plugin", "build", "."], { stdio: "inherit", env });
}, async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
