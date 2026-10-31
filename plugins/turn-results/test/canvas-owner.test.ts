import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowCanvasOwner } from '../gallery/canvas-owner.ts';
import type { CanvasPriority, CanvasRequest } from '../gallery/canvas-owner.ts';
const priority = (order: number, extra: Partial<CanvasPriority> = {}): CanvasPriority => ({ visible: true, focused: false, dialog: false, activation: 0, order, ...extra });
function acknowledge(request: CanvasRequest) { const lease = request.getSnapshot().lease; assert.ok(lease); assert.equal(request.acknowledgeRetired(lease), true); }
function finish(owner: ReturnType<typeof createWindowCanvasOwner>, requests: CanvasRequest[]) { owner.dispose(); for (const r of requests) if (r.getSnapshot().lease) acknowledge(r); }
test('four includes retiring reservations; dialog replacement waits for its exact cleanup', () => {
  const owner = createWindowCanvasOwner();
  const requests = Array.from({ length: 8 }, (_, i) => owner.request(`pane/${i}`, priority(i)));
  const losing = requests[3]!.getSnapshot().lease!;
  const dialog = owner.request('dialog/7', priority(100, { dialog: true, activation: 1 }));
  assert.equal(dialog.getSnapshot().state, 'queued'); assert.equal(losing.signal.aborted, true);
  assert.equal(owner.counts().occupied, 4); assert.equal(owner.counts().retiring, 1);
  acknowledge(requests[3]!); assert.equal(dialog.getSnapshot().state, 'granted');
  const next = owner.request('dialog/8', priority(100, { dialog: true, activation: 2 }));
  assert.equal(next.getSnapshot().state, 'queued'); assert.equal(owner.counts().dialogs, 1);
  acknowledge(dialog); assert.equal(next.getSnapshot().state, 'granted');
  assert.equal(requests[3]!.acknowledgeRetired(losing), false);
  finish(owner, [...requests, dialog, next]); assert.equal(owner.counts().occupied, 0);
});
test('focus survives intersections; hidden resources remain counted until cleanup', () => {
  const owner = createWindowCanvasOwner(), focused = owner.request('focus', priority(100, { focused: true }));
  const requests = [focused, ...Array.from({ length: 12 }, (_, i) => owner.request(`other/${i}`, priority(i, { activation: 5 })))];
  const lease = focused.getSnapshot().lease!;
  focused.update(priority(100, { focused: true, visible: false })); assert.equal(focused.getSnapshot().lease, lease);
  owner.setHidden(true); assert.equal(lease.signal.aborted, true); assert.equal(focused.getSnapshot().state, 'retiring');
  owner.setHidden(false); assert.equal(focused.getSnapshot().lease, lease);
  for (const r of requests) if (r.getSnapshot().state === 'retiring') acknowledge(r);
  assert.equal(focused.getSnapshot().state, 'granted'); assert.notEqual(focused.getSnapshot().lease, lease);
  finish(owner, requests);
});
test('replacement/stale disposers and synchronous nested abort preserve exact ownership', () => {
  const owner = createWindowCanvasOwner(), old = owner.request('key', priority(0));
  let nested: CanvasRequest | undefined;
  old.getSnapshot().signal!.addEventListener('abort', () => { nested = owner.request('key', priority(0, { focused: true })); });
  const superseded = owner.request('key', priority(1));
  assert.equal(superseded.getSnapshot().state, 'released'); assert.equal(nested!.getSnapshot().state, 'granted');
  assert.equal(owner.counts().occupied, 2);
  old.dispose(); superseded.dispose(); acknowledge(old);
  assert.equal(nested!.getSnapshot().signal!.aborted, false);
  finish(owner, [nested!]); assert.equal(owner.counts().requests, 0);
});
test('64 includes retired requests; quiet updates and immutable dialog reservations', () => {
  const owner = createWindowCanvasOwner(), requests = Array.from({ length: 64 }, (_, i) => owner.request(`scope/${i}`, priority(i)));
  const first = requests[0]!, snapshot = first.getSnapshot(); let notifications = 0;
  first.subscribe(() => { notifications++; });
  for (let i = 0; i < 100; i++) first.update(priority(0));
  assert.equal(first.getSnapshot(), snapshot); assert.equal(notifications, 0);
  first.dispose(); assert.equal(snapshot.signal!.aborted, true);
  assert.equal(owner.request('excess', priority(0)).getSnapshot().state, 'capacity');
  assert.equal(owner.request('scope/1', priority(0)).getSnapshot().state, 'capacity');
  acknowledge(first); const next = owner.request('excess', priority(0)); assert.equal(owner.counts().requests, 64);
  finish(owner, [...requests, next]);
});
test('watchdog parks once; drain never pretends stalled resources were disposed', async () => {
  const owner = createWindowCanvasOwner({ retirementMs: 5 }), request = owner.request('held', priority(0));
  const lease = request.getSnapshot().lease!; owner.dispose();
  let drained = false; const drain = owner.whenDrained().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(drained, false); assert.equal(request.getSnapshot().state, 'stalled');
  assert.equal(owner.counts().occupied, 1); assert.equal(owner.counts().stalled, 1);
  assert.equal(request.acknowledgeRetired({ ...lease }), false); acknowledge(request); await drain;
  assert.equal(drained, true); assert.equal(owner.counts().requests, 0);
});
test('restart/readiness and dock/dialog changes retain the old lease until acknowledgement', () => {
  const owner = createWindowCanvasOwner(), r = owner.request('key', priority(0));
  const first = r.getSnapshot().lease!;
  r.update(priority(0, { dialog: true })); assert.equal(r.getSnapshot().lease, first);
  assert.equal(owner.counts().dialogs, 0); acknowledge(r); assert.equal(owner.counts().dialogs, 1);
  r.setAvailable(false); acknowledge(r); assert.equal(r.getSnapshot().state, 'queued');
  r.setAvailable(true); assert.equal(r.getSnapshot().state, 'granted');
  r.restart(); acknowledge(r); finish(owner, [r]);
});


test('queued replacement reserves its 64th slot before released subscribers can reenter', () => {
  const owner = createWindowCanvasOwner(), requests = Array.from({ length: 64 }, (_, i) => owner.request(`key/${i}`, priority(i)));
  let nested: CanvasRequest | undefined;
  requests[5]!.subscribe(() => { nested = owner.request('foreign/new', priority(90)); assert.equal(owner.counts().requests, 64); });
  const replacement = owner.request('key/5', priority(5));
  assert.equal(nested!.getSnapshot().state, 'capacity'); assert.equal(replacement.getSnapshot().state, 'queued');
  assert.equal(owner.counts().requests, 64); finish(owner, [...requests, replacement]);
});
