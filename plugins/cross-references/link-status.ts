/** Bound display-time probing to the same small surface as Thread Links. */
export const FORWARD_REFERENCE_CHECK_LIMIT = 10;

export function firstUniqueLinks<T extends { url: string }>(links: Iterable<T>): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    result.push(link);
    if (result.length === FORWARD_REFERENCE_CHECK_LIMIT) break;
  }
  return result;
}

export type LinkStatus = { url: string; status: number | null; label: string };

/**
 * Matches Thread Links' deliberately small status probe. Results are ephemeral
 * display data: redirects are not followed, browser credentials are never
 * sent, and the graph remains entirely independent of the check outcome.
 */
export function createLinkChecker(fetcher: typeof fetch = fetch) {
  const cache = new Map<string, { expires: number; result: Promise<LinkStatus> }>();
  return (url: string): Promise<LinkStatus> => {
    const previous = cache.get(url);
    if (previous !== undefined && previous.expires > Date.now()) return previous.result;
    const result = (async (): Promise<LinkStatus> => {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
          return { url, status: null, label: 'Not checked' };
        }
        const response = await fetcher(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          signal: AbortSignal.timeout(5_000),
        });
        await response.body?.cancel();
        const status = response.status;
        const label = status === 404 ? 'Not found or private'
          : status === 410 ? 'Gone'
          : status === 401 || status === 403 ? 'Access restricted'
          : status >= 300 && status < 400 ? 'Redirect'
          : response.ok ? 'Available' : 'HTTP error';
        return { url, status, label };
      } catch {
        return { url, status: null, label: url.startsWith('/') ? 'BB link · Not checked' : 'Could not reach' };
      }
    })();
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(url, { expires: Date.now() + 60_000, result });
    return result;
  };
}
