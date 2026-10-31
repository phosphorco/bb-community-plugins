import { createElement, useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { PresentationHost } from '@phosphorco/bb-context-recognition/react';
import type { PresentationHostProps } from '@phosphorco/bb-context-recognition/react';
import { lookupPresentation, subscribePresentations } from '@phosphorco/bb-context-recognition/presentation';
import type { CanvasLease } from './canvas-owner.ts';
import type { PresentationLifetime } from './presentation-lifetime.ts';

export interface HostedCanvasProps extends PresentationHostProps { lifetime: PresentationLifetime }
function MountedHost(props: { lifetime: PresentationLifetime; lease: CanvasLease; children?: ReactNode }) {
  useEffect(() => props.lifetime.mounted(props.lease), [props.lifetime, props.lease]);
  return props.children;
}
/** Layout/size and captions remain consumer-owned. Only public CR props/realm
 * cross this boundary; no native hooks, second registry or fabricated event. */
export function HostedCanvas(props: HostedCanvasProps) {
  const { lifetime, ...host } = props, request = lifetime.request;
  const snapshot = useSyncExternalStore(request.subscribe, request.getSnapshot, request.getSnapshot);
  const subscribeEntry = useCallback((listener: () => void) => {
    let previous = lookupPresentation(host.stamp.pluginId, host.stamp.schema);
    return subscribePresentations(() => {
      const next = lookupPresentation(host.stamp.pluginId, host.stamp.schema);
      if (next !== previous) { previous = next; request.restart(); }
      listener();
    });
  }, [request, host.stamp.pluginId, host.stamp.schema]);
  const entry = useSyncExternalStore(subscribeEntry,
    () => lookupPresentation(host.stamp.pluginId, host.stamp.schema), () => undefined);
  const available = entry !== undefined && host.readyPlugins.has(host.stamp.pluginId) && lifetime.isActive();
  // Data is immutable at a source revision. Identity/stamp/revision/retry/mode
  // changes get a new reservation; size alone is an inexpensive resize.
  const key = JSON.stringify([host.identity, host.stamp, host.revision ?? null, host.retryKey ?? 0, host.mode]);
  const lease = snapshot.lease;
  const binding = lease ? lifetime.capture(lease, { entry, key, sdk: host.sdk }) : null;
  const show = lease !== null && snapshot.state === 'granted' && available
    && binding?.entry === entry && binding?.key === key && binding?.sdk === host.sdk && lifetime.isCurrent(lease);
  useLayoutEffect(() => {
    request.setAvailable(available);
    if (snapshot.state === 'granted' && available && !show) request.restart();
  }, [request, available, show, snapshot.state, entry, key, host.sdk]);
  useEffect(() => lifetime.attach(), [lifetime]);
  useEffect(() => { if (lease && !show) lifetime.committedAbsent(lease); }, [lifetime, lease, show]);
  if (!show || !lease) return host.fallback;
  const current = () => lifetime.isCurrent(lease)
    && lookupPresentation(host.stamp.pluginId, host.stamp.schema) === binding?.entry
    && host.readyPlugins.has(host.stamp.pluginId);
  const guarded: PresentationHostProps = {
    ...host,
    navigate: {
      toThread: id => { if (current()) host.navigate.toThread(id); },
      openUrl: url => { if (current()) host.navigate.openUrl(url); },
      openFile: target => current() ? host.navigate.openFile(target) : false,
    },
    ...(host.requestFull ? { requestFull: () => { if (current()) host.requestFull!(); } } : {}),
    ...(host.refresh ? { refresh: () => { if (current()) host.refresh!(); } } : {}),
    ...(host.onReady ? { onReady: () => { if (current()) host.onReady!(); } } : {}),
    ...(host.onDiagnostic ? { onDiagnostic: diagnostic => { if (current()) host.onDiagnostic!(diagnostic); } } : {}),
  };
  return createElement(MountedHost, { key: lease.id, lifetime, lease }, createElement(PresentationHost, guarded));
}
