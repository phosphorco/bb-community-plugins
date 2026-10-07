import { spawn } from 'node:child_process';

/** Cancellation stays authoritative until owned temporary tools are retired. */
export async function withBuildLifecycle(work, cleanup, signals = process, spawnChild = spawn) {
  let child;
  let cancelled;
  const cancel = signal => { cancelled = signal; child?.kill(signal); };
  const interrupt = () => cancel('SIGINT');
  const terminate = () => cancel('SIGTERM');
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', terminate);
  try {
    return await work({
      throwIfCancelled() { if (cancelled) throw new Error(`Build cancelled by ${cancelled}`); },
      async run(executable, args, options) {
        if (cancelled) throw new Error(`Build cancelled by ${cancelled}`);
        return await new Promise((resolve, reject) => {
          child = spawnChild(executable, args, options);
          child.once('error', reject);
          child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
        });
      },
    });
  } finally {
    child = undefined;
    try {
      await cleanup();
    } finally {
      signals.removeListener('SIGINT', interrupt);
      signals.removeListener('SIGTERM', terminate);
    }
    if (cancelled) throw new Error(`Build cancelled by ${cancelled}`);
  }
}
