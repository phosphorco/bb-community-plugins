import { coAuthorTrailers, resolveInputSchema, unavailableAttribution, type ResolveResult } from '@phosphorco/bb-people-accounts';
import type { PeopleStatus } from '../rpc-contract';

const usage = 'bb people-accounts resolve --for EMAIL_OR_HANDLE [--for MORE...] [--format json|trailers]\nbb people-accounts status [--check]\n';
export async function runCli(argv: string[], port: { resolve(inputs: string[]): Promise<ResolveResult>; status(): Promise<PeopleStatus>; check(): Promise<PeopleStatus> }) {
  if (argv.includes('--help') || argv.includes('-h')) return { exitCode: 0, stdout: usage };
  if (argv[0] === 'status' && (argv.length === 1 || (argv.length === 2 && argv[1] === '--check'))) {
    const status = argv[1] === '--check' ? await port.check() : await port.status();
    return { exitCode: 0, stdout: `${JSON.stringify(status, null, 2)}\n` };
  }
  if (argv[0] !== 'resolve') return { exitCode: 1, stderr: usage };
  const inputs: string[] = [];
  let format = 'json';
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (!value || (flag !== '--for' && flag !== '--format')) return { exitCode: 1, stderr: usage };
    if (flag === '--for') inputs.push(value);
    else format = value;
  }
  if (format !== 'json' && format !== 'trailers') return { exitCode: 1, stderr: usage };
  if (!resolveInputSchema.safeParse({ version: 1, inputs }).success) return { exitCode: 1, stderr: 'Invalid attribution inputs.\n' };
  let warning = '';
  try {
    warning = (await port.status()).reloadRequired ? 'Saved roster changes are inactive; reload people-accounts\n' : '';
    const result = await port.resolve(inputs);
    if (format === 'json') return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: warning };
    const trailers = coAuthorTrailers(result.attribution);
    return { exitCode: 0, stdout: trailers.length ? `${trailers.join('\n')}\n` : '', stderr: warning + (result.attribution.fallbackReason ? `${result.attribution.fallbackReason}\n` : '') };
  } catch {
    // Commit attribution is optional, including when storage or the supplier fails.
    const attribution = unavailableAttribution('unavailable', { inputs });
    return { exitCode: 0, stdout: format === 'json' ? `${JSON.stringify({ version: 1, results: [], attribution }, null, 2)}\n` : '', stderr: warning + `${attribution.fallbackReason}\n` };
  }
}
