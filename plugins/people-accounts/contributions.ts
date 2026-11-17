import { useEffect, useRef, useState } from 'react';
import { createPeopleAccountsDiscovery, createPeopleAccountsV2Client, type PeopleAccountsV2Sdk, type DiscoveryRowV2 } from '@phosphorco/bb-people-accounts/v2/bb';
import type { IdentityV2 } from '@phosphorco/bb-people-accounts/v2';

/** A mounted view borrows the published discovery/client helpers; it owns no registry or polling feed. */
export function useContributions(sdk: PeopleAccountsV2Sdk) {
  const [rows, setRows] = useState<DiscoveryRowV2[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [moreDiscovery, setMoreDiscovery] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [supplier, setSupplier] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<IdentityV2[]>([]);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [next, setNext] = useState<{ cursor: string; revision: string; query: string } | null>(null);
  const owner = useRef<ReturnType<typeof createPeopleAccountsDiscovery> | null>(null);
  const pass = useRef<Awaited<ReturnType<ReturnType<typeof createPeopleAccountsDiscovery>['start']>> | null>(null);
  const alive = useRef(false); const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  const ready = useRef<string[]>([]);
  const drain = async (current: NonNullable<typeof pass.current>, token: number) => {
    try {
      const result = await current.next();
      if (!alive.current || generation.current !== token) return;
      ready.current = result.rows.filter(row => row.admitted).map(row => row.pluginId);
      setRows(result.rows); setMoreDiscovery(result.hasMore); setDiscoveryError(null);
    } catch { if (alive.current && generation.current === token) setDiscoveryError('Could not discover account suppliers. Refresh to try again.'); }
    finally { if (alive.current && generation.current === token) setDiscovering(false); }
  };
  const refresh = async () => {
    const token = ++generation.current;
    pass.current?.dispose(); read.current?.abort(); setReading(false); setItems([]); setNext(null); setReadError(null); setSupplier('');
    setRows([]); setDiscovering(true); setMoreDiscovery(false); setDiscoveryError(null);
    try {
      const current = await owner.current!.start(sdk, { exclude: ['people-accounts'], previouslyReady: ready.current,
        onRow(row) { if (alive.current && token === generation.current) setRows(previous => [...previous.filter(r => r.pluginId !== row.pluginId), row]); },
      });
      if (!alive.current || token !== generation.current) { current.dispose(); return; }
      pass.current = current; await drain(current, token);
    } catch { if (alive.current && token === generation.current) { setDiscoveryError('Could not list account suppliers. Refresh to try again.'); setDiscovering(false); } }
  };
  useEffect(() => {
    alive.current = true; owner.current = createPeopleAccountsDiscovery(); void refresh();
    return () => { alive.current = false; generation.current++; read.current?.abort(); owner.current?.dispose(); };
  }, [sdk]);
  const cancelRead = () => { read.current?.abort(); read.current = null; setReading(false); setItems([]); setNext(null); setReadError(null); setPartial(false); };
  const selectSupplier = (value: string) => { cancelRead(); setSupplier(value); };
  const changeQuery = (value: string) => { cancelRead(); setQuery(value); };
  const search = async (continuation = false) => {
    if (!supplier || !rows.some(row => row.pluginId === supplier && row.admitted && row.capabilities?.identities)) return;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const token = generation.current; setReading(true); setReadError(null);
    const prior = continuation ? next : null;
    if (!prior) { setItems([]); setNext(null); }
    try {
      const result = await createPeopleAccountsV2Client(sdk, supplier).list({ query: prior?.query ?? query, limit: 25,
        ...(prior ? { cursor: prior.cursor, revision: prior.revision } : {}),
      }, controller.signal);
      if (controller.signal.aborted || !alive.current || generation.current !== token) return;
      if (result.status !== 'page') { setItems([]); setNext(null); setReadError(result.status === 'conflict' ? 'The account directory changed. Search again.' : 'This supplier is unavailable. Stored links remain unchanged.'); return; }
      setItems(previous => prior ? [...previous, ...result.items] : result.items);
      setPartial(value => prior ? value || result.coverage === 'partial' : result.coverage === 'partial');
      setNext(result.nextCursor ? { cursor: result.nextCursor, revision: result.revision, query: result.query } : null);
    } catch { if (!controller.signal.aborted && alive.current && generation.current === token) setReadError('Could not read this supplier. Stored links remain unchanged.'); }
    finally { if (!controller.signal.aborted && alive.current && generation.current === token) setReading(false); }
  };
  return { rows, discovering, moreDiscovery, discoveryError, refresh, supplier, selectSupplier, query, changeQuery,
    items, reading, readError, partial, hasMore: next !== null, search,
    continueDiscovery() { if (pass.current && !discovering) { setDiscovering(true); void drain(pass.current, generation.current); } },
  };
}
