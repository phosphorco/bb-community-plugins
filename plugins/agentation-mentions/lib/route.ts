// Reading bb's own routes.
//
// Kept free of imports on purpose: the frontend bundle pulls these in, and
// anything they touched would be bundled with them.

/** `/threads/thr_abc` → `thr_abc`; anything else → null. */
export function threadIdFromRoute(route: string): string | null {
  return /\/threads?\/(thr_[A-Za-z0-9]+)/.exec(route)?.[1] ?? null;
}

/** `/projects/proj_abc/…` → `proj_abc`; anything else → null. */
export function projectIdFromRoute(route: string): string | null {
  return /\/projects?\/(proj_[A-Za-z0-9]+)/.exec(route)?.[1] ?? null;
}

/** `/plugins/github/issues` → `github`; anything else → null. */
export function panelPluginIdFromRoute(route: string): string | null {
  return /^\/plugins\/([^/]+)/.exec(route)?.[1] ?? null;
}

/** A short human label for a bb route, used in annotation listings. */
export function labelForRoute(route: string): string {
  const threadId = threadIdFromRoute(route);
  if (threadId) return `thread ${threadId}`;
  const pluginId = panelPluginIdFromRoute(route);
  if (pluginId) return `${pluginId} panel`;
  if (route === "/" || route === "") return "home";
  if (route.startsWith("/settings")) return "settings";
  return route;
}
