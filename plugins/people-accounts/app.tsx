import './app.css';
import { useRecoveringRead } from './lib/useRecoveringRead.ts';
import { ReadStatus } from './lib/ReadStatus.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc, useSdk, useSettings } from '@get-bb/plugin-sdk/app';
import { STATUS_CHANNEL, type localContract } from './rpc-contract';
import type { RosterRowV1 } from '@phosphorco/bb-people-accounts';

type DirectoryResult = { items: { personKey: string; displayName: string; handle: string | null }[]; reason: string | null; truncated: boolean };
export function createPatUrl(botLogin: string | null, organization: string | undefined): string | null {
  const target = organization?.trim();
  if (botLogin === null || !target) return null;
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.search = new URLSearchParams({
    name: `BB ${botLogin}`.slice(0, 40),
    description: `BB pull request attribution for @${botLogin} in ${target}.`.slice(0, 1024),
    target_name: target, pull_requests: 'write', contents: 'read',
  }).toString();
  return url.toString();
}

function PersonHealth({ row, organization }: { row: RosterRowV1; organization: string | undefined }) {
  const health = row.credential;
  const mismatch = health.actsAs !== null && row.botLogin !== null && health.actsAs.toLowerCase() !== row.botLogin.toLowerCase();
  const patUrl = createPatUrl(row.botLogin, organization);
  const aliases = [...row.aliases.emails, ...row.aliases.nicknames, ...row.aliases.handles];
  return <li className="people-account-row">
    <strong>{row.displayName}</strong>
    <p className="people-muted">Human: {row.githubLogin ? `@${row.githubLogin}` : 'not configured'} · Bot: {row.botLogin ? `@${row.botLogin}` : 'not configured'}</p>
    <p>Token: {health.state === 'missing' ? 'missing' : health.state === 'configured' ? 'configured, not checked' : health.state === 'ok' ? 'last check succeeded' : 'last check failed'}</p>
    <p>Token account: {health.actsAs ? `@${health.actsAs}` : 'not checked'} · Roster expects: {row.botLogin ? `@${row.botLogin}` : 'fill in your bot login'}</p>
    {mismatch && <p className="people-error people-mismatch" role="status">Token belongs to @{health.actsAs}; roster expects @{row.botLogin}. Attribution remains available.</p>}
    <p className="people-muted">Expiry: {health.checkedAt === null ? 'not checked' : health.expiresAt ?? 'not advertised'} · Last check: {health.checkedAt ?? 'never'}</p>
    <p className="people-muted">Advertised scopes: {health.scopes == null ? 'unknown (GitHub may omit these for fine-grained tokens)' : health.scopes.length ? health.scopes.join(', ') : 'none advertised'}</p>
    {health.message && !mismatch && <p className="people-error">{health.message}</p>}
    {patUrl ? <>
      <a href={patUrl} target="_blank" rel="noreferrer">Create PAT for @{row.botLogin}</a>
      <p className="people-muted">Be signed in to GitHub as @{row.botLogin} when opening; resource owner {organization}; Pull requests read/write; Contents read.</p>
    </> : <p>{!organization ? 'Set the GitHub organization above to create your PAT setup link. ' : ''}{row.botLogin === null ? 'Fill in your bot login in your roster row and reload settings to create your PAT.' : ''}</p>}
    {!row.committer && <p className="people-muted">No committer name/email; this person produces no co-author trailer.</p>}
    {aliases.length === 0 && <p className="people-muted">No aliases configured; use the person key or display name.</p>}
    <details><summary>Matching details</summary><p>{aliases.length ? aliases.join(', ') : 'No aliases'}</p><code>{row.personKey}</code></details>
  </li>;
}

export function PeopleAccountsSettings() {
  const rpc = useRpc<typeof localContract>();
  const sdk = useSdk();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const alive = useRef(false);
  const searchVersion = useRef(0);
  const action = useRef(false);
  const connection = useRealtimeConnectionState();
  const { values } = useSettings();
  const organization = typeof values?.githubOrganization === 'string' ? values.githubOrganization.trim() : undefined;
  const [checkError, setCheckError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'reload' | null>(null);
  const [query, setQuery] = useState('');
  const [directory, setDirectory] = useState<DirectoryResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; searchVersion.current++; }; }, []);
  const readSummary = useCallback(async () => {
    try { return await rpcRef.current.call('peopleAccountsStatus', null); }
    catch { throw new Error('Could not refresh the people accounts summary.'); }
  }, []);
  const { data: status, error: readError, refresh } = useRecoveringRead(readSummary);
  const previousRoster = useRef(values?.roster);
  useEffect(() => {
    if (previousRoster.current !== values?.roster) { previousRoster.current = values?.roster; void refresh(); }
  }, [refresh, values?.roster]);
  useRealtime(STATUS_CHANNEL, () => { void refresh(); });
  const runChecks = async () => {
    if (action.current || status === null) return;
    action.current = true; setBusy('check');
    try {
      const keys = status.entries.map(row => row.personKey);
      for (let start = 0; start < keys.length && alive.current; start += 16) {
        await rpcRef.current.call('peopleAccountsCheck', { personKeys: keys.slice(start, start + 16) });
      }
      if (alive.current) { setCheckError(null); await refresh(); }
    } catch { if (alive.current) setCheckError('Could not finish token checks. Refresh the summary and run checks again.'); }
    finally { action.current = false; if (alive.current) setBusy(null); }
  };
  const reload = async () => {
    if (action.current) return;
    action.current = true; setBusy('reload');
    try {
      await sdk.plugins.reload({ pluginId: 'people-accounts' });
      // Reload the native settings form as well as this section, so new secret descriptors appear.
      window.location.reload();
    } catch { if (alive.current) { setReloadError('Could not reload people accounts. Check plugin status and try again.'); setBusy(null); } }
    finally { action.current = false; }
  };
  const search = async () => {
    const version = ++searchVersion.current;
    setSearching(true);
    try {
      const next = await rpcRef.current.call('peopleAccountsDirectory', { query });
      if (alive.current && version === searchVersion.current) { setDirectory(next); setSearchError(null); }
    } catch { if (alive.current && version === searchVersion.current) setSearchError('Could not search the directory. Known person keys still work.'); }
    finally { if (alive.current && version === searchVersion.current) setSearching(false); }
  };
  return <div className="people-accounts">
    <p className="people-muted">Add or update your own row in the shared roster above, keeping your teammates’ rows. Save → Reload settings → paste your PAT into your secret field above. Keep tokens out of roster JSON.</p>
    <div className="people-actions">
      <button type="button" onClick={() => void reload()} disabled={busy !== null}>{busy === 'reload' ? 'Reloading settings…' : 'Reload settings'}</button>
      <button type="button" onClick={() => void refresh()}>Refresh summary</button>
      <button type="button" onClick={() => void runChecks()} disabled={busy !== null || !status?.entries.length}>{busy === 'check' ? 'Checking tokens…' : 'Run checks'}</button>
    </div>
    <p className="people-muted">Checks run only when requested. Account and scope differences are diagnostic; attribution keeps working. Removing a person retains their secret; clear the secret explicitly to delete it. Shared bots use the first configured token in roster order.</p>
    {connection !== 'connected' && <p role="status" className="people-muted">Connecting to people accounts…</p>}
    <ReadStatus subject="People accounts summary" error={readError} retry={() => void refresh()} />
    {checkError && <p role="alert" className="people-error">{checkError}</p>}
    {reloadError && <p role="alert" className="people-error">{reloadError}</p>}
    {status?.reloadRequired && <p role="status">Roster changes are saved. Reload settings to activate them and expose new token fields.</p>}
    {status?.diagnostics.length ? <ul>{status.diagnostics.map((message, index) => <li key={index}>{message}</li>)}</ul> : null}
    {status === null ? (readError ? null : <p className="people-muted">Loading summary…</p>) : <ul className="people-account-list">{status.entries.map(row => <PersonHealth key={row.personKey} row={row} organization={organization} />)}</ul>}
    <details>
      <summary>Find a person key</summary>
      <form className="people-actions" onSubmit={event => { event.preventDefault(); void search(); }}>
        <label>Directory name or handle <input value={query} maxLength={320} onChange={event => setQuery(event.target.value)} /></label>
        <button type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search directory'}</button>
      </form>
      {searchError && <p role="alert" className="people-error">{searchError}</p>}
      {directory?.reason && <p>{directory.reason}</p>}
      {directory && !directory.reason && directory.items.length === 0 && <p>No matching people found. Known person keys can still be entered in the roster.</p>}
      {directory?.truncated && <p>More people match; narrow the search.</p>}
      <ul>{directory?.items.map(person => <li key={person.personKey}>{person.displayName}{person.handle ? ` (@${person.handle})` : ''}<br /><code>{person.personKey}</code></li>)}</ul>
    </details>
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'people-accounts-health', title: 'People and token health', component: PeopleAccountsSettings });
});
