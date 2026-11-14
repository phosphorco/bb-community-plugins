import { withBuildLifecycle } from './build-lifecycle.mjs';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--lazy')) throw new Error('Artifact format 2 is retired. Build native plugin artifacts without --lazy.');
const cli = process.env.BB_TOOLCHAIN_CLI ?? fileURLToPath(new URL('../../../node_modules/bb-app-target/dist/bb.js', import.meta.url));
const env = { ...process.env };
delete env.BB_CLI;
process.exitCode = await withBuildLifecycle(async lifecycle => {
  lifecycle.throwIfCancelled();
  return await lifecycle.run(process.execPath, [cli, 'plugin', 'build', '.'], { stdio: 'inherit', env });
}, async () => {});
