import { createHash } from 'node:crypto';
import { LIMITS, normalizeAliasKey, rosterEntryV1Schema, type RosterEntryV1, type CredentialHealthV1 } from '@phosphorco/bb-people-accounts';

/** Fixed-size filename mapping for opaque keys, independent of presentation. */
export function tokenSlot(personKey: string): string {
  return `github_pat_${createHash('sha256').update(personKey, 'utf8').digest('hex')}`;
}
export function parseRoster(raw: string): { entries: RosterEntryV1[]; diagnostics: string[] } {
  let value: unknown;
  if (Buffer.byteLength(raw) > LIMITS.responseBytes) return { entries: [], diagnostics: ['Roster JSON exceeds 262144 bytes.'] };
  try { value = JSON.parse(raw); }
  catch { return { entries: [], diagnostics: ['Roster is not valid JSON. Save an array of roster entries and reload.'] }; }
  if (!Array.isArray(value) || value.length > LIMITS.rosterEntries) return { entries: [], diagnostics: ['Roster must be an array of at most 256 entries.'] };
  const diagnostics: string[] = [];
  const valid = value.flatMap((entry, index) => {
    const result = rosterEntryV1Schema.safeParse(entry);
    if (result.success) return [result.data];
    // Do not echo user values (including accidentally pasted credentials).
    diagnostics.push(`Roster entry ${index + 1} is invalid; expected personKey, displayName, aliases, githubLogin, botLogin and committer.`);
    return [];
  });
  const entries = valid.filter(entry => {
    const duplicates = valid.filter(other => other.personKey === entry.personKey);
    if (duplicates.length === 1) return true;
    diagnostics.push('Duplicate person key: conflicting entries were omitted.');
    return false;
  });
  const names = new Map<string, string>();
  for (const entry of entries) {
    const aliases = [entry.personKey, entry.displayName, ...entry.aliases.emails, ...entry.aliases.nicknames, ...entry.aliases.handles,
      ...(entry.githubLogin ? [entry.githubLogin] : []), ...(entry.botLogin ? [entry.botLogin] : []), ...(entry.committer ? [entry.committer.email] : [])];
    for (const alias of aliases) {
      const key = normalizeAliasKey(alias);
      const previous = names.get(key);
      if (previous !== undefined && previous !== entry.personKey) diagnostics.push('Some names or aliases match multiple people. Use an unambiguous email or person key.');
      names.set(key, entry.personKey);
    }
  }
  if (entries.length === 0 && diagnostics.length === 0) diagnostics.push('No people configured; consumers use their default account.');
  return { entries, diagnostics: [...new Set(diagnostics)] };
}
export function uncheckedHealth(configured: boolean): CredentialHealthV1 {
  return { state: configured ? 'configured' : 'missing', actsAs: null, expiresAt: null, checkedAt: null, message: null };
}

export type AccountFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Explicit diagnostics only. Neither a failed check nor mismatched login gates routing. */
export async function checkGitHubToken(token: string, expectedLogin: string | null, fetcher: AccountFetch, signal: AbortSignal, timeoutMs = 5000): Promise<CredentialHealthV1> {
  const checkedAt = new Date().toISOString();
  const failed = (message: string): CredentialHealthV1 => ({ ...uncheckedHealth(true), state: 'failing', checkedAt, message });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<CredentialHealthV1>(resolve => {
    abort = () => { controller.abort(); resolve(failed('GitHub account check unavailable or timed out.')); };
    if (signal.aborted) abort();
    else { signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, timeoutMs); }
  });
  const request = async (): Promise<CredentialHealthV1> => {
  try {
    if (signal.aborted) return failed('GitHub account check unavailable or timed out.');
    const response = await fetcher('https://api.github.com/user', {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2026-03-10' },
      signal: controller.signal,
    });
    if (!response.ok) return failed(response.status === 401 ? 'GitHub rejected the token (HTTP 401).' : `GitHub account check failed (HTTP ${response.status}).`);
    const body: unknown = await response.json();
    const login = typeof body === 'object' && body !== null && 'login' in body ? body.login : null;
    if (typeof login !== 'string' || login === token || !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) return failed('GitHub account response did not include a valid login.');
    const advertised = response.headers.get('x-oauth-scopes');
    const scopes = advertised === null || advertised.trim() === '' ? null : advertised.split(',').map(v => v.trim()).filter(v => v !== token && /^[a-z][a-z0-9:_-]{0,127}$/.test(v)).slice(0, 64);
    const expiration = response.headers.get('github-authentication-token-expiration');
    const timestamp = expiration !== null && expiration.length <= 64 ? Date.parse(expiration) : NaN;
    return {
      state: 'ok', actsAs: login, expiresAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      checkedAt, scopes, message: expectedLogin !== null && login.toLowerCase() !== expectedLogin.toLowerCase() ? 'Token acts as a different account than the configured bot login; routing remains available.' : null,
    };
  } catch { return failed('GitHub account check unavailable or timed out.'); }
  };
  try { return await Promise.race([request(), interrupted]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
