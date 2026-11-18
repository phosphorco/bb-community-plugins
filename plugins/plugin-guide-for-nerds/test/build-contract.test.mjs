import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function build({ exit = 0, args = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nerd-guide-build-contract-'));
  roots.push(root);
  const compiler = join(root, 'compiler.mjs');
  const receipt = join(root, 'called.json');
  writeFileSync(compiler, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.BB_GUIDE_TEST_RECEIPT, JSON.stringify({
      args: process.argv.slice(2), forwardedCli: process.env.BB_CLI ?? null,
    }));
    process.exit(Number(process.env.BB_GUIDE_TEST_EXIT));
  `);
  const result = spawnSync(process.execPath, [resolve('scripts/build.mjs'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BB_TOOLCHAIN_CLI: compiler,
      BB_CLI: 'unselected-live-cli',
      BB_GUIDE_TEST_RECEIPT: receipt,
      BB_GUIDE_TEST_EXIT: String(exit),
    },
  });
  return { ...result, call: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null };
}

it('runs the selected native compiler without forwarding the live host CLI', () => {
  const result = build();
  expect(result.status, result.stderr).toBe(0);
  expect(result.call).toEqual({ args: ['plugin', 'build', '.'], forwardedCli: null });
});

it('propagates a failure from the selected compiler', () => {
  const result = build({ exit: 42 });
  expect(result.call).not.toBeNull();
  expect(result.status).toBe(42);
});

it('rejects the retired lazy artifact option before invoking a compiler', () => {
  const result = build({ args: ['--lazy'] });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Artifact format 2 is retired');
  expect(result.call).toBeNull();
});
