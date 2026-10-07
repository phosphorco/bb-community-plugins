import type { GuideContentModule } from './floating/contract';

// Chromium retains rejected module URLs. The literal factory is preserved by
// the selected format-2 builder; check-lazy-build validates its emitted shape
// and that the deferred leaf depends only on already-loaded static modules.
export function guideRetryUrl(factorySource: string, moduleUrl: string, attempt: number): string {
  const owner = new URL(moduleUrl);
  const prefix = owner.pathname.match(/^\/api\/v1\/plugins\/plugin-guide-for-nerds\/assets\/g\/[a-f0-9]{32}\//)?.[0];
  const imports = [...factorySource.matchAll(/\bimport\s*\(\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*\)/g)];
  if (!prefix || imports.length !== 1) throw new Error('Reload BB to try loading the guide again.');
  const target = new URL(imports[0][1] ?? imports[0][2], owner);
  if (target.origin !== owner.origin || !target.pathname.startsWith(prefix)
      || !/^chunks\/guide-content-[A-Za-z0-9_-]+\.js$/.test(target.pathname.slice(prefix.length))) {
    throw new Error('Reload BB to try loading the guide again.');
  }
  target.searchParams.set('bb-guide-retry', String(attempt));
  return target.href;
}

export function createGuideContentLoader(
  firstImport: () => Promise<GuideContentModule>,
  moduleUrl: string,
  importFresh: (url: string) => Promise<GuideContentModule> = (url) => import(/* @vite-ignore */ url),
): () => Promise<GuideContentModule> {
  let ready: GuideContentModule | undefined;
  let pending: Promise<GuideContentModule> | undefined;
  let failed = false;
  let attempt = 0;
  return () => {
    if (ready) return Promise.resolve(ready);
    if (pending) return pending;
    // Sessions can close/reopen while a request is pending. Share that request;
    // frame guards, rather than a second query, decide which session may mount.
    pending = Promise.resolve().then(() => failed
        ? importFresh(guideRetryUrl(firstImport.toString(), moduleUrl, ++attempt))
        : firstImport()).then(module => {
      ready = module;
      return module;
    }, error => {
      failed = true;
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
