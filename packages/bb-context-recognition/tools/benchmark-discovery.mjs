// Emitted-entry source benchmark. Samples are observations, not CPU guarantees.
import { LIMITS } from '../dist/index.js';
import { createRecognitionDiscoveryOwner, enumerateRecognitionSuppliers } from '../dist/bb.js';
for (const count of [500, 2000]) {
  const ids = Array.from({ length: count }, (_, i) => `p${String(i).padStart(4, '0')}`);
  for (const mode of ['absent', 'ready']) {
    let calls = 0, rowCallbacks = 0, progressCallbacks = 0, snapshotRows = 0;
    const owner = createRecognitionDiscoveryOwner();
    const started = performance.now();
    try {
      const result = await enumerateRecognitionSuppliers({ owner, exclude: 'consumer',
        sdk: { plugins: {
          list: async () => ({ plugins: ids.map(id => ({ id, status: 'running' })) }),
          callRpc: async ({ pluginId }) => {
            calls++;
            if (mode === 'absent') throw { status: 404, body: { error: { code: 'unknown_method' } } };
            return { protocol: 'bb-context-recognition', versions: [1], capabilities: { revision: 'bench/1', resolve: { providers: [{ provider: pluginId, kinds: ['item'] }] } } };
          },
        } },
        onRow: () => rowCallbacks++,
        onProgress: snapshot => { progressCallbacks++; snapshotRows += snapshot.rows.length; },
      });
      console.log(JSON.stringify({ proof: 'source-benchmark', count, mode, ms: +(performance.now() - started).toFixed(2), calls, rowCallbacks, progressCallbacks, snapshotRows, finalRows: result.rows.length, admitted: result.rows.filter(r => r.admitted).length, admittedCap: LIMITS.plugins, continuation: result.continuation }));
    } finally { owner.dispose(); }
  }
}
