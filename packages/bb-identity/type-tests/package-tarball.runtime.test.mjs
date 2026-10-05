import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("packed library isolates generic entries and resolves public peer entries", { timeout: 30_000 }, async () => {
  const destination = await mkdtemp(join(tmpdir(), "bb-identity-pack-"));
  try {
    const packed = Bun.spawnSync({
      cmd: ["bun", "pm", "pack", "--destination", destination],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(packed.exitCode, 0, new TextDecoder().decode(packed.stderr));

    const archives = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
    assert.deepEqual(archives.length, 1, "packing should produce exactly one tarball");
    const archive = join(destination, archives[0]);
    const listed = Bun.spawnSync({ cmd: ["tar", "-tzf", archive], stdout: "pipe", stderr: "pipe" });
    assert.equal(listed.exitCode, 0, new TextDecoder().decode(listed.stderr));
    const entries = new Set(new TextDecoder().decode(listed.stdout).trim().split("\n"));

    for (const entry of [
      "package/index.d.ts", "package/model.d.ts", "package/host.d.ts", "package/server.d.ts",
      "package/testing.d.ts", "package/client.d.ts", "package/state.d.ts", "package/bb.d.ts", "package/react.d.ts",
      "package/dist/index-runtime.js", "package/dist/model-runtime.js", "package/dist/host-runtime.js",
      "package/dist/server-runtime.js", "package/dist/testing-runtime.js", "package/dist/state-runtime.js",
      "package/dist/state-service-runtime.js", "package/dist/state-controller-runtime.js",
      "package/dist/state-transport-runtime.js",
      "package/dist/bb-entry-runtime.js", "package/dist/client-entry-runtime.js", "package/dist/react-entry-runtime.js",
    ]) assert.equal(entries.has(entry), true, `missing packed ${entry}`);

    for (const absent of ["package/dist/bb-runtime.js", "package/dist/client-runtime.js", "package/dist/react-runtime.js"]) {
      assert.equal(entries.has(absent), false, `unexpected unsupported packed runtime ${absent}`);
    }

    const consumer = join(destination, "consumer");
    const packageDirectory = join(destination, "unpacked");
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(join(consumer, "node_modules", "@phosphorco"), { recursive: true });
    const unpacked = Bun.spawnSync({ cmd: ["tar", "-xzf", archive, "-C", packageDirectory], stdout: "pipe", stderr: "pipe" });
    assert.equal(unpacked.exitCode, 0, new TextDecoder().decode(unpacked.stderr));
    const packedManifest = JSON.parse(await readFile(join(packageDirectory, "package", "package.json"), "utf8"));
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const version of Object.values(packedManifest[field] ?? {})) {
        assert.equal(/^(catalog|workspace):/.test(version), false, `${field} contains an unresolved package-manager protocol`);
      }
    }
    await symlink(join(packageDirectory, "package"), join(consumer, "node_modules", "@phosphorco", "bb-identity"));
    await assert.rejects(access(join(consumer, "node_modules", "react")));

    const declarationWitness = join(consumer, "generic-entry-consumer.ts");
    await writeFile(declarationWitness, [
      'import * as root from "@phosphorco/bb-identity";',
      'import * as model from "@phosphorco/bb-identity/model";',
      'import * as host from "@phosphorco/bb-identity/host";',
      'import * as server from "@phosphorco/bb-identity/server";',
      'import * as testing from "@phosphorco/bb-identity/testing";',
      'import * as state from "@phosphorco/bb-identity/state";',
      'import * as client from "@phosphorco/bb-identity/client";',
      'void [root, model, host, server, testing, state, client];',
      '',
    ].join("\n"));
    const tsc = join(packageRoot, "..", "..", "node_modules", ".bin", "tsc");
    await access(tsc);
    const declarations = Bun.spawnSync({
      cmd: [tsc, "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2023", declarationWitness],
      cwd: consumer,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(declarations.exitCode, 0, new TextDecoder().decode(declarations.stderr));

    const runtimeWitness = join(consumer, "generic-entry-consumer.mjs");
    await writeFile(runtimeWitness, [
      'import * as root from "@phosphorco/bb-identity";',
      'import * as model from "@phosphorco/bb-identity/model";',
      'import * as host from "@phosphorco/bb-identity/host";',
      'import * as server from "@phosphorco/bb-identity/server";',
      'import * as testing from "@phosphorco/bb-identity/testing";',
      'import * as state from "@phosphorco/bb-identity/state";',
      'import * as client from "@phosphorco/bb-identity/client";',
      'const entries = [root, model, host, server, testing, state, client];',
      'if (entries.some((entry) => Object.keys(entry).length === 0)) process.exitCode = 1;',
      'const clock = testing.createManualClock();',
      'const connection = testing.createConnectionHarness();',
      'const storage = testing.createStateStorageHarness({ clock });',
      'if (typeof connection.connect !== "function" || typeof storage.storage.commit !== "function") process.exitCode = 1;',
      'connection.connection.dispose();',
      '',
    ].join("\n"));
    const runtime = Bun.spawnSync({ cmd: ["bun", runtimeWitness], cwd: consumer, stdout: "pipe", stderr: "pipe" });
    assert.equal(runtime.exitCode, 0, new TextDecoder().decode(runtime.stderr));

    const workspaceModules = join(packageRoot, "..", "..", "node_modules");
    async function linkHost(name, root = consumer) {
      const destinationParts = name.split("/");
      const destinationDirectory = destinationParts.length === 1
        ? join(root, "node_modules")
        : join(root, "node_modules", destinationParts[0]);
      await mkdir(destinationDirectory, { recursive: true });
      await symlink(join(workspaceModules, ...destinationParts), join(destinationDirectory, destinationParts.at(-1)));
    }
    for (const hostDependency of ["react", "@get-bb/plugin-sdk", "@types/react", "zod"]) {
      await linkHost(hostDependency);
      // The packed module remains extracted outside this consumer's source
      // tree, so TypeScript resolves its peer declarations from its real path.
      await linkHost(hostDependency, packageDirectory);
    }

    const publicEntryDeclarations = join(consumer, "public-entry-consumer.ts");
    await writeFile(publicEntryDeclarations, [
      'import * as root from "@phosphorco/bb-identity";',
      'import * as model from "@phosphorco/bb-identity/model";',
      'import * as host from "@phosphorco/bb-identity/host";',
      'import * as server from "@phosphorco/bb-identity/server";',
      'import * as testing from "@phosphorco/bb-identity/testing";',
      'import * as state from "@phosphorco/bb-identity/state";',
      'import * as bb from "@phosphorco/bb-identity/bb";',
      'import * as client from "@phosphorco/bb-identity/client";',
      'import * as react from "@phosphorco/bb-identity/react";',
      'void [root, model, host, server, testing, state, bb, client, react];',
      '',
    ].join("\n"));
    const publicDeclarations = Bun.spawnSync({
      cmd: [tsc, "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2023", publicEntryDeclarations],
      cwd: consumer,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(
      publicDeclarations.exitCode,
      0,
      `${new TextDecoder().decode(publicDeclarations.stdout)}${new TextDecoder().decode(publicDeclarations.stderr)}`,
    );

    const reactWitness = join(consumer, "react-consumer.mjs");
    await writeFile(reactWitness, [
      'import * as hostReact from "react";',
      'import { BbIdentity, IdentityAvatar, IdentityLabel, IdentityViewPicker, IdentityViewStatus, useBbIdentityClient, useBbIdentityConnection } from "@phosphorco/bb-identity/react";',
      'if (typeof hostReact.createElement !== "function" || typeof BbIdentity.Provider !== "function" || typeof BbIdentity.Context !== "function" || typeof IdentityAvatar !== "function" || typeof IdentityLabel !== "function" || typeof IdentityViewPicker !== "function" || typeof IdentityViewStatus !== "function" || typeof useBbIdentityClient !== "function" || typeof useBbIdentityConnection !== "function") process.exitCode = 1;',
      '',
    ].join("\n"));
    const reactRuntime = Bun.spawnSync({ cmd: ["bun", reactWitness], cwd: consumer, stdout: "pipe", stderr: "pipe" });
    assert.equal(reactRuntime.exitCode, 0, new TextDecoder().decode(reactRuntime.stderr));

    const bbWitness = join(consumer, "bb-consumer.mjs");
    await writeFile(bbWitness, [
      'import * as bb from "@phosphorco/bb-identity/bb";',
      'if (Object.keys(bb).length === 0 || typeof bb.bindBbIdentity !== "function") process.exitCode = 1;',
      '',
    ].join("\n"));
    const bbRuntime = Bun.spawnSync({ cmd: ["bun", bbWitness], cwd: consumer, stdout: "pipe", stderr: "pipe" });
    assert.equal(bbRuntime.exitCode, 0, new TextDecoder().decode(bbRuntime.stderr));

    const reactBundle = await readFile(join(packageDirectory, "package", "dist", "react-entry-runtime.js"), "utf8");
    assert.match(reactBundle, /from "react"/);
    assert.match(reactBundle, /from "@get-bb\/plugin-sdk\/app"/);
    assert.doesNotMatch(reactBundle, /react\.development|react\.production/);
    const bbBundle = await readFile(join(packageDirectory, "package", "dist", "bb-entry-runtime.js"), "utf8");
    assert.match(bbBundle, /from "zod"/);
    assert.doesNotMatch(bbBundle, /@get-bb\/plugin-sdk/);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});
