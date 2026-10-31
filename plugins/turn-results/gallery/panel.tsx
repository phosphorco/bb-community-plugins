import { useBbNavigate, useSdk } from '@get-bb/plugin-sdk/app';
import type { PluginThreadPanelProps } from '@get-bb/plugin-sdk/app';
import { useLayoutEffect, useRef, useState } from 'react';
import type { GalleryRuntime } from './runtime.ts';
import type { GalleryPresentationRoot } from './runtime.ts';
import { canonicalJson } from '@phosphorco/bb-turn-results';
import type { GalleryRead } from './rpc.ts';
import { untilAborted } from './lifetime.ts';
import { ResultCard } from './view.tsx';

type Cursor = { seq: number; key: string } | undefined;
/** Public panel keyset continuation only. Read lifetime and displayed-content
 * lifetime differ: refresh failure retains working cards, while scope changes
 * fence old navigation immediately. Hidden views make no read or retry loop. */
export function ResultsPanel({ threadId, params, runtime }: PluginThreadPanelProps & { runtime: GalleryRuntime }) {
  const sdk = useSdk(), navigate = useBbNavigate();
  const turnId = params && typeof params === 'object' && !Array.isArray(params) && typeof params.turnId === 'string' ? params.turnId : null;
  const key = JSON.stringify([threadId, turnId]);
  const [paging, setPaging] = useState<{ key: string; after: Cursor; previous: Cursor[] }>({ key, after: undefined, previous: [] });
  const after = paging.key === key ? paging.after : undefined, previous = paging.key === key ? paging.previous : [];
  const [page, setPage] = useState<{ key: string; value: GalleryRead } | null>(null), [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sourceContinuation, setSourceContinuation] = useState(false), [sourceError, setSourceError] = useState<string | null>(null);
  const [content, setContent] = useState<{ key: string; controller: AbortController; presentationRoot: GalleryPresentationRoot } | null>(null);
  const acceptedPage = useRef<GalleryRead | null>(null);
  const currentScope = useRef(key), readGeneration = useRef(0);
  useLayoutEffect(() => {
    currentScope.current = key;
    const controller = new AbortController(); acceptedPage.current = null;
    setSourceContinuation(false); setSourceError(null);
    setContent({ key, controller, presentationRoot: runtime.presentationRoot(controller.signal, () => currentScope.current === key && !controller.signal.aborted) }); setError(null);
    return () => controller.abort();
  }, [key, runtime]);
  useLayoutEffect(() => {
    let active = true, controller: AbortController | null = null, timer: ReturnType<typeof setTimeout> | null = null;
    function stop() { controller?.abort(); if (timer !== null) clearTimeout(timer); timer = null; }
    function read() {
      stop(); if (!active || document.hidden) return;
      const owned = new AbortController(), generation = ++readGeneration.current; controller = owned;
      timer = setTimeout(() => owned.abort('deadline'), 5000);
      void untilAborted(runtime.readScope(threadId, owned.signal, signal => runtime.backend.read(threadId, turnId, signal, after)), owned.signal).then(async result => {
        if (result.state === 'capacity') {
          if (active && currentScope.current === key && !owned.signal.aborted) setError('Results read capacity reached. Retry results after another view settles.');
          return;
        }
        const value = result.value;
        if (active && !owned.signal.aborted && generation === readGeneration.current && currentScope.current === key) {
          acceptedPage.current = value;
          runtime.observeRows(value.page.rows);
          setPage({ key, value }); setError(null);
          // Retained data is already visible. Optional discovery is a separate
          // ordinary FIFO unit, never a condition for serving that data page.
          try {
            const discovery = await runtime.readScope(threadId, owned.signal, signal => runtime.discoverReady(signal));
            if (active && !owned.signal.aborted && generation === readGeneration.current && currentScope.current === key) {
              setSourceContinuation(discovery.state === 'capacity' || discovery.value.continued || discovery.value.capacity);
              setSourceError(null);
            }
          } catch {
            if (active && !owned.signal.aborted && generation === readGeneration.current && currentScope.current === key) setSourceError('Custom result sources are temporarily unavailable.');
          }
        }
      }, () => {
        if (active && generation === readGeneration.current && currentScope.current === key
          && (!owned.signal.aborted || owned.signal.reason === 'deadline')) setError('Results history is temporarily unavailable.');
      }).finally(() => { if (controller === owned && timer !== null) { clearTimeout(timer); timer = null; } });
    }
    const visibility = () => { if (document.hidden) stop(); else read(); };
    document.addEventListener('visibilitychange', visibility); read();
    return () => { active = false; stop(); document.removeEventListener('visibilitychange', visibility); };
  }, [runtime, threadId, turnId, key, after, attempt]);
  const shown = page?.key === key ? page.value : null;
  const lifetime = content?.key === key ? content.controller.signal : AbortSignal.abort();
  const current = () => runtime.isActive() && currentScope.current === key && !lifetime.aborted;
  return <section className="tr-panel" data-turn-results-panel="" aria-label="Results history">
    <h2>{turnId ? 'Turn results' : 'Thread results'}</h2>
    <p className="tr-freshness">Previously observed results. History that has not been indexed or has been evicted may contain additional results.</p>
    {shown?.page.rows.map(row => <div key={row.key} className="tr-panel-card"><ResultCard row={row} runtime={runtime} sdk={sdk} navigate={navigate}
      current={() => current() && acceptedPage.current?.page.rows.some(next => next.key === row.key && next.owner === row.owner && canonicalJson(next.identity) === canonicalJson(row.identity)
        && canonicalJson(next.resolution?.revision ?? null) === canonicalJson(row.resolution?.revision ?? null)) === true}
      lifetime={lifetime} presentationRoot={content?.key === key ? content.presentationRoot : undefined} /></div>)}
    {!shown?.page.rows.length && <p>No retained results in this history page.</p>}
    {error && <p role="status">{error}<button onClick={() => setAttempt(value => value + 1)}>Retry results</button></p>}
    {(sourceContinuation || sourceError) && <p role="status">{sourceError}<button onClick={() => setAttempt(value => value + 1)}>Continue custom result sources</button></p>}
    <div className="tr-panel-paging">
      <button disabled={!previous.length} onClick={() => setPaging({ key, after: previous.at(-1), previous: previous.slice(0, -1) })}>Previous results</button>
      <button disabled={!shown?.page.next} onClick={() => { if (shown?.page.next) setPaging({ key, after: shown.page.next, previous: [...previous.slice(-63), after] }); }}>Next results</button>
    </div>
  </section>;
}
