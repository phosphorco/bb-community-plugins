import { useRef, useState } from 'react';
import { useSdk } from '@get-bb/plugin-sdk/app';
import { BbIdentity, IdentityViewPicker, IdentityViewStatus, useBbIdentityClient, useBorrowedIdentityClient, useIdentityViewSnapshot, useIdentityStateBinding, useIdentityStateSnapshot } from '@phosphorco/bb-identity/react';
import { externalLocatorSchema, linksRecordSchema, locatorKey, type ExternalLocator, type LinksRecord } from '@phosphorco/bb-people-accounts/v2';
import { linksResource, LINKS_RECORD } from './links-model';
import { useContributions } from './contributions';

export function PeopleLinksSettings() {
  const client = useBbIdentityClient();
  return <BbIdentity.Provider client={client} fallback={<p role="status">Connecting to the people directory…</p>}>
    <BbIdentity.Context pendingEdits="block"><LinksEditor /></BbIdentity.Context>
  </BbIdentity.Provider>;
}

export function LinksEditor() {
  const sdk = useSdk();
  const client = useBorrowedIdentityClient();
  const directory = useContributions(sdk);
  const view = useIdentityViewSnapshot();
  const binding = useIdentityStateBinding<LinksRecord>({ resource: linksResource, recordId: LINKS_RECORD,
    target: 'viewed-subject', editPolicy: 'collaborators', initializeEmpty: false,
    onConflict: () => ({ kind: 'needs-review', reason: 'Links changed elsewhere. Compare your edit with the saved version.' }),
  });
  const snapshot = useIdentityStateSnapshot(binding);
  const presentedOwner = binding?.currentOwnerSession() ?? null;
  const [message, setMessage] = useState<string | null>(null);
  const [knownSupplier, setKnownSupplier] = useState(''); const [knownSubject, setKnownSubject] = useState('');
  const active = useRef(binding); active.current = binding;
  const value = snapshot.status === 'ready' ? snapshot.desired : snapshot.status === 'blocked' ? snapshot.conflict?.local ?? snapshot.draft?.desired : undefined;
  const ready = snapshot.status === 'ready';
  const edit = (next: LinksRecord) => {
    if (!binding || snapshot.status !== 'ready' || binding.currentOwnerSession() !== snapshot.ownerSession) { setMessage('The selected person changed. Review this view before editing.'); return; }
    setMessage(null); const parsed = linksRecordSchema.safeParse(next);
    if (!parsed.success) { setMessage('This edit has duplicate links or exceeds the record limit.'); return; }
    const result = binding?.edit(parsed.data);
    if (!result?.ok) setMessage(result && !result.ok ? result.error.message : 'Links are not ready to edit.');
  };
  const add = (identity: ExternalLocator) => {
    if (!ready || !value) return;
    if (value.links.some(link => locatorKey(link.identity) === locatorKey(identity))) { setMessage('This account is already linked to this person.'); return; }
    edit({ links: [...value.links, { id: crypto.randomUUID(), identity }] });
  };
  const known = () => {
    const result = externalLocatorSchema.safeParse({ pluginId: knownSupplier, subject: knownSubject });
    if (!result.success) { setMessage('Enter a supplier ID and its exact, context-qualified account subject.'); return; }
    add(result.data);
  };
  const recover = async () => {
    const captured = binding; const owner = presentedOwner;
    if (!captured || !owner) return;
    const result = await captured.reconnect(owner);
    if (active.current === captured && captured.currentOwnerSession() === owner) setMessage(result.ok ? null : result.error.message);
  };
  const conflict = async (keepLocal: boolean) => {
    if (snapshot.status !== 'blocked' || !snapshot.conflict || !binding) return;
    const captured = binding; const owner = presentedOwner;
    if (!owner) return;
    const result = await captured.resolveConflict(owner, snapshot.conflict.token, keepLocal ? { kind: 'rebase', value: snapshot.conflict.local } : { kind: 'accept-remote' });
    if (active.current === captured && captured.currentOwnerSession() === owner) setMessage(result.ok ? null : result.error.message);
  };
  return <section className="people-accounts" aria-label="People account links">
    <p>Associate accounts with a person. A link records a relationship; it grants no access and does not select an acting account.</p>
    <IdentityViewPicker labels={{ trigger: 'Choose a person', self: 'My links', viewingFallback: 'Selected person', dialog: 'Choose a person', search: 'Search people', noResults: 'No people found', searchUnavailable: 'People directory unavailable' }} onResult={result => setMessage(result.ok ? null : result.error.message)} />
    <IdentityViewStatus labels={{ viewing: 'Editing links for', returnSelf: 'Return to my links' }} onResult={result => setMessage(result.ok ? null : result.error.message)} />
    {view.status === 'blocked' && <p role="status">{view.error.message} <button onClick={() => void client.refresh()}>Reconnect people</button></p>}
    {view.status === 'ready' && <p>Person key: <code>{view.subject.key}</code></p>}
    {snapshot.status === 'ready' ? <p role="status">{snapshot.saving || snapshot.dirty ? 'Saving links…' : 'Links are saved.'}</p> : snapshot.status === 'blocked' ? <div role="status"><p>{snapshot.message}</p><button onClick={() => void recover()}>Reconnect links</button>
      {snapshot.conflict && <><button onClick={() => void conflict(false)}>Use saved links</button><button onClick={() => void conflict(true)}>Keep my links</button><details><summary>Compare link edits</summary><p>My edit: {snapshot.conflict.local.links.map(link => `${link.identity.pluginId}/${link.identity.subject}`).join(', ') || 'No links'}</p><p>Saved: {snapshot.conflict.remote.status === 'present' ? snapshot.conflict.remote.envelope.value.links.map(link => `${link.identity.pluginId}/${link.identity.subject}`).join(', ') || 'No links' : snapshot.conflict.remote.status === 'empty' ? 'No links' : 'Saved links require migration'}</p></details></>}
    </div> : <p role="status">Loading links…</p>}
    {message && <p role="alert">{message}</p>}
    <ul className="people-account-list">{value?.links.map(link => <li key={link.id} className="people-account-row"><strong>{link.identity.pluginId}</strong><code>{link.identity.subject}</code>
      {!directory.rows.some(row => row.pluginId === link.identity.pluginId && row.admitted && row.capabilities?.identities) && <p className="people-muted">Supplier unavailable or not discovered. This link is retained.</p>}
      <button disabled={!ready} onClick={() => edit({ links: value.links.filter(other => other.id !== link.id) })}>Remove link {link.identity.pluginId}/{link.identity.subject}</button></li>)}</ul>
    {value?.links.length === 0 && <p>No account links for this person.</p>}
    <div className="people-actions"><button disabled={directory.discovering} onClick={() => void directory.refresh()}>Refresh suppliers</button>{directory.moreDiscovery && <button disabled={directory.discovering} onClick={directory.continueDiscovery}>Continue discovery</button>}</div>
    {directory.discovering && <p role="status">Discovering account suppliers…</p>}
    {directory.discoveryError && <p role="status">{directory.discoveryError}</p>}
    {directory.rows.length > 0 && <details><summary>Supplier status</summary><ul>{directory.rows.map(row => <li key={row.pluginId}>{row.pluginId}: {row.status}{row.status === 'ready' && !row.admitted ? ' (over this view’s supplier limit)' : ''}</li>)}</ul></details>}
    <form onSubmit={event => { event.preventDefault(); void directory.search(); }} className="people-actions"><label>Account supplier<select value={directory.supplier} onChange={event => directory.selectSupplier(event.target.value)}><option value="">Choose a supplier</option>{directory.rows.filter(row => row.admitted && row.capabilities?.identities).map(row => <option key={row.pluginId}>{row.pluginId}</option>)}</select></label>
      <label>Find an account<input value={directory.query} onChange={event => directory.changeQuery(event.target.value)} /></label><button disabled={!directory.supplier || directory.reading}>Search accounts</button></form>
    {directory.readError && <p role="status">{directory.readError}</p>}{directory.partial && <p>This supplier returned partial coverage.</p>}
    <ul>{directory.items.map(item => <li key={locatorKey(item.identity)}><strong>{item.presentation.displayName}</strong> {item.presentation.handle}<code>{item.identity.pluginId}/{item.identity.subject}</code><button disabled={!ready} onClick={() => add(item.identity)}>Link {item.identity.pluginId}/{item.identity.subject}</button></li>)}</ul>
    {directory.hasMore && <button disabled={directory.reading} onClick={() => void directory.search(true)}>More accounts</button>}
    <details><summary>Link a known account reference</summary><p>Use the supplier’s exact account subject, including its workspace or installation context. Equal names do not identify the same account.</p><label>Supplier ID<input value={knownSupplier} onChange={event => setKnownSupplier(event.target.value)} /></label><label>Account subject<input value={knownSubject} onChange={event => setKnownSubject(event.target.value)} /></label><button disabled={!ready} onClick={known}>Add known link</button></details>
    <p className="people-muted">Changes save automatically. Keep this view open until they finish.</p>
  </section>;
}
