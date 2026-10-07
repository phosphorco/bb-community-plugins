import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withBuildLifecycle } from '../scripts/build-lifecycle.mjs';

describe('compiler cancellation', () => {
  it('rejects a signalled zero-exit compiler and retains handlers through delayed cleanup', async () => {
    const signals = new EventEmitter();
    const scratch = await mkdtemp(join(tmpdir(), 'nerd-guide-cancel-test-'));
    let release;
    const cleanupGate = new Promise(resolve => { release = resolve; });
    let entered;
    const cleaning = new Promise(resolve => { entered = resolve; });
    let childExit;
    const build = withBuildLifecycle(async lifecycle => {
      const result = lifecycle.run(process.execPath, ['-e',
        "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 'pipe', 'inherit'] });
      childExit = await result;
      return childExit;
    }, async () => { entered(); await cleanupGate; await rm(scratch, { recursive: true, force: true }); }, signals,
    (...args) => {
      const child = spawn(...args);
      child.stdout.once('data', () => signals.emit('SIGTERM'));
      return child;
    });
    const rejection = expect(build).rejects.toThrow('Build cancelled by SIGINT');
    await cleaning;
    expect(childExit).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    signals.emit('SIGINT');
    release();
    await rejection;
    await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
